import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { WriteConflict } from '../collector/store.js';

export interface SiteAsset {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl: string;
  metadata?: Record<string, string>;
}
export interface StoredSiteAsset extends SiteAsset { etag: string }
export interface SiteTarget {
  read(key: string): Promise<StoredSiteAsset | undefined>;
  /** Undefined means create-only; an existing object requires its exact ETag. */
  put(asset: SiteAsset, expectedEtag?: string): Promise<StoredSiteAsset>;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function validKey(key: string): string {
  if (!key || key.startsWith('/') || key.split('/').some(part => !part || part === '.' || part === '..') || key.includes('\\')) {
    throw new Error('Invalid site object key.');
  }
  return key;
}
const missing = (error: unknown) => ['ENOENT', 'NoSuchKey', 'NotFound'].includes(String((error as NodeJS.ErrnoException).code ?? (error as Error).name));

export class LocalSiteTarget implements SiteTarget {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  async read(key: string): Promise<StoredSiteAsset | undefined> {
    let body: Buffer;
    try { body = await readFile(join(this.directory, validKey(key))); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    const etag = hash(body);
    const metadataFile = join(this.directory, '_publication', 'metadata', `${hash(key)}-${etag}.json`);
    try {
      const attributes = JSON.parse(await readFile(metadataFile, 'utf8')) as Omit<SiteAsset, 'key' | 'body'>;
      return { ...attributes, key, body, etag };
    } catch (error) {
      if (!missing(error)) throw error;
      return { key, body, etag, contentType: 'application/octet-stream', cacheControl: 'no-store' };
    }
  }
  async put(asset: SiteAsset, expectedEtag?: string): Promise<StoredSiteAsset> {
    const path = join(this.directory, validKey(asset.key));
    const locks = join(this.directory, '_publication', 'locks');
    await mkdir(locks, { recursive: true });
    const lockPath = join(locks, `${hash(asset.key)}.lock`);
    let lock;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { lock = await open(lockPath, 'wx'); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    if (!lock) throw new WriteConflict('Another local publisher is writing this object.');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const current = await this.read(asset.key);
      if (current?.etag !== expectedEtag) throw new WriteConflict('The site object changed before publication.');
      await mkdir(dirname(path), { recursive: true });
      const etag = hash(asset.body);
      const metadataDirectory = join(this.directory, '_publication', 'metadata');
      await mkdir(metadataDirectory, { recursive: true });
      const { key: _key, body: _body, ...attributes } = asset;
      // Metadata is keyed by exact bytes and is ready before the atomic public file rename.
      await writeFile(join(metadataDirectory, `${hash(asset.key)}-${etag}.json`), JSON.stringify(attributes));
      await writeFile(temporary, asset.body);
      await rename(temporary, path);
      return { ...asset, etag };
    } finally {
      await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
      await lock.close();
      await unlink(lockPath);
    }
  }
}

export class S3SiteTarget implements SiteTarget {
  constructor(readonly bucket: string, private readonly client = new S3Client({})) {}
  async read(key: string): Promise<StoredSiteAsset | undefined> {
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: validKey(key) }), { abortSignal: AbortSignal.timeout(30_000) });
      if (!object.Body || !object.ETag) throw new Error('The site object has no body or ETag.');
      return { key, body: Buffer.from(await object.Body.transformToByteArray()), etag: object.ETag,
        contentType: object.ContentType ?? 'application/octet-stream', cacheControl: object.CacheControl ?? 'no-store', metadata: object.Metadata };
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async put(asset: SiteAsset, expectedEtag?: string): Promise<StoredSiteAsset> {
    try {
      const result = await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: validKey(asset.key),
        Body: asset.body, ContentType: asset.contentType, CacheControl: asset.cacheControl,
        Metadata: asset.metadata, ServerSideEncryption: 'AES256',
        ...(expectedEtag ? { IfMatch: expectedEtag } : { IfNoneMatch: '*' }),
      }), { abortSignal: AbortSignal.timeout(60_000) });
      if (!result.ETag) throw new Error('The uploaded site object has no ETag.');
      return { ...asset, etag: result.ETag };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 409 || status === 412) throw new WriteConflict('The site object changed before publication.');
      throw error;
    }
  }
}

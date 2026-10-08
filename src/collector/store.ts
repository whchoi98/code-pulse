import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Snapshot } from '../shared/types.js';

export interface StoredSnapshot { snapshot: Snapshot; etag?: string }
export interface SnapshotStore {
  read(): Promise<StoredSnapshot>;
  write(snapshot: Snapshot, expectedEtag?: string): Promise<void>;
  archive?(sourceId: string, text: string, checkedAt: string): Promise<void>;
}
export class WriteConflict extends Error {}
export function emptySnapshot(): Snapshot {
  return { schemaVersion: 1, generatedAt: '', entries: [], sources: [], runs: [] };
}
function decode(text: string): Snapshot {
  const value = JSON.parse(text);
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.sources)
    || !Array.isArray(value.runs) || typeof value.generatedAt !== 'string') {
    throw new Error('저장된 변경 기록의 형식을 확인할 수 없습니다.');
  }
  return value as Snapshot;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => ['ENOENT', 'NoSuchKey', 'NotFound'].includes(String((error as { code?: string; name?: string }).code ?? (error as Error).name));

export class FileStore implements SnapshotStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  async read(): Promise<StoredSnapshot> {
    try {
      const body = await readFile(join(this.directory, 'snapshot.json'), 'utf8');
      return { snapshot: decode(body), etag: hash(body) };
    } catch (error) {
      if (missing(error)) return { snapshot: emptySnapshot() };
      throw error;
    }
  }
  async write(snapshot: Snapshot, expectedEtag?: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = join(this.directory, 'snapshot.lock');
    let lock;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { lock = await open(lockPath, 'wx'); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A terminated local collector may leave its lock file behind.
        try {
          if (Date.now() - (await stat(lockPath)).mtimeMs > 60_000) await unlink(lockPath);
        } catch (checkError) { if (!missing(checkError)) throw checkError; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!lock) throw new Error('로컬 저장소를 다른 수집 작업이 사용 중입니다.');
    const temporary = join(this.directory, `snapshot-${randomUUID()}.tmp`);
    try {
      const current = await this.read();
      if (current.etag !== expectedEtag) throw new WriteConflict('저장된 자료가 먼저 갱신됐습니다.');
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(temporary, join(this.directory, 'snapshot.json'));
    } finally {
      await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
      await lock.close();
      await unlink(lockPath);
    }
  }
  async archive(sourceId: string, text: string, checkedAt: string): Promise<void> {
    if (!/^[a-z0-9-]+$/.test(sourceId)) throw new Error('자료 ID가 올바르지 않습니다.');
    const directory = join(this.directory, 'raw', checkedAt.slice(0, 10), sourceId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${hash(text)}.txt`), text, { mode: 0o600 });
  }
}

export class S3Store implements SnapshotStore {
  constructor(readonly bucket: string, private readonly client = new S3Client({})) {}
  async read(): Promise<StoredSnapshot> {
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: 'published/snapshot.json' }), { abortSignal: AbortSignal.timeout(8000) });
      const body = await object.Body?.transformToString();
      if (!body) throw new Error('저장된 변경 기록이 비어 있습니다.');
      return { snapshot: decode(body), etag: object.ETag };
    } catch (error) {
      if (missing(error)) return { snapshot: emptySnapshot() };
      throw error;
    }
  }
  async write(snapshot: Snapshot, expectedEtag?: string): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: 'published/snapshot.json',
        Body: JSON.stringify(snapshot), ContentType: 'application/json; charset=utf-8',
        ServerSideEncryption: 'AES256',
        ...(expectedEtag ? { IfMatch: expectedEtag } : { IfNoneMatch: '*' }),
      }), { abortSignal: AbortSignal.timeout(60_000) });
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 409 || status === 412) throw new WriteConflict('저장된 자료가 먼저 갱신됐습니다.');
      throw error;
    }
  }
  async archive(sourceId: string, text: string, checkedAt: string): Promise<void> {
    if (!/^[a-z0-9-]+$/.test(sourceId)) throw new Error('자료 ID가 올바르지 않습니다.');
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: `raw/${checkedAt.slice(0, 10)}/${sourceId}/${hash(text)}.txt`,
      Body: text, ContentType: 'text/plain; charset=utf-8', ServerSideEncryption: 'AES256',
    }), { abortSignal: AbortSignal.timeout(60_000) });
  }
}

export function configuredStore(): SnapshotStore {
  return process.env.DATA_BUCKET ? new S3Store(process.env.DATA_BUCKET) : new FileStore(process.env.DATA_DIR ?? './data');
}

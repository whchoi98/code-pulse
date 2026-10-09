import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3SiteTarget, type SiteAsset } from '../src/publishing/index.js';
import { WriteConflict } from '../src/collector/store.js';

// Keep the real SDK serializer and response parser, replacing only its HTTP transport.
function objectService() {
  const objects = new Map<string, { body: Buffer; headers: Record<string, string> }>();
  const client = new S3Client({
    region: 'us-east-1', endpoint: 'https://s3.example.test', forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' },
    requestHandler: { handle: async (request: { path: string; method: string; headers: Record<string, string>; body?: unknown }) => {
      const existing = objects.get(request.path);
      const reply = (statusCode: number, body: string | Buffer, headers: Record<string, string> = {}) => ({
        response: { statusCode, headers, body: Readable.from([body]) },
      });
      if (request.method === 'GET') return existing ? reply(200, existing.body, existing.headers)
        : reply(404, '<Error><Code>NoSuchKey</Code></Error>', { 'content-type': 'application/xml' });
      if (request.method !== 'PUT' || request.headers['x-amz-server-side-encryption'] !== 'AES256') {
        return reply(400, '<Error><Code>InvalidRequest</Code></Error>');
      }
      if ((request.headers['if-none-match'] === '*' && existing)
        || (request.headers['if-match'] && request.headers['if-match'] !== existing?.headers.etag)) {
        return reply(412, '<Error><Code>PreconditionFailed</Code></Error>', { 'content-type': 'application/xml' });
      }
      const body = Buffer.from(request.body as Uint8Array);
      const headers = { 'content-type': request.headers['content-type'], 'cache-control': request.headers['cache-control'],
        'x-amz-meta-generation': request.headers['x-amz-meta-generation'] ?? '',
        etag: `"${createHash('sha256').update(body).digest('hex')}"` };
      objects.set(request.path, { body, headers });
      return reply(200, '', { etag: headers.etag });
    } },
  });
  return new S3SiteTarget('site-fixture', client);
}

describe('S3 publication conditional storage', () => {
  const asset: SiteAsset = { key: 'pages/en/example.html', body: Buffer.from('<h1>Version one</h1>'),
    contentType: 'text/html; charset=utf-8', cacheControl: 'public, max-age=0, s-maxage=60, must-revalidate', metadata: { generation: '1' } };

  it('uses create-only uploads and retains the first object when a duplicate upload conflicts', async () => {
    const target = objectService();
    expect(await target.read(asset.key)).toBeUndefined();
    await target.put(asset);
    await expect(target.put({ ...asset, body: Buffer.from('stale overwrite') })).rejects.toBeInstanceOf(WriteConflict);
    const current = await target.read(asset.key);
    expect(current?.body.toString()).toBe('<h1>Version one</h1>');
    expect(current?.cacheControl).toBe('public, max-age=0, s-maxage=60, must-revalidate');
    expect(current?.metadata?.generation).toBe('1');
  });

  it('allows the exact current ETag and refuses a stale ETag after a newer update', async () => {
    const target = objectService();
    const before = await target.put(asset);
    const next = await target.put({ ...asset, body: Buffer.from('<h1>Version two</h1>'), metadata: { generation: '2' } }, before.etag);
    expect(next.etag).not.toBe(before.etag);
    await expect(target.put(asset, before.etag)).rejects.toBeInstanceOf(WriteConflict);
    const current = await target.read(asset.key);
    expect(current?.body.toString()).toBe('<h1>Version two</h1>');
    expect(current?.metadata?.generation).toBe('2');
  });
});

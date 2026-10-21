import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { emptySnapshot, FileStore, S3Store, WriteConflict } from '../src/collector/store.js';

describe('atomic snapshot storage', () => {
  it('persists a snapshot and refuses to overwrite it using an old etag', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'code-pulse-store-'));
    try {
      const a = new FileStore(directory);
      const b = new FileStore(directory);
      await a.write({ ...emptySnapshot(), generatedAt: '2026-10-07T00:00:00Z' });
      const original = await a.read();
      expect(original.snapshot.generatedAt).toBe('2026-10-07T00:00:00Z');
      expect(original.etag).toBeTruthy();
      await b.write({ ...original.snapshot, generatedAt: '2026-10-07T01:00:00Z' }, original.etag);
      await expect(a.write({ ...original.snapshot, generatedAt: '2026-10-07T02:00:00Z' }, original.etag)).rejects.toBeInstanceOf(WriteConflict);
      expect((await a.read()).snapshot.generatedAt).toBe('2026-10-07T01:00:00Z');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('revalidates the S3 snapshot by ETag without downloading an unchanged object', async () => {
    const stored = { ...emptySnapshot(), generatedAt: '2026-10-07T00:00:00Z' };
    const requests: GetObjectCommand['input'][] = [];
    const client = {
      async send(command: GetObjectCommand) {
        requests.push(command.input);
        if (command.input.IfNoneMatch === '"v1"') throw Object.assign(new Error('Not Modified'), { name: 'NotModified', $metadata: { httpStatusCode: 304 } });
        return { ETag: '"v1"', Body: { transformToString: async () => JSON.stringify(stored) } };
      },
    } as unknown as S3Client;
    const store = new S3Store('data-bucket', client);
    expect(await store.read()).toEqual({ snapshot: stored, etag: '"v1"' });
    expect(await store.readIfChanged('"v1"')).toBeUndefined();
    expect(await store.readIfChanged('"v0"')).toEqual({ snapshot: stored, etag: '"v1"' });
    expect(requests).toEqual([
      { Bucket: 'data-bucket', Key: 'published/snapshot.json' },
      { Bucket: 'data-bucket', Key: 'published/snapshot.json', IfNoneMatch: '"v1"' },
      { Bucket: 'data-bucket', Key: 'published/snapshot.json', IfNoneMatch: '"v0"' },
    ]);
  });
});

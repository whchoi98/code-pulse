import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptySnapshot, FileStore, WriteConflict } from '../src/collector/store.js';

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
});

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server/app.js';
import { emptySnapshot, type SnapshotStore } from '../src/collector/store.js';
import type { Entry, Snapshot } from '../src/shared/types.js';
const entry: Entry = {
  id: 'kiro-1234567890', product: 'kiro', channel: 'cli', sourceId: 'kiro-changelog',
  originalTitle: 'Hook matching', publishedAt: '2026-10-05T00:00:00Z', publishedDate: '2026-10-05', datePrecision: 'day',
  sourceUrl: 'https://kiro.dev/changelog/cli/2-28/', references: [],
  originalText: 'Complete copyrighted source material retained in private storage only.',
  contentHash: 'internal-hash', firstSeenAt: '2026-10-07T00:00:00Z', checkedAt: '2026-10-07T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z', explanationStatus: 'pending',
};
const snapshot: Snapshot = {
  ...emptySnapshot(), generatedAt: '2026-10-07T00:00:00Z', entries: [entry],
  sources: [{ id: 'kiro-changelog', name: 'Kiro 공식 변경 기록', url: 'https://kiro.dev/changelog/', product: 'kiro', state: 'ok', checkedAt: '2026-10-07T00:00:00Z', lastSuccessAt: '2026-10-07T00:00:00Z', entryCount: 1 }],
};
const store: SnapshotStore = { read: async () => ({ snapshot }), write: async () => {} };
const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
async function server(s = store, now = '2026-10-07T02:00:00Z') {
  const app = await createServer(s, { staticDirectory: false, now: () => new Date(now), cacheTtlMs: 0 });
  servers.push(app); return app;
}
describe('public reading API', () => {
  it('serves the collected feed without exposing archived full source bodies', async () => {
    const app = await server();
    const response = await app.inject('/api/feed');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stale: false, schedule: { timezone: 'Asia/Seoul', hour: 9 } });
    expect(response.json().entries[0].id).toBe(entry.id);
    expect(response.body).not.toContain('Complete copyrighted');
    expect(response.body).not.toContain('internal-hash');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
  it('shows an outdated successful collection as stale instead of changing its original timestamp', async () => {
    const app = await server(store, '2026-10-08T03:00:00Z');
    const response = await app.inject('/api/feed');
    expect(response.json()).toMatchObject({ stale: true, generatedAt: '2026-10-07T00:00:00Z' });
  });
  it('offers entry detail and a true 404 for an unknown entry or API endpoint', async () => {
    const app = await server();
    const detail = await app.inject(`/api/entries/${entry.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: entry.id, originalText: '' });
    expect((await app.inject('/api/entries/missing')).statusCode).toBe(404);
    expect((await app.inject('/api/missing')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/collect' })).statusCode).toBe(404);
  });
  it('returns service unavailable on a storage failure while health checks keep responding', async () => {
    const app = await server({ read: async () => { throw new Error('access denied, internal details'); }, write: async () => {} });
    const failed = await app.inject('/api/feed');
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('internal details');
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });
  it('keeps the last readable feed with an explicit stale flag during a temporary storage outage', async () => {
    let fail = false;
    const app = await server({ read: async () => { if (fail) throw new Error('temporary S3 outage'); return { snapshot }; }, write: async () => {} });
    expect((await app.inject('/api/feed')).json().stale).toBe(false);
    fail = true;
    const response = await app.inject('/api/feed');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stale: true, generatedAt: snapshot.generatedAt });
  });
  it('serves HTML and static assets with appropriate cache headers and keeps private files outside the public root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'code-pulse-static-'));
    let app: FastifyInstance | undefined;
    try {
      const publicDirectory = join(directory, 'public');
      await mkdir(join(publicDirectory, 'assets'), { recursive: true });
      await writeFile(join(publicDirectory, 'index.html'), '<!doctype html><title>Code Pulse</title>');
      await writeFile(join(publicDirectory, 'assets', 'app-abc123.js'), 'console.log("Code Pulse");');
      await writeFile(join(directory, 'private.txt'), 'private material must not be served');
      app = await createServer(store, { staticDirectory: publicDirectory });
      const page = await app.inject('/');
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('no-cache');
      expect(page.body).toContain('<title>Code Pulse</title>');
      const asset = await app.inject('/assets/app-abc123.js');
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
      expect((await app.inject('/assets/missing.js')).statusCode).toBe(404);
      const traversal = await app.inject('/%2e%2e/private.txt');
      expect(traversal.statusCode).toBe(404);
      expect(traversal.body).not.toContain('private material');
    } finally {
      await app?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

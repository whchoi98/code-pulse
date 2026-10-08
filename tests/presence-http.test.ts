import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/server/app.js';
import { emptySnapshot, type SnapshotStore } from '../src/collector/store.js';
import { MemoryPresenceStore, type PresenceStore } from '../src/server/presence-store.js';

const secret = 'test-presence-secret-shared-between-two-tasks-12345';
const start = Date.parse('2026-10-07T19:00:00Z');
const snapshots: SnapshotStore = { read: async () => ({ snapshot: emptySnapshot() }), write: async () => {} };
const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(app => app.close())); vi.unstubAllEnvs(); });
async function server(store: PresenceStore = new MemoryPresenceStore(), extra = {}) {
  const app = await createServer(snapshots, {
    staticDirectory: false,
    presence: { store, secret, now: () => start, ...extra },
  });
  servers.push(app);
  return app;
}
async function visitorCookie(app: FastifyInstance) {
  const response = await app.inject('/api/presence');
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  expect(raw).toBeDefined();
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0];
}
const headers = (cookie: string, origin = 'http://localhost') => ({
  cookie, origin, 'x-code-pulse-client': '1', 'content-type': 'application/json',
});

describe('presence HTTP contract', () => {
  it('reads real counts and issues a signed HttpOnly cookie without counting a GET visit', async () => {
    const store = new MemoryPresenceStore();
    const app = await server(store);
    const response = await app.inject('/api/presence');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      active_visitors: 0, total_visitors: 0, as_of: '2026-10-07T19:00:00.000Z',
      window_seconds: 90, counting_since: null,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(String(response.headers['set-cookie'])).toContain('code_pulse_visitor=');
    expect(String(response.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(String(response.headers['set-cookie'])).toMatch(/SameSite=Lax/i);
    expect(await store.readTotal()).toBeNull();
  });

  it('counts repeated requests and another server instance only once for a browser cookie', async () => {
    const store = new MemoryPresenceStore();
    const first = await server(store);
    const second = await server(store);
    const cookie = await visitorCookie(first);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).inject({
      method: 'POST', url: '/api/presence', headers: headers(cookie), payload: {},
    })));

    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ active_visitors: 1, total_visitors: 1, counting_since: '2026-10-07T19:00:00.000Z' });
    }
    await first.close();
    const restarted = await server(store);
    const response = await restarted.inject({ method: 'POST', url: '/api/presence', headers: headers(cookie), payload: {} });
    expect(response.json()).toMatchObject({ active_visitors: 1, total_visitors: 1 });
  });

  it('expires activity after 90 seconds while a returning cookie keeps its lifetime total', async () => {
    let time = start;
    const app = await server(new MemoryPresenceStore(), { now: () => time });
    const first = await visitorCookie(app);
    const second = await visitorCookie(app);
    await app.inject({ method: 'POST', url: '/api/presence', headers: headers(first), payload: {} });
    time += 30_000;
    await app.inject({ method: 'POST', url: '/api/presence', headers: headers(second), payload: {} });
    time = start + 90_000;
    const atBoundary = await app.inject({ url: '/api/presence', headers: { cookie: first } });
    expect(atBoundary.json()).toMatchObject({ active_visitors: 1, total_visitors: 2 });
    time = start + 120_000;
    expect((await app.inject({ url: '/api/presence', headers: { cookie: first } })).json()).toMatchObject({ active_visitors: 0, total_visitors: 2 });
    const returned = await app.inject({ method: 'POST', url: '/api/presence', headers: headers(first), payload: {} });
    expect(returned.json()).toMatchObject({ active_visitors: 1, total_visitors: 2 });
  });

  it.each(['missing cookie', 'unsigned cookie', 'tampered cookie', 'foreign origin', 'missing origin', 'missing header'] as const)(
    'rejects %s without recording a visit',
    async problem => {
      const store = new MemoryPresenceStore();
      const app = await server(store);
      const cookie = await visitorCookie(app);
      const requestHeaders: Record<string, string> = headers(cookie);
      if (problem === 'missing cookie') delete requestHeaders.cookie;
      if (problem === 'unsigned cookie') requestHeaders.cookie = 'code_pulse_visitor=11111111-1111-4111-8111-111111111111';
      if (problem === 'tampered cookie') requestHeaders.cookie = `${cookie.slice(0, -1)}${cookie.endsWith('x') ? 'y' : 'x'}`;
      if (problem === 'foreign origin') requestHeaders.origin = 'https://elsewhere.example';
      if (problem === 'missing origin') delete requestHeaders.origin;
      if (problem === 'missing header') delete requestHeaders['x-code-pulse-client'];
      const response = await app.inject({ method: 'POST', url: '/api/presence', headers: requestHeaders, payload: {} });

      expect(response.statusCode).toBe(problem.includes('cookie') ? 401 : 403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).not.toHaveProperty('total_visitors');
      expect(await store.readTotal()).toBeNull();
    },
  );

  it.each([{ visitor_id: 'chosen-by-client' }, { total_visitors: 9000 }, [], null, '{}'].map(payload => ({ payload })))(
    'accepts only an empty JSON object, rejecting $payload',
    async ({ payload }) => {
      const store = new MemoryPresenceStore();
      const app = await server(store);
      const cookie = await visitorCookie(app);
      const response = await app.inject({
        method: 'POST', url: '/api/presence', headers: headers(cookie), payload: JSON.stringify(payload),
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(await store.readTotal()).toBeNull();
    },
  );

  it('uses configured PUBLIC_ORIGIN behind a proxy and makes the cookie Secure for HTTPS', async () => {
    const app = await server(new MemoryPresenceStore(), { publicOrigin: 'https://code-pulse.example' });
    const initial = await app.inject({ url: '/api/presence', headers: { host: 'internal-ecs.local:8080' } });
    expect(initial.statusCode).toBe(200);
    expect(String(initial.headers['set-cookie'])).toMatch(/Secure/i);
    const cookie = String(initial.headers['set-cookie']).split(';')[0];
    const response = await app.inject({
      method: 'POST', url: '/api/presence', payload: {},
      headers: { ...headers(cookie, 'https://code-pulse.example'), host: 'internal-ecs.local:8080' },
    });
    expect(response.statusCode).toBe(200);
    const wrong = await app.inject({
      method: 'POST', url: '/api/presence', payload: {},
      headers: { ...headers(cookie, 'https://elsewhere.example'), host: 'elsewhere.example', 'x-forwarded-host': 'code-pulse.example' },
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('uses the actual local Host and does not trust forwarded origin headers', async () => {
    const app = await server();
    const cookie = await visitorCookie(app);
    const response = await app.inject({
      method: 'POST', url: '/api/presence', payload: {},
      headers: { ...headers(cookie, 'http://localhost:8080'), host: 'localhost:8080' },
    });
    expect(response.statusCode).toBe(200);
    const forged = await app.inject({
      method: 'POST', url: '/api/presence', payload: {},
      headers: { ...headers(cookie, 'https://elsewhere.example'), host: 'localhost:8080', 'x-forwarded-host': 'elsewhere.example', 'x-forwarded-proto': 'https' },
    });
    expect(forged.statusCode).toBe(403);
  });

  it('returns 503 with no invented counts for a failed or incomplete aggregate', async () => {
    const store = new MemoryPresenceStore();
    const app = await server(store);
    vi.spyOn(store, 'countActive').mockRejectedValueOnce(new Error('private database failure'));
    const failed = await app.inject('/api/presence');
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['cache-control']).toBe('no-store');
    expect(failed.json()).not.toHaveProperty('total_visitors');
    expect(failed.body).not.toContain('private database');
    vi.spyOn(store, 'countActive').mockResolvedValueOnce(2);
    const inconsistent = await app.inject('/api/presence');
    expect(inconsistent.statusCode).toBe(503);
    expect(inconsistent.json()).not.toHaveProperty('active_visitors');
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });

  it('bounds unresponsive storage and isolates presence from the feed cache', async () => {
    const store = new MemoryPresenceStore();
    const app = await server(store, { timeoutMs: 25 });
    expect((await app.inject('/api/feed')).statusCode).toBe(200);
    vi.spyOn(store, 'countActive').mockImplementationOnce(async () => new Promise<number>(() => {}));
    const failed = await app.inject('/api/presence');
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['cache-control']).toBe('no-store');
    expect((await app.inject('/api/feed')).statusCode).toBe(200);
  });

  it('fails closed when a persistent table has no shared signing secret', async () => {
    vi.stubEnv('PRESENCE_TABLE', 'configured-table');
    vi.stubEnv('PRESENCE_SECRET', '');
    const app = await createServer(snapshots, { staticDirectory: false });
    servers.push(app);
    const response = await app.inject('/api/presence');
    expect(response.statusCode).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });
});

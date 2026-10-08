import { createHash, randomBytes, randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PresenceSnapshot } from '../shared/types.js';
import {
  DynamoPresenceStore, MemoryPresenceStore, presenceUnavailable, validPresenceCount,
  validatePresenceTotal, type PresenceStore,
} from './presence-store.js';

const COOKIE_NAME = 'code_pulse_visitor';
const WINDOW_SECONDS = 90;
const WINDOW_MS = WINDOW_SECONDS * 1000;
const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PresenceOptions {
  store?: PresenceStore;
  table?: string;
  secret?: string;
  publicOrigin?: string;
  now?: () => number;
  timeoutMs?: number;
  maxPending?: number;
}

function createService(store: PresenceStore, options: PresenceOptions) {
  const clock = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxPending = options.maxPending ?? 64;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 1000) {
    throw new Error('Invalid presence request limits.');
  }
  const lifetime = new AbortController();
  let pending = 0;
  function now() {
    const value = clock();
    if (!validPresenceCount(value) || !Number.isFinite(new Date(value).getTime())) throw presenceUnavailable();
    return value;
  }
  async function run(work: (signal: AbortSignal) => Promise<PresenceSnapshot>): Promise<PresenceSnapshot> {
    if (lifetime.signal.aborted || pending >= maxPending) throw presenceUnavailable();
    pending++;
    const deadline = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(presenceUnavailable()), timeoutMs).unref();
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(presenceUnavailable());
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        signal.throwIfAborted();
        return work(signal);
      }), interrupted]);
    } finally {
      pending--;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
  async function aggregate(signal: AbortSignal): Promise<PresenceSnapshot> {
    const asOf = now();
    const active = await store.countActive(asOf - WINDOW_MS, asOf, { signal });
    signal.throwIfAborted();
    // Visits are counted before activity is published. Reading total after the
    // complete query avoids undercounting totals during concurrent first visits.
    const record = await store.readTotal({ signal });
    signal.throwIfAborted();
    const total = record === null ? { total_visitors: 0, counting_since: null } : validatePresenceTotal(record);
    if (!validPresenceCount(active) || active > total.total_visitors) throw presenceUnavailable();
    return { active_visitors: active, ...total, as_of: new Date(asOf).toISOString(), window_seconds: WINDOW_SECONDS };
  }
  return {
    snapshot: () => run(aggregate),
    heartbeat: (visitor: string) => run(async signal => {
      const hash = createHash('sha256').update('code-pulse:presence:v1\0').update(visitor).digest('hex');
      const time = now();
      await store.remember(hash, time, { signal });
      signal.throwIfAborted();
      await store.touch(hash, time, WINDOW_MS, { signal });
      signal.throwIfAborted();
      return aggregate(signal);
    }),
    close() {
      lifetime.abort(presenceUnavailable());
      if (!options.store) store.close?.();
    },
  };
}

function origin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
    return parsed.origin;
  } catch { return undefined; }
}

export async function registerPresenceApi(app: FastifyInstance, options: PresenceOptions = {}): Promise<void> {
  const table = options.table ?? process.env.PRESENCE_TABLE;
  const local = !table && process.env.NODE_ENV !== 'production';
  const secret = options.secret ?? process.env.PRESENCE_SECRET ?? (local ? randomBytes(32).toString('base64url') : undefined);
  const validSecret = typeof secret === 'string' && secret.trim().length >= 32;
  const configuredOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
  const publicOrigin = configuredOrigin === undefined ? undefined : origin(configuredOrigin);
  const validOrigin = configuredOrigin === undefined || publicOrigin !== undefined;
  const backend = options.store ?? (table ? new DynamoPresenceStore({ table }) : local ? new MemoryPresenceStore() : undefined);
  const service = backend ? createService(backend, options) : undefined;
  const available = validSecret && validOrigin && service !== undefined;
  await app.register(cookie, { ...(validSecret ? { secret } : {}), hook: 'onRequest' });
  app.addHook('onClose', async () => { service?.close(); });

  const expectedOrigin = (request: FastifyRequest) => publicOrigin
    ?? (request.headers.host ? origin(`${request.protocol}://${request.headers.host}`) : undefined);
  function visitor(request: FastifyRequest): string | undefined {
    const value = request.cookies[COOKIE_NAME];
    if (!value) return undefined;
    try {
      const verified = request.unsignCookie(value);
      return verified.valid && verified.value && VISITOR_ID.test(verified.value) ? verified.value : undefined;
    } catch { return undefined; }
  }
  const noStore = async (_request: FastifyRequest, reply: FastifyReply) => { reply.header('Cache-Control', 'no-store'); };
  const unavailable = (reply: FastifyReply) => reply.code(503).header('Retry-After', '5')
    .send({ error: '접속 집계를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });

  app.get('/api/presence', { onRequest: noStore }, async (request, reply) => {
    if (!available) return unavailable(reply);
    try {
      const snapshot = await service!.snapshot();
      if (!visitor(request)) {
        reply.setCookie(COOKIE_NAME, randomUUID(), {
          signed: true, httpOnly: true, sameSite: 'lax', path: '/api/presence',
          secure: expectedOrigin(request)?.startsWith('https:') ?? false,
          maxAge: 365 * 24 * 60 * 60,
        });
      }
      return snapshot;
    } catch { return unavailable(reply); }
  });

  app.post('/api/presence', { onRequest: noStore, bodyLimit: 1024 }, async (request, reply) => {
    if (!available) return unavailable(reply);
    if (request.headers['x-code-pulse-client'] !== '1'
      || !request.headers.origin || request.headers.origin !== expectedOrigin(request)) {
      return reply.code(403).send({ error: '같은 사이트의 방문 확인 요청만 허용합니다.' });
    }
    const id = visitor(request);
    if (!id) return reply.code(401).send({ error: '방문자 쿠키를 먼저 확인해 주세요.' });
    // Do not use an AJV schema that could silently remove client-supplied IDs/counts.
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')
      || request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).length !== 0) {
      return reply.code(400).send({ error: '내용이 없는 JSON 객체만 허용합니다.' });
    }
    try { return await service!.heartbeat(id); }
    catch { return unavailable(reply); }
  });
}

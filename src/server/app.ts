import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyReply } from 'fastify';
import compress from '@fastify/compress';
import staticFiles from '@fastify/static';
import type { SnapshotStore } from '../collector/store.js';
import { SOURCES } from '../collector/sources.js';
import { PRODUCT_IDS, type Entry, type Feed, type FeedEntry, type Language, type ProductId, type Snapshot, type SourceStatus } from '../shared/types.js';
import { registerPresenceApi, type PresenceOptions } from './presence.js';
import { renderRss, resolvePublicBaseUrl } from './rss.js';
import { publicEntry } from './public-entry.js';
import { publicEntryInLanguage, sourceLabelInLanguage } from '../publishing/projection.js';
import { COLLECTION_SCHEDULE } from '../shared/schedule.js';

function languageOf(value: unknown): Language | null {
  return value === undefined || value === 'ko' ? 'ko' : value === 'en' ? 'en' : null;
}

export interface ServerOptions {
  staticDirectory?: string | false;
  siteDirectory?: string | false;
  publicBaseUrl?: string;
  now?: () => Date;
  cacheTtlMs?: number;
  presence?: PresenceOptions;
}

export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'",
  "img-src 'self' data:", "connect-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export async function createServer(store: SnapshotStore, options: ServerOptions = {}) {
  const publicBaseUrl = resolvePublicBaseUrl(options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL);
  const configuredSite = options.siteDirectory === false ? undefined : options.siteDirectory ?? process.env.SITE_DIR;
  const siteDirectory = configuredSite ? resolve(configuredSite) : undefined;
  const staticDirectory = siteDirectory ?? (options.staticDirectory === false ? false
    : resolve(options.staticDirectory ?? process.env.STATIC_DIR ?? './dist/public'));
  const app = Fastify({
    logger: process.env.NODE_ENV === 'production', bodyLimit: 16 * 1024, requestTimeout: 30_000,
    rewriteUrl: request => {
      if (!siteDirectory) return request.url ?? '/';
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/' && url.pathname !== '/index.html') return request.url ?? '/';
      const language = url.searchParams.get('lang') === 'en' ? 'en' : 'ko';
      const entry = url.searchParams.get('entry');
      if (entry && !/^[a-z0-9-]{1,128}$/.test(entry)) return '/__code_pulse_missing__';
      return `/pages/${language}/${entry || 'index'}.html`;
    },
  });
  const clock = options.now ?? (() => new Date());
  const ttl = options.cacheTtlMs ?? 60_000;
  let cached: Snapshot | undefined;
  let publicEntries = new WeakMap<Entry, FeedEntry>();
  let englishEntries = new WeakMap<Entry, FeedEntry>();
  let expiresAt = 0;
  let reading: Promise<{ snapshot: Snapshot; storageStale: boolean }> | undefined;

  async function current() {
    if (cached && clock().getTime() < expiresAt) return { snapshot: cached, storageStale: false };
    if (!reading) {
      reading = (async () => {
        try {
          const { snapshot } = await store.read();
          cached = snapshot;
          publicEntries = new WeakMap();
          englishEntries = new WeakMap();
          expiresAt = clock().getTime() + ttl;
          return { snapshot, storageStale: false };
        } catch (error) {
          app.log.warn({ err: error }, 'snapshot read failed');
          if (cached) return { snapshot: cached, storageStale: true };
          throw error;
        }
      })();
    }
    try { return await reading; } finally { reading = undefined; }
  }
  function unavailable(reply: FastifyReply) {
    return reply.code(503).header('Cache-Control', 'no-store').send({ error: '변경 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  }
  function serializeEntry(entry: Entry, language: Language = 'ko'): FeedEntry {
    // The full inventory is checked once per loaded snapshot, not on every
    // reader request. A fresh store read also clears this derived cache.
    const entries = language === 'en' ? englishEntries : publicEntries;
    const existing = entries.get(entry);
    if (existing) return existing;
    const visible = language === 'en' ? publicEntryInLanguage(entry, 'en') : publicEntry(entry);
    entries.set(entry, visible);
    return visible;
  }
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Strict-Transport-Security', 'max-age=31536000');
  });
  await app.register(compress, { global: true, threshold: 1024 });
  await registerPresenceApi(app, {
    ...options.presence, now: options.presence?.now ?? (() => clock().getTime()),
  });

  app.get('/healthz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', service: 'code-pulse' };
  });
  app.get<{ Querystring: { product?: unknown; lang?: unknown } }>('/feed.xml', async (request, reply) => {
    const product = request.query.product;
    const language = languageOf(request.query.lang);
    if (!language || Object.keys(request.query).some(key => key !== 'product' && key !== 'lang')
      || (product !== undefined && (typeof product !== 'string' || !PRODUCT_IDS.includes(product as ProductId)))) {
      return reply.code(400).header('Cache-Control', 'no-store')
        .send({ error: 'product에는 claude-code, codex, kiro 중 하나만 지정해 주세요.' });
    }
    try {
      const { snapshot, storageStale } = await current();
      const body = renderRss(snapshot.entries.map(entry => serializeEntry(entry, language)), {
        publicBaseUrl, now: clock(), product: product as ProductId | undefined, language,
      });
      return reply.type('application/rss+xml; charset=utf-8')
        .header('Cache-Control', storageStale ? 'no-store' : 'public, max-age=30, s-maxage=60')
        .send(body);
    } catch { return unavailable(reply); }
  });
  app.get<{ Querystring: { lang?: unknown } }>('/api/feed', async (request, reply) => {
    const language = languageOf(request.query.lang);
    if (!language) return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'lang must be ko or en.' });
    try {
      const { snapshot, storageStale } = await current();
      const sources: SourceStatus[] = snapshot.sources.length ? snapshot.sources : SOURCES.map(source => ({
        id: source.id, product: source.product, name: source.name, url: source.url, state: 'pending' as const, entryCount: 0,
      }));
      const stale = storageStale || sources.some(source =>
        !source.lastSuccessAt || clock().getTime() - Date.parse(source.lastSuccessAt) > 26 * 60 * 60_000);
      const feed: Feed = {
        generatedAt: snapshot.generatedAt, entries: snapshot.entries.map(entry => serializeEntry(entry, language)),
        sources: language === 'en' ? sources.map(source => ({ ...source, name: sourceLabelInLanguage(source.name, language) })) : sources,
        latestRun: snapshot.runs[0], schedule: COLLECTION_SCHEDULE, stale, language,
      };
      reply.header('Cache-Control', storageStale ? 'no-store' : 'public, max-age=30, s-maxage=60');
      return feed;
    } catch { return unavailable(reply); }
  });
  app.get<{ Params: { id: string }; Querystring: { lang?: unknown } }>('/api/entries/:id', async (request, reply) => {
    const language = languageOf(request.query.lang);
    if (!language) return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'lang must be ko or en.' });
    try {
      const { snapshot, storageStale } = await current();
      const entry = snapshot.entries.find(item => item.id === request.params.id);
      if (!entry) return reply.code(404).header('Cache-Control', 'no-store').send({ error: '이 변경 기록을 찾을 수 없습니다.' });
      reply.header('Cache-Control', storageStale ? 'no-store' : 'public, max-age=30, s-maxage=60');
      return { ...serializeEntry(entry, language), originalText: '', contentHash: '' };
    } catch { return unavailable(reply); }
  });
  app.get('/robots.txt', async (_request, reply) => {
    reply.type('text/plain').header('Cache-Control', 'public, max-age=86400');
    return 'User-agent: *\nAllow: /\n';
  });

  if (staticDirectory && existsSync(staticDirectory)) {
    await app.register(staticFiles, {
      root: staticDirectory, wildcard: true, index: ['index.html'],
      allowedPath: path => !path.split(/[\\/]/u).includes('_publication'),
      setHeaders(reply, path) {
        reply.header('Cache-Control', siteDirectory
          ? path.includes('/assets/') || path.includes('/content/objects/')
            ? 'public, max-age=31536000, immutable' : 'public, max-age=0, s-maxage=60, must-revalidate'
          : path.endsWith('index.html') ? 'no-cache'
          : path.includes('/assets/') || path.includes('/fonts/') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400');
      },
    });
  }
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0];
    if (!siteDirectory && staticDirectory && existsSync(resolve(staticDirectory, 'index.html')) && request.method === 'GET'
      && !pathname.startsWith('/api/') && !pathname.includes('.')) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).header('Cache-Control', 'no-store').send({ error: '요청한 페이지를 찾을 수 없습니다.' });
  });
  return app;
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { load } from 'cheerio';
import { createServer, type ServerOptions } from '../src/server/app.js';
import { emptySnapshot, type SnapshotStore } from '../src/collector/store.js';
import type { Entry, ProductId, Snapshot } from '../src/shared/types.js';

const NOW = '2026-10-08T01:00:00Z';
const BASE_URL = 'https://pulse.example/';
const ready: Entry = {
  id: 'kiro-ready', product: 'kiro', channel: 'cli', sourceId: 'kiro-changelog',
  originalTitle: 'Hook matching', publishedAt: '2026-10-05T00:00:00Z',
  publishedDate: '2026-10-05', datePrecision: 'day',
  sourceUrl: 'https://kiro.dev/changelog/cli/2-28/', references: [],
  originalText: 'PRIVATE_ARCHIVED_SOURCE_BODY',
  contentHash: 'PRIVATE_SOURCE_HASH', explanationModel: 'PRIVATE_MODEL_IDENTIFIER',
  firstSeenAt: '2026-10-07T00:00:00Z', checkedAt: '2026-10-07T01:00:00Z',
  updatedAt: '2026-10-07T02:00:00Z', explanationEditedAt: '2026-10-07T03:00:00Z',
  explanationStatus: 'ready',
  explanation: {
    title: '훅 조건을 더 정확하게 적용합니다',
    summary: '파일에 맞는 훅을 실행합니다.',
    whyItMatters: '필요한 작업에만 자동 명령을 적용할 수 있습니다.',
    actionItems: ['기존 훅의 조건을 확인하세요.'], highlights: [],
    audience: ['CLI 사용자'], category: 'improvement', impact: 'medium',
  },
};

function snapshot(entries: Entry[] = [ready]): Snapshot {
  return { ...emptySnapshot(), generatedAt: '2026-10-07T04:00:00Z', entries };
}

function storeFor(value: Snapshot): SnapshotStore {
  return {
    read: async () => ({ snapshot: value }),
    write: async () => { throw new Error('Reading RSS must not publish content.'); },
  };
}

const servers: FastifyInstance[] = [];
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('PUBLIC_BASE_URL', undefined);
  vi.stubEnv('PRESENCE_TABLE', undefined);
  vi.stubEnv('PRESENCE_SECRET', undefined);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(app => app.close()));
  vi.unstubAllEnvs();
});

async function server(store = storeFor(snapshot()), options: ServerOptions = {}) {
  const app = await createServer(store, {
    staticDirectory: false, publicBaseUrl: BASE_URL, cacheTtlMs: 0,
    now: () => new Date(NOW), ...options,
  });
  servers.push(app);
  return app;
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  guid: { '#text': string; '@_isPermaLink': string };
  pubDate: string;
  category: string;
}
interface RssChannel {
  title: string;
  link: string;
  description: string;
  language: string;
  'atom:link': { '@_href': string; '@_rel': string; '@_type': string };
  item?: RssItem[];
  pubDate?: string;
  lastBuildDate?: string;
}
function parse(body: string): RssChannel {
  expect(XMLValidator.validate(body)).toBe(true);
  const result = new XMLParser({
    ignoreAttributes: false, parseTagValue: false, trimValues: false,
    isArray: (_name, path) => path === 'rss.channel.item',
  }).parse(body);
  expect(result.rss['@_version']).toBe('2.0');
  return result.rss.channel;
}

describe('RSS subscription', () => {
  it('pins Korean reading links while preserving existing subscription GUIDs', async () => {
    const app = await server();
    const channel = parse((await app.inject('/feed.xml')).body);
    expect(new URL(channel.link).searchParams.get('lang')).toBe('ko');
    expect(new URL(channel.item![0].link).searchParams.get('lang')).toBe('ko');
    expect(channel.item![0].guid['#text']).toBe('https://pulse.example/?entry=kiro-ready');
  });
  it('serves every English source item with English labels and share links', async () => {
    const app = await server(storeFor(snapshot([{ ...ready, originalText: '- Added task hooks.\n- Fixed interrupted sessions.' }])));
    const response = await app.inject('/feed.xml?lang=en&product=kiro');
    expect(response.statusCode).toBe(200);
    const channel = parse(response.body);
    expect(channel.language).toBe('en');
    expect(channel.title).toBe('Code Pulse | Kiro changelog');
    const item = channel.item![0];
    expect(item.title).toContain('Hook matching');
    expect(new URL(item.link).searchParams.get('lang')).toBe('en');
    expect(load(item.description)('ol li').map((_, element) => load(element).text()).get()).toEqual(['Added task hooks.', 'Fixed interrupted sessions.']);
    expect(load(item.description).text()).toContain('Official English release notes');
    expect(item.description).not.toContain('PRIVATE_MODEL_IDENTIFIER');
    expect(item.description).not.toContain('PRIVATE_SOURCE_HASH');
    expect(item.description).not.toContain('AI 해설');
    expect((await app.inject('/feed.xml?lang=fr')).statusCode).toBe(400);
  });
  it('serves Korean explanations with stable detail links, original dates, and official attribution', async () => {
    const app = await server();
    const response = await app.inject('/feed.xml');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/rss+xml; charset=utf-8');
    expect(response.headers['cache-control']).toBe('public, max-age=30, s-maxage=60');
    expect(response.headers['set-cookie']).toBeUndefined();
    const channel = parse(response.body);
    expect(channel.title).toContain('Code Pulse');
    expect(channel.link).toBe('https://pulse.example/?lang=ko');
    expect(channel.language).toBe('ko');
    expect(channel['atom:link']).toMatchObject({
      '@_href': 'https://pulse.example/feed.xml',
      '@_rel': 'self', '@_type': 'application/rss+xml',
    });
    expect(channel.item).toHaveLength(1);
    const item = channel.item![0];
    expect(item.title).toContain('Kiro');
    expect(item.title).toContain('훅 조건을 더 정확하게 적용합니다');
    expect(item.link).toBe('https://pulse.example/?entry=kiro-ready&lang=ko');
    expect(item.guid).toEqual({ '#text': 'https://pulse.example/?entry=kiro-ready', '@_isPermaLink': 'true' });
    expect(item.pubDate).toBe('Mon, 05 Oct 2026 00:00:00 GMT');
    const html = load(item.description);
    expect(html.text()).toContain('AI 해설');
    expect(html.text()).toContain('원문 발표일: 2026-10-05');
    expect(html.text()).toContain('발표 시각 미제공');
    expect(html.text()).toContain('파일에 맞는 훅을 실행합니다.');
    expect(html.text()).toContain('필요한 작업에만 자동 명령을 적용할 수 있습니다.');
    expect(html('a').map((_index, element) => html(element).attr('href')).get()).toEqual([
      'https://pulse.example/?entry=kiro-ready&lang=ko', 'https://kiro.dev/changelog/cli/2-28/',
    ]);
    for (const privateValue of [
      'PRIVATE_ARCHIVED_SOURCE_BODY', 'PRIVATE_SOURCE_HASH', 'PRIVATE_MODEL_IDENTIFIER',
      'originalText', 'contentHash', 'explanationModel', 'total_visitors', 'active_visitors',
    ]) expect(response.body).not.toContain(privateValue);
  });

  it.each<ProductId>(['claude-code', 'codex', 'kiro'])('offers a separate %s subscription', async product => {
    const app = await server(storeFor(snapshot([
      { ...ready, id: 'claude-item', product: 'claude-code' },
      { ...ready, id: 'codex-item', product: 'codex' },
      { ...ready, id: 'kiro-item', product: 'kiro' },
    ])));
    const all = parse((await app.inject('/feed.xml')).body);
    expect(all.item).toHaveLength(3);
    const selected = parse((await app.inject(`/feed.xml?product=${product}`)).body);
    expect(selected.item).toHaveLength(1);
    const expectedId = { 'claude-code': 'claude-item', codex: 'codex-item', kiro: 'kiro-item' }[product];
    expect(selected.item![0].link).toBe(`https://pulse.example/?entry=${expectedId}&lang=ko`);
    expect(selected.link).toBe(`https://pulse.example/?product=${product}&lang=ko`);
    expect(selected['atom:link']['@_href']).toBe(`https://pulse.example/feed.xml?product=${product}`);
  });

  it('omits pending explanations, missing explanations, invalid dates, and future publications', async () => {
    const app = await server(storeFor(snapshot([
      ready,
      { ...ready, id: 'pending', explanationStatus: 'pending' },
      { ...ready, id: 'missing', explanation: undefined },
      { ...ready, id: 'invalid-date', publishedAt: 'not-a-date' },
      { ...ready, id: 'future', publishedAt: '2026-10-08T01:00:01Z', publishedDate: '2026-10-08' },
      { ...ready, id: 'at-now', publishedAt: NOW, publishedDate: '2026-10-08', datePrecision: 'timestamp' },
    ])));
    const items = parse((await app.inject('/feed.xml')).body).item!;
    expect(items.map(item => item.guid['#text'])).toEqual([
      'https://pulse.example/?entry=at-now', 'https://pulse.example/?entry=kiro-ready',
    ]);
    expect(items[0].description).not.toContain('발표 시각 미제공');
  });

  it('orders by publication instants and then stable IDs without using edit or collection times', async () => {
    const early = { ...ready, id: 'edited-early', updatedAt: NOW, explanationEditedAt: NOW };
    const equalA = { ...ready, id: 'same-a', datePrecision: 'timestamp' as const, publishedAt: '2026-10-06T12:00:00Z', publishedDate: '2026-10-06' };
    const equalZ = { ...equalA, id: 'same-z', publishedAt: '2026-10-06T21:00:00+09:00' };
    const latest = { ...equalA, id: 'latest', publishedAt: '2026-10-06T12:00:01Z' };
    const input = [equalZ, early, latest, equalA];
    const app = await server(storeFor(snapshot(input)));
    const items = parse((await app.inject('/feed.xml')).body).item!;
    expect(items.map(item => item.guid['#text'])).toEqual([
      'https://pulse.example/?entry=latest', 'https://pulse.example/?entry=same-a',
      'https://pulse.example/?entry=same-z', 'https://pulse.example/?entry=edited-early',
    ]);
    expect(items[1].pubDate).toBe('Tue, 06 Oct 2026 12:00:00 GMT');
    expect(items[2].pubDate).toBe('Tue, 06 Oct 2026 12:00:00 GMT');
    expect(input.map(entry => entry.id)).toEqual(['same-z', 'edited-early', 'latest', 'same-a']);
  });

  it('keeps the same GUID and original publication date after a Korean edit or a new storage check', async () => {
    let value = snapshot();
    const app = await server({ read: async () => ({ snapshot: value }), write: async () => {} });
    const before = parse((await app.inject('/feed.xml')).body).item![0];
    value = {
      ...value, generatedAt: NOW,
      entries: [{
        ...ready, checkedAt: NOW, updatedAt: NOW, explanationEditedAt: NOW,
        explanation: { ...ready.explanation!, summary: '훅 조건을 확인하고 필요한 파일에만 적용합니다.' },
      }],
    };
    const after = parse((await app.inject('/feed.xml')).body).item![0];
    expect(after.guid).toEqual(before.guid);
    expect(after.pubDate).toBe('Mon, 05 Oct 2026 00:00:00 GMT');
    expect(after.description).toContain('훅 조건을 확인하고 필요한 파일에만 적용합니다.');
    expect(after.description).not.toBe(before.description);
  });

  it('limits each selected product to its latest 50 ready publications', async () => {
    const entries = Array.from({ length: 55 }, (_value, index): Entry => ({
      ...ready, id: `kiro-${String(index).padStart(2, '0')}`,
      publishedAt: `2026-10-05T00:00:${String(index).padStart(2, '0')}Z`,
    }));
    entries.push(...Array.from({ length: 55 }, (_value, index): Entry => ({
      ...ready, id: `codex-${index}`, product: 'codex',
      publishedAt: `2026-10-06T00:00:${String(index).padStart(2, '0')}Z`,
      publishedDate: '2026-10-06',
    })));
    const app = await server(storeFor(snapshot(entries)));
    const all = parse((await app.inject('/feed.xml')).body).item!;
    expect(all).toHaveLength(50);
    expect(all.every(item => item.category === 'Codex')).toBe(true);
    const selected = parse((await app.inject('/feed.xml?product=kiro')).body).item!;
    expect(selected).toHaveLength(50);
    expect(selected[0].link).toBe('https://pulse.example/?entry=kiro-54&lang=ko');
    expect(selected[49].link).toBe('https://pulse.example/?entry=kiro-05&lang=ko');
  });

  it.each([
    '?product=', '?product=all', '?product=unknown', '?product=Codex',
    '?product=codex&product=kiro', '?product=codex&product=codex',
    '?product[]=codex', '?product[0]=kiro',
  ])('rejects an invalid or ambiguous product filter: %s', async query => {
    const app = await server();
    const response = await app.inject(`/feed.xml${query}`);
    expect(response.statusCode).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().error).toBeTruthy();
  });

  it('serves an initial empty snapshot as a valid channel without inventing publication dates', async () => {
    const app = await server(storeFor(emptySnapshot()));
    const response = await app.inject('/feed.xml');
    expect(response.statusCode).toBe(200);
    const channel = parse(response.body);
    expect(channel.item ?? []).toHaveLength(0);
    expect(channel.description).toBeTruthy();
    expect(channel.pubDate).toBeUndefined();
    expect(channel.lastBuildDate).toBeUndefined();
    expect(response.body).not.toContain('Invalid Date');
    expect(response.body).not.toContain('1970');
  });

  it('returns 503 without internal storage details when no snapshot has been read', async () => {
    const app = await server({
      read: async () => { throw new Error('PRIVATE_STORAGE_ERROR'); },
      write: async () => {},
    });
    const response = await app.inject('/feed.xml');
    expect(response.statusCode).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain('PRIVATE_STORAGE_ERROR');
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });

  it('shares the existing snapshot cache and preserves readable items during a storage outage', async () => {
    let failed = false;
    const app = await server({
      read: async () => {
        if (failed) throw new Error('storage temporarily unavailable');
        return { snapshot: snapshot() };
      },
      write: async () => {},
    });
    expect((await app.inject('/api/feed')).statusCode).toBe(200);
    failed = true;
    const stale = await app.inject('/feed.xml');
    expect(stale.statusCode).toBe(200);
    expect(stale.headers['cache-control']).toBe('no-store');
    expect(parse(stale.body).item![0].pubDate).toBe('Mon, 05 Oct 2026 00:00:00 GMT');
    failed = false;
    const recovered = await app.inject('/feed.xml');
    expect(recovered.statusCode).toBe(200);
    expect(recovered.headers['cache-control']).toBe('public, max-age=30, s-maxage=60');
  });

  it('uses a cached snapshot before expiry and refreshes the RSS view after expiry', async () => {
    let time = Date.parse(NOW);
    let value = snapshot();
    const app = await server(
      { read: async () => ({ snapshot: value }), write: async () => {} },
      { now: () => new Date(time), cacheTtlMs: 60_000 },
    );
    expect((await app.inject('/api/feed')).statusCode).toBe(200);
    value = snapshot([{ ...ready, id: 'later-read' }]);
    expect(parse((await app.inject('/feed.xml')).body).item![0].link).toBe('https://pulse.example/?entry=kiro-ready&lang=ko');
    time += 60_000;
    expect(parse((await app.inject('/feed.xml')).body).item![0].link).toBe('https://pulse.example/?entry=later-read&lang=ko');
  });

  it('encodes XML and embedded HTML independently and replaces XML 1.0 forbidden characters', async () => {
    const unsafe = '<script>alert("x&y")</script> ]]> \u0000\u0001\u000B\u000C\u001F\uD800\uDC00\uDFFF\uFFFE\uFFFF 끝 😀';
    const app = await server(storeFor(snapshot([{
      ...ready,
      id: 'id&x="<img src=x onerror=alert(1)>#',
      sourceUrl: 'https://kiro.dev/changelog/cli/2-28/?a=1&note="><img src=x onerror=alert(1)>',
      explanation: { ...ready.explanation!, title: unsafe, summary: unsafe, whyItMatters: unsafe },
    }])));
    const response = await app.inject('/feed.xml');
    expect(response.statusCode).toBe(200);
    const item = parse(response.body).item![0];
    expect(response.body).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u);
    expect(item.title).toContain('<script>alert("x&y")</script> ]]>');
    expect(item.title).toContain('끝 😀');
    const html = load(item.description);
    expect(html('script, img, iframe, object')).toHaveLength(0);
    expect(html('[onerror], [onclick]')).toHaveLength(0);
    expect(html.text()).toContain('<script>alert("x&y")</script> ]]>');
    expect(html('a')).toHaveLength(2);
    expect(html('a').eq(0).attr('href')).toBe('https://pulse.example/?entry=id%26x%3D%22%3Cimg+src%3Dx+onerror%3Dalert%281%29%3E%23&lang=ko');
    expect(html('a').eq(1).attr('href')).toBe('https://kiro.dev/changelog/cli/2-28/?a=1&note=%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E');
  });

  it.each([
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'http://kiro.dev/changelog/', 'https://untrusted.example/changelog/',
    'https://private-user:private-password@kiro.dev/changelog/',
  ])('does not publish an unsafe or nonofficial source link: %s', async sourceUrl => {
    const app = await server(storeFor(snapshot([{ ...ready, sourceUrl }])));
    const response = await app.inject('/feed.xml');
    const item = parse(response.body).item![0];
    const html = load(item.description);
    expect(html('a').map((_index, element) => html(element).attr('href')).get()).toEqual([
      'https://pulse.example/?entry=kiro-ready&lang=ko',
    ]);
    expect(response.body).not.toContain('private-password');
    expect(response.body).not.toContain('untrusted.example');
  });

  it('keeps canonical links independent of malicious Host and forwarded headers', async () => {
    const app = await server();
    const response = await app.inject({
      method: 'GET', url: '/feed.xml',
      headers: {
        host: 'attacker.invalid',
        'x-forwarded-host': 'forwarded.invalid',
        'x-forwarded-proto': 'http',
        forwarded: 'host=another.invalid;proto=http',
      },
    });
    const channel = parse(response.body);
    expect(channel.link).toBe('https://pulse.example/?lang=ko');
    expect(channel.item![0].guid['#text']).toBe('https://pulse.example/?entry=kiro-ready');
    expect(response.body).not.toMatch(/attacker|forwarded\.invalid|another\.invalid/);
  });

  it('uses PUBLIC_BASE_URL in the deployed configuration', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PUBLIC_BASE_URL', 'https://configured.example');
    const app = await server(undefined, { publicBaseUrl: undefined });
    const channel = parse((await app.inject('/feed.xml')).body);
    expect(channel.link).toBe('https://configured.example/?lang=ko');
    expect(channel.item![0].link).toBe('https://configured.example/?entry=kiro-ready&lang=ko');
  });

  it('uses localhost only for an unconfigured development server', async () => {
    const app = await server(undefined, { publicBaseUrl: undefined });
    const channel = parse((await app.inject('/feed.xml')).body);
    expect(channel.link).toBe('http://localhost:8080/?lang=ko');
  });

  it('rejects a missing production canonical URL instead of guessing from a request', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(server(undefined, { publicBaseUrl: undefined }).then(() => undefined)).rejects.toThrow('PUBLIC_BASE_URL');
  });

  it.each([
    '', '/relative', 'javascript:alert(1)', 'ftp://pulse.example/',
    'https://user:private-password@pulse.example/', 'https://pulse.example/path',
    'https://pulse.example/?entry=other', 'https://pulse.example/#fragment',
    ' https://pulse.example/', 'https://pulse.example\\@attacker.invalid/',
  ])('rejects an invalid configured canonical URL: %s', async publicBaseUrl => {
    await expect(server(undefined, { publicBaseUrl }).then(() => undefined)).rejects.toThrow('PUBLIC_BASE_URL');
  });

  it('requires HTTPS for the production canonical URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(server(undefined, { publicBaseUrl: 'http://pulse.example/' }).then(() => undefined)).rejects.toThrow('PUBLIC_BASE_URL');
  });
});

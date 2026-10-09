import { describe, expect, it, vi } from 'vitest';
import { createRemoteCache, createViewportPrefetcher, canPrefetch, parseBootstrap } from '../src/client/remote-cache';
import type { Feed, FeedEntry, SearchIndex } from '../src/shared/types';

function entry(id = 'one', overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id, product: 'kiro', channel: 'ide', sourceId: 'kiro', originalTitle: `Release ${id}`,
    publishedAt: '2026-10-09T00:00:00Z', publishedDate: '2026-10-09', datePrecision: 'day',
    sourceUrl: 'https://kiro.dev/changelog/', references: [], firstSeenAt: '2026-10-09T00:00:00Z',
    checkedAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', explanationStatus: 'ready',
    language: 'ko', readRevision: '1234567890abcdef', detailUrl: `/content/objects/${id}.json`,
    fullChanges: { status: 'ready', sourceCount: 1, items: [{ id: 'item', text: `All changes for ${id}` }],
      formatVersion: 'test', updatedAt: '2026-10-09T00:00:00Z' }, ...overrides,
  };
}

function feed(entries: FeedEntry[] = [entry()], overrides: Partial<Feed> = {}): Feed {
  return { language: 'ko', generatedAt: '2026-10-09T00:00:00Z', entries, sources: [],
    schedule: { timezone: 'Asia/Seoul', hour: 7 }, stale: false,
    searchUrl: '/content/objects/search.json', ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe('demand content cache', () => {
  it('coalesces a prefetch with navigation and returns the same cached detail immediately', async () => {
    const pending = deferred<Response>();
    const urls: string[] = [];
    const cache = createRemoteCache({ fetcher: async input => { urls.push(String(input)); return pending.promise; } });
    const catalog = feed();
    const prefetched = cache.loadDetail('one', catalog, 'ko', { priority: 'prefetch' });
    const navigated = cache.loadDetail('one', catalog, 'ko');
    pending.resolve(json(entry()));
    expect((await prefetched).fullChanges?.items[0]?.text).toBe('All changes for one');
    expect((await navigated).id).toBe('one');
    expect(urls).toEqual(['/content/objects/one.json']);
    expect(cache.peekDetail('one', catalog, 'ko')?.fullChanges?.items).toHaveLength(1);
    await cache.loadDetail('one', catalog, 'ko');
    expect(urls).toHaveLength(1);
  });

  it('uses a changed immutable URL for a revised release without showing the old revision', async () => {
    const urls: string[] = [];
    const revised = entry('one', { detailUrl: '/content/objects/revised.json', readRevision: 'fedcba0987654321' });
    const cache = createRemoteCache({ fetcher: async input => {
      urls.push(String(input));
      return json(String(input).includes('revised') ? revised : entry());
    } });
    await cache.loadDetail('one', feed(), 'ko');
    expect(cache.peekDetail('one', feed([revised]), 'ko')).toBeNull();
    expect((await cache.loadDetail('one', feed([revised]), 'ko')).readRevision).toBe('fedcba0987654321');
    expect(urls).toEqual(['/content/objects/one.json', '/content/objects/revised.json']);
  });

  it('overlays current checking metadata without downloading unchanged detail', async () => {
    let requests = 0;
    const cache = createRemoteCache({ fetcher: async () => { requests++; return json(entry('one', { checkedAt: '' })); } });
    await cache.loadDetail('one', feed(), 'ko');
    const checked = feed([entry('one', { checkedAt: '2026-10-10T00:00:00Z' })]);
    expect(cache.peekDetail('one', checked, 'ko')?.checkedAt).toBe('2026-10-10T00:00:00Z');
    expect((await cache.loadDetail('one', checked, 'ko')).checkedAt).toBe('2026-10-10T00:00:00Z');
    expect(requests).toBe(1);
  });

  it('seeds listing and deep-link bootstrap without duplicate initial requests', async () => {
    let requests = 0;
    const cache = createRemoteCache({ fetcher: async () => { requests++; throw new Error('offline'); } });
    cache.seedBootstrap({ language: 'ko', feed: feed(), detail: entry() });
    expect(cache.peekFeed('ko')?.entries).toHaveLength(1);
    expect(cache.peekDetail('one', null, 'ko')?.id).toBe('one');
    expect((await cache.loadFeed('ko')).entries).toHaveLength(1);
    expect((await cache.loadDetail('one', feed(), 'ko')).id).toBe('one');
    expect(requests).toBe(0);
  });

  it('revalidates catalogs at most once per minute and preserves content after failed refresh', async () => {
    let now = 0;
    let requests = 0;
    const cache = createRemoteCache({ now: () => now, fetcher: async () => {
      requests++;
      if (requests === 2) throw new Error('offline');
      return json(feed());
    } });
    await cache.loadFeed('ko');
    now = 59_999;
    await cache.loadFeed('ko');
    expect(requests).toBe(1);
    now = 60_000;
    await expect(cache.loadFeed('ko')).rejects.toThrow('offline');
    expect(cache.peekFeed('ko')?.entries).toHaveLength(1);
    await cache.loadFeed('ko');
    expect(requests).toBe(2);
    now = 120_000;
    await cache.loadFeed('ko');
    expect(requests).toBe(3);
  });

  it('evicts the least recently used detail under count and byte budgets', async () => {
    const cache = createRemoteCache({ maxEntries: 2, maxBytes: 5_000, fetcher: async input => {
      const id = String(input).split('/').at(-1)!.replace('.json', '');
      return json(entry(id));
    } });
    const catalog = feed([entry('one'), entry('two'), entry('three')]);
    await cache.loadDetail('one', catalog, 'ko');
    await cache.loadDetail('two', catalog, 'ko');
    cache.peekDetail('one', catalog, 'ko');
    await cache.loadDetail('three', catalog, 'ko');
    expect(cache.peekDetail('two', catalog, 'ko')).toBeNull();
    expect(cache.peekDetail('one', catalog, 'ko')).not.toBeNull();
    expect(cache.peekDetail('three', catalog, 'ko')).not.toBeNull();
    const small = createRemoteCache({ maxBytes: 10, fetcher: async () => json(entry()) });
    expect((await small.loadDetail('one', feed(), 'ko')).id).toBe('one');
    expect(small.peekDetail('one', feed(), 'ko')).toBeNull();
  });

  it('retries failed details without poisoning the cache or caching malformed content', async () => {
    let requests = 0;
    const cache = createRemoteCache({ fetcher: async () => {
      requests++;
      return requests === 1 ? new Response('unavailable', { status: 503 })
        : requests === 2 ? json({ id: 'one' }) : json(entry());
    } });
    await expect(cache.loadDetail('one', feed(), 'ko')).rejects.toThrow();
    expect(cache.peekDetail('one', feed(), 'ko')).toBeNull();
    await expect(cache.loadDetail('one', feed(), 'ko')).rejects.toThrow();
    expect((await cache.loadDetail('one', feed(), 'ko')).id).toBe('one');
    expect(requests).toBe(3);
  });

  it('accepts a pending inventory with no generated items instead of treating it as a fetch error', async () => {
    const pending = entry('one', { fullChanges: undefined, explanationStatus: 'pending',
      changeSummary: { status: 'pending', sourceCount: 12, readyCount: 0 } });
    const cache = createRemoteCache({ fetcher: async () => json(pending) });
    const detail = await cache.loadDetail('one', feed([pending]), 'ko');
    expect(detail.explanationStatus).toBe('pending');
    expect(detail.fullChanges).toBeUndefined();
  });

  it('rate-limits repeated focus refreshes after an initial failure but permits an explicit retry', async () => {
    let requests = 0;
    const cache = createRemoteCache({ now: () => 0, fetcher: async () => {
      requests++;
      return requests === 1 ? new Response('', { status: 503 }) : json(feed());
    } });
    await expect(cache.loadFeed('ko')).rejects.toThrow();
    await cache.loadFeed('ko').catch(() => {});
    expect(requests).toBe(1);
    expect((await cache.loadFeed('ko', { force: true })).entries).toHaveLength(1);
    expect(requests).toBe(2);
  });

  it('times out a stalled response and allows a subsequent detail retry', async () => {
    vi.useFakeTimers();
    try {
      let requests = 0;
      const cache = createRemoteCache({ fetcher: async () => {
        requests++;
        return requests === 1 ? new Promise<Response>(() => {}) : json(entry());
      } });
      const failure = expect(cache.loadDetail('one', feed(), 'ko')).rejects.toThrow('Request aborted');
      await vi.advanceTimersByTimeAsync(20_000);
      await failure;
      expect((await cache.loadDetail('one', feed(), 'ko')).id).toBe('one');
      expect(requests).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('rejects a mismatched detail language or revision', async () => {
    const cache = createRemoteCache({ fetcher: async () => json(entry('one', { language: 'en' })) });
    await expect(cache.loadDetail('one', feed(), 'ko')).rejects.toThrow();
    const stale = createRemoteCache({ fetcher: async () => json(entry('one', { readRevision: '0000000000000000' })) });
    await expect(stale.loadDetail('one', feed(), 'ko')).rejects.toThrow();
  });

  it('does not fall back to the large API feed on production errors', async () => {
    const urls: string[] = [];
    const cache = createRemoteCache({ allowLegacy: false, fetcher: async input => {
      urls.push(String(input)); return new Response('', { status: 404 });
    } });
    await expect(cache.loadFeed('ko')).rejects.toThrow();
    expect(urls).toEqual(['/content/ko/feed.json']);
  });

  it('only uses a development API fallback when static content is definitely absent', async () => {
    const urls: string[] = [];
    const cache = createRemoteCache({ allowLegacy: true, fetcher: async input => {
      urls.push(String(input));
      return String(input).startsWith('/content/') ? new Response('<!doctype html><html></html>', { headers: { 'Content-Type': 'text/html' } }) : json(feed());
    } });
    expect((await cache.loadFeed('ko')).entries).toHaveLength(1);
    expect(urls).toEqual(['/content/ko/feed.json', '/api/feed']);
    const failed: string[] = [];
    const offline = createRemoteCache({ allowLegacy: true, fetcher: async input => {
      failed.push(String(input)); throw new Error('offline');
    } });
    await expect(offline.loadFeed('ko')).rejects.toThrow('offline');
    expect(failed).toEqual(['/content/ko/feed.json']);
  });

  it('loads the complete search index once and checks coverage before accepting results', async () => {
    let requests = 0;
    const index: SearchIndex = { language: 'ko', entries: [{ id: 'one', text: 'summary final-only-search-term' }] };
    const cache = createRemoteCache({ fetcher: async () => { requests++; return json(index); } });
    expect(cache.peekSearch(feed())).toBeNull();
    const first = cache.loadSearch(feed());
    const next = cache.loadSearch(feed());
    expect((await first).entries[0]?.text).toContain('final-only-search-term');
    expect(await next).toEqual(index);
    await cache.loadSearch(feed());
    expect(requests).toBe(1);
    await expect(cache.loadSearch(feed([entry('missing')]))).rejects.toThrow();
  });

  it('resolves every selected saved detail in selection order', async () => {
    const urls: string[] = [];
    const cache = createRemoteCache({ fetcher: async input => {
      urls.push(String(input));
      const id = String(input).split('/').at(-1)!.replace('.json', '');
      return json(entry(id));
    } });
    const selected = ['three', 'one', 'two'].map(id => entry(id, { fullChanges: undefined,
      changeSummary: { status: 'ready', sourceCount: 1, readyCount: 1 } }));
    const resolved = await cache.resolveEntriesForExport(selected, 'ko');
    expect(resolved.map(item => item.id)).toEqual(['three', 'one', 'two']);
    expect(resolved.every(item => item.fullChanges?.items.length === 1)).toBe(true);
    expect(urls).toHaveLength(3);
  });
});

describe('viewport prefetch', () => {
  it('keeps a pending prefetched response when navigation replaces the list', async () => {
    let requests = 0;
    const pending = deferred<Response>();
    const cache = createRemoteCache({ fetcher: async () => { requests++; return pending.promise; } });
    const catalog = feed();
    const prefetch = createViewportPrefetcher(cache, () => true);
    prefetch.update(catalog, ['one']);
    prefetch.stop();
    const navigation = cache.loadDetail('one', catalog, 'ko');
    pending.resolve(json(entry()));
    expect((await navigation).id).toBe('one');
    expect(requests).toBe(1);
  });
  it('limits concurrency, drops old queued cards, and gives navigation priority', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<Response>>>();
    const urls: string[] = [];
    const cache = createRemoteCache({ fetcher: async input => {
      const url = String(input);
      urls.push(url);
      const request = deferred<Response>(); pending.set(url, request);
      return request.promise;
    } });
    const catalog = feed(Array.from({ length: 616 }, (_, index) => entry(String(index))));
    const prefetch = createViewportPrefetcher(cache, () => true);
    prefetch.update(catalog, ['0', '1', '2']);
    await settle();
    expect(urls).toEqual(['/content/objects/0.json', '/content/objects/1.json']);
    const navigation = cache.loadDetail('615', catalog, 'ko');
    await settle();
    expect(urls.at(-1)).toBe('/content/objects/615.json');
    prefetch.update(catalog, ['1', '3']);
    pending.get('/content/objects/0.json')!.resolve(json(entry('0')));
    await settle();
    expect(urls).not.toContain('/content/objects/2.json');
    expect(urls).toContain('/content/objects/3.json');
    pending.get('/content/objects/1.json')!.resolve(json(entry('1')));
    pending.get('/content/objects/3.json')!.resolve(json(entry('3')));
    pending.get('/content/objects/615.json')!.resolve(json(entry('615')));
    expect((await navigation).id).toBe('615');
    await settle();
    expect(urls).toHaveLength(4);
    prefetch.stop();
  });

  it.each([
    { online: false, hidden: false }, { online: true, hidden: true },
    { online: true, hidden: false, saveData: true },
    { online: true, hidden: false, effectiveType: '2g' },
    { online: true, hidden: false, effectiveType: 'slow-2g' },
  ])('does not fetch under reduced network/visibility conditions: %j', async state => {
    let requests = 0;
    const cache = createRemoteCache({ fetcher: async () => { requests++; return json(entry()); } });
    const prefetch = createViewportPrefetcher(cache, () => canPrefetch(state));
    prefetch.update(feed(), ['one']);
    await settle();
    expect(requests).toBe(0);
    prefetch.stop();
  });
});

describe('bootstrap parsing', () => {
  it('reads escaped JSON as data and rejects invalid or mixed-language records', () => {
    const detail = entry('one', { originalTitle: '</template><script>window.hacked=true</script>' });
    const raw = JSON.stringify({ language: 'ko', detail }).replaceAll('<', '\\u003c');
    expect(parseBootstrap(raw)?.detail?.originalTitle).toBe('</template><script>window.hacked=true</script>');
    expect(parseBootstrap('{bad')).toBeNull();
    expect(parseBootstrap(JSON.stringify({ language: 'fr', detail }))).toBeNull();
    expect(parseBootstrap(JSON.stringify({ language: 'en', detail }))).toBeNull();
  });
});

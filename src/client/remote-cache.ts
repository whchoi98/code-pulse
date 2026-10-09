import type { Feed, FeedEntry, Language, SearchIndex, StaticBootstrap } from '../shared/types';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Priority = 'demand' | 'prefetch';
type CachedObject = { value: FeedEntry | SearchIndex; bytes: number; kind: 'detail' | 'search' };
type Flight = { promise: Promise<unknown>; controller: AbortController; priority: Priority };
export type FeedSnapshot = {
  data: Feed | null;
  status: 'loading' | 'ready' | 'error';
  notFound: boolean;
  refreshing: boolean;
  refreshError: boolean;
};
type FeedSlot = { snapshot: FeedSnapshot; attemptedAt: number; flight?: Promise<Feed> };
type CacheOptions = {
  fetcher?: Fetcher;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
  allowLegacy?: boolean;
};

export class RemoteError extends Error {
  constructor(message: string, readonly notFound = false, readonly unavailable = false) { super(message); }
}

const CATALOG_INTERVAL = 60_000;
const REQUEST_TIMEOUT = 20_000;
const EMPTY_FEED: FeedSnapshot = { data: null, status: 'loading', notFound: false, refreshing: false, refreshError: false };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isLanguage = (value: unknown): value is Language => value === 'ko' || value === 'en';

function validEntry(value: unknown): value is FeedEntry {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    && ['claude-code', 'codex', 'kiro'].includes(String(value.product))
    && typeof value.originalTitle === 'string' && typeof value.publishedDate === 'string'
    && typeof value.sourceUrl === 'string' && Array.isArray(value.references)
    && (value.explanationStatus === 'ready' || value.explanationStatus === 'pending')
    && (!value.explanation || (isRecord(value.explanation)
      && typeof value.explanation.title === 'string' && typeof value.explanation.summary === 'string'
      && Array.isArray(value.explanation.highlights) && Array.isArray(value.explanation.actionItems)))
    && (!value.fullChanges || (isRecord(value.fullChanges) && Array.isArray(value.fullChanges.items)
      && value.fullChanges.items.every(item => isRecord(item) && typeof item.id === 'string' && typeof item.text === 'string')));
}

function validFeed(value: unknown, language: Language): value is Feed {
  return isRecord(value) && (value.language === undefined || value.language === language)
    && Array.isArray(value.entries) && value.entries.every(entry => validEntry(entry) && (!entry.language || entry.language === language))
    && Array.isArray(value.sources) && isRecord(value.schedule) && typeof value.schedule.hour === 'number'
    && typeof value.generatedAt === 'string' && typeof value.stale === 'boolean';
}

function validDetail(value: unknown, id: string, language: Language, summary?: FeedEntry): value is FeedEntry {
  return validEntry(value) && value.id === id && (!value.language || value.language === language)
    && (!summary?.readRevision || value.readRevision === summary.readRevision)
    && (!summary?.changeSummary || value.fullChanges !== undefined
      || (summary.changeSummary.status === 'pending' && summary.changeSummary.readyCount === 0));
}

function validateSearch(value: unknown, feed: Feed): asserts value is SearchIndex {
  if (!isRecord(value) || value.language !== (feed.language ?? 'ko') || !Array.isArray(value.entries)
    || !value.entries.every(entry => isRecord(entry) && typeof entry.id === 'string' && typeof entry.text === 'string')) {
    throw new RemoteError('Invalid search index');
  }
  const ids = new Set(value.entries.map(entry => entry.id));
  if (ids.size !== value.entries.length || feed.entries.some(entry => !ids.has(entry.id))) {
    throw new RemoteError('Incomplete search index');
  }
}

function objectUrl(value: string): string {
  // Public artifacts stay on the same origin; arbitrary feed URLs cannot cause cross-origin requests.
  if (!/^\/content\/objects\/[a-zA-Z0-9_-]+\.json$/.test(value)) throw new RemoteError('Invalid content URL');
  return value;
}

function developmentFallback() {
  return typeof window !== 'undefined'
    && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}

export function parseBootstrap(raw: string | null | undefined): StaticBootstrap | null {
  if (!raw || raw.length > 8 * 1024 * 1024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isLanguage(value.language) || (!value.feed && !value.detail)) return null;
    if (value.feed && !validFeed(value.feed, value.language)) return null;
    if (value.detail && (!validEntry(value.detail) || (value.detail.language && value.detail.language !== value.language))) return null;
    return value as unknown as StaticBootstrap;
  } catch { return null; }
}

/** Session memory only. The browser HTTP cache also retains content-addressed responses. */
export function createRemoteCache(options: CacheOptions = {}) {
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 80;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const allowLegacy = () => options.allowLegacy ?? developmentFallback();
  const objects = new Map<string, CachedObject>();
  const flights = new Map<string, Flight>();
  const feeds = new Map<Language, FeedSlot>();
  const listeners = new Set<() => void>();
  const bootstrapDetails = new Map<string, string>();
  const legacyFeeds = new WeakSet<Feed>();
  let bytes = 0;

  function feedSlot(language: Language): FeedSlot {
    let slot = feeds.get(language);
    if (!slot) { slot = { snapshot: EMPTY_FEED, attemptedAt: -Infinity }; feeds.set(language, slot); }
    return slot;
  }

  function publish(slot: FeedSlot, snapshot: FeedSnapshot) {
    slot.snapshot = snapshot;
    for (const listener of listeners) listener();
  }

  function cached(url: string, kind: CachedObject['kind']) {
    const found = objects.get(url);
    if (!found || found.kind !== kind) return null;
    objects.delete(url);
    objects.set(url, found);
    return found.value;
  }

  function remember(url: string, kind: CachedObject['kind'], value: FeedEntry | SearchIndex) {
    const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (size > maxBytes || maxEntries < 1) return;
    const previous = objects.get(url);
    if (previous) { bytes -= previous.bytes; objects.delete(url); }
    while (objects.size && (objects.size >= maxEntries || bytes + size > maxBytes)) {
      const oldest = objects.keys().next().value!;
      bytes -= objects.get(oldest)!.bytes;
      objects.delete(oldest);
    }
    objects.set(url, { value, kind, bytes: size });
    bytes += size;
  }

  async function fetchJson(url: string, controller: AbortController, mutable = false, priority: Priority = 'demand'): Promise<unknown> {
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DOMException('Request aborted', 'AbortError'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await Promise.race([fetcher(url, {
        signal: controller.signal, headers: { Accept: 'application/json' },
        priority: priority === 'prefetch' ? 'low' : 'high',
        ...(mutable ? { cache: 'no-cache' as const } : {}),
      }), aborted]);
      if (!response.ok) throw new RemoteError(`Content request failed (${response.status})`, response.status === 404, response.status === 404);
      if (response.headers.get('Content-Type')?.includes('text/html')) throw new RemoteError('Static content is unavailable', false, true);
      const value: unknown = await Promise.race([response.json(), aborted]);
      return value;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  async function loadObject(url: string, kind: CachedObject['kind'], priority: Priority, validate: (value: unknown) => void, immutable = true) {
    const hit = immutable ? cached(url, kind) : null;
    if (hit) { validate(hit); return hit; }
    const existing = flights.get(url);
    if (existing) {
      if (priority === 'demand') existing.priority = 'demand';
      const value = await existing.promise;
      validate(value);
      return value as FeedEntry | SearchIndex;
    }
    const controller = new AbortController();
    const flight: Flight = { controller, priority, promise: Promise.resolve() };
    flight.promise = (async () => {
      try {
        const value = await fetchJson(url, controller, !immutable, priority);
        validate(value);
        if (immutable) remember(url, kind, value as FeedEntry | SearchIndex);
        return value;
      } finally {
        if (flights.get(url) === flight) flights.delete(url);
      }
    })();
    flights.set(url, flight);
    return await flight.promise as FeedEntry | SearchIndex;
  }

  function loadFeed(language: Language, { force = false }: { force?: boolean } = {}): Promise<Feed> {
    const slot = feedSlot(language);
    if (slot.flight) return slot.flight;
    if (!force && now() - slot.attemptedAt < CATALOG_INTERVAL) {
      if (slot.snapshot.data) return Promise.resolve(slot.snapshot.data);
      if (slot.snapshot.status === 'error') return Promise.reject(new RemoteError('Catalog is temporarily unavailable', slot.snapshot.notFound));
    }
    slot.attemptedAt = now();
    publish(slot, { ...slot.snapshot, status: slot.snapshot.data ? 'ready' : 'loading', refreshing: true, notFound: false });
    slot.flight = (async () => {
      try {
        let value: unknown;
        let legacy = false;
        try { value = await fetchJson(`/content/${language}/feed.json`, new AbortController(), true); }
        catch (error) {
          if (!allowLegacy() || !(error instanceof RemoteError) || !error.unavailable) throw error;
          value = await fetchJson(`/api/feed${language === 'en' ? '?lang=en' : ''}`, new AbortController(), true);
          legacy = true;
        }
        if (!validFeed(value, language)) throw new RemoteError('Invalid feed');
        if (legacy) legacyFeeds.add(value);
        publish(slot, { data: value, status: 'ready', notFound: false, refreshing: false, refreshError: false });
        return value;
      } catch (error) {
        publish(slot, { ...slot.snapshot, status: slot.snapshot.data ? 'ready' : 'error', refreshing: false,
          notFound: error instanceof RemoteError && error.notFound, refreshError: true });
        throw error;
      } finally { slot.flight = undefined; }
    })();
    return slot.flight;
  }

  function mergeDetail(detail: FeedEntry, summary?: FeedEntry): FeedEntry {
    return summary ? { ...detail, checkedAt: summary.checkedAt || detail.checkedAt,
      detailUrl: summary.detailUrl, detailBytes: summary.detailBytes } : detail;
  }

  function peekDetail(id: string, feed: Feed | null, language: Language): FeedEntry | null {
    const summary = feed?.entries.find(entry => entry.id === id);
    if (feed && !summary) return null;
    const url = summary?.detailUrl ?? (!feed ? bootstrapDetails.get(`${language}:${id}`) : undefined);
    if (!url) return null;
    const value = cached(url, 'detail');
    return validDetail(value, id, language, summary) ? mergeDetail(value, summary) : null;
  }

  async function loadEntry(summary: FeedEntry, language: Language, priority: Priority = 'demand', legacy = false): Promise<FeedEntry> {
    const url = summary.detailUrl ? objectUrl(summary.detailUrl)
      : legacy && allowLegacy() ? `/api/entries/${encodeURIComponent(summary.id)}${language === 'en' ? '?lang=en' : ''}` : null;
    if (!url) throw new RemoteError('Detail content is unavailable');
    const value = await loadObject(url, 'detail', priority, value => {
      if (!validDetail(value, summary.id, language, summary)) throw new RemoteError('Invalid entry detail');
    }, Boolean(summary.detailUrl));
    return mergeDetail(value as FeedEntry, summary);
  }

  async function loadDetail(id: string, feed: Feed | null, language: Language, { priority = 'demand' }: { priority?: Priority } = {}): Promise<FeedEntry> {
    const hit = peekDetail(id, feed, language);
    if (hit) return hit;
    const catalog = feed ?? await loadFeed(language);
    const summary = catalog.entries.find(entry => entry.id === id);
    if (!summary) throw new RemoteError('Entry not found', true);
    const current = feedSlot(language).snapshot.data;
    return loadEntry(summary, language, priority, legacyFeeds.has(catalog) || Boolean(current && legacyFeeds.has(current)));
  }

  function peekSearch(feed: Feed): SearchIndex | null {
    if (!feed.searchUrl) return null;
    const value = cached(feed.searchUrl, 'search');
    if (!value) return null;
    try { validateSearch(value, feed); return value; } catch { return null; }
  }

  async function loadSearch(feed: Feed): Promise<SearchIndex> {
    if (!feed.searchUrl) throw new RemoteError('Search index is unavailable');
    return await loadObject(objectUrl(feed.searchUrl), 'search', 'demand', value => validateSearch(value, feed)) as SearchIndex;
  }

  function seedBootstrap(bootstrap: StaticBootstrap) {
    if (bootstrap.feed && validFeed(bootstrap.feed, bootstrap.language)) {
      const slot = feedSlot(bootstrap.language);
      slot.attemptedAt = now();
      publish(slot, { data: bootstrap.feed, status: 'ready', notFound: false, refreshing: false, refreshError: false });
    }
    if (bootstrap.detail && validDetail(bootstrap.detail, bootstrap.detail.id, bootstrap.language)) {
      const key = `${bootstrap.language}:${bootstrap.detail.id}`;
      const url = bootstrap.detail.detailUrl ?? `bootstrap:${key}`;
      remember(url, 'detail', bootstrap.detail);
      bootstrapDetails.clear();
      bootstrapDetails.set(key, url);
    }
  }

  async function resolveEntriesForExport(entries: FeedEntry[], language: Language) {
    const result = new Array<FeedEntry>(entries.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= entries.length) return;
        const entry = entries[index];
        result[index] = entry.detailUrl ? await loadEntry(entry, language) : entry;
      }
    }));
    return result;
  }

  return {
    seedBootstrap, loadFeed, peekFeed: (language: Language) => feedSlot(language).snapshot.data,
    getFeedSnapshot: (language: Language) => feedSlot(language).snapshot,
    subscribeFeeds: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    peekDetail, loadDetail, peekSearch, loadSearch, resolveEntriesForExport,
    cancelPrefetch: (url: string) => {
      const flight = flights.get(url);
      // React cleans up list effects before it starts the detail effect. Give the
      // selected request a chance to become a demand request in the same commit.
      queueMicrotask(() => {
        if (flight?.priority === 'prefetch' && flights.get(url) === flight) flight.controller.abort();
      });
    },
  };
}

export type RemoteCache = ReturnType<typeof createRemoteCache>;
export const remoteCache = createRemoteCache();

export function seedBootstrapFromDocument(document: Document) {
  const element = document.getElementById('code-pulse-bootstrap');
  const text = element instanceof HTMLTemplateElement ? element.content.textContent : element?.textContent;
  const bootstrap = parseBootstrap(text);
  if (bootstrap) remoteCache.seedBootstrap(bootstrap);
  return bootstrap;
}

export function canPrefetch(state: { online: boolean; hidden: boolean; saveData?: boolean; effectiveType?: string }) {
  return state.online && !state.hidden && !state.saveData && !['2g', 'slow-2g'].includes(state.effectiveType ?? '');
}

export function browserCanPrefetch() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return canPrefetch({ online: navigator.onLine, hidden: document.hidden,
    saveData: connection?.saveData, effectiveType: connection?.effectiveType });
}

/** The caller supplies only intersections, not every rendered card or the entire catalog. */
export function createViewportPrefetcher(cache: RemoteCache, permitted = browserCanPrefetch) {
  let feed: Feed | null = null;
  let wanted: FeedEntry[] = [];
  let stopped = false;
  const running = new Set<string>();
  const attempted = new Set<string>();

  function pump() {
    if (stopped || !feed) return;
    if (!permitted()) {
      for (const url of running) cache.cancelPrefetch(url);
      return;
    }
    for (const entry of wanted) {
      const url = entry.detailUrl;
      if (running.size >= 2) break;
      if (!url || running.has(url) || attempted.has(url)) continue;
      const language = feed.language ?? 'ko';
      if (cache.peekDetail(entry.id, feed, language)) continue;
      running.add(url);
      attempted.add(url);
      void cache.loadDetail(entry.id, feed, language, { priority: 'prefetch' })
        .catch(error => {
          if (error instanceof DOMException && error.name === 'AbortError') attempted.delete(url);
          // Navigation can retry; a failed prefetch never changes reader state.
        })
        .finally(() => { running.delete(url); pump(); });
    }
  }

  return {
    update: (catalog: Feed, ids: string[]) => {
      feed = catalog;
      const selected = new Set(ids);
      wanted = catalog.entries.filter(entry => selected.has(entry.id) && entry.detailUrl);
      // Bound bookkeeping to the current viewport, including the in-flight requests.
      const urls = new Set(wanted.map(entry => entry.detailUrl!));
      for (const url of attempted) if (!urls.has(url) && !running.has(url)) attempted.delete(url);
      pump();
    },
    resume: pump,
    stop: () => { stopped = true; wanted = []; for (const url of running) cache.cancelPrefetch(url); },
  };
}

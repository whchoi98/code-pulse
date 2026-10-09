import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Entry, Feed, FeedEntry, Language, SearchIndex } from '../shared/types';
import { createViewportPrefetcher, remoteCache, RemoteError } from './remote-cache';
import { useLocale } from './i18n';

type Remote<T> = {
  data: T | null;
  status: 'loading' | 'ready' | 'error';
  notFound: boolean;
};

export function useFeed(language: Language) {
  const getSnapshot = useCallback(() => remoteCache.getFeedSnapshot(language), [language]);
  const snapshot = useSyncExternalStore(remoteCache.subscribeFeeds, getSnapshot, getSnapshot);
  const [clock, setClock] = useState(Date.now);
  const retry = useCallback(() => { void remoteCache.loadFeed(language, { force: true }).catch(() => {}); }, [language]);

  useEffect(() => {
    void remoteCache.loadFeed(language).catch(() => {});
    const refresh = () => {
      setClock(Date.now());
      if (document.hidden || !navigator.onLine) return;
      void remoteCache.loadFeed(language).catch(() => {});
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [language]);

  const data = useMemo(() => {
    if (!snapshot.data) return null;
    const old = snapshot.data.sources.some(source => source.lastSuccessAt
      && clock - Date.parse(source.lastSuccessAt) > 26 * 60 * 60_000);
    return old || snapshot.refreshError ? { ...snapshot.data, stale: true } : snapshot.data;
  }, [snapshot, clock]);
  return { ...snapshot, data, retry };
}

export function useDetail(entryId: string | null, feed: Feed | null, language: Language) {
  const cached = entryId ? remoteCache.peekDetail(entryId, feed, language) : null;
  const summary = feed?.entries.find(entry => entry.id === entryId);
  const target = summary?.detailUrl ?? cached?.detailUrl ?? (feed ? summary ? 'legacy' : 'not-found' : 'catalog');
  const revision = summary?.readRevision ?? cached?.readRevision;
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(() => ({ entryId, language, target, revision, attempt }), [entryId, language, target, revision, attempt]);
  const [remote, setRemote] = useState<Remote<FeedEntry> & { request: object | null }>({ request: null, data: null, status: 'loading', notFound: false });
  const retry = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    if (!request.entryId) return;
    let active = true;
    const ready = remoteCache.peekDetail(request.entryId, feed, request.language);
    if (ready) {
      setRemote({ request, data: ready, status: 'ready', notFound: false });
      return;
    }
    setRemote({ request, data: null, status: 'loading', notFound: false });
    void remoteCache.loadDetail(request.entryId, feed, request.language).then(data => {
      if (active) setRemote({ request, data, status: 'ready', notFound: false });
    }, error => {
      if (active) setRemote({ request, data: null, status: 'error', notFound: error instanceof RemoteError && error.notFound });
    });
    // A shared request may finish and warm the cache after navigation. Only the
    // still-selected subscriber receives it, so abandoned entries are never read.
    return () => { active = false; };
  }, [request]);

  if (cached) return { data: cached, status: 'ready' as const, notFound: false, retry };
  if (remote.request !== request) return { data: null, status: 'loading' as const, notFound: false, retry };
  const data = remote.data && summary ? { ...remote.data, checkedAt: summary.checkedAt || remote.data.checkedAt,
    detailUrl: summary.detailUrl, detailBytes: summary.detailBytes } : remote.data;
  return { data, status: remote.status, notFound: remote.notFound, retry };
}

export function useSearchIndex(feed: Feed | null, query: string) {
  const [attempt, setAttempt] = useState(0);
  const path = feed?.searchUrl ?? null;
  const request = useMemo(() => ({ path, attempt }), [path, attempt]);
  const [remote, setRemote] = useState<Remote<SearchIndex> & { request: object | null }>({ request: null, data: null, status: 'loading', notFound: false });
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const normalized = query.trim();
  const cached = feed && path ? remoteCache.peekSearch(feed) : null;
  const data = cached ?? (remote.request === request && remote.status === 'ready' ? remote.data : null);

  useEffect(() => {
    if (!normalized || !feed || !request.path || remoteCache.peekSearch(feed)
      || (remote.request === request && remote.status === 'ready' && remote.data)) return;
    let active = true;
    setRemote({ request, data: null, status: 'loading', notFound: false });
    const timer = window.setTimeout(() => {
      void remoteCache.loadSearch(feed).then(data => {
        if (active) setRemote({ request, data, status: 'ready', notFound: false });
      }, () => {
        if (active) setRemote({ request, data: null, status: 'error', notFound: false });
      });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [request, normalized, feed]);

  const entries = useMemo(() => {
    if (!feed) return [];
    if (!normalized || !path) return feed.entries;
    if (!data) return [];
    const texts = new Map(data.entries.map(entry => [entry.id, entry.text]));
    if (feed.entries.some(entry => !texts.has(entry.id))) return [];
    return feed.entries.map(entry => ({ ...entry, searchText: texts.get(entry.id)! }));
  }, [feed, normalized, path, data]);
  const missingIndex = Boolean(feed && !path && feed.entries.some(entry => entry.detailUrl));
  const incomplete = Boolean(data && feed && entries.length !== feed.entries.length);
  const status: 'idle' | 'loading' | 'ready' | 'error' = !normalized ? 'idle'
    : missingIndex || incomplete ? 'error'
      : data || (feed && !path) ? 'ready'
        : remote.request === request && remote.status === 'error' ? 'error' : 'loading';
  return { data, entries: status === 'error' ? [] : entries, status, retry };
}

export function useViewportPrefetch(feed: Feed | null, visibleIds: string[]) {
  const ids = JSON.stringify(visibleIds);
  useEffect(() => {
    if (!feed || !visibleIds.length || typeof IntersectionObserver === 'undefined') return;
    const prefetcher = createViewportPrefetcher(remoteCache);
    const near = new Set<string>();
    const targets = new Map<Element, string>();
    const observer = new IntersectionObserver(changes => {
      for (const change of changes) {
        const id = targets.get(change.target);
        if (!id) continue;
        if (change.isIntersecting) near.add(id);
        else near.delete(id);
      }
      prefetcher.update(feed, [...near]);
    }, { rootMargin: '400px 0px', threshold: 0 });
    for (const id of visibleIds) {
      const link = document.getElementById(`entry-link-${id}`);
      if (!link) continue;
      const target = link.closest('.entry-card') ?? link;
      targets.set(target, id);
      observer.observe(target);
    }
    const update = () => prefetcher.resume();
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    connection?.addEventListener('change', update);
    return () => {
      observer.disconnect();
      prefetcher.stop();
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      connection?.removeEventListener('change', update);
    };
  }, [feed, ids]);
}

export function resolveEntriesForExport(entries: FeedEntry[], language: Language) {
  return remoteCache.resolveEntriesForExport(entries, language);
}

export function useRemote<T extends Entry | Feed>(path: string | null) {
  const [remote, setRemote] = useState<Remote<T> & { request: object | null }>({ request: null, data: null, status: 'loading', notFound: false });
  const [attempt, setAttempt] = useState(0);
  // Returning to the same path after null still starts a distinct request.
  const request = useMemo(() => ({ path, attempt }), [path, attempt]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    const { path } = request;
    if (!path) return;
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    setRemote({ request, data: null, status: 'loading', notFound: false });
    fetch(path, { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then(async response => {
        if (!response.ok) {
          if (active) setRemote({ request, data: null, status: 'error', notFound: response.status === 404 });
          return;
        }
        const data: unknown = await response.json();
        if (!data || typeof data !== 'object') throw new Error('Invalid response');
        if (path === '/api/feed' && (!('entries' in data) || !Array.isArray(data.entries) || !('sources' in data) || !Array.isArray(data.sources))) {
          throw new Error('Invalid feed');
        }
        if (path.startsWith('/api/entries/') && !('id' in data)) throw new Error('Invalid entry');
        if (active) setRemote({ request, data: data as T, status: 'ready', notFound: false });
      })
      .catch(() => {
        if (active) setRemote({ request, data: null, status: 'error', notFound: false });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [request]);
  const { request: resultRequest, ...result } = remote;
  return { ...(resultRequest === request ? result : { data: null, status: 'loading' as const, notFound: false }), retry };
}

const SAVED_KEY = 'code-pulse-saved';

function parseSaved(value: string | null): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === 'string'))] : [];
}

export function useSaved(onNotice: (message: string) => void) {
  const { t } = useLocale();
  const [ids, setIds] = useState<string[]>(() => {
    try { return parseSaved(localStorage.getItem(SAVED_KEY)); }
    catch { return []; }
  });
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== SAVED_KEY && event.key !== null) return;
      try { setIds(parseSaved(event.newValue)); }
      catch { onNotice(t('저장 목록을 읽지 못했습니다. 이 창에서 다시 저장할 수 있습니다.', 'Could not read your saved list. You can save entries again in this tab.')); }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [onNotice, t]);
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
    setIds(next);
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(next));
      onNotice(next.includes(id) ? t('글을 저장했습니다. 이 브라우저에서 다시 볼 수 있습니다.', 'Entry saved. You can return to it in this browser.') : t('저장을 해제했습니다.', 'Entry removed from saved.'));
    } catch {
      onNotice(t('브라우저에 저장하지 못했습니다. 이 창을 닫기 전까지 목록을 유지합니다.', 'Browser storage is unavailable. Your saved list will remain until you close this tab.'));
    }
  };
  return { ids, toggle };
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Entry, Feed } from '../shared/types';

type Remote<T> = {
  data: T | null;
  status: 'loading' | 'ready' | 'error';
  notFound: boolean;
};

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
  const [ids, setIds] = useState<string[]>(() => {
    try { return parseSaved(localStorage.getItem(SAVED_KEY)); }
    catch { return []; }
  });
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== SAVED_KEY && event.key !== null) return;
      try { setIds(parseSaved(event.newValue)); }
      catch { onNotice('저장 목록을 읽지 못했습니다. 이 창에서 다시 저장할 수 있습니다.'); }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [onNotice]);
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
    setIds(next);
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(next));
      onNotice(next.includes(id) ? '글을 저장했습니다. 이 브라우저에서 다시 볼 수 있습니다.' : '저장을 해제했습니다.');
    } catch {
      onNotice('브라우저에 저장하지 못했습니다. 이 창을 닫기 전까지 목록을 유지합니다.');
    }
  };
  return { ids, toggle };
}

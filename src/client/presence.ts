import { useEffect, useState } from 'react';

export interface PresenceSnapshot {
  active_visitors: number;
  total_visitors: number;
  as_of: string;
  window_seconds: 90;
  counting_since: string | null;
}

type PresenceState = {
  snapshot: PresenceSnapshot | null;
  status: 'loading' | 'live' | 'unavailable' | 'stale';
};

const HEARTBEAT_MS = 30_000;
const RESUME_GAP_MS = 5000;
const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validTime = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

function parseSnapshot(value: unknown): PresenceSnapshot {
  const snapshot = value as Partial<PresenceSnapshot> | null;
  if (!snapshot || !validCount(snapshot.active_visitors) || !validCount(snapshot.total_visitors)
    || snapshot.active_visitors > snapshot.total_visitors || snapshot.window_seconds !== 90
    || !validTime(snapshot.as_of)
    || (snapshot.counting_since !== null && !validTime(snapshot.counting_since))) {
    throw new Error('방문 집계 응답을 확인할 수 없습니다.');
  }
  return snapshot as PresenceSnapshot;
}

export function usePresence(): PresenceState {
  const [state, setState] = useState<PresenceState>({ snapshot: null, status: 'loading' });
  useEffect(() => {
    let last: PresenceSnapshot | null = null;
    let failed = false;
    let disposed = false;
    let pageHidden = false;
    let sessionReady = false;
    let request: AbortController | undefined;
    let timer: number | undefined;
    let lastAttempt = -Infinity;
    let retryNotBefore = -Infinity;
    let resumeNeeded = false;
    const locks = typeof navigator.locks?.request === 'function' ? navigator.locks : undefined;
    const usable = () => !disposed && !pageHidden && !document.hidden && navigator.onLine !== false;
    let paused = !usable();

    function paint() {
      if (disposed) return;
      const stale = last && (failed || !usable()
        || Math.abs(Date.now() - Date.parse(last.as_of)) > last.window_seconds * 1000);
      setState({
        snapshot: last,
        status: last ? stale ? 'stale' : 'live' : failed || !usable() ? 'unavailable' : 'loading',
      });
    }
    function clearTimer() {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    }
    function schedule(at: number) {
      clearTimer();
      if (!usable()) return;
      timer = window.setTimeout(() => { timer = undefined; void poll(); }, Math.max(0, at - Date.now()));
    }
    async function readResponse(method: 'GET' | 'POST', signal: AbortSignal, credentials: RequestCredentials = 'same-origin') {
      return fetch('/api/presence', {
        method, signal, credentials, cache: 'no-store',
        headers: method === 'POST'
          ? { Accept: 'application/json', 'Content-Type': 'application/json', 'x-code-pulse-client': '1' }
          : { Accept: 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
    }
    async function prepareSession(signal: AbortSignal, credentials: RequestCredentials) {
      const response = await readResponse('GET', signal, credentials);
      if (!response.ok) throw new Error('방문 집계를 읽지 못했습니다.');
      const snapshot = parseSnapshot(await response.json());
      signal.throwIfAborted();
      if (!usable()) return false;
      last = snapshot;
      failed = false;
      paint();
      return true;
    }
    async function poll() {
      if (request || !usable()) return;
      lastAttempt = Date.now();
      const controller = new AbortController();
      request = controller;
      const { signal } = controller;
      const deadline = window.setTimeout(() => controller.abort(new DOMException('Presence timeout', 'TimeoutError')), 8000);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted();
          if (!usable()) return;
          if (!locks) {
            // Without cross-tab coordination, read the real aggregate without
            // issuing or replacing a shared visitor cookie.
            await prepareSession(signal, 'omit');
            retryNotBefore = -Infinity;
            return;
          }
          const response = sessionReady ? await readResponse('POST', signal)
            : await locks.request('code-pulse-presence-bootstrap', { mode: 'exclusive', signal }, async () => {
              signal.throwIfAborted();
              if (!usable() || !await prepareSession(signal, 'same-origin')) return undefined;
              sessionReady = true;
              // Hold the shared lock until the first heartbeat is acknowledged.
              return readResponse('POST', signal);
            });
          if (!response) return;
          if ((response.status === 401 || response.status === 403) && attempt === 0) {
            sessionReady = false;
            continue;
          }
          if (!response.ok) throw new Error('방문 집계를 갱신하지 못했습니다.');
          const snapshot = parseSnapshot(await response.json());
          signal.throwIfAborted();
          if (!usable()) return;
          last = snapshot;
          failed = false;
          retryNotBefore = -Infinity;
          paint();
          return;
        }
      } catch {
        if (disposed) return;
        const pausedAbort = signal.aborted && signal.reason?.name === 'AbortError';
        if (usable() && !pausedAbort) {
          failed = true;
          retryNotBefore = Date.now() + HEARTBEAT_MS;
        }
        paint();
      } finally {
        window.clearTimeout(deadline);
        if (request === controller) request = undefined;
        if (usable()) schedule(Math.max(lastAttempt + (resumeNeeded ? RESUME_GAP_MS : HEARTBEAT_MS), retryNotBefore));
        resumeNeeded = false;
      }
    }
    function pause() {
      paused = true;
      if (last) failed = true;
      clearTimer();
      request?.abort(new DOMException('Presence paused', 'AbortError'));
      paint();
    }
    function resume() {
      if (!usable()) { pause(); return; }
      const wasPaused = paused;
      paused = false;
      paint();
      if (!wasPaused) return;
      if (request) { resumeNeeded = true; return; }
      schedule(Math.max(lastAttempt + RESUME_GAP_MS, retryNotBefore));
    }
    const visibility = () => document.hidden ? pause() : resume();
    const pageHide = () => { pageHidden = true; pause(); };
    const pageShow = () => { pageHidden = false; resume(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', resume);
    window.addEventListener('offline', pause);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    paint();
    // Defer the first request so React's development cleanup can cancel it.
    if (usable()) schedule(Date.now());
    return () => {
      disposed = true;
      clearTimer();
      request?.abort(new DOMException('Presence disposed', 'AbortError'));
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', pause);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
    };
  }, []);
  return state;
}

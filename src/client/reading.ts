import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Entry, FeedEntry } from '../shared/types';

export type ReadingStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
export type ReadRecord = { id: string; revision: string };
export type ReadingSnapshot = { readonly revisions: ReadonlyMap<string, string>; readonly storageFailed: boolean };
export type ReadingStorageEvent = { key: string | null; storageArea: ReadingStorage | null; newValue?: string | null };
export type ReadingState = {
  isRead(entry: FeedEntry | Entry): boolean;
  markRead(entry: FeedEntry | Entry): void;
  markUnread(id: string): void;
};
export type ReadingStore = ReadingState & {
  getSnapshot(): ReadingSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): void;
  syncStorage(event: ReadingStorageEvent): void;
};

/** A local change marker shared by feed and detail responses, never a security hash. */
export function entryRevision(entry: FeedEntry | Entry): string {
  const explanation = entry.explanation;
  const fullChanges = entry.fullChanges;
  // Fixed field order ignores JSON property order and collection/editorial clocks.
  // Private source hashes are absent from the feed; updatedAt tracks source changes.
  const visible = JSON.stringify([
    entry.product, entry.channel, entry.version, entry.originalTitle,
    entry.publishedAt, entry.publishedDate, entry.datePrecision,
    entry.sourceUrl, entry.updatedAt,
    entry.references.map(reference => [reference.title, reference.url, reference.kind]),
    entry.explanationStatus,
    explanation ? [
      explanation.title, explanation.summary, explanation.whyItMatters,
      explanation.actionItems, explanation.audience, explanation.category, explanation.impact,
      explanation.highlights.map(highlight => [highlight.title, highlight.detail, highlight.evidence]),
    ] : null,
    // Keep legacy fingerprints unchanged until a list arrives. Generation clocks,
    // model, source hash and format version do not describe a reader-visible edit.
    ...(fullChanges ? [[fullChanges.status, fullChanges.sourceCount,
      fullChanges.items.map(item => [item.id, item.text])]] : []),
  ]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < visible.length; index++) {
    const code = visible.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x5f356495);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

const READING_KEY_PREFIX = 'code-pulse-read:v1:';
const MAX_ID_LENGTH = 512;
const MAX_RECORD_LENGTH = 2_048;

export function readingKey(id: string): string {
  return `${READING_KEY_PREFIX}${id}`;
}

function idFromKey(key: string): string | null {
  if (!key.startsWith(READING_KEY_PREFIX)) return null;
  const id = key.slice(READING_KEY_PREFIX.length);
  return id.length > 0 && id.length <= MAX_ID_LENGTH ? id : null;
}

export function parseReadRecord(key: string, raw: string | null): ReadRecord | null {
  const id = idFromKey(key);
  if (id === null || !raw || raw.length > MAX_RECORD_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!('id' in value) || value.id !== id || !('revision' in value)
      || typeof value.revision !== 'string' || !/^[a-f0-9]{16}$/.test(value.revision)) return null;
    return { id, revision: value.revision };
  } catch {
    return null;
  }
}

/** Storage is injected so persistence and cross-tab changes can be checked independently of React. */
export function createReadingStore(getStorage: () => ReadingStorage): ReadingStore {
  let snapshot: ReadingSnapshot = { revisions: new Map(), storageFailed: false };
  const listeners = new Set<() => void>();
  // Failed writes remain authoritative in this tab, including explicit unread choices.
  const unsaved = new Map<string, string | null>();

  function publish(revisions: ReadonlyMap<string, string>, storageFailed = snapshot.storageFailed) {
    const unchanged = revisions.size === snapshot.revisions.size
      && [...revisions].every(([id, revision]) => snapshot.revisions.get(id) === revision);
    if (unchanged && storageFailed === snapshot.storageFailed) return;
    snapshot = { revisions: unchanged ? snapshot.revisions : revisions, storageFailed };
    for (const listener of listeners) listener();
  }

  function refresh() {
    try {
      const storage = getStorage();
      const revisions = new Map<string, string>();
      // Bound each untrusted value, but do not expire or arbitrarily truncate history.
      const length = storage.length;
      for (let index = 0; index < length; index++) {
        const key = storage.key(index);
        if (key === null || idFromKey(key) === null) continue;
        const record = parseReadRecord(key, storage.getItem(key));
        if (record) revisions.set(record.id, record.revision);
      }
      for (const [id, revision] of unsaved) {
        if (revision === null) revisions.delete(id);
        else revisions.set(id, revision);
      }
      publish(revisions);
    } catch {
      // A partial or unavailable read must not discard the last known state.
      publish(snapshot.revisions, true);
    }
  }

  function save(id: string, revision: string | null) {
    const revisions = new Map(snapshot.revisions);
    if (revision === null) revisions.delete(id);
    else revisions.set(id, revision);
    try {
      const storage = getStorage();
      if (revision === null) storage.removeItem(readingKey(id));
      else storage.setItem(readingKey(id), JSON.stringify({ id, revision } satisfies ReadRecord));
      unsaved.delete(id);
      publish(revisions);
    } catch {
      unsaved.set(id, revision);
      publish(revisions, true);
    }
  }

  function syncStorage(event: ReadingStorageEvent) {
    if (event.key !== null && idFromKey(event.key) === null) return;
    try {
      const storage = getStorage();
      if (event.storageArea !== null && event.storageArea !== storage) return;
      if (event.key === null) {
        refresh();
        return;
      }
      const id = idFromKey(event.key)!;
      if (unsaved.has(id)) return;
      // Queued events may describe an older write; use the current stored value.
      const record = parseReadRecord(event.key, storage.getItem(event.key));
      const revisions = new Map(snapshot.revisions);
      if (record) revisions.set(id, record.revision);
      else revisions.delete(id);
      publish(revisions);
    } catch {
      publish(snapshot.revisions, true);
    }
  }

  refresh();
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    syncStorage,
    isRead: entry => {
      const revision = snapshot.revisions.get(entry.id);
      return revision !== undefined && revision === entryRevision(entry);
    },
    markRead: entry => save(entry.id, entryRevision(entry)),
    markUnread: id => save(id, null),
  };
}

export function useReading(onNotice: (message: string) => void): ReadingState {
  const [store] = useState(() => createReadingStore(() => window.localStorage));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const noticeSent = useRef(false);

  useEffect(() => {
    window.addEventListener('storage', store.syncStorage);
    // Close the gap between the initial storage read and listener registration.
    store.refresh();
    return () => window.removeEventListener('storage', store.syncStorage);
  }, [store]);

  useEffect(() => {
    if (!snapshot.storageFailed || noticeSent.current) return;
    noticeSent.current = true;
    onNotice('브라우저 저장소를 사용할 수 없습니다. 읽음 상태는 이 창을 닫기 전까지 유지합니다.');
  }, [snapshot.storageFailed, onNotice]);

  const isRead = useCallback((entry: FeedEntry | Entry) => {
    const revision = snapshot.revisions.get(entry.id);
    return revision !== undefined && revision === entryRevision(entry);
  }, [snapshot.revisions]);

  return {
    isRead,
    // These callbacks belong to the store and never change when read state changes.
    markRead: store.markRead,
    markUnread: store.markUnread,
  };
}

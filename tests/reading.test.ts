import { describe, expect, it } from 'vitest';
import type { Entry, FeedEntry } from '../src/shared/types';
import {
  createReadingStore, entryRevision, parseReadRecord, readingKey,
  type ReadingStorage,
} from '../src/client/reading';
import { fullChangesFixture } from './fixtures/full-changes';

// Synthetic records used only to exercise browser reading preferences.
function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'release-one',
    product: 'kiro',
    channel: 'ide',
    sourceId: 'kiro-changelog',
    version: 'test-version',
    originalTitle: 'Workspace settings fix',
    publishedAt: '2026-10-07',
    publishedDate: '2026-10-07',
    datePrecision: 'day',
    sourceUrl: 'https://kiro.dev/changelog/',
    references: [{ title: 'Official changes', url: 'https://kiro.dev/changelog/', kind: 'changelog' }],
    originalText: 'Workspace settings now persist.',
    contentHash: 'test-source-hash',
    firstSeenAt: '2026-10-07T01:00:00Z',
    checkedAt: '2026-10-07T01:00:00Z',
    updatedAt: '2026-10-07T01:00:00Z',
    explanationStatus: 'ready',
    explanation: {
      title: '작업 공간 설정을 유지합니다',
      summary: '다시 실행해도 작업 공간 설정이 유지됩니다.',
      whyItMatters: '설정을 다시 입력할 필요가 줄어듭니다.',
      actionItems: ['앱을 다시 열어 설정을 확인하세요.'],
      highlights: [{
        title: '설정 유지',
        detail: '앱을 다시 실행해도 설정이 남습니다.',
        evidence: 'Workspace settings now persist.',
      }],
      audience: ['IDE 사용자'],
      category: 'fix',
      impact: 'low',
    },
    ...overrides,
  };
}

describe('entry reading revision', () => {
  it('uses the published canonical Korean revision for compact and English entries', () => {
    const revision = entryRevision(entry());
    const compact: FeedEntry = { ...entry(), explanation: undefined, readRevision: revision };
    const english: FeedEntry = { ...entry(), language: 'en', contentKind: 'source', readRevision: revision,
      explanation: { ...entry().explanation!, title: 'English source title', summary: 'English summary' } };
    expect(entryRevision(compact)).toBe(revision);
    expect(entryRevision(english)).toBe(revision);
    expect(entryRevision({ ...english, readRevision: '0123456789abcdef' })).toBe('0123456789abcdef');
  });

  it('ignores malformed published reader revisions', () => {
    expect(entryRevision({ ...entry(), readRevision: 'not-a-reader-revision' })).toBe(entryRevision(entry()));
  });
  it('does not reset when daily checks or editing metadata alone change', () => {
    const original = entry();
    const checkedAgain = entry({
      checkedAt: '2026-10-08T01:00:00Z',
      firstSeenAt: '2026-10-08T01:00:00Z',
      explanationEditedAt: '2026-10-08T01:00:00Z',
      editorialVersion: 'new-editor',
      explanationModel: 'new-model',
    });
    expect(entryRevision(checkedAgain)).toBe(entryRevision(original));
  });

  it('has the same revision in feed and detail responses', () => {
    const detail = entry();
    const { originalText: _text, contentHash: _hash, explanationModel: _model, ...feed } = detail;
    expect(entryRevision(feed satisfies FeedEntry)).toBe(entryRevision(detail));
  });

  it('changes when the official source update changes', () => {
    expect(entryRevision(entry({ updatedAt: '2026-10-08T01:00:00Z' }))).not.toBe(entryRevision(entry()));
  });

  it.each([
    ['title', { title: '설정 유지 오류를 고쳤습니다' }],
    ['summary', { summary: '일부 설정이 초기화되던 오류를 고쳤습니다.' }],
    ['why it matters', { whyItMatters: '팀의 작업 설정을 유지할 수 있습니다.' }],
    ['action items', { actionItems: ['작업 공간 설정을 저장하세요.'] }],
    ['highlight detail', { highlights: [{ title: '설정 유지', detail: '새 설명입니다.', evidence: 'Workspace settings now persist.' }] }],
    ['evidence', { highlights: [{ title: '설정 유지', detail: '앱을 다시 실행해도 설정이 남습니다.', evidence: 'Updated evidence.' }] }],
    ['audience', { audience: ['팀 관리자'] }],
    ['category', { category: 'improvement' as const }],
    ['impact', { impact: 'high' as const }],
  ])('changes when visible explanation %s changes without a timestamp change', (_name, changed) => {
    const original = entry();
    const revised = entry({ explanation: { ...original.explanation!, ...changed } });
    expect(entryRevision(revised)).not.toBe(entryRevision(original));
  });

  it('changes when a pending explanation becomes available', () => {
    expect(entryRevision(entry())).not.toBe(entryRevision(entry({ explanation: undefined, explanationStatus: 'pending' })));
  });

  it('changes when the visible source link or title changes', () => {
    expect(entryRevision(entry({ originalTitle: 'Corrected official title' }))).not.toBe(entryRevision(entry()));
    expect(entryRevision(entry({ references: [] }))).not.toBe(entryRevision(entry()));
  });

  it('ignores JSON object property order', () => {
    const original = entry();
    const reordered = entry({
      references: [{ kind: 'changelog', url: 'https://kiro.dev/changelog/', title: 'Official changes' }],
      explanation: Object.fromEntries(Object.entries(original.explanation!).reverse()) as Entry['explanation'],
    });
    expect(entryRevision(reordered)).toBe(entryRevision(original));
  });

  it('changes when a legacy record gains a full list', () => {
    expect(entryRevision(entry({ fullChanges: fullChangesFixture() }))).not.toBe(entryRevision(entry()));
  });

  it.each([
    ['last item text', fullChangesFixture({ items: fullChangesFixture().items.map(item => item.id === 'change-56'
      ? { ...item, text: '마지막 변경의 적용 조건을 바로잡았습니다.' } : item) })],
    ['last item ID', fullChangesFixture({ items: fullChangesFixture().items.map(item => item.id === 'change-56'
      ? { ...item, id: 'revised-change-56' } : item) })],
    ['item order', fullChangesFixture({ items: fullChangesFixture().items.toReversed() })],
    ['missing item', fullChangesFixture({ items: fullChangesFixture().items.slice(0, 55) })],
    ['source count', fullChangesFixture({ sourceCount: 57 })],
    ['pending status', fullChangesFixture({ status: 'pending' })],
    ['removed list', undefined],
  ])('changes when the full list %s changes without a timestamp change', (_name, fullChanges) => {
    expect(entryRevision(entry({ fullChanges }))).not.toBe(entryRevision(entry({ fullChanges: fullChangesFixture() })));
  });

  it('ignores full-list generation timestamps and private metadata', () => {
    const original = entry({ fullChanges: fullChangesFixture() });
    const changed = entry({ fullChanges: fullChangesFixture({
      updatedAt: '2026-10-08T01:00:00Z', model: 'new-model', sourceHash: 'new-source-hash', formatVersion: 'new-format',
    }) });
    expect(entryRevision(changed)).toBe(entryRevision(original));
  });

  it('shares the same full-list revision between private records and public responses', () => {
    const detail = entry({ fullChanges: fullChangesFixture() });
    const { originalText: _text, contentHash: _hash, explanationModel: _model, fullChanges, ...publicEntry } = detail;
    const { sourceHash: _source, model: _fullModel, ...publicFullChanges } = fullChanges!;
    expect(entryRevision({ ...publicEntry, fullChanges: publicFullChanges })).toBe(entryRevision(detail));
  });
});

class MemoryStorage implements ReadingStorage {
  readonly values = new Map<string, string>();
  failReads = false;
  failWrites = false;
  get length() {
    if (this.failReads) throw new Error('Storage access denied');
    return this.values.size;
  }
  key(index: number) {
    if (this.failReads) throw new Error('Storage access denied');
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    if (this.failReads) throw new Error('Storage access denied');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('Storage quota exceeded');
    this.values.set(key, value);
  }
  removeItem(key: string) {
    if (this.failWrites) throw new Error('Storage access denied');
    this.values.delete(key);
  }
}

describe('stored reading metadata', () => {
  it('accepts matching IDs and revision metadata', () => {
    expect(parseReadRecord(readingKey('release-one'), '{"id":"release-one","revision":"0123456789abcdef"}'))
      .toEqual({ id: 'release-one', revision: '0123456789abcdef' });
  });

  it.each([
    null, '', '{', 'null', '[]', 'true',
    '{"id":"release-one","revision":1}',
    '{"id":"release-one","revision":""}',
    '{"id":"different-entry","revision":"0123456789abcdef"}',
    '{"id":"release-one","revision":"not-a-revision"}',
    JSON.stringify({ id: 'release-one', revision: '0123456789abcdef', unexpected: 'x'.repeat(100_000) }),
  ])('treats corrupt or excessive input as unread without throwing (%#)', raw => {
    expect(parseReadRecord(readingKey('release-one'), raw)).toBeNull();
  });

  it('ignores other applications and overlong IDs', () => {
    expect(parseReadRecord('other-app:release-one', '{"id":"release-one","revision":"0123456789abcdef"}')).toBeNull();
    const id = 'x'.repeat(10_000);
    expect(parseReadRecord(readingKey(id), JSON.stringify({ id, revision: '0123456789abcdef' }))).toBeNull();
  });
});

describe('reading preferences', () => {
  it('retains read markers from before full lists were added for unchanged legacy entries', () => {
    const storage = new MemoryStorage();
    storage.setItem(readingKey('release-one'), JSON.stringify({ id: 'release-one', revision: 'fba13fff4822d70f' }));
    expect(createReadingStore(() => storage).isRead(entry())).toBe(true);
  });

  it('keeps full-list reads after metadata refresh and makes a changed tail unread', () => {
    const storage = new MemoryStorage();
    const reading = createReadingStore(() => storage);
    const original = entry({ fullChanges: fullChangesFixture() });
    reading.markRead(original);
    expect(reading.isRead(entry({ fullChanges: fullChangesFixture({ updatedAt: '2026-10-08T01:00:00Z' }) }))).toBe(true);
    const revised = entry({ fullChanges: fullChangesFixture({ items: fullChangesFixture().items.map(item => item.id === 'change-56'
      ? { ...item, text: '마지막 변경의 적용 범위를 수정했습니다.' } : item) }) });
    expect(reading.isRead(revised)).toBe(false);
    expect(createReadingStore(() => storage).isRead(revised)).toBe(false);
  });

  it('starts unread, remembers the read revision, and supports marking unread', () => {
    const storage = new MemoryStorage();
    const reading = createReadingStore(() => storage);
    const original = entry();
    expect(reading.isRead(original)).toBe(false);
    reading.markRead(original);
    expect(reading.isRead(original)).toBe(true);
    expect(reading.isRead(entry({ checkedAt: '2026-10-08T01:00:00Z' }))).toBe(true);
    expect(reading.isRead(entry({ updatedAt: '2026-10-08T01:00:00Z' }))).toBe(false);
    expect(createReadingStore(() => storage).isRead(original)).toBe(true);
    reading.markUnread(original.id);
    expect(reading.isRead(original)).toBe(false);
    expect(createReadingStore(() => storage).isRead(original)).toBe(false);
  });

  it('persists independent entries without one tab overwriting another tab', () => {
    const storage = new MemoryStorage();
    const firstTab = createReadingStore(() => storage);
    const secondTab = createReadingStore(() => storage);
    const first = entry();
    const second = entry({ id: 'release-two' });
    firstTab.markRead(first);
    secondTab.markRead(second);
    const reopened = createReadingStore(() => storage);
    expect(reopened.isRead(first)).toBe(true);
    expect(reopened.isRead(second)).toBe(true);
    firstTab.markUnread(first.id);
    expect(createReadingStore(() => storage).isRead(second)).toBe(true);
  });

  it('stores only an ID and revision, without article or explanation text', () => {
    const storage = new MemoryStorage();
    createReadingStore(() => storage).markRead(entry());
    expect(storage.values.size).toBe(1);
    const [key, raw] = [...storage.values.entries()][0];
    const saved = JSON.parse(raw);
    expect(key).toBe(readingKey('release-one'));
    expect(Object.keys(saved).sort()).toEqual(['id', 'revision']);
    expect(saved.id).toBe('release-one');
    expect(saved.revision).toMatch(/^[a-f0-9]{16}$/);
  });

  it('ignores a corrupt entry without losing valid history', () => {
    const storage = new MemoryStorage();
    createReadingStore(() => storage).markRead(entry());
    storage.setItem(readingKey('release-two'), '{');
    storage.setItem('another-app', 'not JSON');
    const reopened = createReadingStore(() => storage);
    expect(reopened.isRead(entry())).toBe(true);
    expect(reopened.isRead(entry({ id: 'release-two' }))).toBe(false);
    expect(reopened.getSnapshot().storageFailed).toBe(false);
  });

  it('retains ordinary long-term history instead of capping the number of entries', () => {
    const storage = new MemoryStorage();
    const revision = entryRevision(entry());
    for (let index = 0; index < 6_000; index++) {
      const id = `historical-${index}`;
      storage.setItem(readingKey(id), JSON.stringify({ id, revision }));
    }
    const reading = createReadingStore(() => storage);
    expect(reading.isRead(entry({ id: 'historical-0' }))).toBe(true);
    expect(reading.isRead(entry({ id: 'historical-5999' }))).toBe(true);
  });

  it('applies cross-tab reads, unreads and storage.clear events', () => {
    const storage = new MemoryStorage();
    const firstTab = createReadingStore(() => storage);
    const secondTab = createReadingStore(() => storage);
    const original = entry();
    firstTab.markRead(original);
    secondTab.syncStorage({ key: readingKey(original.id), storageArea: storage });
    expect(secondTab.isRead(original)).toBe(true);
    firstTab.markUnread(original.id);
    secondTab.syncStorage({ key: readingKey(original.id), storageArea: storage });
    expect(secondTab.isRead(original)).toBe(false);
    firstTab.markRead(original);
    secondTab.syncStorage({ key: readingKey(original.id), storageArea: storage });
    storage.values.clear();
    secondTab.syncStorage({ key: null, storageArea: storage });
    expect(secondTab.isRead(original)).toBe(false);
  });

  it('ignores unrelated and session storage events', () => {
    const storage = new MemoryStorage();
    const reading = createReadingStore(() => storage);
    reading.markRead(entry());
    const before = reading.getSnapshot();
    storage.values.clear();
    reading.syncStorage({ key: 'code-pulse-saved', storageArea: storage });
    reading.syncStorage({ key: null, storageArea: new MemoryStorage() });
    expect(reading.getSnapshot()).toBe(before);
    expect(reading.isRead(entry())).toBe(true);
  });

  it('reads current storage when a queued event carries an older value', () => {
    const storage = new MemoryStorage();
    const reading = createReadingStore(() => storage);
    reading.markRead(entry());
    const oldValue = storage.getItem(readingKey('release-one'));
    reading.markUnread('release-one');
    reading.syncStorage({ key: readingKey('release-one'), storageArea: storage, newValue: oldValue });
    expect(reading.isRead(entry())).toBe(false);
  });

  it('keeps the in-tab state when browser storage cannot be opened', () => {
    const reading = createReadingStore(() => { throw new Error('Storage disabled'); });
    expect(reading.isRead(entry())).toBe(false);
    expect(reading.getSnapshot().storageFailed).toBe(true);
    reading.markRead(entry());
    expect(reading.isRead(entry())).toBe(true);
    reading.markUnread('release-one');
    expect(reading.isRead(entry())).toBe(false);
  });

  it('preserves the last known history when a later refresh fails', () => {
    const storage = new MemoryStorage();
    const reading = createReadingStore(() => storage);
    reading.markRead(entry());
    storage.failReads = true;
    reading.refresh();
    expect(reading.isRead(entry())).toBe(true);
    expect(reading.getSnapshot().storageFailed).toBe(true);
  });

  it('preserves unsaved local changes while syncing other entries and a clear event', () => {
    const storage = new MemoryStorage();
    const reading = createReadingStore(() => storage);
    reading.markRead(entry());
    storage.failWrites = true;
    reading.markUnread('release-one');
    reading.markRead(entry({ id: 'release-two' }));
    expect(reading.isRead(entry())).toBe(false);
    expect(reading.isRead(entry({ id: 'release-two' }))).toBe(true);
    expect(reading.getSnapshot().storageFailed).toBe(true);
    storage.failWrites = false;
    createReadingStore(() => storage).markRead(entry({ id: 'release-three' }));
    reading.syncStorage({ key: readingKey('release-three'), storageArea: storage });
    expect(reading.isRead(entry({ id: 'release-three' }))).toBe(true);
    reading.refresh();
    expect(reading.isRead(entry())).toBe(false);
    expect(reading.isRead(entry({ id: 'release-two' }))).toBe(true);
    storage.values.clear();
    reading.syncStorage({ key: null, storageArea: storage });
    expect(reading.isRead(entry())).toBe(false);
    expect(reading.isRead(entry({ id: 'release-two' }))).toBe(true);
    expect(reading.isRead(entry({ id: 'release-three' }))).toBe(false);
  });

  it('notifies subscribers only when observable state changes', () => {
    const storage = new MemoryStorage();
    const reading = createReadingStore(() => storage);
    let changes = 0;
    const unsubscribe = reading.subscribe(() => { changes++; });
    reading.markRead(entry());
    const afterRead = reading.getSnapshot();
    reading.markRead(entry());
    reading.refresh();
    expect(reading.getSnapshot()).toBe(afterRead);
    expect(changes).toBe(1);
    reading.markUnread('release-one');
    expect(changes).toBe(2);
    unsubscribe();
    reading.markRead(entry());
    expect(changes).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { mergeImportedSnapshot } from '../src/collector/engine.js';
import { emptySnapshot } from '../src/collector/store.js';
import type { CollectionRun, Entry, Explanation, Snapshot, SourceStatus } from '../src/shared/types.js';

const explanation: Explanation = {
  title: '검증된 원문의 변경 사항을 설명합니다',
  summary: '검증된 원문의 변경 사항을 설명합니다.',
  whyItMatters: '변경 내용을 적용하기 전에 확인할 수 있습니다.',
  actionItems: ['공식 원문과 적용 조건을 확인하세요.'],
  highlights: [{ title: '검증된 변경', detail: '공식 원문을 확인합니다.', evidence: 'Verified source change.' }],
  audience: ['사용자'], category: 'improvement', impact: 'medium',
};
function entry(id = 'entry-one', overrides: Partial<Entry> = {}): Entry {
  return {
    id, product: 'kiro', channel: 'general', sourceId: 'kiro-changelog',
    sourceUrl: `https://kiro.dev/changelog/general/${id}/`,
    originalTitle: 'Verified source change', originalText: 'Verified source change.', contentHash: 'same-hash',
    references: [{ title: '공식 변경 기록', kind: 'changelog', url: `https://kiro.dev/changelog/general/${id}/` }],
    publishedAt: '2026-10-05T00:00:00.000Z', publishedDate: '2026-10-05', datePrecision: 'day',
    firstSeenAt: '2026-10-06T00:00:00.000Z', checkedAt: '2026-10-07T22:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    explanationStatus: 'ready', explanation, explanationModel: 'previous-model',
    editorialVersion: 'previous-editorial', explanationEditedAt: '2026-10-07T21:00:00.000Z',
    ...overrides,
  };
}
function run(id: string, overrides: Partial<CollectionRun> = {}): CollectionRun {
  return {
    id, startedAt: '2026-10-07T20:00:00.000Z', completedAt: '2026-10-07T21:00:00.000Z',
    status: 'success', newEntries: 1, updatedEntries: 0, summarizedEntries: 1, failedSources: [],
    ...overrides,
  };
}
function snapshot(entries: Entry[] = [], overrides: Partial<Snapshot> = {}): Snapshot {
  return { ...emptySnapshot(), generatedAt: '2026-10-07T23:40:00.000Z', entries, ...overrides };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe('publishing an imported verified snapshot', () => {
  it('keeps a newer current source without rebinding a freshly generated stale-source explanation', () => {
    const currentEntry = entry('release', {
      originalText: 'A later verified source correction.', contentHash: 'new-source-hash',
      checkedAt: '2026-10-07T23:30:00.000Z', updatedAt: '2026-10-07T23:30:00.000Z',
      explanationStatus: 'pending', explanation: undefined, explanationModel: undefined,
      editorialVersion: undefined, explanationEditedAt: undefined,
    });
    const incomingEntry = entry('release', {
      explanationModel: 'haiku-5.5-test', explanationEditedAt: '2026-10-07T23:35:00.000Z',
    });
    const merged = mergeImportedSnapshot(snapshot([currentEntry]), snapshot([incomingEntry], { generatedAt: '2026-10-07T23:36:00.000Z' }));

    expect(merged.entries).toEqual([currentEntry]);
    expect(merged.generatedAt).toBe('2026-10-07T23:40:00.000Z');
    expect(merged.runs).toEqual([]);
  });

  it('combines a newer incoming explanation with the current source verification fields for the same hash', () => {
    const currentEntry = entry('release', { checkedAt: '2026-10-07T23:30:00.000Z' });
    const refreshed = { ...explanation, title: '새 모델로 검증한 해설입니다' };
    const incomingEntry = entry('release', {
      explanation: refreshed, explanationModel: 'haiku-5.5-test',
      editorialVersion: 'new-editorial', explanationEditedAt: '2026-10-07T23:35:00.000Z',
    });
    const merged = mergeImportedSnapshot(snapshot([currentEntry]), snapshot([incomingEntry]));

    expect(merged.entries).toEqual([{
      ...currentEntry, explanation: refreshed, explanationModel: 'haiku-5.5-test',
      editorialVersion: 'new-editorial', explanationEditedAt: '2026-10-07T23:35:00.000Z',
    }]);
  });

  it.each(['2026-10-07T23:35:00.000Z', '2026-10-07T23:36:00.000Z'])(
    'preserves current editorial metadata when its edit time is %s',
    explanationEditedAt => {
      const currentEntry = entry('release', {
        explanation: { ...explanation, title: '공개본의 최신 윤문을 유지합니다' },
        explanationModel: 'current-editor-model', editorialVersion: 'current-editorial', explanationEditedAt,
      });
      const incomingEntry = entry('release', {
        explanation: { ...explanation, title: '별도 작업에서 생성한 해설입니다' },
        explanationModel: 'haiku-5.5-test', explanationEditedAt: '2026-10-07T23:35:00.000Z',
      });

      expect(mergeImportedSnapshot(snapshot([currentEntry]), snapshot([incomingEntry])).entries).toEqual([currentEntry]);
    },
  );

  it('retains a current-only new entry while adding all 612 imported explanations', () => {
    const currentEntry = entry('current-only', { publishedAt: '2026-10-07T20:00:00.000Z', publishedDate: '2026-10-07' });
    const imported = Array.from({ length: 612 }, (_, index) => entry(`imported-${index}`, { explanationModel: 'haiku-5.5-test' }));
    const merged = mergeImportedSnapshot(snapshot([currentEntry]), snapshot(imported));

    expect(merged.entries).toHaveLength(613);
    expect(merged.entries.find(item => item.id === 'current-only')).toEqual(currentEntry);
    expect(merged.entries.filter(item => item.explanationModel === 'haiku-5.5-test')).toHaveLength(612);
  });

  it('canonicalizes duplicate CLI releases and preserves the primary source, links, and earliest confirmed coverage', () => {
    const githubUrl = 'https://github.com/openai/codex/releases/tag/rust-v0.161.0';
    const rssUrl = 'https://developers.openai.com/codex/changelog/#release-161';
    const primary = entry('legacy-github-id', {
      product: 'codex', channel: 'cli', sourceId: 'codex-releases', version: '0.161.0',
      originalTitle: '0.161.0', sourceUrl: githubUrl, contentHash: 'github-hash',
      publishedAt: '2026-10-07T15:58:45.000Z', publishedDate: '2026-10-07', datePrecision: 'timestamp',
      firstSeenAt: '2026-10-07T17:00:00.000Z', updatedAt: '2026-10-07T17:00:00.000Z',
      references: [{ title: 'GitHub 릴리스', url: githubUrl, kind: 'release' }],
    });
    const secondary = entry('legacy-rss-id', {
      product: 'codex', channel: 'cli', sourceId: 'codex-changelog', version: undefined,
      originalTitle: 'Codex CLI Release: 0.161.0', sourceUrl: rssUrl, contentHash: 'rss-hash',
      publishedAt: '2026-10-07T00:00:00.000Z', publishedDate: '2026-10-07',
      checkedAt: '2026-10-07T23:30:00.000Z', firstSeenAt: '2026-10-07T16:00:00.000Z', updatedAt: '2026-10-07T16:00:00.000Z',
      references: [{ title: '공식 RSS', url: rssUrl, kind: 'changelog' }],
    });
    const currentStatus: SourceStatus = {
      id: 'codex-releases', product: 'codex', name: 'Codex', url: githubUrl, state: 'error',
      checkedAt: '2026-10-07T23:00:00.000Z', lastSuccessAt: '2026-10-07T22:00:00.000Z',
      historySince: '2026-06-01T00:00:00.000Z', entryCount: 12, error: 'latest source check failed',
    };
    const incomingStatus: SourceStatus = {
      ...currentStatus, state: 'ok', checkedAt: '2026-10-07T21:00:00.000Z',
      lastSuccessAt: '2026-10-07T21:00:00.000Z', historySince: '2026-01-01T00:00:00.000Z', error: undefined,
    };
    const merged = mergeImportedSnapshot(
      snapshot([secondary], { sources: [currentStatus] }),
      snapshot([primary, { ...secondary, id: 'another-old-id' }], { sources: [incomingStatus] }),
    );

    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]).toMatchObject({
      sourceId: 'codex-releases', version: '0.161.0', originalTitle: '0.161.0', originalText: primary.originalText,
      publishedAt: primary.publishedAt, datePrecision: 'timestamp', checkedAt: primary.checkedAt,
      explanation: primary.explanation, explanationModel: primary.explanationModel,
      firstSeenAt: '2026-10-07T16:00:00.000Z',
    });
    expect(merged.entries[0].id).not.toBe('legacy-github-id');
    expect(merged.entries[0].references.map(reference => reference.url)).toEqual([githubUrl, rssUrl]);
    expect(merged.sources).toEqual([{ ...currentStatus, historySince: '2026-01-01T00:00:00.000Z' }]);
  });

  it('keeps every real run from both snapshots without applying collector retention or inventing a publication run', () => {
    const runs = Array.from({ length: 120 }, (_, index) => run(`real-run-${index}`, {
      startedAt: new Date(Date.parse('2026-10-07T10:00:00Z') + index * 1000).toISOString(),
    }));
    const current = snapshot([], { runs: runs.slice(0, 60) });
    const incoming = snapshot([], { runs: runs.slice(50) });
    const merged = mergeImportedSnapshot(current, incoming);

    expect(merged.runs).toHaveLength(120);
    expect(new Set(merged.runs.map(item => item.id))).toEqual(new Set(runs.map(item => item.id)));
    expect(merged.runs[0]).toEqual(runs[119]);
    expect(merged.runs.at(-1)).toEqual(runs[0]);
  });

  it('retains the later completed record for the same genuine run ID, with current winning ties', () => {
    const latestCurrent = run('current-wins', { completedAt: '2026-10-07T23:30:00.000Z', summarizedEntries: 100 });
    const latestIncoming = run('incoming-wins', { completedAt: '2026-10-07T23:30:00.000Z', summarizedEntries: 612 });
    const tiedCurrent = run('tie', { summarizedEntries: 10 });
    const merged = mergeImportedSnapshot(
      snapshot([], { runs: [latestCurrent, run('incoming-wins'), tiedCurrent] }),
      snapshot([], { runs: [run('current-wins'), latestIncoming, run('tie', { summarizedEntries: 5 })] }),
    );

    expect(merged.runs.find(item => item.id === latestCurrent.id)).toEqual(latestCurrent);
    expect(merged.runs.find(item => item.id === latestIncoming.id)).toEqual(latestIncoming);
    expect(merged.runs.find(item => item.id === tiedCurrent.id)).toEqual(tiedCurrent);
  });

  it('is immutable and idempotent so a publisher can repeat it after an ETag conflict', () => {
    const current = freeze(snapshot([entry('current-only')], { runs: [run('current-run')] }));
    const incoming = freeze(snapshot([entry('import-only')], {
      generatedAt: '2026-10-07T23:45:00.000Z', runs: [run('import-run')],
    }));
    const beforeCurrent = structuredClone(current);
    const beforeIncoming = structuredClone(incoming);
    const merged = mergeImportedSnapshot(current, incoming);

    expect(merged.entries).toHaveLength(2);
    expect(merged.generatedAt).toBe('2026-10-07T23:45:00.000Z');
    expect(mergeImportedSnapshot(merged, incoming)).toEqual(merged);
    expect(current).toEqual(beforeCurrent);
    expect(incoming).toEqual(beforeIncoming);
    expect(mergeImportedSnapshot(emptySnapshot(), emptySnapshot())).toEqual(emptySnapshot());
  });
});

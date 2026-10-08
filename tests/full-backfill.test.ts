import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { extractChangeItems } from '../src/collector/change-items.js';
import { FULL_CHANGES_VERSION, fullChangesSourceHash } from '../src/collector/full-changes.js';
import type { Candidate } from '../src/collector/sources.js';
import { WriteConflict, type SnapshotStore } from '../src/collector/store.js';
import type { Entry, FullChanges, Snapshot } from '../src/shared/types.js';
import { backfillFullChanges, type BackfillEvent, type BackfillOptions } from '../tools/backfill-full-changes.js';

const modelId = 'global.anthropic.claude-haiku-5-5';
const timestamp = '2026-10-08T01:00:00.000Z';

function entry(id: string, count = 2): Entry {
  const value: Entry = {
    id, product: 'claude-code', channel: 'cli', sourceId: 'claude-releases', version: id,
    originalTitle: `Release ${id}`,
    originalText: Array.from({ length: count }, (_, i) => `- Fixed issue ${i + 1} for release ${id}.`).join('\n'),
    contentHash: '', publishedAt: '2026-01-01T03:00:00.000Z', publishedDate: '2026-01-01',
    datePrecision: 'timestamp', sourceUrl: 'https://github.com/anthropics/claude-code/releases',
    references: [], firstSeenAt: timestamp, checkedAt: timestamp, updatedAt: timestamp,
    explanationStatus: 'ready', explanationModel: modelId, editorialVersion: 'human-ton-1',
    explanationEditedAt: timestamp,
    explanation: {
      title: '기존 요약입니다', summary: '기존 요약을 그대로 유지합니다.',
      whyItMatters: '기존 설명을 보존합니다.', highlights: [], actionItems: [], audience: [],
      category: 'fix', impact: 'low',
    },
  };
  value.contentHash = fullChangesSourceHash(value);
  return value;
}

function full(candidate: Candidate, count = extractChangeItems(candidate).length): FullChanges {
  const sources = extractChangeItems(candidate);
  return {
    status: count === sources.length ? 'ready' : 'pending',
    sourceHash: fullChangesSourceHash(candidate), model: modelId,
    formatVersion: FULL_CHANGES_VERSION, updatedAt: timestamp, sourceCount: sources.length,
    items: sources.slice(0, count).map((source, i) => ({ id: source.id, text: `${i + 1}번 항목의 오류를 수정했습니다.` })),
  };
}

function snapshot(entries: Entry[]): Snapshot {
  return {
    schemaVersion: 1, generatedAt: timestamp, entries,
    sources: [{
      id: 'claude-releases', product: 'claude-code', name: '공식 릴리스',
      url: 'https://github.com/anthropics/claude-code/releases', state: 'error',
      entryCount: entries.length, checkedAt: timestamp, lastSuccessAt: '2026-10-07T00:00:00.000Z',
      historySince: '2026-01-01', error: 'Keep the existing source failure.',
    }],
    runs: [{
      id: 'previous-run', startedAt: timestamp, completedAt: timestamp, status: 'partial',
      newEntries: 0, updatedEntries: 0, summarizedEntries: 0, failedSources: ['claude-releases'],
    }],
  };
}

class MemoryStore implements SnapshotStore {
  revision = 0;
  writes: Snapshot[] = [];
  attempts = 0;
  activeWrites = 0;
  maximumWrites = 0;
  beforeNextWrite?: () => void | Promise<void>;
  constructor(public snapshot: Snapshot) {}
  async read() { return { snapshot: structuredClone(this.snapshot), etag: String(this.revision) }; }
  async write(value: Snapshot, etag?: string) {
    this.attempts++;
    this.activeWrites++;
    this.maximumWrites = Math.max(this.maximumWrites, this.activeWrites);
    try {
      const hook = this.beforeNextWrite;
      this.beforeNextWrite = undefined;
      await hook?.();
      if (etag !== String(this.revision)) throw new WriteConflict();
      this.snapshot = structuredClone(value);
      this.writes.push(structuredClone(value));
      this.revision++;
    } finally { this.activeWrites--; }
  }
}

const explainer = (explain: BackfillOptions['explainer']['explain'] = async candidate => full(candidate)) => ({ modelId, explain });
const withoutFullChanges = (value: Snapshot) => ({
  ...value, entries: value.entries.map(({ fullChanges: _fullChanges, ...retained }) => retained),
});

describe('resumable local full-change migration', () => {
  it('persists all 56 items batch by batch before more generation and preserves existing metadata', async () => {
    const store = new MemoryStore(snapshot([entry('2.1.293', 56)]));
    const original = structuredClone(store.snapshot);
    const persisted: number[] = [];
    const events: BackfillEvent[] = [];
    const report = await backfillFullChanges({
      store, onEvent: event => events.push(event),
      explainer: explainer(async (candidate, _previous, onProgress) => {
        for (const count of [24, 48, 56]) {
          await onProgress!(full(candidate, count));
          persisted.push(store.snapshot.entries[0].fullChanges?.items.length ?? 0);
        }
        return full(candidate);
      }),
    });

    expect(persisted).toEqual([24, 48, 56]);
    expect(store.writes.map(value => value.entries[0].fullChanges!.items.length)).toEqual([24, 48, 56]);
    expect(withoutFullChanges(store.snapshot)).toEqual(original);
    expect(report).toMatchObject({
      records: 1, sourceItems: 56, completedItems: 56, completeRecords: 1, pendingRecords: 0,
      requestedRecords: 1, requestedPendingRecords: 0, failedIds: [],
    });
    const logged = JSON.stringify(events);
    expect(logged).not.toContain(original.entries[0].originalText);
    expect(logged).not.toContain('기존 요약');
    expect(logged).not.toContain(original.entries[0].contentHash);
  });

  it('does not generate or write again for an exactly complete record', async () => {
    const ready = entry('ready');
    ready.fullChanges = full(ready);
    const store = new MemoryStore(snapshot([ready]));
    const report = await backfillFullChanges({
      store, explainer: explainer(async () => { throw new Error('A complete record must not call the model.'); }),
    });

    expect(report).toMatchObject({ completeRecords: 1, pendingRecords: 0, failedIds: [] });
    expect(store.writes).toHaveLength(0);
  });

  it('resumes validated partial progress from the same source, model and format', async () => {
    const partial = entry('partial', 3);
    partial.fullChanges = full(partial, 2);
    const store = new MemoryStore(snapshot([partial]));
    const report = await backfillFullChanges({
      store, explainer: explainer(async (candidate, previous) => {
        expect(previous).toEqual(partial.fullChanges);
        return full(candidate);
      }),
    });

    expect(report).toMatchObject({ completedItems: 3, completeRecords: 1, failedIds: [] });
    expect(store.snapshot.entries[0].fullChanges!.items.slice(0, 2)).toEqual(partial.fullChanges.items);
  });

  it.each(['sourceHash', 'model', 'formatVersion'] as const)('does not resume stale %s progress', async field => {
    const stale = entry('stale');
    stale.fullChanges = { ...full(stale, 1), [field]: 'stale' };
    const store = new MemoryStore(snapshot([stale]));
    const report = await backfillFullChanges({
      store, explainer: explainer(async (candidate, previous) => {
        expect(previous).toBeUndefined();
        return full(candidate);
      }),
    });
    expect(report).toMatchObject({ completeRecords: 1, failedIds: [] });
  });

  it('retains successful checkpoints after failure and a rerun fills only the unfinished entry', async () => {
    const store = new MemoryStore(snapshot([entry('failed', 56), entry('neighbor')]));
    const first = await backfillFullChanges({
      store, concurrency: 1,
      explainer: explainer(async (candidate, _previous, progress) => {
        if (candidate.version === 'failed') {
          await progress!(full(candidate, 24));
          throw new Error('MODEL RESPONSE WITH PRIVATE SOURCE TEXT');
        }
        return full(candidate);
      }),
    });
    expect(first).toMatchObject({ completedItems: 26, completeRecords: 1, pendingRecords: 1, failedIds: ['failed'] });
    expect(store.snapshot.entries[0].fullChanges!.status).toBe('pending');

    const second = await backfillFullChanges({
      store, explainer: explainer(async (candidate, previous) => {
        expect(candidate.version).toBe('failed');
        expect(previous?.items).toHaveLength(24);
        return full(candidate);
      }),
    });
    expect(second).toMatchObject({ completedItems: 58, completeRecords: 2, pendingRecords: 0, failedIds: [] });
  });

  it('aborts generation for a failed checkpoint but continues with other entries', async () => {
    const store = new MemoryStore(snapshot([entry('failed'), entry('neighbor')]));
    store.beforeNextWrite = () => { throw new Error('SECRET STORAGE ERROR'); };
    let continuedAfterFailure = false;
    const events: BackfillEvent[] = [];
    const report = await backfillFullChanges({
      store, concurrency: 1, onEvent: event => events.push(event),
      explainer: explainer(async (candidate, _previous, progress) => {
        if (candidate.version === 'failed') {
          await progress!(full(candidate, 1));
          continuedAfterFailure = true;
        }
        return full(candidate);
      }),
    });

    expect(continuedAfterFailure).toBe(false);
    expect(store.snapshot.entries[0].fullChanges).toBeUndefined();
    expect(store.snapshot.entries[1].fullChanges?.status).toBe('ready');
    expect(report).toMatchObject({ completeRecords: 1, pendingRecords: 1, failedIds: ['failed'] });
    expect(JSON.stringify(events)).not.toContain('SECRET STORAGE ERROR');
  });

  it('cannot publish a final result after an explainer catches its failed checkpoint', async () => {
    const store = new MemoryStore(snapshot([entry('failed')]));
    store.beforeNextWrite = () => { throw new Error('storage unavailable'); };
    const report = await backfillFullChanges({
      store, explainer: explainer(async (candidate, _previous, progress) => {
        try { await progress!(full(candidate, 1)); } catch { /* Simulate a faulty injected explainer. */ }
        return full(candidate);
      }),
    });
    expect(store.writes).toHaveLength(0);
    expect(store.snapshot.entries[0].fullChanges).toBeUndefined();
    expect(report).toMatchObject({ completeRecords: 0, pendingRecords: 1, failedIds: ['failed'] });
  });

  it.each([undefined, 1, 12])('bounds generation concurrency to %s and serializes every checkpoint', async concurrency => {
    const store = new MemoryStore(snapshot(Array.from({ length: 13 }, (_, i) => entry(String(i)))));
    let active = 0, maximumActive = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const task = backfillFullChanges({
      store, concurrency,
      explainer: explainer(async (candidate, _previous, progress) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          await gate;
          await progress!(full(candidate, 1));
          await progress!(full(candidate));
          return full(candidate);
        } finally { active--; }
      }),
    });
    // Observe early rejection even when the concurrency assertion fails first.
    void task.catch(() => {});
    try {
      await vi.waitFor(() => expect(active).toBe(concurrency ?? 3));
      expect(store.writes).toHaveLength(0);
    } finally { release(); }
    const report = await task;

    expect(maximumActive).toBe(concurrency ?? 3);
    expect(store.maximumWrites).toBe(1);
    expect(report).toMatchObject({ completedItems: 26, completeRecords: 13, failedIds: [] });
    expect(store.snapshot.entries.every(value => value.fullChanges?.items.length === 2)).toBe(true);
  });

  it('retries an ETag conflict while preserving unrelated additions, source status, runs and target metadata', async () => {
    const store = new MemoryStore(snapshot([entry('target'), entry('other', 1)]));
    let concurrent!: Snapshot;
    store.beforeNextWrite = () => {
      store.snapshot.entries.push(entry('new', 1));
      store.snapshot.entries[0].explanation!.title = '동시에 다듬은 제목입니다';
      store.snapshot.entries[0].explanationEditedAt = '2026-10-08T02:00:00.000Z';
      store.snapshot.entries[1].checkedAt = '2026-10-08T02:00:00.000Z';
      store.snapshot.sources[0].state = 'ok';
      store.snapshot.sources[0].entryCount = 3;
      store.snapshot.runs.push({ ...store.snapshot.runs[0], id: 'concurrent-run', status: 'success' });
      store.snapshot.generatedAt = '2026-10-08T02:00:00.000Z';
      concurrent = structuredClone(store.snapshot);
      store.revision++;
    };
    const report = await backfillFullChanges({ store, explainer: explainer(), entryIds: ['target'] });

    expect(store.attempts).toBe(2);
    expect(withoutFullChanges(store.snapshot)).toEqual(concurrent);
    expect(report).toMatchObject({
      records: 3, sourceItems: 4, completedItems: 2, completeRecords: 1, pendingRecords: 2,
      requestedRecords: 1, requestedPendingRecords: 0, failedIds: [],
    });
  });

  it.each(['changed', 'removed'])('never overwrites a target whose source is concurrently %s', async action => {
    const store = new MemoryStore(snapshot([entry('target')]));
    let concurrent!: Snapshot;
    store.beforeNextWrite = () => {
      if (action === 'removed') store.snapshot.entries = [];
      else {
        store.snapshot.entries[0].originalText = '- Fixed a newly discovered problem.';
        store.snapshot.entries[0].contentHash = fullChangesSourceHash(store.snapshot.entries[0]);
      }
      concurrent = structuredClone(store.snapshot);
      store.revision++;
    };
    const report = await backfillFullChanges({ store, explainer: explainer() });

    expect(store.snapshot).toEqual(concurrent);
    expect(store.writes).toHaveLength(0);
    expect(report).toMatchObject({ requestedPendingRecords: 1, failedIds: ['target'] });
  });

  it('processes only selected pending entries up to the cap while reporting global unfinished records', async () => {
    const ready = entry('ready');
    ready.fullChanges = full(ready);
    const store = new MemoryStore(snapshot([ready, entry('selected'), entry('capped'), entry('unselected')]));
    const original = structuredClone(store.snapshot);
    const report = await backfillFullChanges({
      store, explainer: explainer(), entryIds: ['ready', 'selected', 'capped'], maxEntries: 1,
    });

    expect(store.snapshot.entries[0]).toEqual(original.entries[0]);
    expect(store.snapshot.entries[2]).toEqual(original.entries[2]);
    expect(store.snapshot.entries[3]).toEqual(original.entries[3]);
    expect(report).toMatchObject({
      records: 4, sourceItems: 8, completedItems: 4, completeRecords: 2, pendingRecords: 2,
      requestedRecords: 3, requestedPendingRecords: 1, failedIds: [],
    });
  });

  it('reports an unknown selected ID as unfinished without touching unrelated records', async () => {
    const store = new MemoryStore(snapshot([entry('unselected')]));
    const report = await backfillFullChanges({ store, explainer: explainer(), entryIds: ['missing'] });
    expect(report).toMatchObject({ requestedRecords: 1, requestedPendingRecords: 1, failedIds: ['missing'] });
    expect(store.writes).toHaveLength(0);
  });

  it('keeps the final status pending when a requested ID is missing from an otherwise complete snapshot', async () => {
    const ready = entry('ready');
    ready.fullChanges = full(ready);
    const store = new MemoryStore(snapshot([ready]));
    const events: BackfillEvent[] = [];
    const report = await backfillFullChanges({
      store, explainer: explainer(), entryIds: ['missing'], onEvent: event => events.push(event),
    });
    expect(report).toMatchObject({ completeRecords: 1, pendingRecords: 0, requestedPendingRecords: 1 });
    expect(events.at(-1)).toMatchObject({ event: 'full_backfill_completed', status: 'pending' });
  });

  it('rejects an invalid content hash before model generation, including falsely ready records', async () => {
    const invalid = entry('invalid');
    invalid.fullChanges = full(invalid);
    invalid.contentHash = 'wrong';
    const store = new MemoryStore(snapshot([invalid]));
    let invoked = false;
    const report = await backfillFullChanges({
      store, explainer: explainer(async candidate => { invoked = true; return full(candidate); }),
    });
    expect(invoked).toBe(false);
    expect(report).toMatchObject({ completedItems: 0, completeRecords: 0, pendingRecords: 1, failedIds: ['invalid'] });
    expect(store.writes).toHaveLength(0);
  });

  it.each(['missing', 'duplicate', 'unknown', 'text', 'sourceHash', 'model', 'formatVersion', 'sourceCount', 'pending'])(
    'does not persist a malformed or incomplete final result: %s', async defect => {
      const store = new MemoryStore(snapshot([entry('invalid')]));
      const report = await backfillFullChanges({
        store, explainer: explainer(async candidate => {
          const value = full(candidate);
          if (defect === 'missing') value.items.pop();
          if (defect === 'duplicate') value.items[1] = value.items[0];
          if (defect === 'unknown') value.items[0].id = 'unknown';
          if (defect === 'text') value.items[0].text = 'SECRET non-Korean model output';
          if (defect === 'sourceHash' || defect === 'model' || defect === 'formatVersion') value[defect] = 'wrong';
          if (defect === 'sourceCount') value.sourceCount = 1;
          if (defect === 'pending') value.status = 'pending';
          return value;
        }),
      });
      expect(store.snapshot.entries[0].fullChanges).toBeUndefined();
      expect(store.writes).toHaveLength(0);
      expect(report).toMatchObject({ completedItems: 0, completeRecords: 0, failedIds: ['invalid'] });
    },
  );

  it('rejects a falsely ready partial checkpoint before persisting or continuing generation', async () => {
    const store = new MemoryStore(snapshot([entry('invalid')]));
    let continued = false;
    const report = await backfillFullChanges({
      store, explainer: explainer(async (candidate, _previous, progress) => {
        await progress!({ ...full(candidate, 1), status: 'ready' });
        continued = true;
        return full(candidate);
      }),
    });
    expect(continued).toBe(false);
    expect(store.writes).toHaveLength(0);
    expect(report).toMatchObject({ pendingRecords: 1, failedIds: ['invalid'] });
  });

  it('rereads final totals and validates complete ID coverage instead of trusting ready flags', async () => {
    const store = new MemoryStore(snapshot([entry('existing')]));
    const report = await backfillFullChanges({
      store, explainer: explainer(), maxEntries: 0,
      onEvent: event => {
        if (event.event !== 'full_backfill_started') return;
        const added = entry('new', 3);
        added.fullChanges = { ...full(added, 1), status: 'ready' };
        store.snapshot.entries.push(added);
        store.revision++;
      },
    });
    expect(report).toMatchObject({
      records: 2, sourceItems: 5, completedItems: 1, completeRecords: 0, pendingRecords: 2,
      requestedRecords: 1, requestedPendingRecords: 1,
    });
    expect(store.writes).toHaveLength(0);
  });

  it('stops bounded conflict retries and leaves the record resumable', async () => {
    const store = new MemoryStore(snapshot([entry('conflict')]));
    const conflict = () => { store.revision++; store.beforeNextWrite = conflict; };
    store.beforeNextWrite = conflict;
    const report = await backfillFullChanges({ store, explainer: explainer() });
    expect(store.attempts).toBeGreaterThan(1);
    expect(store.attempts).toBeLessThanOrEqual(6);
    expect(store.writes).toHaveLength(0);
    expect(report).toMatchObject({ pendingRecords: 1, failedIds: ['conflict'] });
  });

  it.each([0, 13, 1.5, NaN])('rejects invalid concurrency before reading or writing: %s', async concurrency => {
    const store = new MemoryStore(snapshot([entry('one')]));
    await expect(backfillFullChanges({ store, explainer: explainer(), concurrency })).rejects.toThrow(/concurrency/);
    expect(store.writes).toHaveLength(0);
  });

  it('does not turn a metadata observer failure into a successful migration', async () => {
    const store = new MemoryStore(snapshot([entry('one')]));
    let continued = false;
    await expect(backfillFullChanges({
      store, explainer: explainer(async (candidate, _previous, progress) => {
        await progress!(full(candidate, 1));
        continued = true;
        return full(candidate);
      }),
      onEvent: event => { if (event.event === 'full_backfill_progress') throw new Error('PRIVATE OBSERVER ERROR'); },
    })).rejects.toThrow();
    expect(continued).toBe(false);
    expect(store.snapshot.entries[0].fullChanges?.items).toHaveLength(1);
  });
});

describe('local migration CLI', () => {
  const execute = promisify(execFile);
  const script = resolve('tools/backfill-full-changes.ts');

  it('can be imported without running a migration', async () => {
    const result = await execute(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      `await import(${JSON.stringify(script)}); console.log('imported');`,
    ]);
    expect(result.stdout.trim()).toBe('imported');
    expect(result.stderr).toBe('');
  });

  it('requires an explicit local directory even when DATA_DIR or DATA_BUCKET is set', async () => {
    const result = await execute(process.execPath, ['--import', 'tsx', script], {
      env: { ...process.env, DATA_DIR: '/tmp/must-not-default', DATA_BUCKET: 'must-not-use-s3' },
    }).then(value => ({ ...value, code: 0 }), error => error as { code: number; stdout: string; stderr: string });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('data-dir');
    expect(result.stderr).not.toContain('must-not-use-s3');
  });

  it('uses only local storage and exits nonzero while requested records are incomplete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'full-backfill-'));
    const value = snapshot([entry('pending')]);
    const text = JSON.stringify(value);
    try {
      await writeFile(join(directory, 'snapshot.json'), text);
      const result = await execute(process.execPath, [
        '--import', 'tsx', script, '--data-dir', directory, '--max-entries', '0',
      ], { env: { ...process.env, DATA_BUCKET: 'must-not-use-s3' } })
        .then(value => ({ ...value, code: 0 }), error => error as { code: number; stdout: string; stderr: string });
      expect(result.code).toBe(2);
      expect(result.stderr).toBe('');
      const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(events.at(-1)).toMatchObject({
        event: 'full_backfill_completed', records: 1, sourceItems: 2,
        completeRecords: 0, pendingRecords: 1, requestedPendingRecords: 1,
      });
      expect(await readFile(join(directory, 'snapshot.json'), 'utf8')).toBe(text);
      expect(result.stdout).not.toContain(value.entries[0].originalText);
      expect(result.stdout).not.toContain('must-not-use-s3');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('exits zero for completed selected IDs while honestly reporting global pending records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'full-backfill-'));
    const ready = entry('ready');
    ready.fullChanges = full(ready);
    const text = JSON.stringify(snapshot([ready, entry('pending')]));
    try {
      await writeFile(join(directory, 'snapshot.json'), text);
      const result = await execute(process.execPath, [
        '--import', 'tsx', script, '--data-dir', directory, '--entry', 'ready', '--entry', 'ready',
      ], { env: { ...process.env, DATA_BUCKET: 'must-not-use-s3', BEDROCK_MODEL_ID: 'obsolete-model' } });
      expect(result.stderr).toBe('');
      const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(events.at(-1)).toMatchObject({
        event: 'full_backfill_completed', status: 'pending', records: 2,
        completeRecords: 1, pendingRecords: 1, requestedRecords: 1, requestedPendingRecords: 0,
      });
      expect(await readFile(join(directory, 'snapshot.json'), 'utf8')).toBe(text);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

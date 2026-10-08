import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { extractChangeItems } from '../src/collector/change-items.js';
import { DEFAULT_MODEL_ID } from '../src/collector/explanation.js';
import {
  BedrockChangeExplainer, FULL_CHANGES_VERSION, fullChangesSourceHash,
  isFullChangesComplete, isFullChangesProgress,
} from '../src/collector/full-changes.js';
import { FileStore, WriteConflict, type SnapshotStore } from '../src/collector/store.js';
import type { Entry, FullChanges } from '../src/shared/types.js';

export interface BackfillReport {
  records: number;
  sourceItems: number;
  completedItems: number;
  completeRecords: number;
  pendingRecords: number;
  requestedRecords: number;
  requestedPendingRecords: number;
  failedIds: string[];
  elapsedMs: number;
}

export interface BackfillEvent extends Partial<BackfillReport> {
  event: 'full_backfill_started' | 'full_backfill_progress' | 'full_backfill_failed' | 'full_backfill_completed';
  id?: string;
  version?: string;
  status?: 'ready' | 'pending' | 'failed';
  reason?: FailureReason;
  concurrency?: number;
  formatVersion?: string;
}

export interface BackfillOptions {
  store: SnapshotStore;
  explainer: Pick<BedrockChangeExplainer, 'modelId' | 'explain'>;
  concurrency?: number;
  entryIds?: readonly string[];
  maxEntries?: number;
  /** Synchronous metadata observer. Exceptions abort the run after in-flight writes settle. */
  onEvent?: (event: BackfillEvent) => void;
}

type FailureReason = 'invalid_source' | 'source_changed' | 'source_missing' | 'invalid_generation'
  | 'generation_failed' | 'checkpoint_failed' | 'observer_failed';
class BackfillFailure extends Error {
  constructor(readonly reason: FailureReason) { super(reason); }
}
class OptionsError extends Error {}

function complete(entry: Entry, modelId: string): boolean {
  return entry.contentHash === fullChangesSourceHash(entry)
    && isFullChangesComplete(entry.fullChanges, entry, modelId);
}

function sameSource(current: Entry | undefined, target: Entry): asserts current is Entry {
  if (!current) throw new BackfillFailure('source_missing');
  if (current.contentHash !== target.contentHash || fullChangesSourceHash(current) !== target.contentHash) {
    throw new BackfillFailure('source_changed');
  }
}

/** All counts describe the final reread snapshot; requested counts also include missing requested IDs. */
export async function backfillFullChanges(options: BackfillOptions): Promise<BackfillReport> {
  const { store, explainer } = options;
  const concurrency = options.concurrency ?? 3;
  const maxEntries = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new OptionsError('concurrency must be an integer from 1 to 12.');
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new OptionsError('max-entries must be a nonnegative integer.');
  }
  const started = Date.now();
  let observerFailed = false;
  const emit = (event: BackfillEvent) => {
    if (observerFailed) throw new BackfillFailure('observer_failed');
    try { options.onEvent?.(event); }
    catch { observerFailed = true; throw new BackfillFailure('observer_failed'); }
  };
  const initial = (await store.read()).snapshot;
  const requestedIds = new Set(options.entryIds ?? initial.entries.map(entry => entry.id));
  const failedIds = new Set<string>();
  const targets = initial.entries.filter(entry => requestedIds.has(entry.id) && !complete(entry, explainer.modelId))
    .slice(0, maxEntries);
  emit({
    event: 'full_backfill_started', records: initial.entries.length, requestedRecords: requestedIds.size,
    concurrency, formatVersion: FULL_CHANGES_VERSION, elapsedMs: 0,
  });
  for (const id of requestedIds) {
    if (initial.entries.some(entry => entry.id === id)) continue;
    failedIds.add(id);
    emit({ event: 'full_backfill_failed', id, status: 'failed', reason: 'source_missing', elapsedMs: Date.now() - started });
  }

  // The queue absorbs a failed write only for scheduling. Its original promise
  // still rejects to the entry's awaited callback, stopping further generation.
  let writes: Promise<void> = Promise.resolve();
  const persist = async (target: Entry, value: FullChanges): Promise<FullChanges> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const latest = await store.read();
      const current = latest.snapshot.entries.find(entry => entry.id === target.id);
      sameSource(current, target);
      if (complete(current, explainer.modelId)) return current.fullChanges!;
      const saved = isFullChangesProgress(current.fullChanges, current, explainer.modelId) ? current.fullChanges : undefined;
      // Keep independently saved valid items and prefer their text on duplicate
      // IDs. Generation only fills missing items, so it must not undo edits.
      const byId = new Map([...value.items, ...(saved?.items ?? [])].map(item => [item.id, item]));
      const items = extractChangeItems(target).flatMap(source => {
        const item = byId.get(source.id);
        return item ? [item] : [];
      });
      const merged: FullChanges = {
        ...value, items, status: items.length === value.sourceCount ? 'ready' : 'pending',
        updatedAt: saved && Date.parse(saved.updatedAt) > Date.parse(value.updatedAt) ? saved.updatedAt : value.updatedAt,
      };
      if (saved?.status === merged.status && saved.items.length === items.length
        && saved.items.every((item, index) => item.id === items[index].id && item.text === items[index].text)) return saved;
      try {
        await store.write({
          ...latest.snapshot,
          entries: latest.snapshot.entries.map(entry => entry.id === target.id ? { ...entry, fullChanges: merged } : entry),
        }, latest.etag);
        return merged;
      } catch (error) {
        if (!(error instanceof WriteConflict) || attempt === 4) throw new BackfillFailure('checkpoint_failed');
      }
    }
    throw new BackfillFailure('checkpoint_failed');
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length && !observerFailed) {
      const target = targets[cursor++];
      try {
        if (target.contentHash !== fullChangesSourceHash(target)) throw new BackfillFailure('invalid_source');
        const candidate = (await store.read()).snapshot.entries.find(entry => entry.id === target.id);
        sameSource(candidate, target);
        if (complete(candidate, explainer.modelId)) continue;
        try {
          if (!extractChangeItems(candidate).length) throw new Error();
        } catch { throw new BackfillFailure('invalid_source'); }
        const previous = isFullChangesProgress(candidate.fullChanges, candidate, explainer.modelId)
          ? structuredClone(candidate.fullChanges) : undefined;
        let checkpointFailure: BackfillFailure | undefined;
        const checkpoint = async (value: FullChanges) => {
          if (checkpointFailure) throw checkpointFailure;
          try {
            if (!isFullChangesProgress(value, candidate, explainer.modelId)
              || (value.status === 'ready' && !isFullChangesComplete(value, candidate, explainer.modelId))) {
              throw new BackfillFailure('invalid_generation');
            }
            const progress = structuredClone(value);
            const write = writes.then(() => persist(candidate, progress));
            writes = write.then(() => undefined, () => undefined);
            const saved = await write;
            emit({
              event: 'full_backfill_progress', id: target.id, version: candidate.version,
              status: saved.status, sourceItems: saved.sourceCount, completedItems: saved.items.length,
              elapsedMs: Date.now() - started,
            });
          } catch (error) {
            checkpointFailure = error instanceof BackfillFailure ? error : new BackfillFailure('checkpoint_failed');
            throw checkpointFailure;
          }
        };
        const value = await explainer.explain(structuredClone(candidate), previous, checkpoint);
        if (checkpointFailure) throw checkpointFailure;
        if (!isFullChangesComplete(value, candidate, explainer.modelId)) throw new BackfillFailure('invalid_generation');
        await checkpoint(value);
      } catch (error) {
        if (observerFailed) throw error;
        failedIds.add(target.id);
        emit({
          event: 'full_backfill_failed', id: target.id, version: target.version, status: 'failed',
          reason: error instanceof BackfillFailure ? error.reason : 'generation_failed', elapsedMs: Date.now() - started,
        });
      }
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  await writes;
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;

  const final = (await store.read()).snapshot;
  let sourceItems = 0, completedItems = 0, completeRecords = 0;
  for (const entry of final.entries) {
    try { sourceItems += extractChangeItems(entry).length; } catch { /* Invalid records remain pending. */ }
    if (entry.contentHash !== fullChangesSourceHash(entry)) continue;
    if (isFullChangesProgress(entry.fullChanges, entry, explainer.modelId)) completedItems += entry.fullChanges!.items.length;
    if (complete(entry, explainer.modelId)) completeRecords++;
  }
  const finalEntries = new Map(final.entries.map(entry => [entry.id, entry]));
  const report: BackfillReport = {
    records: final.entries.length, sourceItems, completedItems, completeRecords,
    pendingRecords: final.entries.length - completeRecords, requestedRecords: requestedIds.size,
    requestedPendingRecords: [...requestedIds].filter(id => {
      const entry = finalEntries.get(id);
      return !entry || !complete(entry, explainer.modelId);
    }).length,
    failedIds: [...failedIds].sort(), elapsedMs: Date.now() - started,
  };
  emit({
    event: 'full_backfill_completed',
    status: report.pendingRecords || report.requestedPendingRecords ? 'pending' : 'ready', ...report,
  });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let values;
    try {
      ({ values } = parseArgs({
        options: {
          'data-dir': { type: 'string' }, concurrency: { type: 'string' },
          entry: { type: 'string', multiple: true }, 'max-entries': { type: 'string' },
        },
      }));
    } catch {
      throw new OptionsError('Usage: --data-dir DIRECTORY [--concurrency 1..12] [--entry ID] [--max-entries COUNT]');
    }
    if (!values['data-dir']?.trim()) throw new OptionsError('--data-dir is required for local migration.');
    const report = await backfillFullChanges({
      // Deliberately do not use configuredStore or DATA_BUCKET here.
      store: new FileStore(values['data-dir']), explainer: new BedrockChangeExplainer(DEFAULT_MODEL_ID),
      concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
      entryIds: values.entry, maxEntries: values['max-entries'] === undefined ? undefined : Number(values['max-entries']),
      onEvent: event => console.log(JSON.stringify(event)),
    });
    process.exitCode = report.requestedPendingRecords ? 2 : 0;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'full_backfill_aborted', status: 'failed',
      reason: error instanceof OptionsError ? error.message : error instanceof BackfillFailure ? error.reason : 'migration_failed',
    }));
    process.exitCode = 1;
  }
}

import { createHash, randomUUID } from 'node:crypto';
import type { CollectionRun, Entry, Explanation, Snapshot, SourceStatus } from '../shared/types.js';
import { parseSource, plainText, SOURCES, type Candidate, type SourceDefinition } from './sources.js';
import type { FetchedDocument } from './official-fetch.js';
import { readSourceHistory } from './source-history.js';
import { WriteConflict, type SnapshotStore } from './store.js';

export interface Supplement { url: string; text: string }
export interface CollectOptions {
  store: SnapshotStore;
  fetchDocument: (url: string) => Promise<FetchedDocument>;
  summarize: (candidate: Candidate, supplements: Supplement[]) => Promise<Explanation>;
  sources?: SourceDefinition[];
  now?: () => Date;
  lookbackDays?: number;
  sinceDate?: string;
  maxSummaries?: number;
  summaryConcurrency?: number;
  modelId?: string;
  refreshModel?: boolean;
  editorialVersion?: string;
  onWarning?: (warning: { id: string; message: string }) => void;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function startOfDate(sinceDate: string, startedTime: number): number {
  const timestamp = Date.parse(`${sinceDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate) || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString().slice(0, 10) !== sinceDate) {
    throw new Error('sinceDate는 달력상 유효한 YYYY-MM-DD 날짜여야 합니다.');
  }
  if (timestamp > startedTime) throw new Error('수집 시작 날짜는 미래일 수 없습니다.');
  return timestamp;
}

function identity(candidate: Candidate): string {
  const url = new URL(candidate.sourceUrl);
  for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_')) url.searchParams.delete(key);
  const key = candidate.channel === 'cli' && candidate.version
    ? `${candidate.product}:cli:${candidate.version}` : url.toString();
  return `${candidate.product}-${digest(key).slice(0, 20)}`;
}

function canonicalEntry(entry: Entry): Entry {
  const version = entry.version ?? (entry.channel === 'cli'
    ? entry.originalTitle.match(/^Codex CLI(?: Release)?:?\s+(\d+\.\d+\.\d+)\s*$/i)?.[1] : undefined);
  return version && entry.channel === 'cli' ? { ...entry, version, id: identity({ ...entry, version }) } : entry;
}

function isPrimaryRelease(candidate: Candidate): boolean {
  return candidate.channel === 'cli' && candidate.sourceId.endsWith('-releases');
}

function mergeReferences(...candidates: Candidate[]): Entry['references'] {
  return [...new Map(candidates.flatMap(candidate => candidate.references).map(reference => [reference.url, reference])).values()];
}

function earliestHistorySince(...values: (string | undefined)[]): string | undefined {
  const times = values.map(value => Date.parse(value ?? '')).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : undefined;
}

function mergeEntry(previous: Entry, incoming: Entry): Entry {
  const previousPrimary = isPrimaryRelease(previous);
  const incomingPrimary = isPrimaryRelease(incoming);
  // Canonical source precedence survives feed omissions and concurrent runs.
  const source = previousPrimary !== incomingPrimary
    ? previousPrimary ? previous : incoming
    : previous.checkedAt > incoming.checkedAt ? previous : incoming;
  const other = source === previous ? incoming : previous;
  const merged: Entry = {
    ...source,
    firstSeenAt: [previous.firstSeenAt, incoming.firstSeenAt].sort()[0],
    references: mergeReferences(source, other),
  };
  if (previous.contentHash !== incoming.contentHash) return merged;

  // Source verification and explanation editing are independent clocks.
  // On tied/legacy edit times, the already persisted explanation wins.
  const previousReady = previous.explanationStatus === 'ready' && previous.explanation;
  const incomingReady = incoming.explanationStatus === 'ready' && incoming.explanation;
  const edited = previousReady && (!incomingReady
    || (previous.explanationEditedAt ?? '') >= (incoming.explanationEditedAt ?? ''))
    ? previous : incomingReady ? incoming : source;
  return {
    ...merged, explanationStatus: edited.explanationStatus, explanation: edited.explanation,
    explanationModel: edited.explanationModel, editorialVersion: edited.editorialVersion,
    explanationEditedAt: edited.explanationEditedAt,
  };
}

function deduplicateReleases(entries: Entry[]): Entry[] {
  const result = new Map<string, Entry>();
  for (const entry of entries) {
    const version = entry.version ?? (entry.channel === 'cli' ? entry.originalTitle.match(/^Codex CLI(?: Release)?:?\s+(\d+\.\d+\.\d+)\b/i)?.[1] : undefined);
    const key = entry.channel === 'cli' && version ? `${entry.product}:cli:${version}` : entry.id;
    const old = result.get(key);
    if (!old) { result.set(key, entry); continue; }
    result.set(key, mergeEntry(old, entry));
  }
  return [...result.values()];
}

function mergeEntries(current: Entry[], additions: Entry[]): Entry[] {
  const entries = new Map(deduplicateReleases(current.map(canonicalEntry)).map(entry => [entry.id, entry]));
  for (const entry of additions) {
    const previous = entries.get(entry.id);
    entries.set(entry.id, previous ? mergeEntry(previous, entry) : entry);
  }
  return deduplicateReleases([...entries.values()])
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
}

function mergeSourceStatuses(current: SourceStatus[], statuses: SourceStatus[]): SourceStatus[] {
  const sources = new Map(current.map(source => [source.id, source]));
  for (const source of statuses) {
    const previous = sources.get(source.id);
    const observation = !previous?.checkedAt || previous.checkedAt <= source.checkedAt!
      ? {
        ...source,
        lastSuccessAt: source.lastSuccessAt && (!previous?.lastSuccessAt || source.lastSuccessAt > previous.lastSuccessAt)
          ? source.lastSuccessAt : previous?.lastSuccessAt,
      } : previous;
    // A slower full read may expand coverage even after a newer source check.
    const historySince = earliestHistorySince(previous?.historySince, source.historySince);
    sources.set(source.id, historySince ? { ...observation, historySince } : observation);
  }
  return [...sources.values()];
}

function merge(
  current: Snapshot, additions: Entry[], statuses: SourceStatus[], run: CollectionRun, includeRun = true,
): Snapshot {
  const runs = [...new Map([...current.runs, ...(includeRun ? [run] : [])].map(item => [item.id, item])).values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 90);
  return {
    schemaVersion: 1, generatedAt: [current.generatedAt, run.completedAt].sort().at(-1)!,
    entries: mergeEntries(current.entries, additions),
    sources: mergeSourceStatuses(current.sources, statuses), runs,
  };
}

/** Merge verified data for publication without creating or rewriting a collection run. */
export function mergeImportedSnapshot(current: Snapshot, incoming: Snapshot): Snapshot {
  const runs = new Map<string, CollectionRun>();
  for (const run of [...current.runs, ...incoming.runs]) {
    const previous = runs.get(run.id);
    if (!previous || run.completedAt > previous.completedAt) runs.set(run.id, run);
  }
  return {
    schemaVersion: 1,
    generatedAt: [current.generatedAt, incoming.generatedAt].sort().at(-1)!,
    entries: mergeEntries(current.entries, incoming.entries.map(canonicalEntry)),
    sources: mergeSourceStatuses(current.sources, incoming.sources),
    runs: [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id)),
  };
}

export async function collectOnce(options: CollectOptions): Promise<CollectionRun> {
  const summaryConcurrency = options.summaryConcurrency === undefined ? 3 : options.summaryConcurrency;
  if (!Number.isInteger(summaryConcurrency) || summaryConcurrency < 1 || summaryConcurrency > 6) {
    throw new Error('summaryConcurrency는 1~6 범위의 정수여야 합니다.');
  }
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const startedTime = Date.parse(startedAt);
  const earliestPublishedAt: number = options.sinceDate === undefined
    ? startedTime - (options.lookbackDays ?? 45) * 86_400_000
    : startOfDate(options.sinceDate, startedTime);
  const sources = options.sources ?? SOURCES;
  const prior = await options.store.read();
  const previous = new Map(deduplicateReleases(prior.snapshot.entries.map(canonicalEntry)).map(entry => [entry.id, entry]));
  const needsModelRefresh = (entry: Entry) => options.refreshModel === true && Boolean(options.modelId)
    && entry.explanationModel !== options.modelId;
  const statuses: SourceStatus[] = [];
  const candidates = new Map<string, Candidate>();
  const historyReadSince = new Map<string, number>();
  const fetched = await Promise.allSettled(sources.map(source => {
    const confirmedSince = Date.parse(prior.snapshot.sources.find(item => item.id === source.id)?.historySince ?? '');
    const readSince = source.id === 'codex-releases' && Number.isFinite(confirmedSince) && confirmedSince <= earliestPublishedAt
      ? Math.max(earliestPublishedAt, startedTime - 45 * 86_400_000) : earliestPublishedAt;
    historyReadSince.set(source.id, readSince);
    return readSourceHistory(source, {
      fetchDocument: options.fetchDocument, earliestPublishedAt: readSince,
      onDocument: document => options.store.archive?.(source.id, document.body, startedAt),
    });
  }));
  const parseDocument = (index: number, known: Candidate[] = []): PromiseSettledResult<Candidate[]> => {
    const result = fetched[index];
    if (result.status === 'rejected') return result;
    try {
      const entries = typeof result.value === 'string' ? parseSource(sources[index], result.value, known) : result.value;
      if (!entries.length && !sources[index].referenceOnly) {
        throw new Error('공식 자료에서 공개된 변경 기록을 찾을 수 없습니다.');
      }
      return { status: 'fulfilled', value: entries };
    } catch (reason) {
      return { status: 'rejected', reason };
    }
  };
  // Weekly coverage ranges supply context for dated releases, never publication dates.
  const parsed = sources.map((source, index) => source.referenceOnly ? undefined : parseDocument(index));
  const known = new Map<string, Candidate>(previous);
  for (const result of parsed) {
    if (result?.status !== 'fulfilled') continue;
    for (const candidate of result.value) {
      const id = identity(candidate);
      const existing = known.get(id);
      if (!existing || isPrimaryRelease(candidate) || !isPrimaryRelease(existing)) known.set(id, candidate);
    }
  }
  for (let index = 0; index < sources.length; index++) {
    if (sources[index].referenceOnly) parsed[index] = parseDocument(index, [...known.values()]);
  }
  const backgroundByIdentity = new Map<string, Candidate[]>();
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    const result = parsed[index]!;
    const oldStatus = prior.snapshot.sources.find(item => item.id === source.id);
    const base = {
      id: source.id, product: source.product, name: source.name, url: source.url, checkedAt: startedAt,
      ...(oldStatus?.historySince ? { historySince: oldStatus.historySince } : {}),
    };
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : '공식 자료를 읽지 못했습니다.';
      statuses.push({ ...base, state: 'error', lastSuccessAt: oldStatus?.lastSuccessAt, entryCount: oldStatus?.entryCount ?? 0, latestPublishedDate: oldStatus?.latestPublishedDate, error: reason.slice(0, 240) });
      continue;
    }
    const eligible = result.value.filter(candidate => {
      const canonical = known.get(identity(candidate));
      const publication = canonical && isPrimaryRelease(canonical) ? canonical : candidate;
      const time = Date.parse(publication.publishedAt);
      return time <= startedTime && time >= earliestPublishedAt;
    });
    statuses.push({
      ...base, state: 'ok', lastSuccessAt: startedAt, entryCount: eligible.length,
      latestPublishedDate: source.referenceOnly ? undefined
        : eligible.map(item => item.publishedDate).sort().at(-1) ?? oldStatus?.latestPublishedDate,
    });
    if (source.referenceOnly) {
      for (const candidate of result.value) {
        const id = identity(candidate);
        backgroundByIdentity.set(id, [...(backgroundByIdentity.get(id) ?? []), candidate]);
      }
      continue;
    }
    for (const candidate of eligible) {
      const id = identity(candidate);
      const existing = candidates.get(id);
      // GitHub is the canonical CLI release. The product feed can add context.
      if (existing) {
        const primary = isPrimaryRelease(candidate) ? candidate : existing;
        candidates.set(id, { ...primary, references: mergeReferences(primary, existing, candidate) });
      } else { candidates.set(id, candidate); }
    }
  }

  const queued = new Map<string, { candidate: Candidate; checkedAt: string }>();
  for (const [id, candidate] of candidates) {
    const old = previous.get(id);
    const retained = old && isPrimaryRelease(old) && !isPrimaryRelease(candidate) ? old : undefined;
    const primary = retained ?? candidate;
    queued.set(id, {
      candidate: { ...primary, references: old ? mergeReferences(primary, old, candidate) : candidate.references },
      checkedAt: retained?.checkedAt ?? startedAt,
    });
  }
  // Discovery limits do not expire retries or model refreshes of verified material.
  for (const [id, entry] of previous) {
    if ((entry.explanationStatus === 'pending' || needsModelRefresh(entry)) && !queued.has(id)) {
      queued.set(id, { candidate: entry, checkedAt: entry.checkedAt });
    }
  }
  for (const [id, item] of queued) {
    const context = backgroundByIdentity.get(id);
    if (!context?.length) continue;
    item.candidate = {
      ...item.candidate, references: mergeReferences(item.candidate, ...context),
      background: [...new Map(context.flatMap(candidate => candidate.background ?? [])
        .map(supplement => [supplement.url, supplement])).values()],
    };
  }

  const run: CollectionRun = {
    id: randomUUID(), startedAt, completedAt: startedAt, status: 'success',
    newEntries: 0, updatedEntries: 0, summarizedEntries: 0,
    failedSources: statuses.filter(source => source.state === 'error').map(source => source.id),
  };
  const additions: Entry[] = [];
  let current = prior;
  const wallStarted = Date.now();
  async function persist(includeRun: boolean) {
    run.completedAt = clock().toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // Only the final snapshot contains every queued candidate, including pending ones.
        const committedStatuses = includeRun ? statuses.map(source => source.id === 'codex-releases' && source.state === 'ok'
          ? {
            ...source,
            historySince: earliestHistorySince(source.historySince, new Date(historyReadSince.get(source.id)!).toISOString()),
          } : source) : statuses;
        const snapshot = merge(current.snapshot, additions, committedStatuses, run, includeRun);
        if (includeRun) {
          const incomplete = snapshot.entries.some(entry => entry.explanationStatus === 'pending' || needsModelRefresh(entry));
          run.status = sources.length > 0 && run.failedSources.length === sources.length ? 'failed'
            : run.failedSources.length || incomplete ? 'partial' : 'success';
          snapshot.runs = snapshot.runs.map(item => item.id === run.id ? { ...run } : item);
        }
        await options.store.write(snapshot, current.etag);
        current = await options.store.read();
        return;
      } catch (error) {
        if (!(error instanceof WriteConflict) || attempt === 4) throw error;
        current = await options.store.read();
      }
    }
  }
  let summariesAttempted = 0;
  // Interleave products so the initial budget always includes all three.
  const sorted = [...queued.entries()].sort((a, b) => b[1].candidate.publishedAt.localeCompare(a[1].candidate.publishedAt));
  const queues = new Map<string, typeof sorted>();
  for (const item of sorted) {
    const queue = queues.get(item[1].candidate.product) ?? [];
    queue.push(item); queues.set(item[1].candidate.product, queue);
  }
  const work: typeof sorted = [];
  while ([...queues.values()].some(queue => queue.length)) {
    for (const queue of queues.values()) { const item = queue.shift(); if (item) work.push(item); }
  }
  async function prepareEntry([id, { candidate, checkedAt }]: (typeof work)[number]): Promise<Entry> {
    const old = previous.get(id);
    const contentHash = digest(`${candidate.originalTitle}\n${candidate.originalText}`);
    const changed = old?.contentHash !== contentHash;
    if (!old) run.newEntries++;
    else if (changed) run.updatedEntries++;
    const { background, ...entrySource } = candidate;
    const entry: Entry = {
      ...entrySource, id, contentHash, firstSeenAt: old?.firstSeenAt ?? startedAt,
      checkedAt, updatedAt: changed ? startedAt : old.updatedAt,
      explanationStatus: changed ? 'pending' : old.explanationStatus,
      ...(!changed && old.explanation ? {
        explanation: old.explanation, explanationModel: old.explanationModel,
        editorialVersion: old.editorialVersion, explanationEditedAt: old.explanationEditedAt,
      } : {}),
    };
    // Ready explanations remain visible until a replacement is generated successfully.
    const needsSummary = entry.explanationStatus === 'pending' || needsModelRefresh(entry);
    if (needsSummary && summariesAttempted < (options.maxSummaries ?? 80) && Date.now() - wallStarted < 14 * 60_000) {
      summariesAttempted++;
      try {
        const supplements: Supplement[] = [...(background ?? [])];
        for (const reference of candidate.references.filter(ref => ref.kind === 'blog').slice(0, 2)) {
          try {
            const document = await options.fetchDocument(reference.url);
            await options.store.archive?.(`${candidate.sourceId}-blog`, document.body, startedAt);
            supplements.push({ url: reference.url, text: plainText(document.body).slice(0, 8000) });
          } catch {
            // Linked background reading is optional; its outage must not hide a release.
          }
        }
        entry.explanation = await options.summarize(candidate, supplements);
        entry.explanationStatus = 'ready';
        entry.explanationModel = options.modelId;
        entry.editorialVersion = options.editorialVersion;
        entry.explanationEditedAt = clock().toISOString();
        run.summarizedEntries++;
      } catch (error) {
        options.onWarning?.({ id, message: error instanceof Error ? error.message.slice(0, 220) : '해설 생성 실패' });
      }
    }
    return entry;
  }
  let checkpointSize = 0;
  for (let index = 0; index < work.length; index += summaryConcurrency) {
    const batch = await Promise.all(work.slice(index, index + summaryConcurrency).map(prepareEntry));
    additions.push(...batch);
    // Only persist after the whole batch settles; writes never compete with one another.
    if (additions.length - checkpointSize >= 5 && summariesAttempted > 0) {
      await persist(false);
      checkpointSize = additions.length;
    }
  }
  await persist(true);
  return run;
}

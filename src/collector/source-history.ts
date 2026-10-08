import { createHash } from 'node:crypto';
import type { FetchedDocument } from './official-fetch.js';
import { parseSource, type Candidate, type SourceDefinition } from './sources.js';

export interface SourceReadOptions {
  fetchDocument: (url: string) => Promise<FetchedDocument>;
  earliestPublishedAt: number;
  onDocument?: (document: FetchedDocument) => void | Promise<void>;
}

export async function readGithubHistory(source: SourceDefinition, options: SourceReadOptions): Promise<Candidate[]> {
  const base = new URL(source.fetchUrl);
  const pageSize = Number(base.searchParams.get('per_page') ?? '30');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('GitHub 페이지 크기가 올바르지 않습니다.');
  const entries: Candidate[] = [];
  const seenPages = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const url = new URL(base);
    if (page > 1) url.searchParams.set('page', String(page));
    const document = await options.fetchDocument(url.toString());
    await options.onDocument?.(document);
    const hash = createHash('sha256').update(document.body).digest('hex');
    if (seenPages.has(hash)) throw new Error('GitHub 변경 기록의 페이지가 반복됩니다.');
    seenPages.add(hash);
    const raw: unknown = JSON.parse(document.body);
    if (!Array.isArray(raw)) throw new Error('GitHub 공식 릴리스 목록을 읽지 못했습니다.');
    if (!raw.length) {
      if (page === 1) throw new Error('GitHub 공식 릴리스 목록이 비어 있습니다.');
      return entries;
    }
    entries.push(...parseSource(source, document.body));
    const publicationTimes = raw.flatMap(release => {
      const time = typeof release?.published_at === 'string' ? Date.parse(release.published_at) : NaN;
      return Number.isFinite(time) ? [time] : [];
    });
    // Use a whole older page so one backdated release cannot hide newer records after it.
    if (raw.length < pageSize || (publicationTimes.length > 0
      && publicationTimes.every(time => time < options.earliestPublishedAt))) return entries;
  }
  throw new Error('GitHub 변경 기록이 페이지 수집 한도를 넘었습니다.');
}

export async function readSourceHistory(source: SourceDefinition, options: SourceReadOptions): Promise<Candidate[] | string> {
  if (source.parser === 'github' && source.product === 'claude-code') return readGithubHistory(source, options);
  if (source.parser === 'github' && source.product === 'codex') {
    const { readCodexHistory } = await import('./codex-history.js');
    return readCodexHistory(source, options);
  }
  if (source.parser === 'kiro') {
    const { readKiroHistory } = await import('./kiro-history.js');
    return readKiroHistory(source, options);
  }
  const document = await options.fetchDocument(source.fetchUrl);
  await options.onDocument?.(document);
  return source.referenceOnly ? document.body : parseSource(source, document.body);
}

import { createHash } from 'node:crypto';
import { extractChangeItems } from '../collector/change-items.js';
import { SOURCES } from '../collector/sources.js';
import { publicEntry } from '../server/public-entry.js';
import { entryRevision } from '../shared/reading-revision.js';
import { COLLECTION_SCHEDULE } from '../shared/schedule.js';
import type { Entry, Explanation, Feed, FeedEntry, Language, SearchIndex, Snapshot, SourceStatus } from '../shared/types.js';
import type { SiteAsset } from './target.js';

export const languages = ['ko', 'en'] as const;
export const immutableCache = 'public, max-age=31536000, immutable';
export const currentCache = 'public, max-age=0, s-maxage=60, must-revalidate';
export const digest = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex');

const productNames = { 'claude-code': 'Claude Code', codex: 'Codex', kiro: 'Kiro' };

/** These are collector-authored labels, not translated official release text. */
export function sourceLabelInLanguage(label: string, language: Language, fallback = 'Official source'): string {
  if (language === 'ko' || !/[가-힣]/u.test(label)) return label;
  let translated = label;
  for (const [korean, english] of [
    ['공식 GitHub 릴리스', 'official GitHub releases'], ['공식 패치 기록', 'official patch notes'],
    ['공식 변경 기록', 'official changelog'], ['공식 릴리스', 'official releases'],
    ['공식 주간 요약', 'official weekly summary'], ['공식 블로그', 'official blog'],
    ['새 소식', "What's new"], ['한국어 주간 요약', 'Korean weekly summary'], ['한국어', 'Korean'], ['영문', 'English'],
  ]) translated = translated.replaceAll(korean, english);
  return /[가-힣]/u.test(translated) ? fallback : translated;
}

/** Complete public content, usable by the existing API and RSS as well as static delivery. */
export function publicEntryInLanguage(entry: Entry, language: Language): FeedEntry {
  const korean = publicEntry(entry);
  const readRevision = entryRevision(korean);
  const sourceItems = extractChangeItems(entry);
  let visible = korean;
  if (language === 'en') {
    const { explanationEditedAt: _editedAt, editorialVersion: _editorialVersion, ...common } = korean;
    visible = {
      ...common, explanationStatus: 'ready',
      references: common.references.map(reference => ({ ...reference,
        title: sourceLabelInLanguage(reference.title, language, `${productNames[entry.product]} official ${reference.kind}`) })),
      explanation: {
        title: entry.originalTitle,
        summary: sourceItems[0].text.replace(/\s+/g, ' ').slice(0, 280),
        whyItMatters: '', highlights: [], actionItems: [], audience: [],
        category: korean.explanation?.category ?? 'improvement', impact: korean.explanation?.impact ?? 'low',
      },
      fullChanges: {
        status: 'ready', sourceCount: sourceItems.length, formatVersion: 'official-source-v1', updatedAt: entry.updatedAt,
        items: sourceItems.map(item => ({ id: item.id, text: item.section ? `${item.section}\n\n${item.text}` : item.text })),
      },
    };
  }
  return {
    ...visible, language, contentKind: language === 'ko' ? 'explanation' : 'source', readRevision,
    changeSummary: {
      status: visible.fullChanges?.status ?? 'pending', sourceCount: sourceItems.length,
      readyCount: visible.fullChanges?.items.length ?? 0,
    },
  };
}

function compactExplanation(explanation?: Explanation): Explanation | undefined {
  return explanation ? { ...explanation, whyItMatters: '', highlights: [], actionItems: [], audience: [] } : undefined;
}

function searchText(entry: FeedEntry): string {
  return [
    productNames[entry.product], entry.channel, entry.version, entry.originalTitle,
    entry.explanation?.title, entry.explanation?.summary, entry.explanation?.whyItMatters,
    ...(entry.explanation?.highlights.flatMap(highlight => [highlight.title, highlight.detail, highlight.evidence]) ?? []),
    ...(entry.explanation?.actionItems ?? []), ...(entry.explanation?.audience ?? []),
    ...(entry.fullChanges?.items.map(item => item.text) ?? []),
  ].filter(Boolean).join(' ').normalize('NFC');
}

export interface PublicContent {
  feeds: Record<Language, Feed>;
  details: Record<Language, FeedEntry[]>;
  objects: Map<string, SiteAsset>;
}

export function buildPublicContent(snapshot: Snapshot, now = new Date()): PublicContent {
  const objects = new Map<string, SiteAsset>();
  function immutableJson(value: unknown): SiteAsset {
    const body = Buffer.from(JSON.stringify(value));
    const key = `content/objects/${digest(body)}.json`;
    const asset = { key, body, contentType: 'application/json; charset=utf-8', cacheControl: immutableCache };
    objects.set(key, asset);
    return asset;
  }
  const ids = new Set<string>();
  for (const entry of snapshot.entries) {
    if (!/^[A-Za-z0-9_-]+$/.test(entry.id) || entry.id === 'index' || ids.has(entry.id)) {
      throw new Error(`Invalid or duplicate public entry ID: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  const sourceStatuses: SourceStatus[] = snapshot.sources.length ? snapshot.sources : SOURCES.map(source => ({
    id: source.id, product: source.product, name: source.name, url: source.url, state: 'pending' as const, entryCount: 0,
  }));
  const sources = sourceStatuses.map(source => { const { error: _error, ...safe } = source; return safe; });
  const stale = sources.some(source => !source.lastSuccessAt || now.getTime() - Date.parse(source.lastSuccessAt) > 26 * 60 * 60_000);
  const ordered = [...snapshot.entries].sort((left, right) => right.publishedDate.localeCompare(left.publishedDate)
    || right.publishedAt.localeCompare(left.publishedAt) || left.id.localeCompare(right.id));
  const feeds = {} as Record<Language, Feed>;
  const details = {} as Record<Language, FeedEntry[]>;
  for (const language of languages) {
    const index: SearchIndex = { language, entries: [] };
    details[language] = [];
    const entries = ordered.map(entry => {
      const full = publicEntryInLanguage(entry, language);
      // A successful recheck changes catalog metadata, not the content-addressed body.
      const detail = { ...full, checkedAt: '' };
      const asset = immutableJson(detail);
      const { fullChanges: _fullChanges, ...summary } = full;
      const catalogEntry: FeedEntry = {
        ...summary, references: [], explanation: compactExplanation(full.explanation),
        detailUrl: `/${asset.key}`, detailBytes: asset.body.byteLength,
      };
      details[language].push({ ...full, detailUrl: catalogEntry.detailUrl, detailBytes: catalogEntry.detailBytes });
      index.entries.push({ id: entry.id, text: searchText(full) });
      return catalogEntry;
    });
    const search = immutableJson(index);
    feeds[language] = {
      language, generatedAt: snapshot.generatedAt, entries,
      sources: sources.map(source => ({ ...source, name: sourceLabelInLanguage(source.name, language, `${productNames[source.product]} official source`) })),
      latestRun: snapshot.runs[0],
      schedule: COLLECTION_SCHEDULE, stale, searchUrl: `/${search.key}`,
    };
  }
  return { feeds, details, objects };
}

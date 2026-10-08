import { load } from 'cheerio';
import type { FetchedDocument } from './official-fetch.js';
import { isOfficialUrl } from './official-fetch.js';
import { parseKiroChangelog, plainText, type Candidate, type SourceDefinition } from './sources.js';

interface HistoryOptions {
  fetchDocument: (url: string) => Promise<FetchedDocument>;
  earliestPublishedAt: number;
  onDocument?: (document: FetchedDocument) => void | Promise<void>;
}

interface PatchMetadata {
  id: string;
  version: string;
  date: string;
  url: string;
}

interface HistoryItem {
  entry: Candidate;
  patches: PatchMetadata[];
  html?: string;
  needsRecovery: boolean;
  recoveryError?: unknown;
}

const MAX_PAGES = 200;
const DETAIL_CONCURRENCY = 3;
const SECTION_TITLE = /^(?:Improvements|Fixes|Patches)(?:\s*\(\d+\))?$/i;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function officialKiroUrl(value: string): URL {
  const url = new URL(value);
  if (!isOfficialUrl(value) || url.origin !== 'https://kiro.dev' || !url.pathname.startsWith('/changelog/') || url.search) {
    throw new Error('Kiro 변경 기록 범위 밖의 주소입니다.');
  }
  return url;
}

function documentKey(value: string): string {
  const url = officialKiroUrl(value);
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

function day(value: string): string {
  const match = value.trim().match(/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?) (\d{1,2}), (\d{4})$/);
  if (!match) throw new Error('Kiro 패치의 실제 발표일을 확인할 수 없습니다.');
  const date = new Date(`${match[1]} ${match[2]}, ${match[3]} 00:00:00 GMT`);
  if (!Number.isFinite(date.getTime()) || date.getUTCDate() !== Number(match[2]) || date.getUTCFullYear() !== Number(match[3])) {
    throw new Error('Kiro 패치 발표일이 올바르지 않습니다.');
  }
  return date.toISOString().slice(0, 10);
}

function patchLinks(html: string, parent: Candidate): PatchMetadata[] {
  const $ = load(html);
  const patches = new Map<string, PatchMetadata>();
  $('a[href*="#patch-"]').each((_, anchor) => {
    if ($(anchor).closest('article').length) return;
    const url = officialKiroUrl(new URL($(anchor).attr('href')!, parent.sourceUrl).href);
    if (documentKey(url.href) !== documentKey(parent.sourceUrl)) throw new Error('Kiro 패치의 부모 기록이 일치하지 않습니다.');
    const values = $(anchor).find('span').toArray().map(span => $(span).text().trim());
    const version = values[0];
    if (!version || !/^\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?$/.test(version) || !/^#patch-[\w-]+$/.test(url.hash)) {
      throw new Error('Kiro 패치의 버전 또는 원문 위치가 올바르지 않습니다.');
    }
    patches.set(url.href, { id: url.hash.slice(1), version, date: day(values[1] ?? ''), url: url.href });
  });
  return [...patches.values()];
}

function incompleteHtml(html: string): boolean {
  const $ = load(html);
  return $('button[aria-expanded="false"], astro-island').length > 0;
}

/**
 * Read the literal React Flight data embedded by Kiro's server. JavaScript is
 * never evaluated. Only article children become inert HTML for text extraction.
 */
class FlightArticles {
  private readonly records = new Map<string, unknown>();
  private readonly byUrl = new Map<string, unknown>();
  private readonly articles: unknown[] = [];

  constructor(body: string) {
    const $ = load(body);
    const chunks: string[] = [];
    $('script').each((_, script) => {
      const match = $(script).text().trim().match(/^self\.__next_f\.push\(([\s\S]*)\);?$/);
      if (!match) return;
      const payload: unknown = JSON.parse(match[1]!);
      if (Array.isArray(payload) && payload[0] === 1 && typeof payload[1] === 'string') chunks.push(payload[1]);
    });
    const buffer = Buffer.from(chunks.join(''), 'utf8');
    let offset = 0;
    let recordCount = 0;
    while (offset < buffer.length) {
      if (buffer[offset] === 10) { offset++; continue; }
      const colon = buffer.indexOf(58, offset);
      const id = buffer.subarray(offset, colon).toString();
      // Resource hints have no record ID and contain no article content.
      if (colon === offset && buffer[colon + 1] === 72) {
        const newline = buffer.indexOf(10, colon);
        offset = newline < 0 ? buffer.length : newline + 1;
        continue;
      }
      if (colon < offset || !/^[0-9a-f]+$/i.test(id) || ++recordCount > 20_000) throw new Error('Kiro 본문 데이터의 레코드 구조가 바뀌었습니다.');
      offset = colon + 1;
      if (buffer[offset] === 84) {
        const comma = buffer.indexOf(44, offset);
        const size = buffer.subarray(offset + 1, comma).toString();
        if (comma < offset || !/^[0-9a-f]+$/i.test(size)) throw new Error('Kiro 본문의 문자열 길이가 올바르지 않습니다.');
        const end = comma + 1 + Number.parseInt(size, 16);
        if (end > buffer.length) throw new Error('Kiro 본문 데이터가 잘렸습니다.');
        this.records.set(id, buffer.subarray(comma + 1, end).toString('utf8'));
        offset = end;
      } else {
        const newline = buffer.indexOf(10, offset);
        const end = newline < 0 ? buffer.length : newline;
        const value = buffer.subarray(offset, end).toString('utf8');
        if (/^(?:\[|\{|"|-?\d|true|false|null)/.test(value)) this.records.set(id, JSON.parse(value));
        offset = end + 1;
      }
    }
    let visited = 0;
    const index = (value: unknown): void => {
      if (++visited > 300_000) throw new Error('Kiro 본문 데이터가 처리 범위를 초과했습니다.');
      if (Array.isArray(value)) {
        if (value[0] === '$' && value[1] === 'article') this.articles.push(value);
        value.forEach(index);
      } else if (isObject(value)) {
        if (typeof value.entryUrl === 'string' && value.children !== undefined) {
          const key = documentKey(new URL(value.entryUrl, 'https://kiro.dev').href);
          this.byUrl.set(key, value.children);
        }
        Object.values(value).forEach(index);
      }
    };
    this.records.forEach(index);
  }

  article(url: string, allowSingleArticle = false): string | undefined {
    const root = this.byUrl.get(documentKey(url)) ?? (allowSingleArticle && this.articles.length === 1 ? this.articles[0] : undefined);
    if (root === undefined) return undefined;
    const references = new Set<string>();
    let visited = 0;
    const render = (value: unknown, depth = 0): string => {
      if (++visited > 100_000 || depth > 150) throw new Error('Kiro 본문 데이터의 참조가 너무 깊습니다.');
      if (value === null || typeof value === 'boolean' || value === undefined) return '';
      if (typeof value === 'number') return String(value);
      if (typeof value === 'string') {
        if (value.startsWith('$$')) return escapeHtml(value.slice(1));
        if (value === '$undefined') return '';
        const ref = value.match(/^\$(?:L|@)?([0-9a-f]+)$/i);
        if (ref) {
          const id = ref[1]!;
          if (!this.records.has(id) || references.has(id)) throw new Error('Kiro 본문 참조를 확인할 수 없습니다.');
          references.add(id);
          const text = render(this.records.get(id), depth + 1);
          references.delete(id);
          return text;
        }
        if (value.startsWith('$')) throw new Error('Kiro 본문에 지원하지 않는 참조 형식이 있습니다.');
        return escapeHtml(value);
      }
      if (!Array.isArray(value)) throw new Error('Kiro 본문의 자식 데이터가 올바르지 않습니다.');
      if (value[0] !== '$') return value.map(child => render(child, depth + 1)).join('');
      const props = value[3];
      if (!isObject(props)) return '';
      const sourceTag = typeof value[1] === 'string' ? value[1] : '';
      if (/^(?:script|style|svg|nav|footer|button|input)$/i.test(sourceTag)) return '';
      const custom = !/^[a-z][a-z0-9]*$/i.test(sourceTag);
      const title = custom && typeof props.title === 'string' && SECTION_TITLE.test(props.title) ? props.title : undefined;
      const tag = custom ? (typeof props.href === 'string' ? 'a' : title ? 'section' : 'div') : sourceTag;
      const attributes = [
        typeof props.id === 'string' ? ` id="${escapeHtml(props.id)}"` : '',
        typeof props.className === 'string' ? ` class="${escapeHtml(props.className)}"` : '',
        typeof props.href === 'string' ? ` href="${escapeHtml(props.href)}"` : '',
        title ? ` data-kiro-section="${escapeHtml(title)}"` : '',
      ].join('');
      return `<${tag}${attributes}>${title ? `<h3>${escapeHtml(title)}</h3>` : ''}${render(props.children, depth + 1)}</${tag}>`;
    };
    return render(root);
  }
}

function verifyRecoveredSections(original: string, recovered: string): void {
  const originalDom = load(original);
  const recoveredDom = load(recovered);
  const expected = originalDom('button[aria-expanded="false"]').toArray().map(button => originalDom(button).text().trim()).filter(title => SECTION_TITLE.test(title));
  for (const title of expected) {
    const section = recoveredDom('[data-kiro-section]').filter((_, node) => recoveredDom(node).attr('data-kiro-section') === title).first();
    const copy = section.clone();
    copy.children('h3').first().remove();
    if (!section.length || !plainText(copy.html() ?? '')) throw new Error(`Kiro ${title} 본문을 복구할 수 없습니다.`);
  }
}

function patchCandidate(parent: Candidate, patch: PatchMetadata, html: string): Candidate {
  const $ = load(html);
  const node = $('[id]').filter((_, element) => $(element).attr('id') === patch.id).first().clone();
  const heading = node.children('p').first();
  if (!node.length || heading.find('strong').first().text().trim() !== patch.version) throw new Error('Kiro 패치 버전과 실제 본문이 일치하지 않습니다.');
  const headerDate = heading.find('span').text().replace(/^\s*\|\s*/, '').trim();
  if (day(headerDate) !== patch.date) throw new Error('Kiro 패치의 본문과 발표일이 일치하지 않습니다.');
  heading.remove();
  const originalText = plainText(node.html() ?? '');
  if (!originalText) throw new Error('Kiro 패치의 본문이 비어 있습니다.');
  const category = new URL(parent.sourceUrl).pathname.split('/')[2];
  const label = category === 'cli' || category === 'ide' ? category.toUpperCase() : category === 'crew' ? 'Crew' : category === 'web' ? 'Web' : '';
  return {
    product: parent.product, sourceId: parent.sourceId, channel: parent.channel,
    version: patch.version, originalTitle: `Kiro ${label} ${patch.version}`.replace(/\s+/g, ' '),
    publishedDate: patch.date, publishedAt: `${patch.date}T00:00:00.000Z`, datePrecision: 'day',
    sourceUrl: patch.url, originalText,
    references: [{ title: 'Kiro 공식 패치 기록', url: patch.url, kind: 'changelog' }],
  };
}

function parentText(html: string, originalTitle: string): string {
  const $ = load(html);
  const article = $('article').first();
  if (!article.length) throw new Error('Kiro 상세 기록에서 article을 찾을 수 없습니다.');
  article.find('[data-kiro-section]').filter((_, element) => /^Patches\b/i.test($(element).attr('data-kiro-section') ?? '')).remove();
  article.find('[id^="patch-"], nav, footer, button').remove();
  article.find('h1, h2, h3, h4, h5, h6, summary').filter((_, element) => /^Patches(?:\s*\(\d+\))?$/i.test($(element).text().trim())).remove();
  // Detail pages place publication metadata and adjacent-release links inside
  // article. The changelog container is the actual release body.
  const content = article.find('.changelog').first();
  const contentText = plainText(content.html() ?? '');
  if (content.length && !contentText) throw new Error('Kiro 기록의 본문이 비어 있습니다.');
  const text = content.length
    ? [originalTitle, ...article.children('p').toArray().map(paragraph => plainText($.html(paragraph))), contentText].filter(Boolean).join('\n\n')
    : plainText(article.html() ?? '');
  if (!text) throw new Error('Kiro 기록의 본문이 비어 있습니다.');
  return text;
}

function nextPage(body: string, url: string, current: number): string | undefined {
  const $ = load(body);
  const pageNumbers = new Map<number, string>();
  $('a[href]').each((_, anchor) => {
    if ($(anchor).closest('article').length) return;
    const link = new URL($(anchor).attr('href')!, url);
    const number = link.pathname.match(/^\/changelog\/page\/([1-9]\d*)\/?$/)?.[1];
    if (!number) return;
    officialKiroUrl(link.href);
    if (link.hash) throw new Error('Kiro 페이지 주소에 예상하지 못한 위치 정보가 있습니다.');
    pageNumbers.set(Number(number), link.href);
  });
  const next = pageNumbers.get(current + 1);
  if (!next && [...pageNumbers.keys()].some(number => number > current)) throw new Error('Kiro 변경 기록의 다음 페이지를 찾을 수 없습니다.');
  return next;
}

const versionKey = (entry: Pick<Candidate, 'product' | 'channel' | 'version'>) => entry.version ? `${entry.product}:${entry.channel}:${entry.version}` : undefined;

export async function readKiroHistory(source: SourceDefinition, options: HistoryOptions): Promise<Candidate[]> {
  const start = officialKiroUrl(source.fetchUrl);
  if (source.product !== 'kiro' || source.parser !== 'kiro' || start.pathname !== '/changelog/' || start.hash || !Number.isFinite(options.earliestPublishedAt)) {
    throw new Error('Kiro 과거 기록 수집 설정이 올바르지 않습니다.');
  }
  const fetchDocument = async (url: string): Promise<FetchedDocument> => {
    officialKiroUrl(url);
    const result = await options.fetchDocument(url);
    if (documentKey(result.url) !== documentKey(url)) throw new Error('Kiro 응답이 요청한 기록과 다른 주소로 이동했습니다.');
    await options.onDocument?.(result);
    return result;
  };
  const items = new Map<string, HistoryItem>();
  let url: string | undefined = source.fetchUrl;
  for (let page = 1; url; page++) {
    if (page > MAX_PAGES) throw new Error('Kiro 변경 기록이 페이지 수집 한도를 초과했습니다.');
    const document = await fetchDocument(url);
    const entries = parseKiroChangelog(document.body);
    const $ = load(document.body);
    const rows = $('[data-timeline-item]').toArray();
    let flight: FlightArticles | undefined;
    let flightRead = false;
    entries.forEach((entry, index) => {
      const key = documentKey(entry.sourceUrl);
      if (items.has(key)) return;
      const row = $(rows[index]!);
      const article = row.find('article').first();
      const patches = patchLinks($.html(row), entry).filter(patch => Date.parse(`${patch.date}T00:00:00Z`) >= options.earliestPublishedAt);
      const relevant = Date.parse(entry.publishedAt) >= options.earliestPublishedAt || patches.length > 0;
      const needsRecovery = relevant && (incompleteHtml($.html(article)) || patches.length > 0);
      let html: string | undefined = $.html(article);
      let recoveryError: unknown;
      if (needsRecovery && incompleteHtml(html)) {
        try {
          if (!flightRead) { flightRead = true; flight = new FlightArticles(document.body); }
          html = flight?.article(entry.sourceUrl);
          if (html) verifyRecoveredSections($.html(article), html);
        } catch (error) {
          html = undefined;
          recoveryError = error;
        }
      }
      items.set(key, { entry, patches, needsRecovery, html, recoveryError });
    });
    // Recent patches can belong to much older parent releases, so only the
    // final official page ends discovery. Date filtering stays with the engine.
    url = nextPage(document.body, document.url, page);
  }
  const standaloneVersions = new Set([...items.values()].map(item => versionKey(item.entry)).filter(Boolean));
  const patchEntries = new Map<string, Candidate>();
  const pending: HistoryItem[] = [];
  const finish = (item: HistoryItem, html: string): void => {
    const patches = item.patches.filter(patch => !standaloneVersions.has(versionKey({ ...item.entry, version: patch.version })));
    const candidates = patches.map(patch => patchCandidate(item.entry, patch, html));
    const text = parentText(html, item.entry.originalTitle);
    item.entry = { ...item.entry, originalText: text };
    for (const entry of candidates) if (!patchEntries.has(versionKey(entry)!)) patchEntries.set(versionKey(entry)!, entry);
  };
  for (const item of items.values()) {
    if (!item.needsRecovery) continue;
    if (item.html) {
      try { finish(item, item.html); continue; } catch (error) { item.recoveryError = error; }
    }
    pending.push(item);
  }
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, pending.length) }, async () => {
    while (!failed && next < pending.length) {
      const item = pending[next++]!;
      try {
        const document = await fetchDocument(item.entry.sourceUrl);
        const $ = load(document.body);
        const article = $('article').first();
        if (!article.length) throw new Error('Kiro 상세 기록에서 article을 찾을 수 없습니다.');
        let html = $.html(article);
        if (incompleteHtml(html)) {
          const restored = new FlightArticles(document.body).article(item.entry.sourceUrl, true);
          if (!restored) throw new Error('Kiro 상세 본문의 접힌 내용을 읽을 수 없습니다.');
          verifyRecoveredSections(html, restored);
          html = restored;
        }
        finish(item, html);
      } catch (error) {
        if (!failed) {
          failed = true;
          const detail = error instanceof Error ? error.message : String(error);
          const initial = item.recoveryError instanceof Error ? ` 목록 본문: ${item.recoveryError.message}` : '';
          failure = new Error(`Kiro 본문 보완 실패 (${item.entry.sourceUrl}): ${detail}.${initial}`, { cause: error });
        }
      }
    }
  }));
  if (failed) throw failure;
  return [...items.values()].map(item => item.entry).concat([...patchEntries.values()]);
}

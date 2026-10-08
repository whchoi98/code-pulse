import { load } from 'cheerio';
import { isOfficialBlog, isOfficialUrl, type FetchedDocument } from './official-fetch.js';
import { parseGithubReleases, plainText, type Candidate, type SourceDefinition } from './sources.js';

export interface CodexHistoryOptions {
  fetchDocument: (url: string) => Promise<FetchedDocument>;
  earliestPublishedAt: number;
  onDocument?: (document: FetchedDocument) => void | Promise<void>;
}

const API_PAGE_SIZE = 20;
const MAXIMUM_BYTES = 8 * 1024 * 1024;
const MAXIMUM_HTML_PAGES = 100;
const REQUEST_PAUSE_MS = 2000;
const RELEASES_URL = 'https://github.com/openai/codex/releases';
const API_PATH = '/repos/openai/codex/releases';
const PREVIEW_TAG = /alpha|beta|rc[.-]?\d|nightly/i;

interface ReleasePage {
  entries: Candidate[];
  detailVersions: Set<string>;
  tags: string[];
  publicationTimes: number[];
  nextUrl?: string;
  terminal: boolean;
}

function assertDocumentUrl(value: string, expected: string) {
  if (!isOfficialUrl(value)) throw new Error('Codex 공식 문서 주소가 아닙니다.');
  const actualUrl = new URL(value);
  const expectedUrl = new URL(expected);
  if (actualUrl.origin !== expectedUrl.origin || actualUrl.pathname !== expectedUrl.pathname
    || actualUrl.hash || actualUrl.searchParams.toString() !== expectedUrl.searchParams.toString()) {
    throw new Error('Codex 문서가 요청한 페이지와 다른 주소를 반환했습니다.');
  }
}

function publicationTimestamp(value: string | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('Codex 릴리스의 명시된 발표 시각을 확인할 수 없습니다.');
  }
  const timestamp = Date.parse(value);
  const day = value.slice(0, 10);
  const dayTimestamp = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || !Number.isFinite(dayTimestamp)
    || new Date(dayTimestamp).toISOString().slice(0, 10) !== day) {
    throw new Error('Codex 릴리스의 발표 시각이 올바르지 않습니다.');
  }
  return new Date(timestamp).toISOString();
}

function renderedContent(source: SourceDefinition, sourceUrl: string, html: string): Pick<Candidate, 'originalText' | 'references'> {
  const $ = load(html);
  const text = plainText(html);
  if (!text || $('include-fragment').length) throw new Error('Codex 안정판의 전체 본문을 확인할 수 없습니다.');
  const references: Candidate['references'] = [{ title: source.name, url: sourceUrl, kind: 'release' }];
  for (const anchor of $('a[href]').toArray()) {
    const link = $(anchor);
    const url = new URL(link.attr('href')!, sourceUrl).href;
    if (isOfficialBlog(url) && !references.some(reference => reference.url === url) && references.length < 4) {
      references.push({ title: link.text().trim() || '공식 블로그', url, kind: 'blog' });
    }
  }
  return { originalText: text, references };
}

function parseDetail(source: SourceDefinition, document: FetchedDocument, listing: Candidate): Candidate {
  const $ = load(document.body);
  const declaredUrls = $('meta[property="og:url"][content], link[rel~="canonical"][href]')
    .toArray().map(element => ($(element).attr('content') ?? $(element).attr('href') ?? '').trim())
    .filter(Boolean);
  if (!declaredUrls.length) throw new Error('Codex 개별 릴리스의 버전 식별 주소가 없습니다.');
  for (const declared of declaredUrls) {
    let identity: URL;
    try { identity = new URL(declared, document.url); }
    catch { throw new Error('Codex 개별 릴리스의 버전 식별 주소가 올바르지 않습니다.'); }
    if (!isOfficialUrl(identity.href) || identity.href !== listing.sourceUrl) {
      throw new Error('Codex 개별 릴리스의 식별 주소가 요청한 버전과 다릅니다.');
    }
  }
  const bodies = $('.markdown-body');
  const title = $('h1').first().text().trim();
  if (bodies.length !== 1 || !title) throw new Error('Codex 개별 릴리스의 전체 본문 구조를 확인할 수 없습니다.');
  const body = bodies.first();
  if (body.nextAll('a[href]').toArray().some(link => $(link).text().trim() === 'Read more')) {
    throw new Error('Codex 개별 릴리스의 본문도 잘려 있습니다.');
  }
  const labels = $('.Label').filter((_, label) => !$(label).closest('.markdown-body').length)
    .toArray().map(label => $(label).text().trim().toLowerCase());
  if (labels.includes('pre-release') || labels.includes('draft')) {
    throw new Error('Codex 목록과 개별 릴리스의 공개 유형이 다릅니다.');
  }
  const times = new Set($('relative-time[datetime]')
    .filter((_, time) => /\breleased\s+this\b/i.test($(time).parent().text()))
    .toArray().map(time => $(time).attr('datetime')));
  if (times.size !== 1) throw new Error('Codex 개별 릴리스의 발표 시각이 명확하지 않습니다.');
  const publishedAt = publicationTimestamp(times.values().next().value);
  return {
    ...listing, originalTitle: title, publishedAt, publishedDate: publishedAt.slice(0, 10),
    ...renderedContent(source, listing.sourceUrl, body.html() ?? ''),
  };
}

function parsePage(
  source: SourceDefinition,
  document: FetchedDocument,
  pageNumber: number,
  earliestPublishedAt: number,
  canonicalVersions: Set<string>,
): ReleasePage {
  const $ = load(document.body);
  const sections = $('section[id^="release-"]');
  if (!sections.length) throw new Error('Codex 릴리스 HTML의 페이지 구조를 확인할 수 없습니다.');
  const entries: Candidate[] = [];
  const detailVersions = new Set<string>();
  const tags: string[] = [];
  const publicationTimes: number[] = [];

  for (const element of sections.toArray()) {
    const section = $(element);
    const tag = section.attr('id')!.slice('release-'.length);
    if (!tag || tags.includes(tag)) throw new Error('Codex 릴리스 페이지에 중복되거나 비어 있는 태그가 있습니다.');
    tags.push(tag);
    const labels = section.find('.Label').toArray().map(label => $(label).text().trim().toLowerCase());
    if (labels.includes('draft')) continue;

    // Asset dates and commit popovers also contain relative-time elements.
    // Only the explicitly labeled release publication time is authoritative.
    const publishedTime = section.find('relative-time[datetime]')
      .filter((_, time) => /\breleased\s+this\b/i.test($(time).parent().text()))
      .first().attr('datetime');
    const publishedAt = publicationTimestamp(publishedTime);
    const timestamp = Date.parse(publishedAt);
    publicationTimes.push(timestamp);
    if (timestamp < earliestPublishedAt || labels.includes('pre-release') || PREVIEW_TAG.test(tag)) continue;

    const version = tag.replace(/^(?:rust-)?v/, '');
    if (canonicalVersions.has(version)) continue;
    const headerLink = section.find('a[href]').filter((_, anchor) => {
      try {
        const url = new URL($(anchor).attr('href')!, document.url);
        return isOfficialUrl(url.href) && url.origin === 'https://github.com'
          && url.pathname.startsWith('/openai/codex/releases/tag/')
          && decodeURIComponent(url.pathname.slice('/openai/codex/releases/tag/'.length)) === tag
          && !url.search && !url.hash;
      } catch { return false; }
    }).first();
    if (!headerLink.length || !headerLink.text().trim()) throw new Error('Codex 안정판의 공식 제목과 주소를 확인할 수 없습니다.');
    const sourceUrl = new URL(headerLink.attr('href')!, document.url).href;
    const renderedBody = section.find('.markdown-body').first();
    if (!renderedBody.length || renderedBody.find('include-fragment').length) {
      throw new Error(`Codex 안정판 ${version}의 본문을 HTML에서 확인할 수 없습니다.`);
    }
    const moreLinks = renderedBody.nextAll('a[href]').filter((_, anchor) => $(anchor).text().trim() === 'Read more');
    if (moreLinks.length) {
      if (moreLinks.toArray().some(anchor => new URL($(anchor).attr('href')!, document.url).href !== sourceUrl)) {
        throw new Error('Codex 전체 본문 링크가 원래 릴리스와 다릅니다.');
      }
      detailVersions.add(version);
    }
    entries.push({
      product: 'codex', sourceId: source.id, channel: tag.startsWith('python-v') ? 'general' : 'cli', version,
      originalTitle: headerLink.text().trim(),
      publishedAt, publishedDate: publishedAt.slice(0, 10), datePrecision: 'timestamp',
      sourceUrl, ...renderedContent(source, sourceUrl, renderedBody.html() ?? ''),
    });
  }
  if (!publicationTimes.length) throw new Error('Codex 페이지에서 공개된 릴리스의 발표 시각을 확인할 수 없습니다.');

  const pagination = $('.pagination, .paginate-container');
  const nextUrls = new Set(pagination.find('a[rel="next"][href]').toArray()
    .map(anchor => new URL($(anchor).attr('href')!, document.url).href));
  if (nextUrls.size > 1) throw new Error('Codex 릴리스의 다음 페이지 주소가 서로 다릅니다.');
  const nextUrl = nextUrls.values().next().value as string | undefined;
  const terminal = pagination.find('.next_page[aria-disabled="true"], .next_page.disabled')
    .toArray().some(element => $(element).text().trim().toLowerCase() === 'next');
  if (nextUrl) {
    const parsed = new URL(nextUrl);
    if (!isOfficialUrl(nextUrl) || parsed.origin !== 'https://github.com'
      || parsed.pathname !== '/openai/codex/releases' || parsed.hash
      || parsed.searchParams.getAll('page').length !== 1
      || [...parsed.searchParams.keys()].some(key => key !== 'page')
      || parsed.searchParams.get('page') !== String(pageNumber + 1) || terminal) {
      throw new Error('Codex 릴리스의 다음 페이지가 올바르게 진행하지 않습니다.');
    }
  } else if (!terminal) {
    throw new Error('Codex 릴리스의 마지막 페이지인지 확인할 수 없습니다.');
  }
  return { entries, detailVersions, tags, publicationTimes, nextUrl, terminal };
}

export async function readCodexHistory(source: SourceDefinition, options: CodexHistoryOptions): Promise<Candidate[]> {
  if (source.product !== 'codex' || source.parser !== 'github' || source.url !== RELEASES_URL
    || !isOfficialUrl(source.fetchUrl) || !Number.isFinite(options.earliestPublishedAt)) {
    throw new Error('Codex 과거 기록의 출처 또는 시작 시각이 올바르지 않습니다.');
  }
  const apiUrl = new URL(source.fetchUrl);
  if (apiUrl.origin !== 'https://api.github.com' || apiUrl.pathname !== API_PATH
    || apiUrl.searchParams.get('per_page') !== String(API_PAGE_SIZE)
    || (apiUrl.searchParams.has('page') && apiUrl.searchParams.get('page') !== '1')) {
    throw new Error('Codex 최신 API는 첫 페이지 20개로 요청해야 합니다.');
  }
  let htmlRequests = 0;
  const readDocument = async (url: string) => {
    if (!isOfficialUrl(url)) throw new Error('Codex 공식 페이지 주소가 아닙니다.');
    if (new URL(url).hostname === 'github.com') {
      if (htmlRequests > 0) await new Promise(resolve => setTimeout(resolve, REQUEST_PAUSE_MS));
      htmlRequests++;
    }
    const document = await options.fetchDocument(url);
    assertDocumentUrl(document.url, url);
    if (Buffer.byteLength(document.body, 'utf8') > MAXIMUM_BYTES) {
      throw new Error('Codex 공식 자료가 수집 용량 제한을 초과했습니다.');
    }
    await options.onDocument?.(document);
    return document;
  };

  const apiDocument = await readDocument(source.fetchUrl);
  const apiEntries = parseGithubReleases(apiDocument.body, source);
  const apiRows = JSON.parse(apiDocument.body) as { tag_name: string }[];
  const apiRecordCount = apiRows.length;
  const byVersion = new Map<string, Candidate>();
  // API visibility decisions also cover drafts, previews and empty bodies.
  // An older stable HTML page must never revive one of these known tags.
  const canonicalVersions = new Set(apiRows.map(release => release.tag_name.replace(/^(?:rust-)?v/, '')));
  for (const entry of apiEntries) {
    const key = entry.version ?? entry.sourceUrl;
    byVersion.set(key, entry);
  }
  const result = () => [...byVersion.values()].sort((left, right) =>
    Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || left.sourceUrl.localeCompare(right.sourceUrl));
  if (apiRecordCount < API_PAGE_SIZE) return result();

  const seenTags = new Set<string>();
  let olderPages = 0;
  let nextUrl = `${RELEASES_URL}?page=1`;
  for (let pageNumber = 1; pageNumber <= MAXIMUM_HTML_PAGES; pageNumber++) {
    const document = await readDocument(nextUrl);
    const page = parsePage(source, document, pageNumber, options.earliestPublishedAt, canonicalVersions);
    if (page.tags.every(tag => seenTags.has(tag))) throw new Error('Codex 릴리스 페이지의 내용이 진행하지 않습니다.');
    page.tags.forEach(tag => seenTags.add(tag));
    for (const entry of page.entries) {
      const key = entry.version ?? entry.sourceUrl;
      if (!byVersion.has(key)) {
        const candidate = page.detailVersions.has(key)
          ? parseDetail(source, await readDocument(entry.sourceUrl), entry)
          : entry;
        byVersion.set(key, candidate);
      }
    }
    // Publication times are not strictly ordered within the GitHub list.
    // Require two whole older pages, including prereleases, before stopping.
    olderPages = page.publicationTimes.every(time => time < options.earliestPublishedAt) ? olderPages + 1 : 0;
    if (olderPages >= 2) return result();
    if (pageNumber === MAXIMUM_HTML_PAGES) break;
    if (page.terminal) return result();
    nextUrl = page.nextUrl!;
  }
  throw new Error('Codex HTML의 100페이지 한도 안에서 요청한 날짜 범위를 확인하지 못했습니다.');
}

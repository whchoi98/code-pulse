import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import type { Channel, ProductId, SourceReference } from '../shared/types.js';
import { isOfficialBlog, isOfficialUrl } from './official-fetch.js';
import { CLAUDE_CHANGELOG_URL, CLAUDE_WHATS_NEW_URL, parseClaudeChangelog, parseClaudeWhatsNew } from './claude-docs.js';

export interface SourceDefinition {
  id: string;
  product: ProductId;
  name: string;
  url: string;
  fetchUrl: string;
  parser: 'github' | 'codex-rss' | 'kiro' | 'claude-changelog' | 'claude-whats-new';
  referenceOnly?: boolean;
}

export interface Candidate {
  product: ProductId;
  sourceId: string;
  channel: Channel;
  originalTitle: string;
  version?: string;
  publishedAt: string;
  publishedDate: string;
  datePrecision: 'day' | 'timestamp';
  sourceUrl: string;
  originalText: string;
  references: SourceReference[];
  /** Short-lived background for explanation generation; never stored or exposed by the API. */
  background?: { url: string; text: string }[];
}

export const SOURCES: SourceDefinition[] = [
  {
    id: 'claude-releases', product: 'claude-code', name: 'Claude Code 공식 릴리스',
    url: 'https://github.com/anthropics/claude-code/releases',
    fetchUrl: 'https://api.github.com/repos/anthropics/claude-code/releases?per_page=100',
    parser: 'github',
  },
  {
    id: 'codex-releases', product: 'codex', name: 'Codex 공식 GitHub 릴리스',
    url: 'https://github.com/openai/codex/releases',
    fetchUrl: 'https://api.github.com/repos/openai/codex/releases?per_page=20',
    parser: 'github',
  },
  {
    id: 'codex-changelog', product: 'codex', name: 'Codex 공식 변경 기록',
    url: 'https://developers.openai.com/codex/changelog/',
    fetchUrl: 'https://developers.openai.com/codex/changelog/rss.xml',
    parser: 'codex-rss',
  },
  {
    id: 'kiro-changelog', product: 'kiro', name: 'Kiro 공식 변경 기록',
    url: 'https://kiro.dev/changelog/',
    fetchUrl: 'https://kiro.dev/changelog/',
    parser: 'kiro',
  },
  {
    id: 'claude-changelog', product: 'claude-code', name: 'Claude Code 공식 변경 기록 (영문)',
    url: CLAUDE_CHANGELOG_URL, fetchUrl: CLAUDE_CHANGELOG_URL, parser: 'claude-changelog',
  },
  {
    id: 'claude-whats-new', product: 'claude-code', name: 'Claude Code 새 소식 (한국어 주간 요약)',
    url: CLAUDE_WHATS_NEW_URL, fetchUrl: CLAUDE_WHATS_NEW_URL, parser: 'claude-whats-new', referenceOnly: true,
  },
];

const githubSchema = z.array(z.object({
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  body: z.string().nullable(),
  prerelease: z.boolean(),
  draft: z.boolean(),
  published_at: z.string().nullable(),
  html_url: z.string().url(),
}));

function timestamp(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error('공식 자료에서 발표일을 확인할 수 없습니다.');
  return date.toISOString();
}

export function plainText(html: string): string {
  const $ = load(html);
  $('script, style, svg, nav, footer, .anchor-link, .copied-indicator').remove();
  $('p, li, h1, h2, h3, h4, br, pre').each((_, el) => { $(el).prepend('\n'); $(el).append('\n'); });
  return $.root().text().replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function blogReferences(text: string, base: string): SourceReference[] {
  const $ = load(text);
  const links: SourceReference[] = [];
  $('a[href]').each((_, element) => {
    const url = new URL($(element).attr('href')!, base).toString();
    if (isOfficialBlog(url)) links.push({ title: $(element).text().trim() || '공식 블로그', url, kind: 'blog' });
  });
  for (const match of text.matchAll(/https:\/\/[^\s<>"')\]]+/g)) {
    const url = match[0].replace(/[.,;]+$/, '');
    if (isOfficialBlog(url)) links.push({ title: '공식 블로그', url, kind: 'blog' });
  }
  return [...new Map(links.map(link => [link.url, link])).values()].slice(0, 3);
}

export function parseGithubReleases(body: string, source: SourceDefinition): Candidate[] {
  const releases = githubSchema.parse(JSON.parse(body));
  if (!releases.length) throw new Error('공식 릴리스 목록이 비어 있습니다.');
  return releases
    .filter(release => !release.draft && !release.prerelease && !/alpha|beta|rc[.-]?\d|nightly/i.test(release.tag_name) && Boolean(release.body?.trim()))
    .map(release => {
      const sourceUrl = release.html_url;
      if (!isOfficialUrl(sourceUrl) || !sourceUrl.startsWith(`${source.url}/tag/`)) {
        throw new Error('공식 저장소 밖의 릴리스 주소입니다.');
      }
      const publishedAt = timestamp(release.published_at ?? '');
      const text = (release.body ?? '').trim();
      if (!text) throw new Error('공식 릴리스의 변경 내용이 비어 있습니다.');
      const channel: Channel = source.product === 'codex' && release.tag_name.startsWith('python-v') ? 'general' : 'cli';
      return {
        product: source.product, sourceId: source.id, channel,
        originalTitle: release.name || release.tag_name,
        version: release.tag_name.replace(/^(?:rust-)?v/, ''),
        publishedAt, publishedDate: publishedAt.slice(0, 10), datePrecision: 'timestamp' as const,
        sourceUrl, originalText: text,
        references: [{ title: source.name, url: sourceUrl, kind: 'release' as const }, ...blogReferences(text, sourceUrl)],
      };
    });
}

export function parseCodexFeed(body: string): Candidate[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw new Error('허용하지 않는 XML 선언입니다.');
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
  const parsed = parser.parse(body);
  const rawItems = parsed?.rss?.channel?.item;
  if (!rawItems) throw new Error('공식 RSS에서 변경 기록을 찾을 수 없습니다.');
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  return items.flatMap((item: Record<string, string>) => {
    const title = item.title ?? '';
    const content = item['content:encoded'] || item.description || '';
    const text = /<(?:p|h\d|ul|li|div|br)\b/i.test(content) ? plainText(content) : content;
    // The official endpoint now carries ChatGPT articles as well. A Codex
    // URL prefix alone is insufficient because legacy anchors remain there.
    if (!/\bcodex\b/i.test(`${title}\n${text}`)) return [];
    const sourceUrl = item.link;
    if (!sourceUrl || !isOfficialUrl(sourceUrl)) throw new Error('공식 RSS의 원문 주소를 확인할 수 없습니다.');
    const publishedAt = timestamp(item.pubDate);
    const channel: Channel = /cli|command.line/i.test(title) ? 'cli'
      : /app|macos|windows|ios|android|mobile|desktop/i.test(title) ? 'app'
        : /web|cloud/i.test(title) ? 'web' : 'general';
    const version = channel === 'cli' ? title.match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/)?.[1] : undefined;
    if (version && /alpha|beta|rc[.-]?\d|nightly/i.test(version)) return [];
    return [{
      product: 'codex' as const, sourceId: 'codex-changelog', channel,
      originalTitle: title, version, publishedAt, publishedDate: publishedAt.slice(0, 10),
      datePrecision: 'day' as const, sourceUrl, originalText: text,
      references: [{ title: 'Codex 공식 변경 기록', url: sourceUrl, kind: 'changelog' as const }, ...blogReferences(content, sourceUrl)],
    }];
  });
}

export function parseKiroChangelog(body: string): Candidate[] {
  const $ = load(body);
  const rows = $('[data-timeline-item]');
  if (!rows.length) throw new Error('Kiro 변경 기록의 문서 구조를 확인할 수 없습니다.');
  const entries: Candidate[] = [];
  rows.each((_, row) => {
    const element = $(row);
    const article = element.find('article').first();
    const link = article.find('a[href^="/changelog/"]').first();
    const href = link.attr('href');
    const originalTitle = link.find('h2').first().text().trim();
    const date = element.find('time').first().attr('datetime') || element.find('time').first().text().trim();
    if (!href || !originalTitle || !date) throw new Error('Kiro 변경 기록의 제목, 주소 또는 발표일이 없습니다.');
    const sourceUrl = new URL(href, 'https://kiro.dev').toString();
    if (!isOfficialUrl(sourceUrl)) throw new Error('Kiro 공식 원문 주소가 아닙니다.');
    const publishedAt = timestamp(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : `${date} 00:00:00 GMT`);
    const channel: Channel = href.includes('/cli/') ? 'cli' : href.includes('/ide/') ? 'ide'
      : href.includes('/web/') ? 'web' : 'general';
    const version = element.find('span').toArray().map(span => $(span).text().trim())
      .find(text => /^\d+\.\d+(?:\.\d+)?$/.test(text));
    const html = article.html() ?? '';
    const originalText = plainText(html);
    if (originalText.length < originalTitle.length + 10) throw new Error('Kiro 변경 기록의 본문이 비어 있습니다.');
    entries.push({
      product: 'kiro', sourceId: 'kiro-changelog', channel, version,
      originalTitle, publishedAt, publishedDate: publishedAt.slice(0, 10), datePrecision: 'day',
      sourceUrl, originalText,
      references: [{ title: 'Kiro 공식 변경 기록', url: sourceUrl, kind: 'changelog' }, ...blogReferences(html, sourceUrl)],
    });
  });
  return entries;
}

export function parseSource(source: SourceDefinition, body: string, known: Candidate[] = []): Candidate[] {
  if (source.parser === 'github') return parseGithubReleases(body, source);
  if (source.parser === 'codex-rss') return parseCodexFeed(body);
  if (source.parser === 'claude-changelog') return parseClaudeChangelog(body);
  if (source.parser === 'claude-whats-new') return parseClaudeWhatsNew(body, known);
  return parseKiroChangelog(body);
}

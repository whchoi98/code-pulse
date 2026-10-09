import { isOfficialUrl } from '../collector/official-fetch.js';
import type { FeedEntry, Language, ProductId } from '../shared/types.js';

const PRODUCT_NAMES: Record<ProductId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  kiro: 'Kiro',
};

export function resolvePublicBaseUrl(configured: string | undefined): string {
  const production = process.env.NODE_ENV === 'production';
  if (configured === undefined && production) throw new Error('PUBLIC_BASE_URL is required in production.');
  const value = configured ?? 'http://localhost:8080';
  try {
    const url = new URL(value);
    if (/[\u0000-\u0020\u007f\\]/u.test(value)
      || !['http:', 'https:'].includes(url.protocol)
      || (production && url.protocol !== 'https:')
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Invalid canonical URL.');
    }
    return url.href;
  } catch {
    // Configuration may contain credentials. Do not include its value in errors.
    throw new Error('PUBLIC_BASE_URL must be a root HTTP(S) URL without credentials, query or fragment. Production requires HTTPS.');
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '\uFFFD')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function entryUrl(baseUrl: string, id: string, language: Language): string {
  const url = new URL(baseUrl);
  url.searchParams.set('entry', id);
  url.searchParams.set('lang', language);
  return url.href;
}

function itemXml(entry: FeedEntry, baseUrl: string, language: Language): string {
  const en = language === 'en';
  const explanation = entry.explanation!;
  const link = entryUrl(baseUrl, entry.id, language);
  // Preserve the identity already stored by existing Korean subscribers.
  const guid = new URL(link);
  if (language === 'ko') guid.searchParams.delete('lang');
  const published = new Date(entry.publishedAt);
  const precision = entry.datePrecision === 'day' ? en ? 'Publication time not provided' : '발표 시각 미제공' : published.toISOString();
  const sourceUrl = isOfficialUrl(entry.sourceUrl) ? new URL(entry.sourceUrl).href : undefined;
  // Escape text and attributes for HTML first, then encode that complete HTML
  // as XML text. This also keeps source text such as "]]>" out of CDATA syntax.
  const description = [
    `<p><strong>${en ? 'Official English release notes' : 'AI 해설'}</strong></p>`,
    `<p>${en ? 'Published' : '원문 발표일'}: ${escapeXml(entry.publishedDate)} (${escapeXml(precision)})</p>`,
    `<p>${escapeXml(explanation.summary)}</p>`,
    ...(explanation.whyItMatters ? [`<p>${escapeXml(explanation.whyItMatters)}</p>`] : []),
    ...(entry.fullChanges ? [
      `<h3>${en ? `All changes (${entry.fullChanges.sourceCount})` : `전체 변경 사항 (${entry.fullChanges.sourceCount}개)`}</h3>`,
      ...(entry.fullChanges.status !== 'ready'
        ? [`<p>${en ? `${entry.fullChanges.items.length} of ${entry.fullChanges.sourceCount} changes are available.` : `전체 ${entry.fullChanges.sourceCount}개 중 ${entry.fullChanges.items.length}개의 한국어 설명을 준비했습니다.`}</p>`] : []),
      `<ol>${entry.fullChanges.items.map(item => `<li>${escapeXml(item.text)}</li>`).join('')}</ol>`,
    ] : []),
    `<p><a href="${escapeXml(link)}">${en ? 'Read all changes' : '해설 전체 읽기'}</a>${sourceUrl
      ? ` | <a href="${escapeXml(sourceUrl)}">${en ? 'Official source' : '공식 원문'}</a>` : ''}</p>`,
  ].join('');
  return [
    '    <item>',
    `      <title>${escapeXml(`${PRODUCT_NAMES[entry.product]}: ${explanation.title}`)}</title>`,
    `      <link>${escapeXml(link)}</link>`,
    `      <guid isPermaLink="true">${escapeXml(guid.href)}</guid>`,
    `      <pubDate>${published.toUTCString()}</pubDate>`,
    `      <category>${escapeXml(PRODUCT_NAMES[entry.product])}</category>`,
    `      <description>${escapeXml(description)}</description>`,
    '    </item>',
  ].join('\n');
}

export function renderRss(
  entries: readonly FeedEntry[],
  options: { publicBaseUrl: string; now: Date; product?: ProductId; language?: Language },
): string {
  const { publicBaseUrl, now, product, language = 'ko' } = options;
  const selected = entries.filter(entry =>
    entry.explanationStatus === 'ready' && entry.explanation
    && (!product || entry.product === product)
    && Number.isFinite(Date.parse(entry.publishedAt)) && Date.parse(entry.publishedAt) <= now.getTime(),
  ).sort((left, right) =>
    Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  ).slice(0, 50);
  const channelUrl = new URL(publicBaseUrl);
  const feedUrl = new URL('/feed.xml', publicBaseUrl);
  if (product) {
    channelUrl.searchParams.set('product', product);
    feedUrl.searchParams.set('product', product);
  }
  channelUrl.searchParams.set('lang', language);
  if (language === 'en') {
    feedUrl.searchParams.set('lang', 'en');
  }
  const title = language === 'en' ? `Code Pulse | ${product ? PRODUCT_NAMES[product] : 'Coding tools'} changelog`
    : product ? `Code Pulse | ${PRODUCT_NAMES[product]} 변경 기록` : 'Code Pulse | 코딩 도구의 변경 기록';
  const description = language === 'en'
    ? `Official English changes for ${product ? PRODUCT_NAMES[product] : 'Claude Code, Codex and Kiro'}. Includes complete change lists from the latest 50 records.`
    : `${product ? PRODUCT_NAMES[product] : 'Claude Code, Codex, Kiro'}의 공식 변경 기록을 정리한 한국어 AI 해설입니다. 해설이 준비된 최근 글을 최대 50개 제공합니다.`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(title)}</title>`,
    `    <link>${escapeXml(channelUrl.href)}</link>`,
    `    <description>${escapeXml(description)}</description>`,
    `    <language>${language}</language>`,
    `    <atom:link href="${escapeXml(feedUrl.href)}" rel="self" type="application/rss+xml" />`,
    ...selected.map(entry => itemXml(entry, publicBaseUrl, language)),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

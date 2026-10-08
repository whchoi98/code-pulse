import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { load } from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

// Run against an already running server with its published, fully prepared data:
// node tools/verify-full-changes-browser.mjs [baseURL] [outputDirectory]
assert.ok(process.argv.length <= 4, 'Usage: verify-full-changes-browser.mjs [baseURL] [outputDirectory]');
const suppliedBase = new URL(process.argv[2] ?? 'http://127.0.0.1:4198');
assert.ok(['http:', 'https:'].includes(suppliedBase.protocol) && !suppliedBase.username && !suppliedBase.password
  && suppliedBase.pathname === '/' && !suppliedBase.search && !suppliedBase.hash,
'The base URL must be a root HTTP(S) URL without credentials, query or fragment.');
const base = suppliedBase.origin;
const output = resolve(process.argv[3] ?? 'docs/screenshots/full-local');
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const products = ['claude-code', 'codex', 'kiro'];
const fullKeys = ['formatVersion', 'items', 'sourceCount', 'status', 'updatedAt'];
const itemKeys = ['id', 'text'];
const report = { startedAt: new Date().toISOString(), base, version, status: 'running', checks: [], samples: [] };
const browserErrors = { pageErrors: 0, consoleErrors: 0 };
let browser;
let page;

function requireThat(condition, message) {
  // Do not attach the inspected API object or original bodies to error reports.
  if (!condition) throw new Error(message);
}

function sameValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pageUrl(params = {}) {
  const url = new URL('/', base);
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

async function getResource(path, contentType) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000) });
  requireThat(response.status === 200, `${path} returned HTTP ${response.status}.`);
  requireThat(new URL(response.url).origin === base, `${path} redirected to a different origin.`);
  requireThat((response.headers.get('content-type') ?? '').includes(contentType), `${path} has an unexpected content type.`);
  return response.text();
}

function validateInventory(entries) {
  requireThat(Array.isArray(entries) && entries.length > 0, 'The public feed has no entries.');
  requireThat(new Set(entries.map(entry => entry.id)).size === entries.length, 'The public feed contains duplicate entry IDs.');
  const totals = Object.fromEntries(products.map(product => [product, { records: 0, items: 0 }]));
  for (const entry of entries) {
    const full = entry.fullChanges;
    requireThat(typeof entry.id === 'string' && entry.id.length > 0 && products.includes(entry.product), 'An entry has an invalid public identity.');
    requireThat(full && typeof full === 'object' && !Array.isArray(full), `${entry.id}: full changes are absent.`);
    requireThat(sameValues(Object.keys(full).sort(), fullKeys), `${entry.id}: full changes do not match the allowed public fields.`);
    requireThat(full.status === 'ready', `${entry.id}: full changes are still pending.`);
    requireThat(typeof full.formatVersion === 'string' && full.formatVersion.length > 0
      && typeof full.updatedAt === 'string' && Number.isFinite(Date.parse(full.updatedAt)), `${entry.id}: full-change metadata is invalid.`);
    requireThat(Number.isInteger(full.sourceCount) && full.sourceCount > 0
      && Array.isArray(full.items) && full.items.length === full.sourceCount, `${entry.id}: full-change counts do not match.`);
    for (const item of full.items) {
      requireThat(item && typeof item === 'object' && !Array.isArray(item)
        && sameValues(Object.keys(item).sort(), itemKeys), `${entry.id}: an item has unexpected public fields.`);
      requireThat(typeof item.id === 'string' && item.id.trim().length > 0
        && typeof item.text === 'string' && item.text.trim().length > 0, `${entry.id}: an item is empty or invalid.`);
    }
    requireThat(new Set(full.items.map(item => item.id)).size === full.sourceCount, `${entry.id}: full changes contain duplicate item IDs.`);
    totals[entry.product].records++;
    totals[entry.product].items += full.sourceCount;
  }
  for (const product of products) requireThat(totals[product].records > 0, `${product}: no public entries are available.`);
  return { records: entries.length, items: Object.values(totals).reduce((sum, value) => sum + value.items, 0), products: totals };
}

function publicationOrder(left, right) {
  return Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

async function verifyRss(entries, exemplar) {
  const now = Date.now();
  const eligible = entries.filter(entry => entry.explanationStatus === 'ready' && entry.explanation
    && Number.isFinite(Date.parse(entry.publishedAt)) && Date.parse(entry.publishedAt) <= now).sort(publicationOrder);
  const results = await Promise.all(['all', ...products].map(async product => {
    const path = `/feed.xml${product === 'all' ? '' : `?product=${product}`}`;
    const xml = await getResource(path, 'application/rss+xml');
    requireThat(XMLValidator.validate(xml) === true, `${path}: RSS is not valid XML.`);
    const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false }).parse(xml);
    const channel = parsed.rss?.channel;
    requireThat(channel && typeof channel.link === 'string', `${path}: RSS channel is missing.`);
    const channelLink = new URL(channel.link);
    const selfLink = new URL(channel['atom:link']?.['@_href']);
    requireThat(channelLink.origin === base && selfLink.origin === base
      && !channelLink.username && !channelLink.password && !selfLink.username && !selfLink.password,
    `${path}: RSS channel or self-link does not use the requested public origin.`);
    requireThat(channelLink.pathname === '/' && selfLink.pathname === '/feed.xml'
      && channelLink.searchParams.get('product') === (product === 'all' ? null : product)
      && selfLink.searchParams.get('product') === (product === 'all' ? null : product), `${path}: RSS channel or self-link targets the wrong feed.`);
    const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    const expected = eligible.filter(entry => product === 'all' || entry.product === product).slice(0, 50);
    requireThat(items.length === expected.length, `${path}: RSS does not contain the expected latest 50 eligible records.`);
    let fullItemCount = 0;
    let exemplarCount = null;
    const entryIds = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const entry = expected[index];
      const link = new URL(item.link);
      requireThat(link.origin === base && !link.username && !link.password && link.pathname === '/'
        && link.searchParams.get('entry') === entry.id, `${path}: RSS item ${index + 1} has an incorrect entry link or publication order.`);
      requireThat(typeof item.description === 'string', `${path}: RSS item ${index + 1} has no description.`);
      const html = load(item.description);
      const changes = html('ol > li');
      requireThat(html('ol').length === 1 && changes.length === entry.fullChanges.sourceCount,
        `${path}: ${entry.id} does not contain every full-change item.`);
      requireThat(sameValues(changes.toArray().map(element => html(element).text()), entry.fullChanges.items.map(change => change.text)),
        `${path}: ${entry.id} has changed, missing or reordered full-change text.`);
      const notice = html('body > p').toArray().map(element => html(element).text()).join('\n');
      requireThat(!/전체\s+\d+개\s+중\s+\d+개|전체 변경 사항[^\n]*준비 중/u.test(notice), `${path}: ${entry.id} still has a partial-list notice.`);
      entryIds.push(entry.id);
      fullItemCount += changes.length;
      if (entry.id === exemplar.id) exemplarCount = changes.length;
    }
    if (product === 'all' || product === 'claude-code') {
      requireThat(exemplarCount === 56, `${path}: Claude Code 2.1.293 must appear with all 56 changes.`);
    }
    return [product, { url: new URL(path, base).href, items: items.length, fullItems: fullItemCount, exemplarItems: exemplarCount, entryIds }];
  }));
  return Object.fromEntries(results);
}

function inlineExpectation(text) {
  // Match complete delimiter runs independently of the component's token scan.
  // An unmatched first delimiter leaves the remaining source text literal.
  const span = /^([^`]*)(`+)(?!`)([\s\S]*?)(?<!`)\2(?!`)/u;
  let rest = text;
  let plain = '';
  const codes = [];
  for (let match = span.exec(rest); match; match = span.exec(rest)) {
    plain += match[1] + match[3];
    codes.push(match[3]);
    rest = rest.slice(match[0].length);
  }
  return { text: plain + rest, codes };
}

async function navigate(url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  requireThat(response?.status() === 200 && new URL(page.url()).origin === base, 'The browser did not load the requested public origin successfully.');
}

async function verifyDetail(entry, name) {
  const url = pageUrl({ entry: entry.id });
  await navigate(url);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(entry.explanation?.title ?? entry.originalTitle, { timeout: 20_000 });
  await expect(page.getByText('짧은 요약', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '주요 변경 요약', exact: true })).toBeVisible();
  const section = page.getByRole('region', { name: '전체 변경 사항', exact: true });
  const rows = section.locator('ol > .full-change-item');
  await expect(rows).toHaveCount(entry.fullChanges.sourceCount, { timeout: 20_000 });
  await expect(section.getByText(`총 ${entry.fullChanges.sourceCount}개`, { exact: true })).toBeVisible();
  await expect(section.locator('.full-changes-pending')).toHaveCount(0);
  const rendered = await rows.evaluateAll(elements => elements.map(element => ({
    text: element.textContent,
    codes: [...element.querySelectorAll('code')].map(code => code.textContent),
  })));
  const expected = entry.fullChanges.items.map(item => inlineExpectation(item.text));
  requireThat(sameValues(rendered, expected), `${entry.id}: rendered rows or inline code labels differ from the public items.`);
  requireThat(await section.locator('ol').evaluate(element => getComputedStyle(element).listStyleType) === 'decimal', `${entry.id}: full changes are not numbered.`);
  const codes = section.locator('code');
  const codeLabels = expected.reduce((sum, item) => sum + item.codes.length, 0);
  if (codeLabels > 0) {
    await codes.first().scrollIntoViewIfNeeded();
    await expect(codes.first()).toBeInViewport();
  }
  await section.getByRole('heading').scrollIntoViewIfNeeded();
  await rows.first().scrollIntoViewIfNeeded();
  await expect(rows.first()).toBeInViewport();
  await page.screenshot({ path: join(output, `${name}-desktop.png`) });
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows.last()).toBeInViewport();
  await page.screenshot({ path: join(output, `${name}-tail.png`) });
  return { product: entry.product, id: entry.id, version: entry.version ?? null, url,
    sourceCount: entry.fullChanges.sourceCount, renderedCount: rendered.length, codeLabels,
    firstAndLastVisible: true, screenshots: [`${name}-desktop.png`, `${name}-tail.png`] };
}

function tailQuery(entry) {
  const lower = value => value.normalize('NFC').toLocaleLowerCase();
  const explanation = entry.explanation;
  const overview = lower([entry.originalTitle, entry.version, explanation?.title, explanation?.summary,
    explanation?.whyItMatters, ...(explanation?.actionItems ?? []), ...(explanation?.audience ?? []),
    ...(explanation?.highlights.flatMap(item => [item.title, item.detail, item.evidence]) ?? [])].join('\n'));
  const texts = entry.fullChanges.items.map(item => lower(item.text));
  function candidate(query) {
    if (/[\r\n]/u.test(query)) return null;
    const normalized = lower(query);
    const matches = texts.flatMap((text, index) => text.includes(normalized) ? [index + 1] : []);
    return !overview.includes(normalized) && matches.length > 0 && matches.every(number => number > 20)
      ? { query, itemNumbers: matches, absentFromOverviewAndFirst20: true } : null;
  }
  for (const preferred of ['Add a repository', 'GitHub 쓰기 권한']) {
    const chosen = candidate(preferred);
    if (chosen) return { ...chosen, preferred: true };
  }
  for (const item of entry.fullChanges.items.toReversed()) {
    const words = [...item.text.matchAll(/\S+/gu)];
    for (const width of [6, 5, 4, 3, 2]) {
      for (let start = 0; start + width <= words.length; start++) {
        const end = words[start + width - 1];
        const phrase = item.text.slice(words[start].index, end.index + end[0].length);
        if (phrase.length < 8 || phrase.length > 100 || !/[가-힣]/u.test(phrase)) continue;
        const chosen = candidate(phrase);
        if (chosen) return { ...chosen, preferred: false };
      }
    }
  }
  throw new Error('Claude Code 2.1.293 has no usable phrase confined to its full-list tail.');
}

function markdownLiteral(value) {
  const unescaped = value.replace(/\\([^\r\n])/gu, '$1');
  return load(`<div>${unescaped}</div>`)('div').text();
}

function normalizedText(value) {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

async function verifySearchAndExport(entry) {
  const search = tailQuery(entry);
  await navigate(pageUrl({ product: 'claude-code' }));
  await page.getByRole('searchbox', { name: '변경 기록 검색', exact: true }).fill(search.query);
  await expect(page.getByRole('heading', { name: /찾은 변경 기록/u })).toBeVisible();
  const card = page.locator(`[data-testid="entry-card"][data-entry-id=${JSON.stringify(entry.id)}]`);
  const more = page.getByRole('button', { name: /^변경 기록 더 보기/u });
  while (await card.count() === 0 && await more.count() > 0) {
    const before = await page.getByTestId('entry-card').count();
    await more.click();
    await expect.poll(() => page.getByTestId('entry-card').count()).toBeGreaterThan(before);
  }
  await expect(card).toBeVisible({ timeout: 20_000 });
  requireThat(new URL(page.url()).searchParams.get('q') === search.query, 'The search phrase did not reach the browser filters.');
  await card.getByRole('link').click();
  await expect(page.locator('.full-change-item')).toHaveCount(56, { timeout: 20_000 });
  await page.getByRole('button', { name: '글 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '저장 해제', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await navigate(pageUrl({ saved: '1', product: 'claude-code' }));
  await expect(page.getByText('현재 필터에 맞는 저장 글 1개', { exact: true })).toBeVisible({ timeout: 20_000 });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Markdown 내보내기', exact: true }).click();
  const download = await downloading;
  requireThat(/^code-pulse-saved-\d{4}-\d{2}-\d{2}\.md$/u.test(download.suggestedFilename()), 'The saved export has an unexpected filename.');
  await download.saveAs(join(output, 'saved-export.md'));
  requireThat(await download.failure() === null, 'The actual Markdown download failed.');
  const markdown = await readFile(join(output, 'saved-export.md'), 'utf8');
  const sections = markdown.split(/^### 전체 변경 사항\s*$/mu);
  requireThat(sections.length === 2, 'The Markdown export does not contain exactly one full-change section.');
  const numbered = [...sections[1].matchAll(/^(\d+)\. (.*)$/gmu)];
  requireThat(numbered.length === 56 && numbered.every((match, index) => Number(match[1]) === index + 1), 'The Markdown export is missing numbered items 1 through 56.');
  requireThat(numbered.every((match, index) => normalizedText(markdownLiteral(match[2])) === normalizedText(entry.fullChanges.items[index].text)),
    'The Markdown export does not preserve every item, including item 56.');
  const summary = markdown.match(/^### 짧은 요약\s*\n+(.+)$/mu)?.[1];
  requireThat(summary && normalizedText(markdownLiteral(summary)) === normalizedText(entry.explanation.summary), 'The Markdown export lost the short overview.');
  requireThat(markdown.includes(pageUrl({ entry: entry.id })) && markdown.includes(entry.sourceUrl), 'The Markdown export lost its article or official source link.');
  requireThat(!/전체 변경 사항[^\n]*준비 중|전체\s+\d+개\s+중\s+\d+개/u.test(sections[1]), 'The Markdown export still claims partial coverage.');
  return { search: { ...search, entryId: entry.id, found: true }, markdown: { entryId: entry.id, savedEntries: 1,
    numberedItems: numbered.length, lastItemPresent: true, file: 'saved-export.md', suggestedFilename: download.suggestedFilename() } };
}

async function verifyMobile(entry) {
  await page.setViewportSize({ width: 320, height: 844 });
  await navigate(pageUrl({ entry: entry.id }));
  await page.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const section = page.getByRole('region', { name: '전체 변경 사항', exact: true });
  const rows = section.locator('.full-change-item');
  await expect(rows).toHaveCount(56, { timeout: 20_000 });
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
    && document.body.scrollWidth <= innerWidth
    && [...document.querySelectorAll('.full-change-item')].every(element => {
      const rect = element.getBoundingClientRect();
      const content = document.createRange();
      content.selectNodeContents(element);
      // Cloned inline-code padding can extend into the list's own gutter.
      // Check the visible viewport and every rendered fragment instead.
      return rect.left >= 0 && rect.right <= innerWidth
        && [...content.getClientRects()].every(fragment => fragment.left >= 0 && fragment.right <= innerWidth);
    }));
  await section.getByRole('heading').scrollIntoViewIfNeeded();
  await rows.first().scrollIntoViewIfNeeded();
  await expect(rows.first()).toBeInViewport();
  await expect.poll(fits).toBe(true);
  await page.screenshot({ path: join(output, 'claude-v2.1.293-mobile-dark.png') });
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows.last()).toBeInViewport();
  await expect.poll(fits).toBe(true);
  await page.screenshot({ path: join(output, 'claude-v2.1.293-mobile-tail.png') });
  return { width: 320, theme: 'dark', renderedItems: 56, horizontalOverflow: false, firstAndLastVisible: true,
    screenshots: ['claude-v2.1.293-mobile-dark.png', 'claude-v2.1.293-mobile-tail.png'] };
}

await mkdir(output, { recursive: true });
try {
  let feed;
  try { feed = JSON.parse(await getResource('/api/feed', 'application/json')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('The public feed is not valid JSON.');
    throw error;
  }
  report.coverage = validateInventory(feed.entries);
  report.checks.push('Every public record is complete with matching positive counts, unique item IDs and only allowed full-change fields.');
  const candidates = feed.entries.filter(entry => entry.product === 'claude-code' && entry.version === '2.1.293');
  requireThat(candidates.length === 1, 'Exactly one Claude Code 2.1.293 record is required.');
  const exemplar = candidates[0];
  requireThat(exemplar.fullChanges.sourceCount === 56, 'Claude Code 2.1.293 must contain exactly 56 changes.');
  const largest = product => feed.entries.filter(entry => entry.product === product && entry.explanationStatus === 'ready' && entry.explanation)
    .sort((left, right) => right.fullChanges.sourceCount - left.fullChanges.sourceCount || publicationOrder(left, right))[0];
  const codex = largest('codex');
  const kiro = largest('kiro');
  requireThat(exemplar.explanationStatus === 'ready' && exemplar.explanation && codex && kiro, 'The three detail samples must have ready short explanations.');
  requireThat(codex.fullChanges.sourceCount > 20, 'The largest Codex sample must exercise more than 20 full-change items.');
  report.rss = await verifyRss(feed.entries, exemplar);
  report.checks.push('All four RSS feeds are valid XML, use the requested origin, match the latest 50 records and preserve every ordered change.');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, colorScheme: 'light', reducedMotion: 'reduce', acceptDownloads: true });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', () => { browserErrors.pageErrors++; });
  page.on('console', message => { if (message.type() === 'error') browserErrors.consoleErrors++; });
  for (const [entry, name] of [[exemplar, 'claude-v2.1.293'], [codex, 'codex'], [kiro, 'kiro']]) {
    report.samples.push(await verifyDetail(entry, name));
  }
  report.checks.push('Claude Code 2.1.293 and the largest Codex/Kiro samples render every numbered item and preserve inline code, with first/last scrolling evidence.');
  Object.assign(report, await verifySearchAndExport(exemplar));
  report.checks.push('A phrase confined to items after 20 finds Claude Code 2.1.293, and its actual saved Markdown download contains all 56 items, overview and official link.');
  const footerVersion = page.getByRole('button', { name: `서비스 변경 기록, 버전 ${version}`, exact: true });
  await footerVersion.scrollIntoViewIfNeeded();
  await expect(footerVersion).toHaveText(`v${version}`);
  await expect(footerVersion).toBeInViewport();
  report.mobile = await verifyMobile(exemplar);
  report.checks.push('The footer matches package.json and all 56 items fit the 320px dark layout without horizontal overflow.');
  requireThat(browserErrors.pageErrors === 0 && browserErrors.consoleErrors === 0, 'The browser reported page or console errors.');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  // Keep diagnostics concise and avoid dumping fetched objects or browser logs.
  report.failure = error instanceof Error ? error.message.split('\n')[0] : 'Verification failed.';
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (browserErrors.pageErrors > 0 || browserErrors.consoleErrors > 0) {
    report.status = 'failed';
    report.failure ??= 'The browser reported page or console errors.';
    process.exitCode = 1;
  }
  report.browserErrors = browserErrors;
  report.checkedAt = new Date().toISOString();
  await writeFile(join(output, 'full-changes-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, base, version, records: report.coverage?.records,
    items: report.coverage?.items, report: join(output, 'full-changes-report.json'), failure: report.failure }));
}

import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Feed, FeedEntry, FullChanges } from '../../src/shared/types';
import { fullChangesFixture } from '../fixtures/full-changes';
import { entries, feed, mockApi } from './fixtures';

function fullEntry(fullChanges: FullChanges | undefined = fullChangesFixture()): FeedEntry {
  const { originalText: _text, contentHash: _hash, explanationModel: _model, ...entry } = entries[1];
  if (!fullChanges) return entry;
  const { sourceHash: _sourceHash, model: _fullModel, ...publicFullChanges } = fullChanges;
  return { ...entry, fullChanges: publicFullChanges };
}

async function useEntries(page: Page, records: FeedEntry[]) {
  const response: Feed = { ...feed, entries: records };
  await mockApi(page, response);
  await page.route('**/api/entries/*', route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    const entry = records.find(record => record.id === id);
    return entry
      ? route.fulfill({ json: { ...entry, originalText: '', contentHash: '' } })
      : route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
}

function section(page: Page) { return page.getByRole('region', { name: '전체 변경 사항', exact: true }); }

test('shows all 56 numbered changes and keeps the overview explicitly separate', async ({ page }) => {
  const entry = fullEntry();
  await useEntries(page, [entry]);
  await page.goto(`/?entry=${entry.id}`);
  const items = section(page).locator('ol > .full-change-item');
  await expect(items).toHaveCount(56);
  await expect(page.getByText('짧은 요약', { exact: true })).toBeVisible();
  await expect(page.getByText(entry.explanation!.summary, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '주요 변경 요약', exact: true })).toBeVisible();
  await expect(section(page).getByText('총 56개', { exact: true })).toBeVisible();
  await expect(items.first()).toHaveText('첫 번째 변경: 작업 공간 설정을 유지합니다.');
  await expect(items.first()).toBeVisible();
  await items.last().scrollIntoViewIfNeeded();
  await expect(items.last()).toHaveText('마지막 변경: 잔여세션정리 오류를 고쳤습니다.');
  await expect(items.last()).toBeInViewport();
  await expect(page.getByRole('link', { name: '공식 원문 읽기', exact: true })).toHaveAttribute('href', entry.sourceUrl);
  await section(page).getByRole('heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/code-pulse-full-changes-desktop.png' });
});

test('searches item 56 and restores the matching saved list after keyboard navigation', async ({ page }) => {
  const entry = fullEntry();
  await useEntries(page, [entry, entries[2]]);
  await page.goto('/');
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: '변경 기록 검색' })).toBeFocused();
  await page.keyboard.type('잔여세션정리');
  const card = page.getByTestId('entry-card');
  await expect(card).toHaveCount(1);
  const link = card.getByRole('link');
  await link.focus();
  const scroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(section(page).locator('.full-change-item')).toHaveCount(56);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '공식 원문 읽기', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '글 저장', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '저장 해제', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const back = page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true });
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(link).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll);
  await expect(card).toHaveCount(1);
  await expect(card.getByText('읽음', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /저장한 글 보기/ }).click();
  await expect(card).toHaveCount(1);
});

for (const available of [0, 24]) {
  test(`shows an honest pending state with ${available} of 56 items`, async ({ page }) => {
    const entry = fullEntry(fullChangesFixture({ status: 'pending', items: fullChangesFixture().items.slice(0, available) }));
    await useEntries(page, [entry]);
    await page.goto(`/?entry=${entry.id}`);
    await expect(section(page).getByText(`56개 중 ${available}개 준비`, { exact: true })).toBeVisible();
    await expect(section(page).getByRole('status')).toContainText('준비 중');
    await expect(section(page).locator('.full-change-item')).toHaveCount(available);
    await expect(section(page).getByText('총 56개', { exact: true })).toHaveCount(0);
    await expect(page.getByText(entry.explanation!.summary, { exact: true })).toBeVisible();
  });
}

test('shows legacy summaries without claiming that they cover every change', async ({ page }) => {
  const { fullChanges: _full, ...entry } = fullEntry();
  await useEntries(page, [entry]);
  await page.goto(`/?entry=${entry.id}`);
  await expect(section(page).getByRole('status')).toContainText('준비 중');
  await expect(section(page).locator('.full-change-item')).toHaveCount(0);
  await expect(section(page)).not.toContainText('총 0개');
  await expect(page.getByText(entry.explanation!.summary, { exact: true })).toBeVisible();
});

test('announces unfinished full lists and includes them in the pending filter', async ({ page }) => {
  const ready = { ...fullEntry(), id: 'full-ready' };
  const pending = { ...fullEntry(fullChangesFixture({ status: 'pending' })), id: 'full-pending' };
  const incomplete = { ...fullEntry(fullChangesFixture({ items: fullChangesFixture().items.slice(0, 55) })), id: 'full-incomplete' };
  const legacy = { ...fullEntry(), id: 'legacy-ready', fullChanges: undefined };
  await useEntries(page, [ready, pending, incomplete, legacy]);
  await page.goto('/');
  const status = page.getByRole('status', { name: '자료 상태' });
  await expect(status).toContainText('일부 글의 전체 변경 사항 해설을 준비하고 있습니다.');
  await expect(status).not.toContainText('한국어 해설이 없습니다');
  await page.getByLabel('변경 종류').selectOption('pending');
  await expect(page.getByTestId('entry-card')).toHaveCount(2);
  expect(await page.getByTestId('entry-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-entry-id'))))
    .toEqual(['full-incomplete', 'full-pending']);
  await useEntries(page, [ready, legacy]);
  await page.goto('/');
  await expect(page.getByTestId('entry-card')).toHaveCount(2);
  await expect(status).toHaveCount(0);
});

test('keeps the missing-summary notice when both the summary and full list are pending', async ({ page }) => {
  const entry: FeedEntry = {
    ...fullEntry(fullChangesFixture({ status: 'pending', items: [] })),
    explanationStatus: 'pending', explanation: undefined,
  };
  await useEntries(page, [entry]);
  await page.goto('/');
  const status = page.getByRole('status', { name: '자료 상태' });
  await expect(status).toContainText('일부 글은 아직 한국어 해설이 없습니다.');
  await expect(status).not.toContainText('일부 글의 전체 변경 사항 해설을 준비하고 있습니다.');
  await page.getByLabel('변경 종류').selectOption('pending');
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
});

test('does not claim completion when a ready list is missing its last item', async ({ page }) => {
  const entry = fullEntry(fullChangesFixture({ items: fullChangesFixture().items.slice(0, 55) }));
  await useEntries(page, [entry]);
  await page.goto(`/?entry=${entry.id}`);
  await expect(section(page).getByRole('status')).toContainText('준비 중');
  await expect(section(page).getByText('56개 중 55개 준비', { exact: true })).toBeVisible();
  await expect(section(page).locator('.full-change-item')).toHaveCount(55);
});

test('renders full items as safe text with inline code and no executable HTML or links', async ({ page }) => {
  const fullChanges = fullChangesFixture({ sourceCount: 2, items: [
    { id: 'code', text: '설정 `--workspace-dir`를 확인하세요.\n여러 줄의 설명도 유지합니다.' },
    { id: 'unsafe', text: '<img src=x onerror="alert(1)"> [이동](javascript:alert(1)) <script>alert(1)</script>' },
  ] });
  const entry = fullEntry(fullChanges);
  await useEntries(page, [entry]);
  await page.goto(`/?entry=${entry.id}`);
  await expect(section(page).locator('code')).toHaveText('--workspace-dir');
  await expect(section(page).locator('.full-change-item').last()).toHaveText(fullChanges.items[1].text);
  await expect(section(page).locator('img, script, a[href^="javascript:"]')).toHaveCount(0);
});

test('keeps literal backticks inside inline code with matching delimiter runs', async ({ page }) => {
  const fullChanges = fullChangesFixture({ sourceCount: 4, items: [
    { id: 'command', text: '명령 예제에 ``echo `pwd` `` 표기를 추가했습니다.' },
    { id: 'triple', text: '예제 ```before ``literal`` after```를 보존합니다.' },
    { id: 'html', text: '예제 ``<img src=x onerror="alert(1)"> `literal` ``를 확인하세요.' },
    { id: 'multiple', text: '단일 `--mode`와 ``echo `pwd` ``를 함께 확인합니다.' },
  ] });
  const entry = fullEntry(fullChanges);
  await useEntries(page, [entry]);
  await page.goto(`/?entry=${entry.id}`);
  const items = section(page).locator('.full-change-item');
  await expect(items).toHaveCount(4);
  await expect(items.first()).toHaveJSProperty('textContent', '명령 예제에 echo `pwd`  표기를 추가했습니다.');
  await expect(section(page).locator('code')).toHaveCount(5);
  expect(await section(page).locator('code').allTextContents()).toEqual([
    'echo `pwd` ', 'before ``literal`` after', '<img src=x onerror="alert(1)"> `literal` ',
    '--mode', 'echo `pwd` ',
  ]);
  await expect(section(page).locator('img, script')).toHaveCount(0);
});

test('keeps unmatched and differently sized backtick delimiters literal', async ({ page }) => {
  const fullChanges = fullChangesFixture({ sourceCount: 4, items: [
    { id: 'unclosed-double', text: '미완성 ``echo `pwd` 표기를 그대로 표시합니다.' },
    { id: 'different-lengths', text: '짝이 다른 ``설정```을 그대로 표시합니다.' },
    { id: 'unclosed-single', text: '닫히지 않은 `설정을 그대로 표시합니다.' },
    { id: 'bare-delimiter', text: '구분자만 있는 ````' },
  ] });
  const entry = fullEntry(fullChanges);
  await useEntries(page, [entry]);
  await page.goto(`/?entry=${entry.id}`);
  const items = section(page).locator('.full-change-item');
  await expect(items).toHaveCount(4);
  expect(await items.allTextContents()).toEqual(fullChanges.items.map(item => item.text));
  await expect(section(page).locator('code')).toHaveCount(0);
});

test('a full-list timestamp refresh stays read but a changed last item becomes unread', async ({ page }) => {
  const entry = fullEntry();
  await useEntries(page, [entry]);
  await page.goto(`/?entry=${entry.id}`);
  await expect(page.getByRole('button', { name: '읽지 않음으로 표시', exact: true })).toBeVisible();
  await useEntries(page, [fullEntry(fullChangesFixture({ updatedAt: '2026-10-08T00:00:00Z', formatVersion: 'test-v2' }))]);
  await page.goto('/');
  await expect(page.getByTestId('entry-card').getByText('읽음', { exact: true })).toBeVisible();
  const revised = fullEntry(fullChangesFixture({ items: fullChangesFixture().items.map(item => item.id === 'change-56'
    ? { ...item, text: '마지막 변경의 적용 범위를 바로잡았습니다.' } : item) }));
  await useEntries(page, [revised]);
  await page.reload();
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  await expect(page.getByTestId('entry-card').getByText('읽음', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '읽지 않은 글만', exact: true }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
});

test('downloads all 56 changes from the matching saved record', async ({ page }) => {
  const entry = fullEntry();
  await useEntries(page, [entry]);
  await page.addInitScript(id => localStorage.setItem('code-pulse-saved', JSON.stringify([id])), entry.id);
  await page.goto('/?saved=1&q=잔여세션정리');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Markdown 내보내기', exact: true }).click();
  const content = await readFile((await (await downloadPromise).path())!, 'utf8');
  expect(content).toContain('총 56개');
  expect(content.match(/^\d+\. /gm)).toHaveLength(56);
  expect(content).toContain('1. 첫 번째 변경: 작업 공간 설정을 유지합니다.');
  expect(content).toContain('56. 마지막 변경: 잔여세션정리 오류를 고쳤습니다.');
  expect(content).toContain(entry.explanation!.summary);
  expect(content).toContain(entry.sourceUrl);
});

test('all 56 items remain readable at 320px in dark mode with long code', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const entry = fullEntry(fullChangesFixture({ items: fullChangesFixture().items.map(item => item.id === 'change-2'
    ? { ...item, text: `설정 \`--workspace-${'long-option-'.repeat(24)}\`를 유지합니다.` } : item) }));
  await useEntries(page, [entry]);
  await page.goto(`/?entry=${entry.id}`);
  await page.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(section(page).locator('.full-change-item')).toHaveCount(56);
  await section(page).getByRole('heading').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/code-pulse-full-changes-mobile-dark.png' });
  await section(page).locator('.full-change-item').last().scrollIntoViewIfNeeded();
  await expect(section(page).locator('.full-change-item').last()).toBeInViewport();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

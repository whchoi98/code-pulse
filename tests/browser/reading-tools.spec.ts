import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Entry, Feed } from '../../src/shared/types';
import { entries, feed, mockApi, presence } from './fixtures';

const latest = entries[1];
const middle: Entry = {
  ...latest,
  id: 'claude-middle',
  originalTitle: 'Claude Code 2.0.10',
  version: '2.0.10',
  publishedAt: '2026-10-04T12:00:00Z',
  publishedDate: '2026-10-04',
  updatedAt: '2026-10-08T00:00:00Z',
  explanation: { ...latest.explanation!, title: '지침을 확인하고 이어서 작업하세요' },
};

async function useEntries(page: Page, records: Entry[]) {
  const response: Feed = {
    ...feed,
    entries: records.map(({ originalText: _text, contentHash: _hash, explanationModel: _model, ...entry }) => entry),
  };
  await page.route('**/api/feed', route => route.fulfill({ json: response }));
  await page.route('**/api/entries/*', route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    const entry = records.find(record => record.id === id);
    return entry ? route.fulfill({ json: entry }) : route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
}

function card(page: Page, id: string) {
  return page.locator(`[data-testid="entry-card"][data-entry-id="${id}"]`);
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('reading a ready detail persists and unread filtering keeps pending explanations', async ({ page }) => {
  await page.goto('/');
  await card(page, latest.id).getByRole('link').click();
  await expect(page.getByRole('article', { name: latest.explanation!.title })).toBeVisible();
  await page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true }).click();
  await expect(card(page, latest.id).getByText('읽음', { exact: true })).toBeVisible();
  await page.reload();
  await expect(card(page, latest.id).getByText('읽음', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '읽지 않은 글만', exact: true }).click();
  await expect(page).toHaveURL(/unread=1/);
  await expect(page.getByTestId('entry-card')).toHaveCount(3);
  await expect(card(page, latest.id)).toHaveCount(0);
  await card(page, 'claude-older').getByRole('link').click();
  await expect(page.getByRole('heading', { name: '한국어 해설을 준비하고 있습니다.' })).toBeVisible();
  await expect(page.getByRole('button', { name: /읽지 않음으로 표시|읽음으로 표시/ })).toHaveCount(0);
  await page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true }).click();
  await expect(card(page, 'claude-older')).toBeVisible();
  await expect(card(page, 'claude-older').getByText('읽음', { exact: true })).toHaveCount(0);
});

test('checking sources again preserves read state while revised visible content becomes unread', async ({ page }) => {
  await page.goto(`/?entry=${latest.id}`);
  await expect(page.getByRole('button', { name: '읽지 않음으로 표시', exact: true })).toBeVisible();
  await useEntries(page, entries.map(entry => ({
    ...entry,
    checkedAt: '2026-10-08T00:00:00Z',
    explanationEditedAt: '2026-10-08T00:00:00Z',
  })));
  await page.goto('/');
  await expect(card(page, latest.id).getByText('읽음', { exact: true })).toBeVisible();
  const revised: Entry = {
    ...latest,
    explanationEditedAt: '2026-10-08T00:00:00Z',
    explanation: { ...latest.explanation!, summary: '지침 미리 보기의 적용 조건을 추가로 확인할 수 있습니다.' },
  };
  await useEntries(page, entries.map(entry => entry.id === latest.id ? revised : entry));
  await page.reload();
  await expect(card(page, latest.id)).toBeVisible();
  await expect(card(page, latest.id).getByText('읽음', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '읽지 않은 글만', exact: true }).click();
  await expect(card(page, latest.id)).toBeVisible();
});

test('manual unread survives unrelated detail updates and is read again only after reopening', async ({ page }) => {
  await page.goto(`/?entry=${latest.id}`);
  await page.getByRole('button', { name: '읽지 않음으로 표시', exact: true }).click();
  await expect(page.getByRole('button', { name: '읽음으로 표시', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '글 저장', exact: true }).click();
  await page.getByRole('button', { name: '다크 모드로 전환' }).click();
  await expect(page.getByRole('button', { name: '읽음으로 표시', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true }).click();
  await expect(card(page, latest.id)).toBeVisible();
  await expect(card(page, latest.id).getByText('읽음', { exact: true })).toHaveCount(0);
  await card(page, latest.id).getByRole('link').click();
  await expect(page.getByRole('button', { name: '읽지 않음으로 표시', exact: true })).toBeVisible();
});

test('failed adjacent details never re-mark the previous detail or the failed record as read', async ({ page }) => {
  await page.route('**/api/entries/claude-older', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
  await page.goto('/');
  await card(page, latest.id).getByRole('link').click();
  await page.getByRole('button', { name: '읽지 않음으로 표시', exact: true }).click();
  await page.getByRole('navigation', { name: '같은 제품의 변경 기록' }).getByRole('link', { name: /이전 발표/ }).click();
  await expect(page.getByRole('alert')).toContainText('글을 불러오지 못했습니다');
  await page.getByRole('button', { name: '목록으로 돌아가기', exact: true }).click();
  await expect(card(page, latest.id)).toBeVisible();
  await expect(card(page, 'claude-older')).toBeVisible();
  await expect(card(page, latest.id).getByText('읽음', { exact: true })).toHaveCount(0);
  await expect(card(page, 'claude-older').getByText('읽음', { exact: true })).toHaveCount(0);
});

test('an unfinished detail response does not mark a record read', async ({ page }) => {
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/entries/claude-latest', async route => {
    await hold;
    await route.fulfill({ json: latest }).catch(() => {});
  });
  await page.goto('/');
  await card(page, latest.id).getByRole('link').click();
  await expect(page.getByRole('status', { name: '불러오는 중' })).toBeVisible();
  await page.goBack();
  release();
  await expect(card(page, latest.id)).toBeVisible();
  await expect(card(page, latest.id).getByText('읽음', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(card(page, latest.id)).toBeVisible();
  await expect(card(page, latest.id).getByText('읽음', { exact: true })).toHaveCount(0);
});

for (const outcome of ['failed', 'abandoned'] as const) {
  test(`reopening the same unread entry does not reuse its old ready response when the new request is ${outcome}`, async ({ page }) => {
    await page.goto('/');
    await card(page, latest.id).getByRole('link').click();
    await page.getByRole('button', { name: '읽지 않음으로 표시', exact: true }).click();
    await page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true }).click();
    await expect(card(page, latest.id)).toBeVisible();
    await expect(card(page, latest.id).getByText('읽음', { exact: true })).toHaveCount(0);

    let release: () => void = () => {};
    const hold = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/entries/claude-latest', async route => {
      await hold;
      await route.fulfill({ status: 503, json: { error: 'unavailable' } }).catch(() => {});
    });
    await card(page, latest.id).getByRole('link').click();
    await expect(page.getByRole('status', { name: '불러오는 중' })).toBeVisible();
    await expect(page.getByRole('article', { name: latest.explanation!.title })).toHaveCount(0);

    if (outcome === 'failed') {
      release();
      await expect(page.getByRole('alert')).toContainText('글을 불러오지 못했습니다');
      await page.getByRole('button', { name: '목록으로 돌아가기', exact: true }).click();
    } else {
      await page.goBack();
      release();
    }
    await expect(card(page, latest.id)).toBeVisible();
    await expect(card(page, latest.id).getByText('읽음', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(card(page, latest.id)).toBeVisible();
    await expect(card(page, latest.id).getByText('읽음', { exact: true })).toHaveCount(0);
  });
}

test('unread combines with product, dates, category, search, and saved filters in the URL', async ({ page }) => {
  await useEntries(page, [...entries, middle]);
  await page.addInitScript(ids => localStorage.setItem('code-pulse-saved', JSON.stringify(ids)), [latest.id, middle.id, 'kiro-day']);
  await page.goto(`/?entry=${latest.id}`);
  await expect(page.getByRole('button', { name: '읽지 않음으로 표시', exact: true })).toBeVisible();
  await page.goto('/?product=claude-code&category=feature&q=지침&from=2026-10-01&to=2026-10-08&saved=1&unread=1');
  await expect(page.getByRole('button', { name: '읽지 않은 글만', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  await expect(card(page, middle.id)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  await page.getByRole('button', { name: '선택한 필터 모두 지우기' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/?saved=1');
  await expect(page.getByTestId('entry-card')).toHaveCount(3);
});

test('adjacent publication links stay within the product and restore the original list focus', async ({ page }) => {
  await useEntries(page, [...entries, middle]);
  await page.goto('/?product=claude-code');
  const originalLink = card(page, middle.id).getByRole('link');
  await originalLink.scrollIntoViewIfNeeded();
  const listScroll = await page.evaluate(() => window.scrollY);
  await originalLink.click();
  const navigation = page.getByRole('navigation', { name: '같은 제품의 변경 기록' });
  const older = navigation.getByRole('link', { name: /이전 발표/ });
  const newer = navigation.getByRole('link', { name: /다음 발표/ });
  await expect(older).toContainText('2026.09.29');
  await expect(older).toContainText('Claude Code 2.0.9');
  await expect(newer).toContainText('2026.10.07');
  await expect(newer).toHaveAttribute('href', '?product=claude-code&entry=claude-latest');
  await older.click();
  await expect(page.getByRole('article', { name: 'Claude Code 2.0.9' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: /이전 발표/ })).toHaveCount(0);
  await navigation.getByRole('link', { name: /다음 발표/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: middle.explanation!.title })).toBeFocused();
  await page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/?product=claude-code');
  await expect(page.getByTestId('entry-card')).toHaveCount(3);
  await expect(originalLink).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(listScroll);
});

test('middle-clicking an adjacent anchor opens a new tab and a lone product has no adjacent links', async ({ page, context }) => {
  await context.route('**/api/feed', route => route.fulfill({ json: feed }));
  await context.route('**/api/entries/claude-older', route => route.fulfill({ json: entries[3] }));
  await context.route('**/api/presence', route => route.fulfill({ json: presence }));
  await page.goto(`/?entry=${latest.id}`);
  const adjacent = page.getByRole('navigation', { name: '같은 제품의 변경 기록' }).getByRole('link', { name: /이전 발표/ });
  await expect(adjacent).toHaveAttribute('href', '?entry=claude-older');
  const newTabPromise = context.waitForEvent('page');
  await adjacent.click({ button: 'middle' });
  const newTab = await newTabPromise;
  await expect(newTab).toHaveURL('http://127.0.0.1:4173/?entry=claude-older');
  await expect(newTab.getByRole('article', { name: entries[3].originalTitle })).toBeVisible();
  await expect(page).toHaveURL(`http://127.0.0.1:4173/?entry=${latest.id}`);
  await newTab.close();
  await page.goto('/?entry=kiro-day');
  await expect(page.getByRole('article', { name: entries[0].explanation!.title })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '같은 제품의 변경 기록' })).toHaveCount(0);
});

test('RSS offers all products and selectable canonical URLs when copying is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } },
    });
  });
  await page.goto('/?product=codex&q=승인&unread=1');
  const trigger = page.getByRole('button', { name: 'RSS 구독', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'RSS 구독' });
  const select = dialog.getByLabel('구독할 제품', { exact: true });
  const address = dialog.getByRole('textbox', { name: '구독 주소', exact: true });
  await expect(select).toHaveValue('codex');
  for (const product of ['all', 'claude-code', 'codex', 'kiro']) {
    await select.selectOption(product);
    const expected = `http://127.0.0.1:4173/feed.xml${product === 'all' ? '' : `?product=${product}`}`;
    await expect(address).toHaveValue(expected);
    await expect(dialog.getByRole('link', { name: 'RSS 피드 열기' })).toHaveAttribute('href', expected);
  }
  await dialog.getByRole('button', { name: '구독 주소 복사', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('직접 복사');
  await expect(address).toHaveAttribute('readonly', '');
  await expect(address).toBeFocused();
  await expect.poll(() => address.evaluate(input => {
    const element = input as HTMLInputElement;
    return element.selectionEnd! - element.selectionStart!;
  })).toBe('http://127.0.0.1:4173/feed.xml?product=kiro'.length);
  for (let index = 0; index < 7; index += 1) {
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('RSS copies the selected subscription without search or saved filters', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?saved=1&q=개선');
  await page.getByRole('button', { name: 'RSS 구독', exact: true }).click();
  await page.getByLabel('구독할 제품', { exact: true }).selectOption('claude-code');
  await page.getByRole('button', { name: '구독 주소 복사', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('http://127.0.0.1:4173/feed.xml?product=claude-code');
});

test('Markdown downloads every matching saved entry beyond the first visible page', async ({ page }) => {
  const exported = Array.from({ length: 23 }, (_, index): Entry => ({
    ...latest,
    id: `export-${index.toString().padStart(2, '0')}`,
    explanation: { ...latest.explanation!, title: `내보내기 기록 ${index.toString().padStart(2, '0')}` },
  }));
  const unsaved = { ...latest, id: 'not-saved', explanation: { ...latest.explanation!, title: '내보내기 제외 기록' } };
  await useEntries(page, [...exported, unsaved, entries[2]]);
  await page.addInitScript(ids => localStorage.setItem('code-pulse-saved', JSON.stringify(ids)), [...exported.map(entry => entry.id), entries[2].id]);
  await page.goto('/?saved=1&product=claude-code&q=내보내기');
  await expect(page.getByTestId('entry-card')).toHaveCount(20);
  await expect(page.getByText('현재 필터에 맞는 저장 글 23개', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Markdown 내보내기', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  const content = await readFile((await download.path())!, 'utf8');
  for (const entry of exported) expect(content).toContain(entry.explanation!.title);
  expect(content).not.toContain('내보내기 제외 기록');
  expect(content).not.toContain(entries[2].explanation!.title);
  expect(content).toContain(latest.sourceUrl);
  expect(content).toContain('2026-10-07');
  expect(content).toContain('http://127.0.0.1:4173/?entry=export-22');
  await expect(page.getByRole('status').filter({ hasText: '23개' })).toBeVisible();
});

test('saved export waits for loaded data and does not show an invented zero count', async ({ page }) => {
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/feed', async route => {
    await hold;
    await route.fulfill({ status: 503, json: { error: 'unavailable' } });
  });
  await page.goto('/?saved=1&unread=1');
  const exportButton = page.getByRole('button', { name: 'Markdown 내보내기', exact: true });
  await expect(exportButton).toBeDisabled();
  await expect(page.getByText(/현재 필터에 맞는 저장 글 \d+개/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '저장한 글', exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('alert')).toContainText('변경 기록을 불러오지 못했습니다');
  await expect(exportButton).toBeDisabled();
  await expect(page.getByText(/현재 필터에 맞는 저장 글 \d+개/)).toHaveCount(0);
});

test('read state stays usable in the current tab when browser storage rejects writes', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Unavailable', 'QuotaExceededError'); };
  });
  await page.goto(`/?entry=${latest.id}`);
  await expect(page.getByRole('status').filter({ hasText: '브라우저 저장소를 사용할 수 없습니다.' })).toBeVisible();
  await page.getByRole('button', { name: '읽지 않음으로 표시', exact: true }).click();
  await expect(page.getByRole('button', { name: '읽음으로 표시', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true }).click();
  await page.getByRole('button', { name: '읽지 않은 글만', exact: true }).click();
  await expect(card(page, latest.id)).toBeVisible();
});

test('reading tools, adjacent links, and RSS remain usable on a narrow dark screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await useEntries(page, [...entries, middle]);
  await page.goto('/');
  await page.getByRole('button', { name: '다크 모드로 전환' }).click();
  await page.getByRole('button', { name: '읽지 않은 글만', exact: true }).click();
  await page.getByRole('button', { name: 'RSS 구독', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'RSS 구독' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await card(page, middle.id).getByRole('link').click();
  await expect(page.getByRole('button', { name: '읽지 않음으로 표시', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '같은 제품의 변경 기록' }).getByRole('link')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/code-pulse-reading-tools-mobile.png', fullPage: true });
});

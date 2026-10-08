import { expect, test } from '@playwright/test';
import appRelease from '../../src/shared/app-release.json' with { type: 'json' };
import { feed, mockApi, presence } from './fixtures';

test('visitor counts use a prepared cookie and confirmed heartbeat response', async ({ page }) => {
  await mockApi(page);
  const methods: string[] = [];
  let heartbeat: { header?: string; cookie?: string; body: string | null } | undefined;
  await page.route('**/api/presence', route => {
    const request = route.request();
    methods.push(request.method());
    if (request.method() === 'GET') return route.fulfill({
      json: { ...presence, active_visitors: 2, total_visitors: 40 },
      headers: { 'set-cookie': 'presence-proof=prepared; Path=/; HttpOnly; SameSite=Lax' },
    });
    heartbeat = { header: request.headers()['x-code-pulse-client'], cookie: request.headers()['cookie'], body: request.postData() };
    return route.fulfill({ json: { ...presence, active_visitors: 3, total_visitors: 41 } });
  });
  await page.goto('/');
  const counter = page.getByRole('status', { name: '방문 집계', exact: true });
  await expect(counter).toContainText('접속 3');
  await expect(counter).toContainText('누적 방문 41');
  expect(methods).toEqual(['GET', 'POST']);
  expect(heartbeat?.header).toBe('1');
  expect(heartbeat?.cookie).toContain('presence-proof=prepared');
  expect(heartbeat?.body).toBe('{}');
});

test('an unconfirmed visitor response shows loading without invented numbers', async ({ page }) => {
  await mockApi(page);
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/presence', async route => {
    await held;
    await route.fulfill({ json: presence });
  });
  await page.goto('/');
  const counter = page.getByRole('status', { name: '방문 집계', exact: true });
  await expect(counter).toContainText('확인 중');
  await expect(counter).not.toContainText('접속 0');
  await expect(counter).not.toContainText('누적 방문 0');
  release();
  await expect(counter).toContainText('누적 방문 42');
});

test('visitor failure leaves the reading interface usable and shows no fabricated count', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/presence', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
  await page.goto('/');
  await expect(page.getByRole('status', { name: '방문 집계', exact: true })).toContainText('확인 불가');
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
  await page.getByRole('searchbox', { name: '변경 기록 검색' }).fill('Codex');
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
});

test('heartbeats run while visible and resume without incrementing client-side totals', async ({ page }) => {
  await mockApi(page, feed, { clock: 'controlled' });
  let posts = 0;
  let asOf = presence.as_of;
  await page.route('**/api/presence', route => {
    if (route.request().method() === 'POST') posts += 1;
    return route.fulfill({ json: { ...presence, as_of: asOf } });
  });
  await page.goto('/');
  await expect.poll(() => posts).toBe(1);
  await page.clock.pauseAt('2026-10-07T03:00:02Z');
  asOf = '2026-10-07T03:00:30Z';
  await page.clock.runFor(20_000);
  expect(posts).toBe(1);
  await page.clock.runFor(10_001);
  await expect.poll(() => posts).toBe(2);
  await expect(page.getByRole('status', { name: '방문 집계', exact: true })).toContainText('누적 방문 42');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(120_000);
  expect(posts).toBe(2);
  asOf = '2026-10-07T03:02:32Z';
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(10);
  await expect.poll(() => posts).toBe(3);
  await expect(page.getByRole('status', { name: '방문 집계', exact: true })).toContainText('누적 방문 42');
});

test('an expired visitor snapshot retains its real numbers with a last-confirmed label', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/presence', route => route.fulfill({
    json: { ...presence, active_visitors: 7, total_visitors: 920, as_of: '2026-10-07T02:00:00Z' },
  }));
  await page.goto('/');
  const counter = page.getByRole('status', { name: '방문 집계', exact: true });
  await expect(counter).toContainText('마지막 확인');
  await expect(counter).toContainText('접속 7');
  await expect(counter).toContainText('누적 방문 920');
});

test('a failed refresh retains the last server counts and becomes stale', async ({ page }) => {
  await mockApi(page, feed, { clock: 'controlled' });
  let unavailable = false;
  await page.route('**/api/presence', route => unavailable
    ? route.fulfill({ status: 503, json: { error: 'unavailable' } })
    : route.fulfill({ json: { ...presence, active_visitors: 4, total_visitors: 100 } }));
  await page.goto('/');
  const counter = page.getByRole('status', { name: '방문 집계', exact: true });
  await expect(counter).toContainText('누적 방문 100');
  await page.clock.pauseAt('2026-10-07T03:00:02Z');
  unavailable = true;
  await page.clock.runFor(30_001);
  await expect(counter).toContainText('마지막 확인');
  await expect(counter).toContainText('접속 4');
  await expect(counter).toContainText('누적 방문 100');
});

test('invalid visitor data is not displayed as a count', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/presence', route => route.fulfill({ json: { ...presence, active_visitors: -1 } }));
  await page.goto('/');
  await expect(page.getByRole('status', { name: '방문 집계', exact: true })).toContainText('확인 불가');
  await expect(page.getByRole('status', { name: '방문 집계', exact: true })).not.toContainText('-1');
});

test('an expired visitor session is prepared again before one heartbeat retry', async ({ page }) => {
  await mockApi(page);
  let preparations = 0;
  let posts = 0;
  const cookies: string[] = [];
  await page.route('**/api/presence', route => {
    if (route.request().method() === 'GET') {
      preparations += 1;
      return route.fulfill({
        json: presence,
        headers: { 'set-cookie': `presence-recovery=${preparations}; Path=/; HttpOnly; SameSite=Lax` },
      });
    }
    posts += 1;
    cookies.push(route.request().headers()['cookie'] ?? '');
    return posts === 1
      ? route.fulfill({ status: 401, json: { error: 'session_required' } })
      : route.fulfill({ json: { ...presence, active_visitors: 5, total_visitors: 90 } });
  });
  await page.goto('/');
  await expect(page.getByRole('status', { name: '방문 집계', exact: true })).toContainText('누적 방문 90');
  expect(preparations).toBe(2);
  expect(posts).toBe(2);
  expect(cookies[0]).toContain('presence-recovery=1');
  expect(cookies[1]).toContain('presence-recovery=2');
});

test('a page that starts hidden does not register a visit until it becomes visible', async ({ page }) => {
  await mockApi(page, feed, { clock: 'controlled' });
  await page.addInitScript(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  const methods: string[] = [];
  await page.route('**/api/presence', route => {
    methods.push(route.request().method());
    return route.fulfill({ json: { ...presence, as_of: '2026-10-07T03:01:02Z' } });
  });
  await page.goto('/');
  await expect(page.getByRole('status', { name: '방문 집계', exact: true })).toContainText('확인 불가');
  await page.clock.pauseAt('2026-10-07T03:00:02Z');
  await page.clock.runFor(60_000);
  expect(methods).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(10);
  await expect(page.getByRole('status', { name: '방문 집계', exact: true })).toContainText('누적 방문 42');
  await expect.poll(() => methods).toEqual(['GET', 'POST']);
});

test('visitor explanation and Korean release history work by keyboard on mobile', async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('status', { name: '방문 집계', exact: true })).toContainText('누적 방문 42');
  const info = page.getByRole('button', { name: /집계 기준 보기/ });
  await info.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(page.getByRole('tooltip')).toContainText('90초');
  await expect(page.getByRole('tooltip')).toContainText('여러 탭');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).not.toBeVisible();
  const version = page.getByRole('button', { name: `서비스 변경 기록, 버전 ${appRelease.version}`, exact: true });
  await expect(version).toHaveText(`v${appRelease.version}`);
  await version.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Code Pulse 변경 기록', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(appRelease.releases[0].changes[0].ko);
  await expect(dialog).not.toContainText(appRelease.releases[0].changes[0].en);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.screenshot({ path: '/tmp/code-pulse-release-notes-mobile.png' });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(version).toBeFocused();
  await page.locator('.site-footer').screenshot({ path: '/tmp/code-pulse-footer-mobile.png' });
});

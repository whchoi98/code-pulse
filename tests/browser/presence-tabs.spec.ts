import { expect, test } from '@playwright/test';
import { feed, mockApi, presence } from './fixtures';

test('two real tabs serialize cookie preparation and the first heartbeat', async ({ page, context }) => {
  await context.addInitScript(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }));
  const second = await context.newPage();
  await mockApi(page, feed, { presence: false });
  await mockApi(second, feed, { presence: false });
  let issued = 0;
  let completedPosts = 0;
  let postInFlight = false;
  let preparationDuringPost = false;
  const registered = new Set<string>();
  const events: string[] = [];
  await context.route('**/api/presence', async route => {
    const request = route.request();
    const visitor = request.headers()['cookie']?.match(/(?:^|;\s*)presence-shared=(visit-\d+)/)?.[1];
    events.push(request.method());
    if (request.method() === 'GET') {
      preparationDuringPost ||= postInFlight;
      if (visitor) return route.fulfill({ json: { ...presence, active_visitors: registered.size, total_visitors: registered.size } });
      const id = `visit-${++issued}`;
      // Both old clients can enter GET before either cookie arrives.
      // Deliver the second cookie only after the first POST has committed.
      await new Promise(resolve => setTimeout(resolve, issued === 1 ? 700 : 1400));
      return route.fulfill({
        json: { ...presence, active_visitors: registered.size, total_visitors: registered.size },
        headers: { 'set-cookie': `presence-shared=${id}; Path=/api/presence; HttpOnly; SameSite=Lax` },
      });
    }
    if (!visitor) return route.fulfill({ status: 401, json: { error: 'session_required' } });
    postInFlight = true;
    registered.add(visitor);
    await new Promise(resolve => setTimeout(resolve, 100));
    postInFlight = false;
    await route.fulfill({ json: { ...presence, active_visitors: registered.size, total_visitors: registered.size } });
    completedPosts += 1;
  });
  await Promise.all([page.goto('/'), second.goto('/')]);
  await expect.poll(() => completedPosts).toBe(2);
  expect({ issuedCookies: issued, cumulativeVisitors: registered.size }).toEqual({ issuedCookies: 1, cumulativeVisitors: 1 });
  expect(preparationDuringPost).toBe(false);
  expect(events).toEqual(['GET', 'POST', 'GET', 'POST']);
  await expect(page.getByRole('status', { name: '방문 집계', exact: true })).toContainText('누적 방문 1');
  await expect(second.getByRole('status', { name: '방문 집계', exact: true })).toContainText('누적 방문 1');
  const cookies = (await context.cookies()).filter(cookie => cookie.name === 'presence-shared');
  expect(cookies).toHaveLength(1);
  expect(cookies[0].value).toBe('visit-1');
  await second.close();
});

test('unsupported locks keep real read-only counts without writing or storing a visitor cookie', async ({ page, context }) => {
  await mockApi(page);
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
  const methods: string[] = [];
  await page.route('**/api/presence', route => {
    methods.push(route.request().method());
    return route.fulfill({
      json: { ...presence, active_visitors: 6, total_visitors: 58 },
      headers: { 'set-cookie': 'unsupported-visitor=should-not-be-stored; Path=/api/presence; HttpOnly; SameSite=Lax' },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('status', { name: '방문 집계', exact: true })).toContainText('누적 방문 58');
  expect(methods).toEqual(['GET']);
  expect((await context.cookies()).some(cookie => cookie.name === 'unsupported-visitor')).toBe(false);
});

test('normal heartbeats bypass the bootstrap lock but 401 recovery waits for it', async ({ page, context }) => {
  await context.addInitScript(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }));
  await mockApi(page, feed, { clock: 'controlled' });
  let posts = 0;
  let preparations = 0;
  await page.route('**/api/presence', route => {
    if (route.request().method() === 'GET') {
      preparations += 1;
      return route.fulfill({
        json: presence,
        headers: { 'set-cookie': 'presence-normal=known; Path=/api/presence; HttpOnly; SameSite=Lax' },
      });
    }
    posts += 1;
    return posts === 2
      ? route.fulfill({ status: 401, json: { error: 'session_required' } })
      : route.fulfill({ json: presence });
  });
  await page.goto('/');
  await expect.poll(() => posts).toBe(1);
  await page.clock.pauseAt('2026-10-07T03:00:02Z');
  const holder = await context.newPage();
  await holder.route('**/__presence-lock-holder', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body>Lock holder</body></html>',
  }));
  await holder.goto('/__presence-lock-holder');
  await holder.evaluate(() => {
    void navigator.locks.request('code-pulse-presence-bootstrap', async () => {
      document.documentElement.dataset.lockHeld = 'true';
      await new Promise<void>(resolve => window.addEventListener('release-test-lock', () => resolve(), { once: true }));
    });
  });
  await expect(holder.locator('html')).toHaveAttribute('data-lock-held', 'true');
  await page.clock.runFor(30_001);
  await expect.poll(() => posts).toBe(2);
  await expect.poll(() => holder.evaluate(async () => (await navigator.locks.query()).pending
    ?.filter(lock => lock.name === 'code-pulse-presence-bootstrap').length ?? 0)).toBe(1);
  expect(preparations).toBe(1);
  await holder.evaluate(() => window.dispatchEvent(new Event('release-test-lock')));
  await page.clock.runFor(10);
  await expect.poll(() => posts).toBe(3);
  expect(preparations).toBe(2);
  await holder.close();
});

test('unmount cancels a queued bootstrap lock before it can issue network requests', async ({ page: holder, context }) => {
  await holder.route('**/__presence-lock-holder', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body>Lock holder</body></html>',
  }));
  await holder.goto('/__presence-lock-holder');
  await holder.evaluate(() => {
    void navigator.locks.request('code-pulse-presence-bootstrap', async () => {
      document.documentElement.dataset.lockHeld = 'true';
      await new Promise<void>(resolve => window.addEventListener('release-test-lock', () => resolve(), { once: true }));
    });
  });
  await expect(holder.locator('html')).toHaveAttribute('data-lock-held', 'true');
  const counter = await context.newPage();
  await mockApi(counter, feed, { presence: false });
  await counter.addInitScript(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }));
  let requests = 0;
  await counter.route('**/api/presence', route => { requests += 1; return route.fulfill({ json: presence }); });
  await counter.goto('/tests/browser/fixtures/presence-lifecycle.html');
  await expect.poll(() => holder.evaluate(async () => (await navigator.locks.query()).pending
    ?.filter(lock => lock.name === 'code-pulse-presence-bootstrap').length ?? 0)).toBe(1);
  expect(requests).toBe(0);
  await counter.getByRole('button', { name: '카운터 제거', exact: true }).click();
  await expect(counter.getByRole('status', { name: '방문 집계', exact: true })).toHaveCount(0);
  await expect.poll(() => holder.evaluate(async () => (await navigator.locks.query()).pending
    ?.filter(lock => lock.name === 'code-pulse-presence-bootstrap').length ?? 0)).toBe(0);
  await holder.evaluate(async () => {
    window.dispatchEvent(new Event('release-test-lock'));
    await navigator.locks.request('code-pulse-presence-bootstrap', async () => {});
  });
  expect(requests).toBe(0);
  await counter.close();
});

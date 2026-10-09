import { chromium, devices } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'https://code-pulse.whchoi.net' },
  output: { type: 'string', default: 'docs/delivery-measurement.json' },
  runs: { type: 'string', default: '3' },
} });
const count = Number(values.runs);
if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error('runs must be 1–5');
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const mode of ['desktop', 'mobile']) {
    for (let run = 0; run < count; run++) {
      const context = await browser.newContext(mode === 'mobile'
        ? { ...devices['Pixel 7'], locale: 'ko-KR' } : { viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      await session.send('Network.enable');
      // A fresh browser context has an empty cache. The second navigation in
      // that context intentionally measures the application's retained cache.
      if (mode === 'mobile') {
        await session.send('Network.emulateNetworkConditions', {
          offline: false, latency: 80, downloadThroughput: 1_600_000 / 8,
          uploadThroughput: 750_000 / 8, connectionType: 'cellular4g',
        });
        await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      }
      const failures = [];
      page.on('pageerror', error => failures.push(error.message));
      await page.addInitScript(() => {
        window.__deliveryLcp = 0;
        new PerformanceObserver(list => {
          window.__deliveryLcp = list.getEntries().at(-1)?.startTime ?? 0;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      const response = await page.goto(values.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      const first = page.locator('.entry-card h3 a').first();
      await first.waitFor({ timeout: 90_000 });
      // Both static and client-rendered cards must be usable before measuring a click.
      await page.locator('.site-header button').first().waitFor({ timeout: 90_000 });
      const listReadyMs = await page.evaluate(() => performance.now());
      const firstId = await page.locator('.entry-card').first().getAttribute('data-entry-id');
      const initial = await page.evaluate(() => ({
        navigation: performance.getEntriesByType('navigation')[0].toJSON(),
        paints: performance.getEntriesByType('paint').map(item => item.toJSON()),
        lcpMs: window.__deliveryLcp,
        resources: performance.getEntriesByType('resource').map(item => ({
          path: new URL(item.name).pathname, bytes: item.transferSize,
          decoded: item.decodedBodySize, duration: item.duration,
        })),
      }));
      const clickAt = await page.evaluate(() => performance.now());
      await first.click();
      await page.locator('.full-change-item').first().waitFor({ timeout: 60_000 });
      const firstDetailMs = await page.evaluate(start => performance.now() - start, clickAt);
      const itemCount = await page.locator('.full-change-item').count();
      await page.locator('.back-button').click();
      await page.locator('.entry-card h3 a').first().waitFor();
      const secondClickAt = await page.evaluate(() => performance.now());
      await page.locator('.entry-card h3 a').first().click();
      await page.locator('.full-change-item').first().waitFor();
      const repeatedDetailMs = await page.evaluate(start => performance.now() - start, secondClickAt);
      const result = { mode, run: run + 1, httpStatus: response.status(), listReadyMs,
        firstId, firstDetailMs, repeatedDetailMs, itemCount, ...initial, failures };
      results.push(result);
      console.log(JSON.stringify({ mode, run: run + 1, listReadyMs, firstDetailMs, repeatedDetailMs, itemCount, failures }));
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const report = { checkedAt: new Date().toISOString(), url: values.url,
  conditions: { mobile: 'Pixel 7, 80ms latency, 1.6Mbps down, 750Kbps up, CPU 4x', desktop: '1440x1000, native network/CPU', cache: 'Fresh context per run; repeated detail in same context' }, results };
await mkdir(dirname(values.output), { recursive: true });
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);

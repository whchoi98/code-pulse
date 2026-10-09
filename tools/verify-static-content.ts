import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { extractChangeItems } from '../src/collector/change-items.js';
import { configuredStore } from '../src/collector/store.js';
import { publicEntry } from '../src/server/public-entry.js';
import { entryRevision } from '../src/shared/reading-revision.js';
import { COLLECTION_SCHEDULE } from '../src/shared/schedule.js';
import { PRODUCT_IDS, type Feed, type FeedEntry, type SearchIndex } from '../src/shared/types.js';

const { values } = parseArgs({ options: {
  base: { type: 'string', default: 'https://code-pulse.whchoi.net' },
  output: { type: 'string', default: 'docs/static-content-verification.json' },
} });
const base = new URL(values.base!);
assert.ok(['http:', 'https:'].includes(base.protocol) && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password);
const { snapshot } = await configuredStore().read();
assert.ok(snapshot.entries.length > 0);
const expected = new Map(snapshot.entries.map(entry => [entry.id, entry]));
const privateKeys = new Set(['originalText', 'contentHash', 'sourceHash', 'model', 'explanationModel', 'background']);
function assertPublic(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(assertPublic); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!privateKeys.has(key), `Private field ${key} in public artifact.`);
    assertPublic(item);
  }
}
async function get<T>(path: string): Promise<T> {
  assert.ok(path.startsWith('/') && !path.startsWith('//'));
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000), cache: 'no-cache' });
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  const body: unknown = await response.json();
  assertPublic(body);
  return body as T;
}
const languages = [];
for (const language of ['ko', 'en'] as const) {
  const feed = await get<Feed>(`/content/${language}/feed.json`);
  assert.equal(feed.language, language);
  assert.equal(feed.entries.length, expected.size);
  assert.equal(new Set(feed.entries.map(entry => entry.id)).size, expected.size);
  assert.equal(feed.generatedAt, snapshot.generatedAt, 'The current catalog must represent the current snapshot. Retry after the 60-second edge TTL.');
  assert.deepEqual(feed.schedule, COLLECTION_SCHEDULE);
  const search = await get<SearchIndex>(feed.searchUrl!);
  assert.equal(search.language, language);
  assert.deepEqual(search.entries.map(entry => entry.id).sort(), [...expected.keys()].sort());
  const searchText = new Map(search.entries.map(entry => [entry.id, entry.text.normalize('NFC').toLocaleLowerCase()]));
  const counts = Object.fromEntries(PRODUCT_IDS.map(product => [product, { records: 0, items: 0 }]));
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= feed.entries.length) return;
      const summary = feed.entries[index];
      assert.equal(summary.fullChanges, undefined, 'Initial catalog must not embed full change lists.');
      const original = expected.get(summary.id);
      assert.ok(original, summary.id);
      assert.match(summary.detailUrl!, /^\/content\/objects\/[a-f0-9]{64}\.json$/);
      const detail = await get<FeedEntry>(summary.detailUrl!);
      const source = extractChangeItems(original);
      assert.equal(detail.id, summary.id);
      assert.equal(detail.language, language);
      assert.equal(detail.publishedAt, original.publishedAt);
      assert.equal(detail.publishedDate, original.publishedDate);
      assert.equal(detail.sourceUrl, original.sourceUrl);
      assert.equal(detail.contentKind, language === 'en' ? 'source' : 'explanation');
      assert.equal(detail.fullChanges?.status, 'ready');
      assert.equal(detail.fullChanges.sourceCount, source.length);
      assert.equal(summary.changeSummary?.sourceCount, source.length);
      assert.equal(summary.changeSummary?.readyCount, source.length);
      assert.deepEqual(detail.fullChanges.items.map(item => item.id), source.map(item => item.id));
      const wanted = language === 'ko' ? publicEntry(original).fullChanges!.items
        : source.map(item => ({ id: item.id, text: item.section ? `${item.section}\n\n${item.text}` : item.text }));
      assert.deepEqual(detail.fullChanges.items, wanted);
      assert.equal(detail.readRevision, summary.readRevision);
      assert.equal(detail.readRevision, entryRevision(publicEntry(original)));
      for (const item of wanted) {
        assert.ok(searchText.get(summary.id)?.includes(item.text.normalize('NFC').toLocaleLowerCase()), `Missing search item: ${summary.id}/${item.id}`);
      }
      counts[detail.product].records++;
      counts[detail.product].items += source.length;
    }
  }));
  languages.push({ language, records: feed.entries.length, items: Object.values(counts).reduce((total, row) => total + row.items, 0), products: counts, searchRecords: search.entries.length });
  console.log(JSON.stringify(languages.at(-1)));
}
const report = { checkedAt: new Date().toISOString(), base: base.href, snapshotGeneratedAt: snapshot.generatedAt,
  schedule: COLLECTION_SCHEDULE, languages, complete: true, privateFieldsExposed: false };
await writeFile(values.output!, `${JSON.stringify(report, null, 2)}\n`);

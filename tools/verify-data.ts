import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_MODEL_ID, EDITORIAL_VERSION, validateExplanation } from '../src/collector/explanation.js';
import { isOfficialUrl } from '../src/collector/official-fetch.js';
import { SOURCES } from '../src/collector/sources.js';
import { configuredStore } from '../src/collector/store.js';

const { values } = parseArgs({
  options: {
    'allow-pending': { type: 'boolean', default: false },
    output: { type: 'string', default: 'docs/data-verification.json' },
  },
});
const { snapshot } = await configuredStore().read();
const counts = (items: string[]) => Object.fromEntries([...new Set(items)].sort().map(item => [item, items.filter(value => value === item).length]));
const now = Date.now();
const entries = snapshot.entries;
const errors: { id: string; error: string }[] = [];
for (const entry of entries) {
  try {
    assert.ok(entry.publishedDate >= '2026-01-01', 'Requested history begins on January 1, 2026.');
    assert.ok(Date.parse(entry.publishedAt) <= now, 'Future publication.');
    assert.equal(entry.publishedDate, entry.publishedAt.slice(0, 10), 'Publication date and timestamp disagree.');
    assert.ok(isOfficialUrl(entry.sourceUrl) && entry.references.every(reference => isOfficialUrl(reference.url)), 'Non-official source.');
    assert.equal('background' in entry, false, 'Ephemeral source background was persisted.');
    if (entry.explanationStatus === 'ready') {
      assert.ok(entry.explanation, 'Ready entry has no explanation.');
      validateExplanation(entry.explanation, entry);
    }
  } catch (error) {
    errors.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
  }
}
const canonicalKeys = entries.map(entry => entry.channel === 'cli' && entry.version
  ? `${entry.product}:cli:${entry.version}` : entry.id);
const pending = entries.filter(entry => entry.explanationStatus !== 'ready' || !entry.explanation);
const oldModel = entries.filter(entry => entry.explanationModel !== DEFAULT_MODEL_ID);
const oldEditorial = entries.filter(entry => entry.editorialVersion !== EDITORIAL_VERSION);
const report = {
  checkedAt: new Date().toISOString(),
  requestedSince: '2026-01-01',
  entries: entries.length,
  ready: entries.length - pending.length,
  pending: pending.length,
  remainingModelRefresh: oldModel.length,
  models: counts(entries.map(entry => entry.explanationModel ?? 'pending')),
  editorialVersions: counts(entries.map(entry => entry.editorialVersion ?? 'pending')),
  products: counts(entries.map(entry => entry.product)),
  months: counts(entries.map(entry => entry.publishedDate.slice(0, 7))),
  firstPublication: entries.map(entry => entry.publishedDate).sort()[0],
  latestPublication: entries.map(entry => entry.publishedDate).sort().at(-1),
  duplicateIds: entries.length - new Set(entries.map(entry => entry.id)).size,
  duplicateCliVersions: entries.length - new Set(canonicalKeys).size,
  sources: snapshot.sources,
  weeklyReferences: entries.filter(entry => entry.references.some(reference => reference.url === 'https://code.claude.com/docs/ko/whats-new')).length,
  latestRun: snapshot.runs[0],
  validationErrors: errors,
  complete: pending.length === 0 && oldModel.length === 0 && oldEditorial.length === 0
    && errors.length === 0 && snapshot.sources.length === SOURCES.length
    && snapshot.sources.every(source => source.state === 'ok') && snapshot.runs[0]?.status === 'success',
};
await writeFile(values.output!, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
assert.ok(entries.length > 0);
assert.equal(report.duplicateIds, 0);
assert.equal(report.duplicateCliVersions, 0);
assert.equal(errors.length, 0, 'Stored entries failed source or explanation validation.');
if (!values['allow-pending']) assert.equal(report.complete, true, 'History or model migration is not complete.');

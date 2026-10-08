import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { extractChangeItems } from '../src/collector/change-items.js';
import { DEFAULT_MODEL_ID } from '../src/collector/explanation.js';
import { FULL_CHANGES_VERSION, fullChangesSourceHash, isFullChangesComplete, isFullChangesProgress } from '../src/collector/full-changes.js';
import { configuredStore } from '../src/collector/store.js';
import { SOURCES } from '../src/collector/sources.js';

const { values } = parseArgs({ options: {
  output: { type: 'string', default: 'docs/full-changes-verification.json' },
  'allow-pending': { type: 'boolean', default: false },
  'reference-v293': { type: 'string' },
} });
const { snapshot } = await configuredStore().read();
const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const issues: { id: string; reason: string }[] = [];
const rows = snapshot.entries.map(entry => {
  let sourceCount = 0;
  try {
    const sourceItems = extractChangeItems(entry);
    sourceCount = sourceItems.length;
    assert.equal(entry.contentHash, fullChangesSourceHash(entry), 'Source hash mismatch.');
    assert.ok(sourceCount > 0, 'Empty source inventory.');
    assert.equal(new Set(sourceItems.map(item => item.id)).size, sourceCount, 'Duplicate extracted IDs.');
    const represented = normalize(sourceItems.map(item => `${item.section ?? ''}\n${item.text}`).join('\n'));
    for (const line of entry.originalText.split(/\r?\n/)) {
      if (/^\s*(?:`{3,}|~{3,}|[-*_]{3,})/u.test(line)) continue;
      const content = normalize(line.trim().replace(/^#{1,6}\s+(.+?)(?:\s+#+)?$/u, '$1')
        .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, ''));
      if (content) assert.ok(represented.includes(content), 'A substantive source line is missing from the inventory.');
    }
    if (entry.fullChanges) assert.ok(isFullChangesProgress(entry.fullChanges, entry, DEFAULT_MODEL_ID), 'Invalid full-change progress.');
  } catch (error) {
    issues.push({ id: entry.id, reason: error instanceof Error ? error.message : 'Invalid source coverage.' });
  }
  const valid = isFullChangesProgress(entry.fullChanges, entry, DEFAULT_MODEL_ID);
  return {
    id: entry.id, product: entry.product, version: entry.version, sourceCount,
    explainedCount: valid ? entry.fullChanges!.items.length : 0,
    complete: isFullChangesComplete(entry.fullChanges, entry, DEFAULT_MODEL_ID),
  };
});
const exemplar = snapshot.entries.find(entry => entry.product === 'claude-code' && entry.version === '2.1.293');
let referenceVerified = false;
if (values['reference-v293']) {
  assert.ok(exemplar, 'Claude Code v2.1.293 must exist.');
  const official = await readFile(values['reference-v293'], 'utf8');
  assert.equal(exemplar.originalText.trim(), official.trim());
  const officialItems = official.split(/\r?\n/).filter(line => /^-\s/u.test(line)).map(line => line.slice(2));
  assert.equal(officialItems.length, 56);
  assert.deepEqual(extractChangeItems(exemplar).map(item => item.text), officialItems);
  referenceVerified = true;
}
const products = Object.fromEntries(['claude-code', 'codex', 'kiro'].map(product => {
  const selected = rows.filter(entry => entry.product === product);
  return [product, { records: selected.length, sourceItems: selected.reduce((sum, entry) => sum + entry.sourceCount, 0),
    explainedItems: selected.reduce((sum, entry) => sum + entry.explainedCount, 0),
    completeRecords: selected.filter(entry => entry.complete).length }];
}));
const pending = rows.filter(entry => !entry.complete);
const sourceErrors = snapshot.sources.filter(source => source.state !== 'ok').map(source => ({ id: source.id, state: source.state }));
const report = {
  checkedAt: new Date().toISOString(), model: DEFAULT_MODEL_ID, formatVersion: FULL_CHANGES_VERSION,
  records: rows.length, sourceItems: rows.reduce((sum, entry) => sum + entry.sourceCount, 0),
  explainedItems: rows.reduce((sum, entry) => sum + entry.explainedCount, 0),
  completeRecords: rows.length - pending.length, pendingRecords: pending.length,
  products, issues, sourceErrors, latestRun: snapshot.runs[0],
  v2_1_293: { ...rows.find(entry => entry.id === exemplar?.id), officialReferenceVerified: referenceVerified },
  complete: rows.length > 0 && !pending.length && !issues.length && !sourceErrors.length
    && snapshot.sources.length === SOURCES.length && snapshot.runs[0]?.status === 'success',
  entries: rows,
};
await writeFile(values.output!, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, entries: undefined }));
assert.equal(issues.length, 0, 'Full-change coverage validation failed.');
if (!values['allow-pending']) assert.ok(report.complete, 'Full-change migration or official-source verification is incomplete.');

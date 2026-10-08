import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { mergeImportedSnapshot } from '../src/collector/engine.js';
import { DEFAULT_MODEL_ID } from '../src/collector/explanation.js';
import { S3Store, WriteConflict } from '../src/collector/store.js';
import type { Snapshot } from '../src/shared/types.js';
import { assertFullPublication } from './full-publication.js';

const { values } = parseArgs({
  options: { input: { type: 'string' }, write: { type: 'boolean', default: false }, output: { type: 'string', default: 'docs/backfill-publication.json' } },
});
if (!values.input) throw new Error('--input에 검증할 백필 데이터 폴더를 지정하세요.');
const input = resolve(values.input);
const incoming = JSON.parse(await readFile(resolve(input, 'snapshot.json'), 'utf8')) as Snapshot;
assertFullPublication(incoming);
const outputs = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).CodePulse;
assert.match(outputs.DataBucketName, /^codepulse-databucket[a-z0-9-]+$/);
const execute = promisify(execFile);
const identity = JSON.parse((await execute('aws', ['sts', 'get-caller-identity', '--region', 'ap-northeast-2', '--output', 'json'])).stdout);
assert.equal(identity.Account, '061525506239');
const store = new S3Store(outputs.DataBucketName);
const before = await store.read();
const proposed = mergeImportedSnapshot(before.snapshot, incoming);
assertFullPublication(proposed);
console.log(JSON.stringify({
  mode: values.write ? 'write' : 'dry-run', input, bucket: outputs.DataBucketName,
  incoming: incoming.entries.length, current: before.snapshot.entries.length, merged: proposed.entries.length,
  model: DEFAULT_MODEL_ID,
}));
if (values.write) {
  await execute('aws', [
    's3', 'cp', resolve(input, 'raw'), `s3://${outputs.DataBucketName}/raw/`,
    '--recursive', '--no-follow-symlinks', '--only-show-errors', '--region', 'ap-northeast-2',
  ], { maxBuffer: 2 * 1024 * 1024 });
  let current = before;
  let published = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const merged = mergeImportedSnapshot(current.snapshot, incoming);
      assertFullPublication(merged);
      await store.write(merged, current.etag);
      published = true;
      break;
    } catch (error) {
      if (!(error instanceof WriteConflict) || attempt === 4) throw error;
      current = await store.read();
    }
  }
  assert.ok(published);
  const after = await store.read();
  assertFullPublication(after.snapshot);
  const report = {
    publishedAt: new Date().toISOString(), bucket: outputs.DataBucketName, etag: after.etag,
    importedEntries: incoming.entries.length, publishedEntries: after.snapshot.entries.length,
    model: DEFAULT_MODEL_ID,
    fullChangeRecords: after.snapshot.entries.filter(entry => entry.fullChanges?.status === 'ready').length,
    fullChangeItems: after.snapshot.entries.reduce((sum, entry) => sum + (entry.fullChanges?.items.length ?? 0), 0),
    modelCounts: Object.fromEntries([...new Set(after.snapshot.entries.map(entry => entry.explanationModel ?? 'pending'))]
      .map(model => [model, after.snapshot.entries.filter(entry => (entry.explanationModel ?? 'pending') === model).length])),
    preservedCurrentEntries: before.snapshot.entries.every(entry =>
      after.snapshot.entries.some(publishedEntry => publishedEntry.id === entry.id
        || (entry.channel === 'cli' && entry.version && publishedEntry.product === entry.product
          && publishedEntry.channel === entry.channel && publishedEntry.version === entry.version))),
  };
  await writeFile(values.output!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

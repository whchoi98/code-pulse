import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { mergeImportedSnapshot } from '../src/collector/engine.js';
import { DEFAULT_MODEL_ID, EDITORIAL_VERSION, validateExplanation } from '../src/collector/explanation.js';
import { isOfficialUrl } from '../src/collector/official-fetch.js';
import { S3Store, WriteConflict } from '../src/collector/store.js';
import type { Snapshot } from '../src/shared/types.js';

const { values } = parseArgs({
  options: { input: { type: 'string' }, write: { type: 'boolean', default: false } },
});
if (!values.input) throw new Error('--input에 검증할 백필 데이터 폴더를 지정하세요.');
const input = resolve(values.input);
const incoming = JSON.parse(await readFile(resolve(input, 'snapshot.json'), 'utf8')) as Snapshot;
assert.equal(incoming.schemaVersion, 1);
assert.ok(incoming.entries.length > 0);
assert.equal(new Set(incoming.entries.map(entry => entry.id)).size, incoming.entries.length);
assert.equal(incoming.sources.length, 6);
assert.ok(incoming.sources.every(source => source.state === 'ok'), '백필 출처를 모두 확인해야 합니다.');
for (const entry of incoming.entries) {
  assert.equal(entry.explanationStatus, 'ready', `해설 미완료: ${entry.id}`);
  assert.equal(entry.explanationModel, DEFAULT_MODEL_ID, `모델 갱신 미완료: ${entry.id}`);
  assert.equal(entry.editorialVersion, EDITORIAL_VERSION);
  assert.equal('background' in entry, false);
  assert.ok(entry.publishedDate >= '2026-01-01' && Date.parse(entry.publishedAt) <= Date.now());
  assert.ok(isOfficialUrl(entry.sourceUrl) && entry.references.every(reference => isOfficialUrl(reference.url)));
  assert.equal(entry.contentHash, createHash('sha256').update(`${entry.originalTitle}\n${entry.originalText}`).digest('hex'));
  validateExplanation(entry.explanation, entry);
}
const outputs = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).CodePulse;
assert.match(outputs.DataBucketName, /^codepulse-databucket[a-z0-9-]+$/);
const execute = promisify(execFile);
const identity = JSON.parse((await execute('aws', ['sts', 'get-caller-identity', '--region', 'ap-northeast-2', '--output', 'json'])).stdout);
assert.equal(identity.Account, '061525506239');
const store = new S3Store(outputs.DataBucketName);
const before = await store.read();
const proposed = mergeImportedSnapshot(before.snapshot, incoming);
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
      await store.write(mergeImportedSnapshot(current.snapshot, incoming), current.etag);
      published = true;
      break;
    } catch (error) {
      if (!(error instanceof WriteConflict) || attempt === 4) throw error;
      current = await store.read();
    }
  }
  assert.ok(published);
  const after = await store.read();
  const report = {
    publishedAt: new Date().toISOString(), bucket: outputs.DataBucketName, etag: after.etag,
    importedEntries: incoming.entries.length, publishedEntries: after.snapshot.entries.length,
    model: DEFAULT_MODEL_ID,
    modelCounts: Object.fromEntries([...new Set(after.snapshot.entries.map(entry => entry.explanationModel ?? 'pending'))]
      .map(model => [model, after.snapshot.entries.filter(entry => (entry.explanationModel ?? 'pending') === model).length])),
    preservedCurrentEntries: before.snapshot.entries.every(entry =>
      after.snapshot.entries.some(publishedEntry => publishedEntry.id === entry.id
        || (entry.channel === 'cli' && entry.version && publishedEntry.product === entry.product
          && publishedEntry.channel === entry.channel && publishedEntry.version === entry.version))),
  };
  await writeFile('docs/backfill-publication.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

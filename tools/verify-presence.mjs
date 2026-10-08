import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { request } from '@playwright/test';

const outputs = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).CodePulse;
const base = new URL(outputs.SiteUrl).origin;
assert.equal(new URL(base).protocol, 'https:');
assert.ok(outputs.PresenceTableName);
const execute = promisify(execFile);
const aws = async args => {
  const { stdout } = await execute('aws', [
    ...args, '--region', 'ap-northeast-2', '--output', 'json',
  ], { maxBuffer: 1024 * 1024, timeout: 30_000 });
  return stdout.trim() ? JSON.parse(stdout) : {};
};
const identity = await aws(['sts', 'get-caller-identity']);
assert.equal(identity.Account, '061525506239');
const api = await request.newContext({ baseURL: base });
const headers = { origin: base, 'x-code-pulse-client': '1' };
try {
  const before = await api.get('/api/presence');
  assert.equal(before.status(), 200);
  assert.equal(before.headers()['cache-control'], 'no-store');
  const initial = await before.json();
  const state = await api.storageState();
  const cookie = state.cookies.find(item => item.name === 'code_pulse_visitor');
  assert.ok(cookie && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Lax');
  assert.equal(cookie.path, '/api/presence');
  const unsigned = decodeURIComponent(cookie.value).slice(0, decodeURIComponent(cookie.value).lastIndexOf('.'));
  assert.match(unsigned, /^[0-9a-f-]{36}$/);
  const hash = createHash('sha256').update('code-pulse:presence:v1\0').update(unsigned).digest('hex');
  const record = async partition => (await aws(['dynamodb', 'get-item', '--table-name', outputs.PresenceTableName,
    '--key', JSON.stringify({ pk: { S: `PRESENCE#${partition}` }, sk: { S: hash } }), '--consistent-read'])).Item;
  assert.equal(await record('SEEN'), undefined, 'GET must not register a visitor.');
  const first = await api.post('/api/presence', { headers, data: {} });
  assert.equal(first.status(), 200);
  assert.equal(first.headers()['cache-control'], 'no-store');
  const counted = await first.json();
  assert.equal(counted.window_seconds, 90);
  assert.ok(counted.total_visitors >= initial.total_visitors + 1 && counted.active_visitors >= 1);
  const replies = await Promise.all(Array.from({ length: 4 }, () =>
    api.post('/api/presence', { headers, data: {} })));
  assert.ok(replies.every(reply => reply.status() === 200));
  const snapshots = await Promise.all(replies.map(reply => reply.json()));
  const seen = await record('SEEN');
  const online = await record('ONLINE');
  assert.ok(Number.isFinite(Number(seen.first_seen.N)));
  assert.equal(seen.expires_at, undefined, 'The first-visit marker must survive activity expiry.');
  assert.ok(Number(online.expires_at.N) > Date.now() / 1000);
  assert.ok(Number(online.expires_at.N) - Number(online.last_seen.N) / 1000 <= 91);
  const ttl = await aws(['dynamodb', 'describe-time-to-live', '--table-name', outputs.PresenceTableName]);
  assert.equal(ttl.TimeToLiveDescription.AttributeName, 'expires_at');
  assert.ok(['ENABLED', 'ENABLING'].includes(ttl.TimeToLiveDescription.TimeToLiveStatus));
  const foreign = await api.post('/api/presence', { headers: { ...headers, origin: 'https://unrelated.example' }, data: {} });
  assert.equal(foreign.status(), 403);
  const forged = await api.post('/api/presence', { headers, data: { total_visitors: 9999 } });
  assert.equal(forged.status(), 400);
  const restored = await request.newContext({ baseURL: base, storageState: state });
  let restoredSnapshot;
  try {
    const response = await restored.post('/api/presence', { headers, data: {} });
    assert.equal(response.status(), 200);
    restoredSnapshot = await response.json();
  } finally { await restored.dispose(); }
  const markerAfter = await record('SEEN');
  assert.deepEqual(markerAfter, seen);
  const report = {
    checkedAt: new Date().toISOString(), base, table: outputs.PresenceTableName,
    secureCookie: true, httpOnlyCookie: true, cookiePath: cookie.path,
    cacheDisabled: true, getDoesNotCount: true, persistentMarker: true,
    markerPreservedAcrossRestoredClient: true, activeTtlSeconds: 90,
    ttlStatus: ttl.TimeToLiveDescription.TimeToLiveStatus,
    initial, firstVisit: counted, repeated: snapshots, restoredClient: restoredSnapshot,
    stableTotalObserved: [...snapshots, restoredSnapshot].every(snapshot => snapshot.total_visitors === counted.total_visitors),
    rejectedForeignOrigin: true, rejectedClientCount: true,
  };
  // Visitor IDs and signing values are deliberately omitted from the report.
  await writeFile('docs/presence-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await api.dispose();
}

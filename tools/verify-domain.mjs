import assert from 'node:assert/strict';
import { resolveCname } from 'node:dns/promises';
import { readFile, writeFile } from 'node:fs/promises';
import tls from 'node:tls';

const outputs = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).CodePulse;
const base = new URL(outputs.SiteUrl);
assert.equal(base.origin, 'https://code-pulse.whchoi.net');
const native = `https://${outputs.DistributionDomainName}`;
const cname = await resolveCname(base.hostname);
assert.ok(cname.includes(outputs.DistributionDomainName), 'The public CNAME must target this distribution.');

const certificate = await new Promise((resolve, reject) => {
  const socket = tls.connect({ host: base.hostname, port: 443, servername: base.hostname }, () => {
    const peer = socket.getPeerCertificate();
    const result = {
      authorized: socket.authorized,
      protocol: socket.getProtocol(),
      subject: peer.subject.CN,
      subjectAlternativeNames: peer.subjectaltname,
      validFrom: peer.valid_from,
      validTo: peer.valid_to,
    };
    socket.destroy();
    resolve(result);
  });
  socket.setTimeout(15_000, () => socket.destroy(new Error('TLS verification timed out.')));
  socket.on('error', reject);
});
assert.equal(certificate.authorized, true);
assert.match(certificate.subjectAlternativeNames, /DNS:\*\.whchoi\.net(?:,|$)/);
assert.ok(['TLSv1.2', 'TLSv1.3'].includes(certificate.protocol));

async function request(url, method = 'GET') {
  const response = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  const result = {
    url, method, status: response.status,
    location: response.headers.get('location'),
    contentType: response.headers.get('content-type'),
  };
  await response.body?.cancel();
  return result;
}

function sameDestination(actual, expected) {
  const received = new URL(actual);
  const destination = new URL(expected);
  assert.equal(received.origin, destination.origin);
  assert.equal(received.pathname, destination.pathname);
  // CloudFront groups duplicate parameters and can reorder keys. The values,
  // including the order of duplicates, must retain their original meaning.
  const parameters = url => Object.fromEntries([...new Set(url.searchParams.keys())].sort()
    .map(key => [key, url.searchParams.getAll(key)]));
  assert.deepEqual(parameters(received), parameters(destination));
}

const checks = await Promise.all([
  ...['/', '/healthz', '/api/feed', '/feed.xml', '/feed.xml?product=kiro'].map(async path => {
    const result = await request(`${base.origin}${path}`);
    assert.equal(result.status, 200, `Public path failed: ${path}`);
    assert.equal(result.location, null, `Canonical URL must not redirect: ${path}`);
    return result;
  }),
  ...['/', '/?product=codex&q=%ED%95%9C%EA%B8%80%20%26%20a%2Bb&unread=1',
    '/feed.xml?product=kiro', '/?q=one&q=two%2Fthree&saved=1'].map(async path => {
    const result = await request(`${native}${path}`);
    assert.equal(result.status, 308, `The old URL must redirect: ${path}`);
    sameDestination(result.location, `${base.origin}${path}`);
    return result;
  }),
  (async () => {
    const result = await request(`${native}/feed.xml?product=codex`, 'HEAD');
    assert.equal(result.status, 308);
    assert.equal(result.location, `${base.origin}/feed.xml?product=codex`);
    return result;
  })(),
  (async () => {
    const result = await request(`http://${base.hostname}/?product=kiro`);
    assert.ok([301, 308].includes(result.status));
    assert.equal(result.location, `${base.origin}/?product=kiro`);
    return result;
  })(),
]);

const report = {
  checkedAt: new Date().toISOString(),
  publicOrigin: base.origin,
  distributionDomain: outputs.DistributionDomainName,
  cname, certificate, checks,
};
await writeFile('docs/domain-verification.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));

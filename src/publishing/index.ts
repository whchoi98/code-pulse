import { randomUUID } from 'node:crypto';
import type { SnapshotStore, StoredSnapshot } from '../collector/store.js';
import { WriteConflict } from '../collector/store.js';
import { buildPublicContent, currentCache, digest, languages } from './projection.js';
import { readBuild } from './assets.js';
import { renderPage } from './render.js';
import { LocalSiteTarget, S3SiteTarget, type SiteAsset, type SiteTarget, type StoredSiteAsset } from './target.js';

export { buildPublicContent, publicEntryInLanguage, sourceLabelInLanguage } from './projection.js';
export { renderPage } from './render.js';
export { LocalSiteTarget, S3SiteTarget } from './target.js';
export type { SiteAsset, SiteTarget, StoredSiteAsset } from './target.js';

const controlKey = '_publication/control.json';
interface Control {
  generation: number;
  publicationId: string;
  buildId: string;
  generatedAt: string;
  phase: 'publishing' | 'complete';
  completedAt?: string;
}
export interface PublicationReport {
  status: 'published' | 'unchanged';
  records: number;
  generation: number;
  generatedAt: string;
  immutableObjects: number;
  uploadedObjects: number;
  reusedObjects: number;
  htmlPages: number;
  catalogBytes: { ko: number; en: number };
}
export interface PublicationOptions { staticDirectory: string; now?: () => Date }

function control(asset?: StoredSiteAsset): Control | undefined {
  if (!asset) return undefined;
  const value = JSON.parse(asset.body.toString()) as Control;
  if (!Number.isSafeInteger(value.generation) || value.generation < 1 || !value.publicationId || !value.buildId
    || !['publishing', 'complete'].includes(value.phase)) throw new Error('Invalid site publication control.');
  return value;
}
function controlAsset(value: Control): SiteAsset {
  return { key: controlKey, body: Buffer.from(JSON.stringify(value)), contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' };
}
async function assertSnapshot(store: SnapshotStore, original: StoredSnapshot): Promise<void> {
  const current = await store.read();
  if (original.etag !== current.etag || digest(JSON.stringify(original.snapshot)) !== digest(JSON.stringify(current.snapshot))) {
    throw new WriteConflict('The source snapshot changed during static publication. Retry from the current snapshot.');
  }
}

async function eachConcurrent<T>(values: Iterable<T>, work: (value: T) => Promise<void>, concurrency = 8): Promise<void> {
  const iterator = values[Symbol.iterator]();
  let failed: unknown;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!failed) {
      const next = iterator.next();
      if (next.done) return;
      try { await work(next.value); } catch (error) { failed = error; }
    }
  }));
  if (failed) throw failed;
}

export async function publishSite(store: SnapshotStore, target: SiteTarget, options: PublicationOptions): Promise<PublicationReport> {
  const now = options.now ?? (() => new Date());
  const stored = await store.read();
  if (!stored.snapshot.generatedAt || !Number.isFinite(Date.parse(stored.snapshot.generatedAt))) throw new Error('A collected snapshot is required for static publication.');
  if (!stored.snapshot.entries.length) throw new Error('An empty snapshot cannot replace the published site.');
  const originalControl = await target.read(controlKey);
  const prior = control(originalControl);
  if (prior && Date.parse(prior.generatedAt) > Date.parse(stored.snapshot.generatedAt)) throw new WriteConflict('An older snapshot cannot replace a newer site.');
  const content = buildPublicContent(stored.snapshot, now());
  const build = await readBuild(options.staticDirectory);
  // Include the renderer format so template changes can deliberately invalidate publication identity.
  const buildId = digest(JSON.stringify(['static-publication-v1', build.shell,
    build.assets.map(asset => [asset.key, digest(asset.body)]), content.feeds]));
  const baseReport = {
    records: stored.snapshot.entries.length, generatedAt: stored.snapshot.generatedAt,
    immutableObjects: content.objects.size + build.assets.length,
    htmlPages: stored.snapshot.entries.length * languages.length + languages.length,
    catalogBytes: { ko: Buffer.byteLength(JSON.stringify(content.feeds.ko)), en: Buffer.byteLength(JSON.stringify(content.feeds.en)) },
  };
  if (prior?.phase === 'complete' && prior.buildId === buildId) {
    await assertSnapshot(store, stored);
    return { ...baseReport, status: 'unchanged', generation: prior.generation, uploadedObjects: 0, reusedObjects: baseReport.immutableObjects };
  }
  let uploadedObjects = 0, reusedObjects = 0;
  await eachConcurrent([...build.assets, ...content.objects.values()], async asset => {
    const existing = await target.read(asset.key);
    if (existing) {
      if (!existing.body.equals(asset.body)) throw new Error(`Immutable asset content changed at ${asset.key}; use a versioned filename.`);
      reusedObjects++;
      return;
    }
    try { await target.put(asset); uploadedObjects++; }
    catch (error) {
      if (!(error instanceof WriteConflict)) throw error;
      const concurrent = await target.read(asset.key);
      if (!concurrent?.body.equals(asset.body)) throw error;
      reusedObjects++;
    }
  });
  await assertSnapshot(store, stored);
  const publication: Control = { generation: (prior?.generation ?? 0) + 1, publicationId: randomUUID(), buildId,
    generatedAt: stored.snapshot.generatedAt, phase: 'publishing' };
  const claimed = await target.put(controlAsset(publication), originalControl?.etag);
  uploadedObjects++;

  async function assertOwner(): Promise<void> {
    if (control(await target.read(controlKey))?.publicationId !== publication.publicationId) throw new WriteConflict('A newer static publisher superseded this run.');
  }
  async function mutable(asset: SiteAsset): Promise<void> {
    const existing = await target.read(asset.key);
    if (Number(existing?.metadata?.generation ?? 0) > publication.generation) throw new WriteConflict('A newer site object is already published.');
    await assertOwner();
    await target.put({ ...asset, metadata: { generation: String(publication.generation), publication: publication.publicationId } }, existing?.etag);
    uploadedObjects++;
  }
  const stamp = `<!-- code-pulse-publication:${publication.publicationId} -->`;
  function* pages(): Generator<SiteAsset> {
    for (const language of languages) {
      for (const detail of content.details[language]) {
        yield { key: `pages/${language}/${detail.id}.html`, body: Buffer.from(renderPage(build.shell, { language, detail }, build.assetUrls) + stamp),
          contentType: 'text/html; charset=utf-8', cacheControl: currentCache };
      }
      yield { key: `pages/${language}/index.html`, body: Buffer.from(renderPage(build.shell, { language, feed: content.feeds[language] }, build.assetUrls) + stamp),
        contentType: 'text/html; charset=utf-8', cacheControl: currentCache };
    }
  }
  await eachConcurrent(pages(), mutable);
  await assertSnapshot(store, stored);
  for (const language of languages) {
    // A unique marker changes the ETag even if visible bytes are otherwise unchanged.
    // This prevents an older in-flight CAS write from passing after a newer publication.
    await mutable({ key: `content/${language}/feed.json`, body: Buffer.from(JSON.stringify({ ...content.feeds[language], publicationId: publication.publicationId })),
      contentType: 'application/json; charset=utf-8', cacheControl: currentCache });
  }
  await assertSnapshot(store, stored);
  await target.put(controlAsset({ ...publication, phase: 'complete', completedAt: now().toISOString() }), claimed.etag);
  uploadedObjects++;
  return { ...baseReport, status: 'published', generation: publication.generation, uploadedObjects, reusedObjects };
}

export async function publishConfiguredSite(store: SnapshotStore): Promise<PublicationReport | undefined> {
  const bucket = process.env.SITE_BUCKET;
  const directory = process.env.SITE_DIR;
  if (!bucket && !directory) return undefined;
  if (bucket && directory) throw new Error('Choose SITE_BUCKET or SITE_DIR, not both.');
  if (bucket && bucket === process.env.DATA_BUCKET) throw new Error('SITE_BUCKET must be separate from the private snapshot bucket.');
  const target = bucket ? new S3SiteTarget(bucket) : new LocalSiteTarget(directory!);
  return publishSite(store, target, { staticDirectory: process.env.STATIC_DIR ?? './dist/public' });
}

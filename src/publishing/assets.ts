import { readdir, readFile } from 'node:fs/promises';
import { extname, join, posix, resolve } from 'node:path';
import { digest, immutableCache } from './projection.js';
import type { SiteAsset } from './target.js';

const contentTypes: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
};

export interface StaticBuild { shell: string; assets: SiteAsset[]; assetUrls: ReadonlyMap<string, string> }

/** Fingerprint the whole static dependency graph, including fixed-name CSS, logos and theme code. */
export async function readBuild(directory: string): Promise<StaticBuild> {
  const root = resolve(directory);
  let shell = await readFile(join(root, 'index.html'), 'utf8');
  if (shell.includes('/src/client/')) throw new Error('STATIC_DIR must contain a compiled frontend build.');
  const source = new Map<string, Buffer>();
  async function visit(prefix = ''): Promise<void> {
    for (const file of await readdir(join(root, prefix), { withFileTypes: true })) {
      const key = prefix ? `${prefix}/${file.name}` : file.name;
      if (file.isSymbolicLink()) throw new Error('Static build symlinks are not published.');
      if (file.isDirectory()) { await visit(key); continue; }
      if (!file.isFile() || key === 'index.html' || key.endsWith('.map') || key.startsWith('_publication/')) continue;
      source.set(key, await readFile(join(root, key)));
    }
  }
  await visit();
  const assetUrls = new Map<string, string>();
  const assets = new Map<string, SiteAsset>();
  const active = new Set<string>();
  const keys = [...source.keys()].sort((a, b) => b.length - a.length);
  function rewrite(body: string, from: string): string {
    for (const key of keys) {
      if (body.includes(`/${key}`)) body = body.replaceAll(`/${key}`, compile(key));
    }
    // Vite chunks and hand-authored CSS can also use relative file references.
    return body.replace(/(["'(])((?:\.\.?\/)[^"'()\s]+)(["')])/g, (match, start: string, path: string, end: string) => {
      const key = posix.normalize(posix.join(posix.dirname(from), path));
      return source.has(key) ? `${start}${compile(key)}${end}` : match;
    });
  }
  function compile(key: string): string {
    const ready = assetUrls.get(`/${key}`);
    if (ready) return ready;
    if (active.has(key)) throw new Error(`A static asset dependency cycle needs a bundled build: ${key}`);
    active.add(key);
    let body = source.get(key)!;
    if (['.js', '.css', '.svg'].includes(extname(key))) body = Buffer.from(rewrite(body.toString(), key));
    const versionedKey = `assets/site-${digest(body)}${extname(key)}`;
    const url = `/${versionedKey}`;
    assetUrls.set(`/${key}`, url);
    assets.set(versionedKey, { key: versionedKey, body,
      contentType: contentTypes[extname(key)] ?? 'application/octet-stream', cacheControl: immutableCache });
    active.delete(key);
    return url;
  }
  for (const key of keys) compile(key);
  shell = rewrite(shell, 'index.html');
  // Crawlers request this fixed URL directly; its allow-all policy is stable across builds.
  assets.set('robots.txt', { key: 'robots.txt', body: Buffer.from('User-agent: *\nAllow: /\n'),
    contentType: 'text/plain; charset=utf-8', cacheControl: immutableCache });
  return { shell, assets: [...assets.values()].sort((a, b) => a.key.localeCompare(b.key)), assetUrls };
}

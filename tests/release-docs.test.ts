import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseDocuments, syncReleaseDocuments } from '../tools/release-docs.mjs';

const entry = (version = '1.0.0') => ({
  version, date: '2026-10-07',
  changes: [{ category: 'Added', en: 'Add official release history.', ko: '공식 변경 기록 추가' }],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'code-pulse-release-'));
  await mkdir(join(root, 'src/shared'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'code-pulse', version: '1.0.0' }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }));
  await writeFile(join(root, 'src/shared/app-release.json'), JSON.stringify({ version: '1.0.0', releases: [entry()] }));
  await writeFile(join(root, 'README.md'), '# Code Pulse\n\nExisting project explanation.\n');
  return root;
}
describe('version and release synchronization', () => {
  it('generates matching bilingual notes and preserves README content across repeated syncs', async () => {
    const root = await fixture();
    const first = await syncReleaseDocuments(root);
    const contents = await Promise.all(first.files.map(path => readFile(join(root, path), 'utf8')));
    expect(contents.join('\n')).toContain('Add official release history.');
    expect(contents.join('\n')).toContain('공식 변경 기록 추가');
    expect(contents.join('\n')).toContain('Existing project explanation.');
    await syncReleaseDocuments(root);
    expect(await Promise.all(first.files.map(path => readFile(join(root, path), 'utf8')))).toEqual(contents);
    await expect(syncReleaseDocuments(root, true, 'v1.0.0')).resolves.toMatchObject({ version: '1.0.0', mode: 'check' });
  });
  it('rejects a manifest/lockfile mismatch before writing documents', async () => {
    const root = await fixture();
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.1.0' }));
    await expect(syncReleaseDocuments(root)).rejects.toThrow(/버전/);
    await expect(readFile(join(root, 'CHANGELOG.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('detects stale release documents and a mismatched tag in check mode', async () => {
    const root = await fixture();
    await syncReleaseDocuments(root);
    await writeFile(join(root, 'docs/releases/1.0.0.md'), 'outdated notes');
    await expect(syncReleaseDocuments(root, true)).rejects.toThrow(/동기화/);
    await expect(syncReleaseDocuments(root, true, 'v9.0.0')).rejects.toThrow(/태그/);
  });
  it('protects historical notes before making any generated change', async () => {
    const root = await fixture();
    await syncReleaseDocuments(root);
    const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.1.0' }));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '1.1.0', packages: { '': { version: '1.1.0' } } }));
    const old = entry();
    old.changes[0].en = 'Rewrite an old release without authorization.';
    await writeFile(join(root, 'src/shared/app-release.json'), JSON.stringify({ version: '1.1.0', releases: [entry('1.1.0'), old] }));
    await expect(syncReleaseDocuments(root)).rejects.toThrow(/과거/);
    expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toBe(changelog);
  });
  it('rejects invalid calendar dates and missing translations', async () => {
    const root = await fixture();
    const invalid = entry(); invalid.date = '2026-02-30';
    await writeFile(join(root, 'src/shared/app-release.json'), JSON.stringify({ version: '1.0.0', releases: [invalid] }));
    await expect(releaseDocuments(root)).rejects.toThrow(/날짜/);
    invalid.date = '2026-10-07'; invalid.changes[0].ko = '';
    await writeFile(join(root, 'src/shared/app-release.json'), JSON.stringify({ version: '1.0.0', releases: [invalid] }));
    await expect(releaseDocuments(root)).rejects.toThrow(/한국어/);
  });
});

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BADGES = '[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)';
const CATEGORIES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const versionStart = '<!-- app-version:start -->';
const versionEnd = '<!-- app-version:end -->';

export async function releaseDocuments(root) {
  const readJson = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const [manifest, lock, release] = await Promise.all([
    readJson('package.json'), readJson('package-lock.json'), readJson('src/shared/app-release.json'),
  ]);
  const version = manifest.version;
  if (!SEMVER.test(version) || lock.version !== version || lock.packages?.['']?.version !== version
    || release.version !== version || release.releases?.[0]?.version !== version) {
    throw new Error('package.json, package-lock.json과 앱 릴리스의 현재 버전이 일치해야 합니다.');
  }
  const versions = new Set();
  for (const item of release.releases) {
    if (!SEMVER.test(item.version) || versions.has(item.version)) throw new Error('릴리스 버전이 유효하지 않거나 중복됩니다.');
    versions.add(item.version);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(Date.parse(`${item.date}T00:00:00Z`))
      || new Date(`${item.date}T00:00:00Z`).toISOString().slice(0, 10) !== item.date) {
      throw new Error('확인된 릴리스 날짜를 YYYY-MM-DD로 지정해야 합니다.');
    }
    if (!item.changes?.length) throw new Error('릴리스에는 변경 내용이 필요합니다.');
    for (const change of item.changes) {
      if (!CATEGORIES.includes(change.category) || !change.en?.trim() || !change.ko?.trim()) {
        throw new Error('각 변경에는 범주와 영어, 한국어 내용이 필요합니다.');
      }
      if (/[—–·ㆍ•]/u.test(change.ko)) throw new Error('한국어 릴리스 문구의 금지 구분 기호를 제거하세요.');
    }
  }
  const changes = (item, language, level = '###') => CATEGORIES.flatMap(category => {
    const entries = item.changes.filter(change => change.category === category);
    return entries.length ? [`${level} ${category}\n\n${entries.map(change => `- ${change[language]}`).join('\n')}\n`] : [];
  }).join('\n');
  const history = language => release.releases.map(item =>
    `## [${item.version}] - ${item.date}\n\n${changes(item, language)}`).join('\n');
  const notice = {
    en: 'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).',
    ko: '이 문서는 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 형식을 바탕으로 작성하며, 프로젝트 버전은 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.',
  };
  const sourceNote = {
    en: 'These entries describe application builds. Git tags and hosted releases are verified separately by the release workflow; no repository URL is assumed.',
    ko: '아래 내용은 앱 빌드의 변경 기록입니다. Git 태그와 원격 릴리스는 릴리스 워크플로에서 별도로 확인하며 저장소 주소를 임의로 만들지 않습니다.',
  };
  const files = new Map();
  files.set('CHANGELOG.md', `# Changelog\n\n${BADGES}\n\n---\n\n# English\n\n${notice.en}\n\n${sourceNote.en}\n\n## [Unreleased]\n\n${history('en')}\n---\n\n# 한국어\n\n${notice.ko}\n\n${sourceNote.ko}\n\n## [Unreleased]\n\n${history('ko')}`);
  for (const item of release.releases) {
    files.set(`docs/releases/${item.version}.md`,
      `# Code Pulse ${item.version}\n\n${BADGES}\n\n## English\n\nApplication build: \`${item.version}\`. Date: ${item.date}.\n\n${sourceNote.en}\n\n${changes(item, 'en')}\n## 한국어\n\n앱 빌드: \`${item.version}\`. 날짜: ${item.date}.\n\n${sourceNote.ko}\n\n${changes(item, 'ko')}`);
  }
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  const versionBlock = `${versionStart}\n현재 소스 버전: **${version}**. [변경 기록](CHANGELOG.md)과 [릴리스 노트](docs/releases/${version}.md)를 함께 관리합니다.\n${versionEnd}`;
  const start = readme.indexOf(versionStart);
  const end = readme.indexOf(versionEnd);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) throw new Error('README 버전 영역이 올바르지 않습니다.');
  files.set('README.md', start >= 0
    ? `${readme.slice(0, start)}${versionBlock}${readme.slice(end + versionEnd.length)}`
    : readme.replace(/^(# [^\n]+\n)/, `$1\n${versionBlock}\n`));
  return { version, files };
}

export async function syncReleaseDocuments(root, check = false, tag) {
  const { version, files } = await releaseDocuments(root);
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`릴리스 태그는 v${version}이어야 합니다.`);
  const mismatches = [];
  const updates = [];
  for (const [path, text] of files) {
    const target = resolve(root, path);
    let existing;
    try { existing = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing === text) continue;
    if (check) { mismatches.push(path); continue; }
    if (path.startsWith('docs/releases/') && path !== `docs/releases/${version}.md` && existing !== undefined) {
      throw new Error(`과거 릴리스 노트를 자동으로 바꾸지 않습니다: ${path}`);
    }
    updates.push({ target, text });
  }
  if (mismatches.length) throw new Error(`버전 문서를 동기화하세요: ${mismatches.join(', ')}. npm run release:sync`);
  for (const { target, text } of updates) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  return { version, files: [...files.keys()], mode: check ? 'check' : 'sync' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = !args.includes('--write');
  const tagIndex = args.indexOf('--tag');
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
  if ((tagIndex >= 0 && !tag) || args.some((arg, index) =>
    !['--write', '--check', '--tag'].includes(arg) && !(tagIndex >= 0 && index === tagIndex + 1))) {
    throw new Error('지원하지 않는 릴리스 검사 옵션입니다.');
  }
  console.log(JSON.stringify(await syncReleaseDocuments(resolve(dirname(fileURLToPath(import.meta.url)), '..'), check, tag)));
}

import type { Candidate } from './sources.js';
import { isOfficialUrl } from './official-fetch.js';

export const CLAUDE_CHANGELOG_URL = 'https://code.claude.com/docs/en/changelog';
export const CLAUDE_WHATS_NEW_URL = 'https://code.claude.com/docs/ko/whats-new';

interface UpdateBlock { label: string; description?: string; attributes: string; body: string }
function updates(body: string): UpdateBlock[] {
  const blocks = [...body.matchAll(/<Update\b([^>]*)>([\s\S]*?)<\/Update>/g)].map(match => ({
    label: match[1].match(/\blabel="([^"]+)"/)?.[1] ?? '',
    description: match[1].match(/\bdescription="([^"]+)"/)?.[1],
    attributes: match[1],
    body: match[2].replace(/^ {2}/gm, '').trim(),
  }));
  if (!blocks.length) throw new Error('Claude Code 공식 문서의 Update 항목을 확인할 수 없습니다.');
  return blocks;
}

export function parseClaudeChangelog(body: string): Candidate[] {
  const entries: Candidate[] = [];
  for (const block of updates(body)) {
    const version = block.label.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version) || !block.body) continue;
    // Old entries without a full date are not assigned their collection day.
    const date = block.description ?? '';
    const explicitDay = /^\d{4}-\d{2}-\d{2}$/.test(date);
    const englishDay = /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/.test(date);
    if (!explicitDay && !englishDay) continue;
    const parsed = new Date(explicitDay ? `${date}T00:00:00Z` : `${date} 00:00:00 GMT`);
    if (Number.isNaN(parsed.getTime())) throw new Error('Claude Code 변경 기록의 발표일을 읽을 수 없습니다.');
    const publishedAt = parsed.toISOString();
    entries.push({
      product: 'claude-code', sourceId: 'claude-changelog', channel: 'cli', version,
      originalTitle: `Claude Code ${version}`, publishedAt, publishedDate: publishedAt.slice(0, 10),
      datePrecision: 'day', sourceUrl: CLAUDE_CHANGELOG_URL, originalText: block.body,
      references: [{ title: 'Claude Code 공식 변경 기록', url: CLAUDE_CHANGELOG_URL, kind: 'changelog' }],
    });
  }
  return entries;
}

function compareVersion(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

export function parseClaudeWhatsNew(body: string, known: Candidate[]): Candidate[] {
  const blocks = updates(body);
  const references: Candidate[] = [];
  let validOverview = false;
  for (const block of blocks) {
    if (!/^Week \d+$/.test(block.label)) continue;
    const tags = block.attributes.match(/\btags=\{(\[[\s\S]*?\])\}/)?.[1];
    if (!tags) continue;
    const versions = (JSON.parse(tags) as unknown[]).flatMap(tag =>
      typeof tag === 'string' ? [...tag.matchAll(/\bv?(\d+\.\d+\.\d+)\b/g)].map(match => match[1]) : []);
    if (!versions.length || !block.body) continue;
    validOverview = true;
    versions.sort(compareVersion);
    const first = versions[0];
    const last = versions.at(-1)!;
    const href = block.body.match(/\]\((\/docs\/ko\/whats-new\/[^)\s]+)\)/)?.[1];
    const url = href ? new URL(href, CLAUDE_WHATS_NEW_URL).toString() : CLAUDE_WHATS_NEW_URL;
    if (!isOfficialUrl(url)) throw new Error('Claude Code 주간 요약의 공식 주소가 아닙니다.');
    const background = {
      url,
      text: `공식 주간 요약: ${block.label}. 여러 버전 ${first} ~ ${last}의 배경 자료입니다. 개별 버전의 변경 목록은 별도로 확인합니다.\n\n${block.body.slice(0, 6000)}`,
    };
    for (const source of known) {
      if (source.product !== 'claude-code' || source.channel !== 'cli' || !source.version
        || !/^\d+\.\d+\.\d+$/.test(source.version)
        || compareVersion(source.version, first) < 0 || compareVersion(source.version, last) > 0) continue;
      references.push({
        product: source.product, sourceId: 'claude-whats-new', channel: source.channel, version: source.version,
        originalTitle: source.originalTitle, originalText: source.originalText, sourceUrl: source.sourceUrl,
        publishedAt: source.publishedAt, publishedDate: source.publishedDate, datePrecision: source.datePrecision,
        references: [
          { title: 'Claude Code 새 소식 (한국어)', url: CLAUDE_WHATS_NEW_URL, kind: 'changelog' },
          ...(url !== CLAUDE_WHATS_NEW_URL ? [{ title: `${block.label} 공식 주간 요약`, url, kind: 'changelog' as const }] : []),
        ],
        background: [background],
      });
    }
  }
  if (!validOverview) throw new Error('Claude Code 주간 요약의 버전 범위를 확인할 수 없습니다.');
  return references;
}

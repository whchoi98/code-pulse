import { describe, expect, it } from 'vitest';
import { buildSavedMarkdown, downloadSavedMarkdown } from '../src/client/export.js';
import type { FeedEntry } from '../src/shared/types.js';
import { fullChangesFixture } from './fixtures/full-changes';

const entry = (id: string, date: string): FeedEntry => ({
  id, product: 'codex', sourceId: 'codex-releases', channel: 'cli', version: '0.161.0',
  originalTitle: 'Codex CLI 0.161.0', publishedAt: `${date}T12:00:00Z`, publishedDate: date,
  datePrecision: 'timestamp', sourceUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.161.0',
  references: [], firstSeenAt: `${date}T12:00:00Z`, checkedAt: `${date}T12:00:00Z`, updatedAt: `${date}T12:00:00Z`,
  explanationStatus: 'ready', explanation: {
    title: `${id}의 변경 사항`, summary: '작업 공간 설정을 읽는 방식이 바뀌었습니다.',
    whyItMatters: '프로젝트별 설정이 적용되는 범위를 확인할 수 있습니다.',
    actionItems: ['프로젝트 설정을 확인하세요.'], highlights: [], audience: ['개발자'],
    category: 'improvement', impact: 'medium',
  },
});

describe('saved article Markdown export', () => {
  it('exports complete selected Korean notes in publication order with canonical and official links', () => {
    const older = entry('older', '2026-01-06');
    const newer = entry('newer', '2026-10-07');
    const result = buildSavedMarkdown([older, newer], 'https://code.example');
    expect(result).toContain('# Code Pulse 저장한 글');
    expect(result).toContain('총 2개');
    expect(result.indexOf('newer의 변경 사항')).toBeLessThan(result.indexOf('older의 변경 사항'));
    expect(result).toContain('2026-01-06');
    expect(result).toContain(newer.explanation!.summary);
    expect(result).toContain(newer.explanation!.whyItMatters);
    expect(result).toContain(newer.explanation!.actionItems[0]);
    expect(result).toContain('https://code.example/?entry=newer');
    expect(result).toContain(newer.sourceUrl);
    expect(result).toContain('AI 해설');
  });

  it('keeps raw sources, private model metadata and unrelated data out of the document', () => {
    const source = {
      ...entry('selected', '2026-10-07'),
      originalText: 'PRIVATE_RAW_SOURCE',
      contentHash: 'PRIVATE_CONTENT_HASH',
      explanationModel: 'PRIVATE_MODEL_ID',
    };
    const before = JSON.stringify(source);
    const result = buildSavedMarkdown([source], 'https://code.example');
    expect(result).not.toMatch(/PRIVATE_RAW_SOURCE|PRIVATE_CONTENT_HASH|PRIVATE_MODEL_ID/);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('escapes Markdown and HTML text so content cannot inject links or sections', () => {
    const source = entry('a&b', '2026-10-07');
    source.explanation!.title = '[링크](javascript:alert(1)) <script>bad</script>';
    source.explanation!.summary = '첫 문장\n# 가짜 헤딩\n<img src=x onerror=bad>';
    const result = buildSavedMarkdown([source], 'https://code.example');
    expect(result).not.toContain('](javascript:');
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('<img');
    expect(result).not.toContain('\n# 가짜 헤딩');
    expect(result).toContain('https://code.example/?entry=a%26b');
  });

  it('keeps pending notes honest and does not substitute invented explanations', () => {
    const source = { ...entry('pending', '2026-10-07'), explanation: undefined, explanationStatus: 'pending' as const };
    const result = buildSavedMarkdown([source], 'https://code.example');
    expect(result).toContain(source.originalTitle);
    expect(result).toContain('한국어 해설 준비 중');
    expect(result).toContain(source.sourceUrl);
    expect(result).not.toContain('왜 중요한가요');
  });

  it('rejects unsafe source links and an invalid app origin before creating a download', () => {
    const source = entry('unsafe', '2026-10-07');
    source.sourceUrl = 'javascript:alert(1)';
    expect(() => buildSavedMarkdown([source], 'https://code.example')).toThrow();
    expect(() => buildSavedMarkdown([entry('safe', '2026-10-07')], 'https://user:secret@code.example/path')).toThrow();
    expect(() => downloadSavedMarkdown([], 'https://code.example')).toThrow(/없습니다/);
  });

  it('preserves entity-looking queries and backslashes in Markdown link destinations', () => {
    const source = entry('special-link', '2026-10-07');
    source.sourceUrl = 'https://kiro.dev/changelog/?first=1&copy;=2#part\\_one';
    const result = buildSavedMarkdown([source], 'https://code.example');
    expect(result).toContain('[공식 원문](<https://kiro.dev/changelog/?first=1&amp;copy;=2#part%5C_one>)');
    expect(result).not.toContain('](<https://kiro.dev/changelog/?first=1&copy;=');
  });

  it('exports all 56 numbered changes alongside the short overview and official links', () => {
    const source = {
      ...entry('full-list', '2026-10-07'),
      fullChanges: fullChangesFixture(),
      references: [{ title: '공식 사용 안내', url: 'https://developers.openai.com/codex/', kind: 'blog' as const }],
    };
    const result = buildSavedMarkdown([source], 'https://code.example');
    expect(result).toContain('### 전체 변경 사항');
    expect(result).toContain('총 56개');
    expect(result.match(/^\d+\. /gm)).toHaveLength(56);
    expect(result).toContain('1. 첫 번째 변경: 작업 공간 설정을 유지합니다.');
    expect(result).toContain('56. 마지막 변경: 잔여세션정리 오류를 고쳤습니다.');
    for (const item of source.fullChanges.items) expect(result).toContain(item.text);
    expect(result).toContain(source.explanation!.summary);
    expect(result).toContain(source.explanation!.whyItMatters);
    expect(result).toContain(source.sourceUrl);
    expect(result).toContain('[공식 사용 안내](<https://developers.openai.com/codex/>)');
    expect(result).not.toMatch(/PRIVATE_FULL_SOURCE_HASH|PRIVATE_FULL_MODEL|test-full-changes-v1/);
  });

  it('exports every available pending change without claiming the complete list is ready', () => {
    const source = {
      ...entry('partial-list', '2026-10-07'),
      fullChanges: fullChangesFixture({ status: 'pending', items: fullChangesFixture().items.slice(0, 24) }),
    };
    const result = buildSavedMarkdown([source], 'https://code.example');
    expect(result).toContain('### 전체 변경 사항');
    expect(result).toContain('56개 중 24개 준비');
    expect(result).toContain('준비 중');
    expect(result.match(/^\d+\. /gm)).toHaveLength(24);
    expect(result).toContain('24. 변경 24:');
    expect(result).not.toContain('총 56개');
  });

  it.each([
    fullChangesFixture({ items: fullChangesFixture().items.slice(0, 55) }),
    fullChangesFixture({ items: Array.from({ length: 56 }, () => fullChangesFixture().items[0]) }),
    fullChangesFixture({ items: [], sourceCount: 0 }),
  ])('does not label inconsistent ready metadata as complete (%#)', fullChanges => {
    const result = buildSavedMarkdown([{ ...entry('incomplete', '2026-10-07'), fullChanges }], 'https://code.example');
    expect(result).toContain('준비 중');
    expect(result).not.toMatch(/총 (56|0)개/);
  });

  it('exports a full list even if the short explanation is still pending', () => {
    const source = {
      ...entry('full-without-summary', '2026-10-07'),
      explanation: undefined, explanationStatus: 'pending' as const, fullChanges: fullChangesFixture(),
    };
    const result = buildSavedMarkdown([source], 'https://code.example');
    expect(result).toContain('한국어 해설 준비 중');
    expect(result).toContain('56. 마지막 변경: 잔여세션정리 오류를 고쳤습니다.');
    expect(result).not.toContain('왜 중요한가요');
  });

  it('escapes each complete item without allowing Markdown or HTML injection', () => {
    const source = {
      ...entry('unsafe-item', '2026-10-07'),
      fullChanges: fullChangesFixture({ sourceCount: 1, items: [{
        id: 'unsafe', text: '설정 `--flag`를 확인하세요.\n# 가짜 제목\n[링크](javascript:alert(1)) <img src=x onerror=bad>',
      }] }),
    };
    const result = buildSavedMarkdown([source], 'https://code.example');
    expect(result).toContain('1. 설정');
    expect(result).toContain('--flag');
    expect(result).toContain('&lt;img');
    expect(result).not.toMatch(/<img|\n# 가짜 제목|\]\(javascript:/);
  });

  it('keeps legacy exports usable without claiming full coverage', () => {
    const source = entry('legacy', '2026-10-07');
    const result = buildSavedMarkdown([source], 'https://code.example');
    expect(result).toContain(source.explanation!.summary);
    expect(result).toContain(source.sourceUrl);
    expect(result).not.toContain('전체 변경 사항');
  });
});

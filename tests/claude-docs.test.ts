import { describe, expect, it } from 'vitest';
import { parseClaudeChangelog, parseClaudeWhatsNew } from '../src/collector/claude-docs.js';
import type { Candidate } from '../src/collector/sources.js';

const known = (version: string, date: string): Candidate => ({
  product: 'claude-code', sourceId: 'claude-releases', channel: 'cli', version,
  originalTitle: `v${version}`, publishedAt: `${date}T15:30:00.000Z`, publishedDate: date,
  datePrecision: 'timestamp', sourceUrl: `https://github.com/anthropics/claude-code/releases/tag/v${version}`,
  originalText: 'Added plugin evaluation.', references: [],
});

describe('user-selected Claude Code documentation', () => {
  it('reads dated stable versions from the official MDX changelog without creating dates for undated releases', () => {
    const input = `# Claude Code changelog
<Update label="2.1.293" description="October 7, 2026">
  * Added Claude Haiku 5.5.
  * Fixed context compaction.
</Update>
<Update label="2.1.294-beta.1" description="October 7, 2026">
  * Preview release.
</Update>
<Update label="1.0.0">
  * Old release without a publication date.
</Update>`;
    const entries = parseClaudeChangelog(input);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      product: 'claude-code', sourceId: 'claude-changelog', channel: 'cli', version: '2.1.293',
      publishedAt: '2026-10-07T00:00:00.000Z', publishedDate: '2026-10-07', datePrecision: 'day',
      sourceUrl: 'https://code.claude.com/docs/en/changelog',
    });
    expect(entries[0].originalText).toContain('Added Claude Haiku 5.5.');
  });
  it('matches the Korean weekly overview to known versions and preserves their real release timestamps', () => {
    const input = `<Update label="Week 37" description="2026년 9월 7–11일" tags={["v2.1.263–v2.1.269"]}>
  **플러그인 평가**: 플러그인을 테스트 케이스에 실행합니다.
  [주간 요약 읽기](/docs/ko/whats-new/2026-w37)
</Update>`;
    const entries = parseClaudeWhatsNew(input, [
      known('2.1.262', '2026-09-05'), known('2.1.263', '2026-09-06'),
      known('2.1.269', '2026-09-11'), known('2.1.270', '2026-09-12'),
    ]);
    expect(entries.map(entry => entry.version)).toEqual(['2.1.263', '2.1.269']);
    expect(entries[0].publishedAt).toBe('2026-09-06T15:30:00.000Z');
    expect(entries[0].originalText).toBe('Added plugin evaluation.');
    expect(entries[0].references.map(reference => reference.url)).toContain('https://code.claude.com/docs/ko/whats-new');
    expect(entries[0].background?.[0]).toMatchObject({ url: 'https://code.claude.com/docs/ko/whats-new/2026-w37' });
    expect(entries[0].background?.[0].text).toContain('플러그인을 테스트 케이스에 실행합니다');
    expect(entries[0].background?.[0].text).toContain('2.1.263');
  });
  it('does not turn the end of a weekly coverage range into an invented publication day', () => {
    const input = `<Update label="Week 37" description="2026년 9월 7–11일" tags={["v2.1.263–v2.1.269"]}>주간 기능 요약</Update>`;
    expect(parseClaudeWhatsNew(input, [])).toEqual([]);
    expect(() => parseClaudeWhatsNew('<html>temporary error</html>', [])).toThrow();
    expect(() => parseClaudeChangelog('# unexpected content')).toThrow();
  });
});

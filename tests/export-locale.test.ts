import { describe, expect, it } from 'vitest';
import type { FeedEntry } from '../src/shared/types';
import { buildSavedMarkdown } from '../src/client/export';

const source: FeedEntry = {
  id: 'english-source', product: 'codex', channel: 'app', language: 'en', contentKind: 'source',
  sourceId: 'codex', originalTitle: 'App release', version: '2.0', publishedAt: '2026-10-09',
  publishedDate: '2026-10-09', datePrecision: 'day', sourceUrl: 'https://developers.openai.com/codex/changelog/',
  references: [{ kind: 'blog', title: 'Official documentation', url: 'https://developers.openai.com/codex/' }],
  firstSeenAt: '2026-10-09T00:00:00Z', checkedAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
  explanationStatus: 'ready', explanation: {
    title: 'App release', summary: 'Added workspace approval previews.', category: 'feature', impact: 'low',
    whyItMatters: '', highlights: [], actionItems: [], audience: [],
  },
  fullChanges: { status: 'ready', sourceCount: 2, formatVersion: 'official-v1', updatedAt: '2026-10-09T00:00:00Z',
    items: [{ id: 'one', text: 'Added approval previews.' }, { id: 'two', text: 'Fixed retry behavior for `--workspace`.' }] },
};

describe('language-aware saved Markdown', () => {
  it('labels complete English source text accurately and omits empty AI explanation sections', () => {
    const markdown = buildSavedMarkdown([source], 'https://code.example', 'en');
    expect(markdown).toContain('# Code Pulse saved articles');
    expect(markdown).toContain('Official source');
    expect(markdown).toContain('2 changes');
    expect(markdown).toContain('2. Fixed retry behavior');
    expect(markdown).toContain('- Product: Codex (App)');
    expect(markdown).toContain('?entry=english-source&lang=en');
    expect(markdown).toContain(source.references[0].url);
    expect(markdown).not.toMatch(/[가-힣]|Why it matters|AI commentary|Highlights/);
  });

  it('distinguishes unavailable source inventory from pending Korean commentary', () => {
    const markdown = buildSavedMarkdown([{ ...source, fullChanges: { ...source.fullChanges!, status: 'pending', items: [] } }], 'https://code.example', 'en');
    expect(markdown).toContain('0 of 2');
    expect(markdown).toContain('official source');
    expect(markdown).not.toMatch(/[가-힣]|Korean commentary|AI commentary/);
  });

  it('pins Korean export links so a recipient’s English preference cannot change their language', () => {
    const korean: FeedEntry = {
      ...source, language: 'ko', contentKind: 'explanation',
      explanation: { ...source.explanation!, title: '승인 미리 보기 추가', summary: '작업 공간의 승인 내용을 미리 볼 수 있습니다.' },
      fullChanges: { ...source.fullChanges!, sourceCount: 1, items: [{ id: 'one', text: '승인 내용을 미리 볼 수 있습니다.' }] },
    };
    expect(buildSavedMarkdown([korean], 'https://code.example', 'ko')).toContain('?entry=english-source&lang=ko');
  });
});

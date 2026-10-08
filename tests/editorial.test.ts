import { describe, expect, it } from 'vitest';
import { mergeEditorialEdit } from '../tools/editorial-merge.js';
import type { Entry, Explanation } from '../src/shared/types.js';

const explanation: Explanation = {
  title: '작업 공간의 접근 범위를 지정합니다',
  summary: 'Codex CLI에서 작업 공간의 접근 범위를 지정할 수 있습니다.',
  whyItMatters: '작업에 필요한 디렉터리의 접근 범위를 조정할 수 있습니다.',
  actionItems: ['작업 공간의 접근 설정을 확인하세요.'],
  highlights: [{ title: '작업 공간 설정', detail: '작업 공간의 접근 범위를 지정합니다.', evidence: 'Codex CLI adds workspace controls.' }],
  audience: ['Codex CLI 사용자'], category: 'feature', impact: 'medium',
};

function entry(): Entry {
  return {
    id: 'codex-release-161', product: 'codex', channel: 'cli', sourceId: 'codex-releases', version: '0.161.0',
    originalTitle: '0.161.0', originalText: 'Codex CLI adds workspace controls.', contentHash: 'verified-original-hash',
    sourceUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.161.0',
    references: [{ title: 'Codex 공식 릴리스', kind: 'release', url: 'https://github.com/openai/codex/releases/tag/rust-v0.161.0' }],
    publishedAt: '2026-10-07T15:58:45.000Z', publishedDate: '2026-10-07', datePrecision: 'timestamp',
    firstSeenAt: '2026-10-07T16:00:00.000Z', checkedAt: '2026-10-07T19:20:00.000Z', updatedAt: '2026-10-07T16:00:00.000Z',
    explanation, explanationStatus: 'ready', explanationModel: 'current-source-model',
    editorialVersion: 'human-ton-2', explanationEditedAt: '2026-10-07T19:10:00.000Z',
  };
}

describe('editorial persistence', () => {
  it.each([
    ['older', '2026-10-07T19:05:00.000Z'],
    ['equally dated', '2026-10-07T19:10:00.000Z'],
    ['undated', undefined],
  ])('preserves the reloaded explanation when a cached edit is %s', (_label, explanationEditedAt) => {
    const current = entry();
    const cached: Entry = {
      ...current, explanation: { ...explanation, title: '이전에 생성한 오래된 해설입니다' },
      explanationModel: 'stale-source-model', editorialVersion: 'human-ton-1', explanationEditedAt,
    };

    expect(mergeEditorialEdit(current, cached)).toEqual(current);
  });

  it('rejects a newer edit when the verified source hash has changed', () => {
    const current: Entry = {
      ...entry(), originalText: 'Codex CLI adds workspace controls. Fixed permissions.', contentHash: 'revised-source-hash',
      updatedAt: '2026-10-07T19:15:00.000Z', explanation: undefined, explanationStatus: 'pending',
      explanationModel: undefined, editorialVersion: undefined, explanationEditedAt: undefined,
    };
    const cached: Entry = {
      ...entry(), explanation: { ...explanation, title: '이전 원문을 뒤늦게 윤문했습니다' },
      editorialVersion: 'human-ton-3', explanationEditedAt: '2026-10-07T19:21:00.000Z',
    };

    expect(mergeEditorialEdit(current, cached)).toEqual(current);
  });

  it('applies a newer edit while retaining the current source fields and model provenance', () => {
    const current = entry();
    const revised = { ...explanation, title: '접근 범위를 작업에 맞게 조정할 수 있습니다' };
    const cached: Entry = {
      ...current, sourceId: 'codex-changelog', sourceUrl: 'https://developers.openai.com/codex/changelog/#release-161',
      publishedAt: '2026-10-07T00:00:00.000Z', datePrecision: 'day', references: [],
      firstSeenAt: '2026-10-07T17:00:00.000Z', checkedAt: '2026-10-07T18:00:00.000Z', updatedAt: '2026-10-07T17:00:00.000Z',
      explanation: revised, explanationModel: 'stale-source-model',
      editorialVersion: 'human-ton-3', explanationEditedAt: '2026-10-07T19:21:00.000Z',
    };

    expect(mergeEditorialEdit(current, cached)).toEqual({
      ...current, explanation: revised, editorialVersion: 'human-ton-3',
      explanationEditedAt: '2026-10-07T19:21:00.000Z',
    });
    expect(current.explanation?.title).toBe('작업 공간의 접근 범위를 지정합니다');
  });

  it('applies a dated edit to a legacy explanation that has no edit timestamp', () => {
    const current = { ...entry(), explanationEditedAt: undefined };
    const revised = { ...explanation, title: '기존 해설을 처음으로 윤문했습니다' };
    const cached = {
      ...current, explanation: revised, editorialVersion: 'human-ton-3',
      explanationEditedAt: '2026-10-07T19:21:00.000Z',
    };

    expect(mergeEditorialEdit(current, cached)).toEqual(cached);
  });

  it('leaves an entry unchanged when this editor has no pending edit for it', () => {
    const current = entry();

    expect(mergeEditorialEdit(current, undefined)).toEqual(current);
  });
});

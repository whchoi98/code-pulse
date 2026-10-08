import type { Page } from '@playwright/test';
import type { Entry, Feed } from '../../src/shared/types';

// These entries are invented exclusively for browser interaction tests.
// Production content is always provided by the collector's API.
export const entries: Entry[] = [
  {
    id: 'kiro-day',
    product: 'kiro',
    channel: 'ide',
    sourceId: 'kiro',
    version: '0.8',
    originalTitle: 'IDE configuration fix',
    publishedAt: '2026-10-05',
    publishedDate: '2026-10-05',
    datePrecision: 'day',
    sourceUrl: 'https://kiro.dev/changelog/',
    references: [],
    originalText: 'Fixed workspace settings being reset after restarting the IDE.',
    contentHash: 'test-kiro',
    firstSeenAt: '2026-10-07T00:00:00Z',
    checkedAt: '2026-10-07T00:10:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
    explanationStatus: 'ready',
    explanation: {
      title: '다시 열어도 유지되는 작업 공간 설정',
      summary: 'IDE를 다시 실행했을 때 작업 공간 설정이 초기화되던 문제를 고쳤습니다.',
      whyItMatters: '프로젝트마다 지정한 설정을 다시 입력할 필요가 줄어듭니다.',
      actionItems: ['작업 공간 설정을 바꾸고 IDE를 다시 열어 유지되는지 확인하세요.'],
      highlights: [{
        title: '설정 초기화 오류 수정',
        detail: '재시작 후에도 작업 공간 설정을 유지합니다.',
        evidence: 'Fixed workspace settings being reset after restarting the IDE.',
      }],
      audience: ['IDE 사용자'],
      category: 'fix',
      impact: 'low',
    },
  },
  {
    id: 'claude-latest',
    product: 'claude-code',
    channel: 'cli',
    sourceId: 'claude-releases',
    version: '2.1.0',
    originalTitle: 'Claude Code 2.1.0',
    publishedAt: '2026-10-07T00:05:00Z',
    publishedDate: '2026-10-07',
    datePrecision: 'timestamp',
    sourceUrl: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.0',
    references: [{ title: 'Claude Code release', url: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.0', kind: 'release' }],
    originalText: 'Added workspace instruction previews before starting a session.',
    contentHash: 'test-claude',
    firstSeenAt: '2026-10-07T00:10:00Z',
    checkedAt: '2026-10-07T00:10:00Z',
    updatedAt: '2026-10-07T00:10:00Z',
    explanationStatus: 'ready',
    explanationModel: 'test-model',
    explanation: {
      title: '작업을 시작하기 전에 지침을 확인하세요',
      summary: '세션을 시작하기 전에 작업 공간에 적용할 지침을 미리 볼 수 있습니다.',
      whyItMatters: '어떤 지침을 읽었는지 확인하고 작업을 시작할 수 있습니다.',
      actionItems: ['새 세션에서 적용할 지침이 맞는지 확인하세요.'],
      highlights: [{
        title: '작업 공간 지침 미리 보기',
        detail: '세션 시작 전에 적용할 지침을 보여줍니다.',
        evidence: 'Added workspace instruction previews before starting a session.',
      }],
      audience: ['CLI 사용자'],
      category: 'feature',
      impact: 'medium',
    },
  },
  {
    id: 'codex-security',
    product: 'codex',
    channel: 'cli',
    sourceId: 'codex-releases',
    version: '0.110.0',
    originalTitle: 'Codex CLI 0.110.0',
    publishedAt: '2026-10-06T02:00:00Z',
    publishedDate: '2026-10-06',
    datePrecision: 'timestamp',
    sourceUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.110.0',
    references: [],
    originalText: 'Require approval before accessing directories outside the workspace.',
    contentHash: 'test-codex',
    firstSeenAt: '2026-10-06T03:00:00Z',
    checkedAt: '2026-10-07T00:10:00Z',
    updatedAt: '2026-10-06T03:00:00Z',
    explanationStatus: 'ready',
    explanation: {
      title: '작업 폴더 밖의 파일 접근을 확인합니다',
      summary: '작업 공간 밖의 디렉터리에 접근하기 전에 승인을 요청합니다.',
      whyItMatters: '다른 프로젝트의 파일을 읽기 전에 접근 범위를 확인할 수 있습니다.',
      actionItems: ['승인 요청에서 대상 폴더를 확인하세요.'],
      highlights: [{
        title: '외부 디렉터리 접근 승인',
        detail: '작업 폴더 밖의 디렉터리 접근에 승인이 필요합니다.',
        evidence: 'Require approval before accessing directories outside the workspace.',
      }],
      audience: ['CLI 사용자'],
      category: 'security',
      impact: 'high',
    },
  },
  {
    id: 'claude-older',
    product: 'claude-code',
    channel: 'cli',
    sourceId: 'claude-releases',
    version: '2.0.9',
    originalTitle: 'Claude Code 2.0.9',
    publishedAt: '2026-09-29T08:00:00Z',
    publishedDate: '2026-09-29',
    datePrecision: 'timestamp',
    sourceUrl: 'https://github.com/anthropics/claude-code/releases/tag/v2.0.9',
    references: [],
    originalText: 'Improved terminal output rendering.',
    contentHash: 'test-older',
    firstSeenAt: '2026-10-07T00:00:00Z',
    checkedAt: '2026-10-07T00:10:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
    explanationStatus: 'pending',
  },
];

export const feed: Feed = {
  generatedAt: '2026-10-07T00:10:00Z',
  entries: entries.map(({ originalText: _text, contentHash: _hash, explanationModel: _model, ...entry }) => entry),
  sources: [
    { id: 'claude-releases', product: 'claude-code', name: 'Claude Code GitHub Releases', url: 'https://github.com/anthropics/claude-code/releases', state: 'ok', checkedAt: '2026-10-07T00:10:00Z', lastSuccessAt: '2026-10-07T00:10:00Z', latestPublishedDate: '2026-10-07', entryCount: 2 },
    { id: 'codex-releases', product: 'codex', name: 'Codex GitHub Releases', url: 'https://github.com/openai/codex/releases', state: 'ok', checkedAt: '2026-10-07T00:10:00Z', lastSuccessAt: '2026-10-07T00:10:00Z', latestPublishedDate: '2026-10-06', entryCount: 1 },
    { id: 'kiro', product: 'kiro', name: 'Kiro changelog', url: 'https://kiro.dev/changelog/', state: 'ok', checkedAt: '2026-10-07T00:10:00Z', lastSuccessAt: '2026-10-07T00:10:00Z', latestPublishedDate: '2026-10-05', entryCount: 1 },
  ],
  latestRun: {
    id: 'test-run',
    startedAt: '2026-10-07T00:00:00Z',
    completedAt: '2026-10-07T00:10:00Z',
    status: 'success',
    newEntries: 3,
    updatedEntries: 0,
    summarizedEntries: 3,
    failedSources: [],
  },
  schedule: { timezone: 'Asia/Seoul', hour: 9 },
  stale: false,
};

export const presence = {
  active_visitors: 2,
  total_visitors: 42,
  as_of: '2026-10-07T03:00:00Z',
  window_seconds: 90,
  counting_since: '2026-10-01T00:00:00Z',
};

export async function mockApi(page: Page, response: Feed = feed, options: { clock?: 'fixed' | 'controlled'; presence?: boolean } = {}) {
  if (options.clock === 'controlled') await page.clock.install({ time: new Date('2026-10-07T03:00:00Z') });
  else await page.clock.setFixedTime(new Date('2026-10-07T03:00:00Z'));
  await page.route('**/api/feed', route => route.fulfill({ json: response }));
  if (options.presence !== false) {
    await page.route('**/api/presence', route => route.fulfill({
      json: presence,
      headers: route.request().method() === 'GET'
        ? { 'set-cookie': 'code-pulse-test-visitor=known; Path=/; HttpOnly; SameSite=Lax' }
        : {},
    }));
  }
  await page.route('**/api/entries/*', route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    const entry = entries.find(item => item.id === id);
    return entry
      ? route.fulfill({ json: entry })
      : route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
}

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { createServer } from '../src/server/app.js';
import { emptySnapshot, type SnapshotStore } from '../src/collector/store.js';
import { createChatTools, runChatAgent, searchTerms, type ChatModel, type ModelEvent } from '../src/server/chat.js';
import type { ChatEvent, Entry, FeedEntry } from '../src/shared/types.js';

const entry = (id: string, product: Entry['product'], version: string, date: string, title: string, summary: string, items: string[]): Entry => ({
  id, product, channel: 'cli', sourceId: `${product}-releases`, version, originalTitle: `${product} ${version}`,
  publishedAt: `${date}T00:00:00Z`, publishedDate: date, datePrecision: 'timestamp', sourceUrl: `https://example.com/${id}`,
  references: [], originalText: items.join('\n'), contentHash: `private-hash-${id}`, firstSeenAt: `${date}T01:00:00Z`,
  checkedAt: `${date}T01:00:00Z`, updatedAt: `${date}T01:00:00Z`, explanationStatus: 'ready', explanationModel: 'private-model',
  explanation: { title, summary, whyItMatters: '작업 흐름이 달라집니다.', actionItems: [], highlights: [], audience: [], category: 'feature', impact: 'medium' },
  fullChanges: { status: 'ready', sourceHash: `private-hash-${id}`, model: 'private-model', formatVersion: 'test', updatedAt: `${date}T01:00:00Z`, sourceCount: items.length, items: items.map((text, index) => ({ id: `${id}-${index}`, text })) },
});
const records = [
  entry('claude-code-210', 'claude-code', '2.1.0', '2026-10-07', '훅에서 작업 결과를 확인합니다', 'PostToolUse 훅이 도구 결과를 받습니다.', ['PostToolUse 훅에 도구 결과를 전달합니다.']),
  entry('claude-code-209', 'claude-code', '2.0.9', '2026-09-29', '터미널 출력 개선', '긴 출력의 렌더링을 고쳤습니다.', ['터미널 출력 렌더링을 개선했습니다.']),
  entry('codex-0110', 'codex', '0.110.0', '2026-10-06', '작업 폴더 밖 접근 승인', '외부 디렉터리 접근 전에 승인을 요청합니다.', ['외부 디렉터리 접근에 승인이 필요합니다.']),
];
const visible = (language: 'ko' | 'en' = 'ko') => records.map(({ originalText: _t, contentHash: _h, explanationModel: _m, fullChanges, ...rest }) => ({
  ...rest, language, fullChanges: fullChanges && { status: fullChanges.status, formatVersion: fullChanges.formatVersion, updatedAt: fullChanges.updatedAt, sourceCount: fullChanges.sourceCount, items: fullChanges.items },
})) as FeedEntry[];

/** Replays one scripted model turn per call and records what it was given. */
function scriptedModel(turns: ModelEvent[][]): ChatModel & { calls: { system: string; messages: Message[] }[] } {
  const calls: { system: string; messages: Message[] }[] = [];
  return {
    calls,
    async *stream(input) {
      calls.push({ system: input.system, messages: structuredClone(input.messages) });
      for (const event of turns[calls.length - 1] ?? [{ type: 'text', text: '끝' }]) yield event;
    },
  };
}
async function collect(events: AsyncIterable<ChatEvent>) {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('chat tools', () => {
  it('finds versions by exact number or prefix and searches Korean words without particles', () => {
    const tools = createChatTools(visible());
    expect(tools.run('find_version', { version: 'v2.1.0' }).result).toMatchObject({ total: 1, matches: [{ id: 'claude-code-210' }] });
    expect(tools.run('find_version', { version: '2', product: 'claude-code' }).result).toMatchObject({ total: 2 });
    expect(searchTerms('훅을 어떻게 쓰나요?')).toContain('훅');
    const search = tools.run('search_changes', { query: 'PostToolUse 훅을' });
    expect(search.ok).toBe(true);
    expect((search.result as { matches: { id: string }[] }).matches[0]!.id).toBe('claude-code-210');
    expect(tools.run('list_recent', { product: 'codex' }).result).toMatchObject({ entries: [{ id: 'codex-0110' }] });
  });

  it('returns validation errors to the model instead of throwing and never exposes private fields', () => {
    const tools = createChatTools(visible());
    expect(tools.run('get_entry', { id: '../../etc' })).toMatchObject({ ok: false });
    expect(tools.run('drop_table', {})).toMatchObject({ ok: false });
    const detail = JSON.stringify(tools.run('get_entry', { id: 'claude-code-210' }).result);
    expect(detail).toContain('PostToolUse 훅에 도구 결과를 전달합니다.');
    expect(detail).not.toMatch(/private-hash|private-model/);
  });
});

describe('chat agent loop', () => {
  it('runs a tool, feeds its result back and cites the entry it linked', async () => {
    const model = scriptedModel([
      [{ type: 'text', text: '찾아보겠습니다.' }, { type: 'tool', id: 't1', name: 'find_version', input: { version: '2.1.0', product: 'claude-code' } }, { type: 'stop', reason: 'tool_use' }],
      [{ type: 'text', text: '2.1.0에서는 ' }, { type: 'text', text: '[훅 변경](?entry=claude-code-210)이 추가됐습니다.' }],
    ]);
    const events = await collect(runChatAgent(model, { language: 'ko', messages: [{ role: 'user', content: '2.1.0 버전 알려줘' }] }, visible(), { now: new Date('2026-10-21T00:00:00Z'), signal: new AbortController().signal }));

    // Narration before a tool call is retracted so only the final answer remains.
    const retracted = events.findIndex(event => event.type === 'retract');
    expect(events.slice(0, retracted)).toContainEqual({ type: 'delta', text: '찾아보겠습니다.' });
    expect(events.slice(retracted).filter(event => event.type === 'delta').map(event => (event as { text: string }).text).join('')).toBe('2.1.0에서는 [훅 변경](?entry=claude-code-210)이 추가됐습니다.');
    expect(events).toContainEqual({ type: 'tool', name: 'find_version', input: { version: '2.1.0', product: 'claude-code' } });
    expect(events.at(-2)).toEqual({ type: 'sources', sources: [{ id: 'claude-code-210', product: 'claude-code', version: '2.1.0', title: '훅에서 작업 결과를 확인합니다', publishedDate: '2026-10-07' }] });
    expect(events.at(-1)).toEqual({ type: 'done' });
    const second = model.calls[1]!.messages;
    expect(second.at(-2)!.content!.find(block => block.toolUse)?.toolUse).toMatchObject({ toolUseId: 't1', name: 'find_version' });
    expect(second.at(-1)!.content![0]!.toolResult).toMatchObject({ toolUseId: 't1', status: 'success' });
    expect(model.calls[0]!.system).toContain('2026-10-21');
  });

  it('describes the article the reader is viewing and stops after the round limit', async () => {
    const looping = scriptedModel(Array.from({ length: 6 }, (_, index) => [{ type: 'tool' as const, id: `t${index}`, name: 'list_recent', input: {} }]));
    const events = await collect(runChatAgent(looping, { language: 'en', entryId: 'codex-0110', messages: [{ role: 'user', content: 'Explain this' }] }, visible('en'), { now: new Date(), signal: new AbortController().signal }));
    expect(looping.calls[0]!.system).toContain('id codex-0110');
    expect(looping.calls).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('narrower') });
  });
});

describe('POST /api/chat', () => {
  const servers: FastifyInstance[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(app => app.close())); });
  const store: SnapshotStore = { read: async () => ({ snapshot: { ...emptySnapshot(), entries: records } }), write: async () => {} };
  async function server(model: ChatModel, chat = {}) {
    const app = await createServer(store, { staticDirectory: false, presence: { secret: 'x'.repeat(40) }, chat: { model, ...chat } });
    servers.push(app);
    return app;
  }
  const headers = { origin: 'http://localhost', 'x-code-pulse-client': '1', 'content-type': 'application/json' };
  const payload = { language: 'ko', messages: [{ role: 'user', content: 'Codex 최근 변화' }] };

  it('streams uncompressed newline-delimited events without caching', async () => {
    const app = await server(scriptedModel([[{ type: 'text', text: '최근 Codex는 승인 절차를 추가했습니다.' }]]));
    const response = await app.inject({ method: 'POST', url: '/api/chat', headers: { ...headers, 'accept-encoding': 'gzip' }, payload });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    const events = response.body.trim().split('\n').map(line => JSON.parse(line));
    expect(events[0]).toEqual({ type: 'start' });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('rejects cross-site requests, malformed conversations and excess load', async () => {
    const app = await server(scriptedModel([]), { maxPerMinute: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/chat', headers: { ...headers, origin: 'https://evil.example' }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/chat', headers: { origin: headers.origin, 'content-type': headers['content-type'] }, payload })).statusCode).toBe(403);
    for (const body of [
      { language: 'ko', messages: [{ role: 'assistant', content: '안녕' }] },
      { language: 'ko', messages: [{ role: 'user', content: 'x'.repeat(2001) }] },
      { language: 'fr', messages: [{ role: 'user', content: 'hi' }] },
      { ...payload, extra: true },
    ]) expect((await app.inject({ method: 'POST', url: '/api/chat', headers, payload: body })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/chat', headers, payload })).statusCode).toBe(200);
    const limited = await app.inject({ method: 'POST', url: '/api/chat', headers, payload });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('20');
  });

  it('reports a model failure as an explicit stream event', async () => {
    const failing: ChatModel = { async *stream() { throw new Error('throttled'); } };
    const app = await server(failing);
    const response = await app.inject({ method: 'POST', url: '/api/chat', headers, payload });
    const events = response.body.trim().split('\n').map(line => JSON.parse(line));
    expect(events.at(-1)).toEqual({ type: 'error', message: expect.stringContaining('AI 에이전트') });
  });
});

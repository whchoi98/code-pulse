import { describe, expect, it } from 'vitest';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { BedrockExplainer, editModelOutput, shortenModelQuotes, validateExplanation } from '../src/collector/explanation.js';
import type { Candidate } from '../src/collector/sources.js';
const candidate: Candidate = {
  product: 'claude-code', sourceId: 'claude-releases', channel: 'cli',
  originalTitle: 'v2.1.292', publishedDate: '2026-10-06', publishedAt: '2026-10-06T00:00:00Z',
  datePrecision: 'timestamp', sourceUrl: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.292',
  references: [], originalText: 'Added an effort parameter to the Agent tool. Fixed permission checks.',
};
const valid = {
  title: '하위 에이전트의 작업 강도를 지정합니다',
  summary: 'Agent 도구에 effort 매개변수가 추가됐습니다.',
  whyItMatters: '작업마다 하위 에이전트의 추론 강도를 다르게 지정할 수 있습니다.',
  actionItems: ['하위 에이전트에게 맡길 작업에 맞춰 강도를 정해 보세요.'],
  highlights: [{ title: '작업 강도 설정', detail: 'Agent 도구가 effort 값을 받습니다.', evidence: 'Added an effort parameter' }],
  audience: ['Claude Code 사용자'], category: 'feature', impact: 'medium',
};
describe('grounded Korean explanations', () => {
  it('removes editorial separator punctuation while preserving quoted evidence, commands and input data', () => {
    const source = { ...candidate, originalText: `${candidate.originalText} Name — exact quote. flag–value` };
    const draft = {
      ...valid, title: '기능·설정 — 변경 사항',
      summary: '1–3단계와 GPT–6 설정을 확인합니다.',
      actionItems: ['원문의 `flag–value`를 확인합니다.'],
      highlights: [{ title: '변경ㆍ설정 안내', detail: '설정・도구가 바뀝니다.', evidence: 'Name — exact quote.' }],
    };
    const before = structuredClone(draft);
    const edited = validateExplanation(editModelOutput(draft), source);
    expect(edited.title).toBe('기능, 설정, 변경 사항');
    expect(edited.summary).toBe('1~3단계와 GPT-6 설정을 확인합니다.');
    expect(edited.actionItems[0]).toContain('`flag–value`');
    expect(edited.highlights[0].evidence).toBe('Name — exact quote.');
    expect(draft).toEqual(before);
  });
  it('keeps the first three selected highlights within the requested editorial limit', () => {
    const draft = { ...valid, highlights: Array.from({ length: 4 }, (_, index) => ({ ...valid.highlights[0], title: `변경 사항 ${index + 1}` })) };
    const edited = validateExplanation(shortenModelQuotes(editModelOutput(draft)), candidate);
    expect(edited.highlights.map(item => item.title)).toEqual(['변경 사항 1', '변경 사항 2', '변경 사항 3']);
    expect(draft.highlights).toHaveLength(4);
  });
  it('accepts plain Korean prose supported by an exact source fragment', () => {
    expect(validateExplanation(valid, candidate).title).toBe(valid.title);
  });
  it('rejects a fabricated quotation even when the Korean summary looks plausible', () => {
    expect(() => validateExplanation({ ...valid, highlights: [{ ...valid.highlights[0], evidence: 'Runs twice as fast' }] }, candidate)).toThrow(/근거/);
  });
  it.each(['기능—개선', '기능·개선', '기능ㆍ개선', '기능 • 개선'])('rejects prohibited punctuation in generated prose: %s', title => {
    expect(() => validateExplanation({ ...valid, title }, candidate)).toThrow();
  });
  it('rejects invented command syntax and English-only explanations', () => {
    expect(() => validateExplanation({ ...valid, actionItems: ['`claude --magic-mode`를 실행합니다.'] }, candidate)).toThrow(/코드/);
    expect(() => validateExplanation({ ...valid, title: 'New agent support' }, candidate)).toThrow();
  });
  it('keeps direct quotations short and does not accept unbounded copied text', () => {
    const long = 'word '.repeat(30).trim();
    expect(() => validateExplanation({ ...valid, highlights: [{ ...valid.highlights[0], evidence: long }] }, { ...candidate, originalText: long })).toThrow();
  });
  it('shortens model excerpts deterministically while retaining exact source fragments', () => {
    const text = 'Added a new way to configure the effort level for each subagent in a workflow.';
    const model = { ...valid, highlights: [1, 2, 3].map(() => ({ ...valid.highlights[0], evidence: text })) };
    const result = validateExplanation(shortenModelQuotes(model), { ...candidate, originalText: text });
    expect(result.highlights.map(highlight => highlight.evidence)).toEqual([
      'Added a new way to configure the effort',
      'Added a new way to configure the effort',
      'Added a new way to configure the effort',
    ]);
    expect(result.summary).toBe(valid.summary);
  });
  it('applies a separate Korean editing pass and validates the edited source evidence', async () => {
    const edited = { ...valid, title: '하위 에이전트마다 추론 강도를 정할 수 있습니다' };
    const client = { send: async () => ({ output: { message: { content: [{ text: JSON.stringify(edited) }] } } }) } as unknown as BedrockRuntimeClient;
    const result = await new BedrockExplainer('test-model', client).polish(candidate, validateExplanation(valid, candidate));
    expect(result.title).toBe('하위 에이전트마다 추론 강도를 정할 수 있습니다');
    expect(result.highlights[0].evidence).toBe('Added an effort parameter');
  });
  it('rejects an editing result that invents its supporting source text', async () => {
    const invented = { ...valid, highlights: [{ ...valid.highlights[0], evidence: 'Performance improved by 80 percent' }] };
    const client = { send: async () => ({ output: { message: { content: [{ text: JSON.stringify(invented) }] } } }) } as unknown as BedrockRuntimeClient;
    await expect(new BedrockExplainer('test-model', client).polish(candidate, validateExplanation(valid, candidate))).rejects.toThrow(/근거/);
  });
  it('uses Haiku 5.5 with enough output space and no reasoning allocation that truncates the JSON', async () => {
    const calls: Record<string, unknown>[] = [];
    const previous = process.env.BEDROCK_MODEL_ID;
    delete process.env.BEDROCK_MODEL_ID;
    const client = { send: async (command: { input: Record<string, unknown> }) => {
      calls.push(command.input);
      if ('temperature' in (command.input.inferenceConfig as Record<string, unknown>)) throw new Error('temperature is deprecated for this model');
      return { output: { message: { content: [{ text: JSON.stringify(valid) }] } } };
    } } as unknown as BedrockRuntimeClient;
    try {
      const result = await new BedrockExplainer(undefined, client).explain(candidate);
      expect(result.title).toBe(valid.title);
      expect(calls.map(call => call.modelId)).toEqual([
        'global.anthropic.claude-haiku-5-5', 'global.anthropic.claude-haiku-5-5',
      ]);
      expect(calls.every(call => (call.inferenceConfig as { maxTokens: number }).maxTokens === 8192)).toBe(true);
      expect(calls.map(call => call.additionalModelRequestFields)).toEqual([
        { thinking: { type: 'disabled' } }, { thinking: { type: 'disabled' } },
      ]);
    } finally {
      if (previous === undefined) delete process.env.BEDROCK_MODEL_ID;
      else process.env.BEDROCK_MODEL_ID = previous;
    }
  });
});

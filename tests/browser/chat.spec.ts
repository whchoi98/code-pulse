import { expect, test } from '@playwright/test';
import { mockApi } from './fixtures';

const ndjson = (events: object[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';

test('the AI agent opens as a floating window, streams an answer and links to its sources', async ({ page }) => {
  await mockApi(page);
  let request: { body: any; header?: string } | undefined;
  await page.route('**/api/chat', route => {
    request = { body: route.request().postDataJSON(), header: route.request().headers()['x-code-pulse-client'] };
    return route.fulfill({ contentType: 'application/x-ndjson', body: ndjson([
      { type: 'start' },
      { type: 'delta', text: '버전을 찾아보겠습니다.' },
      { type: 'tool', name: 'find_version', input: { version: '2.1.0', product: 'claude-code' } },
      { type: 'retract' },
      { type: 'delta', text: '2.1.0에서는 **세션 시작 전** 지침을 볼 수 있습니다.\n\n- [지침 미리 보기](?entry=claude-latest)' },
      { type: 'sources', sources: [{ id: 'claude-latest', product: 'claude-code', version: '2.1.0', title: '작업을 시작하기 전에 지침을 확인하세요', publishedDate: '2026-10-07' }] },
      { type: 'done' },
    ]) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'AI 에이전트에게 질문하기' }).click();
  const agent = page.getByRole('dialog', { name: 'Code Pulse AI 에이전트' });
  await expect(agent).toBeVisible();
  await expect(agent.getByRole('textbox', { name: 'AI 에이전트에게 보낼 질문' })).toBeFocused();

  await agent.getByRole('textbox').fill('Claude Code 2.1.0 버전을 알려줘');
  await agent.getByRole('textbox').press('Enter');
  await expect(agent.getByRole('log')).toContainText('세션 시작 전');
  await expect(agent.locator('strong', { hasText: '세션 시작 전' })).toBeVisible();
  await expect(agent.getByRole('log')).not.toContainText('찾아보겠습니다');
  expect(request?.header).toBe('1');
  expect(request?.body).toEqual({ language: 'ko', messages: [{ role: 'user', content: 'Claude Code 2.1.0 버전을 알려줘' }] });

  await agent.getByRole('link', { name: /Claude Code 2.1.0/ }).click();
  await expect(page).toHaveURL(/entry=claude-latest/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('작업을 시작하기 전에 지침을 확인하세요');

  // The window stays open beside the article; Escape closes it from inside.
  await expect(agent).toBeVisible();
  await agent.getByRole('textbox').press('Escape');
  await expect(agent).toBeHidden();
  await expect(page.getByRole('button', { name: 'AI 에이전트에게 질문하기' })).toBeFocused();
});

test('the AI agent sends the viewed article and conversation history, and shows server errors', async ({ page }) => {
  await mockApi(page);
  const bodies: any[] = [];
  await page.route('**/api/chat', route => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1
      ? route.fulfill({ contentType: 'application/x-ndjson', body: ndjson([{ type: 'delta', text: 'Codex 0.110.0은 승인을 요청합니다.' }, { type: 'sources', sources: [] }, { type: 'done' }]) })
      : route.fulfill({ status: 429, json: { error: '지금은 질문이 많습니다. 잠시 후 다시 시도해 주세요.' } });
  });
  await page.goto('/?entry=codex-security');
  await page.getByRole('button', { name: 'AI 에이전트에게 질문하기' }).click();
  const agent = page.getByRole('dialog', { name: 'Code Pulse AI 에이전트' });
  await agent.getByRole('button', { name: '이 글의 변경 사항을 자세히 설명해 주세요' }).click();
  await expect(agent.getByRole('log')).toContainText('승인을 요청합니다');
  expect(bodies[0]).toMatchObject({ entryId: 'codex-security', language: 'ko' });

  await agent.getByRole('textbox').fill('다른 제품도 비슷한가요?');
  await agent.getByRole('button', { name: '질문 보내기' }).click();
  await expect(agent.getByRole('log')).toContainText('지금은 질문이 많습니다');
  expect(bodies[1].messages).toEqual([
    { role: 'user', content: '이 글의 변경 사항을 자세히 설명해 주세요' },
    { role: 'assistant', content: 'Codex 0.110.0은 승인을 요청합니다.' },
    { role: 'user', content: '다른 제품도 비슷한가요?' },
  ]);
});

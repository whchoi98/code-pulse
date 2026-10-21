import { expect, test } from '@playwright/test';
import { mockApi } from './fixtures';

const ndjson = (events: object[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';

test('the AI agent opens as a floating window, streams an answer and links to its sources', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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

  // Plain text keeps the Markdown and rich text keeps the formatting; both carry shareable links.
  await agent.getByRole('button', { name: '답변 복사' }).click();
  await expect(agent.getByRole('button', { name: '복사했습니다' })).toBeVisible();
  const copied = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return { plain: await (await item!.getType('text/plain')).text(), html: await (await item!.getType('text/html')).text() };
  });
  expect(copied.plain).toBe('2.1.0에서는 **세션 시작 전** 지침을 볼 수 있습니다.\n\n- [지침 미리 보기](http://127.0.0.1:4173/?entry=claude-latest&lang=ko)');
  expect(copied.html).toContain('<strong>세션 시작 전</strong>');
  expect(copied.html).toContain('href="http://127.0.0.1:4173/?entry=claude-latest&amp;lang=ko"');
  await expect(agent.getByRole('button', { name: '답변 복사' })).toBeVisible();

  await agent.getByRole('link', { name: /Claude Code 2.1.0/ }).click();
  await expect(page).toHaveURL(/entry=claude-latest/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('작업을 시작하기 전에 지침을 확인하세요');

  // The window stays open beside the article; Escape closes it from inside.
  await expect(agent).toBeVisible();
  await agent.getByRole('textbox').press('Escape');
  await expect(agent).toBeHidden();
  await expect(page.getByRole('button', { name: 'AI 에이전트에게 질문하기' })).toBeFocused();
});

const codexSource = { id: 'codex-security', product: 'codex', version: '0.110.0', title: '작업 폴더 밖 접근 전에 승인 요청', publishedDate: '2026-10-06' };

test('the AI agent sends the viewed article and conversation history, and shows server errors', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockApi(page);
  const bodies: any[] = [];
  await page.route('**/api/chat', route => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1
      ? route.fulfill({ contentType: 'application/x-ndjson', body: ndjson([{ type: 'delta', text: 'Codex 0.110.0은 승인을 요청합니다.' }, { type: 'sources', sources: [codexSource] }, { type: 'done' }]) })
      : route.fulfill({ status: 429, json: { error: '지금은 질문이 많습니다. 잠시 후 다시 시도해 주세요.' } });
  });
  await page.goto('/?entry=codex-security');
  await page.getByRole('button', { name: 'AI 에이전트에게 질문하기' }).click();
  const agent = page.getByRole('dialog', { name: 'Code Pulse AI 에이전트' });
  await agent.getByRole('button', { name: '이 글의 변경 사항을 자세히 설명해 주세요' }).click();
  await expect(agent.getByRole('log')).toContainText('승인을 요청합니다');
  expect(bodies[0]).toMatchObject({ entryId: 'codex-security', language: 'ko' });
  // A source the answer did not link is listed after the copied answer.
  await agent.getByRole('button', { name: '답변 복사' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    'Codex 0.110.0은 승인을 요청합니다.\n\n참고한 변경 기록\n- [작업 폴더 밖 접근 전에 승인 요청](http://127.0.0.1:4173/?entry=codex-security&lang=ko) (Codex 0.110.0, 2026-10-06)');

  await agent.getByRole('textbox').fill('다른 제품도 비슷한가요?');
  await agent.getByRole('button', { name: '질문 보내기' }).click();
  await expect(agent.getByRole('log')).toContainText('지금은 질문이 많습니다');
  expect(bodies[1].messages).toEqual([
    { role: 'user', content: '이 글의 변경 사항을 자세히 설명해 주세요' },
    { role: 'assistant', content: 'Codex 0.110.0은 승인을 요청합니다.' },
    { role: 'user', content: '다른 제품도 비슷한가요?' },
  ]);
  // Failed answers have nothing worth copying.
  await expect(agent.getByRole('button', { name: /답변 복사|복사했습니다/ })).toHaveCount(1);
});

test('the AI agent selects the answer for manual copying when the clipboard is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
        writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
      },
    });
  });
  await mockApi(page);
  await page.route('**/api/chat', route => route.fulfill({ contentType: 'application/x-ndjson', body: ndjson([
    { type: 'delta', text: 'Codex 0.110.0은 작업 폴더 밖에 접근하기 전에 **승인**을 요청합니다.' }, { type: 'done' },
  ]) }));
  await page.goto('/');
  await page.getByRole('button', { name: 'AI 에이전트에게 질문하기' }).click();
  const agent = page.getByRole('dialog', { name: 'Code Pulse AI 에이전트' });
  await agent.getByRole('textbox').fill('Codex 승인 기능');
  await agent.getByRole('textbox').press('Enter');
  await agent.getByRole('button', { name: '답변 복사' }).click();
  await expect(agent.getByText('선택된 답변을 직접 복사하세요')).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Codex 0.110.0은 작업 폴더 밖에 접근하기 전에 승인을 요청합니다.');
});

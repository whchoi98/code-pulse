import type { FeedEntry } from '../shared/types';
import { categories, channels, getFullChangesState, products, validDate } from './lib';

function markdownText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`*_{}[\]()#!|]/g, '\\$&');
}

function sourceLink(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('공식 원문 주소를 확인할 수 없습니다.');
  return url.href.replaceAll('\\', '%5C').replaceAll('<', '%3C').replaceAll('>', '%3E').replaceAll('&', '&amp;');
}

export function buildSavedMarkdown(entries: readonly FeedEntry[], siteOrigin: string): string {
  const base = new URL(siteOrigin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) throw new Error('사이트 주소를 확인할 수 없습니다.');
  const selected = [...new Map(entries.map(entry => [entry.id, entry])).values()]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  const lines = [
    '# Code Pulse 저장한 글', '', `총 ${selected.length}개`, '',
    '한국어 설명은 공식 발표를 바탕으로 작성한 AI 해설입니다. 적용 조건은 연결된 공식 원문을 확인하세요.', '',
  ];
  for (const entry of selected) {
    if (!validDate(entry.publishedDate) || !products[entry.product]) throw new Error('내보낼 글의 발표일과 제품을 확인할 수 없습니다.');
    const explanation = entry.explanationStatus === 'ready' ? entry.explanation : undefined;
    const url = new URL('/', base);
    url.searchParams.set('entry', entry.id);
    lines.push(
      `## [${markdownText(explanation?.title ?? entry.originalTitle)}](<${url.href}>)`, '',
      `- 제품: ${products[entry.product].name} (${channels[entry.channel]})`,
      `- 공식 발표일: ${entry.publishedDate}`,
      ...(entry.version ? [`- 버전: ${markdownText(entry.version)}`] : []),
      `- 구분: ${explanation ? categories[explanation.category] : '한국어 해설 준비 중'}`, '',
    );
    if (explanation) {
      if (entry.fullChanges) lines.push('### 짧은 요약', '');
      lines.push(markdownText(explanation.summary), '', '### 왜 중요한가요?', '', markdownText(explanation.whyItMatters), '');
      if (explanation.highlights.length) {
        lines.push(entry.fullChanges ? '### 주요 변경 요약' : '### 달라진 점', '', ...explanation.highlights.map(item =>
          `- **${markdownText(item.title)}**: ${markdownText(item.detail)}`), '');
      }
      if (explanation.actionItems.length) {
        lines.push('### 적용 전 확인', '', ...explanation.actionItems.map(item => `- ${markdownText(item)}`), '');
      }
    }
    if (entry.fullChanges) {
      const state = getFullChangesState(entry.fullChanges);
      lines.push('### 전체 변경 사항', '', state.countLabel, '');
      if (!state.complete) lines.push('전체 변경 사항의 한국어 해설 준비 중입니다. 준비된 항목부터 보여드립니다.', '');
      lines.push(...entry.fullChanges.items.map((item, index) => `${index + 1}. ${markdownText(item.text)}`), '');
    }
    lines.push(`[공식 원문](<${sourceLink(entry.sourceUrl)}>)`, '');
    const linked = new Set([entry.sourceUrl]);
    for (const reference of entry.references) {
      if (linked.has(reference.url)) continue;
      linked.add(reference.url);
      lines.push(`[${markdownText(reference.title)}](<${sourceLink(reference.url)}>)`, '');
    }
    lines.push('---', '');
  }
  return `${lines.join('\n')}\n`;
}

export function downloadSavedMarkdown(entries: readonly FeedEntry[], siteOrigin: string): void {
  if (!entries.length) throw new Error('내보낼 저장한 글이 없습니다.');
  const text = buildSavedMarkdown(entries, siteOrigin);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `code-pulse-saved-${new Date().toISOString().slice(0, 10)}.md`;
  anchor.hidden = true;
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

import type { FeedEntry, Language } from '../shared/types';
import { getFullChangesState, products, validDate } from './lib';
import { categoryLabel, channelLabel, translate } from './i18n';

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

export function buildSavedMarkdown(entries: readonly FeedEntry[], siteOrigin: string, language: Language = 'ko'): string {
  const t = (ko: string, en: string) => translate(language, ko, en);
  const base = new URL(siteOrigin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) throw new Error('사이트 주소를 확인할 수 없습니다.');
  const selected = [...new Map(entries.map(entry => [entry.id, entry])).values()]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  const lines = [
    t('# Code Pulse 저장한 글', '# Code Pulse saved articles'), '', t(`총 ${selected.length}개`, `${selected.length} ${selected.length === 1 ? 'article' : 'articles'}`), '',
    t('한국어 설명은 공식 발표를 바탕으로 작성한 AI 해설입니다. 적용 조건은 연결된 공식 원문을 확인하세요.',
      'Official source text from product announcements. See the linked official sources for conditions and scope.'), '',
  ];
  for (const entry of selected) {
    if (!validDate(entry.publishedDate) || !products[entry.product]) throw new Error('내보낼 글의 발표일과 제품을 확인할 수 없습니다.');
    const explanation = entry.explanationStatus === 'ready' ? entry.explanation : undefined;
    const isSource = entry.contentKind === 'source';
    const url = new URL('/', base);
    url.searchParams.set('entry', entry.id);
    url.searchParams.set('lang', language);
    lines.push(
      `## [${markdownText(explanation?.title ?? entry.originalTitle)}](<${url.href}>)`, '',
      `- ${t('제품', 'Product')}: ${products[entry.product].name} (${channelLabel(entry.channel, language)})`,
      `- ${t('공식 발표일', 'Published')}: ${entry.publishedDate}`,
      ...(entry.version ? [`- ${t('버전', 'Version')}: ${markdownText(entry.version)}`] : []),
      `- ${t('구분', 'Category')}: ${explanation ? categoryLabel(explanation.category, language) : t('한국어 해설 준비 중', 'Source details unavailable')}`,
      ...(isSource ? [`- ${t('내용', 'Content')}: ${t('공식 원문', 'Official source')}`] : []), '',
    );
    if (explanation) {
      if (entry.fullChanges) lines.push(t('### 짧은 요약', '### Overview'), '');
      lines.push(markdownText(explanation.summary), '');
      if (!isSource && explanation.whyItMatters.trim()) {
        lines.push(t('### 왜 중요한가요?', '### Why it matters'), '', markdownText(explanation.whyItMatters), '');
      }
      if (!isSource && explanation.highlights.length) {
        lines.push(entry.fullChanges ? t('### 주요 변경 요약', '### Highlights') : t('### 달라진 점', '### What changed'), '', ...explanation.highlights.map(item =>
          `- **${markdownText(item.title)}**: ${markdownText(item.detail)}`), '');
      }
      if (!isSource && explanation.actionItems.length) {
        lines.push(t('### 적용 전 확인', '### Before you start'), '', ...explanation.actionItems.map(item => `- ${markdownText(item)}`), '');
      }
    }
    if (entry.fullChanges) {
      const state = getFullChangesState(entry.fullChanges, language);
      lines.push(t('### 전체 변경 사항', '### All changes'), '', state.countLabel, '');
      if (!state.complete) lines.push(t('전체 변경 사항의 한국어 해설 준비 중입니다. 준비된 항목부터 보여드립니다.',
        'The complete change list is not available yet. Read the official source for the full announcement.'), '');
      lines.push(...entry.fullChanges.items.map((item, index) => `${index + 1}. ${markdownText(item.text)}`), '');
    }
    lines.push(`[${t('공식 원문', 'Official source')}](<${sourceLink(entry.sourceUrl)}>)`, '');
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

export function downloadSavedMarkdown(entries: readonly FeedEntry[], siteOrigin: string, language: Language = 'ko'): void {
  if (!entries.length) throw new Error('내보낼 저장한 글이 없습니다.');
  const text = buildSavedMarkdown(entries, siteOrigin, language);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `code-pulse-saved-${language === 'en' ? 'en-' : ''}${new Date().toISOString().slice(0, 10)}.md`;
  anchor.hidden = true;
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

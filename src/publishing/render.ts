import type { Feed, FeedEntry, Language, StaticBootstrap } from '../shared/types.js';
import { COLLECTION_SCHEDULE } from '../shared/schedule.js';

const productNames = { 'claude-code': 'Claude Code', codex: 'Codex', kiro: 'Kiro' };
const productLogos = { 'claude-code': '/brand/claude-code.png', codex: '/brand/codex.png', kiro: '/brand/kiro.svg' };
const text = {
  ko: { title: '코딩 도구의 변경 기록', subtitle: 'Claude Code, Codex, Kiro의 공식 기록을 읽어보세요.',
    schedule: `매일 오전 ${COLLECTION_SCHEDULE.hour}시, 한국 시간`, back: '목록으로 돌아가기', full: '전체 변경 사항',
    source: '공식 원문', explanation: 'AI 한국어 해설', summary: '요약', why: '왜 중요한가요', action: '확인할 사항',
    pending: '한국어 해설을 준비하고 있습니다. 공식 원문을 먼저 확인할 수 있습니다.',
    pendingChanges: '일부 항목은 아직 준비 중입니다.', checked: '최근 확인', published: '발표일',
    note: '한국어 설명은 공식 자료를 바탕으로 생성한 AI 해설입니다. 세부 조건은 공식 원문을 확인하세요.',
    status: '일부 출처를 확인하지 못했습니다. 이전에 확인한 글은 계속 읽을 수 있습니다.', articles: '변경 기록',
  },
  en: { title: 'Updates to your coding tools', subtitle: 'Read official updates from Claude Code, Codex and Kiro.',
    schedule: `Daily at ${String(COLLECTION_SCHEDULE.hour).padStart(2, '0')}:00 ${COLLECTION_SCHEDULE.timezone}`, back: 'Back to updates', full: 'Complete official changes',
    source: 'Official source', explanation: 'Official English wording', summary: 'Overview', why: 'Why it matters', action: 'What to check',
    pending: 'The overview is being prepared. You can read the official source.', pendingChanges: 'Some items are still being prepared.',
    checked: 'Last checked', published: 'Published', note: 'English items retain the official source wording and section context.',
    status: 'Some sources could not be checked. Previously collected updates remain available.', articles: 'updates',
  },
};

function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}
function link(language: Language, id?: string): string {
  return `/?lang=${language}${id ? `&entry=${encodeURIComponent(id)}` : ''}`;
}
function external(url: string, label: string): string {
  try {
    const safe = new URL(url);
    if (safe.protocol === 'https:') return `<a href="${escape(safe.href)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`;
  } catch { /* Invalid source links remain readable labels. */ }
  return `<span>${escape(label)}</span>`;
}
function paragraphs(value: string): string {
  return value.split(/\n\s*\n/).filter(Boolean).map(paragraph => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
}
function product(entry: FeedEntry, assetUrls?: ReadonlyMap<string, string>): string {
  return `<span class="product-name"><span class="product-mark ${entry.product}" aria-hidden="true"><img src="${assetUrls?.get(productLogos[entry.product]) ?? productLogos[entry.product]}" alt="" width="23" height="23"></span>${productNames[entry.product]}</span>`;
}
function header(language: Language, id?: string): string {
  return `<a class="skip-link" href="#main">${language === 'ko' ? '본문으로 건너뛰기' : 'Skip to content'}</a>
    <header class="site-header"><div class="header-inner"><a class="brand" href="${escape(link(language))}"><span>Code<span class="brand-light">Pulse</span><small>FROM THE SOURCE</small></span></a>
    <nav class="primary-nav"><a class="nav-link active" href="${escape(link(language))}">${text[language].articles}</a></nav>
    <nav class="header-actions" aria-label="${language === 'ko' ? '언어' : 'Language'}"><a href="${escape(link('ko', id))}" lang="ko" ${language === 'ko' ? 'aria-current="true"' : ''}>한국어</a><a href="${escape(link('en', id))}" lang="en" ${language === 'en' ? 'aria-current="true"' : ''}>English</a></nav></div></header>`;
}
function listing(feed: Feed, language: Language, assetUrls?: ReadonlyMap<string, string>): string {
  const t = text[language];
  // All links remain available without JavaScript; only the compact catalog is embedded.
  const cards = feed.entries.slice(0, 20).map(entry => `<article class="entry-card" data-entry-id="${escape(entry.id)}">
    <div class="entry-date"><time datetime="${escape(entry.publishedDate)}"><span>${escape(entry.publishedDate.slice(5).replace('-', '.'))}</span><small>${escape(entry.publishedDate.slice(0, 4))}</small></time></div>
    <div class="entry-body"><div class="entry-meta">${product(entry, assetUrls)}<span class="channel-label">${escape(entry.channel.toUpperCase())}</span>${entry.version ? `<span class="version-label">${escape(entry.version)}</span>` : ''}</div>
    <h3><a href="${escape(link(language, entry.id))}">${escape(entry.explanation?.title || entry.originalTitle)}</a></h3>
    <p class="entry-summary">${escape(entry.explanation?.summary || t.pending)}</p></div></article>`).join('');
  return `<main id="main" class="page-shell"><section class="hero"><div class="hero-copy"><div class="eyebrow">CODE PULSE</div><h1>${t.title}</h1><p>${t.subtitle}</p><p class="schedule">${t.schedule}</p></div></section>
    ${feed.sources.some(source => source.state === 'error') ? `<p class="collection-notice" role="status">${t.status}</p>` : ''}
    <section class="feed-section" aria-label="${t.articles}"><div class="feed-heading"><h2>${feed.entries.length} ${t.articles}</h2></div><div class="entry-list">${cards}</div>
    ${feed.entries.length > 20 ? `<noscript><ul>${feed.entries.slice(20).map(entry => `<li><a href="${escape(link(language, entry.id))}">${escape(entry.publishedDate)} ${escape(entry.explanation?.title || entry.originalTitle)}</a></li>`).join('')}</ul></noscript>` : ''}</section></main>`;
}
function detailPage(entry: FeedEntry, language: Language, assetUrls?: ReadonlyMap<string, string>): string {
  const t = text[language];
  const explanation = entry.explanation;
  const changes = entry.fullChanges;
  const aiSections = language === 'ko' && explanation ?
    `${explanation.whyItMatters ? `<section class="detail-section"><h2>${t.why}</h2>${paragraphs(explanation.whyItMatters)}</section>` : ''}
    ${explanation.highlights.length ? `<section class="detail-section"><h2>주요 변경</h2>${explanation.highlights.map(highlight => `<h3>${escape(highlight.title)}</h3>${paragraphs(highlight.detail)}<blockquote>${escape(highlight.evidence)}</blockquote>`).join('')}</section>` : ''}
    ${explanation.actionItems.length ? `<section class="detail-section"><h2>${t.action}</h2><ul>${explanation.actionItems.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section>` : ''}` : '';
  return `<main id="main" class="page-shell detail-page"><div class="detail-wrap"><a class="back-button" href="${escape(link(language))}">${t.back}</a>
    <article class="detail-article"><header class="detail-header"><div class="entry-meta">${product(entry, assetUrls)}<span class="version-label">${escape(entry.version)}</span></div>
    <p class="eyebrow">${t.explanation}</p><h1>${escape(explanation?.title || entry.originalTitle)}</h1><p class="detail-summary">${escape(explanation?.summary || t.pending)}</p>
    <div class="detail-dates"><span>${t.published} <time datetime="${escape(entry.publishedDate)}">${escape(entry.publishedDate)}</time></span>${entry.checkedAt ? `<span>${t.checked} <time datetime="${escape(entry.checkedAt)}">${escape(entry.checkedAt)}</time></span>` : ''}</div></header>
    ${aiSections}<section class="detail-section full-changes full-changes-section"><div class="full-changes-heading"><h2>${t.full}</h2><span class="full-changes-count">${language === 'ko' ? `${changes?.sourceCount ?? entry.changeSummary?.sourceCount ?? 0}개 중 ${changes?.items.length ?? 0}개 준비` : `${changes?.items.length ?? 0} of ${changes?.sourceCount ?? 0} items`}</span></div>
    ${changes?.status !== 'ready' ? `<p class="full-changes-pending">${t.pendingChanges}</p>` : ''}<ol class="full-changes-list">${(changes?.items ?? []).map(item => `<li class="full-change-item" data-change-id="${escape(item.id)}">${paragraphs(item.text)}</li>`).join('')}</ol></section>
    <section class="detail-section"><h2>${t.source}</h2><p>${external(entry.sourceUrl, entry.originalTitle)}</p>${entry.references.map(reference => `<p>${external(reference.url, reference.title)}</p>`).join('')}</section><p class="inline-note">${t.note}</p></article></div></main>`;
}

/** Uses only the compiled shell and public data; importing the browser app here is unsafe. */
export function renderPage(shell: string, bootstrap: StaticBootstrap, assetUrls?: ReadonlyMap<string, string>): string {
  if (!/<div\b[^>]*id=["']root["'][^>]*>\s*<\/div>/i.test(shell)) throw new Error('The compiled page must contain an empty root element.');
  if (!bootstrap.feed && !bootstrap.detail) throw new Error('A rendered page needs public feed or detail data.');
  const language = bootstrap.language;
  const title = bootstrap.detail?.explanation?.title || bootstrap.detail?.originalTitle || text[language].title;
  const markup = `${header(language, bootstrap.detail?.id)}${bootstrap.detail ? detailPage(bootstrap.detail, language, assetUrls) : listing(bootstrap.feed!, language, assetUrls)}`;
  // Escaping '<' also neutralizes closing template/script tags, comments and HTML entities.
  const json = JSON.stringify(bootstrap).replace(/[<>&\u2028\u2029]/g, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return shell.replace(/<html\b[^>]*>/i, `<html lang="${language}">`)
    .replace(/<link\b[^>]*type=["']application\/rss\+xml["'][^>]*>/i,
      `<link rel="alternate" type="application/rss+xml" title="Code Pulse RSS" href="/feed.xml?lang=${language}">`)
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escape(title)} | Code Pulse</title>`)
    .replace(/<meta\s+name=["']description["'][^>]*>/i, () => `<meta name="description" content="${escape(bootstrap.detail?.explanation?.summary || text[language].subtitle)}">`)
    .replace(/<div\b[^>]*id=["']root["'][^>]*>\s*<\/div>/i, () => `<div id="root">${markup}</div><template id="code-pulse-bootstrap">${json}</template>`);
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, Bookmark, BookOpen, CalendarDays, ChevronDown, CircleHelp, Clock3, Download, Layers3, Moon, Rss, Search, SlidersHorizontal, Sun, X } from 'lucide-react';
import { PRODUCT_IDS } from '../shared/types';
import { ActivityTable, BrandMark, CollectionStatus, DateDialog, EntryCard, EntryDetail, ErrorState, FeedAside, Loading, Modal, ProductMark, SourcesDialog } from './components';
import { adjacentEntries, categories, displayDate, displayTimestamp, entryTitle, filterEntries, getCollectionState, products, readLocation, type Filters } from './lib';
import { resolveEntriesForExport, useDetail, useFeed, useSaved, useSearchIndex, useViewportPrefetch } from './hooks';
import { PresenceCounter, ServiceReleaseDialog } from './footer';
import { entryRevision, useReading } from './reading';
import { SubscriptionDialog } from './subscriptions';
import { downloadSavedMarkdown } from './export';
import { categoryLabel, LocaleProvider, useLocale } from './i18n';

export default function App() {
  return <LocaleProvider><ReaderApp /></LocaleProvider>;
}

function ReaderApp() {
  const { language, setLanguage, t } = useLocale();
  const [search, setSearch] = useState(window.location.search);
  const selection = useMemo(() => readLocation(search), [search]);
  const [modal, setModal] = useState<'sources' | 'dates' | 'share' | 'releases' | 'rss' | null>(null);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const [visibleCount, setVisibleCount] = useState(20);
  const [exporting, setExporting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const previousEntry = useRef<string | null>(null);
  const listEntry = useRef<string | null>(null);
  const listScroll = useRef(0);
  const markedDetail = useRef<{ id: string; revision: string } | null>(null);
  const navigationIntent = useRef<'restore-list' | 'home'>('restore-list');
  const nextToastId = useRef(0);
  const announce = useCallback((message: string) => {
    setToast({ id: ++nextToastId.current, message });
  }, []);
  const feed = useFeed(language);
  const detail = useDetail(selection.entry, feed.data, language);
  const searchIndex = useSearchIndex(feed.data, selection.entry ? '' : selection.query);
  const saved = useSaved(announce);
  const reading = useReading(announce);
  const currentDetail = detail.status === 'ready' && detail.data?.id === selection.entry ? detail.data : null;
  const currentRevision = currentDetail ? entryRevision(currentDetail) : null;

  useEffect(() => {
    if (!selection.entry || markedDetail.current?.id !== selection.entry) markedDetail.current = null;
    if (!currentDetail || !currentRevision || currentDetail.explanationStatus !== 'ready' || !currentDetail.explanation) return;
    if (markedDetail.current?.id === currentDetail.id && markedDetail.current.revision === currentRevision) return;
    markedDetail.current = { id: currentDetail.id, revision: currentRevision };
    reading.markRead(currentDetail);
  }, [selection.entry, currentDetail, currentRevision, reading.markRead]);

  useEffect(() => {
    const onPopState = () => {
      navigationIntent.current = 'restore-list';
      setSearch(window.location.search);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !modal && !selection.entry && !target?.closest('input, textarea, select, [contenteditable="true"]')) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', handleSearchShortcut);
    return () => window.removeEventListener('keydown', handleSearchShortcut);
  }, [modal, selection.entry]);

  useEffect(() => {
    let frame: number | undefined;
    if (selection.entry) {
      window.scrollTo(0, 0);
    } else if (previousEntry.current && navigationIntent.current === 'restore-list') {
      const id = listEntry.current ?? previousEntry.current;
      frame = requestAnimationFrame(() => {
        window.scrollTo(0, listScroll.current);
        const target = document.getElementById(`entry-link-${id}`) ?? document.getElementById('feed-heading');
        target?.focus({ preventScroll: true });
      });
    }
    previousEntry.current = selection.entry;
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [selection.entry]);

  useEffect(() => {
    document.title = currentDetail
      ? `${entryTitle(currentDetail)} | Code Pulse`
      : t('Code Pulse | 코딩 도구의 변경 기록', 'Code Pulse | Coding tool changes');
  }, [currentDetail, t]);

  useEffect(() => { setToast(null); }, [language]);

  useEffect(() => {
    setVisibleCount(20);
  }, [selection.product, selection.category, selection.query, selection.from, selection.to, selection.saved, selection.unread]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const navigate = useCallback((params: URLSearchParams, push = false) => {
    if (language === 'en' || params.has('lang') || new URLSearchParams(window.location.search).has('lang')) params.set('lang', language);
    const query = params.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
    if (push) window.history.pushState({ codePulseEntry: params.has('entry') }, '', url);
    else window.history.replaceState(window.history.state, '', url);
    setSearch(window.location.search);
  }, [language]);

  const applyFilters = (patch: Partial<Filters>) => {
    const params = new URLSearchParams(window.location.search);
    Object.entries(patch).forEach(([key, value]) => {
      const param = key === 'query' ? 'q' : key;
      if (!value || value === 'all') params.delete(param);
      else params.set(param, value === true ? '1' : String(value));
    });
    params.delete('entry');
    navigate(params);
  };

  const clearFilters = () => applyFilters({ product: 'all', category: 'all', query: '', from: '', to: '', unread: false });
  const goHome = () => {
    navigationIntent.current = 'home';
    navigate(new URLSearchParams());
    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      document.getElementById('page-heading')?.focus({ preventScroll: true });
    });
  };
  const backToList = () => {
    navigationIntent.current = 'restore-list';
    if (window.history.state?.codePulseEntry) window.history.back();
    else {
      const params = new URLSearchParams(window.location.search);
      params.delete('entry');
      navigate(params);
    }
  };
  const openEntry = (id: string) => {
    navigationIntent.current = 'restore-list';
    listEntry.current = id;
    listScroll.current = window.scrollY;
    const params = new URLSearchParams(window.location.search);
    params.set('entry', id);
    navigate(params, true);
  };
  const openAdjacentEntry = (id: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set('entry', id);
    navigate(params);
  };
  const entryHref = (id: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set('entry', id);
    params.set('lang', language);
    return `?${params.toString()}`;
  };
  const shareUrl = new URL(window.location.pathname, window.location.origin);
  shareUrl.search = new URLSearchParams({ entry: selection.entry ?? '', lang: language }).toString();
  const share = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(shareUrl.href);
      announce(t('글 주소를 복사했습니다.', 'Article link copied.'));
    } catch {
      setModal('share');
    }
  };
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('code-pulse-theme', next); } catch { /* The current tab can still change theme. */ }
  };
  const searchPending = Boolean(selection.query.trim()) && searchIndex.status === 'loading';
  const searchFailed = Boolean(selection.query.trim()) && searchIndex.status === 'error';
  const entries = useMemo(() => filterEntries(searchIndex.entries, selection, saved.ids, reading.isRead), [searchIndex.entries, selection, saved.ids, reading.isRead]);
  const visibleIds = useMemo(() => searchPending || searchFailed || selection.entry ? [] : entries.slice(0, visibleCount).map(entry => entry.id), [entries, visibleCount, searchPending, searchFailed, selection.entry]);
  useViewportPrefetch(selection.entry ? null : feed.data, visibleIds);
  const adjacent = feed.status === 'ready' && feed.data && currentDetail ? adjacentEntries(feed.data.entries, currentDetail) : undefined;
  const exportSaved = async () => {
    if (feed.status !== 'ready' || !feed.data || !selection.saved || !entries.length || searchPending || searchFailed || exporting) return;
    setExporting(true);
    try {
      const completeEntries = await resolveEntriesForExport(entries, language);
      downloadSavedMarkdown(completeEntries, window.location.origin, language);
      announce(t(`저장한 글 ${entries.length}개를 Markdown 파일로 내보냈습니다.`, `Exported ${entries.length} saved articles to Markdown.`));
    } catch {
      announce(t('파일을 만들지 못했습니다. 잠시 후 다시 시도하세요.', 'Could not create the file. Please try again.'));
    } finally {
      setExporting(false);
    }
  };
  const filterActive = Boolean(selection.query || selection.product !== 'all' || selection.category !== 'all' || selection.from || selection.to || selection.unread);
  const collection = feed.data ? getCollectionState(feed.data) : null;
  const sourceErrors = collection?.sourceErrors;
  const sourcePending = collection?.sourcePending ?? true;
  const freshnessWarning = collection?.oldData || collection?.statusUnavailable;
  const lastChecked = feed.data?.latestRun?.completedAt;
  const dateLabel = selection.from && selection.from === selection.to ? displayDate(selection.from, language)
    : selection.from || selection.to ? `${selection.from ? displayDate(selection.from, language) : t('처음', 'Start')} ~ ${selection.to ? displayDate(selection.to, language) : t('최근', 'Latest')}` : t('날짜 선택', 'Select dates');

  return <>
    <a className="skip-link" href="#main-content">{t('본문으로 건너뛰기', 'Skip to content')}</a>
    <header className="site-header">
      <div className="header-inner">
        <a href={`/?lang=${language}`} className="brand" aria-label={t('Code Pulse 홈', 'Code Pulse home')} onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); goHome();
        }}><BrandMark /><span>Code<span className="brand-light">Pulse</span><small>{t('코딩 도구의 변경 기록', 'Coding tool changes')}</small></span></a>
        <nav className="primary-nav" aria-label={t('주 메뉴', 'Main navigation')}>
          <button className={!selection.saved ? 'nav-link active' : 'nav-link'} aria-current={!selection.saved && !selection.entry ? 'page' : undefined} onClick={() => applyFilters({ saved: false })}>{t('변경 기록', 'Changes')}</button>
          <button className={selection.saved ? 'nav-link active' : 'nav-link'} aria-label={t(`저장한 글 보기 ${saved.ids.length}개`, `View ${saved.ids.length} saved articles`)} aria-current={selection.saved ? 'page' : undefined} onClick={() => applyFilters({ saved: true })}><Bookmark size={15} aria-hidden="true" /><span>{t('저장한 글', 'Saved')}</span>{saved.ids.length > 0 && <span className="saved-count">{saved.ids.length}</span>}</button>
        </nav>
        <div className="header-actions">
          <div className="language-switch" role="group" aria-label={t('언어', 'Language')}>
            <button lang="ko" aria-label="한국어" aria-pressed={language === 'ko'} onClick={() => setLanguage('ko')}>KO</button>
            <button lang="en" aria-label="English" aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>EN</button>
          </div>
          <button className="source-button" onClick={() => setModal('sources')} aria-label={t('출처 안내', 'Sources')}><CircleHelp size={17} aria-hidden="true" /><span>{t('출처 안내', 'Sources')}</span></button><span className="header-divider" /><button className="icon-button theme-button" onClick={toggleTheme} aria-label={theme === 'light' ? t('다크 모드로 전환', 'Switch to dark mode') : t('라이트 모드로 전환', 'Switch to light mode')}>{theme === 'light' ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}</button>
        </div>
      </div>
    </header>

    <main id="main-content" className={selection.entry ? 'page-shell detail-page' : 'page-shell'} tabIndex={-1}>
      {selection.entry ? detail.status === 'loading' || detail.data?.id !== selection.entry && detail.status === 'ready'
        ? <Loading detail />
        : detail.status === 'error'
          ? <ErrorState title={detail.notFound ? t('글을 찾을 수 없습니다.', 'Article not found.') : t('글을 불러오지 못했습니다.', 'Could not load the article.')} description={detail.notFound ? t('주소가 올바른지 확인하거나 목록에서 글을 다시 찾아보세요.', 'Check the address or find the article in the list.') : t('잠시 후 다시 불러오세요. 목록의 다른 글은 계속 확인할 수 있습니다.', 'Try again shortly. Other articles are still available in the list.')} retry={detail.notFound ? undefined : detail.retry} goBack={backToList} />
          : currentDetail && <EntryDetail entry={currentDetail} saved={saved.ids.includes(currentDetail.id)} read={reading.isRead(currentDetail)} onSave={() => saved.toggle(currentDetail.id)} onRead={() => reading.isRead(currentDetail) ? reading.markUnread(currentDetail.id) : reading.markRead(currentDetail)} onBack={backToList} onShare={() => void share()} adjacent={adjacent} href={entryHref} onAdjacent={openAdjacentEntry} />
        : <>
          <section className="hero" aria-labelledby="page-heading">
            <div className="hero-copy">
              <div className="eyebrow"><span />FOLLOW THE CHANGE</div>
              <h1 id="page-heading" tabIndex={-1}>{t('코딩 도구의 변화,', 'Coding tools change.')}<br /><span>{t('한곳에서.', 'Keep up here.')}</span></h1>
              <p>{t('Claude Code, Codex, Kiro의 공식 발표를 모아', 'Official changes from Claude Code, Codex and Kiro,')}<br className="desktop-break" /> {t('새 기능과 달라진 점을 한국어로 전합니다.', 'with every source item in English.')}<br />{t('2026년 1월 1일부터 최신 발표까지 확인할 수 있습니다.', 'From January 1, 2026 to the latest announcements.')}</p>
              <div className="schedule"><Clock3 size={14} aria-hidden="true" />{t('매일 오전 7시 확인', 'Checked daily at 07:00')}<span>{t('한국 시간', 'KST')}</span></div>
              <div className="collection-brief">
                <span className={`status-dot ${feed.status === 'error' || sourceErrors || freshnessWarning ? 'error' : sourcePending ? 'pending' : 'ok'}`} />
                <button onClick={() => setModal('sources')}>
                  {feed.status === 'loading' ? t('확인 상태를 불러오고 있습니다', 'Loading collection status')
                    : feed.status === 'error' ? t('수집 상태를 불러오지 못했습니다', 'Collection status unavailable')
                      : collection?.runFailed ? t('모든 출처 확인 실패', 'All source checks failed')
                        : sourceErrors ? t('일부 출처 확인 실패', 'Some source checks failed')
                          : sourcePending ? collection?.initialPending ? t('첫 출처 확인 대기', 'Awaiting the first source check') : t('일부 출처 확인 대기', 'Some source checks are pending')
                            : collection?.oldData ? t('마지막 확인 이후 시간이 지났습니다', 'The last source check is overdue')
                              : collection?.statusUnavailable ? t('최신 수집 상태 확인 불가', 'Latest collection status unavailable')
                                : t('공식 출처 확인 완료', 'Official sources checked')}
                  {lastChecked && ` / ${language === 'ko' ? displayTimestamp(lastChecked, language).slice(5) : displayTimestamp(lastChecked, language)}`}
                </button>
              </div>
            </div>
            {feed.data ? <ActivityTable entries={feed.data.entries} selectedProduct={selection.product} selectedDate={selection.from === selection.to ? selection.from : ''} onSelect={(product, day) => applyFilters({ product, from: day, to: day })} />
              : <div className="activity-placeholder"><div className="activity-placeholder-icon"><Layers3 size={26} aria-hidden="true" /></div><p>{t('지난 7일의 변화', 'The last 7 days')}</p><span>{feed.status === 'error' ? t('피드를 불러오면 활동을 확인할 수 있습니다.', 'Activity will appear when the feed is available.') : t('공식 발표 기록을 확인하고 있습니다.', 'Loading official announcements.')}</span></div>}
          </section>

          <section className="feed-section" aria-label={t('변경 기록 목록', 'Change list')}>
            <div className="product-filters" role="group" aria-label={t('제품 필터', 'Product filters')}>
              <button className={selection.product === 'all' ? 'product-filter selected' : 'product-filter'} aria-pressed={selection.product === 'all'} onClick={() => applyFilters({ product: 'all' })}><Layers3 size={16} aria-hidden="true" />{t('전체', 'All')}<span>{feed.data?.entries.length ?? 0}</span></button>
              {PRODUCT_IDS.map(product => <button key={product} className={`product-filter ${selection.product === product ? 'selected' : ''}`} aria-pressed={selection.product === product} onClick={() => applyFilters({ product })}><ProductMark product={product} />{products[product].name}<span>{feed.data?.entries.filter(entry => entry.product === product).length ?? 0}</span></button>)}
            </div>
            <div className="filter-toolbar">
              <div className="search-field"><Search size={19} aria-hidden="true" /><input ref={input} type="search" aria-label={t('변경 기록 검색', 'Search changes')} placeholder={t('기능, 키워드, 버전으로 검색', 'Search features, keywords, versions')} value={selection.query} onChange={event => applyFilters({ query: event.target.value })} autoComplete="off" />{selection.query ? <button className="clear-search" aria-label={t('검색어 지우기', 'Clear search')} onClick={() => { applyFilters({ query: '' }); input.current?.focus(); }}><X size={16} aria-hidden="true" /></button> : <kbd aria-hidden="true">/</kbd>}</div>
              <div className="toolbar-select"><SlidersHorizontal size={15} aria-hidden="true" /><select aria-label={t('변경 종류', 'Change type')} value={selection.category} onChange={event => applyFilters({ category: event.target.value as Filters['category'] })}><option value="all">{t('모든 변경', 'All changes')}</option>{(Object.keys(categories) as Array<keyof typeof categories>).map(value => <option key={value} value={value}>{categoryLabel(value, language)}</option>)}<option value="pending">{t('해설 준비 중', 'Details pending')}</option></select><ChevronDown size={13} aria-hidden="true" /></div>
              <button className={`date-filter ${selection.from || selection.to ? 'has-filter' : ''}`} onClick={() => setModal('dates')} aria-label={t('날짜 선택', 'Select dates')}><CalendarDays size={16} aria-hidden="true" /><span>{dateLabel}</span><ChevronDown size={13} aria-hidden="true" /></button>
            </div>
            <div className="reading-tools" role="group" aria-label={t('읽기 도구', 'Reading tools')}>
              <button className="unread-filter" aria-pressed={selection.unread} onClick={() => applyFilters({ unread: !selection.unread })}><BookOpen size={15} aria-hidden="true" />{t('읽지 않은 글만', 'Unread only')}</button>
              <button className="subscribe-button" aria-haspopup="dialog" onClick={() => setModal('rss')}><Rss size={15} aria-hidden="true" />{t('RSS 구독', 'Subscribe via RSS')}</button>
            </div>
            {filterActive && <div className="active-filters" aria-label={t('선택한 필터', 'Selected filters')}>{selection.product !== 'all' && <span>{products[selection.product].name}</span>}{selection.category !== 'all' && <span>{selection.category === 'pending' ? t('해설 준비 중', 'Details pending') : categoryLabel(selection.category, language)}</span>}{selection.query.trim() && <span>“{selection.query.trim()}”</span>}{(selection.from || selection.to) && <span>{dateLabel}</span>}{selection.unread && <span>{t('읽지 않은 글', 'Unread')}</span>}<button aria-label={t('선택한 필터 모두 지우기', 'Clear all selected filters')} onClick={clearFilters}><X size={13} aria-hidden="true" />{t('지우기', 'Clear')}</button></div>}
            {feed.data && <CollectionStatus feed={feed.data} />}
            <div className="feed-layout">
              <div className="feed-main">
                <div className="feed-heading"><h2 id="feed-heading" tabIndex={-1}>{selection.saved ? t('저장한 글', 'Saved articles') : filterActive ? t('찾은 변경 기록', 'Matching changes') : t('최근 변경 기록', 'Latest changes')}{feed.status === 'ready' && !searchPending && !searchFailed && <span>{entries.length}</span>}</h2><span><ArrowDown size={13} aria-hidden="true" />{t('발표일 최신순', 'Newest first')}</span></div>
                {selection.saved && <div className="saved-export">
                  <p>{searchPending ? t('전체 변경 기록에서 검색하고 있습니다.', 'Searching all changes.') : searchFailed ? t('검색 자료를 다시 불러온 뒤 내보내기를 이용하세요.', 'Retry the search before exporting.') : feed.status === 'ready' ? t(`현재 필터에 맞는 저장 글 ${entries.length}개`, `${entries.length} saved articles match these filters`) : feed.status === 'loading' ? t('목록을 불러오면 저장한 글을 내보낼 수 있습니다.', 'Saved articles can be exported once the list loads.') : t('목록을 다시 불러온 뒤 내보내기를 이용하세요.', 'Reload the list before exporting.')}</p>
                  <button className="secondary-button" onClick={() => void exportSaved()} disabled={feed.status !== 'ready' || !entries.length || searchPending || searchFailed || exporting} aria-busy={exporting}><Download size={15} aria-hidden="true" />{exporting ? t('내보내기 준비 중', 'Preparing export') : t('Markdown 내보내기', 'Export Markdown')}</button>
                </div>}
                {feed.status === 'loading' ? <Loading /> : feed.status === 'error' ? <ErrorState title={t('변경 기록을 불러오지 못했습니다.', 'Could not load changes.')} description={t('연결 상태를 확인한 뒤 다시 불러오세요.', 'Check your connection and try again.')} retry={feed.retry} />
                  : searchPending ? <Loading search /> : searchFailed ? <ErrorState title={t('검색 자료를 불러오지 못했습니다.', 'Could not search all changes.')} description={t('전체 내용을 검색하려면 검색 자료를 다시 불러오세요.', 'Try again to search the complete article text.')} retry={searchIndex.retry} />
                    : entries.length > 0 ? <><div className="entry-list">{entries.slice(0, visibleCount).map(entry => <EntryCard key={entry.id} entry={entry} saved={saved.ids.includes(entry.id)} read={reading.isRead(entry)} onSave={() => saved.toggle(entry.id)} onOpen={() => openEntry(entry.id)} href={entryHref(entry.id)} />)}</div>{entries.length > visibleCount && <button className="load-more" onClick={() => setVisibleCount(count => count + 20)}>{t('변경 기록 더 보기', 'Load more changes')}<span>{t(`${Math.min(20, entries.length - visibleCount)}개`, `${Math.min(20, entries.length - visibleCount)} more`)}</span><ArrowDown size={15} aria-hidden="true" /></button>}</>
                      : <div className="empty-state"><span className="state-icon">{selection.saved ? <Bookmark size={25} aria-hidden="true" /> : <Search size={25} aria-hidden="true" />}</span><h3>{selection.saved && !filterActive ? t('저장한 글이 없습니다.', 'No saved articles yet.') : filterActive ? t('조건에 맞는 글이 없습니다.', 'No matching articles.') : t('아직 발표 기록이 없습니다.', 'No announcements yet.')}</h3><p>{selection.saved && !filterActive ? t('다시 읽고 싶은 글에서 저장 버튼을 눌러보세요.', 'Save an article to read it again later.') : filterActive ? t('검색어를 줄이거나 다른 날짜와 제품을 선택해 보세요.', 'Try fewer keywords, another date range or a different product.') : sourceErrors ? t('출처를 확인하지 못했습니다. 확인 상태에서 마지막 수집 결과를 볼 수 있습니다.', 'Sources could not be checked. Open collection status for the latest result.') : sourcePending ? t('공식 출처 확인을 마치면 변경 기록을 보여드립니다.', 'Changes will appear after the official sources have been checked.') : t('공식 출처를 확인했습니다. 새 발표가 있으면 이곳에 표시합니다.', 'Official sources have been checked. New announcements will appear here.')}</p>{filterActive ? <button className="secondary-button" onClick={clearFilters}>{t('필터 초기화', 'Reset filters')}<ArrowRight size={15} aria-hidden="true" /></button> : selection.saved ? <button className="secondary-button" onClick={() => applyFilters({ saved: false })}>{t('전체 글 보기', 'View all articles')}<ArrowRight size={15} aria-hidden="true" /></button> : <button className="secondary-button" onClick={() => setModal('sources')}>{t('수집 상태 확인', 'View collection status')}<ArrowRight size={15} aria-hidden="true" /></button>}</div>}
                {feed.data && <div className="feed-footnote"><span className={`status-dot ${sourceErrors || freshnessWarning ? 'error' : sourcePending ? 'pending' : 'ok'}`} /><span>{lastChecked ? t(`최근 확인 ${displayTimestamp(lastChecked, language)} (한국 시간)`, `Last checked ${displayTimestamp(lastChecked, language)} (KST)`) : t('첫 출처 확인을 기다리고 있습니다.', 'Waiting for the first source check.')}</span></div>}
              </div>
              {feed.data && <FeedAside feed={feed.data} onSources={() => setModal('sources')} />}
            </div>
          </section>
        </>}
    </main>
    <footer className="site-footer">
      <div className="footer-brand"><BrandMark small /><strong>Code Pulse</strong>
        <button className="app-version" aria-label={t(`서비스 변경 기록, 버전 ${__APP_VERSION__}`, `Service updates, version ${__APP_VERSION__}`)} aria-haspopup="dialog" onClick={() => setModal('releases')}>v{__APP_VERSION__}</button>
        <span>{t('공식 릴리스의 새 기능과 적용 조건', 'Official releases and every recorded change')}</span>
      </div>
      <div className="footer-meta">
        <PresenceCounter />
        <div className="footer-links"><span>{t('공식 발표를 바탕으로 만든 AI 해설', 'English wording from official announcements')}</span><button onClick={() => setModal('sources')}>{t('출처와 이용 안내', 'Sources and about')}<ArrowUpRightIcon /></button></div>
      </div>
    </footer>
    <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite" aria-atomic="true"><span key={toast?.id}>{toast?.message}</span></div>
    {modal === 'sources' && <SourcesDialog feed={feed.data} onClose={() => setModal(null)} />}
    {modal === 'releases' && <ServiceReleaseDialog onClose={() => setModal(null)} />}
    {modal === 'rss' && <SubscriptionDialog product={selection.product} onClose={() => setModal(null)} />}
    {modal === 'dates' && <DateDialog from={selection.from} to={selection.to} onClose={() => setModal(null)} onApply={(from, to) => { applyFilters({ from, to }); setModal(null); }} />}
    {modal === 'share' && <Modal title={t('글 주소 공유', 'Share article')} onClose={() => setModal(null)} className="share-modal"><p className="modal-intro">{t('아래 주소를 복사해 공유하세요.', 'Copy the address below to share this article.')}</p><label className="share-label">{t('공유할 글 주소', 'Article URL')}<input readOnly value={shareUrl.href} onFocus={event => event.target.select()} /></label></Modal>}
  </>;
}

function ArrowUpRightIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 12 12 4M4 4h8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

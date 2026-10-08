import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, Bookmark, BookOpen, CalendarDays, ChevronDown, CircleHelp, Clock3, Download, Layers3, Moon, Rss, Search, SlidersHorizontal, Sun, X } from 'lucide-react';
import { PRODUCT_IDS, type Entry, type Feed } from '../shared/types';
import { ActivityTable, BrandMark, CollectionStatus, DateDialog, EntryCard, EntryDetail, ErrorState, FeedAside, Loading, Modal, ProductMark, SourcesDialog } from './components';
import { adjacentEntries, categories, displayDate, displayTimestamp, entryTitle, filterEntries, getCollectionState, products, readLocation, type Filters } from './lib';
import { useRemote, useSaved } from './hooks';
import { PresenceCounter, ServiceReleaseDialog } from './footer';
import { entryRevision, useReading } from './reading';
import { SubscriptionDialog } from './subscriptions';
import { downloadSavedMarkdown } from './export';

export default function App() {
  const [search, setSearch] = useState(window.location.search);
  const selection = useMemo(() => readLocation(search), [search]);
  const [modal, setModal] = useState<'sources' | 'dates' | 'share' | 'releases' | 'rss' | null>(null);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const [visibleCount, setVisibleCount] = useState(20);
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
  const feed = useRemote<Feed>('/api/feed');
  const detail = useRemote<Entry>(selection.entry ? `/api/entries/${encodeURIComponent(selection.entry)}` : null);
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
      : 'Code Pulse | 코딩 도구의 변경 기록';
  }, [currentDetail]);

  useEffect(() => {
    setVisibleCount(20);
  }, [selection.product, selection.category, selection.query, selection.from, selection.to, selection.saved, selection.unread]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const navigate = useCallback((params: URLSearchParams, push = false) => {
    const query = params.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
    if (push) window.history.pushState({ codePulseEntry: params.has('entry') }, '', url);
    else window.history.replaceState(window.history.state, '', url);
    setSearch(window.location.search);
  }, []);

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
    return `?${params.toString()}`;
  };
  const share = async () => {
    const url = new URL(window.location.href);
    url.search = new URLSearchParams({ entry: selection.entry! }).toString();
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url.href);
      announce('글 주소를 복사했습니다.');
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
  const entries = useMemo(() => filterEntries(feed.data?.entries ?? [], selection, saved.ids, reading.isRead), [feed.data, selection, saved.ids, reading.isRead]);
  const adjacent = feed.status === 'ready' && feed.data && currentDetail ? adjacentEntries(feed.data.entries, currentDetail) : undefined;
  const exportSaved = () => {
    if (feed.status !== 'ready' || !feed.data || !selection.saved || !entries.length) return;
    try {
      downloadSavedMarkdown(entries, window.location.origin);
      announce(`저장한 글 ${entries.length}개를 Markdown 파일로 내보냈습니다.`);
    } catch {
      announce('파일을 만들지 못했습니다. 잠시 후 다시 시도하세요.');
    }
  };
  const filterActive = Boolean(selection.query || selection.product !== 'all' || selection.category !== 'all' || selection.from || selection.to || selection.unread);
  const collection = feed.data ? getCollectionState(feed.data) : null;
  const sourceErrors = collection?.sourceErrors;
  const sourcePending = collection?.sourcePending ?? true;
  const freshnessWarning = collection?.oldData || collection?.statusUnavailable;
  const lastChecked = feed.data?.latestRun?.completedAt;
  const dateLabel = selection.from && selection.from === selection.to ? displayDate(selection.from)
    : selection.from || selection.to ? `${selection.from ? displayDate(selection.from) : '처음'} ~ ${selection.to ? displayDate(selection.to) : '최근'}` : '날짜 선택';

  return <>
    <a className="skip-link" href="#main-content">본문으로 건너뛰기</a>
    <header className="site-header">
      <div className="header-inner">
        <a href="/" className="brand" aria-label="Code Pulse 홈" onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); goHome();
        }}><BrandMark /><span>Code<span className="brand-light">Pulse</span><small>코딩 도구의 변경 기록</small></span></a>
        <nav className="primary-nav" aria-label="주 메뉴">
          <button className={!selection.saved ? 'nav-link active' : 'nav-link'} aria-current={!selection.saved && !selection.entry ? 'page' : undefined} onClick={() => applyFilters({ saved: false })}>변경 기록</button>
          <button className={selection.saved ? 'nav-link active' : 'nav-link'} aria-label={`저장한 글 보기 ${saved.ids.length}개`} aria-current={selection.saved ? 'page' : undefined} onClick={() => applyFilters({ saved: true })}><Bookmark size={15} aria-hidden="true" /><span>저장한 글</span>{saved.ids.length > 0 && <span className="saved-count">{saved.ids.length}</span>}</button>
        </nav>
        <div className="header-actions"><button className="source-button" onClick={() => setModal('sources')} aria-label="출처 안내"><CircleHelp size={17} aria-hidden="true" /><span>출처 안내</span></button><span className="header-divider" /><button className="icon-button theme-button" onClick={toggleTheme} aria-label={theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환'}>{theme === 'light' ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}</button></div>
      </div>
    </header>

    <main id="main-content" className={selection.entry ? 'page-shell detail-page' : 'page-shell'} tabIndex={-1}>
      {selection.entry ? detail.status === 'loading' || detail.data?.id !== selection.entry && detail.status === 'ready'
        ? <Loading detail />
        : detail.status === 'error'
          ? <ErrorState title={detail.notFound ? '글을 찾을 수 없습니다.' : '글을 불러오지 못했습니다.'} description={detail.notFound ? '주소가 올바른지 확인하거나 목록에서 글을 다시 찾아보세요.' : '잠시 후 다시 불러오세요. 목록의 다른 글은 계속 확인할 수 있습니다.'} retry={detail.notFound ? undefined : detail.retry} goBack={backToList} />
          : currentDetail && <EntryDetail entry={currentDetail} saved={saved.ids.includes(currentDetail.id)} read={reading.isRead(currentDetail)} onSave={() => saved.toggle(currentDetail.id)} onRead={() => reading.isRead(currentDetail) ? reading.markUnread(currentDetail.id) : reading.markRead(currentDetail)} onBack={backToList} onShare={() => void share()} adjacent={adjacent} href={entryHref} onAdjacent={openAdjacentEntry} />
        : <>
          <section className="hero" aria-labelledby="page-heading">
            <div className="hero-copy">
              <div className="eyebrow"><span />FOLLOW THE CHANGE</div>
              <h1 id="page-heading" tabIndex={-1}>코딩 도구의 변화,<br /><span>한곳에서.</span></h1>
              <p>Claude Code, Codex, Kiro의 공식 발표를 모아<br className="desktop-break" /> 새 기능과 달라진 점을 한국어로 전합니다.<br />2026년 1월 1일부터 최신 발표까지 확인할 수 있습니다.</p>
              <div className="schedule"><Clock3 size={14} aria-hidden="true" />매일 오전 9시 확인<span>한국 시간</span></div>
              <div className="collection-brief">
                <span className={`status-dot ${feed.status === 'error' || sourceErrors || freshnessWarning ? 'error' : sourcePending ? 'pending' : 'ok'}`} />
                <button onClick={() => setModal('sources')}>
                  {feed.status === 'loading' ? '확인 상태를 불러오고 있습니다'
                    : feed.status === 'error' ? '수집 상태를 불러오지 못했습니다'
                      : collection?.runFailed ? '모든 출처 확인 실패'
                        : sourceErrors ? '일부 출처 확인 실패'
                          : sourcePending ? collection?.initialPending ? '첫 출처 확인 대기' : '일부 출처 확인 대기'
                            : collection?.oldData ? '마지막 확인 이후 시간이 지났습니다'
                              : collection?.statusUnavailable ? '최신 수집 상태 확인 불가'
                                : '공식 출처 확인 완료'}
                  {lastChecked && ` / ${displayTimestamp(lastChecked).slice(5)}`}
                </button>
              </div>
            </div>
            {feed.data ? <ActivityTable entries={feed.data.entries} selectedProduct={selection.product} selectedDate={selection.from === selection.to ? selection.from : ''} onSelect={(product, day) => applyFilters({ product, from: day, to: day })} />
              : <div className="activity-placeholder"><div className="activity-placeholder-icon"><Layers3 size={26} aria-hidden="true" /></div><p>지난 7일의 변화</p><span>{feed.status === 'error' ? '피드를 불러오면 활동을 확인할 수 있습니다.' : '공식 발표 기록을 확인하고 있습니다.'}</span></div>}
          </section>

          <section className="feed-section" aria-label="변경 기록 목록">
            <div className="product-filters" role="group" aria-label="제품 필터">
              <button className={selection.product === 'all' ? 'product-filter selected' : 'product-filter'} aria-pressed={selection.product === 'all'} onClick={() => applyFilters({ product: 'all' })}><Layers3 size={16} aria-hidden="true" />전체<span>{feed.data?.entries.length ?? 0}</span></button>
              {PRODUCT_IDS.map(product => <button key={product} className={`product-filter ${selection.product === product ? 'selected' : ''}`} aria-pressed={selection.product === product} onClick={() => applyFilters({ product })}><ProductMark product={product} />{products[product].name}<span>{feed.data?.entries.filter(entry => entry.product === product).length ?? 0}</span></button>)}
            </div>
            <div className="filter-toolbar">
              <div className="search-field"><Search size={19} aria-hidden="true" /><input ref={input} type="search" aria-label="변경 기록 검색" placeholder="기능, 키워드, 버전으로 검색" value={selection.query} onChange={event => applyFilters({ query: event.target.value })} autoComplete="off" />{selection.query ? <button className="clear-search" aria-label="검색어 지우기" onClick={() => { applyFilters({ query: '' }); input.current?.focus(); }}><X size={16} aria-hidden="true" /></button> : <kbd aria-hidden="true">/</kbd>}</div>
              <div className="toolbar-select"><SlidersHorizontal size={15} aria-hidden="true" /><select aria-label="변경 종류" value={selection.category} onChange={event => applyFilters({ category: event.target.value as Filters['category'] })}><option value="all">모든 변경</option>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="pending">해설 준비 중</option></select><ChevronDown size={13} aria-hidden="true" /></div>
              <button className={`date-filter ${selection.from || selection.to ? 'has-filter' : ''}`} onClick={() => setModal('dates')} aria-label="날짜 선택"><CalendarDays size={16} aria-hidden="true" /><span>{dateLabel}</span><ChevronDown size={13} aria-hidden="true" /></button>
            </div>
            <div className="reading-tools" role="group" aria-label="읽기 도구">
              <button className="unread-filter" aria-pressed={selection.unread} onClick={() => applyFilters({ unread: !selection.unread })}><BookOpen size={15} aria-hidden="true" />읽지 않은 글만</button>
              <button className="subscribe-button" aria-haspopup="dialog" onClick={() => setModal('rss')}><Rss size={15} aria-hidden="true" />RSS 구독</button>
            </div>
            {filterActive && <div className="active-filters" aria-label="선택한 필터">{selection.product !== 'all' && <span>{products[selection.product].name}</span>}{selection.category !== 'all' && <span>{selection.category === 'pending' ? '해설 준비 중' : categories[selection.category]}</span>}{selection.query.trim() && <span>“{selection.query.trim()}”</span>}{(selection.from || selection.to) && <span>{dateLabel}</span>}{selection.unread && <span>읽지 않은 글</span>}<button aria-label="선택한 필터 모두 지우기" onClick={clearFilters}><X size={13} aria-hidden="true" />지우기</button></div>}
            {feed.data && <CollectionStatus feed={feed.data} />}
            <div className="feed-layout">
              <div className="feed-main">
                <div className="feed-heading"><h2 id="feed-heading" tabIndex={-1}>{selection.saved ? '저장한 글' : filterActive ? '찾은 변경 기록' : '최근 변경 기록'}{feed.status === 'ready' && <span>{entries.length}</span>}</h2><span><ArrowDown size={13} aria-hidden="true" />발표일 최신순</span></div>
                {selection.saved && <div className="saved-export">
                  <p>{feed.status === 'ready' ? `현재 필터에 맞는 저장 글 ${entries.length}개` : feed.status === 'loading' ? '목록을 불러오면 저장한 글을 내보낼 수 있습니다.' : '목록을 다시 불러온 뒤 내보내기를 이용하세요.'}</p>
                  <button className="secondary-button" onClick={exportSaved} disabled={feed.status !== 'ready' || !entries.length}><Download size={15} aria-hidden="true" />Markdown 내보내기</button>
                </div>}
                {feed.status === 'loading' ? <Loading /> : feed.status === 'error' ? <ErrorState title="변경 기록을 불러오지 못했습니다." description="연결 상태를 확인한 뒤 다시 불러오세요." retry={feed.retry} />
                  : entries.length > 0 ? <><div className="entry-list">{entries.slice(0, visibleCount).map(entry => <EntryCard key={entry.id} entry={entry} saved={saved.ids.includes(entry.id)} read={reading.isRead(entry)} onSave={() => saved.toggle(entry.id)} onOpen={() => openEntry(entry.id)} href={entryHref(entry.id)} />)}</div>{entries.length > visibleCount && <button className="load-more" onClick={() => setVisibleCount(count => count + 20)}>변경 기록 더 보기<span>{Math.min(20, entries.length - visibleCount)}개</span><ArrowDown size={15} aria-hidden="true" /></button>}</>
                    : <div className="empty-state"><span className="state-icon">{selection.saved ? <Bookmark size={25} aria-hidden="true" /> : <Search size={25} aria-hidden="true" />}</span><h3>{selection.saved && !filterActive ? '저장한 글이 없습니다.' : filterActive ? '조건에 맞는 글이 없습니다.' : '아직 발표 기록이 없습니다.'}</h3><p>{selection.saved && !filterActive ? '다시 읽고 싶은 글에서 저장 버튼을 눌러보세요.' : filterActive ? '검색어를 줄이거나 다른 날짜와 제품을 선택해 보세요.' : sourceErrors ? '출처를 확인하지 못했습니다. 확인 상태에서 마지막 수집 결과를 볼 수 있습니다.' : sourcePending ? '공식 출처 확인을 마치면 변경 기록을 보여드립니다.' : '공식 출처를 확인했습니다. 새 발표가 있으면 이곳에 표시합니다.'}</p>{filterActive ? <button className="secondary-button" onClick={clearFilters}>필터 초기화<ArrowRight size={15} aria-hidden="true" /></button> : selection.saved ? <button className="secondary-button" onClick={() => applyFilters({ saved: false })}>전체 글 보기<ArrowRight size={15} aria-hidden="true" /></button> : <button className="secondary-button" onClick={() => setModal('sources')}>수집 상태 확인<ArrowRight size={15} aria-hidden="true" /></button>}</div>}
                {feed.data && <div className="feed-footnote"><span className={`status-dot ${sourceErrors || freshnessWarning ? 'error' : sourcePending ? 'pending' : 'ok'}`} /><span>{lastChecked ? `최근 확인 ${displayTimestamp(lastChecked)} (한국 시간)` : '첫 출처 확인을 기다리고 있습니다.'}</span></div>}
              </div>
              {feed.data && <FeedAside feed={feed.data} onSources={() => setModal('sources')} />}
            </div>
          </section>
        </>}
    </main>
    <footer className="site-footer">
      <div className="footer-brand"><BrandMark small /><strong>Code Pulse</strong>
        <button className="app-version" aria-label={`서비스 변경 기록, 버전 ${__APP_VERSION__}`} aria-haspopup="dialog" onClick={() => setModal('releases')}>v{__APP_VERSION__}</button>
        <span>공식 릴리스의 새 기능과 적용 조건</span>
      </div>
      <div className="footer-meta">
        <PresenceCounter />
        <div className="footer-links"><span>공식 발표를 바탕으로 만든 AI 해설</span><button onClick={() => setModal('sources')}>출처와 이용 안내<ArrowUpRightIcon /></button></div>
      </div>
    </footer>
    <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite" aria-atomic="true"><span key={toast?.id}>{toast?.message}</span></div>
    {modal === 'sources' && <SourcesDialog feed={feed.data} onClose={() => setModal(null)} />}
    {modal === 'releases' && <ServiceReleaseDialog onClose={() => setModal(null)} />}
    {modal === 'rss' && <SubscriptionDialog product={selection.product} onClose={() => setModal(null)} />}
    {modal === 'dates' && <DateDialog from={selection.from} to={selection.to} onClose={() => setModal(null)} onApply={(from, to) => { applyFilters({ from, to }); setModal(null); }} />}
    {modal === 'share' && <Modal title="글 주소 공유" onClose={() => setModal(null)} className="share-modal"><p className="modal-intro">아래 주소를 복사해 공유하세요.</p><label className="share-label">공유할 글 주소<input readOnly value={`${window.location.origin}${window.location.pathname}?${new URLSearchParams({ entry: selection.entry ?? '' }).toString()}`} onFocus={event => event.target.select()} /></label></Modal>}
  </>;
}

function ArrowUpRightIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 12 12 4M4 4h8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

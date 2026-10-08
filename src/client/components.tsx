import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Bookmark, BookOpen, Check, Clock3, ExternalLink, Info, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { PRODUCT_IDS, type Entry, type Feed, type FeedEntry, type ProductId } from '../shared/types';
import { categories, channels, displayDate, displayTimestamp, entryTitle, getCollectionState, lastSevenDays, officialHref, products } from './lib';

export function BrandMark({ small = false }: { small?: boolean }) {
  return <svg className={small ? 'brand-mark small' : 'brand-mark'} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <rect width="40" height="40" rx="12" fill="currentColor" />
    <path d="m12.5 14-6 6 6 6m15-12 6 6-6 6M17 26l3-12 3 12" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function ProductMark({ product }: { product: ProductId }) {
  return <span className={`product-mark ${product}`} aria-hidden="true">
    <img src={products[product].logo} alt="" width={23} height={23} decoding="async" draggable={false} />
  </span>;
}

export function External({ href, children, className = '', ...props }: {
  href: string;
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  const safe = officialHref(href);
  return safe
    ? <a href={safe} target="_blank" rel="noopener noreferrer" className={className} {...props}>{children}</a>
    : <span className={className}>{children}</span>;
}

export function ActivityTable({ entries, onSelect, selectedProduct, selectedDate }: {
  entries: FeedEntry[];
  onSelect: (product: ProductId, day: string) => void;
  selectedProduct: string;
  selectedDate: string;
}) {
  const days = lastSevenDays();
  return <section className="activity-panel" aria-labelledby="activity-heading">
    <div className="activity-heading">
      <h2 id="activity-heading"><span className="pulse-dot" />지난 7일의 변화</h2>
      <span className="mono">{days[0].slice(5).replace('-', '.')} ~ {days[6].slice(5).replace('-', '.')}</span>
    </div>
    <table className="activity-table">
      <caption className="sr-only">제품별 발표 건수입니다. 날짜를 선택하면 해당 제품의 글을 볼 수 있습니다.</caption>
      <thead><tr><th scope="col"><span className="sr-only">제품</span></th>{days.map((day, index) => <th scope="col" key={day} className={index === 6 ? 'today' : ''}>{day.slice(8)}<span className="sr-only">일</span></th>)}</tr></thead>
      <tbody>{PRODUCT_IDS.map(product => <tr key={product}>
        <th scope="row"><ProductMark product={product} /><span>{products[product].name}</span></th>
        {days.map(day => {
          const count = entries.filter(entry => entry.product === product && entry.publishedDate === day).length;
          return <td key={day}><button
            className={`activity-cell ${product} ${count ? 'has-entries' : ''} ${count > 2 ? 'busy' : ''}`}
            aria-label={`${products[product].name} ${day} 발표 ${count}건`}
            aria-pressed={selectedProduct === product && selectedDate === day}
            onClick={() => onSelect(product, day)}
            title={`${displayDate(day)} 발표 ${count}건`}
          >{count || <span className="empty-cell-dot" />}</button></td>;
        })}
      </tr>)}</tbody>
    </table>
    <div className="activity-foot"><span>칸을 눌러 발표일을 살펴보세요</span><span className="activity-legend"><span />발표한 글</span></div>
  </section>;
}

export function CollectionStatus({ feed }: { feed: Feed }) {
  const state = getCollectionState(feed);
  if (!state.oldData && !state.statusUnavailable && !state.sourceErrors && !state.sourcePending && !state.pendingExplanations) return null;
  return <div role="status" aria-label="자료 상태" className="collection-notice">
    <Info size={18} aria-hidden="true" />
    <div>
      {state.oldData && <p>마지막 확인 이후 시간이 지났습니다. 최신 발표는 공식 출처에서 확인하세요.</p>}
      {state.statusUnavailable && <p>최신 수집 상태를 확인하지 못했습니다. 마지막으로 확인한 자료를 보여드립니다.</p>}
      {state.runFailed
        ? <p>이번 수집에서 모든 출처를 확인하지 못했습니다.{feed.entries.length > 0 && ' 이전에 확인한 글을 보여드립니다.'}</p>
        : state.sourceErrors && <p>일부 출처를 확인하지 못했습니다. 확인된 글은 계속 읽을 수 있습니다.</p>}
      {state.sourcePending && !state.runFailed && <p>{state.initialPending ? '첫 출처 확인을 기다리고 있습니다.' : '아직 확인을 마치지 않은 출처가 있습니다.'}</p>}
      {state.pendingExplanations && <p>일부 글은 아직 한국어 해설이 없습니다. 공식 원문을 먼저 확인할 수 있습니다.</p>}
    </div>
  </div>;
}

export function SaveButton({ saved, onClick, withText = false }: { saved: boolean; onClick: () => void; withText?: boolean }) {
  return <button className={`${withText ? 'secondary-button' : 'icon-button save-button'} ${saved ? 'is-saved' : ''}`}
    aria-label={saved ? '저장 해제' : '글 저장'} aria-pressed={saved} onClick={onClick} title={saved ? '저장 해제' : '글 저장'}>
    <Bookmark size={17} aria-hidden="true" fill={saved ? 'currentColor' : 'none'} />
    {withText && (saved ? '저장한 글' : '글 저장')}
  </button>;
}

export function EntryCard({ entry, saved, read, onSave, onOpen, href }: {
  entry: FeedEntry;
  saved: boolean;
  read: boolean;
  onSave: () => void;
  onOpen: () => void;
  href: string;
}) {
  const title = entryTitle(entry);
  const category = entry.explanation?.category;
  return <article className="entry-card" data-testid="entry-card" data-entry-id={entry.id}>
    <div className="entry-date"><time dateTime={entry.publishedDate}><span>{entry.publishedDate.slice(5).replace('-', '.')}</span><small>{entry.publishedDate.slice(0, 4)}</small></time></div>
    <div className="entry-body">
      <div className="entry-meta"><span className="product-name"><ProductMark product={entry.product} />{products[entry.product].name}</span><span className="channel-label">{channels[entry.channel]}</span>{entry.version && <span className="version-label">{entry.version}</span>}</div>
      <h3><a id={`entry-link-${entry.id}`} href={href} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen();
      }}>{title}<ArrowUpRight className="entry-arrow" size={19} aria-hidden="true" /></a></h3>
      <p className="entry-summary">{entry.explanation?.summary || '한국어 해설을 준비하고 있습니다. 공식 원문을 먼저 확인할 수 있습니다.'}</p>
      <div className="entry-bottom">
        <div className="entry-tags">{category ? <span className={`category-tag ${category}`}>{categories[category]}</span> : <span className="pending-tag"><Clock3 size={12} aria-hidden="true" />해설 준비 중</span>}
          {entry.explanation?.impact === 'high' && <span className="impact-label">적용 전 확인</span>}
          {read && <span className="read-badge"><Check size={12} aria-hidden="true" />읽음</span>}
        </div>
        <SaveButton saved={saved} onClick={onSave} />
      </div>
    </div>
  </article>;
}

export function Loading({ detail = false }: { detail?: boolean }) {
  return <div className={detail ? 'loading-state detail-loading' : 'loading-state'} role="status" aria-label="불러오는 중" aria-live="polite">
    <p><LoaderCircle className="spinner" size={17} aria-hidden="true" />{detail ? '글을 불러오고 있습니다' : '변경 기록을 불러오고 있습니다'}</p>
    {[0, 1, 2].map(index => <div className="skeleton-entry" key={index} aria-hidden="true"><span /><div><i /><i /><i /></div></div>)}
  </div>;
}

export function ErrorState({ title, description, retry, goBack }: { title: string; description: string; retry?: () => void; goBack?: () => void }) {
  return <div className="empty-state error-state" role="alert">
    <span className="state-icon"><Info size={25} aria-hidden="true" /></span>
    <h2>{title}</h2><p>{description}</p>
    <div className="state-actions">{retry && <button className="primary-button" onClick={retry}><RefreshCw size={16} aria-hidden="true" />다시 불러오기</button>}{goBack && <button className="secondary-button" onClick={goBack}>목록으로 돌아가기<ArrowRight size={15} aria-hidden="true" /></button>}</div>
  </div>;
}

export function Modal({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const oldOverflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    return () => {
      element?.close();
      document.body.style.overflow = oldOverflow;
      previous?.focus();
    };
  }, []);
  return <dialog ref={dialog} className={`modal ${className}`} aria-label={title} aria-modal="true"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}
    onKeyDown={event => {
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex="0"]')).filter(element => !element.hasAttribute('disabled'));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div className="modal-heading"><h2>{title}</h2><button ref={closeButton} className="icon-button" onClick={onClose} aria-label="닫기"><X size={20} aria-hidden="true" /></button></div>
    {children}
  </dialog>;
}

export function SourcesDialog({ feed, onClose }: { feed: Feed | null; onClose: () => void }) {
  return <Modal title="공식 출처와 수집 상태" onClose={onClose} className="sources-modal">
    <p className="modal-intro">각 제품의 공식 발표를 매일 오전 9시, 한국 시간에 확인합니다. 아래 시각은 출처를 확인한 시각입니다.</p>
    {!feed && <p className="inline-note">피드를 불러오면 출처별 확인 상태를 볼 수 있습니다.</p>}
    <div className="source-list">{feed?.sources.map(source => <section key={source.id} className="source-item">
      <div className="source-item-heading"><ProductMark product={source.product} /><h3><External href={source.url}>{source.name}<ExternalLink size={13} aria-hidden="true" /></External></h3><span className={`source-status ${source.state}`}>{source.state === 'ok' ? '확인 완료' : source.state === 'error' ? '확인 실패' : '확인 대기'}</span></div>
      <dl className="source-times"><div><dt>최근 확인</dt><dd>{displayTimestamp(source.checkedAt)}</dd></div><div><dt>마지막 성공</dt><dd>{displayTimestamp(source.lastSuccessAt)}</dd></div>{source.latestPublishedDate && <div><dt>최근 발표일</dt><dd>{displayDate(source.latestPublishedDate)}</dd></div>}</dl>
      {source.state === 'error' && <p className="source-failure">이번 확인에 실패했습니다. 이전에 확인한 글을 유지합니다.</p>}
    </section>)}</div>
    <div className="source-policy"><Info size={17} aria-hidden="true" /><p>한국어 설명은 공식 자료를 바탕으로 생성한 AI 해설입니다. 적용 범위와 세부 조건은 각 글에 연결된 공식 원문을 확인하세요.</p></div>
    <p className="modal-fine-print">Code Pulse는 각 제품의 공식 서비스가 아닙니다. 모든 확인 시각은 한국 시간입니다.</p>
  </Modal>;
}

export function DateDialog({ from, to, onApply, onClose }: { from: string; to: string; onApply: (from: string, to: string) => void; onClose: () => void }) {
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);
  const [error, setError] = useState('');
  return <Modal title="날짜로 찾기" onClose={onClose} className="date-modal">
    <p className="modal-intro">공식 발표일을 기준으로 찾습니다. 같은 날짜를 고르면 하루의 글만 볼 수 있습니다.</p>
    <form onSubmit={event => {
      event.preventDefault();
      if (start && end && start > end) { setError('종료일은 시작일과 같거나 뒤여야 합니다.'); return; }
      onApply(start, end);
    }}>
      <div className="date-inputs"><label>시작일<input type="date" value={start} onChange={event => { setStart(event.target.value); setError(''); }} /></label><span aria-hidden="true">~</span><label>종료일<input type="date" value={end} min={start || undefined} onChange={event => { setEnd(event.target.value); setError(''); }} /></label></div>
      <div className="date-presets"><button type="button" onClick={() => { const days = lastSevenDays(); setStart(days[0]); setEnd(days[6]); setError(''); }}>최근 7일</button><button type="button" onClick={() => { const today = lastSevenDays()[6]; setStart(today); setEnd(today); setError(''); }}>오늘</button><button type="button" onClick={() => { setStart(''); setEnd(''); setError(''); }}>모든 날짜</button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button full-width" type="submit">날짜 적용<Check size={16} aria-hidden="true" /></button>
    </form>
  </Modal>;
}

export function FeedAside({ feed, onSources }: { feed: Feed; onSources: () => void }) {
  return <aside className="feed-aside">
    <section className="source-summary">
      <div className="aside-eyebrow">FROM THE SOURCE</div>
      <h2>공식 기록에서<br />시작합니다.</h2>
      <p>공식 릴리스를 모아<br />새 기능과 적용 조건을 설명합니다.</p>
      <div className="source-summary-products">{PRODUCT_IDS.map(product => {
        const sourceStatuses = feed.sources.filter(source => source.product === product);
        const state = sourceStatuses.some(source => source.state === 'error') ? 'error' : sourceStatuses.length > 0 && sourceStatuses.every(source => source.state === 'ok') ? 'ok' : 'pending';
        return <div key={product}><span><ProductMark product={product} />{products[product].name}</span><span className={`status-dot ${state}`} aria-label={state === 'ok' ? '확인 완료' : state === 'error' ? '일부 확인 실패' : '확인 대기'} /></div>;
      })}</div>
      <button className="text-button" onClick={onSources}>출처별 확인 상태<ArrowUpRight size={15} aria-hidden="true" /></button>
    </section>
    <section className="reading-note"><Info size={16} aria-hidden="true" /><div><h3>발표일을 기준으로 읽습니다.</h3><p>늦게 수집한 글도 원래 발표한 날짜에 표시합니다.</p></div></section>
    <section className="reading-note"><Bookmark size={16} aria-hidden="true" /><div><h3>다시 읽을 글은 저장하세요.</h3><p>저장한 글은 같은 브라우저에서 다시 볼 수 있습니다.</p></div></section>
  </aside>;
}

export function EntryDetail({ entry, saved, read, onSave, onRead, onBack, onShare, adjacent, href, onAdjacent }: {
  entry: Entry;
  saved: boolean;
  read: boolean;
  onSave: () => void;
  onRead: () => void;
  onBack: () => void;
  onShare: () => void;
  adjacent?: { older?: FeedEntry; newer?: FeedEntry };
  href: (id: string) => string;
  onAdjacent: (id: string) => void;
}) {
  const title = entryTitle(entry);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [entry.id]);
  const references = entry.references.filter(reference => reference.url !== entry.sourceUrl)
    .filter((reference, index, all) => all.findIndex(item => item.url === reference.url) === index);
  return <div className="detail-wrap">
    <button className="back-button" onClick={onBack}><ArrowDown size={15} className="back-arrow" aria-hidden="true" />변경 기록으로 돌아가기</button>
    <article className="detail-article" aria-labelledby="detail-title">
      <div className="entry-meta detail-meta"><span className="product-name"><ProductMark product={entry.product} />{products[entry.product].name}</span><span className="channel-label">{channels[entry.channel]}</span>{entry.version && <span className="version-label">{entry.version}</span>}{entry.explanation && <span className={`category-tag ${entry.explanation.category}`}>{categories[entry.explanation.category]}</span>}</div>
      <h1 ref={heading} tabIndex={-1} id="detail-title">{title}</h1>
      {entry.explanation && <p className="detail-lead">{entry.explanation.summary}</p>}
      <div className="detail-dates"><div><span>공식 발표일</span><time data-testid="publication-date" dateTime={entry.datePrecision === 'day' ? entry.publishedDate : entry.publishedAt}>{displayDate(entry.publishedDate)}</time>{entry.datePrecision === 'timestamp' && <small>한국 시간 {displayTimestamp(entry.publishedAt)}</small>}</div><div><span>출처 확인</span><time dateTime={entry.checkedAt}>{displayTimestamp(entry.checkedAt)}</time><small>한국 시간</small></div></div>
      {entry.datePrecision === 'day' && <p className="date-precision-note">원문이 발표 시각을 제공하지 않아 날짜만 표시합니다.</p>}
      <div className="detail-actions"><External href={entry.sourceUrl} className="primary-button" aria-label="공식 원문 읽기">공식 원문 읽기<ArrowUpRight size={16} aria-hidden="true" /></External><SaveButton saved={saved} onClick={onSave} withText /><button className="secondary-button" onClick={onShare}><ExternalLink size={15} aria-hidden="true" />글 주소 복사</button>{entry.explanationStatus === 'ready' && entry.explanation && <button className="secondary-button reading-toggle" aria-pressed={read} onClick={onRead}>{read ? <Check size={15} aria-hidden="true" /> : <BookOpen size={15} aria-hidden="true" />}{read ? '읽지 않음으로 표시' : '읽음으로 표시'}</button>}</div>
      {entry.explanation ? <>
        <div className="ai-disclosure"><span>AI 해설</span><p>공식 자료를 바탕으로 정리했습니다. 적용 전에 원문의 조건과 범위를 확인하세요.</p></div>
        <section className="detail-section why-section"><div className="section-label">WHY IT MATTERS</div><h2>왜 중요한가요?</h2><p>{entry.explanation.whyItMatters}</p>{entry.explanation.audience.length > 0 && <div className="audience-label"><span>이런 분께</span>{entry.explanation.audience.join(', ')}</div>}</section>
        <section className="detail-section"><div className="section-label">WHAT CHANGED</div><h2>어떤 점이 달라졌나요?</h2><div className="highlights">{entry.explanation.highlights.map((highlight, index) => <div className="highlight" key={`${index}-${highlight.title}`}><h3>{highlight.title}</h3><p>{highlight.detail}</p><div className="evidence"><span>원문 근거</span><blockquote>{highlight.evidence}</blockquote><External href={entry.sourceUrl}>공식 발표에서 확인<ArrowUpRight size={13} aria-hidden="true" /></External></div></div>)}</div></section>
        {entry.explanation.actionItems.length > 0 && <section className="detail-section"><div className="section-label">BEFORE YOU START</div><h2>적용 전에 확인하세요</h2><ul className="action-items">{entry.explanation.actionItems.map((item, index) => <li key={`${index}-${item}`}><ArrowRight size={17} aria-hidden="true" /><span>{item}</span></li>)}</ul></section>}
      </> : <section className="pending-explanation"><Clock3 size={22} aria-hidden="true" /><h2>한국어 해설을 준비하고 있습니다.</h2><p>수집한 공식 발표의 해설을 아직 마치지 못했습니다. 위의 공식 원문에서 변경 내용을 먼저 확인할 수 있습니다.</p></section>}
      <section className="detail-section references-section"><h2>공식 출처</h2><External href={entry.sourceUrl} className="reference-link"><div><span>공식 발표</span><strong>{entry.originalTitle}</strong></div><ArrowUpRight size={18} aria-hidden="true" /></External>{references.map(reference => <External key={reference.url} href={reference.url} className="reference-link"><div><span>{reference.kind === 'blog' ? '공식 블로그' : '변경 기록'}</span><strong>{reference.title}</strong></div><ArrowUpRight size={18} aria-hidden="true" /></External>)}</section>
      <div className="detail-end"><span className="pulse-dot" /><span>읽은 변화가 다음 작업의 기준이 되도록.</span></div>
    </article>
    {(adjacent?.older || adjacent?.newer) && <nav className="adjacent-entries" aria-label="같은 제품의 변경 기록">
      {([
        { entry: adjacent.older, direction: 'older', label: '이전 발표' },
        { entry: adjacent.newer, direction: 'newer', label: '다음 발표' },
      ] as const).map(item => item.entry && <a key={item.direction} className={`adjacent-entry ${item.direction}`} href={href(item.entry.id)} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onAdjacent(item.entry!.id);
      }}>
        <span className="adjacent-label">{item.direction === 'older' && <ArrowLeft size={14} aria-hidden="true" />}{item.label}{item.direction === 'newer' && <ArrowRight size={14} aria-hidden="true" />}</span>
        <time dateTime={item.entry.publishedDate}>{displayDate(item.entry.publishedDate)}</time>
        <strong>{entryTitle(item.entry)}</strong>
      </a>)}
    </nav>}
  </div>;
}

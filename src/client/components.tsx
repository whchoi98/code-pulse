import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Bookmark, BookOpen, Check, Clock3, ExternalLink, Info, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { PRODUCT_IDS, type Feed, type FeedEntry, type ProductId, type PublicFullChanges } from '../shared/types';
import { displayDate, displayTimestamp, entryTitle, getCollectionState, getFullChangesState, lastSevenDays, officialHref, products } from './lib';
import { categoryLabel, channelLabel, useLocale } from './i18n';

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
  const { language, t } = useLocale();
  const days = lastSevenDays();
  return <section className="activity-panel" aria-labelledby="activity-heading">
    <div className="activity-heading">
      <h2 id="activity-heading"><span className="pulse-dot" />{t('지난 7일의 변화', 'The last 7 days')}</h2>
      <span className="mono">{days[0].slice(5).replace('-', '.')} ~ {days[6].slice(5).replace('-', '.')}</span>
    </div>
    <table className="activity-table">
      <caption className="sr-only">{t('제품별 발표 건수입니다. 날짜를 선택하면 해당 제품의 글을 볼 수 있습니다.', 'Announcements by product. Choose a date to read that product’s articles.')}</caption>
      <thead><tr><th scope="col"><span className="sr-only">{t('제품', 'Product')}</span></th>{days.map((day, index) => <th scope="col" key={day} className={index === 6 ? 'today' : ''}>{day.slice(8)}<span className="sr-only">{t('일', '')}</span></th>)}</tr></thead>
      <tbody>{PRODUCT_IDS.map(product => <tr key={product}>
        <th scope="row"><ProductMark product={product} /><span>{products[product].name}</span></th>
        {days.map(day => {
          const count = entries.filter(entry => entry.product === product && entry.publishedDate === day).length;
          return <td key={day}><button
            className={`activity-cell ${product} ${count ? 'has-entries' : ''} ${count > 2 ? 'busy' : ''}`}
            aria-label={t(`${products[product].name} ${day} 발표 ${count}건`, `${products[product].name}, ${day}, ${count} announcements`)}
            aria-pressed={selectedProduct === product && selectedDate === day}
            onClick={() => onSelect(product, day)}
            title={t(`${displayDate(day, language)} 발표 ${count}건`, `${displayDate(day, language)}: ${count} announcements`)}
          >{count || <span className="empty-cell-dot" />}</button></td>;
        })}
      </tr>)}</tbody>
    </table>
    <div className="activity-foot"><span>{t('칸을 눌러 발표일을 살펴보세요', 'Choose a day to browse announcements')}</span><span className="activity-legend"><span />{t('발표한 글', 'Announcements')}</span></div>
  </section>;
}

export function CollectionStatus({ feed }: { feed: Feed }) {
  const { t } = useLocale();
  const state = getCollectionState(feed);
  if (!state.oldData && !state.statusUnavailable && !state.sourceErrors && !state.sourcePending && !state.pendingExplanations) return null;
  return <div role="status" aria-label={t('자료 상태', 'Data status')} className="collection-notice">
    <Info size={18} aria-hidden="true" />
    <div>
      {state.oldData && <p>{t('마지막 확인 이후 시간이 지났습니다. 최신 발표는 공식 출처에서 확인하세요.', 'The last source check is overdue. Check official sources for the latest announcements.')}</p>}
      {state.statusUnavailable && <p>{t('최신 수집 상태를 확인하지 못했습니다. 마지막으로 확인한 자료를 보여드립니다.', 'The latest collection status is unavailable. Showing the last available records.')}</p>}
      {state.runFailed
        ? <p>{t('이번 수집에서 모든 출처를 확인하지 못했습니다.', 'Could not check any sources during this collection.')}{feed.entries.length > 0 && t(' 이전에 확인한 글을 보여드립니다.', ' Showing previously collected articles.')}</p>
        : state.sourceErrors && <p>{t('일부 출처를 확인하지 못했습니다. 확인된 글은 계속 읽을 수 있습니다.', 'Some sources could not be checked. Previously collected articles remain available.')}</p>}
      {state.sourcePending && !state.runFailed && <p>{state.initialPending ? t('첫 출처 확인을 기다리고 있습니다.', 'Waiting for the first source check.') : t('아직 확인을 마치지 않은 출처가 있습니다.', 'Some sources are still waiting to be checked.')}</p>}
      {state.pendingExplanations && <p>{state.pendingShortExplanations
        ? t('일부 글은 아직 한국어 해설이 없습니다. 공식 원문을 먼저 확인할 수 있습니다.', 'Some source details are not available yet. You can read the official announcements.')
        : t('일부 글의 전체 변경 사항 해설을 준비하고 있습니다. 요약과 공식 원문은 계속 확인할 수 있습니다.', 'Some complete change lists are not available yet. Overviews and official sources remain available.')}</p>}
    </div>
  </div>;
}

export function SaveButton({ saved, onClick, withText = false }: { saved: boolean; onClick: () => void; withText?: boolean }) {
  const { t } = useLocale();
  const label = saved ? t('저장 해제', 'Unsave article') : t('글 저장', 'Save article');
  return <button className={`${withText ? 'secondary-button' : 'icon-button save-button'} ${saved ? 'is-saved' : ''}`}
    aria-label={label} aria-pressed={saved} onClick={onClick} title={label}>
    <Bookmark size={17} aria-hidden="true" fill={saved ? 'currentColor' : 'none'} />
    {withText && (saved ? t('저장한 글', 'Saved') : t('글 저장', 'Save article'))}
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
  const { language, t } = useLocale();
  const title = entryTitle(entry);
  const category = entry.explanation?.category;
  return <article className="entry-card" data-testid="entry-card" data-entry-id={entry.id}>
    <div className="entry-date"><time dateTime={entry.publishedDate}><span>{entry.publishedDate.slice(5).replace('-', '.')}</span><small>{entry.publishedDate.slice(0, 4)}</small></time></div>
    <div className="entry-body">
      <div className="entry-meta"><span className="product-name"><ProductMark product={entry.product} />{products[entry.product].name}</span><span className="channel-label">{channelLabel(entry.channel, language)}</span>{entry.version && <span className="version-label">{entry.version}</span>}</div>
      <h3><a id={`entry-link-${entry.id}`} href={href} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen();
      }}>{title}<ArrowUpRight className="entry-arrow" size={19} aria-hidden="true" /></a></h3>
      <p className="entry-summary">{entry.explanation?.summary || t('한국어 해설을 준비하고 있습니다. 공식 원문을 먼저 확인할 수 있습니다.', 'Source details are not available yet. You can read the official announcement.')}</p>
      <div className="entry-bottom">
        <div className="entry-tags">{category ? <span className={`category-tag ${category}`}>{categoryLabel(category, language)}</span> : <span className="pending-tag"><Clock3 size={12} aria-hidden="true" />{t('해설 준비 중', 'Source pending')}</span>}
          {entry.contentKind === 'source' && <span className="source-label">{t('공식 원문', 'Official source')}</span>}
          {entry.explanation?.impact === 'high' && <span className="impact-label">{t('적용 전 확인', 'Review before applying')}</span>}
          {read && <span className="read-badge"><Check size={12} aria-hidden="true" />{t('읽음', 'Read')}</span>}
        </div>
        <SaveButton saved={saved} onClick={onSave} />
      </div>
    </div>
  </article>;
}

export function Loading({ detail = false, search = false }: { detail?: boolean; search?: boolean }) {
  const { t } = useLocale();
  return <div className={detail ? 'loading-state detail-loading' : 'loading-state'} role="status" aria-label={t('불러오는 중', 'Loading')} aria-live="polite">
    <p><LoaderCircle className="spinner" size={17} aria-hidden="true" />{detail ? t('글을 불러오고 있습니다', 'Loading article') : search ? t('전체 변경 기록에서 검색하고 있습니다', 'Searching all changes') : t('변경 기록을 불러오고 있습니다', 'Loading changes')}</p>
    {[0, 1, 2].map(index => <div className="skeleton-entry" key={index} aria-hidden="true"><span /><div><i /><i /><i /></div></div>)}
  </div>;
}

export function ErrorState({ title, description, retry, goBack }: { title: string; description: string; retry?: () => void; goBack?: () => void }) {
  const { t } = useLocale();
  return <div className="empty-state error-state" role="alert">
    <span className="state-icon"><Info size={25} aria-hidden="true" /></span>
    <h2>{title}</h2><p>{description}</p>
    <div className="state-actions">{retry && <button className="primary-button" onClick={retry}><RefreshCw size={16} aria-hidden="true" />{t('다시 불러오기', 'Try again')}</button>}{goBack && <button className="secondary-button" onClick={goBack}>{t('목록으로 돌아가기', 'Back to list')}<ArrowRight size={15} aria-hidden="true" /></button>}</div>
  </div>;
}

export function Modal({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const { t } = useLocale();
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
    <div className="modal-heading"><h2>{title}</h2><button ref={closeButton} className="icon-button" onClick={onClose} aria-label={t('닫기', 'Close')}><X size={20} aria-hidden="true" /></button></div>
    {children}
  </dialog>;
}

export function SourcesDialog({ feed, onClose }: { feed: Feed | null; onClose: () => void }) {
  const { language, t } = useLocale();
  return <Modal title={t('공식 출처와 수집 상태', 'Official sources and collection status')} onClose={onClose} className="sources-modal">
    <p className="modal-intro">{t('각 제품의 공식 발표를 매일 오전 7시, 한국 시간에 확인합니다. 아래 시각은 출처를 확인한 시각입니다.', 'Official announcements are checked daily at 07:00 Asia/Seoul. The times below show when each source was checked.')}</p>
    {!feed && <p className="inline-note">{t('피드를 불러오면 출처별 확인 상태를 볼 수 있습니다.', 'Source status will appear when the feed is available.')}</p>}
    <div className="source-list">{feed?.sources.map(source => <section key={source.id} className="source-item">
      <div className="source-item-heading"><ProductMark product={source.product} /><h3><External href={source.url}>{source.name}<ExternalLink size={13} aria-hidden="true" /></External></h3><span className={`source-status ${source.state}`}>{source.state === 'ok' ? t('확인 완료', 'Checked') : source.state === 'error' ? t('확인 실패', 'Check failed') : t('확인 대기', 'Awaiting check')}</span></div>
      <dl className="source-times"><div><dt>{t('최근 확인', 'Last checked')}</dt><dd>{displayTimestamp(source.checkedAt, language)}</dd></div><div><dt>{t('마지막 성공', 'Last successful check')}</dt><dd>{displayTimestamp(source.lastSuccessAt, language)}</dd></div>{source.latestPublishedDate && <div><dt>{t('최근 발표일', 'Latest announcement')}</dt><dd>{displayDate(source.latestPublishedDate, language)}</dd></div>}</dl>
      {source.state === 'error' && <p className="source-failure">{t('이번 확인에 실패했습니다. 이전에 확인한 글을 유지합니다.', 'This check failed. Previously collected articles remain available.')}</p>}
    </section>)}</div>
    <div className="source-policy"><Info size={17} aria-hidden="true" /><p>{t('한국어 설명은 공식 자료를 바탕으로 생성한 AI 해설입니다. 적용 범위와 세부 조건은 각 글에 연결된 공식 원문을 확인하세요.', 'English articles contain the official source wording. Korean articles include AI commentary. Check each linked announcement for its full conditions and scope.')}</p></div>
    <p className="modal-fine-print">{t('Code Pulse는 각 제품의 공식 서비스가 아닙니다. 모든 확인 시각은 한국 시간입니다.', 'Code Pulse is an independent service. All source check times use Korea Standard Time (KST).')}</p>
  </Modal>;
}

export function DateDialog({ from, to, onApply, onClose }: { from: string; to: string; onApply: (from: string, to: string) => void; onClose: () => void }) {
  const { t } = useLocale();
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);
  const [error, setError] = useState(false);
  return <Modal title={t('날짜로 찾기', 'Find by date')} onClose={onClose} className="date-modal">
    <p className="modal-intro">{t('공식 발표일을 기준으로 찾습니다. 같은 날짜를 고르면 하루의 글만 볼 수 있습니다.', 'Filter by the official publication date. Choose the same start and end date to see one day.')}</p>
    <form onSubmit={event => {
      event.preventDefault();
      if (start && end && start > end) { setError(true); return; }
      onApply(start, end);
    }}>
      <div className="date-inputs"><label>{t('시작일', 'Start date')}<input type="date" value={start} onChange={event => { setStart(event.target.value); setError(false); }} /></label><span aria-hidden="true">~</span><label>{t('종료일', 'End date')}<input type="date" value={end} min={start || undefined} onChange={event => { setEnd(event.target.value); setError(false); }} /></label></div>
      <div className="date-presets"><button type="button" onClick={() => { const days = lastSevenDays(); setStart(days[0]); setEnd(days[6]); setError(false); }}>{t('최근 7일', 'Last 7 days')}</button><button type="button" onClick={() => { const today = lastSevenDays()[6]; setStart(today); setEnd(today); setError(false); }}>{t('오늘', 'Today')}</button><button type="button" onClick={() => { setStart(''); setEnd(''); setError(false); }}>{t('모든 날짜', 'All dates')}</button></div>
      {error && <p className="form-error" role="alert">{t('종료일은 시작일과 같거나 뒤여야 합니다.', 'End date must be on or after the start date.')}</p>}
      <button className="primary-button full-width" type="submit">{t('날짜 적용', 'Apply dates')}<Check size={16} aria-hidden="true" /></button>
    </form>
  </Modal>;
}

export function FeedAside({ feed, onSources }: { feed: Feed; onSources: () => void }) {
  const { t } = useLocale();
  return <aside className="feed-aside">
    <section className="source-summary">
      <div className="aside-eyebrow">FROM THE SOURCE</div>
      <h2>{t('공식 기록에서', 'From the official')}<br />{t('시작합니다.', 'record.')}</h2>
      <p>{t('공식 릴리스를 모아', 'Official releases with')}<br />{t('새 기능과 적용 조건을 설명합니다.', 'every recorded change.')}</p>
      <div className="source-summary-products">{PRODUCT_IDS.map(product => {
        const sourceStatuses = feed.sources.filter(source => source.product === product);
        const state = sourceStatuses.some(source => source.state === 'error') ? 'error' : sourceStatuses.length > 0 && sourceStatuses.every(source => source.state === 'ok') ? 'ok' : 'pending';
        return <div key={product}><span><ProductMark product={product} />{products[product].name}</span><span className={`status-dot ${state}`} aria-label={state === 'ok' ? t('확인 완료', 'Checked') : state === 'error' ? t('일부 확인 실패', 'Some checks failed') : t('확인 대기', 'Awaiting check')} /></div>;
      })}</div>
      <button className="text-button" onClick={onSources}>{t('출처별 확인 상태', 'Source check status')}<ArrowUpRight size={15} aria-hidden="true" /></button>
    </section>
    <section className="reading-note"><Info size={16} aria-hidden="true" /><div><h3>{t('발표일을 기준으로 읽습니다.', 'Ordered by publication date.')}</h3><p>{t('늦게 수집한 글도 원래 발표한 날짜에 표시합니다.', 'Articles keep their original publication date, even when collected later.')}</p></div></section>
    <section className="reading-note"><Bookmark size={16} aria-hidden="true" /><div><h3>{t('다시 읽을 글은 저장하세요.', 'Save articles for later.')}</h3><p>{t('저장한 글은 같은 브라우저에서 다시 볼 수 있습니다.', 'Saved articles remain available in this browser.')}</p></div></section>
  </aside>;
}

function ChangeText({ text }: { text: string }) {
  // Only inline code is formatted. React escapes both the code and all prose;
  // source-looking HTML and Markdown links remain literal text.
  const delimiters = [...text.matchAll(/`+/g)];
  const parts: ReactNode[] = [];
  let position = 0;
  for (let index = 0; index < delimiters.length; index++) {
    const opening = delimiters[index];
    let closingIndex = index + 1;
    while (closingIndex < delimiters.length && delimiters[closingIndex][0] !== opening[0]) closingIndex++;
    // Do not reinterpret an unfinished span's inner backticks as delimiters.
    if (closingIndex === delimiters.length) break;
    const closing = delimiters[closingIndex];
    parts.push(text.slice(position, opening.index));
    parts.push(<code key={opening.index}>{text.slice(opening.index + opening[0].length, closing.index)}</code>);
    position = closing.index + closing[0].length;
    index = closingIndex;
  }
  parts.push(text.slice(position));
  return <>{parts}</>;
}

function FullChangesSection({ fullChanges }: { fullChanges?: PublicFullChanges }) {
  const { language, t } = useLocale();
  const state = getFullChangesState(fullChanges, language);
  const items = fullChanges?.items ?? [];
  return <section className="detail-section full-changes-section" aria-labelledby="full-changes-title">
    <div className="section-label">ALL CHANGES</div>
    <div className="full-changes-heading"><h2 id="full-changes-title">{t('전체 변경 사항', 'All changes')}</h2><span className={`full-changes-count${state.complete ? '' : ' is-pending'}`}>{state.countLabel}</span></div>
    {!state.complete && <div className="full-changes-pending" role="status">
      <Clock3 size={17} aria-hidden="true" /><div><p>{t('전체 변경 사항의 한국어 해설 준비 중입니다.', 'The complete change list is not available yet.')}</p><p>{items.length ? t('준비된 항목부터 보여드립니다. 전체 내용은 공식 원문에서 확인할 수 있습니다.', 'Showing the available items. Read the official source for the full announcement.') : t('공식 원문에서 변경 내용을 먼저 확인할 수 있습니다.', 'Read the official source for the full announcement.')}</p></div>
    </div>}
    {items.length > 0 && <ol className="full-changes-list">{items.map((item, index) => <li className="full-change-item" key={`${index}-${item.id}`}><ChangeText text={item.text} /></li>)}</ol>}
  </section>;
}

export function EntryDetail({ entry, saved, read, onSave, onRead, onBack, onShare, adjacent, href, onAdjacent }: {
  entry: FeedEntry;
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
  const { language, t } = useLocale();
  const title = entryTitle(entry);
  const isSource = entry.contentKind === 'source';
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [entry.id]);
  const references = entry.references.filter(reference => reference.url !== entry.sourceUrl)
    .filter((reference, index, all) => all.findIndex(item => item.url === reference.url) === index);
  return <div className="detail-wrap">
    <button className="back-button" onClick={onBack}><ArrowDown size={15} className="back-arrow" aria-hidden="true" />{t('변경 기록으로 돌아가기', 'Back to changes')}</button>
    <article className="detail-article" aria-labelledby="detail-title">
      <div className="entry-meta detail-meta"><span className="product-name"><ProductMark product={entry.product} />{products[entry.product].name}</span><span className="channel-label">{channelLabel(entry.channel, language)}</span>{entry.version && <span className="version-label">{entry.version}</span>}{entry.explanation && <span className={`category-tag ${entry.explanation.category}`}>{categoryLabel(entry.explanation.category, language)}</span>}</div>
      <h1 ref={heading} tabIndex={-1} id="detail-title">{title}</h1>
      {entry.explanation && <div className="detail-summary"><p className="summary-label">{t('짧은 요약', 'Overview')}</p><p className="detail-lead">{entry.explanation.summary}</p></div>}
      <div className="detail-dates"><div><span>{t('공식 발표일', 'Published')}</span><time data-testid="publication-date" dateTime={entry.datePrecision === 'day' ? entry.publishedDate : entry.publishedAt}>{displayDate(entry.publishedDate, language)}</time>{entry.datePrecision === 'timestamp' && <small>{t('한국 시간', 'KST')} {displayTimestamp(entry.publishedAt, language)}</small>}</div><div><span>{t('출처 확인', 'Source checked')}</span><time dateTime={entry.checkedAt}>{displayTimestamp(entry.checkedAt, language)}</time><small>{t('한국 시간', 'KST')}</small></div></div>
      {entry.datePrecision === 'day' && <p className="date-precision-note">{t('원문이 발표 시각을 제공하지 않아 날짜만 표시합니다.', 'Only the date is shown because the source does not provide a publication time.')}</p>}
      <div className="detail-actions"><External href={entry.sourceUrl} className="primary-button" aria-label={t('공식 원문 읽기', 'Read official source')}>{t('공식 원문 읽기', 'Read official source')}<ArrowUpRight size={16} aria-hidden="true" /></External><SaveButton saved={saved} onClick={onSave} withText /><button className="secondary-button" onClick={onShare}><ExternalLink size={15} aria-hidden="true" />{t('글 주소 복사', 'Copy article link')}</button>{entry.explanationStatus === 'ready' && entry.explanation && <button className="secondary-button reading-toggle" aria-pressed={read} onClick={onRead}>{read ? <Check size={15} aria-hidden="true" /> : <BookOpen size={15} aria-hidden="true" />}{read ? t('읽지 않음으로 표시', 'Mark as unread') : t('읽음으로 표시', 'Mark as read')}</button>}</div>
      {isSource ? <div className="source-disclosure"><span>{t('공식 원문', 'Official source')}</span><p>{t('공식 발표의 원문 항목을 제공합니다. 적용 전에 원문의 조건과 범위를 확인하세요.', 'Original English wording from the official announcement. Check the linked source for conditions and scope.')}</p></div>
        : (entry.explanation || Boolean(entry.fullChanges?.items.length)) && <div className="ai-disclosure"><span>{t('AI 해설', 'AI commentary')}</span><p>{t('공식 자료를 바탕으로 정리했습니다. 적용 전에 원문의 조건과 범위를 확인하세요.', 'Based on official announcements. Check the original conditions and scope before applying changes.')}</p></div>}
      <FullChangesSection fullChanges={entry.fullChanges} />
      {!isSource && (entry.explanation ? <>
        {(entry.explanation.whyItMatters || entry.explanation.audience.length > 0) && <section className="detail-section why-section"><div className="section-label">WHY IT MATTERS</div><h2>{t('왜 중요한가요?', 'Why it matters')}</h2>{entry.explanation.whyItMatters && <p>{entry.explanation.whyItMatters}</p>}{entry.explanation.audience.length > 0 && <div className="audience-label"><span>{t('이런 분께', 'For')}</span>{entry.explanation.audience.join(', ')}</div>}</section>}
        {entry.explanation.highlights.length > 0 && <section className="detail-section"><div className="section-label">HIGHLIGHTS</div><h2>{t('주요 변경 요약', 'Highlights')}</h2><div className="highlights">{entry.explanation.highlights.map((highlight, index) => <div className="highlight" key={`${index}-${highlight.title}`}><h3>{highlight.title}</h3><p>{highlight.detail}</p><div className="evidence"><span>{t('원문 근거', 'Source excerpt')}</span><blockquote>{highlight.evidence}</blockquote><External href={entry.sourceUrl}>{t('공식 발표에서 확인', 'Read in the official announcement')}<ArrowUpRight size={13} aria-hidden="true" /></External></div></div>)}</div></section>}
        {entry.explanation.actionItems.length > 0 && <section className="detail-section"><div className="section-label">BEFORE YOU START</div><h2>{t('적용 전에 확인하세요', 'Before you start')}</h2><ul className="action-items">{entry.explanation.actionItems.map((item, index) => <li key={`${index}-${item}`}><ArrowRight size={17} aria-hidden="true" /><span>{item}</span></li>)}</ul></section>}
      </> : <section className="pending-explanation"><Clock3 size={22} aria-hidden="true" /><h2>{t('한국어 해설을 준비하고 있습니다.', 'Commentary is not available yet.')}</h2><p>{t('수집한 공식 발표의 해설을 아직 마치지 못했습니다. 위의 공식 원문에서 변경 내용을 먼저 확인할 수 있습니다.', 'This article’s commentary is still being prepared. Read the official source above for the announcement.')}</p></section>)}
      <section className="detail-section references-section"><h2>{t('공식 출처', 'Official sources')}</h2><External href={entry.sourceUrl} className="reference-link"><div><span>{t('공식 발표', 'Official announcement')}</span><strong>{entry.originalTitle}</strong></div><ArrowUpRight size={18} aria-hidden="true" /></External>{references.map(reference => <External key={reference.url} href={reference.url} className="reference-link"><div><span>{reference.kind === 'blog' ? t('공식 블로그', 'Official blog') : t('변경 기록', 'Changelog')}</span><strong>{reference.title}</strong></div><ArrowUpRight size={18} aria-hidden="true" /></External>)}</section>
      <div className="detail-end"><span className="pulse-dot" /><span>{t('읽은 변화가 다음 작업의 기준이 되도록.', 'Bring what changed into your next project.')}</span></div>
    </article>
    {(adjacent?.older || adjacent?.newer) && <nav className="adjacent-entries" aria-label={t('같은 제품의 변경 기록', 'More changes for this product')}>
      {([
        { entry: adjacent.older, direction: 'older', label: t('이전 발표', 'Previous announcement') },
        { entry: adjacent.newer, direction: 'newer', label: t('다음 발표', 'Next announcement') },
      ] as const).map(item => item.entry && <a key={item.direction} className={`adjacent-entry ${item.direction}`} href={href(item.entry.id)} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onAdjacent(item.entry!.id);
      }}>
        <span className="adjacent-label">{item.direction === 'older' && <ArrowLeft size={14} aria-hidden="true" />}{item.label}{item.direction === 'newer' && <ArrowRight size={14} aria-hidden="true" />}</span>
        <time dateTime={item.entry.publishedDate}>{displayDate(item.entry.publishedDate, language)}</time>
        <strong>{entryTitle(item.entry)}</strong>
      </a>)}
    </nav>}
  </div>;
}

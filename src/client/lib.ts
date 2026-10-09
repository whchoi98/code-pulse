import type { Category, Channel, Feed, FeedEntry, Language, ProductId, PublicFullChanges } from '../shared/types';

export const products: Record<ProductId, { name: string; logo: string }> = {
  'claude-code': { name: 'Claude Code', logo: '/brand/claude-code.png' },
  codex: { name: 'Codex', logo: '/brand/codex.png' },
  kiro: { name: 'Kiro', logo: '/brand/kiro.svg' },
};

export const categories: Record<Category, string> = {
  feature: '새 기능',
  improvement: '개선',
  fix: '오류 수정',
  security: '보안',
  breaking: '호환성 변경',
};

export const channels: Record<Channel, string> = {
  cli: 'CLI',
  ide: 'IDE',
  app: '앱',
  web: '웹',
  general: '제품',
};

export type Filters = {
  product: ProductId | 'all';
  category: Category | 'all' | 'pending';
  query: string;
  from: string;
  to: string;
  saved: boolean;
  unread: boolean;
};

export function readLocation(search: string): Filters & { entry: string | null } {
  const params = new URLSearchParams(search);
  const product = params.get('product') ?? '';
  const category = params.get('category') ?? '';
  return {
    product: Object.hasOwn(products, product) ? product as ProductId : 'all',
    category: Object.hasOwn(categories, category) || category === 'pending' ? category as Filters['category'] : 'all',
    query: params.get('q') ?? '',
    from: validDate(params.get('from') ?? ''),
    to: validDate(params.get('to') ?? ''),
    saved: params.get('saved') === '1',
    unread: params.get('unread') === '1',
    entry: params.get('entry'),
  };
}

export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}

export function displayDate(value: string, language: Language = 'ko') {
  return validDate(value) ? language === 'en' ? value : value.replaceAll('-', '.')
    : language === 'en' ? 'Date pending' : '날짜 확인 중';
}

export function displayTimestamp(value?: string, language: Language = 'ko') {
  if (!value || !Number.isFinite(new Date(value).getTime())) return language === 'en' ? 'Not checked yet' : '아직 확인하지 않음';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (name: string) => parts.find(item => item.type === name)?.value ?? '';
  const separator = language === 'en' ? '-' : '.';
  return `${part('year')}${separator}${part('month')}${separator}${part('day')} ${part('hour')}:${part('minute')}`;
}

export function todayInSeoul() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function lastSevenDays(today = todayInSeoul()) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 6 + index);
    return date.toISOString().slice(0, 10);
  });
}

function hasPendingFullChanges(entry: FeedEntry) {
  if (entry.changeSummary) {
    const summary = entry.changeSummary;
    return summary.status !== 'ready' || !Number.isInteger(summary.sourceCount)
      || summary.sourceCount <= 0 || summary.readyCount !== summary.sourceCount;
  }
  return entry.fullChanges !== undefined && !getFullChangesState(entry.fullChanges).complete;
}

export function getCollectionState(feed: Feed) {
  const successfulChecks = feed.sources
    .map(source => source.lastSuccessAt ? Date.parse(source.lastSuccessAt) : NaN)
    .filter(Number.isFinite);
  const sourcePending = !feed.sources.length || feed.sources.some(source => source.state === 'pending');
  const runFailed = feed.latestRun?.status === 'failed';
  const sourceErrors = runFailed || feed.sources.some(source => source.state === 'error')
    || Boolean(feed.latestRun?.failedSources.length);

  // The API uses 26 hours for source freshness. It also marks missing success
  // records and cached reads stale, so those cases need different explanations.
  const oldData = successfulChecks.some(checkedAt => Date.now() - checkedAt > 26 * 60 * 60_000);
  const statusUnavailable = feed.stale && !oldData && successfulChecks.length > 0
    && !sourcePending && !sourceErrors;
  const initialPending = !feed.latestRun && !successfulChecks.length && !feed.entries.length
    && feed.sources.every(source => source.state === 'pending');
  const pendingShortExplanations = feed.entries.some(entry => entry.explanationStatus === 'pending');
  const pendingFullChanges = feed.entries.some(hasPendingFullChanges);
  const pendingExplanations = pendingShortExplanations || pendingFullChanges;

  return { sourcePending, sourceErrors, runFailed, oldData, statusUnavailable, initialPending, pendingExplanations, pendingShortExplanations, pendingFullChanges };
}

function comparePublication(left: FeedEntry, right: FeedEntry) {
  return right.publishedDate.localeCompare(left.publishedDate)
    || right.publishedAt.localeCompare(left.publishedAt)
    || left.id.localeCompare(right.id);
}

export function filterEntries(entries: FeedEntry[], filters: Filters, savedIds: string[], isRead: (entry: FeedEntry) => boolean = () => false) {
  const query = filters.query.trim().normalize('NFC').toLocaleLowerCase();
  return entries.filter(entry => {
    if (filters.product !== 'all' && entry.product !== filters.product) return false;
    if (filters.category === 'pending' && entry.explanationStatus !== 'pending' && !hasPendingFullChanges(entry)) return false;
    if (filters.category !== 'all' && filters.category !== 'pending' && entry.explanation?.category !== filters.category) return false;
    if (filters.from && entry.publishedDate < filters.from) return false;
    if (filters.to && entry.publishedDate > filters.to) return false;
    if (filters.saved && !savedIds.includes(entry.id)) return false;
    if (filters.unread && isRead(entry)) return false;
    if (!query) return true;
    const searchable = [
      products[entry.product].name, entry.version, entry.originalTitle,
      entry.explanation?.title, entry.explanation?.summary, entry.explanation?.whyItMatters,
      ...(entry.explanation?.highlights.flatMap(highlight => [highlight.title, highlight.detail]) ?? []),
      ...(entry.fullChanges?.items.map(item => item.text) ?? []),
      entry.searchText,
    ].join(' ').normalize('NFC').toLocaleLowerCase();
    return searchable.includes(query);
  }).sort(comparePublication);
}

export function getFullChangesState(fullChanges?: PublicFullChanges, language: Language = 'ko') {
  const items = fullChanges?.items ?? [];
  const total = fullChanges && Number.isInteger(fullChanges.sourceCount) && fullChanges.sourceCount > 0
    ? fullChanges.sourceCount : null;
  const complete = fullChanges?.status === 'ready' && total === items.length
    && items.every(item => item.id.trim() && item.text.trim())
    && new Set(items.map(item => item.id)).size === items.length;
  const countLabel = language === 'en' ? complete ? `${items.length} ${items.length === 1 ? 'change' : 'changes'}`
    : total !== null ? `${items.length} of ${total} ready`
      : items.length ? `${items.length} ready` : 'Preparing'
    : complete ? `총 ${items.length}개`
    : total !== null ? `${total}개 중 ${items.length}개 준비`
      : items.length ? `${items.length}개 준비` : '준비 중';
  return { complete, countLabel };
}

export function adjacentEntries(entries: FeedEntry[], current: FeedEntry) {
  const productEntries = entries.filter(entry => entry.product === current.product && entry.id !== current.id)
    .concat(current).sort(comparePublication);
  const index = productEntries.findIndex(entry => entry.id === current.id);
  return { older: productEntries[index + 1], newer: productEntries[index - 1] };
}

export function officialHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function entryTitle(entry: FeedEntry) {
  return entry.explanation?.title || entry.originalTitle;
}

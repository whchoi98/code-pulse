export const PRODUCT_IDS = ['claude-code', 'codex', 'kiro'] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];
export type Category = 'feature' | 'improvement' | 'fix' | 'security' | 'breaking';
export type Channel = 'cli' | 'ide' | 'app' | 'web' | 'general';
export type Language = 'ko' | 'en';

export interface SourceReference {
  title: string;
  url: string;
  kind: 'changelog' | 'release' | 'blog';
}

export interface Highlight {
  title: string;
  detail: string;
  evidence: string;
}

export interface Explanation {
  title: string;
  summary: string;
  whyItMatters: string;
  actionItems: string[];
  highlights: Highlight[];
  audience: string[];
  category: Category;
  impact: 'high' | 'medium' | 'low';
}

export interface FullChangeItem {
  id: string;
  text: string;
}

export interface FullChanges {
  status: 'ready' | 'pending';
  sourceHash: string;
  model: string;
  formatVersion: string;
  updatedAt: string;
  sourceCount: number;
  items: FullChangeItem[];
}

export type PublicFullChanges = Omit<FullChanges, 'sourceHash' | 'model'>;

export interface Entry {
  id: string;
  product: ProductId;
  channel: Channel;
  sourceId: string;
  version?: string;
  originalTitle: string;
  publishedAt: string;
  publishedDate: string;
  datePrecision: 'day' | 'timestamp';
  sourceUrl: string;
  references: SourceReference[];
  originalText: string;
  contentHash: string;
  firstSeenAt: string;
  checkedAt: string;
  updatedAt: string;
  explanation?: Explanation;
  explanationStatus: 'ready' | 'pending';
  explanationModel?: string;
  editorialVersion?: string;
  explanationEditedAt?: string;
  fullChanges?: FullChanges;
}

export interface SourceStatus {
  id: string;
  product: ProductId;
  name: string;
  url: string;
  state: 'ok' | 'error' | 'pending';
  checkedAt?: string;
  lastSuccessAt?: string;
  /** Earliest fully read history bound whose eligible entries reached a final snapshot. */
  historySince?: string;
  latestPublishedDate?: string;
  entryCount: number;
  error?: string;
}

export interface CollectionRun {
  id: string;
  startedAt: string;
  completedAt: string;
  status: 'success' | 'partial' | 'failed';
  newEntries: number;
  updatedEntries: number;
  summarizedEntries: number;
  failedSources: string[];
}

export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  entries: Entry[];
  sources: SourceStatus[];
  runs: CollectionRun[];
}

export type FeedEntry = Omit<Entry, 'originalText' | 'contentHash' | 'explanationModel' | 'fullChanges'> & {
  fullChanges?: PublicFullChanges;
  language?: Language;
  contentKind?: 'explanation' | 'source';
  /** Existing reader fingerprint, shared by both languages. Not a source hash. */
  readRevision?: string;
  detailUrl?: string;
  detailBytes?: number;
  changeSummary?: { status: 'ready' | 'pending'; sourceCount: number; readyCount: number };
  searchText?: string;
};
export interface Feed {
  generatedAt: string;
  entries: FeedEntry[];
  sources: SourceStatus[];
  latestRun?: CollectionRun;
  schedule: { timezone: 'Asia/Seoul'; hour: number };
  stale: boolean;
  language?: Language;
  searchUrl?: string;
}

export interface SearchIndex {
  language: Language;
  entries: { id: string; text: string }[];
}

export interface StaticBootstrap {
  language: Language;
  feed?: Feed;
  detail?: FeedEntry;
}

/** Counts server-issued browser cookies rather than individual people. */
export interface PresenceSnapshot {
  active_visitors: number;
  total_visitors: number;
  as_of: string;
  window_seconds: number;
  counting_since: string | null;
}

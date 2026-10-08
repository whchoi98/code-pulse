import { extractChangeItems } from '../collector/change-items.js';
import { FULL_CHANGES_VERSION, fullChangesSourceHash, isFullChangesComplete, isFullChangesProgress } from '../collector/full-changes.js';
import type { Entry, FeedEntry, FullChangeItem, PublicFullChanges } from '../shared/types.js';

/** Keep private source and generation metadata out of every public response. */
export function publicEntry(entry: Entry): FeedEntry {
  const { originalText: _originalText, contentHash: _hash, explanationModel: _model,
    fullChanges, ...visible } = entry;
  if (!fullChanges) return visible;
  let sourceItems;
  try { sourceItems = extractChangeItems(entry); }
  catch { return visible; }
  const expected = new Set(sourceItems.map(item => item.id));
  const translated = new Map<string, FullChangeItem>();
  if (fullChanges.sourceHash === fullChangesSourceHash(entry)
    && fullChanges.formatVersion === FULL_CHANGES_VERSION && Array.isArray(fullChanges.items)
    && isFullChangesProgress({ ...fullChanges, status: 'pending', sourceCount: sourceItems.length }, entry)) {
    for (const item of fullChanges.items) {
      if (item && expected.has(item.id) && typeof item.text === 'string' && /[가-힣]/u.test(item.text)
        && !translated.has(item.id)) translated.set(item.id, { id: item.id, text: item.text });
    }
  }
  const safe: PublicFullChanges = {
    status: isFullChangesComplete(fullChanges, entry) ? 'ready' : 'pending',
    formatVersion: FULL_CHANGES_VERSION,
    updatedAt: typeof fullChanges.updatedAt === 'string' && Number.isFinite(Date.parse(fullChanges.updatedAt))
      ? fullChanges.updatedAt : entry.checkedAt,
    sourceCount: sourceItems.length,
    items: sourceItems.flatMap(item => translated.has(item.id) ? [translated.get(item.id)!] : []),
  };
  return { ...visible, fullChanges: safe };
}

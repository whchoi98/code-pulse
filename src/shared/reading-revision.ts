import type { Entry, FeedEntry } from './types';

/** A local change marker shared by feed and detail responses, never a security hash. */
export function entryRevision(entry: FeedEntry | Entry): string {
  if ('readRevision' in entry && typeof entry.readRevision === 'string' && /^[a-f0-9]{16}$/.test(entry.readRevision)) {
    return entry.readRevision;
  }
  const explanation = entry.explanation;
  const fullChanges = entry.fullChanges;
  // Fixed field order ignores JSON property order and collection/editorial clocks.
  // Private source hashes are absent from the feed; updatedAt tracks source changes.
  const visible = JSON.stringify([
    entry.product, entry.channel, entry.version, entry.originalTitle,
    entry.publishedAt, entry.publishedDate, entry.datePrecision,
    entry.sourceUrl, entry.updatedAt,
    entry.references.map(reference => [reference.title, reference.url, reference.kind]),
    entry.explanationStatus,
    explanation ? [
      explanation.title, explanation.summary, explanation.whyItMatters,
      explanation.actionItems, explanation.audience, explanation.category, explanation.impact,
      explanation.highlights.map(highlight => [highlight.title, highlight.detail, highlight.evidence]),
    ] : null,
    // Keep legacy fingerprints unchanged until a list arrives. Generation clocks,
    // model, source hash and format version do not describe a reader-visible edit.
    ...(fullChanges ? [[fullChanges.status, fullChanges.sourceCount,
      fullChanges.items.map(item => [item.id, item.text])]] : []),
  ]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < visible.length; index++) {
    const code = visible.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x5f356495);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}


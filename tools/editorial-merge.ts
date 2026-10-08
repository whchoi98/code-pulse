import type { Entry } from '../src/shared/types.js';

export function mergeEditorialEdit(current: Entry, edited?: Entry): Entry {
  if (!edited || edited.contentHash !== current.contentHash
    || (edited.explanationEditedAt ?? '') <= (current.explanationEditedAt ?? '')) return current;
  // Compare against the reloaded entry on every save/retry and apply only the
  // fields owned by polishing; source observations and model provenance stay current.
  return {
    ...current, explanation: edited.explanation,
    editorialVersion: edited.editorialVersion, explanationEditedAt: edited.explanationEditedAt,
  };
}

import { z } from 'zod';
import type { Snapshot } from '../src/shared/types.js';
import { fullChangesSourceHash, isFullChangesProgress } from '../src/collector/full-changes.js';

const patchSchema = z.array(z.object({
  entryId: z.string().min(1), sourceHash: z.string().min(1),
  items: z.array(z.object({ id: z.string().min(1), text: z.string().min(4) }).strict()).min(1),
}).strict());
export type FullEditorialPatch = z.infer<typeof patchSchema>[number];

export function applyFullEditorial(snapshot: Snapshot, input: unknown, at = new Date().toISOString()): Snapshot {
  const patches = patchSchema.parse(input);
  if (new Set(patches.map(patch => patch.entryId)).size !== patches.length) throw new Error('중복된 편집 대상 글입니다.');
  if (!Number.isFinite(Date.parse(at))) throw new Error('편집 시각을 확인하세요.');
  const result = structuredClone(snapshot);
  for (const patch of patches) {
    const entry = result.entries.find(value => value.id === patch.entryId);
    if (!entry || entry.contentHash !== patch.sourceHash || fullChangesSourceHash(entry) !== patch.sourceHash
      || !isFullChangesProgress(entry.fullChanges, entry)) throw new Error(`편집 대상의 원문과 진행 상태를 확인하세요: ${patch.entryId}`);
    const full = entry.fullChanges!;
    const changes = new Map(patch.items.map(item => [item.id, item.text]));
    if (changes.size !== patch.items.length || [...changes.keys()].some(id => !full.items.some(item => item.id === id))) {
      throw new Error(`편집할 항목이 없거나 중복됩니다: ${patch.entryId}`);
    }
    let changed = false;
    full.items = full.items.map(item => {
      const text = changes.get(item.id);
      if (text === undefined || text === item.text) return item;
      changed = true;
      return { id: item.id, text };
    });
    if (changed) full.updatedAt = at;
    if (!isFullChangesProgress(full, entry)) throw new Error(`편집 결과가 원문 항목의 검증 조건을 충족하지 못했습니다: ${patch.entryId}`);
  }
  return result;
}

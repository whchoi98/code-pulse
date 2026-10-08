import { readFile } from 'node:fs/promises';
import { configuredStore } from '../src/collector/store.js';
import { EDITORIAL_VERSION, validateExplanation } from '../src/collector/explanation.js';

const corrections = JSON.parse(await readFile(process.argv[2] ?? 'docs/initial-editorial.json', 'utf8')) as { id: string; contentHash: string; explanation: unknown }[];
const store = configuredStore();
const { snapshot, etag } = await store.read();
let changed = 0;
for (const correction of corrections) {
  const entry = snapshot.entries.find(item => item.id === correction.id);
  if (!entry) throw new Error(`기록을 찾을 수 없습니다: ${correction.id}`);
  if (entry.contentHash !== correction.contentHash) throw new Error(`원문이 바뀌어 편집을 적용하지 않았습니다: ${correction.id}`);
  entry.explanation = validateExplanation(correction.explanation, entry);
  entry.explanationStatus = 'ready';
  entry.editorialVersion = EDITORIAL_VERSION;
  entry.explanationEditedAt = new Date().toISOString();
  changed++;
}
snapshot.generatedAt = new Date().toISOString();
await store.write(snapshot, etag);
console.log(JSON.stringify({ event: 'editorial_applied', entries: changed }));

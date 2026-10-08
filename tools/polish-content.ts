import { BedrockExplainer, EDITORIAL_VERSION } from '../src/collector/explanation.js';
import { configuredStore, WriteConflict } from '../src/collector/store.js';
import type { Entry } from '../src/shared/types.js';
import { mergeEditorialEdit } from './editorial-merge.js';

const store = configuredStore();
const explainer = new BedrockExplainer();
let current = await store.read();
const changes = new Map<string, Entry>();
let failures = 0;
async function save() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const snapshot = {
      ...current.snapshot,
      generatedAt: new Date().toISOString(),
      entries: current.snapshot.entries.map(entry => mergeEditorialEdit(entry, changes.get(entry.id))),
    };
    try {
      await store.write(snapshot, current.etag);
      current = await store.read();
      return;
    } catch (error) {
      if (!(error instanceof WriteConflict) || attempt === 4) throw error;
      current = await store.read();
    }
  }
}
for (const entry of current.snapshot.entries) {
  if (!entry.explanation || entry.editorialVersion === EDITORIAL_VERSION) continue;
  try {
    const explanation = await explainer.polish(entry, entry.explanation);
    changes.set(entry.id, { ...entry, explanation, editorialVersion: EDITORIAL_VERSION, explanationEditedAt: new Date().toISOString() });
    console.log(JSON.stringify({ event: 'entry_polished', id: entry.id, title: explanation.title }));
    if (changes.size % 5 === 0) await save();
  } catch (error) {
    failures++;
    console.error(JSON.stringify({ event: 'polish_failed', id: entry.id, message: error instanceof Error ? error.message : String(error) }));
  }
}
await save();
console.log(JSON.stringify({ event: 'polish_completed', edited: changes.size, failures }));
if (failures) process.exitCode = 1;

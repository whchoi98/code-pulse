import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { FileStore, WriteConflict } from '../src/collector/store.js';
import { applyFullEditorial } from './full-editorial.js';
import { publishConfiguredSite } from '../src/publishing/index.js';

const { values } = parseArgs({ options: {
  input: { type: 'string' }, 'data-dir': { type: 'string' }, write: { type: 'boolean', default: false },
} });
if (!values.input || !values['data-dir']) throw new Error('--input과 --data-dir를 지정하세요.');
const patches = JSON.parse(await readFile(values.input, 'utf8'));
const store = new FileStore(values['data-dir']);
let publicationNeeded = false;
for (let attempt = 0; attempt < 5; attempt++) {
  const current = await store.read();
  const edited = applyFullEditorial(current.snapshot, patches);
  const changedItems = edited.entries.reduce((count, entry) => {
    const old = current.snapshot.entries.find(value => value.id === entry.id);
    return count + (entry.fullChanges?.items.filter(item => old?.fullChanges?.items.find(previous => previous.id === item.id)?.text !== item.text).length ?? 0);
  }, 0);
  try {
    if (values.write && changedItems) {
      await store.write(edited, current.etag);
      publicationNeeded = true;
    }
    console.log(JSON.stringify({ mode: values.write ? 'write' : 'dry-run', entries: patches.length, changedItems, at: new Date().toISOString() }));
    break;
  } catch (error) {
    if (!(error instanceof WriteConflict) || attempt === 4) throw error;
  }
}
if (publicationNeeded) {
  const publication = await publishConfiguredSite(store);
  if (publication) console.log(JSON.stringify({ event: 'site_published', ...publication }));
}

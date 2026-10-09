import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { configuredStore } from '../src/collector/store.js';
import { publishConfiguredSite } from '../src/publishing/index.js';

const { values } = parseArgs({ options: {
  'data-dir': { type: 'string' }, 'data-bucket': { type: 'string' },
  'site-dir': { type: 'string' }, 'site-bucket': { type: 'string' },
  'static-dir': { type: 'string' }, report: { type: 'string' },
} });
if (values['data-dir'] && values['data-bucket']) throw new Error('Choose --data-dir or --data-bucket.');
if (values['site-dir'] && values['site-bucket']) throw new Error('Choose --site-dir or --site-bucket.');
if (values['data-dir']) { process.env.DATA_DIR = values['data-dir']; delete process.env.DATA_BUCKET; }
if (values['data-bucket']) process.env.DATA_BUCKET = values['data-bucket'];
if (values['site-dir']) { process.env.SITE_DIR = values['site-dir']; delete process.env.SITE_BUCKET; }
if (values['site-bucket']) { process.env.SITE_BUCKET = values['site-bucket']; delete process.env.SITE_DIR; }
if (values['static-dir']) process.env.STATIC_DIR = values['static-dir'];
const report = await publishConfiguredSite(configuredStore());
if (!report) throw new Error('Set SITE_BUCKET or SITE_DIR, or pass --site-bucket or --site-dir.');
if (values.report) await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ event: 'site_published', ...report }));

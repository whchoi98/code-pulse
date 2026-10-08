import { parseArgs } from 'node:util';
import { collectOnce } from './engine.js';
import { BedrockExplainer, EDITORIAL_VERSION } from './explanation.js';
import { fetchOfficial } from './official-fetch.js';
import { configuredStore } from './store.js';
import { BedrockChangeExplainer } from './full-changes.js';

function metric(success: boolean) {
  if (process.env.ENABLE_METRICS !== 'true') return;
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{ Namespace: 'CodePulse', Dimensions: [['Application']], Metrics: [{ Name: 'CollectionSuccess', Unit: 'Count' }, { Name: 'CollectionFailure', Unit: 'Count' }] }],
    },
    Application: 'code-pulse', CollectionSuccess: success ? 1 : 0, CollectionFailure: success ? 0 : 1,
  }));
}

const timeout = setTimeout(() => {
  metric(false);
  console.error(JSON.stringify({ event: 'collection_timeout' }));
  process.exit(1);
}, 20 * 60_000).unref();

try {
  const { values } = parseArgs({
    options: {
      days: { type: 'string' },
      since: { type: 'string' },
      'max-summaries': { type: 'string', default: '80' },
      'max-full-changes': { type: 'string', default: '80' },
      concurrency: { type: 'string', default: '3' },
      'no-ai': { type: 'boolean', default: false },
      'refresh-model': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.days !== undefined && values.since !== undefined) {
    throw new Error('--days와 --since는 함께 지정할 수 없습니다.');
  }
  const days = values.days === undefined ? undefined : Number(values.days);
  const sinceDate = values.since ?? (days === undefined ? '2026-01-01' : undefined);
  const maxSummaries = Number(values['max-summaries']);
  const maxFullChanges = Number(values['max-full-changes']);
  const summaryConcurrency = Number(values.concurrency);
  if (!Number.isInteger(summaryConcurrency) || summaryConcurrency < 1 || summaryConcurrency > 6) {
    throw new Error('--concurrency는 1~6 범위의 정수여야 합니다.');
  }
  if ((days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365))
    || !Number.isInteger(maxSummaries) || maxSummaries < 0 || maxSummaries > 300
    || !Number.isInteger(maxFullChanges) || maxFullChanges < 0 || maxFullChanges > 300) {
    throw new Error('days는 1~365, max-summaries와 max-full-changes는 0~300 범위의 정수여야 합니다.');
  }
  const explainer = new BedrockExplainer();
  const changeExplainer = new BedrockChangeExplainer(explainer.modelId);
  console.log(JSON.stringify({
    event: 'collection_started', at: new Date().toISOString(), ...(sinceDate !== undefined ? { sinceDate } : { days }), maxSummaries,
    maxFullChanges: values['no-ai'] ? 0 : maxFullChanges,
    modelId: explainer.modelId, refreshModel: values['refresh-model'], summaryConcurrency,
  }));
  const run = await collectOnce({
    store: configuredStore(), fetchDocument: fetchOfficial,
    summarize: async (candidate, supplements) => {
      const explanation = await explainer.explain(candidate, supplements);
      console.log(JSON.stringify({ event: 'entry_explained', product: candidate.product, date: candidate.publishedDate, title: explanation.title }));
      return explanation;
    },
    expandChanges: (candidate, previous, onProgress) => changeExplainer.explain(candidate, previous, async progress => {
      await onProgress?.(progress);
      console.log(JSON.stringify({ event: 'entry_changes_progress', product: candidate.product, version: candidate.version,
        completed: progress.items.length, total: progress.sourceCount, status: progress.status }));
    }),
    maxFullChanges: values['no-ai'] ? 0 : maxFullChanges,
    lookbackDays: days, sinceDate, maxSummaries: values['no-ai'] ? 0 : maxSummaries, summaryConcurrency, modelId: explainer.modelId,
    refreshModel: values['refresh-model'],
    editorialVersion: EDITORIAL_VERSION,
    onWarning: warning => console.warn(JSON.stringify({ event: 'explanation_pending', ...warning })),
  });
  console.log(JSON.stringify({ event: 'collection_completed', ...run }));
  metric(run.status === 'success');
  if (run.status !== 'success') process.exitCode = run.status === 'failed' ? 1 : 2;
} catch (error) {
  metric(false);
  console.error(JSON.stringify({ event: 'collection_failed', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}

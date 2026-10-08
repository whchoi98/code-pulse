import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCodexHistory } from '../src/collector/codex-history.js';
import type { FetchedDocument } from '../src/collector/official-fetch.js';
import type { SourceDefinition } from '../src/collector/sources.js';

const source: SourceDefinition = {
  id: 'codex-releases', product: 'codex', name: 'Codex CLI 공식 릴리스',
  url: 'https://github.com/openai/codex/releases',
  fetchUrl: 'https://api.github.com/repos/openai/codex/releases?per_page=20',
  parser: 'github',
};
const earliest = Date.parse('2026-01-01T00:00:00Z');
const pageUrl = (page: number) => `${source.url}?page=${page}`;

function apiRelease(version = '0.161.0', date = '2026-10-07T15:58:45Z', body = '## New Features\n\n- Preserve the exact API Markdown and `code`.') {
  return {
    tag_name: `rust-v${version}`, name: version, draft: false, prerelease: version.includes('alpha'),
    published_at: date, html_url: `${source.url}/tag/rust-v${version}`, body,
  };
}
const fullApi = () => JSON.stringify([
  apiRelease(),
  ...Array.from({ length: 19 }, (_, index) => apiRelease(`0.162.0-alpha.${index + 1}`, '2026-10-07T02:00:00Z', 'Preview')),
]);

// A compact version of the verified official release-page structure:
// section id, primary tag link, explicit "released this" time, rendered body,
// repeated desktop/mobile labels, and lazy asset fragments.
function releaseHtml(version: string, date?: string, body: string | null = '<h2>New Features</h2><p>Preserved workspace settings.</p>', label = '') {
  return `<section id="release-rust-v${version}">
    <h2 class="sr-only">${version}</h2><div class="Box"><div class="Box-body">
    <span><a class="Link--primary Link" href="/openai/codex/releases/tag/rust-v${version}">${version}</a></span>
    ${label ? `<span class="Label">${label}</span><span class="Label">${label}</span>` : ''}
    <div><a href="/apps/github-actions">github-actions</a> released this
      ${date === undefined ? '' : `<relative-time datetime="${date}">${date}</relative-time>`}
    </div>
    ${body === null ? '' : `<div class="markdown-body">${body}</div>`}
    </div><include-fragment src="https://github.com/openai/codex/releases/expanded_assets/rust-v${version}"></include-fragment>
    </div></section>`;
}

function htmlPage(releases: string[], next?: number | string) {
  const pagination = next === undefined
    ? '<span class="next_page disabled" aria-label="Next page" aria-disabled="true">Next</span>'
    : `<a class="next_page" rel="next" href="${typeof next === 'number' ? `/openai/codex/releases?page=${next}` : next}">Next</a>`;
  return `<html><main>${releases.join('')}</main><div class="pagination">${pagination}</div></html>`;
}

function truncatedRelease(version: string, date: string) {
  return releaseHtml(version, date, '<p>Visible introduction followed by a truncated...</p>')
    .replace('</div><include-fragment', `<a href="/openai/codex/releases/tag/rust-v${version}">Read more</a></div><include-fragment`);
}

function detailHtml(version: string, date?: string, readMore = false) {
  return `<html><head><meta property="og:url" content="/openai/codex/releases/tag/rust-v${version}"></head>
    <main><h1>${version}</h1><div>github-actions released this
    ${date ? `<relative-time datetime="${date}">${date}</relative-time>` : ''}
    </div><div class="markdown-body"><h2>New Features</h2><p>Visible introduction.</p>
    <h2>Changelog</h2><p>Trailing change omitted by the release list.</p>
    <a href="https://openai.com/index/introducing-codex/">Full official background</a></div>
    ${readMore ? `<a href="/openai/codex/releases/tag/rust-v${version}">Read more</a>` : ''}
    </main></html>`;
}

function documents(pages: Record<string, string>, visited: string[] = []) {
  return async (url: string): Promise<FetchedDocument> => {
    visited.push(url);
    if (!(url in pages)) throw new Error(`Unexpected document: ${url}`);
    return { url, body: pages[url], contentType: url.startsWith('https://api.github.com/') ? 'application/json' : 'text/html' };
  };
}

afterEach(() => vi.useRealTimers());

describe('Codex official historical releases', () => {
  it('uses a complete API page under 20 records without unnecessary HTML requests', async () => {
    const body = JSON.stringify([apiRelease(), { ...apiRelease('0.162.0-alpha.1'), draft: true }]);
    const visited: string[] = [];
    const archived: FetchedDocument[] = [];
    const entries = await readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({ [source.fetchUrl]: body }, visited),
      onDocument: async document => { archived.push(document); },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      version: '0.161.0', channel: 'cli', sourceId: source.id,
      originalText: '## New Features\n\n- Preserve the exact API Markdown and `code`.',
      publishedAt: '2026-10-07T15:58:45.000Z', datePrecision: 'timestamp',
    });
    expect(visited).toEqual([source.fetchUrl]);
    expect(archived).toEqual([{ url: source.fetchUrl, body, contentType: 'application/json' }]);
  });

  it('adds historical stable releases, keeps API content and time, and checks complete boundary pages', async () => {
    const visited: string[] = [];
    const archived: string[] = [];
    const entries = await readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: fullApi(),
        [pageUrl(1)]: htmlPage([
          releaseHtml('0.161.0', '2026-10-07T01:00:00Z', '<p>Different rendered wording must not replace the API.</p>'),
          releaseHtml('0.80.0', '2026-01-09T19:48:15Z', '<h2>New Features</h2><ul><li>Added workspace controls.</li></ul><pre><code>keep_exact_code</code></pre><a href="https://openai.com/index/introducing-codex/">Official background</a>'),
          releaseHtml('0.82.0', '2026-01-15T10:00:00Z', null, 'Pre-release'),
          releaseHtml('0.81.0-alpha.1', '2026-01-10T10:00:00Z', null),
          releaseHtml('0.90.0', undefined, null, 'Draft'),
        ], 2),
        [pageUrl(2)]: htmlPage([
          releaseHtml('0.77.0', '2025-12-21T05:37:01Z', null),
          releaseHtml('0.79.0', '2026-01-07T00:56:03Z'),
        ], 3),
        [pageUrl(3)]: htmlPage([releaseHtml('0.76.0', '2025-12-19T18:55:54Z', null)], 4),
        [pageUrl(4)]: htmlPage([releaseHtml('0.75.0', '2025-12-18T19:29:04Z', null)], 5),
      }, visited),
      onDocument: document => { archived.push(document.url); },
    });
    expect(entries.map(entry => entry.version)).toEqual(['0.161.0', '0.80.0', '0.79.0']);
    expect(entries[0].originalText).toBe(apiRelease().body);
    expect(entries[0].publishedAt).toBe('2026-10-07T15:58:45.000Z');
    expect(entries[1]).toMatchObject({
      publishedAt: '2026-01-09T19:48:15.000Z', publishedDate: '2026-01-09',
      datePrecision: 'timestamp', sourceUrl: `${source.url}/tag/rust-v0.80.0`,
    });
    expect(entries[1].originalText).toContain('Added workspace controls.');
    expect(entries[1].originalText).toContain('keep_exact_code');
    expect(entries[1].references).toContainEqual({
      title: 'Official background', url: 'https://openai.com/index/introducing-codex/', kind: 'blog',
    });
    expect(visited).toEqual([source.fetchUrl, pageUrl(1), pageUrl(2), pageUrl(3), pageUrl(4)]);
    expect(archived).toEqual(visited);
    expect(visited.every(url => !url.includes('expanded_assets'))).toBe(true);
  });

  it('rejects a missing publication time instead of using a commit timestamp', async () => {
    const html = htmlPage([releaseHtml('0.80.0', undefined, '<p>Workspace changes.</p><relative-time datetime="2026-01-01T10:00:00Z">commit time</relative-time>')]);
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({ [source.fetchUrl]: fullApi(), [pageUrl(1)]: html }),
    })).rejects.toThrow(/발표/);
  });

  it('rejects date-only HTML metadata rather than inventing a midnight timestamp', async () => {
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({ [source.fetchUrl]: fullApi(), [pageUrl(1)]: htmlPage([releaseHtml('0.80.0', '2026-01-09')]) }),
    })).rejects.toThrow(/발표/);
  });

  it('fails when a historical stable body is absent instead of claiming complete coverage', async () => {
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({ [source.fetchUrl]: fullApi(), [pageUrl(1)]: htmlPage([releaseHtml('0.80.0', '2026-01-09T19:48:15Z', null)]) }),
    })).rejects.toThrow(/본문/);
  });

  it('propagates a later page failure without returning the successfully read prefix', async () => {
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({ [source.fetchUrl]: fullApi(), [pageUrl(1)]: htmlPage([releaseHtml('0.80.0', '2026-01-09T19:48:15Z')], 2) }),
    })).rejects.toThrow(/Unexpected document/);
  });

  it('requires explicit terminal pagination when the date boundary has not been reached', async () => {
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({ [source.fetchUrl]: fullApi(), [pageUrl(1)]: `<html>${releaseHtml('0.80.0', '2026-01-09T19:48:15Z')}</html>` }),
    })).rejects.toThrow(/페이지/);
  });

  it.each([
    'https://example.org/releases?page=2',
    'https://github.com/anthropics/claude-code/releases?page=2',
    '/openai/codex/releases?page=1',
  ])('rejects an unsafe or non-advancing next link: %s', async next => {
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({ [source.fetchUrl]: fullApi(), [pageUrl(1)]: htmlPage([releaseHtml('0.80.0', '2026-01-09T19:48:15Z')], next) }),
    })).rejects.toThrow(/페이지/);
  });

  it('rejects repeated page contents even when page numbers keep advancing', async () => {
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: fullApi(),
        [pageUrl(1)]: htmlPage([releaseHtml('0.80.0', '2026-01-09T19:48:15Z')], 2),
        [pageUrl(2)]: htmlPage([releaseHtml('0.80.0', '2026-01-09T19:48:15Z')], 3),
      }),
    })).rejects.toThrow(/진행/);
  });

  it('does not swallow an archive callback failure', async () => {
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({ [source.fetchUrl]: JSON.stringify([apiRelease()]) }),
      onDocument: async () => { throw new Error('archive unavailable'); },
    })).rejects.toThrow('archive unavailable');
  });

  it('leaves publication-date filtering to the engine and retains older canonical API timestamps', async () => {
    const entries = await readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: JSON.stringify([
          apiRelease('0.999.0', '2026-10-08T01:00:00Z'),
          apiRelease('0.77.0', '2025-12-21T05:37:01Z'),
        ]),
      }),
    });
    expect(entries.map(entry => entry.version)).toEqual(['0.999.0', '0.77.0']);
    expect(entries[1].publishedAt).toBe('2025-12-21T05:37:01.000Z');
  });

  it('does not let an in-range HTML date replace an older canonical API release', async () => {
    const older = apiRelease('0.77.0', '2025-12-21T05:37:01Z', 'Canonical older API release.');
    const entries = await readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: JSON.stringify([older, ...JSON.parse(fullApi()).slice(1)]),
        [pageUrl(1)]: htmlPage([
          releaseHtml('0.77.0', '2026-01-08T10:00:00Z', '<p>A later supplementary publication date.</p>'),
          releaseHtml('0.78.0', '2026-01-06T18:47:47Z'),
        ]),
      }),
    });
    expect(entries.map(entry => entry.version)).toEqual(['0.78.0', '0.77.0']);
    expect(entries[1]).toMatchObject({
      publishedAt: '2025-12-21T05:37:01.000Z',
      originalText: 'Canonical older API release.',
    });
  });

  it.each(['prerelease', 'draft'] as const)('does not revive an API-%s release from stale stable HTML', async flag => {
    const apiRows = JSON.parse(fullApi());
    apiRows[0][flag] = true;
    const entries = await readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: JSON.stringify(apiRows),
        [pageUrl(1)]: htmlPage([
          releaseHtml('0.161.0', '2026-10-07T15:58:45Z', '<p>Stale HTML still labels this as stable.</p>'),
          releaseHtml('0.80.0', '2026-01-09T19:48:15Z'),
        ]),
      }),
    });
    expect(entries.map(entry => entry.version)).toEqual(['0.80.0']);
  });

  it('keeps the Python SDK tag and title while classifying it as a product record', async () => {
    const python = releaseHtml('0.154.0', '2026-09-10T10:00:00Z', '<p>Python SDK release notes.</p>')
      .replaceAll('rust-v0.154.0', 'python-v0.154.0')
      .replaceAll('>0.154.0<', '>Python SDK 0.154.0<');
    const entries = await readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: fullApi(),
        [pageUrl(1)]: htmlPage([python, releaseHtml('0.154.0', '2026-09-09T22:35:38Z')]),
      }),
    });
    expect(entries.find(entry => entry.version === 'python-v0.154.0')).toMatchObject({
      channel: 'general', originalTitle: 'Python SDK 0.154.0',
      version: 'python-v0.154.0', sourceUrl: `${source.url}/tag/python-v0.154.0`,
    });
    expect(entries.find(entry => entry.version === '0.154.0')?.channel).toBe('cli');
  });

  it('follows an explicit Read more link to preserve a historical release full body', async () => {
    const detailUrl = `${source.url}/tag/rust-v0.80.0`;
    const archived: string[] = [];
    const entries = await readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: fullApi(),
        [pageUrl(1)]: htmlPage([truncatedRelease('0.80.0', '2026-01-09T19:48:15Z')]),
        [detailUrl]: detailHtml('0.80.0', '2026-01-09T19:48:15Z'),
      }),
      onDocument: document => { archived.push(document.url); },
    });
    expect(entries.find(entry => entry.version === '0.80.0')?.originalText)
      .toContain('Trailing change omitted by the release list.');
    expect(entries.find(entry => entry.version === '0.80.0')?.references).toContainEqual({
      title: 'Full official background', url: 'https://openai.com/index/introducing-codex/', kind: 'blog',
    });
    expect(archived).toEqual([source.fetchUrl, pageUrl(1), detailUrl]);
  });

  it('does not fetch truncated HTML details for a version already covered by the canonical API', async () => {
    const visited: string[] = [];
    const entries = await readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: fullApi(),
        [pageUrl(1)]: htmlPage([truncatedRelease('0.161.0', '2026-10-07T15:58:45Z')]),
      }, visited),
    });
    expect(entries[0].originalText).toBe(apiRelease().body);
    expect(visited).toEqual([source.fetchUrl, pageUrl(1)]);
  });

  it('preserves the end of a complete historical body longer than 30000 characters', async () => {
    const fullBody = detailHtml('0.156.0', '2026-09-22T19:51:01Z')
      .replace('Trailing change omitted by the release list.', `${'x'.repeat(31_000)} FINAL_SOURCE_CHANGE`);
    const entries = await readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: fullApi(),
        [pageUrl(1)]: htmlPage([truncatedRelease('0.156.0', '2026-09-22T19:51:01Z')]),
        [`${source.url}/tag/rust-v0.156.0`]: fullBody,
      }),
    });
    expect(entries.find(entry => entry.version === '0.156.0')?.originalText.includes('FINAL_SOURCE_CHANGE')).toBe(true);
  });

  it('rejects a missing Read more response instead of returning truncated list text', async () => {
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: fullApi(),
        [pageUrl(1)]: htmlPage([truncatedRelease('0.80.0', '2026-01-09T19:48:15Z')]),
      }),
    })).rejects.toThrow(/Unexpected document/);
  });

  it.each(['missing timestamp', 'still truncated'])('rejects an incomplete canonical release document: %s', async problem => {
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: fullApi(),
        [pageUrl(1)]: htmlPage([truncatedRelease('0.80.0', '2026-01-09T19:48:15Z')]),
        [`${source.url}/tag/rust-v0.80.0`]: detailHtml('0.80.0', problem === 'missing timestamp' ? undefined : '2026-01-09T19:48:15Z', problem === 'still truncated'),
      }),
    })).rejects.toThrow(/발표|본문/);
  });

  it('rejects another real release HTML body even when its response URL is relabeled as the requested version', async () => {
    // Reduced directly from the saved official 0.157.0 document, whose URL,
    // publication time, title, and first feature were independently checked.
    const wrongRelease = `<html><head>
      <meta property="og:url" content="/openai/codex/releases/tag/rust-v0.157.0">
      </head><body><h1>0.157.0</h1><div>github-actions released this
      <relative-time datetime="2026-09-25T02:31:06Z">25 Sep 02:31</relative-time></div>
      <div class="markdown-body"><h2>New Features</h2><ul><li>
      Added GPT-6 Sol and Luna, including Amazon Bedrock support and migration prompts for older models. (#47332, #47347)
      </li></ul></div></body></html>`;
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: fullApi(),
        [pageUrl(1)]: htmlPage([truncatedRelease('0.158.0', '2026-09-28T05:07:23Z')]),
        [`${source.url}/tag/rust-v0.158.0`]: wrongRelease,
      }),
    })).rejects.toThrow(/버전|주소|식별/);
  });

  it('accepts a matching canonical link when an Open Graph URL is absent', async () => {
    const body = detailHtml('0.80.0', '2026-01-09T19:48:15Z')
      .replace('<meta property="og:url" content="/openai/codex/releases/tag/rust-v0.80.0">',
        '<link rel="canonical" href="https://github.com/openai/codex/releases/tag/rust-v0.80.0">');
    const entries = await readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: fullApi(),
        [pageUrl(1)]: htmlPage([truncatedRelease('0.80.0', '2026-01-09T19:48:15Z')]),
        [`${source.url}/tag/rust-v0.80.0`]: body,
      }),
    });
    expect(entries.find(entry => entry.version === '0.80.0')?.originalText).toContain('Trailing change omitted by the release list.');
  });

  it('rejects a detail body without a declared release identity', async () => {
    const body = detailHtml('0.80.0', '2026-01-09T19:48:15Z')
      .replace('<meta property="og:url" content="/openai/codex/releases/tag/rust-v0.80.0">', '');
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({
        [source.fetchUrl]: fullApi(),
        [pageUrl(1)]: htmlPage([truncatedRelease('0.80.0', '2026-01-09T19:48:15Z')]),
        [`${source.url}/tag/rust-v0.80.0`]: body,
      }),
    })).rejects.toThrow(/버전|주소|식별/);
  });

  it('rejects the web archive cap if January coverage is still unverified', async () => {
    vi.useFakeTimers();
    const outcome = readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: async url => {
        if (url === source.fetchUrl) return { url, body: fullApi(), contentType: 'application/json' };
        const page = Number(new URL(url).searchParams.get('page'));
        return {
          url, contentType: 'text/html',
          body: htmlPage([releaseHtml(`0.${page}.0`, '2026-01-09T19:48:15Z')], page === 100 ? undefined : page + 1),
        };
      },
    }).then(value => ({ value }), error => ({ error }));
    await vi.runAllTimersAsync();
    const result = await outcome;
    expect(result).toHaveProperty('error');
    expect('error' in result ? String(result.error) : '').toMatch(/범위|한도/);
  });

  it('rejects oversized cached documents without attempting to parse or archive them', async () => {
    let archived = false;
    await expect(readCodexHistory(source, {
      earliestPublishedAt: earliest,
      fetchDocument: documents({ [source.fetchUrl]: ' '.repeat(8 * 1024 * 1024 + 1) }),
      onDocument: () => { archived = true; },
    })).rejects.toThrow(/용량/);
    expect(archived).toBe(false);
  });
});

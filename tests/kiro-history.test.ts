import { describe, expect, it } from 'vitest';
import { readKiroHistory } from '../src/collector/kiro-history.js';
import type { FetchedDocument } from '../src/collector/official-fetch.js';
import type { SourceDefinition } from '../src/collector/sources.js';

const source: SourceDefinition = {
  id: 'kiro-changelog', product: 'kiro', name: 'Kiro 공식 변경 기록',
  url: 'https://kiro.dev/changelog/', fetchUrl: 'https://kiro.dev/changelog/', parser: 'kiro',
};
const earliestPublishedAt = Date.parse('2026-01-01T00:00:00Z');
const document = (url: string, body: string): FetchedDocument => ({ url, body, contentType: 'text/html' });
const pageUrl = (page: number) => page === 1 ? source.fetchUrl : `https://kiro.dev/changelog/page/${page}/`;
type Patch = { version: string; date: string };

function row(path: string, version: string, date: string, content = '<p>Official release content is present here.</p>', patches: Patch[] = []) {
  return `<div data-timeline-item="true"><div><time>${date}</time><span>${version}</span>
    ${patches.map(patch => `<a href="/changelog/${path}#patch-${patch.version.replaceAll('.', '-')}"><span>${patch.version}</span><span>${patch.date}</span></a>`).join('')}
    </div><article id="${path.split('/').at(-1)}"><a href="/changelog/${path}/"><h2>Release ${version}</h2></a>${content}</article></div>`;
}

function page(rows: string, next?: number) {
  return `<html><body>${rows}${next ? `<nav><a aria-label="Go to page ${next}" href="/changelog/page/${next}/">Next</a></nav>` : ''}</body></html>`;
}

const element = (tag: string, children: unknown, props: Record<string, unknown> = {}) => ['$', tag, null, { ...props, children }];
const articleModel = (path: string, children: unknown) => element('$LItem',
  element('article', children, { id: path.split('/').at(-1) }),
  { entryUrl: `/changelog/${path}` });
const patchNode = (version: string, date: string, body: string) => element('div', [
  element('p', [element('strong', version), element('span', ` | ${date}`)]),
  element('p', body),
], { id: `patch-${version.replaceAll('.', '-')}` });
const flightScript = (stream: string) => `<script>self.__next_f.push(${JSON.stringify([1, stream]).replaceAll('<', '\\u003c')});</script>`;

describe('Kiro history collection', () => {
  it('walks to the final page despite older parent dates and archives complete HTML without detail requests', async () => {
    const pages = new Map([
      [pageUrl(1), page(row('cli/2-0', '2.0.0', 'Oct 5, 2026'), 2)],
      [pageUrl(2), page(row('cli/1-24', '1.24.0', 'Jan 16, 2026'), 3)],
      [pageUrl(3), page(row('ide/0-8', '0.8.0', 'Dec 18, 2025'), 4)],
      [pageUrl(4), page(row('ide/0-6', '0.6.0', 'Nov 17, 2025'))],
    ]);
    const requested: string[] = [];
    const archived: FetchedDocument[] = [];
    const result = await readKiroHistory(source, {
      earliestPublishedAt,
      fetchDocument: async url => {
        requested.push(url);
        if (!pages.has(url)) throw new Error('Unexpected request');
        return document(url, pages.get(url)!);
      },
      onDocument: async doc => { archived.push(doc); },
    });
    expect(requested).toEqual([pageUrl(1), pageUrl(2), pageUrl(3), pageUrl(4)]);
    expect(archived.map(doc => doc.body)).toEqual([...pages.values()]);
    expect(result.map(entry => entry.publishedDate)).toEqual(['2026-10-05', '2026-01-16', '2025-12-18', '2025-11-17']);
    expect(result[0]).toMatchObject({ product: 'kiro', channel: 'cli', version: '2.0.0', sourceUrl: 'https://kiro.dev/changelog/cli/2-0/' });
    expect(result[0]!.originalText).toContain('Official release content is present here.');
  });

  it.each([
    { days: 45, cutoff: '2026-08-23', previous: 'Aug 11, 2026', path: 'ide/1-0', version: '1.0.0', parentDate: 'Jun 25, 2026', patches: [{ version: '1.0.411', date: 'Aug 31, 2026' }] },
    { days: 30, cutoff: '2026-09-07', previous: 'Sep 1, 2026', path: 'cli/2-21', version: '2.21.0', parentDate: 'Sep 1, 2026', patches: [{ version: '2.21.3', date: 'Sep 10, 2026' }, { version: '2.21.2', date: 'Sep 8, 2026' }] },
  ])('finds recent patches on later pages outside the $days-day parent window', async scenario => {
    const openPatches = scenario.patches.map(patch => `<div id="patch-${patch.version.replaceAll('.', '-')}"><p><strong>${patch.version}</strong><span> | ${patch.date}</span></p><p>Exact patch body for this fixture.</p></div>`).join('');
    const pages = new Map([
      [pageUrl(1), page(row('cli/2-28', '2.28.0', 'Oct 5, 2026'), 2)],
      [pageUrl(2), page(row('ide/older', '9.0.0', scenario.previous), 3)],
      [pageUrl(3), page(row(scenario.path, scenario.version, scenario.parentDate, `<p>Original parent release content.</p><h2>Patches</h2>${openPatches}`, scenario.patches))],
    ]);
    const requested: string[] = [];
    const result = await readKiroHistory(source, {
      earliestPublishedAt: Date.parse(`${scenario.cutoff}T00:00:00Z`),
      fetchDocument: async url => {
        requested.push(url);
        if (!pages.has(url)) throw new Error('Unexpected detail request');
        return document(url, pages.get(url)!);
      },
    });
    expect(requested).toEqual([pageUrl(1), pageUrl(2), pageUrl(3)]);
    for (const patch of scenario.patches) {
      expect(result.find(entry => entry.version === patch.version)).toMatchObject({
        sourceUrl: `https://kiro.dev/changelog/${scenario.path}#patch-${patch.version.replaceAll('.', '-')}`,
        originalText: 'Exact patch body for this fixture.',
      });
    }
    expect(result.find(entry => entry.version === scenario.version)!.originalText).not.toContain('Exact patch body for this fixture.');
  });

  it('recovers scoped Flight article data and dated boundary patches while preferring standalone timeline versions', async () => {
    const unicode = '정확한 복구 안내 🛠';
    const collapsed = '<p>Visible official release introduction.</p><button aria-expanded="false">Fixes</button><button aria-expanded="false">Patches</button>';
    const main = row('cli/2-0-1', '2.0.1', 'Feb 2, 2026', '<p>Standalone timeline patch takes priority.</p>')
      + row('cli/2-0', '2.0.0', 'Feb 1, 2026', collapsed, [{ version: '2.0.2', date: 'Feb 3, 2026' }, { version: '2.0.1', date: 'Feb 2, 2026' }])
      + row('ide/0-8', '0.8.0', 'Dec 18, 2025', '<p>Older parent publication remains unchanged.</p><button aria-expanded="false">Patches</button>', [{ version: '0.8.140', date: 'Jan 15, 2026' }]);
    const stream = [
      ':HL["/_next/static/css/site.css","style"]\n',
      `a:${JSON.stringify(articleModel('cli/2-0', [element('h2', 'Release 2.0.0'), element('p', 'Visible official release introduction.'), '$b', element('$LCollapsible', [patchNode('2.0.2', 'Feb 3, 2026', 'Corrected the real command output.'), patchNode('2.0.1', 'Feb 2, 2026', 'Duplicate embedded patch.')], { title: 'Patches' })]))}\n`,
      `b:${JSON.stringify(element('$LCollapsible', element('p', ['Recovered exact fix: ', '$c']), { title: 'Fixes' }))}\n`,
      `c:T${Buffer.byteLength(unicode).toString(16)},${unicode}`,
      `d:${JSON.stringify(articleModel('ide/0-8', [element('p', 'Older parent publication remains unchanged.'), element('$LCollapsible', [patchNode('0.8.140', 'Jan 15, 2026', 'Editor security improvements')], { title: 'Patches' })]))}\n`,
      `e:${JSON.stringify(articleModel('cli/unrelated', element('p', 'Do not copy another release into this article.')))}\n`,
    ].join('');
    const split = Math.floor(stream.length / 2);
    const body = page(main) + flightScript(stream.slice(0, split)) + flightScript(stream.slice(split))
      + '<script>globalThis.__kiroHistoryExecuted = true;</script>';
    const result = await readKiroHistory(source, {
      earliestPublishedAt,
      fetchDocument: async url => {
        if (url !== source.fetchUrl) throw new Error('Flight data should not require a second request');
        return document(url, body);
      },
    });
    expect(result).toHaveLength(5);
    expect(result.find(entry => entry.version === '2.0.0')!.originalText).toContain(unicode);
    expect(result.find(entry => entry.version === '2.0.0')!.originalText).not.toContain('Do not copy another release');
    expect(result.find(entry => entry.version === '2.0.0')!.originalText).not.toContain('Corrected the real command output.');
    expect(result.find(entry => entry.version === '2.0.0')!.originalText).not.toContain('Duplicate embedded patch.');
    expect(result.filter(entry => entry.version === '2.0.1')).toHaveLength(1);
    expect(result.find(entry => entry.version === '2.0.1')!.sourceUrl).toBe('https://kiro.dev/changelog/cli/2-0-1/');
    expect(result.find(entry => entry.version === '0.8.0')!.publishedDate).toBe('2025-12-18');
    expect(result.find(entry => entry.version === '0.8.140')).toMatchObject({
      product: 'kiro', channel: 'ide', publishedDate: '2026-01-15',
      publishedAt: '2026-01-15T00:00:00.000Z', datePrecision: 'day',
      sourceUrl: 'https://kiro.dev/changelog/ide/0-8#patch-0-8-140',
    });
    expect(result.find(entry => entry.version === '0.8.140')!.originalText).toBe('Editor security improvements');
    expect((globalThis as Record<string, unknown>).__kiroHistoryExecuted).toBeUndefined();
  });

  it('limits detail fallback requests to three and preserves list dates, URLs and channels', async () => {
    const body = page(Array.from({ length: 7 }, (_, index) => row(`cli/2-${index}`, `2.${index}.0`, 'Oct 5, 2026',
      '<p>Visible official introduction.</p><button aria-expanded="false">Fixes</button>')).join(''));
    let active = 0;
    let maximumActive = 0;
    const archived: string[] = [];
    const result = await readKiroHistory(source, {
      earliestPublishedAt,
      fetchDocument: async url => {
        if (url === source.fetchUrl) return document(url, body);
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return document(url, '<html><article><time>Oct 7, 2026</time><div class="changelog"><h2>Fixes</h2><p>Full exact detail body.</p></div><div><a href="/changelog/cli/unrelated/">Unrelated next release.</a></div></article></html>');
      },
      onDocument: doc => { archived.push(doc.url); },
    });
    expect(maximumActive).toBe(3);
    expect(archived).toHaveLength(8);
    expect(result).toHaveLength(7);
    for (const entry of result) {
      expect(entry).toMatchObject({ publishedDate: '2026-10-05', product: 'kiro', channel: 'cli' });
      expect(entry.sourceUrl).toMatch(/^https:\/\/kiro\.dev\/changelog\/cli\/2-\d\/$/);
      expect(entry.originalText).toContain('Full exact detail body.');
      expect(entry.originalText).not.toContain('Unrelated next release');
      expect(entry.originalText).not.toContain('Oct 7, 2026');
    }
  });

  it('propagates a later page failure instead of accepting incomplete history', async () => {
    await expect(readKiroHistory(source, {
      earliestPublishedAt,
      fetchDocument: async url => {
        if (url === source.fetchUrl) return document(url, page(row('cli/2-0', '2.0.0', 'Oct 5, 2026'), 2));
        throw new Error('HTTP 503 from official page');
      },
    })).rejects.toThrow('HTTP 503');
  });

  it('rejects unreadable advertised sections after attempting the official detail page', async () => {
    const archived: string[] = [];
    await expect(readKiroHistory(source, {
      earliestPublishedAt,
      fetchDocument: async url => document(url, url === source.fetchUrl
        ? page(row('cli/2-0', '2.0.0', 'Oct 5, 2026', '<p>Visible official introduction.</p><button aria-expanded="false">Fixes</button>'))
        : '<html><article><p>Visible official introduction.</p><button aria-expanded="false">Fixes</button></article></html>'),
      onDocument: doc => { archived.push(doc.url); },
    })).rejects.toThrow();
    expect(archived).toEqual([source.fetchUrl, 'https://kiro.dev/changelog/cli/2-0/']);
  });

  it('rejects hostile pagination without fetching another host', async () => {
    const requested: string[] = [];
    await expect(readKiroHistory(source, {
      earliestPublishedAt,
      fetchDocument: async url => {
        requested.push(url);
        return document(url, page(row('cli/2-0', '2.0.0', 'Oct 5, 2026'))
          + '<a aria-label="Go to page 2" href="https://kiro.dev.evil.test/changelog/page/2/">Next</a>');
      },
    })).rejects.toThrow();
    expect(requested).toEqual([source.fetchUrl]);
  });

  it('fails when raw document persistence fails', async () => {
    await expect(readKiroHistory(source, {
      earliestPublishedAt,
      fetchDocument: async url => document(url, page(row('cli/2-0', '2.0.0', 'Oct 5, 2026'))),
      onDocument: async () => { throw new Error('Raw archive unavailable'); },
    })).rejects.toThrow('Raw archive unavailable');
  });

  it('does not invent a date for a patch with malformed official metadata', async () => {
    await expect(readKiroHistory(source, {
      earliestPublishedAt,
      fetchDocument: async url => document(url, page(row('ide/0-8', '0.8.0', 'Dec 18, 2025',
        '<p>Official parent release introduction.</p>', [{ version: '0.8.140', date: 'sometime next week' }]))),
    })).rejects.toThrow();
  });
});

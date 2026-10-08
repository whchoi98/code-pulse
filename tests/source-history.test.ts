import { describe, expect, it, vi } from 'vitest';
import { readGithubHistory } from '../src/collector/source-history.js';
import { SOURCES } from '../src/collector/sources.js';

const source = {
  ...SOURCES[0],
  fetchUrl: 'https://api.github.com/repos/anthropics/claude-code/releases?per_page=2',
};
const earliestPublishedAt = Date.parse('2026-01-01T00:00:00Z');
const release = (version: string, date: string, prerelease = false) => ({
  tag_name: `v${version}`, name: `v${version}`, published_at: `${date}T12:00:00Z`,
  prerelease, draft: false, html_url: `${source.url}/tag/v${version}`, body: `Changes in ${version}.`,
});
const document = (rows: ReturnType<typeof release>[], url = source.fetchUrl) => ({
  url, body: JSON.stringify(rows), contentType: 'application/json',
});

describe('official release history pagination', () => {
  it('keeps the January 1 boundary and reads until a complete page is older than the requested period', async () => {
    const pages = [
      [release('2.1.9', '2026-10-07'), release('2.1.8', '2026-06-01')],
      [release('2.1.7', '2026-01-01'), release('2.1.6', '2025-12-31')],
      [release('2.1.5', '2025-12-30'), release('2.1.4', '2025-12-29')],
    ];
    const fetchDocument = vi.fn(async (url: string) => document(pages[Number(new URL(url).searchParams.get('page') ?? '1') - 1], url));
    const onDocument = vi.fn();
    const entries = await readGithubHistory(source, { fetchDocument, onDocument, earliestPublishedAt });
    expect(entries.filter(entry => Date.parse(entry.publishedAt) >= earliestPublishedAt).map(entry => entry.version))
      .toEqual(['2.1.9', '2.1.8', '2.1.7']);
    expect(fetchDocument).toHaveBeenCalledTimes(3);
    expect(fetchDocument.mock.calls[1][0]).toBe(`${source.fetchUrl}&page=2`);
    expect(onDocument).toHaveBeenCalledTimes(3);
  });

  it('does not treat a full page of previews as the end of stable release history', async () => {
    const fetchDocument = vi.fn(async (url: string) => document(
      new URL(url).searchParams.has('page')
        ? [release('2.1.7', '2026-01-01')]
        : [release('2.1.9-beta.1', '2026-10-07', true), release('2.1.9-beta.2', '2026-10-06', true)],
      url,
    ));
    const entries = await readGithubHistory(source, { fetchDocument, earliestPublishedAt });
    expect(entries.map(entry => entry.version)).toEqual(['2.1.7']);
    expect(fetchDocument).toHaveBeenCalledTimes(2);
  });

  it('does not present a later page outage as a successful complete history', async () => {
    const fetchDocument = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.has('page')) throw new Error('HTTP 503');
      return document([release('2.1.9', '2026-10-07'), release('2.1.8', '2026-06-01')]);
    });
    await expect(readGithubHistory(source, { fetchDocument, earliestPublishedAt })).rejects.toThrow('HTTP 503');
  });

  it('stops repeated pages with an explicit error instead of looping or claiming complete coverage', async () => {
    const fetchDocument = vi.fn(async () => document([release('2.1.9', '2026-10-07'), release('2.1.8', '2026-06-01')]));
    await expect(readGithubHistory(source, { fetchDocument, earliestPublishedAt })).rejects.toThrow(/반복/);
    expect(fetchDocument).toHaveBeenCalledTimes(2);
  });

  it('accepts an empty terminal page after valid records but rejects an empty first page', async () => {
    const first = [release('2.1.9', '2026-10-07'), release('2.1.8', '2026-06-01')];
    const fetchDocument = vi.fn(async (url: string) => document(new URL(url).searchParams.has('page') ? [] : first, url));
    expect(await readGithubHistory(source, { fetchDocument, earliestPublishedAt })).toHaveLength(2);
    expect(fetchDocument).toHaveBeenCalledTimes(2);
    await expect(readGithubHistory(source, { fetchDocument: async () => document([]), earliestPublishedAt })).rejects.toThrow();
  });
});

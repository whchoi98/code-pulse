import { describe, expect, it } from 'vitest';
import { parseCodexFeed, parseGithubReleases, parseKiroChangelog, SOURCES } from '../src/collector/sources.js';

describe('official source parsers', () => {
  it('identifies a Python SDK release as a product update rather than a CLI release', () => {
    const entries = parseGithubReleases(JSON.stringify([{
      tag_name: 'python-v0.154.0', name: 'Python SDK 0.154.0', prerelease: false, draft: false,
      published_at: '2026-09-10T19:51:43Z', html_url: 'https://github.com/openai/codex/releases/tag/python-v0.154.0',
      body: 'Install with pip install --upgrade openai-codex==0.154.0.',
    }]), SOURCES[1]);
    expect(entries[0]).toMatchObject({ channel: 'general', version: 'python-v0.154.0', originalTitle: 'Python SDK 0.154.0' });
  });

  it('keeps stable releases and the real publication timestamp, excluding drafts and prereleases', () => {
    const body = JSON.stringify([
      { tag_name: 'rust-v0.120.0-alpha.1', name: 'alpha', prerelease: true, draft: false, published_at: '2026-10-07T10:00:00Z', html_url: 'https://github.com/openai/codex/releases/tag/rust-v0.120.0-alpha.1', body: 'preview' },
      { tag_name: 'rust-v0.119.0', name: '0.119.0', prerelease: false, draft: false, published_at: '2026-10-06T22:10:00Z', html_url: 'https://github.com/openai/codex/releases/tag/rust-v0.119.0', body: '## New features\n- Added workspace access controls.' },
      { tag_name: 'rust-v0.118.0', name: 'draft', prerelease: false, draft: true, published_at: '2026-10-05T00:00:00Z', html_url: 'https://github.com/openai/codex/releases/tag/rust-v0.118.0', body: 'draft' },
    ]);
    const entries = parseGithubReleases(body, SOURCES[1]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      product: 'codex', channel: 'cli', version: '0.119.0',
      publishedAt: '2026-10-06T22:10:00.000Z', publishedDate: '2026-10-06',
      datePrecision: 'timestamp',
      sourceUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.119.0',
    });
    expect(entries[0].originalText).toContain('workspace access controls');
  });

  it('does not publish unrelated ChatGPT news from the combined Codex RSS feed', () => {
    const xml = `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
      <item><title>ChatGPT for iOS</title><link>https://developers.openai.com/codex/changelog/#codex-2026-10-07-mobile</link><pubDate>Wed, 07 Oct 2026 00:00:00 GMT</pubDate><content:encoded><![CDATA[# ChatGPT for iOS\nAdded support for opening Codex task links directly on iOS.]]></content:encoded></item>
      <item><title>Recipe cards</title><link>https://learn.chatgpt.com/docs/changelog/#recipes</link><pubDate>Wed, 07 Oct 2026 00:00:00 GMT</pubDate><content:encoded>ChatGPT can display recipes.</content:encoded></item>
    </channel></rss>`;
    const entries = parseCodexFeed(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ product: 'codex', channel: 'app', publishedDate: '2026-10-07', datePrecision: 'day' });
    expect(entries[0].originalText).toContain('Codex task links');
  });

  it('extracts Kiro release dates, product channel and text without copying the navigation', () => {
    const html = `<html><nav>Marketing material</nav><div data-timeline-item="true">
      <div><time>Oct 5, 2026</time><div><span>2.28.0</span><span>CLI</span></div></div>
      <div><article id="2-28"><div><a href="/changelog/cli/2-28/"><h2>Category-Based Hook Matching</h2></a></div>
      <p>V3 Hooks can match tool categories.</p><div class="changelog"><h2>Match Hooks</h2><p>Use shell, read, or write categories.</p><a href="/blog/hooks/">Read the announcement</a></div>
      </article></div></div></html>`;
    const entries = parseKiroChangelog(html);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      product: 'kiro', channel: 'cli', version: '2.28.0', publishedDate: '2026-10-05',
      sourceUrl: 'https://kiro.dev/changelog/cli/2-28/',
    });
    expect(entries[0].originalText).toContain('Use shell, read, or write categories.');
    expect(entries[0].originalText).not.toContain('Marketing material');
    expect(entries[0].references).toContainEqual({ title: 'Read the announcement', url: 'https://kiro.dev/blog/hooks/', kind: 'blog' });
  });

  it('rejects changed markup and malformed dates instead of reporting a successful empty day', () => {
    expect(() => parseKiroChangelog('<html>Service unavailable</html>')).toThrow();
    expect(() => parseGithubReleases('{"message":"rate limit"}', SOURCES[0])).toThrow();
    const invalid = JSON.stringify([{ tag_name: 'v1.0.0', prerelease: false, draft: false, published_at: 'yesterday-ish', html_url: 'https://github.com/anthropics/claude-code/releases/tag/v1.0.0', body: 'Added something.' }]);
    expect(() => parseGithubReleases(invalid, SOURCES[0])).toThrow();
  });

  it('rejects hostile release URLs and XML document type declarations', () => {
    const invalid = JSON.stringify([{ tag_name: 'v1.0.0', prerelease: false, draft: false, published_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com.evil.test/anthropics/claude-code/releases/tag/v1.0.0', body: 'Added something.' }]);
    expect(() => parseGithubReleases(invalid, SOURCES[0])).toThrow();
    expect(() => parseCodexFeed('<!DOCTYPE x [<!ENTITY s SYSTEM "file:///etc/passwd">]><rss>&s;</rss>')).toThrow();
  });

  it('does not let an older empty release body prevent reading a newer release', () => {
    const metadata = { prerelease: false, draft: false, published_at: '2026-10-07T10:00:00Z' };
    const entries = parseGithubReleases(JSON.stringify([
      { ...metadata, tag_name: 'v2.1.293', html_url: `${SOURCES[0].url}/tag/v2.1.293`, body: 'Added agent type to the status line.' },
      { ...metadata, tag_name: 'v2.1.177', html_url: `${SOURCES[0].url}/tag/v2.1.177`, body: '' },
    ]), SOURCES[0]);
    expect(entries.map(entry => entry.version)).toEqual(['2.1.293']);
  });
  it('recognizes CLI versions imported into the official Codex RSS and excludes their previews', () => {
    const xml = `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
      <item><title>Codex CLI Release: 0.161.0</title><link>https://developers.openai.com/codex/changelog/#github-release-1</link><pubDate>Wed, 07 Oct 2026 00:00:00 GMT</pubDate><content:encoded>Codex CLI adds workspace controls.</content:encoded></item>
      <item><title>Codex CLI Release: 0.162.0-alpha.18</title><link>https://developers.openai.com/codex/changelog/#github-release-2</link><pubDate>Wed, 07 Oct 2026 00:00:00 GMT</pubDate><content:encoded>Codex CLI preview.</content:encoded></item>
    </channel></rss>`;
    expect(parseCodexFeed(xml).map(entry => ({ version: entry.version, channel: entry.channel }))).toEqual([{ version: '0.161.0', channel: 'cli' }]);
  });
});

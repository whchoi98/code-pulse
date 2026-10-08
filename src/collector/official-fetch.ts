const PATHS: Record<string, RegExp> = {
  'api.github.com': /^\/repos\/(?:anthropics\/claude-code|openai\/codex)\/releases(?:\/|$)/,
  'github.com': /^\/(?:anthropics\/claude-code|openai\/codex)\/(?:releases|blob)(?:[/.]|$)/,
  'raw.githubusercontent.com': /^\/(?:anthropics\/claude-code|openai\/codex)\//,
  'developers.openai.com': /^\/(?:codex|blog)(?:\/|$)/,
  'learn.chatgpt.com': /^\/docs(?:\/|$)/,
  'openai.com': /^\/(?:index|news)(?:\/|$)/,
  'www.openai.com': /^\/(?:index|news)(?:\/|$)/,
  'anthropic.com': /^\/(?:news|engineering)(?:\/|$)/,
  'www.anthropic.com': /^\/(?:news|engineering)(?:\/|$)/,
  'claude.com': /^\/blog(?:\/|$)/,
  'www.claude.com': /^\/blog(?:\/|$)/,
  'code.claude.com': /^\/docs\/(?:en\/changelog|ko\/whats-new)(?:[/.]|$)/,
  'kiro.dev': /^\/(?:changelog|blog)(?:\/|$)/,
};

export function isOfficialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && Boolean(PATHS[url.hostname]?.test(url.pathname));
  } catch { return false; }
}

export function isOfficialBlog(value: string): boolean {
  if (!isOfficialUrl(value)) return false;
  const url = new URL(value);
  return (url.hostname.endsWith('openai.com') && url.pathname.startsWith('/index/'))
    || (url.hostname.endsWith('anthropic.com') && /^\/(news|engineering)\//.test(url.pathname))
    || (url.hostname.endsWith('claude.com') && url.pathname.startsWith('/blog/'))
    || (url.hostname === 'kiro.dev' && url.pathname.startsWith('/blog/'));
}

export interface FetchedDocument {
  body: string;
  url: string;
  contentType: string;
}

export async function fetchOfficial(initialUrl: string, fetcher: typeof fetch = fetch): Promise<FetchedDocument> {
  const maximumBytes = 8 * 1024 * 1024;
  for (let attempt = 0; attempt < 3; attempt++) {
    let retryDelay = 1000 * 2 ** attempt;
    try {
      let url = initialUrl;
      for (let redirect = 0; redirect <= 5; redirect++) {
        if (!isOfficialUrl(url)) throw new Error('허용되지 않은 출처 주소입니다.');
        const response = await fetcher(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(25_000),
          headers: {
            'user-agent': 'CodePulse/1.0 (daily official release reader)',
            accept: new URL(url).hostname === 'code.claude.com'
              ? 'text/markdown, text/plain;q=0.9'
              : 'application/json, application/rss+xml, text/html, text/plain;q=0.9',
          },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new Error('출처의 이동 주소가 없습니다.');
          url = new URL(location, url).toString();
          continue;
        }
        if (!response.ok) {
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter && (response.status === 429 || response.status >= 500)) {
            const serverDelay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - Date.now();
            if (!Number.isNaN(serverDelay)) retryDelay = Math.max(retryDelay, serverDelay);
          }
          await response.body?.cancel();
          throw new Error(`공식 출처 응답: HTTP ${response.status}`);
        }
        const advertised = Number(response.headers.get('content-length') ?? 0);
        if (advertised > maximumBytes) {
          await response.body?.cancel();
          throw new Error('공식 자료가 수집 용량 제한을 초과했습니다.');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('공식 출처의 본문이 비어 있습니다.');
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > maximumBytes) throw new Error('공식 자료가 수집 용량 제한을 초과했습니다.');
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        return { body: Buffer.concat(chunks).toString('utf8'), url, contentType: response.headers.get('content-type') ?? '' };
      }
      throw new Error('출처 주소가 너무 여러 번 이동했습니다.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /HTTP (429|5\d\d)|fetch failed|timeout|aborted/i.test(message);
      // A longer server pause belongs to a later collection, not an early retry.
      if (!retryable || attempt === 2 || retryDelay > 60_000) throw error;
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  throw new Error('공식 자료를 읽을 수 없습니다.');
}

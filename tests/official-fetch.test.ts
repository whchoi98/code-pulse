import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOfficial } from '../src/collector/official-fetch.js';

const url = 'https://github.com/openai/codex/releases?page=42';
afterEach(() => vi.useRealTimers());

describe('official source rate limits', () => {
  it('waits for the server Retry-After interval before retrying a 429 response', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('Rate limited', { status: 429, headers: { 'retry-after': '6' } }))
      .mockResolvedValueOnce(new Response('Official release content'));
    const result = fetchOfficial(url, fetcher);
    await vi.advanceTimersByTimeAsync(5999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).body).toBe('Official release content');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('understands an HTTP-date Retry-After value', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T22:00:00Z'));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('Unavailable', { status: 503, headers: { 'retry-after': 'Wed, 07 Oct 2026 22:00:08 GMT' } }))
      .mockResolvedValueOnce(new Response('Official release content'));
    const result = fetchOfficial(url, fetcher);
    await vi.advanceTimersByTimeAsync(7999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).body).toBe('Official release content');
  });

  it('leaves long rate-limit waits for a later collection without sending an early retry', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('Rate limited', { status: 429, headers: { 'retry-after': '120' } }))
      .mockResolvedValue(new Response('Official release content'));
    const result = fetchOfficial(url, fetcher).then(value => value, error => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(Error);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

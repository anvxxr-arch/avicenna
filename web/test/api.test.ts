/**
 * api.ts — the envelope parser is the single point where every backend response
 * becomes typed data, so it is the frontend's contract surface. Stub fetch and
 * pin the four outcomes: unwrapped data, the error envelope, a non-JSON proxy
 * answer, and a foreign shape that must not be rendered as an empty payload.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { API_BASE, ApiRequestError, apiGet } from '../src/lib/api';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string) => Response | Promise<Response>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('apiGet', () => {
  test('unwraps the success envelope', async () => {
    stubFetch(() => json({ api: 'nontonanime-go', version: '1', data: { ok: true } }));
    await expect(apiGet('/health')).resolves.toEqual({ ok: true });
  });

  test('turns the error envelope into a typed ApiRequestError', async () => {
    stubFetch(() => json({ api: 'nontonanime-go', version: '1', error: { code: 'not_found', message: 'Not found' } }, 404));
    const err = await apiGet('/nope').catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('Not found');
  });

  test('surfaces 405 as its own class, not as bad_request', async () => {
    stubFetch(() => json({ api: 'x', version: '1', error: { code: 'method_not_allowed', message: 'GET only' } }, 405));
    const err = await apiGet('/home').catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.code).toBe('method_not_allowed');
    expect(err.status).toBe(405);
  });

  test('a class the client does not know yet is still reported, not swallowed', async () => {
    stubFetch(() => json({ api: 'x', version: '1', error: { code: 'teapot', message: 'short and stout' } }, 500));
    const err = await apiGet('/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.code).toBe('teapot');
  });

  test('a non-JSON body (gateway HTML, empty 502) becomes an internal error', async () => {
    stubFetch(() => new Response('<html>504 Gateway Time-out</html>', { status: 502 }));
    const err = await apiGet('/home').catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.status).toBe(502);
    expect(err.code).toBe('internal');
    expect(err.message).toContain('non-JSON response');
  });

  test('a foreign JSON shape is refused instead of rendering an empty payload', async () => {
    stubFetch(() => json({ result: [] }));
    const err = await apiGet('/home').catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.message).toBe('response is not an Avicenna envelope');
  });

  test('omits empty and undefined params but keeps 0', async () => {
    const calls = stubFetch(() => json({ api: 'x', version: '1', data: null }));
    await apiGet('/home', { page: 0, q: undefined, empty: '', ok: 3 });
    expect(calls).toHaveLength(1);
    const url = calls[0];
    expect(url.startsWith(`${API_BASE}/home?`)).toBe(true);
    expect(url).toContain('page=0');
    expect(url).toContain('ok=3');
    expect(url).not.toContain('q=');
    expect(url).not.toContain('empty=');
  });

  test('a query value with spaces and unicode is encoded, never spliced raw', async () => {
    const calls = stubFetch(() => json({ api: 'x', version: '1', data: null }));
    await apiGet('/search', { q: 'a b&c=d 日本' });
    const url = calls[0];
    expect(url).not.toContain('&c='); // the & inside the value must be encoded
    expect(url).toContain('q=a+b%26c%3Dd+%E6%97%A5%E6%9C%AC');
  });

  test('no params -> no query string', async () => {
    const calls = stubFetch(() => json({ api: 'x', version: '1', data: null }));
    await apiGet('/home');
    expect(calls[0]).toBe(`${API_BASE}/home`);
    expect(calls[0]).not.toContain('?');
  });

  test('sends an accept header so the server never negotiates HTML', async () => {
    let seen: HeadersInit | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.headers;
      return json({ api: 'x', version: '1', data: 1 });
    }) as typeof fetch;
    await apiGet('/health');
    expect(JSON.stringify(seen)).toContain('application/json');
  });
});

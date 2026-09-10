/**
 * core/fetch.ts — hardened transport: createSite() gives each scraper an isolated
 * limiter + LRU cache + in-flight dedupe + SSRF guards. Verbatim logic from
 * nontonanime.ts (spec 003 phase 0). Behavior frozen.
 */
import { isNonce } from './parse';

export interface SiteConfig {
  base: string;
  headers?: Record<string, string>;
  ttlMs?: number;      // LRU entry TTL (default 5min)
  cacheMax?: number;   // LRU size (default 100)
  rateMs?: number;     // min interval between requests (default 350)
  maxRetries?: number; // default 3
  timeoutMs?: number;  // default 15000
  maxBytes?: number;   // default 3MB
  maxRedirects?: number; // default 5
}

export interface Site {
  base: string;
  baseHost: string;
  isValidUrl(s: string): boolean;
  assertSiteUrl(u: string): string;
  sanitizeUrl(p: string): string;
  resolveUrl(raw: string, base: string): string;
  fetchPage(url: string): Promise<string>;
  postAjax(url: string, body: string, postUrl?: string): Promise<string>;
  cacheApi: { stats(): { size: number; max: number }; purge(): number };
}

const BLOCKED_HOST_RE = /^(localhost|127\.|0\.0\.0\.0|\[::|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return BLOCKED_HOST_RE.test(h) || h === 'localhost' || h === '::1';
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** Serial chain limiter + jitter. */
class RateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private last = 0;
  constructor(private delayMs: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    await prev;
    const now = Date.now();
    const wait = this.delayMs - (now - this.last);
    if (wait > 0) await sleep(wait + Math.random() * 120);
    try {
      const out = await fn();
      this.last = Date.now();
      return out;
    } finally { release(); }
  }
}

export function createSite(cfg: SiteConfig): Site {
  const base = cfg.base.replace(/\/+$/, '');
  const baseHost = new URL(base).hostname.toLowerCase();
  const TTL = cfg.ttlMs ?? 5 * 60_000;
  const CACHE_MAX = cfg.cacheMax ?? 100;
  const MAX_RETRIES = cfg.maxRetries ?? 3;
  const TIMEOUT_MS = cfg.timeoutMs ?? 15_000;
  const MAX_BYTES = cfg.maxBytes ?? 3_000_000;
  const MAX_REDIRECTS = cfg.maxRedirects ?? 5;
  const BASE_HEADERS = Object.freeze({ ...cfg.headers } as Record<string, string>);

  // === SSRF / URL GUARDS (per-site base) ===
  function isValidUrl(str: string): boolean {
    if (!str || typeof str !== 'string' || str.length > 2048) return false;
    try {
      const u = new URL(str.length > 0 && str[0] === '/' ? base + str : str);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      if (u.username || u.password) return false;
      if (isBlockedHost(u.hostname)) return false;
      return true;
    } catch { return false; }
  }

  function assertSiteUrl(url: string): string {
    const u = new URL(url.startsWith('/') ? base + url : url);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname.toLowerCase() !== baseHost) {
      throw new Error(`URL host not allowed: ${u.hostname}`);
    }
    if (isBlockedHost(u.hostname)) throw new Error('Blocked host');
    return u.toString();
  }

  function sanitizeUrl(path: string): string {
    if (!path || typeof path !== 'string') throw new Error('Empty URL');
    const clean = path.trim().slice(0, 2048);
    if (/[\x00-\x1f\x7f\\]/.test(clean)) throw new Error('Illegal chars in URL');
    if (/^javascript:/i.test(clean) || /^data:/i.test(clean) || /^vbscript:/i.test(clean)) {
      throw new Error('Blocked URL scheme');
    }
    const u = new URL(clean, base + '/');
    if (u.hostname.toLowerCase() !== baseHost) {
      throw new Error(`External host rejected: ${u.hostname}`);
    }
    u.username = ''; u.password = ''; u.hash = '';
    return u.toString();
  }

  function resolveUrl(raw: string, b: string): string {
    const u = new URL(raw, b);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Bad redirect scheme');
    if (u.username || u.password) throw new Error('Creds in URL blocked');
    if (isBlockedHost(u.hostname)) throw new Error('Blocked redirect host');
    u.username = ''; u.password = '';
    const s = u.toString();
    if (s.length > 2048) throw new Error('URL too long');
    return s;
  }

  // === LRU + in-flight ===
  const cache = new Map<string, { t: number; v: string }>();
  const inflight = new Map<string, Promise<string>>();

  function cacheGet(k: string): string | null {
    const e = cache.get(k);
    if (!e) return null;
    if (Date.now() - e.t > TTL) { cache.delete(k); return null; }
    cache.delete(k); cache.set(k, e);
    return e.v;
  }
  function cacheSet(k: string, v: string): void {
    if (cache.has(k)) cache.delete(k);
    cache.set(k, { t: Date.now(), v });
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  const limiter = new RateLimiter(cfg.rateMs ?? 350);

  async function readCapped(res: Response): Promise<string> {
    const cl = res.headers.get('content-length');
    if (cl && Number(cl) > MAX_BYTES) throw new Error(`Body too large (${cl} bytes)`);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('image/') || ct.includes('video/') || ct.includes('octet-stream')) {
      throw new Error(`Unexpected content-type: ${ct}`);
    }
    if (!res.body) return await res.text();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { reader.cancel().catch(() => {}); throw new Error('Body exceeds cap'); }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return new TextDecoder('utf-8').decode(buf);
  }

  async function doFetch(url: string, init?: RequestInit, redirects = 0): Promise<string> {
    let cur = url;
    for (let r = 0; r <= MAX_REDIRECTS; r++) {
      const ctrl = AbortSignal.timeout(TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(cur, { ...init, redirect: 'manual', signal: ctrl });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('aborted') || msg.toLowerCase().includes('timeout')) throw new Error(`Timeout ${TIMEOUT_MS}ms for ${cur}`);
        throw e;
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!loc) throw new Error(`Redirect ${res.status} without location`);
        if (redirects + r >= MAX_REDIRECTS) throw new Error('Too many redirects');
        cur = resolveUrl(loc, cur);
        continue;
      }
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        await res.body?.cancel().catch(() => {});
        const err = new Error(`HTTP ${res.status} for ${cur}`) as Error & { retryable?: boolean; retryAfter?: number };
        err.retryable = true;
        const ra = res.headers.get('retry-after');
        if (ra) { const n = Number(ra); if (Number.isFinite(n)) err.retryAfter = n * 1000; }
        throw err;
      }
      if (res.status === 403 || res.status === 401 || res.status === 503) {
        try {
          const peek = await readCapped(res);
          if (/attention required|just a moment|cf-challenge|captcha|you have been blocked/i.test(peek)) {
            throw new Error(`WAF blocked (Cloudflare) for ${cur} — filter params trip bot protection; retry with fewer filters`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('WAF blocked')) throw e;
        }
        throw new Error(`HTTP ${res.status} for ${cur}`);
      }
      if (res.status !== 200) { await res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status} for ${cur}`); }
      void redirects;
      return await readCapped(res);
    }
    throw new Error('Too many redirects');
  }

  async function withRetry(fn: () => Promise<string>): Promise<string> {
    let last: Error = new Error('failed');
    for (let i = 0; i <= MAX_RETRIES; i++) {
      try { return await fn(); } catch (e) {
        last = e as Error;
        const r = e as Error & { retryable?: boolean; retryAfter?: number };
        const retryable = r.retryable ?? /timeout|econn|enotfound|eai_again|socket|fetch failed/i.test(last.message);
        if (!retryable || i === MAX_RETRIES) throw last;
        const backoff = r.retryAfter ?? Math.min(8000, 600 * 2 ** i);
        await sleep(backoff + Math.random() * 300);
      }
    }
    throw last;
  }

  async function fetchPage(url: string): Promise<string> {
    const site = url.startsWith('/') ? sanitizeUrl(url) : assertSiteUrl(url);
    const hit = cacheGet(site);
    if (hit !== null) return hit;
    const dupe = inflight.get(site);
    if (dupe) return dupe;
    const p = limiter.run(() => withRetry(() => doFetch(site, { headers: BASE_HEADERS })))
      .then((v) => { cacheSet(site, v); return v; })
      .finally(() => { inflight.delete(site); });
    inflight.set(site, p);
    return p;
  }

  async function postAjax(url: string, body: string, postUrl?: string): Promise<string> {
    const site = url.startsWith('/') ? sanitizeUrl(url) : assertSiteUrl(url);
    if (body.length > 8192) throw new Error('POST body too large');
    const ref = postUrl ? (postUrl.startsWith('/') ? sanitizeUrl(postUrl) : assertSiteUrl(postUrl)) : base + '/';
    return limiter.run(() => withRetry(() => doFetch(site, {
      method: 'POST',
      headers: { ...BASE_HEADERS, 'accept': '*/*', 'origin': base, 'referer': ref, 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    })));
  }

  return {
    base, baseHost, isValidUrl, assertSiteUrl, sanitizeUrl, resolveUrl, fetchPage, postAjax,
    cacheApi: {
      stats(): { size: number; max: number } {
        const now = Date.now();
        for (const [k, e] of cache) if (now - e.t > TTL) cache.delete(k);
        return { size: cache.size, max: CACHE_MAX };
      },
      purge(): number {
        const n = cache.size;
        cache.clear();
        inflight.clear();
        return n;
      },
    },
  };
}

export { isNonce, sleep };

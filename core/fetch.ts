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

export interface RequestOptions {
  /**
   * Redirect handling: `false`/absent = refuse, `true` = follow (bounded, every
   * hop re-checked against the allowlist), `'manual'` = validate the Location
   * host and return the 3xx response untouched.
   */
  follow?: boolean | 'manual';
  /**
   * Extra hosts a redirect may land on, IN ADDITION to the pinned origin.
   * Must be listed explicitly — never inferred — so a hostile `Location`
   * header cannot reach an unlisted (e.g. private/link-local) host.
   */
  allowHosts?: string[];
}
export interface Site {
  base: string;
  baseHost: string;
  isValidUrl(s: string): boolean;
  assertSiteUrl(u: string): string;
  sanitizeUrl(p: string): string;
  resolveUrl(raw: string, base: string): string;
  fetchPage(url: string): Promise<string>;
  postAjax(url: string, body: string, postUrl?: string, extraHeaders?: Record<string, string>): Promise<string>;
  /**
   * Guarded single request outside the GET cache — for internal/JSON APIs.
   * Applies the same origin rules, limiter, retry/backoff, timeout, redirect
   * bound and size caps as fetchPage, but never caches. `corsSite` widens the
   * origin pin to a second host on the SAME registrable domain (e.g. an API on
   * a sibling subdomain); anything else is rejected.
   */
  request(
    url: string | { path: string; corsSite?: boolean },
    init?: RequestInit & RequestOptions,
  ): Promise<Response>;
  /**
   * Guarded request to an explicitly named PUBLIC third-party host (CDN, embed
   * origin, upload endpoint). Same guards/limiter/timeout/caps as request(),
   * but the host is the URL's own origin instead of the site origin. Private,
   * loopback and link-local targets are rejected; redirects stay on that host.
   */
  requestExternal(url: string, init?: RequestInit): Promise<Response>;
  cacheApi: { stats(): { size: number; max: number }; purge(): number };
}

const BLOCKED_HOST_RE = /^(localhost|127\.|0\.0\.0\.0|\[::|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/** IPv6 literals that must never be fetched: loopback/unspecified, IPv4-mapped, unique-local, link-local. */
const BLOCKED_V6_RE = /^(?:::1?|::ffff:|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return BLOCKED_HOST_RE.test(h) || BLOCKED_V6_RE.test(h) || h === 'localhost';
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
    // base may include a path prefix (e.g. https://api.host/v1) — relative paths
    // must join against base as a directory, and also replace the LAST segment
    // when the path starts with '/' (JS URL semantics), so join against base root
    // unless base has a path (then keep the base path prefix).
    const basePath = new URL(base).pathname.replace(/\/+$/, '');
    const u = basePath && basePath !== ''
      ? new URL(clean.startsWith('/') ? base + clean : clean, base + '/')
      : new URL(clean, base + '/');
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
    let hops = redirects;
    for (;;) {
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
        if (++hops > MAX_REDIRECTS) throw new Error('Too many redirects');
        cur = resolveUrl(loc, cur);
        continue;
      }
      // Any of these may be a Cloudflare interstitial — inspect the body BEFORE
      // deciding to retry, so a challenge is reported instead of retried 4×.
      if (res.status === 429 || res.status === 403 || res.status === 401 || res.status >= 500) {
        const peek = await readCapped(res).catch(() => '');
        if (/attention required|just a moment|cf-challenge|captcha|you have been blocked/i.test(peek)) {
          throw new Error(`WAF blocked (Cloudflare) for ${cur} — filter params trip bot protection; retry with fewer filters`);
        }
        if (res.status === 429 || res.status >= 500) {
          const err = new Error(`HTTP ${res.status} for ${cur}`) as Error & { retryable?: boolean; retryAfter?: number };
          err.retryable = true;
          const ra = res.headers.get('retry-after');
          if (ra) { const n = Number(ra); if (Number.isFinite(n)) err.retryAfter = n * 1000; }
          throw err;
        }
        throw new Error(`HTTP ${res.status} for ${cur}`);
      }
      if (res.status < 200 || res.status >= 300) { await res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status} for ${cur}`); }
      return await readCapped(res);
    }
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

  async function postAjax(url: string, body: string, postUrl?: string, extraHeaders?: Record<string, string>): Promise<string> {
    const site = url.startsWith('/') ? sanitizeUrl(url) : assertSiteUrl(url);
    if (body.length > 8192) throw new Error('POST body too large');
    const ref = postUrl ? (postUrl.startsWith('/') ? sanitizeUrl(postUrl) : assertSiteUrl(postUrl)) : base + '/';
    // JSON body → JSON content-type; otherwise form-encoded (matches legacy axios behavior)
    const isJson = body.trimStart().startsWith('{') || body.trimStart().startsWith('[');
    return limiter.run(() => withRetry(() => doFetch(site, {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        'accept': '*/*',
        'origin': base,
        'referer': ref,
        'x-requested-with': 'XMLHttpRequest',
        ...(isJson
          ? { 'content-type': 'application/json' }
          : { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
        ...extraHeaders,
      },
      body,
    })));
  }

  /** Same registrable domain (last two labels) — used for sibling-subdomain APIs. */
  function sameSiteHost(u: URL): boolean {
    if (u.hostname.toLowerCase() === baseHost) return true;
    const reg = (h: string) => h.split('.').slice(-2).join('.');
    return reg(u.hostname.toLowerCase()) === reg(baseHost);
  }
  async function request(url: string | { path: string; corsSite?: boolean }, init?: RequestInit): Promise<Response> {
    const raw = typeof url === 'string' ? url : url.path;
    const corsSite = typeof url === 'string' ? false : !!url.corsSite;
    let target: URL;
    try {
      target = new URL(raw, base + '/');
    } catch {
      throw new Error('Invalid request URL');
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('Blocked URL scheme');
    if (target.username || target.password) throw new Error('Creds in URL blocked');
    if (isBlockedHost(target.hostname)) throw new Error('Blocked host');
    if (target.hostname.toLowerCase() !== baseHost && !(corsSite && sameSiteHost(target))) {
      throw new Error(`External host rejected: ${target.hostname}`);
    }
    const href = target.toString();
    const follow = !!(init as RequestOptions | undefined)?.follow;
    const extraHosts = ((init as RequestOptions | undefined)?.allowHosts ?? []).map((h) => h.toLowerCase());
    const allowedHost = (h: string) => h === baseHost || (corsSite && sameSiteHost(new URL(`https://${h}/`))) || extraHosts.includes(h);
    // Non-2xx is returned to the caller: these are internal/JSON APIs whose
    // error bodies are part of their contract. Guards + limiter + timeout apply
    // to every hop; redirects are followed manually, never by the platform.
    return limiter.run(async () => {
      let cur = href;
      for (let hop = 0; ; hop++) {
        const ctrl = AbortSignal.timeout(TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(cur, { ...init, redirect: 'manual', signal: ctrl });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('aborted') || msg.toLowerCase().includes('timeout')) throw new Error(`Timeout ${TIMEOUT_MS}ms for ${cur}`);
          throw e;
        }
        if (!(res.status >= 300 && res.status < 400)) return res;
        const loc = res.headers.get('location');
        if (!follow) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`Redirect ${res.status} not allowed for ${cur}`);
        }
        if (!loc) { await res.body?.cancel().catch(() => {}); throw new Error(`Redirect ${res.status} without location`); }
        const next = new URL(loc, cur);
        if (next.protocol !== 'https:' && next.protocol !== 'http:') { await res.body?.cancel().catch(() => {}); throw new Error('Bad redirect scheme'); }
        if (next.username || next.password) { await res.body?.cancel().catch(() => {}); throw new Error('Creds in URL blocked'); }
        if (isBlockedHost(next.hostname)) { await res.body?.cancel().catch(() => {}); throw new Error(`Blocked redirect host: ${next.hostname}`); }
        if (!allowedHost(next.hostname.toLowerCase())) { await res.body?.cancel().catch(() => {}); throw new Error(`Redirect host not allowed: ${next.hostname}`); }
        if (follow === 'manual') return res;
        await res.body?.cancel().catch(() => {});
        if (hop + 1 > MAX_REDIRECTS) throw new Error('Too many redirects');
        cur = next.toString();
      }
    });
  }
  // Child sites for explicitly named public hosts (CDN/embed/upload endpoints).
  const externalSites = new Map<string, Site>();
  async function requestExternal(rawUrl: string, init?: RequestInit): Promise<Response> {
    let u: URL;
    try { u = new URL(rawUrl); } catch { throw new Error('Invalid URL'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Blocked URL scheme');
    if (u.username || u.password) throw new Error('Creds in URL blocked');
    if (isBlockedHost(u.hostname)) throw new Error(`Blocked host: ${u.hostname}`);
    const origin = u.origin;
    let child = externalSites.get(origin);
    if (!child) {
      child = createSite({ base: origin, rateMs: cfg.rateMs, headers: cfg.headers, timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxBytes, maxRedirects: MAX_REDIRECTS });
      externalSites.set(origin, child);
    }
    return child.request(u.toString(), { ...init, follow: true });
  }
  return {
    base, baseHost, isValidUrl, assertSiteUrl, sanitizeUrl, resolveUrl, fetchPage, postAjax, request, requestExternal,
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

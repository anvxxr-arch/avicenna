#!/usr/bin/env bun
/*
 * NontonAnimeID JSON API — thin HTTP layer over ../.. scrapers.
 * Edge-ready: cacheable GETs emit `Cache-Control: public, max-age + s-maxage + stale-while-revalidate`
 * (Cloudflare Cache-Everything honours s-maxage); nonce-derived endpoints
 * (resolve/stream) are always `no-store`.
 *
 *   bun api/nontonanime/server.ts            # :3000
 *   PORT=8080 HOST=127.0.0.1 bun api/nontonanime/server.ts
 *   API_CORS=0          # disable permissive CORS (default: enabled)
 *   API_ADMIN_TOKEN=..  # enables POST /admin/purge (unset = endpoint hidden 404)
 *
 * Every data response carries `x-cache: HIT|MISS|PASS` (PASS = no-store routes).
 */

import {
  getLatestEpisodes, getHomeContent, searchAnime, advancedSearch,
  getList, getAnimeDetail, getEpisodeInfo, getEpisodeStream, getGenres, getGenreAnime,
  getOngoingAnime, getPopularSeries, getSchedule, getRecentEpisodes, getTopAnime,
  getSeasonAnime, getEpisodeServers, resolveServer, getEpisodeNav, getEpisodeMeta,
  loadMoreHome,
} from '../../nontonanime';

declare const process: {
  env: Record<string, string | undefined>;
  on(sig: 'SIGTERM' | 'SIGINT', fn: () => void): void;
  exit(code?: number): void;
};
declare const Bun: {
  serve(opts: {
    hostname: string; port: number;
    fetch(req: Request): Promise<Response>;
  }): { hostname: string; port: number; stop(closeActive?: boolean): void };
};

const PORT = parseInt(process.env.API_PORT || process.env.PORT || '3000') || 3000;
const HOST = process.env.API_HOST || '0.0.0.0';
const CORS = (process.env.API_CORS ?? '1') === '1';
const ADMIN_TOKEN = process.env.API_ADMIN_TOKEN || '';
const STARTED = Date.now();
const GRACE_MS = 5000;

// seconds
const TTL_SHORT = 300;  // fast-moving grids (home/latest/search)
const TTL_LONG = 1800;  // slow-moving (genres, detail)

type CacheState = 'HIT' | 'MISS' | 'PASS';

function headers(cacheable: number | null, xCache: CacheState, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-cache': xCache,
    ...extra,
  };
  if (CORS) h['access-control-allow-origin'] = '*';
  h['cache-control'] = cacheable === null
    ? 'no-store'
    : `public, max-age=${cacheable}, s-maxage=${cacheable * 2}, stale-while-revalidate=${cacheable * 4}`;
  return h;
}

function json(data: unknown, status = 200, cacheable: number | null = TTL_SHORT, xCache: CacheState = 'PASS'): Response {
  return new Response(JSON.stringify(data), { status, headers: headers(cacheable, xCache) });
}

function err(e: unknown): Response {
  const msg = e instanceof Error ? e.message : String(e);
  if (/required|invalid|unknown|too short|must be|year required/i.test(msg)) {
    return json({ error: msg }, 400, null);
  }
  if (/WAF blocked|HTTP (403|429|5\d\d)/i.test(msg)) {
    return json({ error: msg }, 502, null);
  }
  if (/HTTP 404/i.test(msg)) return json({ error: msg }, 502, null);
  return json({ error: msg }, 500, null);
}

const pg = (v: string | null, dflt = 1): number => {
  const n = parseInt(v || String(dflt));
  return Math.min(50, Math.max(1, Number.isFinite(n) ? n : dflt));
};
const need = (v: string | null, msg: string): string => {
  if (!v) throw new Error(msg);
  return v;
};

// === cache introspection + purge (exposed by nontonanime.ts) ===
import { __cacheApi } from '../../nontonanime';

type Handler = (u: URL) => Promise<Response>;
const R: Record<string, Handler> = {
  '/api/nontonanime': async () => json({
    name: 'nontonanime-api',
    uptime_s: Math.floor((Date.now() - STARTED) / 1000),
    routes: Object.keys(R).filter((k) => k !== '/api/nontonanime').sort(),
  }, 200, TTL_LONG),
  '/api/nontonanime/health': async () => json({
    ok: true,
    uptime_s: Math.floor((Date.now() - STARTED) / 1000),
    cache: __cacheApi.stats(),
  }, 200, null),

  '/api/nontonanime/home': async (u) => json(await getHomeContent(pg(u.searchParams.get('page')))),
  '/api/nontonanime/latest': async (u) => json(await getLatestEpisodes(pg(u.searchParams.get('page')))),
  '/api/nontonanime/recent': async (u) => json(await getRecentEpisodes(pg(u.searchParams.get('page')))),
  '/api/nontonanime/list': async (u) => json(await getList(pg(u.searchParams.get('page'))), 200, TTL_LONG),
  '/api/nontonanime/search': async (u) => json(await searchAnime(need(u.searchParams.get('q'), 'Query required (?q=)'))),
  '/api/nontonanime/advsearch': async (u) => {
    const o: Record<string, string> = {};
    for (const k of ['sort', 'status', 'type', 'score_min', 'score_max', 'year_min', 'year_max', 'genre', 'rating', 'mode', 'studio', 'season', 's', 'page']) {
      const v = u.searchParams.get(k);
      if (v) o[k] = v.slice(0, 64);
    }
    // filtered queries vary too much to share an edge entry safely
    const cacheable = Object.keys(o).length > 1 ? 60 : TTL_SHORT;
    return json(await advancedSearch(o), 200, cacheable);
  },

  '/api/nontonanime/anime': async (u) => {
    const d = await getAnimeDetail(need(u.searchParams.get('url'), 'Anime URL required (?url=)'));
    if (!d) return json({ error: 'Anime not found' }, 404, null);
    return json(d, 200, TTL_LONG);
  },
  '/api/nontonanime/episode': async (u) => {
    const d = await getEpisodeInfo(need(u.searchParams.get('url'), 'Episode URL required (?url=)'));
    if (!d) return json({ error: 'Episode not found' }, 404, null);
    return json(d);
  },
  // nonce-derived: never cache at edge
  '/api/nontonanime/stream': async (u) => {
    const raw = parseInt(u.searchParams.get('server') || '1');
    const server = Math.min(20, Math.max(1, Number.isFinite(raw) ? raw : 1));
    return json(await getEpisodeStream(need(u.searchParams.get('url'), 'Episode URL required (?url=)'), server), 200, null);
  },
  '/api/nontonanime/resolve': async (u) => json(
    await resolveServer(need(u.searchParams.get('url'), 'Episode URL required (?url=)'), u.searchParams.get('server') || 1),
    200, null,
  ),
  '/api/nontonanime/servers': async (u) => json(await getEpisodeServers(need(u.searchParams.get('url'), 'Episode URL required (?url=)'))),
  '/api/nontonanime/nav': async (u) => json(await getEpisodeNav(need(u.searchParams.get('url'), 'Episode URL required (?url=)'))),
  '/api/nontonanime/meta': async (u) => json(await getEpisodeMeta(need(u.searchParams.get('url'), 'Episode URL required (?url=)')), 200, TTL_LONG),

  '/api/nontonanime/genres': async (u) => json(await getGenres(u.searchParams.get('sort') || undefined), 200, TTL_LONG),
  '/api/nontonanime/genre': async (u) => json(await getGenreAnime(
    need(u.searchParams.get('slug'), 'Genre slug required (?slug=)'), pg(u.searchParams.get('page')),
  )),
  '/api/nontonanime/ongoing': async (u) => json(await getOngoingAnime(u.searchParams.get('sort') || undefined)),
  '/api/nontonanime/popular': async () => json(await getPopularSeries(), 200, TTL_LONG),
  '/api/nontonanime/schedule': async () => json(await getSchedule()),
  '/api/nontonanime/top': async () => json(await getTopAnime(), 200, TTL_LONG),
  '/api/nontonanime/season': async (u) => {
    const season = need(u.searchParams.get('season'), 'Season required (?season=winter&year=2024)');
    const yearRaw = need(u.searchParams.get('year'), 'Year required (?season=winter&year=2024)');
    return json(await getSeasonAnime(season, parseInt(yearRaw), pg(u.searchParams.get('page'))), 200, TTL_LONG);
  },
  '/api/nontonanime/more': async (u) => {
    const ids = (u.searchParams.get('ids') || '').split(',').map(Number).filter(Number.isFinite);
    const offset = parseInt(u.searchParams.get('offset') || '0') || 0;
    return json(await loadMoreHome(ids, offset));
  },
};

/** Constant-time string compare (timing-safe token check). */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    if (CORS && req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-max-age': '86400',
        },
      });
    }
    const u = new URL(req.url);

    // admin purge — hidden entirely when token unset
    if (u.pathname === '/api/nontonanime/admin/purge') {
      if (!ADMIN_TOKEN) return json({ error: 'Not found', routes: '/api/nontonanime' }, 404, null);
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405, null);
      const auth = req.headers.get('authorization') || '';
      const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : u.searchParams.get('token') || '';
      if (!supplied || !timingSafeEq(supplied, ADMIN_TOKEN)) {
        return json({ error: 'Unauthorized' }, 401, null);
      }
      const evicted = __cacheApi.purge();
      return json({ purged: evicted }, 200, null);
    }

    if (req.method !== 'GET') return json({ error: 'GET only' }, 405, null);
    const h = R[u.pathname];
    if (!h) return json({ error: 'Not found', routes: '/api/nontonanime' }, 404, null);
    const t0 = Date.now();
    try {
      const res = await h(u);
      console.log(`[api] ${req.method} ${u.pathname}${u.search} -> ${res.status} ${Date.now() - t0}ms`);
      return res;
    } catch (e) {
      console.log(`[api] ${req.method} ${u.pathname}${u.search} -> ERR ${Date.now() - t0}ms`);
      return err(e);
    }
  },
});

// graceful shutdown: stop accepting, give in-flight 5s, then hard exit
let shuttingDown = false;
function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] ${sig} — draining (grace ${GRACE_MS}ms)...`);
  server.stop(false); // stop accepting; keep active connections
  setTimeout(() => {
    console.log('[api] bye');
    process.exit(0);
  }, GRACE_MS);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log(`[nontonanime-api] http://${server.hostname}:${server.port}/api/nontonanime`);

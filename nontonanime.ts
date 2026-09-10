#!/usr/bin/env bun
/*
- base : https://s13.nontonanimeid.boats
- creator : phrzy
- hardened & optimized by Fox v2 (transport: core/fetch.ts, parse: core/parse.ts — spec 003)
*/

import type { Cheerio, CheerioAPI, AnyNode } from './core/parse';
import {
  safeCheerio, txt, num, firstText, img as imgOf, href as hrefOf, isNonce,
  sliceBalanced, extractPageVar, extractEmbedUrl, extractEpisodeFromUrl, extractPostId,
} from './core/parse';
import { createSite } from './core/fetch';

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };

// === CONFIG (site instance on shared core) ===
const BASE = (process.env.ANIME_BASE || 'https://s13.nontonanimeid.boats').replace(/\/+$/, '');

const site = createSite({
  base: BASE,
  headers: {
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'referer': BASE + '/',
    'dnt': '1',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  },
});
const { fetchPage, postAjax, isValidUrl, sanitizeUrl, assertSiteUrl } = site;

// local aliases (parse helpers keep their nontonanime names at usage sites)
const img = imgOf;
const href = hrefOf;
const ADMIN_AJAX = BASE + '/wp-admin/admin-ajax.php';

// === TYPES ===
interface Episode { title: string; episode: string; url: string; thumbnail: string; }
interface AnimeCard { title: string; url: string; thumbnail: string; rating?: string; type?: string; season?: string; score?: string; synopsis?: string; genres?: string[]; }
interface StreamResult { title: string; postId: string; streams: Array<{ server: string; embedUrl: string; rawHtml: string }>; downloads: Array<{ format: string; links: Array<{ label: string; url: string }> }>; }
interface SearchResult extends AnimeCard { type?: string; season?: string; }
interface Genre { name: string; url: string; total: number; ongoing: number; }
interface AnimeDetail {
  title: string; titleEn: string; titleJp: string; score: string; type: string; synopsis: string;
  genres: string[]; studios: string; rating: string; popularity: string; members: string;
  aired: string; status: string; totalEpisodes: string; duration: string; season: string;
  poster: string; trailer: string;
  episodes: Array<{ title: string; date: string; url: string }>;
  firstEpisode: string; lastEpisode: string; recommended: AnimeCard[];
}
interface ScheduleSlot { title: string; url: string; episode: string; time?: string; rating?: string; members?: string; type?: string; status?: string; genres?: string[]; }
interface ScheduleEntry { day: string; dateText: string; entries: ScheduleSlot[]; }
interface TopAnime { title: string; url: string; thumbnail: string; score: string; }
interface SeasonResult { title: string; url: string; thumbnail: string; score: string; genre: string; }
interface AdvancedSearchOpts {
  sort?: string; status?: string; type?: string; score_min?: string; score_max?: string;
  year_min?: string; year_max?: string; genre?: string; rating?: string; mode?: string;
  studio?: string; season?: string; s?: string; page?: string;
}

// === SCRAPERS ===
type PickFn = ($el: Cheerio<AnyNode>) => AnimeCard | null;
function parseCards($: CheerioAPI, sel: string, pick: PickFn): AnimeCard[] {
  const out: AnimeCard[] = [];
  $(sel).each((_, el) => {
    const c = pick($(el));
    if (c && c.title && c.url) out.push(c);
  });
  return out;
}
/** Homepage / loadmore article grid → episodes (single shared parser). */
function parseArticleGrid($: CheerioAPI): Episode[] {
  return parseCards($, 'article.animeseries', ($el) => {
    const url = href($el);
    if (!url) return null;
    const title = txt($el.find('.title span').attr('data-title-default') || $el.find('.title').text(), 200);
    if (!title) return null;
    return { title, url, thumbnail: img($el), rating: num($el.find('.episodes').text()) };
  }).map((c) => ({ title: c.title, episode: c.rating || '', url: c.url, thumbnail: c.thumbnail }));
}
async function getLatestEpisodes(page = 1): Promise<Episode[]> {
  page = clampPage(page);
  const html = await fetchPage(page === 1 ? BASE + '/' : `${BASE}/page/${page}/`);
  return parseArticleGrid(safeCheerio(html));
}

async function getHomeContent(page = 1): Promise<{ latestEpisodes: Episode[]; series: Record<string, AnimeCard[]> }> {
  page = clampPage(page);
  const html = await fetchPage(page === 1 ? BASE + '/' : `${BASE}/page/${page}/`);
  const $ = safeCheerio(html);
  const latestEpisodes = parseArticleGrid($);

  // homepage has a single grid + a popseries rail (old .section categories are gone)
  const series: Record<string, AnimeCard[]> = {};
  const pop: AnimeCard[] = [];
  $('a.popseries').each((_, el) => {
    const $el = $(el);
    const url = $el.attr('href') || '';
    if (!url) return;
    const $img = $el.find('img').first();
    const title = txt($img.attr('alt') || '', 200);
    if (!title) return;
    pop.push({ title, url, thumbnail: $img.attr('src') || '' });
  });
  if (pop.length) series['Populer'] = pop;
  return { latestEpisodes, series };
}

async function searchAnime(query: string): Promise<SearchResult[]> {
  const q = cleanQuery(query);
  const html = await fetchPage(`${BASE}/?s=${encodeURIComponent(q)}`);
  return parseAsCards(safeCheerio(html));
}

/** Shared parser for the as-anime-card grid (search, /anime/, /genres/x/, /premiereds/x/, related). */
function parseAsCards($: CheerioAPI, sel = '.as-anime-card'): SearchResult[] {
  return parseCards($, sel, ($el) => {
    const url = ($el.is('a') ? $el.attr('href') : '') || href($el) || '';
    if (!url) return null;
    const $t = $el.find('.as-anime-title').first();
    const title = txt($t.attr('data-title-default') || $t.text(), 200);
    if (!title) return null;
    const genres: string[] = [];
    $el.find('.as-genres span, .jr-genre-pill').each((_, g) => {
      const x = txt($(g).text(), 40);
      if (x) genres.push(x);
    });
    const card: SearchResult = {
      title, url, thumbnail: img($el),
      rating: num($el.find('.as-rating').first().text()) || undefined,
      type: txt($el.find('.as-type').first().text().replace(/^[^\w]+/, ''), 20) || undefined,
      season: txt($el.find('.as-season').first().text().replace(/📅\s*/g, ''), 30) || undefined,
      synopsis: txt($el.find('.as-synopsis').first().text(), 300) || undefined,
    };
    if (genres.length) card.genres = genres;
    return card;
  });
}

const ADV_KEYS = ['sort', 'status', 'type', 'score_min', 'score_max', 'year_min', 'year_max', 'genre', 'rating', 'mode', 'studio', 'season', 's'] as const;

/** Advanced search = GET /anime/ filter grid (supports page via opts.page). */
async function advancedSearch(opts: AdvancedSearchOpts = {}): Promise<SearchResult[]> {
  const params = new URLSearchParams();
  for (const k of ADV_KEYS) {
    const v = opts[k];
    if (v !== undefined && v !== '') params.set(k, String(v).slice(0, 64));
  }
  const page = opts.page ? clampPage(parseInt(opts.page) || 1) : 1;
  const qs = params.toString();
  const base = page === 1 ? `${BASE}/anime/` : `${BASE}/anime/page/${page}/`;
  try {
    const html = await fetchPage(qs ? `${base}?${qs}` : base);
    return parseAsCards(safeCheerio(html));
  } catch (e) {
    // WAF gates genre/type filters — fall back to the genre archive + client-side filter
    if (!opts.genre || !(e instanceof Error) || !/WAF blocked|HTTP (403|500)/.test(e.message)) throw e;
    return await genreFallback(opts);
  }
}

/** Genre archive crawl (max 3 pages) + client-side score/type filter + sort. */
async function genreFallback(opts: AdvancedSearchOpts): Promise<SearchResult[]> {
  const slug = cleanSlug(String(opts.genre));
  const out: SearchResult[] = [];
  for (let p = 1; p <= 3; p++) {
    const html = await fetchPage(p === 1 ? `${BASE}/genres/${slug}/` : `${BASE}/genres/${slug}/page/${p}/`);
    const cards = parseAsCards(safeCheerio(html));
    if (!cards.length) break;
    out.push(...cards);
    if (cards.length < 20) break; // last page
  }
  const min = opts.score_min ? parseFloat(opts.score_min) : NaN;
  const max = opts.score_max ? parseFloat(opts.score_max) : NaN;
  const type = opts.type?.toLowerCase();
  const res = out.filter((c) => {
    const r = parseFloat(c.rating || '');
    if (!Number.isNaN(min) && (Number.isNaN(r) || r < min)) return false;
    if (!Number.isNaN(max) && (Number.isNaN(r) || r > max)) return false;
    if (type && (c.type || '').toLowerCase() !== type) return false;
    return true;
  });
  if (opts.sort === 'series_skor') res.sort((a, b) => (parseFloat(b.rating || '') || 0) - (parseFloat(a.rating || '') || 0));
  else if (opts.sort === 'series_title') res.sort((a, b) => a.title.localeCompare(b.title));
  return res;
}

async function getList(page = 1): Promise<AnimeCard[]> {
  page = clampPage(page);
  const html = await fetchPage(page === 1 ? BASE + '/anime/' : `${BASE}/anime/page/${page}/`);
  return parseAsCards(safeCheerio(html));
}

async function getAnimeDetail(url: string): Promise<AnimeDetail | null> {
  const html = await fetchPage(assertSiteUrl(url));
  const $ = safeCheerio(html);
  const title = txt($('h1.entry-title span[data-title-default]').attr('data-title-default')
    || $('h1.entry-title').text().replace(/^Nonton\s+|\s+Sub Indo$/g, '').trim()
    || $('meta[property="og:title"]').attr('content'), 300);
  if (!title) return null;

  // details-list: label → value, single pass
  const meta = new Map<string, string>();
  $('ul.details-list li').each((_, el) => {
    const $el = $(el);
    const label = txt($el.find('.detail-label').first().text().replace(/:$/, ''), 40);
    if (!label) return;
    const clone = $el.clone();
    clone.find('.detail-label').remove();
    const value = txt(clone.text(), 300);
    if (value && value !== '-' && !meta.has(label)) meta.set(label, value);
  });
  const getMeta = (label: string): string => {
    const hit = meta.get(label);
    if (hit) return hit;
    for (const [k, v] of meta) if (k.toLowerCase().includes(label.toLowerCase())) return v;
    return '';
  };

  const quick: string[] = [];
  $('.anime-card__quick-info .info-item').each((_, el) => { quick.push(txt($(el).text(), 60)); });
  const findQuick = (re: RegExp): string => quick.find((q) => re.test(q)) || '';

  const genres: string[] = [];
  $('a.genre-tag').each((_, el) => { const g = txt($(el).text(), 40); if (g) genres.push(g); });

  const episodes: AnimeDetail['episodes'] = [];
  $('.episode-list-items a.episode-item').each((_, el) => {
    const $el = $(el);
    const u = $el.attr('href') || $el.attr('data-episode-url') || '';
    if (!u) return;
    episodes.push({
      title: txt($el.find('.ep-title').text(), 200),
      date: txt($el.find('.ep-date').text(), 40),
      url: u,
    });
  });

  const recommended = parseAsCards($, '.related .as-anime-card');

  return {
    title,
    titleEn: getMeta('English'),
    titleJp: getMeta('Japanese') || getMeta('Synonyms'),
    score: txt($('.anime-card__score .value').first().text(), 10),
    type: txt($('.anime-card__score .type').first().text(), 20),
    synopsis: txt($('.synopsis-prose p').first().text(), 2000) || txt($('meta[name="description"]').attr('content'), 2000),
    genres,
    studios: getMeta('Studio'),
    rating: getMeta('Rating'),
    popularity: getMeta('Popularity'),
    members: getMeta('Member'),
    aired: getMeta('Aired'),
    status: txt($('.status-airing').first().text(), 30),
    totalEpisodes: findQuick(/episode/i),
    duration: findQuick(/min/i),
    season: txt($('.info-item.season').first().text(), 30),
    poster: $('.anime-card__sidebar img').first().attr('src') || $('meta[property="og:image"]').attr('content') || '',
    trailer: $('a.trailerbutton').first().attr('href') || '',
    episodes,
    firstEpisode: $('.meta-episode-item.first a').attr('href') || episodes[episodes.length - 1]?.url || '',
    lastEpisode: $('.meta-episode-item.last a').attr('href') || episodes[0]?.url || '',
    recommended,
  };
}

interface ServerTab { n: number; name: string; postId: string; active: boolean; }
interface ServersResult { postId: string; servers: ServerTab[]; defaultEmbed: string; nonce: string; }
interface EpisodeNav { prev: string; all: string; next: string; episodeNumber: string; }
interface EpisodeMeta { episodeNumber: string; seriesTitle: string; seriesUrl: string; poster: string; genres: string[]; }

async function getEpisodeInfo(url: string): Promise<StreamResult | null> {
  const site = assertSiteUrl(url);
  const html = await fetchPage(site);
  const $ = safeCheerio(html);
  const title = firstText($, ['h1.entry-title', 'h2.name'])
    || txt($('meta[property="og:title"]').attr('content'), 300);
  if (!title) return null;

  // streams come straight from the tab parse (single fetch, cached)
  let servers: ServerTab[] = [];
  let postId = extractPostId(url);
  let defEmbed = '';
  try {
    const res = await getEpisodeServers(site);
    servers = res.servers; postId = res.postId || postId; defEmbed = res.defaultEmbed;
  } catch { /* fall through to legacy iframe parse */ }
  const streams: StreamResult['streams'] = servers.length
    ? servers.map((s) => ({
      server: s.name,
      embedUrl: s.active ? defEmbed : '',
      rawHtml: `<span>S-${s.name}</span>`,
    }))
    : (() => {
      const src = $('#videoku iframe, .player_embed iframe').first();
      const u = src.attr('data-src') || src.attr('src') || '';
      return u ? [{ server: 'default', embedUrl: u, rawHtml: '' }] : [];
    })();

  const downloads: StreamResult['downloads'] = [];
  $('.listlink').each((_, el) => {
    const $el = $(el);
    const format = txt($el.find('span').first().text(), 30) || 'Download';
    const links: Array<{ label: string; url: string }> = [];
    $el.find('a').each((_, aEl) => {
      const $a = $(aEl);
      const label = txt($a.text(), 40);
      const hrefv = $a.attr('href') || '';
      if (label && hrefv && isValidUrl(hrefv)) links.push({ label, url: hrefv });
    });
    if (links.length) downloads.push({ format, links });
  });
  // legacy fallback
  if (!downloads.length) {
    $('div dl.download > dd').each((_, ddEl) => {
      const $dd = $(ddEl);
      const links: Array<{ label: string; url: string }> = [];
      $dd.find('a').each((_, aEl) => {
        const $a = $(aEl);
        const label = txt($a.text(), 40);
        const hrefv = $a.attr('href') || '';
        if (label && hrefv && isValidUrl(hrefv)) links.push({ label, url: hrefv });
      });
      if (links.length) downloads.push({ format: txt($dd.prev('dt').text(), 30) || 'Download', links });
    });
  }

  return { title, postId, streams, downloads };
}

/** List all video servers for an episode (parsed from player tabs — no extra requests). */
async function getEpisodeServers(url: string): Promise<ServersResult> {
  const site = assertSiteUrl(url);
  const html = await fetchPage(site);
  const $ = safeCheerio(html);
  const servers: ServerTab[] = [];
  let postId = '';
  $('li.serverplayer').each((_, el) => {
    const $el = $(el);
    const name = txt($el.attr('data-type') || '', 40);
    if (!name) return;
    postId = $el.attr('data-post') || postId;
    servers.push({
      n: parseInt($el.attr('data-nume') || '0') || servers.length + 1,
      name, postId: $el.attr('data-post') || '',
      active: $el.hasClass('on'),
    });
  });
  if (!servers.length) throw new Error('No servers found (page layout changed?)');
  servers.sort((a, b) => a.n - b.n);
  const $frame = $('#videoku iframe, .player_embed iframe').first();
  const nonce = String(extractPageVar(html, 'kotakajax')?.nonce || '');
  return { postId, servers, defaultEmbed: $frame.attr('data-src') || $frame.attr('src') || '', nonce };
}

/** Pick a server tab by 1-based number or (fuzzy) name. */
function pickServer(servers: ServerTab[], sel: string | number): ServerTab {
  if (typeof sel === 'number' || /^\d+$/.test(String(sel))) {
    const n = clampInt(parseInt(String(sel)), 1, servers.length);
    return servers.find((s) => s.n === n) || servers[n - 1];
  }
  const want = String(sel).toLowerCase();
  const tab = servers.find((s) => s.name.toLowerCase() === want)
    || servers.find((s) => s.name.toLowerCase().includes(want));
  if (!tab) throw new Error(`Unknown server "${sel}" (use servers command to list)`);
  return tab;
}

/** Resolve a server tab to its real embed URL via player_ajax. sel = 1-based number or server name. */
async function resolveServer(url: string, sel: string | number = 1): Promise<string> {
  const site = assertSiteUrl(url);
  const { postId, servers, nonce } = await getEpisodeServers(site);
  const tab = pickServer(servers, sel);
  if (!isNonce(nonce)) throw new Error('player_ajax nonce not found');
  const body = new URLSearchParams({
    action: 'player_ajax', post: tab.postId || postId,
    nume: String(tab.n), serverName: tab.name, nonce,
  }).toString();
  const resHtml = await postAjax(ADMIN_AJAX, body, site);
  if (!resHtml || resHtml.trim() === '0') throw new Error('Server returned empty embed (expired nonce?)');
  const embed = extractEmbedUrl(resHtml);
  if (!embed || !isValidUrl(embed)) throw new Error('No embed URL in server response');
  return embed;
}

async function getEpisodeStream(url: string, serverNumber = 1): Promise<string | null> {
  try {
    return await resolveServer(url, clampInt(serverNumber, 1, 20));
  } catch {
    // fallback: default iframe without AJAX
    const html = await fetchPage(assertSiteUrl(url));
    const $ = safeCheerio(html);
    const $frame = $('#videoku iframe, .player_embed iframe').first();
    return $frame.attr('data-src') || $frame.attr('src') || null;
  }
}

/** Prev / All-episodes / Next links + episode number (JSON-LD backed). */
async function getEpisodeNav(url: string): Promise<EpisodeNav> {
  const site = assertSiteUrl(url);
  const html = await fetchPage(site);
  const $ = safeCheerio(html);
  const nav = $('#navigation-episode');
  const links = nav.find('a');
  let prev = '', all = '', next = '';
  links.each((_, el) => {
    const $a = $(el);
    const t = ($a.text() + ' ' + ($a.attr('title') || '')).toLowerCase();
    const hrefv = $a.attr('href') || '';
    if (!hrefv) return;
    if (t.includes('prev')) prev = hrefv;
    else if (t.includes('next')) next = hrefv;
    else if (hrefv.includes('/anime/')) all = hrefv;
    else if (!all) all = hrefv;
  });
  let episodeNumber = extractEpisodeFromUrl(site);
  const m = html.match(/"episodeNumber"\s*:\s*"(\d+)"/) || html.match(/"episodeNumber"\s*:\s*(\d+)/);
  if (m) episodeNumber = m[1];
  return { prev, all, next, episodeNumber };
}

/** Episode meta from JSON-LD + tracker beacon (no extra requests). */
async function getEpisodeMeta(url: string): Promise<EpisodeMeta> {
  const site = assertSiteUrl(url);
  const html = await fetchPage(site);
  const trace = extractPageVar(html, 'episodeToTrace', 'episodeToTrack');
  const numM = html.match(/"episodeNumber"\s*:\s*"?(\d+)"?/);
  const seriesM = html.match(/"partOfSeries"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"url"\s*:\s*"([^"]+)"/);
  return {
    episodeNumber: String(trace?.episodeNumber || (numM ? numM[1] : '') || extractEpisodeFromUrl(site)),
    seriesTitle: String(trace?.seriesTitle || (seriesM ? seriesM[1] : '')),
    seriesUrl: String(trace?.seriesUrl || (seriesM ? seriesM[2] : '')),
    poster: String(trace?.poster || ''),
    genres: Array.isArray(trace?.genres) ? (trace.genres as string[]).slice(0, 20) : [],
  };
}

/** Homepage infinite-scroll (action=loadmore). ids = post-IDs already shown. */
async function loadMoreHome(displayedIds: number[] = [], offset = 0): Promise<Episode[]> {
  const home = await fetchPage(BASE + '/');
  const vars = extractPageVar(home, 'misha_loadmore_params');
  const nonce = vars?.nonce;
  if (!isNonce(nonce)) throw new Error('loadmore nonce not found');
  const p = new URLSearchParams({ action: 'loadmore', nonce, offset: String(clampInt(offset, 0, 100000)) });
  const ids = displayedIds.filter((n) => Number.isFinite(n)).slice(0, 200);
  for (const id of ids) p.append('displayed_posts[]', String(Math.floor(id)));
  const resHtml = await postAjax(ADMIN_AJAX, p.toString(), BASE + '/');
  if (!resHtml || resHtml.trim() === '0' || !resHtml.trim()) return [];
  return parseArticleGrid(safeCheerio(resHtml));
}

const GENRE_SORTS = new Set(['az', 'popular', 'ongoing']);

async function getGenres(sort?: string): Promise<Genre[]> {
  let url = BASE + '/genres/';
  if (sort) {
    const s = sort.toLowerCase().trim();
    if (!GENRE_SORTS.has(s)) throw new Error('Sort must be az|popular|ongoing');
    url += `?sort=${s}&mode=sort`;
  }
  const html = await fetchPage(url);
  const $ = safeCheerio(html);
  const out: Genre[] = [];
  $('a.genre-grid-card').each((_, el) => {
    const $el = $(el);
    const name = txt($el.find('.genre-name').text(), 60);
    const hrefv = $el.attr('href') || '';
    if (!name || !hrefv) return;
    out.push({
      name, url: hrefv,
      total: parseInt(($el.find('.detail-item.count').text().match(/[\d,]+/) || ['0'])[0].replace(/,/g, '')) || 0,
      ongoing: parseInt(($el.find('.detail-item.ongoing').text().match(/[\d,]+/) || ['0'])[0].replace(/,/g, '')) || 0,
    });
  });
  return out;
}

async function getGenreAnime(genreSlug: string, page = 1): Promise<AnimeCard[]> {
  const slug = cleanSlug(genreSlug);
  page = clampPage(page);
  const html = await fetchPage(page === 1 ? `${BASE}/genres/${slug}/` : `${BASE}/genres/${slug}/page/${page}/`);
  return parseAsCards(safeCheerio(html));
}

async function getOngoingAnime(sort?: string): Promise<Array<{ title: string; url: string; currentEpisode: string; totalEpisode: string; score: string; rarity: number }>> {
  let url = BASE + '/ongoing-list/';
  if (sort) {
    if (!/^[a-z0-9_]+$/i.test(sort)) throw new Error('Invalid sort value');
    url += `?sort=${sort.toLowerCase().trim().slice(0, 32)}&mode=sort`;
  }
  const html = await fetchPage(url);
  const $ = safeCheerio(html);
  const out: Array<{ title: string; url: string; currentEpisode: string; totalEpisode: string; score: string; rarity: number }> = [];
  $('a.gacha-card').each((_, el) => {
    const $el = $(el);
    const link = $el.attr('href') || '';
    if (!link) return;
    const title = txt($el.find('h3.title').text(), 200);
    if (!title) return;
    const cls = $el.attr('class') || '';
    const rm = cls.match(/rarity-(\d)/);
    out.push({
      title, url: link,
      currentEpisode: txt($el.find('.current-ep').text(), 20),
      totalEpisode: txt($el.find('.total-ep').text(), 20),
      score: txt($el.find('.skor-angka').text().replace(/[()]/g, ''), 10),
      rarity: rm ? clampInt(parseInt(rm[1]), 1, 5) : 3,
    });
  });
  return out;
}

async function getPopularSeries(): Promise<SeasonResult[]> {
  const html = await fetchPage(BASE + '/popular-series/');
  const $ = safeCheerio(html);
  const labelById = new Map<string, string>();
  $('.tabs li').each((_, li) => {
    const $li = $(li);
    const id = $li.attr('data-tab') || '';
    const label = txt($li.text(), 40);
    if (id && label) labelById.set(id, label);
  });
  const out: SeasonResult[] = [];
  $('.tab-content').each((_, tabEl) => {
    const $tab = $(tabEl);
    const genre = labelById.get($tab.attr('id') || '') || $tab.attr('id') || '';
    $tab.find('.animeseries').each((_, el) => {
      const $el = $(el);
      const url = href($el);
      if (!url) return;
      const title = txt($el.find('.title span').text(), 200);
      if (!title) return;
      out.push({ title, url, thumbnail: img($el), score: num($el.find('.kotakscore').text()), genre });
    });
  });
  return out;
}

async function getSchedule(): Promise<ScheduleEntry[]> {
  const html = await fetchPage(BASE + '/jadwal-rilis/');
  const $ = safeCheerio(html);
  const out: ScheduleEntry[] = [];
  $('.as-tab-content').each((_, dayEl) => {
    const $day = $(dayEl);
    const day = txt(($day.attr('id') || ''), 20);
    const dateText = txt($day.attr('data-date-text') || '', 40);
    if (!day) return;
    const entries: ScheduleEntry['entries'] = [];
    $day.find('.as-anime-card').each((_, el) => {
      const $el = $(el);
      const link = ($el.is('a') ? $el.attr('href') : '') || '';
      if (!link) return;
      const title = txt($el.find('.as-anime-title').first().text(), 200);
      if (!title) return;
      const genres: string[] = [];
      $el.find('.jr-genre-pill').each((_, g) => { const x = txt($(g).text(), 40); if (x) genres.push(x); });
      const slot: ScheduleSlot = {
        title, url: link,
        episode: txt($el.find('.jr-ep-text').text(), 30),
        time: txt($el.find('.time-text').text(), 20) || undefined,
        rating: num($el.find('.rating-text').text()) || undefined,
        members: txt($el.find('.members-text').text(), 20) || undefined,
        type: txt($el.find('.jr-type-badge').text(), 20) || undefined,
        status: $el.attr('data-status') || undefined,
      };
      if (genres.length) slot.genres = genres;
      entries.push(slot);
    });
    if (entries.length) out.push({ day, dateText, entries });
  });
  return out;
}

/** /recent/ is gone (404) — homepage grid is the live equivalent. */
async function getRecentEpisodes(page = 1): Promise<Episode[]> {
  return getLatestEpisodes(page);
}

/** /top/ is gone (404) — popular-series per-genre tabs are the live equivalent. */
async function getTopAnime(_page = 1): Promise<TopAnime[]> {
  const all = await getPopularSeries();
  const seen = new Map<string, TopAnime>();
  for (const a of all) {
    if (!seen.has(a.url)) seen.set(a.url, { title: a.title, url: a.url, thumbnail: a.thumbnail, score: a.score });
  }
  return [...seen.values()].sort((a, b) => (parseFloat(b.score) || 0) - (parseFloat(a.score) || 0));
}

const SEASONS = new Set(['spring', 'summer', 'fall', 'autumn', 'winter']);

async function getSeasonAnime(season: string, year?: number, page = 1): Promise<SeasonResult[]> {
  const s = season.toLowerCase().trim();
  if (!SEASONS.has(s)) throw new Error('Season must be spring/summer/fall/winter');
  if (year === undefined) throw new Error('Year required (e.g. season winter 2024)');
  const y = clampInt(year, 1990, 2100);
  page = clampPage(page);
  const base = `${BASE}/premiereds/${s}-${y}/`;
  const html = await fetchPage(page === 1 ? base : `${base}page/${page}/`);
  const $ = safeCheerio(html);
  return parseAsCards($).map((c) => ({
    title: c.title, url: c.url, thumbnail: c.thumbnail,
    score: c.rating || '', genre: (c.genres || []).join(', '),
  }));
}

// === INPUT SANITIZERS ===
function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
function clampPage(p: number): number { return clampInt(p, 1, 50); }
function cleanSlug(s: string): string {
  if (!s || typeof s !== 'string') throw new Error('Slug required');
  const c = s.trim().toLowerCase().slice(0, 80);
  if (!/^[a-z0-9-]+$/.test(c)) throw new Error('Invalid slug (a-z 0-9 - only)');
  return c;
}
function cleanQuery(q: string): string {
  if (!q || typeof q !== 'string') throw new Error('Query required');
  const c = q.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (c.length < 2) throw new Error('Query too short');
  return c;
}

// === CLI ===
function printUsage(): void {
  console.log(`
NontonAnimeID Scraper - Hardened & Optimized v2
===============================================
Usage:
  bun nontonanime.ts home [page]                            Homepage lengkap
  bun nontonanime.ts latest [page]                          Episode terbaru
  bun nontonanime.ts search <query>                         Cari anime
  bun nontonanime.ts advsearch [opts]                       Advanced search
  bun nontonanime.ts list [page]                            Daftar anime
  bun nontonanime.ts anime <url>                            Detail anime + episode list
  bun nontonanime.ts episode <url>                          Info episode + server + download
  bun nontonanime.ts stream <url>                           Streaming semua server (1-8)
  bun nontonanime.ts stream <url> <server-num>              Streaming server tertentu
  bun nontonanime.ts genres [az|popular|ongoing]              Daftar semua genre
  bun nontonanime.ts genre <slug> [page]                    Anime berdasarkan genre
  bun nontonanime.ts ongoing [sort]                         Anime ongoing/tayang
  bun nontonanime.ts popular                                Anime populer per genre
  bun nontonanime.ts schedule                               Jadwal rilis (7 hari + jam tayang)
  bun nontonanime.ts recent [page]                          = latest (alias, /recent/ retired)
  bun nontonanime.ts top                                    Top rating (dari popular)
  bun nontonanime.ts season <season> <year> [page]          Anime per season (premiereds)
  bun nontonanime.ts servers <url>                          List 8 video servers (tabs)
  bun nontonanime.ts resolve <url> [n|name]                 Resolve server → real embed URL (player_ajax)
  bun nontonanime.ts nav <url>                              Prev / all / next + episode number
  bun nontonanime.ts meta <url>                             Series title/url, poster, genres (JSON-LD)
  bun nontonanime.ts more --offset=N [ids..]                Homepage infinite-scroll (loadmore AJAX)

Advanced Search Options:
  --sort=series_skor|series_popularity|series_tahun_newest|series_tahun_oldest|series_title
  --status=Currently Airing|Finished Airing
  --type=TV|Movie|OVA|ONA|Special|CM|Music|PV|TV Special
  --score_min=<n> --score_max=<n>
  --year_min=<n> --year_max=<n>
  --genre=<genre-slug> --rating=G|PG|PG-13|R|Rx
  --mode=<query> --studio=<slug> --season=<slug> --s=<keyword> --page=<n>
  NOTE: Cloudflare WAF blocks some filter combos (genre/type) — sort-only
  queries always work; dedicated genre pages (genre <slug>) are the workaround.

Examples:
  bun nontonanime.ts search "one piece"
  bun nontonanime.ts anime "https://s13.nontonanimeid.boats/anime/one-piece/"
  bun nontonanime.ts episode "https://s13.nontonanimeid.boats/episode/one-piece-episode-1000/"
  bun nontonanime.ts advsearch --genre=action --sort=series_skor
  bun nontonanime.ts season winter 2024
`);
}

function parseArgs(): { cmd: string; pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) flags[arg.slice(2)] = '';
      else flags[arg.slice(2, eq)] = arg.slice(eq + 1).slice(0, 200);
    } else pos.push(arg);
  }
  return { cmd: pos[0] || '', pos, flags };
}

function out(v: unknown): void { console.log(JSON.stringify(v, null, 2)); }

function need(v: string | undefined, msg: string): string {
  if (!v) throw new Error(msg);
  return v;
}
const pg = (v: string | undefined): number => clampPage(parseInt(v || '1'));

/** Command dispatch table (replaces the switch behemoth). Each handler gets (pos, flags). */
const COMMANDS: Record<string, (pos: string[], flags: Record<string, string>) => Promise<unknown>> = {
  home: (p) => getHomeContent(pg(p[1])),
  latest: (p) => getLatestEpisodes(pg(p[1])),
  recent: (p) => getRecentEpisodes(pg(p[1])),
  search: (p) => searchAnime(cleanQuery(p[1] || '')),
  advsearch: (_p, f) => advancedSearch(f as AdvancedSearchOpts),
  list: (p) => getList(pg(p[1])),
  anime: (p) => getAnimeDetail(need(p[1], 'Anime URL required')),
  episode: (p) => getEpisodeInfo(need(p[1], 'Episode URL required')),
  stream: (p) => getEpisodeStream(need(p[1], 'Episode URL required'), clampInt(parseInt(p[2] || '1'), 1, 20)),
  servers: (p) => getEpisodeServers(need(p[1], 'Episode URL required')),
  resolve: (p) => resolveServer(need(p[1], 'Episode URL required'), p[2] || 1),
  nav: (p) => getEpisodeNav(need(p[1], 'Episode URL required')),
  meta: (p) => getEpisodeMeta(need(p[1], 'Episode URL required')),
  genres: (p) => getGenres(p[1]),
  genre: (p) => getGenreAnime(need(p[1], 'Genre slug required'), pg(p[2])),
  ongoing: (p) => getOngoingAnime(p[1]),
  popular: () => getPopularSeries(),
  schedule: () => getSchedule(),
  top: () => getTopAnime(),
  season: (p) => getSeasonAnime(
    need(p[1], 'Season required (spring/summer/fall/winter)'),
    parseInt(need(p[2], 'Year required (e.g. season winter 2024)')), pg(p[3]),
  ),
  more: (p, f) => loadMoreHome(p.slice(1).map(Number).filter(Number.isFinite), parseInt(f.offset || '0') || 0),
};

async function main(): Promise<void> {
  const { cmd, pos, flags } = parseArgs();
  if (!cmd || cmd === 'help' || cmd === '--help') { printUsage(); return; }
  const run = COMMANDS[cmd];
  if (!run) { console.error(`Unknown command: ${cmd}`); printUsage(); return; }
  try {
    out(await run(pos, flags));
  } catch (error) {
    console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// @ts-ignore - bun/direct-run entrypoint
if (import.meta.main) await main();

export {
  fetchPage, postAjax, getLatestEpisodes, getHomeContent, searchAnime, advancedSearch,
  getList, getAnimeDetail, getEpisodeInfo, getEpisodeStream, getGenres, getGenreAnime,
  getOngoingAnime, getPopularSeries, getSchedule, getRecentEpisodes, getTopAnime,
  getSeasonAnime, getEpisodeServers, resolveServer, getEpisodeNav, getEpisodeMeta,
  loadMoreHome, isValidUrl, sanitizeUrl,
};

// internal — consumed by api/nontonanime/server.ts (purge/health)
export const __cacheApi = site.cacheApi;

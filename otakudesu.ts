#!/usr/bin/env bun
/*
- base : https://otakudesu.blog
- creator : rynaqrtz
- migrated to core/ (spec 003) — ESM, hardened transport (cookie jar + ajax nonce flows preserved), uniform CLI
*/

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };
declare const Buffer: { from(data: string, enc?: string): { toString(enc?: string): string } };

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

const BASE_URL = 'https://otakudesu.blog';
const site = createSite({ base: BASE_URL, rateMs: 500 });
const { postAjax } = site;

// cookie jar preserved (site may set cloudflare/wp cookies)
class CookieJar {
  private cookies = new Map<string, string>();
  update(res: Response): void {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  getString(): string { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  clear(): void { this.cookies.clear(); }
}
const jar = new CookieJar();

type Rec = Record<string, unknown>;

function getHeaders(): Record<string, string> {
  return {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'accept-language': 'id-ID,id;q=0.9,en;q=0.8',
    ...(jar.getString() ? { cookie: jar.getString() } : {}),
  };
}

async function fetchHTML(url: string): Promise<string> {
  const res = await fetch(url, { headers: getHeaders(), redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  jar.update(res);
  if (!res.ok) throw new Error(`HTTP ${res.status} untuk ${url}`);
  return res.text();
}

/** admin-ajax POST with cookie jar (form-encoded) */
async function postAjaxRaw(payload: Record<string, string | number>): Promise<Rec> {
  const res = await fetch(`${BASE_URL}/wp-admin/admin-ajax.php`, {
    method: 'POST',
    headers: {
      ...getHeaders(),
      'x-requested-with': 'XMLHttpRequest',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)])).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  jar.update(res);
  if (!res.ok) throw new Error(`HTTP ${res.status} untuk admin-ajax`);
  return res.json() as Promise<Rec>;
}

function clean(obj: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) return obj.map((i) => clean(i)).filter((v) => v !== undefined);
  if (typeof obj === 'object') {
    const result: Rec = {};
    for (const key of Object.keys(obj as Rec)) {
      const val = clean((obj as Rec)[key]);
      if (val !== undefined) result[key] = val;
    }
    return Object.keys(result).length ? result : undefined;
  }
  return obj;
}

function buildResponse(page: string, url: string, data: Rec): Rec {
  return clean({ creator: 'rynaqrtz', page, url, data }) as Rec;
}

function parsePagination($: CheerioAPI): Rec {
  const result: Rec = { current: 1, next: null, hasNext: false, total: null };
  const pageLinks: Array<{ text: string; href: string }> = [];
  $('.pagination a, .pagination span, .page-numbers, .pagenavix a, .pagenavix span').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href) pageLinks.push({ text, href });
  });
  const numbers = pageLinks.filter((l) => /^\d+$/.test(l.text)).map((l) => parseInt(l.text));
  if (numbers.length) result.total = Math.max(...numbers);
  const current = $('.pagination .page-numbers.current, .pagenavix .page-numbers.current').first();
  if (current.length) {
    const t = current.text().trim();
    if (/^\d+$/.test(t)) result.current = parseInt(t);
  }
  if ((result.total as number) && (result.current as number) < (result.total as number)) {
    result.hasNext = true;
    const nextLink = pageLinks.find((l) => l.text === 'Next' || l.text === '»' || l.text.toLowerCase().includes('next'));
    if (nextLink?.href) {
      result.next = nextLink.href.startsWith('http') ? nextLink.href : BASE_URL + nextLink.href;
    }
  }
  return result;
}

function parseCardDetpost($: CheerioAPI, element: unknown): Rec | null {
  const $el = $(element);
  const link = $el.find('.thumb a').attr('href');
  const title = $el.find('.jdlflm').text().trim();
  const poster = $el.find('.thumbz img').attr('src') || null;
  const episode = $el.find('.epz').text().trim() || null;
  const day = $el.find('.epztipe').text().trim() || null;
  const date = $el.find('.newnime').text().trim() || null;
  if (!link || !title) return null;
  return { title, url: link.startsWith('http') ? link : BASE_URL + link, poster, episode, day, date };
}

function parseCardColAnime($: CheerioAPI, element: unknown): Rec | null {
  const $el = $(element);
  const link = $el.find('.col-anime-title a').attr('href');
  const title = $el.find('.col-anime-title a').text().trim();
  const studio = $el.find('.col-anime-studio').text().trim() || null;
  const eps = $el.find('.col-anime-eps').text().trim() || null;
  const rating = $el.find('.col-anime-rating').text().trim() || null;
  const genres = $el.find('.col-anime-genre a').map((_, a) => $(a).text()).get() || [];
  const poster = $el.find('.col-anime-cover img').attr('src') || null;
  const synopsis = $el.find('.col-synopsis p').text().trim() || null;
  const season = $el.find('.col-anime-date').text().trim() || null;
  if (!link || !title) return null;
  return { title, url: link.startsWith('http') ? link : BASE_URL + link, studio, episodes: eps, rating, genres, poster, synopsis, season };
}

function parseGenreList($: CheerioAPI): Array<{ name: string; slug: string; url: string }> {
  const genres: Array<{ name: string; slug: string; url: string }> = [];
  $('.genres li a').each((_, el) => {
    const $el = $(el);
    const name = $el.text().trim();
    const link = $el.attr('href');
    if (name && link) {
      const slug = link.replace(/\/genres\/([^\/]+)\/?/, '$1');
      genres.push({ name, slug, url: link.startsWith('http') ? link : BASE_URL + link });
    }
  });
  return genres;
}

function parseSchedule($: CheerioAPI): Rec {
  const schedule: Rec = {};
  $('.kglist321').each((_, el) => {
    const $el = $(el);
    const day = $el.find('h2').text().trim();
    const items: Array<Rec> = [];
    $el.find('ul li a').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      items.push({ title: $a.text().trim(), url: href.startsWith('http') ? href : BASE_URL + href });
    });
    if (day && items.length) schedule[day] = items;
  });
  return schedule;
}

function parseEpisodeList($: CheerioAPI): Array<{ title: string; episodeId: string | null; url: string; releaseDate: string | null }> {
  const episodes: Array<{ title: string; episodeId: string | null; url: string; releaseDate: string | null }> = [];
  $('.episodelist ul li').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a');
    const title = $a.text().trim();
    const href = $a.attr('href');
    const date = $el.find('.zeebr').text().trim() || null;
    if (href && title) {
      const match = href.match(/\/episode\/([^\/]+)\/?$/);
      episodes.push({
        title,
        episodeId: match ? match[1] : null,
        url: href.startsWith('http') ? href : BASE_URL + href,
        releaseDate: date,
      });
    }
  });
  return episodes;
}

function extractPostId($: CheerioAPI): string | number | null {
  const ids = new Set<string | number>();
  $('[data-content]').each((_, el) => {
    const content = $(el).attr('data-content');
    if (content) {
      try {
        const parsed = JSON.parse(Buffer.from(content, 'base64').toString('utf-8'));
        if (parsed.id) ids.add(parsed.id);
      } catch { /* ignore */ }
    }
  });
  $('[id^="post-"]').each((_, el) => {
    const id = $(el).attr('id') || '';
    const match = id.match(/post-(\d+)/);
    if (match) ids.add(parseInt(match[1]));
  });
  const html = $.html();
  const scriptMatches = html.match(/post[_\s]*id[_\s]*[:=]\s*["']?(\d+)["']?/gi);
  if (scriptMatches) {
    scriptMatches.forEach((m) => {
      const num = m.match(/\d+/);
      if (num) ids.add(parseInt(num[0]));
    });
  }
  return ids.size > 0 ? [...ids][0] : null;
}

async function getNonce(): Promise<string | null> {
  try {
    const res = await postAjaxRaw({ action: 'aa1208d27f29ca340c92c66d1926f13f' });
    return (res?.data as string) || null;
  } catch {
    return null;
  }
}

async function getStreamUrl(postId: string | number, index: unknown, quality: unknown, nonce: string): Promise<string | null> {
  try {
    const res = await postAjaxRaw({ action: '2a3505c93b0035d3f455df82bf976b84', id: postId, i: index, q: quality, nonce });
    if (!res?.data) return null;
    const html = Buffer.from(res.data as string, 'base64').toString('utf-8');
    const $ = cheerio.load(html);
    return $('iframe').attr('src') || null;
  } catch {
    return null;
  }
}

async function extractStreams(html: string): Promise<Rec> {
  const $ = cheerio.load(html);
  const postId = extractPostId($);
  if (!postId) return {};
  const nonce = await getNonce();
  if (!nonce) return {};
  const streams: Rec = {};
  $('.mirrorstream ul').each((_, ul) => {
    const $ul = $(ul);
    $ul.find('a').each((_, a) => {
      const $a = $(a);
      const dataContent = $a.attr('data-content');
      if (dataContent) {
        try {
          const decoded = JSON.parse(Buffer.from(dataContent, 'base64').toString('utf-8')) as { id?: string | number; i?: unknown; q?: unknown };
          if (decoded.id === postId) {
            const key = `${decoded.q}_${$a.text().trim()}`;
            streams[key] = { postId, i: decoded.i, q: decoded.q, nonce };
          }
        } catch { /* ignore */ }
      }
    });
  });
  const result: Rec = {};
  for (const [key, params] of Object.entries(streams)) {
    const p = params as { postId: string | number; i: unknown; q: unknown; nonce: string };
    const url = await getStreamUrl(p.postId, p.i, p.q, p.nonce);
    if (url) result[key] = url;
  }
  return result;
}

async function home(): Promise<Rec> {
  const url = BASE_URL + '/';
  const $ = cheerio.load(await fetchHTML(url));
  const items: Rec[] = [];
  $('.detpost:has(.epz:contains("Episode"))').each((_, el) => {
    const card = parseCardDetpost($, el);
    if (card) items.push(card);
  });
  return buildResponse('home', url, { items });
}

async function ongoing(page = 1): Promise<Rec> {
  const url = page === 1 ? BASE_URL + '/ongoing-anime/' : `${BASE_URL}/ongoing-anime/page/${page}/`;
  const $ = cheerio.load(await fetchHTML(url));
  const items: Rec[] = [];
  $('.detpost').each((_, el) => {
    const card = parseCardDetpost($, el);
    if (card) items.push(card);
  });
  return buildResponse('ongoing', url, { pagination: parsePagination($), items });
}

async function complete(page = 1): Promise<Rec> {
  const url = page === 1 ? BASE_URL + '/complete-anime/' : `${BASE_URL}/complete-anime/page/${page}/`;
  const $ = cheerio.load(await fetchHTML(url));
  const items: Rec[] = [];
  $('.detpost').each((_, el) => {
    const card = parseCardDetpost($, el);
    if (card) items.push(card);
  });
  return buildResponse('complete', url, { pagination: parsePagination($), items });
}

async function genreList(): Promise<Rec> {
  const url = BASE_URL + '/genre-list/';
  const $ = cheerio.load(await fetchHTML(url));
  return buildResponse('genreList', url, { genres: parseGenreList($) });
}

async function genre(slug: string, page = 1): Promise<Rec> {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid genre slug');
  const url = page === 1 ? `${BASE_URL}/genres/${slug}/` : `${BASE_URL}/genres/${slug}/page/${page}/`;
  const $ = cheerio.load(await fetchHTML(url));
  const items: Rec[] = [];
  $('.col-anime-con').each((_, el) => {
    const card = parseCardColAnime($, el);
    if (card) items.push(card);
  });
  return buildResponse('genre', url, { slug, pagination: parsePagination($), items });
}

async function jadwalRilis(): Promise<Rec> {
  const url = BASE_URL + '/jadwal-rilis/';
  const $ = cheerio.load(await fetchHTML(url));
  return buildResponse('jadwalRilis', url, { schedule: parseSchedule($) });
}

async function searchAnime(query: string): Promise<Rec> {
  const url = `${BASE_URL}/?s=${encodeURIComponent(query)}&post_type=anime`;
  const $ = cheerio.load(await fetchHTML(url));
  const items: Rec[] = [];
  $('.chivsrc li').each((_, el) => {
    const $el = $(el);
    const link = $el.find('h2 a').attr('href');
    const title = $el.find('h2 a').text().trim();
    const poster = $el.find('img').attr('src') || null;
    const genres = $el.find('.set:first-child a').map((_, a) => $(a).text()).get() || [];
    const status = $el.find('.set:nth-child(2)').text().replace('Status :', '').trim() || null;
    const ratingEl = $el.find('.set:contains("Rating")');
    const rating = ratingEl.length ? ratingEl.text().replace('Rating :', '').trim() : null;
    if (link && title) {
      items.push({ title, url: link.startsWith('http') ? link : BASE_URL + link, poster, genres, status, rating });
    }
  });
  return buildResponse('search', url, { query, items });
}

async function detail(slug: string): Promise<Rec> {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid slug');
  const url = `${BASE_URL}/anime/${slug}/`;
  const $ = cheerio.load(await fetchHTML(url));
  const title = $('.jdlrx h1').text().trim() || $('title').text().trim();
  const poster = $('.fotoanime img').attr('src') || null;
  const sinopsis = $('.sinopc p').text().trim() || null;
  const info: Rec = {};
  $('.infozin .infozingle p').each((_, el) => {
    const text = $(el).text().trim();
    if (text.includes('Genre')) {
      const genreLinks = $(el).find('a').map((_, a) => $(a).text()).get();
      info.genre = genreLinks.length ? genreLinks.join(', ') : null;
      return;
    }
    const parts = text.split(':');
    if (parts.length >= 2) {
      const key = parts[0].replace(/\s/g, '_').toLowerCase();
      const value = parts.slice(1).join(':').trim();
      if (key) info[key] = value;
    }
  });
  const episodes = parseEpisodeList($);
  const recommendations: Rec[] = [];
  $('.isi-recommend-anime-series .isi-konten').each((_, el) => {
    const $el = $(el);
    const link = $el.find('.judul-anime a').attr('href');
    const titleRec = $el.find('.judul-anime a').text().trim();
    const posterRec = $el.find('.gambar-konten img').attr('src') || null;
    if (link && titleRec) {
      recommendations.push({
        title: titleRec,
        url: link.startsWith('http') ? link : BASE_URL + link,
        poster: posterRec,
      });
    }
  });
  return buildResponse('detail', url, { title, poster, sinopsis, info, episodes, recommendations });
}

function parseDownloads($: CheerioAPI, fallbackGroup: string): Array<Rec> {
  const downloads: Array<Rec> = [];
  $('.download ul').each((_, ul) => {
    const $ul = $(ul);
    const group = $ul.prev('h4').text().trim() || $ul.prev('strong').text().trim() || fallbackGroup;
    const items: Rec[] = [];
    $ul.find('li').each((_, li) => {
      const $li = $(li);
      const resolution = $li.find('strong').text().trim() || null;
      const size = $li.find('i').text().trim() || null;
      const links: Array<Rec> = [];
      $li.find('a').each((_, a) => {
        const $a = $(a);
        links.push({ host: $a.text().trim(), url: $a.attr('href') });
      });
      if (links.length) items.push({ resolution, size, links });
    });
    if (items.length) downloads.push({ group, items });
  });
  return downloads;
}

async function episode(slug: string): Promise<Rec> {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid episode slug');
  const url = `${BASE_URL}/episode/${slug}/`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const title = $('h1.posttl').text().trim() || $('title').text().trim();
  const streams = await extractStreams(html);
  const downloads = parseDownloads($, 'Download');
  const nav = {
    prev: $('.prevnext .flir a:first-child').attr('href') || null,
    all: $('.prevnext .flir a:contains("See All")').attr('href') || null,
    next: $('.prevnext .flir a:last-child').attr('href') || null,
  };
  const otherEpisodes = parseEpisodeList($);
  const data: Rec = { title, streams, downloads, nav };
  if (otherEpisodes.length) data.otherEpisodes = otherEpisodes;
  return buildResponse('episode', url, data);
}

// helper removed — episode() now fetches html once

async function batch(slug: string): Promise<Rec> {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid batch slug');
  const url = `${BASE_URL}/lengkap/${slug}/`;
  const $ = cheerio.load(await fetchHTML(url));
  const title = $('.jdlrx h1').text().trim() || $('title').text().trim();
  return buildResponse('batch', url, { title, downloads: parseDownloads($, 'Batch') });
}

if (import.meta.main) {
  defineCli({
    name: 'otakudesu',
    title: 'Otakudesu Scraper (otakudesu.blog)',
    commands: {
      home: { desc: 'Episode terbaru', run: async () => home() },
      ongoing: { desc: 'Anime ongoing', usage: '[page]', run: async (p) => ongoing(parseInt(p[0]) || 1) },
      complete: { desc: 'Anime completed', usage: '[page]', run: async (p) => complete(parseInt(p[0]) || 1) },
      genrelist: { desc: 'Daftar genre', run: async () => genreList() },
      genre: { desc: 'Anime per genre', usage: '<slug> [page]', run: async (p) => { if (!p[0]) throw new Error('Genre slug required'); return genre(p[0], parseInt(p[1]) || 1); } },
      jadwal: { desc: 'Jadwal rilis mingguan', run: async () => jadwalRilis() },
      search: { desc: 'Cari anime', usage: '<query>', run: async (p) => { if (!p[0]) throw new Error('Query required'); return searchAnime(p.join(' ')); } },
      detail: { desc: 'Detail anime + episode list', usage: '<slug>', run: async (p) => { if (!p[0]) throw new Error('Anime slug required'); return detail(p[0]); } },
      episode: { desc: 'Episode + resolved stream URLs', usage: '<episode-slug>', run: async (p) => { if (!p[0]) throw new Error('Episode slug required'); return episode(p[0]); } },
      batch: { desc: 'Batch download page', usage: '<slug>', run: async (p) => { if (!p[0]) throw new Error('Batch slug required'); return batch(p[0]); } },
    },
    examples: `  bun otakudesu.ts search "one piece"
  bun otakudesu.ts episode one-piece-episode-1100`,
  });
}

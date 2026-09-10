#!/usr/bin/env bun
/*
- base : https://anime-indo.lol
- creator : rynaqrtz
- migrated to core/ (spec 003) — ESM, hardened transport (cookie jar preserved), uniform CLI
*/

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

const BASE_URL = 'https://anime-indo.lol';
const site = createSite({ base: BASE_URL, rateMs: 500 });
const { fetchPage } = site;

// simple cookie jar (legacy had tough-cookie style jar; core doesn't set cookies,
// but the site works without session cookies for public pages — jar kept for parity)
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
const get = <T>(o: unknown, k: string): T | undefined => (o && typeof o === 'object' ? (o as Rec)[k] as T : undefined);

function getHeaders(): Record<string, string> {
  return {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'accept-language': 'id-ID,id;q=0.9,en;q=0.8',
    ...(jar.getString() ? { cookie: jar.getString() } : {}),
  };
}

async function fetchHTML(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: getHeaders(),
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  jar.update(res);
  if (!res.ok) throw new Error(`HTTP ${res.status} untuk ${url}`);
  return res.text();
}

function decodeEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function clean(obj: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) return obj.map((i) => clean(i)).filter((v) => v !== undefined);
  if (typeof obj === 'object') {
    const result: Rec = {};
    for (const key of Object.keys(obj as Rec)) {
      const val = clean((obj as Rec)[key]);
      if (val !== undefined && val !== null && !(Array.isArray(val) && val.length === 0)) {
        result[key] = val;
      }
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
  $('.pag a, .pag span, .pagination a, .pagination span').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href) pageLinks.push({ text, href });
  });
  const numbers = pageLinks.filter((l) => /^\d+$/.test(l.text)).map((l) => parseInt(l.text));
  if (numbers.length) result.total = Math.max(...numbers);
  const current = $('.pag .cur, .pagination .current').first();
  if (current.length) {
    const t = current.text().trim();
    if (/^\d+$/.test(t)) result.current = parseInt(t);
  }
  if ((result.total as number) && (result.current as number) < (result.total as number)) {
    result.hasNext = true;
    const nextLink = pageLinks.find((l) => l.text === '»' || l.text.toLowerCase().includes('next'));
    if (nextLink?.href) {
      result.next = nextLink.href.startsWith('http') ? nextLink.href : BASE_URL + nextLink.href;
    }
  }
  return result;
}

function parseCardHome($: CheerioAPI, element: unknown): Rec | null {
  const $el = $(element);
  let link: string | null = null;
  let title: string | null = null;
  let image: string | null = null;
  let episode: string | null = null;

  const $parent = $el.parent('a');
  if ($parent.length) link = $parent.attr('href') || null;
  else {
    const $a = $el.find('a').first();
    if ($a.length) link = $a.attr('href') || null;
  }
  const $title = $el.find('p').first();
  if ($title.length) title = $title.text().trim();
  const $img = $el.find('img').first();
  if ($img.length) image = $img.attr('data-original') || $img.attr('src') || null;
  const $eps = $el.find('.eps').first();
  if ($eps.length) episode = $eps.text().trim();
  if (!link) {
    const $innerA = $el.find('a').first();
    if ($innerA.length) link = $innerA.attr('href') || null;
  }
  if (link && title) {
    return {
      title,
      url: link.startsWith('http') ? link : BASE_URL + link,
      image: image ? (image.startsWith('http') ? image : BASE_URL + image) : null,
      episode,
    };
  }
  return null;
}

function parseCardTable($: CheerioAPI, element: unknown): Rec | null {
  const $el = $(element);
  const $thumb = $el.find('.vithumb img');
  const $title = $el.find('.videsc a:first');
  const $labels = $el.find('.label');
  const $desc = $el.find('.des');
  const thumbnail = $thumb.attr('src') || $thumb.attr('data-original') || '';
  const title = $title.text().trim();
  const url = $title.attr('href') || '';
  const labels: string[] = [];
  $labels.each((_, label) => labels.push($(label).text().trim()));
  const description = $desc.text().trim();
  if (!title || !url) return null;
  return {
    title,
    url: url.startsWith('http') ? url : BASE_URL + url,
    thumbnail: thumbnail ? (thumbnail.startsWith('http') ? thumbnail : BASE_URL + thumbnail) : null,
    labels,
    description,
    type: labels.includes('Movie') ? 'movie' : labels.includes('LA') ? 'liveaction' : labels.includes('Special') ? 'special' : labels.includes('OVA') ? 'ova' : 'tv',
    duration: labels.find((l) => l.includes('hr') || l.includes('min')) || null,
    year: labels.find((l) => /^\d{4}$/.test(l)) || null,
    status: labels.find((l) => l === 'Completed' || l === 'Currently Airing' || l === 'Unknown') || null,
  };
}

function parseEpisodeList($: CheerioAPI): Array<{ number: number; title: string; url: string }> {
  const episodes: Array<{ number: number; title: string; url: string }> = [];
  $('.ep a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    const text = $el.text().trim();
    const number = parseInt(text);
    if (href && !isNaN(number)) {
      episodes.push({
        number,
        title: `Episode ${number}`,
        url: href.startsWith('http') ? href : BASE_URL + href,
      });
    }
  });
  return episodes;
}

function parseGenreList($: CheerioAPI): Array<{ name: string; slug: string; url: string }> {
  const genres: Array<{ name: string; slug: string; url: string }> = [];
  $('.list-genre a').each((_, el) => {
    const $el = $(el);
    const name = $el.text().trim();
    const href = $el.attr('href');
    if (name && href) {
      const slug = href.replace(/\/genres\/([^\/]+)\/?/, '$1');
      genres.push({ name, slug, url: href.startsWith('http') ? href : BASE_URL + href });
    }
  });
  return genres;
}

function extractVideoUrls($: CheerioAPI): Rec {
  const result: Rec = { iframe: null, servers: [], downloads: [] };
  const iframe = $('#tontonin').attr('src');
  if (iframe) {
    result.iframe = iframe.startsWith('http') ? iframe : BASE_URL + iframe;
  }
  $('.server').each((_, el) => {
    const $el = $(el);
    const name = $el.text().trim();
    const url = $el.attr('data-video');
    if (url) {
      (result.servers as Array<Rec>).push({ name, url: url.startsWith('http') ? url : BASE_URL + url });
    }
  });
  $('.navi a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    const text = $el.text().trim();
    if (href && (text.includes('Download') || text.includes('Unduh') || text.includes('GDrive'))) {
      (result.downloads as Array<Rec>).push({
        text,
        url: href.startsWith('http') ? href : BASE_URL + href,
      });
    }
  });
  return result;
}

async function fetchDirectVideo(proxyUrl: string, depth = 0): Promise<string | null> {
  if (depth > 5) return null;
  try {
    const html = await fetchHTML(proxyUrl);
    const $ = cheerio.load(html);
    const iframe = $('iframe').attr('src');
    if (iframe) {
      if (iframe.includes('googlevideo.com')) return iframe;
      return fetchDirectVideo(iframe, depth + 1);
    }
    const videoSrc = $('video source').attr('src') || $('video').attr('src');
    if (videoSrc) return videoSrc;
    const embed = $('.embed-responsive iframe').attr('src') || $('#player iframe').attr('src') || $('.player iframe').attr('src');
    if (embed) {
      if (embed.includes('googlevideo.com')) return embed;
      return fetchDirectVideo(embed, depth + 1);
    }
    const gvMatch = html.match(/https?:\/\/[^"'\s]*googlevideo\.com\/videoplayback[^"'\s]*/i);
    return gvMatch ? gvMatch[0] : null;
  } catch {
    return null;
  }
}

async function home(page = 1): Promise<Rec> {
  const url = page === 1 ? BASE_URL + '/' : `${BASE_URL}/page/${page}/`;
  const $ = cheerio.load(await fetchHTML(url));
  const items: Rec[] = [];
  $('.list-anime').each((_, el) => {
    const card = parseCardHome($, el);
    if (card) items.push(card);
  });
  return buildResponse('home', url, { pagination: parsePagination($), items });
}

async function genreList(): Promise<Rec> {
  const url = BASE_URL + '/list-genre/';
  const $ = cheerio.load(await fetchHTML(url));
  return buildResponse('genreList', url, { genres: parseGenreList($) });
}

async function genre(slug: string, page = 1): Promise<Rec> {
  const s = slug.toLowerCase().trim();
  if (!/^[a-z0-9-]+$/.test(s)) throw new Error('Invalid genre slug');
  const url = page === 1 ? `${BASE_URL}/genres/${s}/` : `${BASE_URL}/genres/${s}/page/${page}/`;
  const $ = cheerio.load(await fetchHTML(url));
  const items: Rec[] = [];
  $('.otable').each((_, el) => {
    const card = parseCardTable($, el);
    if (card) items.push(card);
  });
  return buildResponse('genre', url, { slug: s, pagination: parsePagination($), items });
}

async function movies(page = 1): Promise<Rec> {
  const url = page === 1 ? BASE_URL + '/movie/' : `${BASE_URL}/movie/page/${page}/`;
  const $ = cheerio.load(await fetchHTML(url));
  const items: Rec[] = [];
  $('.otable').each((_, el) => {
    const card = parseCardTable($, el);
    if (card) items.push(card);
  });
  return buildResponse('movies', url, { pagination: parsePagination($), items });
}

async function jadwal(): Promise<Rec> {
  const url = BASE_URL + '/jadwal/';
  const $ = cheerio.load(await fetchHTML(url));
  const items: string[] = [];
  $('.anime-list li').each((_, el) => {
    const text = $(el).text().trim();
    if (text) items.push(text);
  });
  return buildResponse('jadwal', url, { items });
}

async function searchAnime(query: string): Promise<Rec> {
  const url = BASE_URL + `/search.php?q=${encodeURIComponent(query)}`;
  const $ = cheerio.load(await fetchHTML(url));
  const items: Rec[] = [];
  $('.otable').each((_, el) => {
    const card = parseCardTable($, el);
    if (card) items.push(card);
  });
  if (items.length === 0) {
    $('.list-anime').each((_, el) => {
      const card = parseCardHome($, el);
      if (card) items.push(card);
    });
  }
  return buildResponse('search', url, { query, items });
}

async function detail(slug: string): Promise<Rec> {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid slug');
  const url = `${BASE_URL}/anime/${slug}/`;
  const $ = cheerio.load(await fetchHTML(url));
  const $detail = $('.detail');
  const title = $('h1.title').text().trim() || $('title').text().trim();
  const image = $detail.find('img').attr('src') || null;
  const description = $detail.find('p').text().trim() || null;
  const genres: Array<{ name: string; url: string }> = [];
  $detail.find('li a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    genres.push({ name: $el.text().trim(), url: href.startsWith('http') ? href : BASE_URL + href });
  });
  return buildResponse('detail', url, {
    title,
    image: image ? (image.startsWith('http') ? image : BASE_URL + image) : null,
    description,
    genres,
    episodes: parseEpisodeList($),
  });
}

async function episode(slug: string): Promise<Rec> {
  const url = `${BASE_URL}/${slug}/`;
  const $ = cheerio.load(await fetchHTML(url));
  const title = $('h1.title').text().trim() || $('title').text().trim();
  const videoData = extractVideoUrls($);
  let directVideo: string | null = null;
  const iframe = videoData.iframe as string | null;
  if (iframe?.includes('btube3.php')) directVideo = await fetchDirectVideo(iframe);
  return buildResponse('episode', url, {
    title,
    iframe,
    directVideo,
    servers: videoData.servers,
    downloads: videoData.downloads,
  });
}

async function batch(slug: string): Promise<Rec> {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid slug');
  const url = `${BASE_URL}/anime/${slug}/`;
  const $ = cheerio.load(await fetchHTML(url));
  const title = $('h1.title').text().trim() || $('title').text().trim();
  const episodes = parseEpisodeList($);
  const batchData: Rec[] = [];
  for (const ep of episodes.slice(0, 10)) {
    try {
      const $ep = cheerio.load(await fetchHTML(ep.url));
      const videoData = extractVideoUrls($ep);
      let directVideo: string | null = null;
      const iframe = videoData.iframe as string | null;
      if (iframe?.includes('btube3.php')) directVideo = await fetchDirectVideo(iframe);
      batchData.push({
        episode: ep.number, title: ep.title, iframe, directVideo,
        servers: videoData.servers, downloads: videoData.downloads,
      });
    } catch (e) {
      batchData.push({ episode: ep.number, title: ep.title, error: (e as Error).message });
    }
  }
  return buildResponse('batch', url, { title, episodes: batchData });
}

if (import.meta.main) {
  defineCli({
    name: 'animeindo',
    title: 'AnimeIndo Scraper (anime-indo.lol)',
    commands: {
      home: { desc: 'Homepage (paginated)', usage: '[page]', run: async (p) => home(parseInt(p[0]) || 1) },
      genrelist: { desc: 'Daftar genre', run: async () => genreList() },
      genre: { desc: 'Anime per genre', usage: '<slug> [page]', run: async (p) => { if (!p[0]) throw new Error('Genre slug required'); return genre(p[0], parseInt(p[1]) || 1); } },
      movies: { desc: 'Daftar movie', usage: '[page]', run: async (p) => movies(parseInt(p[0]) || 1) },
      jadwal: { desc: 'Jadwal mingguan', run: async () => jadwal() },
      search: { desc: 'Cari anime', usage: '<query>', run: async (p) => { if (!p[0]) throw new Error('Query required'); return searchAnime(p.join(' ')); } },
      detail: { desc: 'Detail anime + episode list', usage: '<slug>', run: async (p) => { if (!p[0]) throw new Error('Anime slug required'); return detail(p[0]); } },
      episode: { desc: 'Episode + streams + downloads', usage: '<slug>', run: async (p) => { if (!p[0]) throw new Error('Episode slug required'); return episode(p[0]); } },
      batch: { desc: 'Batch download page (10 eps)', usage: '<slug>', run: async (p) => { if (!p[0]) throw new Error('Anime slug required'); return batch(p[0]); } },
    },
    examples: `  bun animeindo.ts search "one piece"
  bun animeindo.ts detail one-piece
  bun animeindo.ts episode one-piece-episode-1`,
  });
}

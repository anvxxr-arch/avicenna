#!/usr/bin/env bun
/*
- base : https://tv12.lk21official.cc
- creator : phrzy
- migrated to core/ (spec 003) — ESM, hardened transport, uniform CLI
- NOTE: site sits behind Cloudflare challenge (cf-mitigated: challenge). Plain HTTP
  clients get "Just a moment..." — parity is maintained structurally; live verification
  requires a challenge-solving session (out of scope for core). Legacy behavior preserved:
  redirect:'manual' semantics now live in core; the scraper inspects raw HTML only.
*/

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';


const BASE = 'https://tv12.lk21official.cc';
const site = createSite({
  base: BASE,
  rateMs: 500,
  headers: {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'accept': '*/*',
  },
});
const { fetchPage } = site;

function decodeEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}
type Item = Record<string, unknown>;
/** Mirrors legacy `base` as stated by the site itself. */
const SITE = 'https://tv12.lk21official.cc';
const DELAY_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abs = (href: string | undefined | null): string | null => (href ? (href.startsWith('http') ? href : BASE + href) : null);

/** Legacy `parseItem` — full field set (slug, genres, title, rating, ratingCount, year, isSeries, episodes, duration, quality, poster, url). */
function parseItem(block: string): Item {
  const item: Item = {};
  const href = block.match(/<a href="\/([^\/?"]+)"/);
  item.slug = href ? href[1] : null;
  let m = block.match(/<meta itemprop="genre" content="([^"]+)"/) || block.match(/<div class="genre">([\s\S]*?)<\/div>/);
  item.genres = m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
  m = block.match(/<h3 class="poster-title"[^>]*>([\s\S]*?)<\/h3>/);
  item.title = m ? decodeEntities(m[1].replace(/<[^>]*>/g, '')).trim() : null;
  m = block.match(/itemprop="ratingValue">([\s\S]*?)<\/span>/) || block.match(/<span class="rating">[\s\S]*?<\/i>([\s\S]*?)<\/span>/);
  item.rating = m ? m[1].trim() : null;
  m = block.match(/itemprop="ratingCount" content="([^"]+)"/);
  item.ratingCount = m ? m[1] : null;
  m = block.match(/class="year"[^>]*>([\s\S]*?)<\/span>/);
  item.year = m ? m[1].trim() : null;
  item.isSeries = /class="episode/.test(block);
  m = block.match(/class="episode[^"]*">[\s\S]*?<strong>([\s\S]*?)<\/strong>/);
  item.episodes = m ? m[1].trim() : null;
  m = block.match(/class="duration"[^>]*>([\s\S]*?)<\/span>/);
  item.duration = m ? m[1].trim() : null;
  m = block.match(/class="label[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  item.quality = m ? m[1].trim() : null;
  m = block.match(/<img[^>]*data-src="([^"]+)"/) || block.match(/<img[^>]*src="([^"]+)"/);
  item.poster = m ? m[1] : null;
  item.url = item.slug ? BASE + '/' + item.slug : null;
  return item;
}
function parseList(html: string, idHint?: string): Item[] {
  let region = html;
  if (idHint) {
    const start = html.indexOf('id="' + idHint + '"');
    if (start !== -1) {
      const end = html.indexOf('id="adHome5"', start);
      region = html.slice(start, end === -1 ? start + 500_000 : end);
    }
  }
  return [...region.matchAll(/<article[\s\S]*?<\/article>/g)].map((m) => parseItem(m[0]));
}
async function getCompleteList(): Promise<Item[]> {
  const items = new Map<string, Item>();
  for (const it of parseList(await fetchPage(BASE + '/'), 'post-container')) if (it.slug) items.set(it.slug as string, it);
  for (let page = 2; ; page++) {
    let text: string;
    try {
      text = await fetchPage(BASE + '/loadmore-home/page/' + page);
    } catch (e) {
      // 404 = end of list; WAF/5xx must surface instead of silently truncating
      if (/HTTP 404/.test((e as Error).message)) break;
      throw e;
    }
    if (!text.trim()) break;
    const parsed = parseList(text);
    if (!parsed.length) break;
    for (const it of parsed) if (it.slug) items.set(it.slug as string, it);
    await sleep(DELAY_MS);
  }
  return [...items.values()];
}
function parseSectionItems(html: string): Item[] {
  const ul = html.match(/<ul class="sliders"[\s\S]*?<\/ul>/);
  if (!ul) return [];
  return [...ul[0].matchAll(/<li class="slider"[\s\S]*?<\/li>/g)].map((m) => parseItem(m[0]));
}
async function getSections(): Promise<Array<Record<string, unknown>>> {
  const home = await fetchPage(BASE + '/');
  const marks = [...home.matchAll(/<div class="widget"[^>]*>/g)].map((m) => m.index as number);
  const sections: Array<Record<string, unknown>> = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1] : home.indexOf('<footer', start);
    const slice = home.slice(start, end === -1 ? start + 400_000 : end);
    const label = slice.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!label) continue;
    const name = decodeEntities(label[1].replace(/<[^>]*>/g, '')).trim();
    const urlMatch = slice.match(/<a href="([^"]+)" class="btn btn-small">/);
    const type = (slice.match(/<div class="widget"[^>]*data-type="([^"]*)"/) || [])[1] || '';
    const items = parseSectionItems(slice);
    // legacy: sections carrying a `data-type` continue over /loadmore/<type>/page/N
    if (type) {
      for (let page = 2; ; page++) {
        let text: string;
        try {
          text = await fetchPage(`${BASE}/loadmore/${type}/page/${page}`);
        } catch (e) {
          if (/HTTP 404/.test((e as Error).message)) break;
          throw e;
        }
        if (!text.trim()) break;
        const more = [...text.matchAll(/<li class="slider"[\s\S]*?<\/li>/g)].map((m) => parseItem(m[0]));
        if (!more.length) break;
        items.push(...more);
        await sleep(DELAY_MS);
      }
    }
    sections.push({ name, type, url: urlMatch ? urlMatch[1] : null, total: items.length, items });
  }
  return sections;
}
/** Legacy `parseDetail` — id/title/year/runtime/rating/poster/info/tags/genres/countries/synopsis/details/player/players/downloadUrl/trailerUrl. */
function parseDetail(html: string, item: Item): Item {
  const d: Item = { ...item };
  let m = html.match(/<script id="watch-history-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const j = JSON.parse(m[1]) as Record<string, unknown>;
      d.id = j.id;
      d.title = j.title;
      d.year = j.year;
      d.runtime = j.runtime;
      d.rating = j.rating;
      d.poster = j.poster;
    } catch { /* malformed payload — keep the scraped values */ }
  }
  m = html.match(/<div class="main-player"[^>]*data-post_id="([^"]+)"[^>]*data-related_type="([^"]+)"/);
  if (m) { d.id = m[1]; d.type = m[2]; }
  m = html.match(/<h1>([\s\S]*?)<\/h1><div class="info-tag">([\s\S]*?)<\/div><div class="tag-list">([\s\S]*?)<\/div>/);
  if (m) {
    d.title = d.title || decodeEntities(m[1].replace(/<[^>]*>/g, '')).trim();
    const spans = m[2].match(/<span>([\s\S]*?)<\/span>/g);
    d.info = spans ? spans.map((x) => x.replace(/<\/?span>/g, '').trim()) : [];
    const tags = [...m[3].matchAll(/<span class="tag"><a href="([^"]+)">([\s\S]*?)<\/a><\/span>/g)]
      .map((t) => ({ url: t[1], name: decodeEntities(t[2].replace(/<[^>]*>/g, '')).trim() }));
    d.tags = tags;
    d.genres = tags.filter((t) => t.url.startsWith('/genre/')).map((t) => t.name);
    d.countries = tags.filter((t) => t.url.startsWith('/country/')).map((t) => t.name);
  }
  m = html.match(/<div class="synopsis[^"]*">([\s\S]*?)<\/div>/);
  d.synopsis = m ? decodeEntities(m[1].replace(/<br\s*\/?>/g, '\n').replace(/<[^>]*>/g, '')).trim() : null;
  m = html.match(/<div class="detail hidden">([\s\S]*?)<\/div>/);
  if (m) {
    const detail: Record<string, string> = {};
    for (const dm of m[1].matchAll(/<p><span>[\s\S]*?<\/span>\s*([\s\S]*?)<\/p>/g)) {
      const raw = dm[1].replace(/<[^>]*>/g, '').trim();
      const keyMatch = dm[0].match(/<span>([\s\S]*?)<\/span>/);
      if (keyMatch) detail[decodeEntities(keyMatch[1]).replace(/<\/?span>/g, '').replace(/:$/, '').trim()] = decodeEntities(raw);
    }
    d.details = detail;
  }
  m = html.match(/<iframe id="main-player"[^>]*src="([^"]+)"/);
  d.player = m ? m[1] : null;
  m = html.match(/id="player-list"\s*([\s\S]*?)<\/ul>/);
  if (m) d.players = [...m[1].matchAll(/<li><a href="([^"]+)"[^>]*data-server="([^"]*)">/g)].map((p) => ({ server: p[2], url: p[1] }));
  m = html.match(/<a href="([^"]*dadadidi[^"]*)"[^>]*title="Download[^"]*"/);
  d.downloadUrl = m ? m[1] : null;
  m = html.match(/<a href="(https:\/\/www\.youtube\.com\/watch\?v=[^"]+)"[^>]*class="yt-lightbox"/);
  d.trailerUrl = m ? m[1] : null;
  d.site = SITE;
  return d;
}
async function getDetail(slug: string): Promise<Item> {
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error('Invalid slug (a-z 0-9 - only)');
  const html = await fetchPage(BASE + '/' + slug + '/');
  // a challenge/soft block must not be reported as an empty film
  if (!/watch-history-data/.test(html)) throw new Error('Respon tidak dikenali untuk ' + slug);
  const openNow = html.match(/href="(https:\/\/[^"]+)"[^>]*id="openNow"/);
  if (openNow) return { slug, status: 'redirect', redirectUrl: openNow[1] };
  return parseDetail(html, { slug });
}
if (import.meta.main) {
  // legacy flag entry point
  if (process.argv[2] === '--sections') process.argv[2] = 'sections';
  defineCli({
    name: 'lk21',
    title: 'LK21 Scraper (tv12.lk21official.cc)',
    commands: {
      list: { desc: 'Seluruh daftar lengkap film terbaru', run: () => getCompleteList() },
      sections: { desc: 'Semua bagian di halaman utama (terbaru, rekomendasi, dll)', run: () => getSections() },
      detail: {
        desc: 'Detail satu film', usage: '<slug>',
        run: (p) => { if (!p[0]) throw new Error('Slug required (e.g. night-nurse-2026)'); return getDetail(p[0].trim()); },
      },
      'list-detail': {
        desc: 'Daftar lengkap + detail tiap film (SLOW)',
        run: async () => {
          const list = await getCompleteList();
          const result: Item[] = [];
          for (let i = 0; i < list.length; i++) {
            const it = list[i];
            try {
              result.push(await getDetail(it.slug as string));
            } catch (e) {
              result.push({ ...it, status: 'error', message: (e as Error).message });
            }
            process.stderr.write(`[${i + 1}/${list.length}] ${String(it.title)}\n`);
            await sleep(DELAY_MS);
          }
          return result;
        },
      },
    },
    examples: `  bun lk21.ts detail night-nurse-2026
  bun lk21.ts sections
  bun lk21.ts list`,
  });
}

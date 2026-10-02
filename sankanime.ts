#!/usr/bin/env bun
/*
- base : https://www.sankavollerei.web.id (official Sankanime API)
- creator : avicenna
- sankanime.web.id's HTML tells scrapers to use the official API instead of
  scraping the SPA — this CLI IS that sanctioned client. The Go port
  (scrapers/sankanime.go) is diffed against this file: payload key shapes match
  command for command.
*/
declare const process: { argv: string[]; exit(code?: number): void };
import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

type Rec = Record<string, unknown>;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// The API allows 30 req/min with a 3-strike permanent ban: 2.2s spacing.
const site = createSite({
  base: 'https://www.sankavollerei.web.id',
  rateMs: 2200,
  headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', 'accept-language': 'id-ID,id;q=0.9,en;q=0.8' },
});

const SLUG_RE = /^[a-z0-9-]+$/;

/** \uXXXX runs the chapter endpoint double-escaped (upstream defect). */
function unescapeUnicode(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}
/** Recursive unescape of every string in the decoded payload. */
function fix<T>(v: T): T {
  if (typeof v === 'string') return unescapeUnicode(v) as unknown as T;
  if (Array.isArray(v)) return v.map((e) => fix(e)) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Rec = {};
    for (const [k, e] of Object.entries(v as Rec)) out[k] = fix(e);
    return out as unknown as T;
  }
  return v;
}

async function get(path: string): Promise<Rec> {
  const res = await site.request(site.sanitizeUrl(site.base + path), { follow: true });
  if (!res.ok) throw new Error(`upstream error (HTTP ${res.status})`);
  const m = (await res.json()) as Rec;
  // An error payload is `{creator, message}` — no data branches.
  const msg = typeof m.message === 'string' ? m.message : '';
  if (msg !== '' && m.data === undefined && m.comics === undefined && m.status === undefined) throw new Error(msg);
  return m;
}

/** Mirrors Scrapers.Clean (clean.go) + ScraperEnvelope: nil/null and empty
 * arrays/objects drop out so the JSON shape matches the Go port exactly. */
function clean(obj: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const out = obj.map((i) => clean(i)).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
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

function build(page: string, url: string, data: Rec): Rec {
  return (clean({ creator: 'avicenna', page, url, data }) ?? { creator: 'avicenna', page, url }) as Rec;
}

function slugGuard(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new Error('Invalid slug (a-z 0-9 - only)');
}

async function home(): Promise<Rec> {
  const m = await get('/comic/homepage');
  return build('home', site.base + '/comic/homepage', { popular: m.popular, latest: m.latest, ranking: m.ranking });
}
async function terbaru(page: number): Promise<Rec> {
  const u = `/comic/terbaru?page=${page}`;
  const m = await get(u);
  return build('terbaru', site.base + u, { items: m.comics, pagination: m.pagination });
}
async function populer(): Promise<Rec> {
  const m = await get('/comic/populer');
  return build('populer', site.base + '/comic/populer', { items: m.comics, pagination: m.pagination });
}
async function search(q: string): Promise<Rec> {
  if (q.trim() === '') throw new Error('Query required');
  const u = `/comic/search?q=${encodeURIComponent(q)}`;
  const m = await get(u);
  return build('search', site.base + u, { query: q, items: m.data, total: m.total });
}
async function genreList(): Promise<Rec> {
  const m = await get('/comic/genres');
  return build('genreList', site.base + '/comic/genres', { genres: m.data });
}
async function genre(slug: string, page: number): Promise<Rec> {
  if (!slug) throw new Error('Genre slug required');
  slugGuard(slug);
  const u = `/comic/genre/${slug}?page=${page}`;
  const m = await get(u);
  return build('genre', site.base + u, { genre: slug, items: m.comics, pagination: m.pagination, metadata: m.metadata });
}
async function detail(slug: string): Promise<Rec> {
  if (!slug) throw new Error('Series slug required');
  slugGuard(slug);
  const u = `/comic/comic/${slug}`;
  const m = await get(u);
  delete m.creator; // the upstream attribution, not a series field
  return build('detail', site.base + u, fix(m));
}
async function chapter(slug: string): Promise<Rec> {
  if (!slug) throw new Error('Chapter slug required');
  slugGuard(slug);
  const u = `/comic/chapter/${slug}`;
  const m = await get(u);
  delete m.creator;
  delete m.imagesproxy; // proxy mirrors of `images`; callers use the originals
  return build('chapter', site.base + u, fix(m));
}
function supported(): Rec {
  return build('supportedPages', site.base + '/', {
    home: true, terbaru: true, populer: true, search: true,
    genreList: true, genre: true, detail: true, chapter: true,
  });
}

if (import.meta.main) {
  defineCli({
    name: 'sankanime',
    title: 'Sankanime Scraper (sankanime.web.id / official API)',
    commands: {
      home: { desc: 'Section homepage (populer, terbaru, ranking)', run: async () => home() },
      terbaru: { desc: 'Komik terbaru (per halaman)', usage: '[page]', run: async (p) => terbaru(Number(p[0]) || 1) },
      populer: { desc: 'Komik populer', run: async () => populer() },
      search: { desc: 'Cari komik', usage: '<query>', run: async (p) => search(p.join(' ')) },
      genrelist: { desc: 'Daftar genre', run: async () => genreList() },
      genre: { desc: 'Komik per genre', usage: '<slug> [page]', run: async (p) => genre(p[0] || '', Number(p[1]) || 1) },
      detail: { desc: 'Detail komik + daftar chapter', usage: '<slug>', run: async (p) => detail(p[0] || '') },
      chapter: { desc: 'Chapter + daftar gambar', usage: '<slug>', run: async (p) => chapter(p[0] || '') },
      supported: { desc: 'List supported pages/features', run: () => supported() },
    },
    examples: `  bun sankanime.ts search "naruto"
  bun sankanime.ts detail naruto-konohas-story-the-steam-ninja-scrolls
  bun sankanime.ts chapter naruto-konohas-story-the-steam-ninja-scrolls-chapter-15
  bun sankanime.ts terbaru 2`,
  });
}

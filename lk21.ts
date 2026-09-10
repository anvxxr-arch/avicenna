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

interface LkItem {
  slug: string | null;
  genres: string[];
  title: string | null;
  rating: string | null;
  ratingCount: string | null;
  year: string | null;
  isSeries: boolean;
  [k: string]: unknown;
}

function parseItem(block: string): LkItem {
  const item: LkItem = {
    slug: null, genres: [], title: null, rating: null, ratingCount: null, year: null, isSeries: false,
  };
  const href = block.match(/<a href="\/([^\/?"]+)"/);
  item.slug = href ? href[1] : null;
  let m = block.match(/<meta itemprop="genre" content="([^"]+)"/)
    || block.match(/<div class="genre">([\s\S]*?)<\/div>/);
  item.genres = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  m = block.match(/<h3 class="poster-title"[^>]*>([\s\S]*?)<\/h3>/);
  item.title = m ? decodeEntities(m[1].replace(/<[^>]*>/g, '')).trim() : null;
  m = block.match(/itemprop="ratingValue">([\s\S]*?)<\/span>/)
    || block.match(/<span class="rating">[\s\S]*?<\/i>([\s\S]*?)<\/span>/);
  item.rating = m ? m[1].trim() : null;
  m = block.match(/itemprop="ratingCount" content="([^"]+)"/);
  item.ratingCount = m ? m[1] : null;
  m = block.match(/class="year"[^>]*>([\s\S]*?)<\/span>/);
  item.year = m ? m[1].trim() : null;
  item.isSeries = /class="episode/.test(block);
  return item;
}

function parseList(html: string, idHint?: string): LkItem[] {
  let region = html;
  if (idHint) {
    const start = html.indexOf('id="' + idHint + '"');
    if (start !== -1) {
      const end = html.indexOf('id="adHome5"', start);
      region = html.slice(start, end === -1 ? start + 500000 : end);
    }
  }
  return [...region.matchAll(/<article[\s\S]*?<\/article>/g)].map((m) => parseItem(m[0]));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getCompleteList(): Promise<LkItem[]> {
  const items = new Map<string, LkItem>();
  const home = await fetchPage(BASE + '/');
  for (const it of parseList(home, 'post-container')) if (it.slug) items.set(it.slug, it);

  for (let page = 2; ; page++) {
    let text: string;
    try {
      text = await fetchPage(BASE + '/loadmore-home/page/' + page);
    } catch {
      break; // 404 or WAF = end of pagination
    }
    if (!text.trim()) break;
    const parsed = parseList(text);
    if (!parsed.length) break;
    for (const it of parsed) if (it.slug) items.set(it.slug, it);
    await sleep(500);
  }
  return [...items.values()];
}

function parseSectionItems(html: string): LkItem[] {
  const ul = html.match(/<ul class="sliders"[\s\S]*?<\/ul>/);
  if (!ul) return [];
  return [...ul[0].matchAll(/<li class="slider"[\s\S]*?<\/li>/g)].map((m) => parseItem(m[0]));
}

async function getSections(): Promise<Array<{ section: string; items: LkItem[] }>> {
  const home = await fetchPage(BASE + '/');
  const marks = [...home.matchAll(/<div class="widget"[^>]*>/g)].map((m) => m.index!);
  const sections: Array<{ section: string; items: LkItem[] }> = [];

  for (let i = 0; i < marks.length; i++) {
    const start = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1] : home.indexOf('<footer', start);
    const slice = home.slice(start, end === -1 ? home.length : end);
    const h = slice.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const sectionName = h ? decodeEntities(h[1].replace(/<[^>]*>/g, '')).trim() : `section-${i + 1}`;
    const items = parseSectionItems(slice);
    if (items.length) sections.push({ section: sectionName, items });
  }
  return sections;
}

function parseDetail(html: string, item: LkItem): LkItem {
  const d: LkItem = { ...item };
  let m = html.match(/<div class="wp-content"[^>]*>([\s\S]*?)<\/div>/);
  if (m) d.description = decodeEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 2000) || null;
  m = html.match(/itemprop="duration"[^>]*>([\s\S]*?)</) || html.match(/class="duration"[^>]*>([\s\S]*?)</);
  d.duration = m ? m[1].trim() : null;
  m = html.match(/itemprop="director"[^>]*>([\s\S]*?)</) || html.match(/class="director"[^>]*>([\s\S]*?)</);
  d.director = m ? decodeEntities(m[1].replace(/<[^>]*>/g, '')).trim() : null;
  m = html.match(/itemprop="actor"[^>]*>([\s\S]*?)</);
  d.stars = m ? decodeEntities(m[1].replace(/<[^>]*>/g, '')).trim() : null;
  m = html.match(/class="country"[^>]*>([\s\S]*?)</);
  d.country = m ? decodeEntities(m[1].replace(/<[^>]*>/g, '')).trim() : null;
  d.trailer = html.match(/<iframe[^>]+src="([^"]*youtube[^"]*)"/i)?.[1] || null;
  const links = [...html.matchAll(/<a[^>]+href="([^"]*(?:otakudesu|link|download)[^"]*)"/gi)].map((x) => x[1]);
  d.downloadLinks = [...new Set(links)].slice(0, 30);
  return d;
}

async function getDetail(slug: string): Promise<LkItem> {
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error('Invalid slug (a-z 0-9 - only)');
  const html = await fetchPage(BASE + '/' + slug + '/');
  return parseDetail(html, { slug, genres: [], title: null, rating: null, ratingCount: null, year: null, isSeries: false });
}

if (import.meta.main) {
  defineCli({
    name: 'lk21',
    title: 'LK21 Scraper (tv12.lk21official.cc)',
    commands: {
      list: {
        desc: 'Seluruh daftar lengkap film terbaru',
        run: async () => getCompleteList(),
      },
      sections: {
        desc: 'Semua bagian di halaman utama (terbaru, rekomendasi, dll)',
        run: async () => getSections(),
      },
      detail: {
        desc: 'Detail satu film', usage: '<slug>',
        run: async (p) => {
          if (!p[0]) throw new Error('Slug required (e.g. night-nurse-2026)');
          return getDetail(p[0].trim());
        },
      },
      'list-detail': {
        desc: 'Daftar lengkap + detail tiap film (SLOW)',
        run: async () => {
          const list = await getCompleteList();
          const result = [];
          for (let i = 0; i < list.length; i++) {
            const it = list[i];
            try {
              result.push(await getDetail(it.slug!));
            } catch (e) {
              result.push({ ...it, status: 'error', message: (e as Error).message });
            }
            process.stderr.write(`[${i + 1}/${list.length}] ${it.title}\n`);
            await sleep(500);
          }
          return result;
        },
      },
    },
    examples: `  bun lk21.ts detail night-nurse-2026
  bun lk21.ts sections`,
  });
}

// site is behind Cloudflare challenge as of 2026-09-10 — plain fetch gets 403 "Just a moment"
void site;

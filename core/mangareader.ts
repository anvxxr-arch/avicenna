/**
 * core/mangareader.ts — shared reference implementation of the Themesia
 * "mangareader" WordPress theme (mangasusuku.com, kanzenin.info, 02.ngomik.cc).
 * The Go port (scrapers/mangareader.go) is diffed against this file: payload
 * key shapes match command for command.
 */
import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { defineCli } from './cli';
import type { CommandDef } from './cli';
import { createSite } from './fetch';
import type { Site } from './fetch';

declare const process: { argv: string[]; exit(code?: number): void };

export interface MangaReaderConfig {
  name: string;
  title: string;
  base: string;
  /** Series URL prefix: "/komik/" (mangasusuku) or "/manga/" (kanzenin, ngomik). */
  seriesPath: string;
  /** A-Z directory path, or '' when the skin has none (ngomik). */
  azPath: string;
  examples?: string;
}

type Rec = Record<string, unknown>;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SITE_HEADERS: Record<string, string> = { 'user-agent': UA, 'accept-language': 'id-ID,id;q=0.9,en;q=0.8' };
const SLUG_RE = /^[a-z0-9-]+$/;
const GENRE_RE = /\/genres\/([^/]+)\//;
const DIGITS_RE = /^\d+$/;
const AZ_RE = /^(\.|0-9|[A-Za-z])$/;

/** Whitespace-collapsed, UTF-16-capped text (mirrors Txt() in scrapers/transport.go). */
function txt(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Digits and dots only (mirrors Num() in scrapers/transport.go). */
function num(s: string): string {
  return s.replace(/[^0-9.]/g, '');
}

/** Strict integer parse of the numeric core of a token, or null. */
function int(s: string): number | null {
  const n = Number(num(s));
  return Number.isInteger(n) ? n : null;
}

// ngomik runs PageSpeed: src becomes a /pagespeed_static/ placeholder and the
// real URL lives in data-pagespeed-lazy-src — attribute preference matters.
function img(sel: Cheerio<AnyNode>): string {
  if (!sel || !sel.length) return '';
  for (const attr of ['data-pagespeed-lazy-src', 'data-src', 'data-original', 'src']) {
    const v = (sel.attr(attr) || '').trim();
    if (v === '' || v.startsWith('data:') || v.startsWith('javascript:') || v.includes('pagespeed_static')) continue;
    return v;
  }
  return '';
}

/** span.type.<T> badge (e.g. `<span class="type Manhwa">` → "Manhwa"). */
function typeBadge(sel: Cheerio<AnyNode>): string {
  for (const c of (sel.find('span.type').first().attr('class') || '').split(/\s+/)) {
    if (c !== '' && c !== 'type') return c;
  }
  return '';
}

/**
 * Brace scan (string aware, so `}` inside string literals cannot end the object
 * early) over the `ts_reader.run({...})` payload of a chapter page. A scan beats
 * a regex here because the payload nests objects.
 */
export function tsReader(html: string): Rec | null {
  const marker = 'ts_reader.run(';
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf('{', i + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, k + 1)) as Rec;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function createMangaReaderCli(cfg: MangaReaderConfig): void {
  const site: Site = createSite({ base: cfg.base, rateMs: 500, headers: SITE_HEADERS });

  // Envelope + cleaner, verbatim from the other TS reference CLIs.
  function clean(obj: unknown): unknown {
    if (obj === null || obj === undefined) return undefined;
    if (Array.isArray(obj)) return obj.map((i) => clean(i)).filter((v) => v !== undefined);
    if (typeof obj === 'object') {
      const result: Rec = {};
      for (const key of Object.keys(obj as Rec)) {
        const val = clean((obj as Rec)[key]);
        if (val !== undefined && val !== null && !(Array.isArray(val) && val.length === 0)) result[key] = val;
      }
      return Object.keys(result).length ? result : undefined;
    }
    return obj;
  }
  function build(page: string, url: string, data: Rec): Rec {
    return clean({ creator: 'avicenna', page, url, data }) as Rec;
  }

  async function fetchHTML(rawURL: string): Promise<string> {
    const res = await site.request(site.sanitizeUrl(rawURL), { headers: SITE_HEADERS, follow: true });
    if (!res.ok) throw new Error(`HTTP ${res.status} untuk ${rawURL}`);
    return (await res.text()).replace(/^\uFEFF/, '');
  }

  // `x.startsWith('http') ? x : BASE_URL + x` (mirrors mrAbs in the Go port).
  function abs(raw: string): string {
    if (raw === '') return '';
    return raw.startsWith('http') ? raw : cfg.base + raw;
  }

  function parseCard($: CheerioAPI, el: AnyNode): Rec | null {
    const $el = $(el);
    const $a = $el.find('a').first();
    const href = $a.attr('href') || '';
    let title = txt($el.find('.tt').first().text(), 200);
    if (title === '') title = txt($a.attr('title') || '', 200);
    if (href === '' || title === '') return null;
    const card: Rec = { title, url: abs(href) };
    const cover = img($el.find('img').first());
    if (cover !== '') card.image = abs(cover);
    const type = typeBadge($el);
    if (type !== '') card.type = type;
    if ($el.find('span.colored').length > 0) card.colored = true;
    if ($el.find('span.hotx').length > 0) card.hot = true;
    const latest = txt($el.find('.epxs').first().text(), 60);
    if (latest !== '') card.latest = latest;
    const score = txt($el.find('.numscore').first().text(), 10);
    if (score !== '') card.score = score;
    return card;
  }

  function cards($: CheerioAPI, sel: Cheerio<AnyNode>): Rec[] {
    const items: Rec[] = [];
    sel.each((_i, el) => {
      const card = parseCard($, el);
      if (card) items.push(card);
    });
    return items;
  }

  // .pagination block: .page-numbers.current, highest numeric slot, a.next link.
  function pagination($: CheerioAPI, $pag: Cheerio<AnyNode>): Rec {
    const out: Rec = { current: 1, hasNext: false };
    if (!$pag || !$pag.length) return out;
    const cur = int(txt($pag.find('.page-numbers.current').first().text(), 8));
    let total = 0;
    $pag.find('.page-numbers').each((_i, el) => {
      const t = txt($(el).text(), 8);
      if (!DIGITS_RE.test(t)) return;
      const n = Number(t);
      if (n > total) total = n;
    });
    const next = abs($pag.find('a.next').attr('href') || '');
    out.current = cur !== null && cur > 0 ? cur : 1;
    if (total > 0) out.total = total;
    if (next !== '') {
      out.next = next;
      out.hasNext = true;
    } else if (total > 0 && (out.current as number) < total) {
      out.hasNext = true;
    }
    return out;
  }

  // table.infotable (older skins) and .tsinfo .imptdt (ngomik) → label→value.
  function info($: CheerioAPI): Record<string, string> {
    const out: Record<string, string> = {};
    $('table.infotable tr').each((_i, el) => {
      const $tr = $(el);
      const k = txt($tr.find('td').first().text(), 40).toLowerCase();
      const v = txt($tr.find('td').eq(1).text(), 200);
      if (k !== '' && v !== '' && v !== '?') out[k] = v;
    });
    $('.tsinfo .imptdt').each((_i, el) => {
      const $d = $(el);
      let $val = $d.find('i').first();
      if (!$val.length) $val = $d.find('a').first();
      if (!$val.length) $val = $d.find('span').first();
      const v = txt($val.text(), 200);
      const full = txt($d.text(), 300);
      const k = full.slice(0, Math.max(0, full.length - v.length)).trim().toLowerCase();
      if (k !== '' && v !== '' && v !== '?') out[k] = v;
    });
    return out;
  }

  // time[itemprop=<prop>][datetime] (older skins) or meta[itemprop][content].
  function machineTime($: CheerioAPI, prop: string): string {
    const dt = $(`time[itemprop="${prop}"]`).first().attr('datetime');
    if (dt) return dt;
    return $(`meta[itemprop="${prop}"]`).first().attr('content') || '';
  }

  async function home(page: number): Promise<Rec> {
    const u = page > 1 ? `${cfg.base}/page/${page}/` : `${cfg.base}/`;
    const $ = cheerio.load(await fetchHTML(u));
    const sections: Rec[] = [];
    $('.bixbox').each((_i, el) => {
      const $box = $(el);
      const title = txt($box.find('.releases h2, .releases h1').first().text(), 80);
      const items = cards($, $box.find('.listupd .bsx'));
      if (title === '' || items.length === 0) return;
      sections.push({ title, items });
    });
    return build('home', u, { sections, pagination: pagination($, $('.pagination').first()) });
  }

  async function search(query: string): Promise<Rec> {
    if (query === '') throw new Error('Query required');
    const u = `${cfg.base}/?s=${encodeURIComponent(query)}`;
    const $ = cheerio.load(await fetchHTML(u));
    return build('search', u, {
      query,
      items: cards($, $('.postbody .listupd .bsx')),
      pagination: pagination($, $('.pagination').first()),
    });
  }

  // Genre index page (ngomik's .taxindex); older skins have none, so their
  // homepage menu links fill the gap.
  async function genreList(): Promise<Rec> {
    const u = `${cfg.base}/genres/`;
    const genres: Rec[] = [];
    const seen = new Set<string>();
    try {
      const $ = cheerio.load(await fetchHTML(u));
      $('.taxindex li a').each((_i, el) => {
        const $a = $(el);
        const name = txt($a.find('span').first().text(), 60) || txt($a.text(), 60);
        const href = $a.attr('href') || '';
        const loc = href.match(GENRE_RE);
        if (name === '' || !loc || seen.has(loc[1])) return;
        seen.add(loc[1]);
        const g: Rec = { name, slug: loc[1], url: abs(href) };
        const n = int(txt($a.find('i').first().text(), 8));
        if (n !== null && n > 0) g.count = n;
        genres.push(g);
      });
    } catch { /* no index page on the older skins */ }
    if (genres.length === 0) {
      const $ = cheerio.load(await fetchHTML(`${cfg.base}/`));
      $('a[href*="/genres/"]').each((_i, el) => {
        const $a = $(el);
        const name = txt($a.text(), 60);
        const href = $a.attr('href') || '';
        const loc = href.match(GENRE_RE);
        if (name === '' || !loc || seen.has(loc[1])) return;
        seen.add(loc[1]);
        genres.push({ name, slug: loc[1], url: abs(href) });
      });
    }
    return build('genreList', u, { genres });
  }

  async function genre(slug: string, page: number): Promise<Rec> {
    if (!SLUG_RE.test(slug)) throw new Error('Invalid slug (a-z 0-9 - only)');
    const u = page > 1 ? `${cfg.base}/genres/${slug}/page/${page}/` : `${cfg.base}/genres/${slug}/`;
    const $ = cheerio.load(await fetchHTML(u));
    return build('genre', u, {
      genre: slug,
      items: cards($, $('.postbody .listupd .bsx')),
      pagination: pagination($, $('.pagination').first()),
    });
  }

  // A-Z directory: letter tabs (.lista a) plus one letter's series links.
  async function azList(letter: string): Promise<Rec> {
    if (!AZ_RE.test(letter)) throw new Error('Invalid letter (A-Z, 0-9 or . only)');
    const u = `${cfg.base}${cfg.azPath}?show=${encodeURIComponent(letter)}`;
    const $ = cheerio.load(await fetchHTML(u));
    const letters: Rec[] = [];
    $('.lista a').each((_i, el) => {
      const $a = $(el);
      const label = txt($a.text(), 4);
      const href = $a.attr('href') || '';
      const q = href.indexOf('show=');
      const show = q >= 0 ? href.slice(q + 5) : '';
      if (label === '' || show === '') return;
      letters.push({ label, show });
    });
    const items: Rec[] = [];
    const seen = new Set<string>();
    $('.postbody a').each((_i, el) => {
      const $a = $(el);
      const href = $a.attr('href') || '';
      const title = txt($a.text(), 200);
      if (title === '' || !href.includes(cfg.seriesPath)) return;
      const url = abs(href);
      if (seen.has(url)) return;
      seen.add(url);
      items.push({ title, url });
    });
    return build('azList', u, { letter, letters, items });
  }

  async function detail(slug: string): Promise<Rec> {
    if (!SLUG_RE.test(slug)) throw new Error('Invalid slug (a-z 0-9 - only)');
    let u = `${cfg.base}${cfg.seriesPath}${slug}/`;
    const $ = cheerio.load(await fetchHTML(u));
    const canonical = $('link[rel="canonical"]').first().attr('href');
    if (canonical) u = canonical;
    const data: Rec = { title: txt($('h1.entry-title').first().text(), 200) || txt($('h1').first().text(), 200), slug };
    const alts = txt($('.seriestualt').first().text(), 500).split(',').map((p) => p.trim()).filter((p) => p !== '');
    if (alts.length > 0) data.altTitles = alts;
    const cover = img($('.thumb img').first());
    if (cover !== '') data.cover = abs(cover);
    const inf = info($);
    for (const key of ['status', 'type', 'released', 'author', 'artist', 'serialization']) {
      if (inf[key]) data[key] = inf[key];
    }
    if (inf['posted by']) data.postedBy = inf['posted by'];
    const postedOn = machineTime($, 'datePublished') || inf['posted on'];
    if (postedOn) data.postedOn = postedOn;
    const updatedOn = machineTime($, 'dateModified') || inf['updated on'];
    if (updatedOn) data.updatedOn = updatedOn;
    if (inf.views && DIGITS_RE.test(inf.views)) data.views = Number(inf.views);
    const followers = int(txt($('.bmc').first().text(), 40));
    if (followers !== null && followers > 0) data.followers = followers;
    const score = $(`[itemprop="ratingValue"]`).first().attr('content') || txt($('.rating .numscore, .numscore, .rating .num').first().text(), 10);
    if (score !== '') data.score = score;
    const genres: Rec[] = [];
    const seenGenre = new Set<string>();
    $('.seriestugenre a[rel="tag"], .mgen a[rel="tag"]').each((_i, el) => {
      const $a = $(el);
      const name = txt($a.text(), 40);
      const loc = ($a.attr('href') || '').match(GENRE_RE);
      if (name === '' || !loc || seenGenre.has(loc[1])) return;
      seenGenre.add(loc[1]);
      genres.push({ name, slug: loc[1], url: abs($a.attr('href') || '') });
    });
    if (genres.length > 0) data.genres = genres;
    const synopsis = txt($('[itemprop="description"]').first().text(), 5000);
    if (synopsis !== '') data.synopsis = synopsis;
    $('.lastend .inepcx').each((_i, el) => {
      const $box = $(el);
      const label = txt($box.find('span').first().text(), 20).toLowerCase();
      const title = txt($box.find('.epcur').first().text(), 80);
      if (title === '') return;
      const entry: Rec = { title };
      const href = $box.find('a').first().attr('href') || '';
      if (href !== '' && !href.startsWith('#')) entry.url = abs(href);
      if (label.startsWith('first')) data.firstChapter = entry;
      else if (label.startsWith('latest')) data.latestChapter = entry;
    });
    const chapters: Rec[] = [];
    $('.eplister li').each((_i, el) => {
      const $li = $(el);
      let $a = $li.find('.eph-num a').first();
      if (!$a.length) $a = $li.find('a').first();
      const href = $a.attr('href') || '';
      const title = txt($li.find('.chapternum').first().text(), 80) || txt($a.text(), 80);
      if (href === '' || title === '') return;
      const ch: Rec = { title, url: abs(href) };
      const n = int($li.attr('data-num') || '');
      if (n !== null && n > 0) ch.number = n;
      const date = txt($li.find('.chapterdate').first().text(), 40);
      if (date !== '') ch.date = date;
      chapters.push(ch);
    });
    if (chapters.length > 0) data.chapters = chapters;
    return build('detail', u, data);
  }

  async function chapter(slug: string): Promise<Rec> {
    if (!SLUG_RE.test(slug)) throw new Error('Invalid slug (a-z 0-9 - only)');
    const u = `${cfg.base}/${slug}/`;
    const html = await fetchHTML(u);
    const $ = cheerio.load(html);
    const data: Rec = { title: txt($('h1.entry-title').first().text(), 200) || txt($('.headpost h1').first().text(), 200), slug };
    const $series = $('.allc a').first();
    if ($series.length) data.series = { title: txt($series.text(), 200), url: abs($series.attr('href') || '') };
    let images: string[] | null = null;
    const servers: Rec[] = [];
    const payload = tsReader(html);
    if (payload) {
      for (const raw of (payload.sources as Rec[] | undefined) || []) {
        const imgs = ((raw.images as string[] | undefined) || []).filter((s) => typeof s === 'string' && s !== '');
        if (imgs.length === 0) continue;
        servers.push({ name: raw.source ?? '', images: imgs });
        if (images === null) images = imgs;
      }
      const prev = payload.prevUrl as string | undefined;
      if (prev) data.prevUrl = abs(prev);
      const next = payload.nextUrl as string | undefined;
      if (next) data.nextUrl = abs(next);
      const mode = payload.mode as string | undefined;
      if (mode) data.mode = mode;
    }
    if (images === null) {
      const fallback: string[] = [];
      $('#readerarea img').each((_i, el) => {
        const src = img($(el));
        if (src !== '') fallback.push(abs(src));
      });
      images = fallback;
    }
    if (images.length > 0) data.images = images;
    if (servers.length > 0) data.servers = servers;
    return build('chapter', u, data);
  }

  function supported(): Rec {
    return build('supportedPages', `${cfg.base}/`, {
      home: true, search: true, genreList: true, genre: true,
      azList: cfg.azPath !== '', detail: true, chapter: true,
    });
  }

  const commands: Record<string, CommandDef> = {
    home: { desc: 'Section homepage (rilisan terbaru, populer, …)', usage: '[page]', run: async (p) => home(Number(p[0]) || 1) },
    search: { desc: 'Cari komik', usage: '<query>', run: async (p) => search(p.join(' ')) },
    genrelist: { desc: 'Daftar genre', run: async () => genreList() },
    genre: {
      desc: 'Komik per genre', usage: '<slug> [page]',
      run: async (p) => {
        if (!p[0]) throw new Error('Genre slug required');
        return genre(p[0], Number(p[1]) || 1);
      },
    },
    detail: {
      desc: 'Detail komik + daftar chapter', usage: '<slug>',
      run: async (p) => {
        if (!p[0]) throw new Error('Series slug required');
        return detail(p[0]);
      },
    },
    chapter: {
      desc: 'Chapter + daftar gambar', usage: '<slug>',
      run: async (p) => {
        if (!p[0]) throw new Error('Chapter slug required');
        return chapter(p[0]);
      },
    },
    supported: { desc: 'List supported pages/features', run: () => supported() },
  };
  if (cfg.azPath !== '') {
    commands.azlist = {
      desc: 'A-Z list (per huruf)', usage: '<letter>',
      run: async (p) => {
        if (!p[0]) throw new Error('Letter required (A-Z, 0-9 or .)');
        return azList(p[0]);
      },
    };
  }

  defineCli({ name: cfg.name, title: cfg.title, commands, examples: cfg.examples });
}

#!/usr/bin/env bun
/*
- base : https://v2.samehadaku.how
- creator : avicenna
- Samehadaku (Eastheme/WordPress "eastplay" theme) — home, search, list, detail, episode, batch.
- NOTE: the site is behind a Cloudflare managed challenge (like lk21). Plain HTTP clients
  get "Just a moment..." (HTTP 403), so live runs need a challenge-solving session; the
  parsers are verified offline against tools/fixtures/samehadaku/*.html, which are real
  (single) captures of each page, and live when cookies from such a session are supplied
  through the shared transport (SAMEHADAKU_COOKIE).
- Endpoints
  home     [page]                     Latest anime cards + latest-episode feed
  search   <query>                    /?s=<query>
  list     [page]                     /anime-terbaru/ paginated catalogue
  detail   <slug|url>                 anime page: info, genres, rating, episode list, batch links
  episode  <slug|url>                 episode page: mirrors (AJAX) + download links + navigation
  batch    <slug|url>                 batch page: download groups
  mirrors  <slug|url> [nume]          player_ajax mirror embeds only
*/
import { defineCli } from './core/cli';
import { createSite } from './core/fetch';
import { safeCheerio, txt } from './core/parse';
import type { CheerioAPI } from './core/parse';

// Base is overridable so the parsers can be verified against a local fixture host
// (the live site is behind a Cloudflare challenge — same situation as lk21).
const BASE = (process.env.SAMEHADAKU_BASE || 'https://v2.samehadaku.how').replace(/\/$/, '');
const CREATOR = 'avicenna';

const site = createSite({
  base: BASE,
  rateMs: 450,
  headers: {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(process.env.SAMEHADAKU_COOKIE ? { cookie: process.env.SAMEHADAKU_COOKIE } : {}),
  },
});
const { fetchPage, postAjax } = site;

type Rec = Record<string, unknown>;

const abs = (href: string | null | undefined): string | null =>
  href ? (href.startsWith('http') ? href : BASE + (href.startsWith('/') ? href : '/' + href)) : null;

/** Page title without the trailing site suffix. */
function pageTitle($: CheerioAPI): string {
  return txt(($('title').first().text() || '').replace(/\s*[–|-]\s*Samehadaku\s*$/i, ''), 200);
}
const RELEASED_ON_RE = /.*Released on:\s*/i;
const VIEWS_RE = /\s*Views.*/i;
const PAGE_OF_RE = /of\s+(\d+)/i;

/** One `div.post-show li` card (home / anime-terbaru / search fallback). */
function parsePostShowCard($: CheerioAPI, el: unknown): Rec | null {
  const $el = $(el as never);
  const a = $el.find('h2.entry-title a').first();
  const url = abs(a.attr('href'));
  if (!url) return null;
  const title = txt(a.text(), 200);
  const episode = txt($el.find('author[itemprop="name"]').first().text(), 40);
  const postedBy = txt($el.find('span.author author[itemprop="name"], span.author').first().text(), 60);
  const released = txt(
    $el
      .find('span')
      .filter((_, s) => /Released on/i.test($(s).text()))
      .first()
      .text()
      .replace(RELEASED_ON_RE, ''),
    60,
  );
  return {
    title,
    slug: slugOf(url),
    url,
    poster: $el.find('img').first().attr('src') || null,
    ...(episode ? { episode } : {}),
    ...(postedBy ? { postedBy } : {}),
    ...(released ? { releasedOn: released } : {}),
  };
}

/** One search-result card. The site renamed the class `animpost` → `animepost`; both are accepted. */
function parseAnimpostCard($: CheerioAPI, el: unknown): Rec | null {
  const $el = $(el as never);
  const a = $el.find('a[href*="/anime/"]').first();
  const url = abs(a.attr('href'));
  if (!url) return null;
  const genres = $el
    .find('.genres .mta a')
    .map((_, g) => txt($(g).text(), 40))
    .get()
    .filter(Boolean);
  return {
    title: txt(a.attr('title') || a.text(), 200),
    slug: slugOf(url),
    url,
    poster: $el.find('img.anmsa').first().attr('src') || null,
    type: txt($el.find('.content-thumb .type').first().text(), 30) || null,
    score: txt($el.find('.content-thumb .score').first().text().replace(/[^\d.]/g, ''), 12) || null,
    status: txt($el.find('.data .type').first().text(), 30) || null,
    views: txt(($el.find('.metadata span').filter((_, s) => /Views/i.test($(s).text())).first().text() || '').replace(VIEWS_RE, ''), 20) || null,
    ...(genres.length ? { genres } : {}),
  };
}

/** Search-result card selector. The site renamed `animpost` → `animepost`; accept both. */
const SH_SEARCH_CARD = 'article.animpost, article.animepost';

/** `?s=` search: results + the "Results found" count. */
async function search(query: string): Promise<Rec> {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (q.length < 2) throw new Error('Query too short');
  const url = `${BASE}/?s=${encodeURIComponent(q)}`;
  const $ = safeCheerio(await fetchPage(url));
  const results: Rec[] = [];
  $(SH_SEARCH_CARD).each((_, el) => {
    const c = parseAnimpostCard($, el);
    if (c) results.push(c);
  });
  return { query: q, url, count: results.length, results };
}

/** Home: post-show cards + the "Latest Episode" feed. */
async function home(page = 1): Promise<Rec> {
  const p = Math.min(50, Math.max(1, Math.floor(page) || 1));
  const url = p === 1 ? BASE + '/' : `${BASE}/page/${p}/`;
  const $ = safeCheerio(await fetchPage(url));
  const cards: Rec[] = [];
  $('div.post-show li').each((_, el) => {
    const c = parsePostShowCard($, el);
    if (c) cards.push(c);
  });
  // On this theme the "Latest Episode" rail is the same post-show card list, so
  // the feed is the subset of cards carrying an episode number.
  const latest = cards
    .filter((c) => typeof c.episode === 'string' && c.episode !== '')
    .map((c) => ({
      title: c.title,
      url: c.url,
      slug: c.slug,
      episode: c.episode,
      releasedOn: c.releasedOn ?? null,
    }));
  return { creator: CREATOR, page: p, url, count: cards.length, cards, latestEpisode: latest.slice(0, 20) };
}

/** Paginated catalogue: /anime-terbaru/. */
async function list(page = 1): Promise<Rec> {
  const p = Math.min(50, Math.max(1, Math.floor(page) || 1));
  const url = p === 1 ? `${BASE}/anime-terbaru/` : `${BASE}/anime-terbaru/page/${p}/`;
  const $ = safeCheerio(await fetchPage(url));
  const items: Rec[] = [];
  $('div.post-show li').each((_, el) => {
    const c = parsePostShowCard($, el);
    if (c) items.push(c);
  });
  const pageInfo = txt($('.pagination span').first().text(), 40);
  const [, totalPage] = PAGE_OF_RE.exec(pageInfo) || [];
  return {
    creator: CREATOR,
    url,
    page: p,
    totalPages: totalPage ? Number(totalPage) : null,
    count: items.length,
    items,
  };
}

const slugOf = (raw: string): string =>
  String(raw || '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .pop() || '';

/** Detail: info block, genre list, rating, episode list, batch links. */
async function detail(rawSlug: string): Promise<Rec> {
  const slug = slugOf(rawSlug);
  if (!slug) throw new Error('Slug required');
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error('Invalid slug (a-z 0-9 - only)');
  const url = `${BASE}/anime/${slug}/`;
  const $ = safeCheerio(await fetchPage(url));
  const info = $('.infoanime');
  const title = txt(info.find('h2.entry-title, h1.entry-title').first().text(), 200) || pageTitle($);
  const rating = txt(info.find('[itemprop="ratingValue"]').first().text(), 12) || null;

  const sinopsis = txt(
    $('.infoanime .desc, .infoanime .entry-content, .desc p').first().text().replace(/\s+/g, ' '),
    1200,
  );

  const details: Rec = {};
  info.find('.spe span').each((_, s) => {
    const raw = $(s).text().replace(/\s+/g, ' ').trim();
    const i = raw.indexOf(':');
    if (i > 0) details[txt(raw.slice(0, i), 40)] = txt(raw.slice(i + 1), 200);
  });
  const genreInfo = $('.genre-info a, .infoanime .genre-info a')
    .map((_, g) => txt($(g).text(), 40))
    .get()
    .filter(Boolean);

  const episodes: Rec[] = [];
  $('.lstepsiode.listeps li').each((_, el) => {
    const $el = $(el);
    const a = $el.find('.lchx a, a').first();
    const href = abs(a.attr('href'));
    if (!href) return;
    episodes.push({
      episode: txt($el.find('.eps a').first().text(), 12) || null,
      title: txt(a.text(), 160),
      url: href,
      date: txt($el.find('.date').first().text(), 40) || null,
    });
  });

  const batches: Array<{ title: string; url: string }> = [];
  $('.listbatch a').each((_, el) => {
    const href = abs($(el).attr('href'));
    if (href) batches.push({ title: txt($(el).text(), 160), url: href });
  });

  return {
    creator: CREATOR,
    url,
    slug,
    title,
    poster: info.find('img.anmsa, .thumb img').first().attr('src') || null,
    rating,
    genres: genreInfo,
    details,
    ...(sinopsis ? { sinopsis } : {}),
    episodeCount: episodes.length,
    episodes,
    ...(batches.length ? { batches } : {}),
  };
}

/** `mirrors <slug> [nume]`: the player_ajax response for one mirror. */
async function mirrors(rawSlug: string, nume = 1): Promise<Rec> {
  const slug = slugOf(rawSlug);
  if (!slug) throw new Error('Slug required');
  const url = `${BASE}/${slug}/`.replace('/anime/', '/');
  const $ = safeCheerio(await fetchPage(url));
  const options: Rec[] = [];
  $('#server .east_player_option, .east_player_option').each((_, el) => {
    const $el = $(el);
    options.push({
      nume: Number($el.attr('data-nume') || 0),
      name: txt($el.find('span').first().text(), 60),
      post: $el.attr('data-post') || null,
      type: $el.attr('data-type') || null,
    });
  });
  const post = options[0]?.post as string | undefined;
  if (!post) throw new Error('No player options on this page');
  const n = Number.isFinite(nume) ? Math.floor(nume) : 1;
  const body = `action=player_ajax&post=${encodeURIComponent(String(post))}&nume=${n}&type=schtml`;
  const raw = await postAjax('/wp-admin/admin-ajax.php', body);
  return { slug, post, nume: n, server: options.find((o) => Number(o.nume) === n)?.name ?? null, options, embed: raw.trim() };
}

/** `episode <slug>`: mirrors + download groups + navigation. */
async function episode(rawSlug: string): Promise<Rec> {
  const slug = slugOf(rawSlug);
  if (!slug) throw new Error('Slug required');
  const url = `${BASE}/${slug}/`.replace('/anime/', '/');
  const $ = safeCheerio(await fetchPage(url));

  const players: Rec[] = [];
  $('#server .east_player_option, .east_player_option').each((_, el) => {
    const $el = $(el);
    players.push({
      nume: Number($el.attr('data-nume') || 0),
      name: txt($el.find('span').first().text(), 60),
      post: $el.attr('data-post') || null,
    });
  });

  // `<div class="download-eps"><p><b>label</b></p><ul><li><strong>quality</strong><span><a>server</a>…`
  const downloadable: Array<{ label: string; entries: Array<{ quality: string; servers: Array<{ name: string; url: string }> }> }> = [];
  $('#downloadb').each((_, block) => {
    const $block = $(block);
    let label = '';
    $block.children('p, h4, h3').each((__, p) => {
      if (!label) label = txt($(p).text(), 80);
    });
    const entries: Array<{ quality: string; servers: Array<{ name: string; url: string }> }> = [];
    $block.find('ul li').each((__, li) => {
      const $li = $(li);
      const servers: Array<{ name: string; url: string }> = [];
      $li.find('a').each((___, a) => {
        const href = $(a).attr('href');
        if (href) servers.push({ name: txt($(a).text(), 40), url: href });
      });
      if (servers.length) entries.push({ quality: txt($li.find('strong').first().text(), 24), servers });
    });
    if (entries.length) downloadable.push({ label, entries });
  });

  // .naveps = [prev] [All Episode] [next]; a `nonex` class marks a missing neighbour.
  const $nav = $('.naveps .nvs');
  const prevHref = $nav.first().find('a').attr('href');
  const nextHref = $nav.last().find('a').attr('href');
  const hasNext = !$nav.last().find('a').hasClass('nonex') && !!nextHref && nextHref !== '#';

  return {
    creator: CREATOR,
    url,
    slug,
    title: txt($('h1.entry-title').first().text(), 200) || pageTitle($),
    anime: (() => {
      const a = $('.naveps a').filter((_, x) => /\/anime\//.test($(x).attr('href') || '')).first();
      const href = abs(a.attr('href'));
      if (!href) return null;
      const label = txt(a.text(), 160);
      // The back-link reads "All Episode"; only a real title is worth reporting.
      const title = /^all episode$/i.test(label) ? null : label || null;
      return { title, slug: slugOf(href), url: href };
    })(),
    players,
    downloads: downloadable,
    prev: prevHref ? { slug: slugOf(prevHref), url: abs(prevHref) } : null,
    next: hasNext ? { slug: slugOf(nextHref), url: abs(nextHref) } : null,
    embed: $('#player_embed iframe, #player iframe, iframe[src*="blogger"], iframe[src*="youtube"]').first().attr('src') || null,
  };
}

/** `batch <slug>`: batch download groups. */
async function batch(rawSlug: string): Promise<Rec> {
  const slug = slugOf(rawSlug);
  if (!slug) throw new Error('Slug required');
  const url = `${BASE}/batch/${slug}/`;
  const $ = safeCheerio(await fetchPage(url));
  const groups: Array<{ label: string; entries: Array<{ quality: string; servers: Array<{ name: string; url: string }> }> }> = [];
  $('#downloadb').each((_, block) => {
    const $block = $(block);
    const label = txt($block.find('> p b, > p').first().text(), 80);
    const entries: Array<{ quality: string; servers: Array<{ name: string; url: string }> }> = [];
    let current: { quality: string; servers: Array<{ name: string; url: string }> } = { quality: '', servers: [] };
    $block.find('ul li').each((__, li) => {
      const $li = $(li);
      const quality = txt($li.find('strong').first().text(), 24);
      if (quality !== current.quality) {
        current = { quality, servers: [] };
        entries.push(current);
      }
      $li.find('a').each((___, a) => {
        const href = $(a).attr('href');
        if (href) current.servers.push({ name: txt($(a).text(), 40), url: href });
      });
    });
    if (entries.length) groups.push({ label, entries });
  });
  return {
    creator: CREATOR,
    url,
    slug,
    title: txt($('h1.entry-title').first().text(), 200) || pageTitle($),
    poster: $('.thumb-batch img, .content-batch img').first().attr('src') || null,
    count: groups.length,
    groups,
  };
}

/**
 * The site's own mobile-client API (`/wp-json/apk/*`). Its search returns the
 * numeric post ids that `/apk/episode?id=` consumes, so the pair is the cheapest
 * path from a title to a mirror list — no HTML, no nonce, no player_ajax.
 */
async function apkSearch(query: string): Promise<Rec> {
  const q = txt(query, 100);
  if (q.length < 2) throw new Error('Query too short');
  const parsed = JSON.parse(await fetchPage(`/wp-json/apk/search?s=${encodeURIComponent(q)}`)) as Rec[] | { error?: string };
  const results = Array.isArray(parsed) ? parsed : [];
  return { query: q, count: results.length, results, ...(Array.isArray(parsed) ? {} : { note: String(parsed.error ?? '') }) };
}

/** `apk <id>`: one episode record from the mobile API (players, prev, thumb). */
async function apkEpisode(id: string): Promise<Rec> {
  const clean = String(id || '').replace(/[^0-9]/g, '');
  if (!clean) throw new Error('Numeric post id required');
  return JSON.parse(await fetchPage(`/wp-json/apk/episode?id=${clean}`)) as Rec;
}

const SCHEDULE_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

/** `schedule <day>`: the weekly release schedule, from the site's own REST endpoint. */
async function schedule(day: string): Promise<Rec> {
  const d = String(day || '').toLowerCase().trim();
  if (!SCHEDULE_DAYS.includes(d as (typeof SCHEDULE_DAYS)[number])) {
    throw new Error(`Day must be one of: ${SCHEDULE_DAYS.join(', ')}`);
  }
  const raw = await fetchPage(`/wp-json/custom/v1/all-schedule?perpage=20&day=${d}`);
  const items = JSON.parse(raw) as Rec[];
  return { creator: CREATOR, day: d, count: items.length, items };
}

if (import.meta.main) {
  defineCli({
    name: 'samehadaku',
    title: 'Samehadaku Scraper (v2.samehadaku.how)',
    commands: {
      home: {
        desc: 'Latest anime cards + latest-episode feed', usage: '[page]',
        run: (p) => home(Number.parseInt(p[0] || '1', 10) || 1),
      },
      search: {
        desc: 'Search anime by title', usage: '<query>',
        run: (p) => search(p.join(' ')),
      },
      list: {
        desc: 'Paginated anime catalogue (/anime-terbaru/)', usage: '[page]',
        run: (p) => list(Number.parseInt(p[0] || '1', 10) || 1),
      },
      detail: {
        desc: 'Anime detail: info, genres, rating, episodes, batch links', usage: '<slug|url>',
        run: (p) => detail(p[0] || ''),
      },
      episode: {
        desc: 'Episode page: mirrors, downloads, navigation', usage: '<slug|url>',
        run: (p) => episode(p[0] || ''),
      },
      batch: {
        desc: 'Batch download groups', usage: '<slug|url>',
        run: (p) => batch(p[0] || ''),
      },
      mirrors: {
        desc: 'Resolve player mirrors via the player_ajax endpoint', usage: '<slug|url> [nume]',
        run: (p) => mirrors(p[0] || '', Number.parseInt(p[1] || '1', 10) || 1),
      },
      schedule: {
        desc: 'Weekly release schedule for one day', usage: '<monday..sunday>',
        run: (p) => schedule(p[0] || ''),
      },
      apksearch: {
        desc: 'Search the site\'s mobile API (returns numeric post ids)', usage: '<query>',
        run: (p) => apkSearch(p.join(' ')),
      },
      apk: {
        desc: 'Episode record from the mobile API: players, prev, thumb', usage: '<numeric id>',
        run: (p) => apkEpisode(p[0] || ''),
      },
    },
    examples: `  bun samehadaku.ts home
  bun samehadaku.ts search "one piece"
  bun samehadaku.ts detail one-piece
  bun samehadaku.ts episode one-piece-episode-1180`,
  });
}
#!/usr/bin/env bun
/*
- base : https://www.whitehouse.gov
- creator : phrzy
- migrated to core/ (spec 003) — ESM, hardened transport, uniform CLI
*/

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

const BASE = 'https://www.whitehouse.gov';
const site = createSite({
  base: BASE,
  rateMs: 600,
  headers: {
    'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  },
});
const { fetchPage } = site;

const SECTIONS: Record<string, string> = {
  news: '/news/',
  releases: '/releases/',
  briefings: '/briefings/',
  'presidential-actions': '/presidential-actions/',
  'executive-orders': '/executive-orders/',
  memoranda: '/memoranda/',
  proclamations: '/proclamations/',
  nominations: '/nominations/',
  'fact-sheets': '/fact-sheets/',
  remarks: '/remarks/',
  research: '/research/',
  gallery: '/gallery/',
  videos: '/videos/',
};

async function fetchHtml(url: string): Promise<string> {
  return fetchPage(url);
}

function abs(url: string, base: string): string {
  try { return new URL(url, base).href; } catch { return url; }
}

function pageUrl(sectionPath: string, page: number): string {
  if (page > 1) return BASE + sectionPath + 'page/' + page + '/';
  return BASE + sectionPath;
}

function topperTitle($: CheerioAPI): string {
  return $('h1.wp-block-whitehouse-topper__headline').first().text().trim();
}

function parsePagination($: CheerioAPI, baseUrl: string) {
  const pages: number[] = [];
  let total = 0;
  let next: string | null = null;
  $('nav.wp-block-query-pagination .page-numbers:not(.dots)').each((_, el) => {
    const $n = $(el);
    const txtv = $n.text().trim();
    const hrefv = $n.attr('href');
    if (txtv.match(/^\d+$/)) pages.push(parseInt(txtv, 10));
    if (txtv.toLowerCase() === 'next' && hrefv) next = abs(hrefv, baseUrl);
    total++;
  });
  const currentTxt = $('nav.wp-block-query-pagination .page-numbers.current').first().text().trim();
  return {
    currentPage: parseInt(currentTxt, 10) || 1,
    pages,
    next,
    hasMore: !!next,
  };
}

function parseFilters($: CheerioAPI, baseUrl: string) {
  const filters: Array<{ label: string; value: string }> = [];
  $('select[name], .wp-block-whitehouse-filter select').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;
    const options: Array<{ value: string; label: string }> = [];
    $(el).find('option').each((_, o) => {
      options.push({ value: $(o).attr('value') || '', label: $(o).text().trim() });
    });
    filters.push({ label: name, value: JSON.stringify(options).slice(0, 500) });
  });
  return filters;
}

function parsePost($: CheerioAPI, el: never) {
  const $el = $(el);
  const $title = $el.find('h2.wp-block-post-title').first();
  const $a = $title.find('a').first();
  const $cover = $el.find('a.wp-block-cover__action').first();
  const url = $a.attr('href') || $cover.attr('href') || null;
  const cats: string[] = [];
  $el.find('.wp-block-post-terms a').each((_, c) => cats.push($(c).text().trim()));
  const $time = $el.find('.wp-block-post-date time').first();
  const idMatch = ($el.attr('class') || '').match(/post-(\d+)/);
  return {
    title: $a.text().trim() || $title.text().trim(),
    url: url ? abs(url, BASE) : null,
    categories: cats,
    date: $time.text().trim() || null,
    dateISO: $time.attr('datetime') || null,
    thumbnail: $el.find('img.wp-post-image').attr('src') || $el.find('img').first().attr('src') || null,
    postId: idMatch ? parseInt(idMatch[1], 10) : null,
  };
}

function parseListing(html: string, url: string) {
  const $ = cheerio.load(html);
  const posts = [];
  $('li.wp-block-post').each((_, el) => {
    const p = parsePost($, el as never);
    if (p.title) posts.push(p);
  });
  return {
    title: topperTitle($) || null,
    url,
    count: posts.length,
    posts,
    filters: parseFilters($, url),
    pagination: parsePagination($, url),
  };
}

function parseVideos(html: string, url: string) {
  const $ = cheerio.load(html);
  const posts = [];
  $('div.wp-block-whitehouse-past-event').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a').first();
    const $img = $el.find('img').first();
    const $time = $el.find('time').first();
    posts.push({
      title: $el.find('.wp-block-whitehouse-past-event__title a').text().trim(),
      url: abs($a.attr('href') || '', BASE),
      thumbnail: $img.attr('src') || null,
      duration: $el.find('.wp-block-whitehouse-past-event__duration').text().trim() || null,
      date: $time.text().trim() || null,
      dateISO: $time.attr('datetime') || null,
    });
  });
  return { title: topperTitle($) || null, url, count: posts.length, posts, pagination: parsePagination($, url) };
}

function parseSearch(html: string, url: string) {
  const $ = cheerio.load(html);
  const posts = [];
  $('li.wp-block-post').each((_, el) => {
    const p = parsePost($, el as never);
    if (p.title) posts.push(p);
  });
  const typeFilters = [];
  $('fieldset.wp-block-search__filters label').each((_, el) => {
    const $l = $(el);
    typeFilters.push({
      label: $l.text().trim(),
      type: $l.find('input').attr('value') || null,
      checked: $l.find('input').is(':checked'),
    });
  });
  return {
    query: $('input[name="s"]').attr('value') || null,
    url,
    count: posts.length,
    posts,
    typeFilters,
    pagination: parsePagination($, url),
  };
}

function parseDetail(html: string, url: string) {
  const $ = cheerio.load(html);
  const topper = $('.wp-block-whitehouse-topper').first();
  const title = topper.find('.wp-block-whitehouse-topper__headline').first().text().trim()
    || $('h1').first().text().trim();
  const eyebrow = topper.find('.wp-block-whitehouse-topper__eyebrow a').first();
  const byline = topper.find('.wp-block-whitehouse-byline-subcategory').first();
  const subLink = byline.find('a').first();
  const $date = topper.find('.wp-block-post-date time').first();
  const eoNumber = $('p.wp-block-whitehouse-topper__eo-number').first().text().trim() || null;

  const entry = $('div.entry-content').first();
  entry.find('.wp-block-whitehouse-topper').remove();
  const images = [];
  entry.find('img').each((_, img) => {
    const src = $(img).attr('src');
    if (src) images.push(src);
  });
  const bodyText = entry.text().replace(/\s+/g, ' ').trim();

  let schema = null;
  const ld = $('script.yoast-schema-graph').first().text();
  if (ld) {
    try {
      const parsed = JSON.parse(ld);
      const graph = Array.isArray(parsed['@graph']) ? parsed['@graph'] : [];
      schema = graph.find((n) => n && n['@type'] === 'Article') || graph.find((n) => n && n['@type'] === 'WebPage') || null;
    } catch { schema = null; }
  }

  return {
    url,
    title,
    category: eyebrow.text().trim() || null,
    categoryUrl: eyebrow.attr('href') ? abs(eyebrow.attr('href'), url) : null,
    subcategory: subLink.length ? subLink.text().trim() : byline.text().trim() || null,
    byline: byline.text().trim() || null,
    date: $date.text().trim() || null,
    dateISO: $date.attr('datetime') || null,
    eoNumber,
    sections: (schema as Record<string, unknown>)?.articleSection || null,
    published: (schema as Record<string, unknown>)?.datePublished || null,
    modified: (schema as Record<string, unknown>)?.dateModified || null,
    wordCount: (schema as Record<string, unknown>)?.wordCount || null,
    featuredImage: (schema as Record<string, unknown>)?.thumbnailUrl || images[0] || null,
    images,
    bodyText,
    bodyHtml: entry.html() || null,
  };
}

function parseHome(html: string) {
  const $ = cheerio.load(html);
  const topper = $('.wp-block-whitehouse-topper').first();
  const heroVideo = topper.find('.wp-block-whitehouse-topper__media video').attr('src')
    || topper.find('.wp-block-whitehouse-topper__media video source').attr('src') || null;
  const videos = [];
  $('.wp-block-whitehouse-video-accordion-item').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('.wp-block-whitehouse-video-accordion-item__link').first();
    const $v = $el.find('video').first();
    videos.push({
      title: $el.find('.wp-block-whitehouse-video-accordion-item__title').text().trim(),
      url: $a.attr('href') ? abs($a.attr('href'), BASE) : null,
      video: $v.attr('src') || null,
    });
  });
  const paragraphs = [];
  $('.site-content .entry-content p, .site-content main p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) paragraphs.push(t);
  });
  const headings = [];
  $('main h2, main h3, main h4').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) headings.push(t);
  });
  return {
    headline: topper.find('.wp-block-whitehouse-topper__headline').text().trim() || null,
    deck: topper.find('.wp-block-whitehouse-topper__deck').text().replace(/\s+/g, ' ').trim() || null,
    heroVideo,
    videoAccordion: videos,
    headings,
    paragraphs,
    url: BASE + '/',
  };
}

function parseAdministration(html: string) {
  const $ = cheerio.load(html);
  const profiles = [];
  $('.entry-content .wp-block-columns').each((_, group) => {
    const $group = $(group);
    const $cols = $group.children('.wp-block-column');
    if ($cols.length < 2) return;
    const image = $cols.first().find('img').attr('src') || null;
    const $text = $cols.last();
    const $h = $text.find('h2.wp-block-heading').first();
    const $link = $h.find('a').first();
    const name = ($link.text() || $h.text()).trim();
    if (!name) return;
    const $group2 = $h.closest('.wp-block-group');
    let bio = '';
    if ($group2.length) {
      bio = $group2.parent().children('p').first().text().replace(/\s+/g, ' ').trim();
    } else {
      bio = $text.children('p').eq(1).text().replace(/\s+/g, ' ').trim();
    }
    profiles.push({
      name,
      role: $text.find('p.has-small-caps-font-size').first().text().trim() || null,
      url: $link.attr('href') ? abs($link.attr('href'), BASE) : null,
      image,
      bio,
    });
  });
  return { title: topperTitle($) || null, count: profiles.length, profiles };
}

if (import.meta.main) {
  const commands: Record<string, { desc: string; usage?: string; run: (p: string[], f: Record<string, string>) => Promise<unknown> }> = {
    home: { desc: 'Homepage hero + content', run: async () => parseHome(await fetchHtml(BASE + '/')) },
    search: {
      desc: 'Site search', usage: '<keyword> [page]',
      run: async (p) => {
        if (!p[0]) throw new Error('Parameter keyword wajib');
        const page = parseInt(p[1] || '0', 10) || 0;
        const url = BASE + '/?s=' + encodeURIComponent(p[0]) + (page > 1 ? '&paged=' + page : '');
        return parseSearch(await fetchHtml(url), url);
      },
    },
    detail: {
      desc: 'Article detail', usage: '<URL>',
      run: async (p) => {
        if (!p[0]) throw new Error('Parameter URL wajib');
        const url = abs(p[0], BASE);
        return parseDetail(await fetchHtml(url), url);
      },
    },
    administration: { desc: 'Administration profiles', run: async () => parseAdministration(await fetchHtml(BASE + '/administration/')) },
    videos: {
      desc: 'Video gallery', usage: '[page]',
      run: async (p) => {
        const url = pageUrl(SECTIONS.videos, parseInt(p[0] || '0', 10) || 0);
        return parseVideos(await fetchHtml(url), url);
      },
    },
  };
  for (const name of Object.keys(SECTIONS)) {
    if (name === 'videos') continue;
    commands[name] = {
      desc: `Listing: ${name}`, usage: '[page]',
      run: async (p) => {
        const url = pageUrl(SECTIONS[name], parseInt(p[0] || '0', 10) || 0);
        return parseListing(await fetchHtml(url), url);
      },
    };
  }
  defineCli({
    name: 'whitehouse',
    title: 'WhiteHouse.gov Scraper',
    commands,
    examples: `  bun whitehouse.ts search "executive order"
  bun whitehouse.ts detail "https://www.whitehouse.gov/..."
  bun whitehouse.ts presidential-actions 2`,
  });
}

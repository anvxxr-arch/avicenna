const cheerio = require('cheerio');

const BASE = 'https://www.whitehouse.gov';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

const SECTIONS = {
  news: '/news/',
  releases: '/releases/',
  briefings: '/briefings-statements/',
  'presidential-actions': '/presidential-actions/',
  'executive-orders': '/presidential-actions/executive-orders/',
  memoranda: '/presidential-actions/presidential-memoranda/',
  proclamations: '/presidential-actions/proclamations/',
  nominations: '/presidential-actions/nominations-appointments/',
  'fact-sheets': '/fact-sheets/',
  remarks: '/remarks/',
  research: '/research/',
  gallery: '/gallery/',
  videos: '/videos/',
};

const USAGE = [
  'Penggunaan: node web.js <fitur> [parameter] [halaman]',
  '',
  'Fitur tersedia:',
  '  home',
  '  search "keyword" [page]',
  '  news [page] | releases [page] | briefings [page]',
  '  presidential-actions [page] | executive-orders [page]',
  '  memoranda [page] | proclamations [page] | nominations [page]',
  '  fact-sheets [page] | remarks [page] | research [page]',
  '  gallery [page] | videos [page]',
  '  detail "URL"',
  '  administration',
].join('\n');

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' untuk ' + url);
  return await res.text();
}

function abs(url, base) {
  try { return new URL(url, base).href; } catch (e) { return url; }
}

function pageUrl(sectionPath, page) {
  if (page > 1) return BASE + sectionPath + 'page/' + page + '/';
  return BASE + sectionPath;
}

function topperTitle($) {
  return $('h1.wp-block-whitehouse-topper__headline').first().text().trim();
}

function parsePagination($, baseUrl) {
  const pages = [];
  let total = 0;
  $('nav.wp-block-query-pagination .page-numbers:not(.dots)').each((_, el) => {
    const $n = $(el);
    const n = parseInt($n.text().trim(), 10);
    if (!isNaN(n)) {
      total = Math.max(total, n);
      pages.push({ number: n, url: $n.is('a') ? abs($n.attr('href'), baseUrl) : null, current: $n.hasClass('current') });
    }
  });
  const next = $('nav.wp-block-query-pagination a.wp-block-query-pagination-next').attr('href') || null;
  return { current: (pages.find((p) => p.current) || {}).number || 1, total, pages, next: next ? abs(next, baseUrl) : null };
}

function parseFilters($, baseUrl) {
  const filters = [];
  $('.wp-block-whitehouse-topper-navigation__parent-item, .wp-block-whitehouse-topper-navigation__child-item').each((_, el) => {
    const $a = $(el).find('a').first();
    if (!$a.length) return;
    filters.push({ label: $a.text().trim(), url: abs($a.attr('href'), baseUrl), active: $a.hasClass('is-current') });
  });
  return filters;
}

function parsePost($, el) {
  const $el = $(el);
  const $title = $el.find('h2.wp-block-post-title').first();
  const $a = $title.find('a').first();
  const $cover = $el.find('a.wp-block-cover__action').first();
  const url = $a.attr('href') || $cover.attr('href') || null;
  const cats = [];
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

function parseListing(html, url) {
  const $ = cheerio.load(html);
  const posts = [];
  $('li.wp-block-post').each((_, el) => {
    const p = parsePost($, el);
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

function parseVideos(html, url) {
  const $ = cheerio.load(html);
  const posts = [];
  $('div.wp-block-whitehouse-past-event').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a').first();
    const $img = $el.find('img').first();
    const $time = $el.find('time').first();
    posts.push({
      title: $el.find('.wp-block-whitehouse-past-event__title a').text().trim(),
      url: abs($a.attr('href'), BASE),
      thumbnail: $img.attr('src') || null,
      duration: $el.find('.wp-block-whitehouse-past-event__duration').text().trim() || null,
      date: $time.text().trim() || null,
      dateISO: $time.attr('datetime') || null,
    });
  });
  return { title: topperTitle($) || null, url, count: posts.length, posts, pagination: parsePagination($, url) };
}

function parseSearch(html, url) {
  const $ = cheerio.load(html);
  const posts = [];
  $('li.wp-block-post').each((_, el) => {
    const p = parsePost($, el);
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

function parseDetail(html, url) {
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
    } catch (e) { schema = null; }
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
    sections: (schema && schema.articleSection) || null,
    published: (schema && schema.datePublished) || null,
    modified: (schema && schema.dateModified) || null,
    wordCount: (schema && schema.wordCount) || null,
    featuredImage: (schema && schema.thumbnailUrl) || images[0] || null,
    images,
    bodyText,
    bodyHtml: entry.html() || null,
  };
}

function parseHome(html) {
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

function parseAdministration(html) {
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

const FEATURES = {
  home: () => fetchHtml(BASE + '/').then(parseHome),

  search: async (keyword, page) => {
    if (!keyword) throw new Error('Parameter keyword wajib: node web.js search "keyword"');
    const url = BASE + '/?s=' + encodeURIComponent(keyword) + (page > 1 ? '&paged=' + page : '');
    return parseSearch(await fetchHtml(url), url);
  },

  detail: async (rawUrl) => {
    if (!rawUrl) throw new Error('Parameter URL wajib: node web.js detail "https://www.whitehouse.gov/..."');
    const url = abs(rawUrl, BASE);
    return parseDetail(await fetchHtml(url), url);
  },

  administration: () => fetchHtml(BASE + '/administration/').then(parseAdministration),

  videos: (param) => {
    const url = pageUrl(SECTIONS.videos, parseInt(param, 10) || 0);
    return fetchHtml(url).then((html) => parseVideos(html, url));
  },
};

for (const name of Object.keys(SECTIONS)) {
  if (name === 'videos') continue;
  FEATURES[name] = (param) => {
    const url = pageUrl(SECTIONS[name], parseInt(param, 10) || 0);
    return fetchHtml(url).then((html) => parseListing(html, url));
  };
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const feature = process.argv[2];
  const param = process.argv[3];
  const page = parseInt(process.argv[4], 10) || 0;
  if (!feature) { console.log(USAGE); return; }
  const fn = FEATURES[feature];
  if (!fn) { out({ error: 'Fitur tidak dikenal: ' + feature, usage: USAGE.split('\n')[0] }); process.exit(1); return; }
  try {
    out(await fn(param, page));
  } catch (err) {
    out({ error: err.message });
    process.exit(1);
  }
}

main();

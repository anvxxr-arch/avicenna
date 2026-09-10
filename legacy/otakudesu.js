const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const BASE_URL = 'https://otakudesu.blog';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.104 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
];

let uaIndex = 0;

class CookieJar {
  constructor() {
    this.cookies = {};
  }

  update(headers) {
    const setCookie = headers['set-cookie'];
    if (!setCookie) return;
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookieStr of cookies) {
      const parts = cookieStr.split(';')[0].split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        this.cookies[key] = value;
      }
    }
  }

  getString() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  clear() {
    this.cookies = {};
  }
}

function randomDelay(min = 300, max = 800) {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
}

function getHeaders(ref = BASE_URL, cookie = '') {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex++;
  const isMobile = ua.includes('Mobile') || ua.includes('iPhone') || ua.includes('Android');
  const platform = ua.includes('Windows') ? 'Windows' : ua.includes('Mac') ? 'macOS' : 'Linux';
  const headers = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': ref || BASE_URL,
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'DNT': '1',
    'Sec-Ch-Ua': `"${ua.includes('Chrome') ? 'Google Chrome' : 'Chromium'}"`,
    'Sec-Ch-Ua-Mobile': isMobile ? '?1' : '?0',
    'Sec-Ch-Ua-Platform': `"${platform}"`,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Connection': 'keep-alive'
  };
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

async function request(method, url, data = null, headers = {}, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      await randomDelay(300, 800);
      const config = {
        method,
        url,
        headers,
        timeout: 30000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false, keepAlive: true }),
        maxRedirects: 5,
        decompress: true,
        validateStatus: status => status >= 200 && status < 400
      };
      if (data && (method === 'POST' || method === 'PUT')) {
        config.data = data;
      }
      const res = await axios(config);
      return res;
    } catch (e) {
      if (i < retries - 1) await randomDelay(1500, 4000);
      else throw e;
    }
  }
}

class OtakudesuScraper {
  constructor() {
    this.base = BASE_URL;
    this.creator = 'rynaqrtz';
    this.cookieJar = new CookieJar();
  }

  async _fetchHTML(url, retries = 5) {
    const headers = getHeaders(url, this.cookieJar.getString());
    const res = await request('GET', url, null, headers, retries);
    this.cookieJar.update(res.headers);
    return res.data;
  }

  async _fetchJSON(url, retries = 5) {
    const headers = getHeaders(url, this.cookieJar.getString());
    const res = await request('GET', url, null, headers, retries);
    this.cookieJar.update(res.headers);
    return res.data;
  }

  async _postAjax(payload, retries = 5) {
    const params = new URLSearchParams(payload);
    const url = `${this.base}/wp-admin/admin-ajax.php`;
    const headers = {
      ...getHeaders(this.base, this.cookieJar.getString()),
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded'
    };
    const res = await request('POST', url, params.toString(), headers, retries);
    this.cookieJar.update(res.headers);
    return res.data;
  }

  _clean(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (Array.isArray(obj)) return obj.map(i => this._clean(i));
    if (typeof obj === 'object') {
      const result = {};
      for (const key of Object.keys(obj)) {
        const val = this._clean(obj[key]);
        if (val !== undefined) result[key] = val;
      }
      return Object.keys(result).length ? result : undefined;
    }
    return obj;
  }

  _buildResponse(page, url, data) {
    return this._clean({
      creator: this.creator,
      page,
      url,
      data
    });
  }

  _parsePagination($) {
    const result = { current: 1, next: null, hasNext: false, total: null };
    const pageLinks = [];
    $('.pagination a, .pagination span, .page-numbers, .pagenavix a, .pagenavix span').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (href) pageLinks.push({ text, href });
    });
    const numbers = pageLinks.filter(l => /^\d+$/.test(l.text)).map(l => parseInt(l.text));
    if (numbers.length) result.total = Math.max(...numbers);
    const current = $('.pagination .page-numbers.current, .pagenavix .page-numbers.current').first();
    if (current.length) {
      const t = current.text().trim();
      if (/^\d+$/.test(t)) result.current = parseInt(t);
    }
    if (result.total && result.current < result.total) {
      result.hasNext = true;
      const nextLink = pageLinks.find(l => l.text === 'Next' || l.text === '»' || l.text.toLowerCase().includes('next'));
      if (nextLink && nextLink.href) {
        result.next = nextLink.href.startsWith('http') ? nextLink.href : this.base + nextLink.href;
      }
    }
    return result;
  }

  _parseCardDetpost($, element) {
    const $el = $(element);
    const link = $el.find('.thumb a').attr('href');
    const title = $el.find('.jdlflm').text().trim();
    const poster = $el.find('.thumbz img').attr('src') || null;
    const episode = $el.find('.epz').text().trim() || null;
    const day = $el.find('.epztipe').text().trim() || null;
    const date = $el.find('.newnime').text().trim() || null;
    if (!link || !title) return null;
    return {
      title,
      url: link.startsWith('http') ? link : this.base + link,
      poster,
      episode,
      day,
      date
    };
  }

  _parseCardColAnime($, element) {
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
    return {
      title,
      url: link.startsWith('http') ? link : this.base + link,
      studio,
      episodes: eps,
      rating,
      genres,
      poster,
      synopsis,
      season
    };
  }

  _parseGenreList($) {
    const genres = [];
    $('.genres li a').each((i, el) => {
      const $el = $(el);
      const name = $el.text().trim();
      const link = $el.attr('href');
      if (name && link) {
        const slug = link.replace(/\/genres\/([^\/]+)\/?/, '$1');
        genres.push({ name, slug, url: link.startsWith('http') ? link : this.base + link });
      }
    });
    return genres;
  }

  _parseSchedule($) {
    const schedule = {};
    $('.kglist321').each((i, el) => {
      const $el = $(el);
      const day = $el.find('h2').text().trim();
      const items = [];
      $el.find('ul li a').each((j, a) => {
        const $a = $(a);
        items.push({
          title: $a.text().trim(),
          url: $a.attr('href').startsWith('http') ? $a.attr('href') : this.base + $a.attr('href')
        });
      });
      if (day && items.length) schedule[day] = items;
    });
    return schedule;
  }

  _parseEpisodeList($) {
    const episodes = [];
    $('.episodelist ul li').each((i, el) => {
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
          url: href.startsWith('http') ? href : this.base + href,
          releaseDate: date
        });
      }
    });
    return episodes;
  }

  _extractPostId($) {
    const ids = new Set();
    $('[data-content]').each((i, el) => {
      const content = $(el).attr('data-content');
      if (content) {
        try {
          const decoded = Buffer.from(content, 'base64').toString('utf-8');
          const parsed = JSON.parse(decoded);
          if (parsed.id) ids.add(parsed.id);
        } catch (e) {}
      }
    });
    $('[id^="post-"]').each((i, el) => {
      const id = $(el).attr('id');
      const match = id.match(/post-(\d+)/);
      if (match) ids.add(parseInt(match[1]));
    });
    const html = $.html();
    const scriptMatches = html.match(/post[_\s]*id[_\s]*[:=]\s*["']?(\d+)["']?/gi);
    if (scriptMatches) {
      scriptMatches.forEach(m => {
        const num = m.match(/\d+/);
        if (num) ids.add(parseInt(num[0]));
      });
    }
    return ids.size > 0 ? [...ids][0] : null;
  }

  async _getNonce() {
    try {
      const res = await this._postAjax({ action: 'aa1208d27f29ca340c92c66d1926f13f' });
      return res?.data || null;
    } catch (e) {
      return null;
    }
  }

  async _getStreamUrl(postId, index, quality, nonce) {
    const payload = {
      action: '2a3505c93b0035d3f455df82bf976b84',
      id: postId,
      i: index,
      q: quality,
      nonce
    };
    try {
      const res = await this._postAjax(payload);
      if (!res || !res.data) return null;
      const html = Buffer.from(res.data, 'base64').toString('utf-8');
      const $ = cheerio.load(html);
      return $('iframe').attr('src') || null;
    } catch (e) {
      return null;
    }
  }

  async _extractStreams(html) {
    const $ = cheerio.load(html);
    const postId = this._extractPostId($);
    if (!postId) return {};
    const nonce = await this._getNonce();
    if (!nonce) return {};
    const streams = {};
    $('.mirrorstream ul').each((i, ul) => {
      const $ul = $(ul);
      $ul.find('a').each((j, a) => {
        const $a = $(a);
        const dataContent = $a.attr('data-content');
        if (dataContent) {
          try {
            const decoded = Buffer.from(dataContent, 'base64').toString('utf-8');
            const parsed = JSON.parse(decoded);
            if (parsed.id === postId) {
              const key = `${parsed.q}_${$a.text().trim()}`;
              streams[key] = { postId, i: parsed.i, q: parsed.q, nonce };
            }
          } catch (e) {}
        }
      });
    });
    const result = {};
    for (const [key, params] of Object.entries(streams)) {
      const url = await this._getStreamUrl(params.postId, params.i, params.q, params.nonce);
      if (url) result[key] = url;
    }
    return result;
  }

  async home() {
    const url = this.base + '/';
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const items = [];
    $('.detpost:has(.epz:contains("Episode"))').each((i, el) => {
      const card = this._parseCardDetpost($, el);
      if (card) items.push(card);
    });
    return this._buildResponse('home', url, { items });
  }

  async ongoing(page = 1) {
    const url = page === 1 ? this.base + '/ongoing-anime/' : this.base + `/ongoing-anime/page/${page}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const items = [];
    $('.detpost').each((i, el) => {
      const card = this._parseCardDetpost($, el);
      if (card) items.push(card);
    });
    const pagination = this._parsePagination($);
    return this._buildResponse('ongoing', url, { pagination, items });
  }

  async complete(page = 1) {
    const url = page === 1 ? this.base + '/complete-anime/' : this.base + `/complete-anime/page/${page}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const items = [];
    $('.detpost').each((i, el) => {
      const card = this._parseCardDetpost($, el);
      if (card) items.push(card);
    });
    const pagination = this._parsePagination($);
    return this._buildResponse('complete', url, { pagination, items });
  }

  async genreList() {
    const url = this.base + '/genre-list/';
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const genres = this._parseGenreList($);
    return this._buildResponse('genreList', url, { genres });
  }

  async genre(slug, page = 1) {
    const url = page === 1 ? this.base + `/genres/${slug}/` : this.base + `/genres/${slug}/page/${page}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const items = [];
    $('.col-anime-con').each((i, el) => {
      const card = this._parseCardColAnime($, el);
      if (card) items.push(card);
    });
    const pagination = this._parsePagination($);
    return this._buildResponse('genre', url, { slug, pagination, items });
  }

  async jadwalRilis() {
    const url = this.base + '/jadwal-rilis/';
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const schedule = this._parseSchedule($);
    return this._buildResponse('jadwalRilis', url, { schedule });
  }

  async search(query) {
    const url = `${this.base}/?s=${encodeURIComponent(query)}&post_type=anime`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const items = [];
    $('.chivsrc li').each((i, el) => {
      const $el = $(el);
      const link = $el.find('h2 a').attr('href');
      const title = $el.find('h2 a').text().trim();
      const poster = $el.find('img').attr('src') || null;
      const genres = $el.find('.set:first-child a').map((_, a) => $(a).text()).get() || [];
      const status = $el.find('.set:nth-child(2)').text().replace('Status :', '').trim() || null;
      const ratingEl = $el.find('.set:contains("Rating")');
      const rating = ratingEl.length ? ratingEl.text().replace('Rating :', '').trim() : null;
      if (link && title) {
        items.push({
          title,
          url: link.startsWith('http') ? link : this.base + link,
          poster,
          genres,
          status,
          rating
        });
      }
    });
    return this._buildResponse('search', url, { query, items });
  }

  async detail(slug) {
    const url = this.base + `/anime/${slug}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const title = $('.jdlrx h1').text().trim() || $('title').text().trim();
    const poster = $('.fotoanime img').attr('src') || null;
    const sinopsis = $('.sinopc p').text().trim() || null;
    const info = {};
    $('.infozin .infozingle p').each((i, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      if (text.includes('Genre')) {
        const genreLinks = $el.find('a').map((_, a) => $(a).text()).get();
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
    const episodes = this._parseEpisodeList($);
    const recommendations = [];
    $('.isi-recommend-anime-series .isi-konten').each((i, el) => {
      const $el = $(el);
      const link = $el.find('.judul-anime a').attr('href');
      const titleRec = $el.find('.judul-anime a').text().trim();
      const posterRec = $el.find('.gambar-konten img').attr('src') || null;
      if (link && titleRec) {
        recommendations.push({
          title: titleRec,
          url: link.startsWith('http') ? link : this.base + link,
          poster: posterRec
        });
      }
    });
    return this._buildResponse('detail', url, {
      title,
      poster,
      sinopsis,
      info,
      episodes,
      recommendations
    });
  }

  async episode(slug) {
    const url = this.base + `/episode/${slug}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const title = $('h1.posttl').text().trim() || $('title').text().trim();
    const streams = await this._extractStreams(html);
    const downloads = [];
    $('.download ul').each((i, ul) => {
      const $ul = $(ul);
      const group = $ul.prev('h4').text().trim() || $ul.prev('strong').text().trim() || 'Download';
      const items = [];
      $ul.find('li').each((j, li) => {
        const $li = $(li);
        const resolution = $li.find('strong').text().trim() || null;
        const size = $li.find('i').text().trim() || null;
        const links = [];
        $li.find('a').each((k, a) => {
          const $a = $(a);
          links.push({
            host: $a.text().trim(),
            url: $a.attr('href')
          });
        });
        if (links.length) items.push({ resolution, size, links });
      });
      if (items.length) downloads.push({ group, items });
    });
    const nav = {
      prev: $('.prevnext .flir a:first-child').attr('href') || null,
      all: $('.prevnext .flir a:contains("See All")').attr('href') || null,
      next: $('.prevnext .flir a:last-child').attr('href') || null
    };
    const otherEpisodes = this._parseEpisodeList($);
    const data = { title, streams, downloads, nav };
    if (otherEpisodes.length) data.otherEpisodes = otherEpisodes;
    return this._buildResponse('episode', url, data);
  }

  async batch(slug) {
    const url = this.base + `/lengkap/${slug}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const title = $('.jdlrx h1').text().trim() || $('title').text().trim();
    const downloads = [];
    $('.download ul').each((i, ul) => {
      const $ul = $(ul);
      const group = $ul.prev('h4').text().trim() || $ul.prev('strong').text().trim() || 'Batch';
      const items = [];
      $ul.find('li').each((j, li) => {
        const $li = $(li);
        const resolution = $li.find('strong').text().trim() || null;
        const size = $li.find('i').text().trim() || null;
        const links = [];
        $li.find('a').each((k, a) => {
          const $a = $(a);
          links.push({
            host: $a.text().trim(),
            url: $a.attr('href')
          });
        });
        if (links.length) items.push({ resolution, size, links });
      });
      if (items.length) downloads.push({ group, items });
    });
    return this._buildResponse('batch', url, { title, downloads });
  }

  async watch(slug) {
    const url = this.base + `/episode/${slug}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const title = $('h1.posttl').text().trim() || $('title').text().trim();
    const streams = await this._extractStreams(html);
    const downloads = [];
    $('.download ul').each((i, ul) => {
      const $ul = $(ul);
      const group = $ul.prev('h4').text().trim() || $ul.prev('strong').text().trim() || 'Download';
      const items = [];
      $ul.find('li').each((j, li) => {
        const $li = $(li);
        const resolution = $li.find('strong').text().trim() || null;
        const size = $li.find('i').text().trim() || null;
        const links = [];
        $li.find('a').each((k, a) => {
          const $a = $(a);
          links.push({
            host: $a.text().trim(),
            url: $a.attr('href')
          });
        });
        if (links.length) items.push({ resolution, size, links });
      });
      if (items.length) downloads.push({ group, items });
    });
    const nav = {
      prev: $('.prevnext .flir a:first-child').attr('href') || null,
      all: $('.prevnext .flir a:contains("See All")').attr('href') || null,
      next: $('.prevnext .flir a:last-child').attr('href') || null
    };
    return this._buildResponse('watch', url, { title, streams, downloads, nav });
  }

  resetCookie() {
    this.cookieJar.clear();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const params = args.slice(1);
  const scraper = new OtakudesuScraper();
  (async () => {
    let result;
    try {
      switch (cmd) {
        case 'home':
          result = await scraper.home();
          break;
        case 'ongoing':
          result = await scraper.ongoing(parseInt(params[0]) || 1);
          break;
        case 'complete':
          result = await scraper.complete(parseInt(params[0]) || 1);
          break;
        case 'genrelist':
          result = await scraper.genreList();
          break;
        case 'genre':
          if (!params[0]) throw new Error('Genre slug required');
          result = await scraper.genre(params[0], parseInt(params[1]) || 1);
          break;
        case 'jadwal':
          result = await scraper.jadwalRilis();
          break;
        case 'search':
          if (!params[0]) throw new Error('Query required');
          result = await scraper.search(params[0]);
          break;
        case 'detail':
          if (!params[0]) throw new Error('Anime slug required');
          result = await scraper.detail(params[0]);
          break;
        case 'episode':
          if (!params[0]) throw new Error('Episode slug required');
          result = await scraper.episode(params[0]);
          break;
        case 'batch':
          if (!params[0]) throw new Error('Batch slug required');
          result = await scraper.batch(params[0]);
          break;
        case 'watch':
          if (!params[0]) throw new Error('Episode slug required');
          result = await scraper.watch(params[0]);
          break;
        default:
          console.error(`Commands:
  home                 - Latest episodes (filtered ongoing)
  ongoing [page]       - Ongoing anime list (paginated)
  complete [page]      - Completed anime list (paginated)
  genrelist            - List of all genres
  genre <slug> [page]  - Anime by genre (e.g. comedy, action)
  jadwal               - Weekly schedule
  search <query>       - Search anime (max 12 results)
  detail <slug>        - Anime detail + episode list
  episode <slug>       - Episode with streams + downloads
  batch <slug>         - Batch download page
  watch <slug>         - Lightweight stream only (title + streams)`);
          process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(JSON.stringify({ error: err.message }));
      process.exit(1);
    }
  })();
}

module.exports = OtakudesuScraper;
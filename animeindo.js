const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const BASE_URL = 'https://anime-indo.lol';

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
      if (i < retries - 1) continue;
      throw e;
    }
  }
}

class AnimeIndoScraper {
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

  async _fetchDirectVideo(proxyUrl, retries = 3) {
    try {
      const html = await this._fetchHTML(proxyUrl, retries);
      const $ = cheerio.load(html);
      
      const iframe = $('iframe').attr('src');
      if (iframe) {
        if (iframe.includes('googlevideo.com')) {
          return iframe;
        }
        return await this._fetchDirectVideo(iframe, retries);
      }
      
      const videoSrc = $('video source').attr('src') || $('video').attr('src');
      if (videoSrc) {
        return videoSrc;
      }
      
      const embed = $('.embed-responsive iframe').attr('src') || 
                    $('#player iframe').attr('src') ||
                    $('.player iframe').attr('src');
      if (embed) {
        if (embed.includes('googlevideo.com')) {
          return embed;
        }
        return await this._fetchDirectVideo(embed, retries);
      }
      
      const htmlStr = $.html();
      const gvMatch = htmlStr.match(/https?:\/\/[^"'\s]*googlevideo\.com\/videoplayback[^"'\s]*/i);
      if (gvMatch) {
        return gvMatch[0];
      }
      
      return null;
    } catch (e) {
      return null;
    }
  }

  _clean(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (Array.isArray(obj)) return obj.map(i => this._clean(i));
    if (typeof obj === 'object') {
      const result = {};
      for (const key of Object.keys(obj)) {
        const val = this._clean(obj[key]);
        if (val !== undefined && val !== null && !(Array.isArray(val) && val.length === 0)) {
          result[key] = val;
        }
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
    $('.pag a, .pag span, .pagination a, .pagination span').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (href) pageLinks.push({ text, href });
    });
    const numbers = pageLinks.filter(l => /^\d+$/.test(l.text)).map(l => parseInt(l.text));
    if (numbers.length) result.total = Math.max(...numbers);
    const current = $('.pag .cur, .pagination .current').first();
    if (current.length) {
      const t = current.text().trim();
      if (/^\d+$/.test(t)) result.current = parseInt(t);
    }
    if (result.total && result.current < result.total) {
      result.hasNext = true;
      const nextLink = pageLinks.find(l => l.text === '»' || l.text.toLowerCase().includes('next'));
      if (nextLink && nextLink.href) {
        result.next = nextLink.href.startsWith('http') ? nextLink.href : this.base + nextLink.href;
      }
    }
    return result;
  }

  _parseCardHome($, element) {
    const $el = $(element);
    let link = null;
    let title = null;
    let image = null;
    let episode = null;
    
    const $parent = $el.parent('a');
    if ($parent.length) {
      link = $parent.attr('href');
    } else {
      const $a = $el.find('a');
      if ($a.length) {
        link = $a.attr('href');
      }
    }
    
    const $title = $el.find('p');
    if ($title.length) {
      title = $title.text().trim();
    }
    
    const $img = $el.find('img');
    if ($img.length) {
      image = $img.attr('data-original') || $img.attr('src') || null;
    }
    
    const $eps = $el.find('.eps');
    if ($eps.length) {
      episode = $eps.text().trim();
    }
    
    if (!link) {
      const $innerA = $el.find('a');
      if ($innerA.length) {
        link = $innerA.attr('href');
      }
    }

    if (link && title) {
      return {
        title,
        url: link.startsWith('http') ? link : this.base + link,
        image: image ? (image.startsWith('http') ? image : this.base + image) : null,
        episode
      };
    }
    return null;
  }

  _parseCardTable($, element) {
    const $el = $(element);
    const $thumb = $el.find('.vithumb img');
    const $title = $el.find('.videsc a:first');
    const $labels = $el.find('.label');
    const $desc = $el.find('.des');
    const thumbnail = $thumb.attr('src') || $thumb.attr('data-original') || '';
    const title = $title.text().trim();
    const url = $title.attr('href');
    const labels = [];
    $labels.each((i, label) => {
      labels.push($(label).text().trim());
    });
    const description = $desc.text().trim();
    if (!title || !url) return null;
    return {
      title,
      url: url.startsWith('http') ? url : this.base + url,
      thumbnail: thumbnail ? (thumbnail.startsWith('http') ? thumbnail : this.base + thumbnail) : null,
      labels,
      description,
      type: labels.includes('Movie') ? 'movie' : labels.includes('LA') ? 'liveaction' : labels.includes('Special') ? 'special' : labels.includes('OVA') ? 'ova' : 'tv',
      duration: labels.find(l => l.includes('hr') || l.includes('min')) || null,
      year: labels.find(l => /^\d{4}$/.test(l)) || null,
      status: labels.find(l => l === 'Completed' || l === 'Currently Airing' || l === 'Unknown') || null
    };
  }

  _parseEpisodeList($) {
    const episodes = [];
    $('.ep a').each((i, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      const text = $el.text().trim();
      const number = parseInt(text);
      if (href && !isNaN(number)) {
        episodes.push({
          number,
          title: `Episode ${number}`,
          url: href.startsWith('http') ? href : this.base + href
        });
      }
    });
    return episodes;
  }

  _parseGenreList($) {
    const genres = [];
    $('.list-genre a').each((i, el) => {
      const $el = $(el);
      const name = $el.text().trim();
      const href = $el.attr('href');
      if (name && href) {
        const slug = href.replace(/\/genres\/([^\/]+)\/?/, '$1');
        genres.push({ name, slug, url: href.startsWith('http') ? href : this.base + href });
      }
    });
    return genres;
  }

  _extractVideoUrls($) {
    const result = {
      iframe: null,
      directVideo: null,
      servers: [],
      downloads: []
    };

    const iframe = $('#tontonin').attr('src');
    if (iframe) {
      result.iframe = iframe.startsWith('http') ? iframe : this.base + iframe;
    }

    $('.server').each((i, el) => {
      const $el = $(el);
      const name = $el.text().trim();
      const url = $el.attr('data-video');
      if (url) {
        result.servers.push({ name, url: url.startsWith('http') ? url : this.base + url });
      }
    });

    $('.navi a').each((i, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      const text = $el.text().trim();
      if (href && (text.includes('Download') || text.includes('Unduh') || text.includes('GDrive'))) {
        result.downloads.push({
          text,
          url: href.startsWith('http') ? href : this.base + href
        });
      }
    });

    return result;
  }

  async home(page = 1) {
    const url = page === 1 ? this.base + '/' : this.base + `/page/${page}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const items = [];
    $('.list-anime').each((i, el) => {
      const card = this._parseCardHome($, el);
      if (card) items.push(card);
    });
    const pagination = this._parsePagination($);
    return this._buildResponse('home', url, { pagination, items });
  }

  async genreList() {
    const url = this.base + '/list-genre/';
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
    $('.otable').each((i, el) => {
      const card = this._parseCardTable($, el);
      if (card) items.push(card);
    });
    const pagination = this._parsePagination($);
    return this._buildResponse('genre', url, { slug, pagination, items });
  }

  async movies(page = 1) {
    const url = page === 1 ? this.base + '/movie/' : this.base + `/movie/page/${page}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const items = [];
    $('.otable').each((i, el) => {
      const card = this._parseCardTable($, el);
      if (card) items.push(card);
    });
    const pagination = this._parsePagination($);
    return this._buildResponse('movies', url, { pagination, items });
  }

  async jadwal() {
    const url = this.base + '/jadwal/';
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const items = [];
    $('.anime-list li').each((i, el) => {
      const text = $(el).text().trim();
      if (text) items.push(text);
    });
    return this._buildResponse('jadwal', url, { items });
  }

  async search(query) {
    const url = this.base + `/search.php?q=${encodeURIComponent(query)}`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const items = [];
    $('.otable').each((i, el) => {
      const card = this._parseCardTable($, el);
      if (card) items.push(card);
    });
    if (items.length === 0) {
      $('.list-anime').each((i, el) => {
        const card = this._parseCardHome($, el);
        if (card) items.push(card);
      });
    }
    return this._buildResponse('search', url, { query, items });
  }

  async detail(slug) {
    const url = this.base + `/anime/${slug}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const $detail = $('.detail');
    const title = $('h1.title').text().trim() || $('title').text().trim();
    const image = $detail.find('img').attr('src') || null;
    const description = $detail.find('p').text().trim() || null;
    const genres = [];
    $detail.find('li a').each((i, el) => {
      const $el = $(el);
      genres.push({
        name: $el.text().trim(),
        url: $el.attr('href').startsWith('http') ? $el.attr('href') : this.base + $el.attr('href')
      });
    });
    const episodes = this._parseEpisodeList($);
    return this._buildResponse('detail', url, {
      title,
      image: image ? (image.startsWith('http') ? image : this.base + image) : null,
      description,
      genres,
      episodes
    });
  }

  async episode(slug) {
    const url = this.base + `/${slug}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const title = $('h1.title').text().trim() || $('title').text().trim();
    const videoData = this._extractVideoUrls($);
    let directVideo = null;
    if (videoData.iframe && videoData.iframe.includes('btube3.php')) {
      directVideo = await this._fetchDirectVideo(videoData.iframe);
    }
    return this._buildResponse('episode', url, {
      title,
      iframe: videoData.iframe,
      directVideo,
      servers: videoData.servers,
      downloads: videoData.downloads
    });
  }

  async watch(slug) {
    return this.episode(slug);
  }

  async batch(slug) {
    const url = this.base + `/anime/${slug}/`;
    const html = await this._fetchHTML(url);
    const $ = cheerio.load(html);
    const title = $('h1.title').text().trim() || $('title').text().trim();
    const episodes = this._parseEpisodeList($);
    const batchData = [];
    for (const ep of episodes.slice(0, 10)) {
      try {
        const epHtml = await this._fetchHTML(ep.url);
        const $ep = cheerio.load(epHtml);
        const videoData = this._extractVideoUrls($ep);
        let directVideo = null;
        if (videoData.iframe && videoData.iframe.includes('btube3.php')) {
          directVideo = await this._fetchDirectVideo(videoData.iframe);
        }
        batchData.push({
          episode: ep.number,
          title: ep.title,
          iframe: videoData.iframe,
          directVideo,
          servers: videoData.servers,
          downloads: videoData.downloads
        });
      } catch (e) {
        batchData.push({
          episode: ep.number,
          title: ep.title,
          error: e.message
        });
      }
    }
    return this._buildResponse('batch', url, { title, episodes: batchData });
  }

  resetCookie() {
    this.cookieJar.clear();
  }

  getSupportedPages() {
    return this._buildResponse('supportedPages', this.base, {
      home: true,
      genreList: true,
      genre: true,
      movies: true,
      jadwal: true,
      search: true,
      detail: true,
      episode: true,
      watch: true,
      batch: true
    });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const params = args.slice(1);
  const scraper = new AnimeIndoScraper();

  (async () => {
    let result;
    try {
      switch (cmd) {
        case 'supported':
          result = scraper.getSupportedPages();
          break;
        case 'home':
          result = await scraper.home(parseInt(params[0]) || 1);
          break;
        case 'genrelist':
          result = await scraper.genreList();
          break;
        case 'genre':
          if (!params[0]) throw new Error('Genre slug required (e.g: romance, action)');
          result = await scraper.genre(params[0], parseInt(params[1]) || 1);
          break;
        case 'movies':
          result = await scraper.movies(parseInt(params[0]) || 1);
          break;
        case 'jadwal':
          result = await scraper.jadwal();
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
        case 'watch':
          if (!params[0]) throw new Error('Episode slug required');
          result = await scraper.watch(params[0]);
          break;
        case 'batch':
          if (!params[0]) throw new Error('Anime slug required');
          result = await scraper.batch(params[0]);
          break;
        default:
          console.log(JSON.stringify({
            error: 'Invalid command',
            supported: [
              'supported - Show supported pages',
              'home [page] - Latest anime (paginated)',
              'genrelist - List of all genres',
              'genre <slug> [page] - Anime by genre (e.g: romance, action)',
              'movies [page] - Movie list (paginated)',
              'jadwal - Schedule page (may be empty)',
              'search <query> - Search anime',
              'detail <slug> - Anime detail + episodes',
              'episode <slug> - Episode streams + downloads',
              'watch <slug> - Stream only (title + video)',
              'batch <slug> - Batch download links (10 episodes max)'
            ]
          }, null, 2));
          process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(JSON.stringify({ error: err.message }, null, 2));
      process.exit(1);
    }
  })();
}

module.exports = AnimeIndoScraper;
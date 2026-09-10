/*
- base : https://s13.nontonanimeid.boats
- creator : phrzy
- channel : https://whatsapp.com/channel/0029VbD1zGq6mYPUbtVh6U0L/121
*/

const cheerio = require('cheerio');
const https = require('https');
const http = require('http');

const BASE = 'https://s13.nontonanimeid.boats';

const headers = {
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'referer': BASE + '/'
};

function fetchPage(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchPage(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function postAjax(url, body, postUrl) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const u = new URL(url);
        const opts = {
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname,
            method: 'POST',
            headers: {
                'user-agent': headers['user-agent'],
                'accept': '*/*',
                'origin': BASE,
                'referer': postUrl || BASE + '/',
                'x-requested-with': 'XMLHttpRequest',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'content-length': Buffer.byteLength(body)
            }
        };
        const req = mod.request(opts, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
    });
}

// === SCRAPE FUNCTIONS ===

async function getLatestEpisodes(page = 1) {
    const url = page === 1 ? BASE + '/' : BASE + '/page/' + page + '/';
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
    const episodes = [];
    $('article.animeseries').each((_, el) => {
        const $el = $(el);
        const link = $el.find('a').first().attr('href') || '';
        const epNum = $el.find('.episodes').text().replace(/\D/g, '').trim();
        const title = $el.find('.title span').attr('data-title-default') || $el.find('.title').text().trim();
        const img = $el.find('img').attr('src') || '';
        episodes.push({ title, episode: epNum, url: link, thumbnail: img });
    });
    return episodes;
}

async function getHomeContent(page = 1) {
    const url = page === 1 ? BASE + '/' : BASE + '/page/' + page + '/';
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
    const episodes = [];
    $('article.animeseries').each((_, el) => {
        const $el = $(el);
        const link = $el.find('a').first().attr('href') || '';
        const epNum = $el.find('.episodes').text().replace(/\D/g, '').trim();
        const title = $el.find('.title span').attr('data-title-default') || $el.find('.title').text().trim();
        const img = $el.find('img').attr('src') || '';
        episodes.push({ title, episode: epNum, url: link, thumbnail: img });
    });
    const tabs = {};
    const tabLabels = {};
    $('#series-footer .tabs1 li').each((_, li) => {
        const $li = $(li);
        const id = $li.attr('data-tab1') || '';
        const label = $li.text().trim();
        if (id && label) tabLabels[id] = label;
    });
    $('#series-footer .tab-content1').each((_, tabEl) => {
        const $tab = $(tabEl);
        const tabId = $tab.attr('id') || '';
        const items = [];
        $tab.find('.animeseries').each((_, el) => {
            const $el = $(el);
            const link = $el.find('a').first().attr('href') || '';
            const title = $el.find('.title span').text().trim();
            const score = $el.find('.kotakscore').text().replace(/[^\d.]/g, '').trim();
            const img = $el.find('img').attr('src') || '';
            if (title) items.push({ title, url: link, thumbnail: img, score });
        });
        if (items.length) tabs[tabLabels[tabId] || tabId] = items;
    });
    return { latestEpisodes: episodes, series: tabs };
}

async function searchAnime(query) {
    const url = BASE + '/?s=' + encodeURIComponent(query);
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
    const results = [];
    $('.as-anime-card').each((_, el) => {
        const $el = $(el);
        const link = $el.attr('href') || '';
        const title = $el.find('.as-anime-title').attr('data-title-default') || $el.find('.as-anime-title').text().trim();
        const img = $el.find('img').attr('src') || '';
        const rating = $el.find('.as-rating').text().replace(/[^\d.]/g, '').trim();
        const type = $el.find('.as-type').text().trim().replace(/^[^\w]+/, '').trim();
        const season = $el.find('.as-season').text().replace(/📅\s*/g, '').trim();
        if (title) results.push({ title, url: link, thumbnail: img, rating, type, season });
    });
    return results;
}

async function advancedSearch(opts = {}) {
    const params = new URLSearchParams();
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.status) params.set('status', opts.status);
    if (opts.type) params.set('type', opts.type);
    if (opts.score_min) params.set('score_min', opts.score_min);
    if (opts.score_max) params.set('score_max', opts.score_max);
    if (opts.year_min) params.set('year_min', opts.year_min);
    if (opts.year_max) params.set('year_max', opts.year_max);
    if (opts.genre) params.set('genre', opts.genre);
    if (opts.rating) params.set('rating', opts.rating);
    if (opts.mode) params.set('mode', opts.mode);
    const qs = params.toString();
    const url = BASE + '/anime/' + (qs ? '?' + qs : '');
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
    const results = [];
    $('.as-anime-card').each((_, el) => {
        const $el = $(el);
        const link = $el.attr('href') || '';
        const title = $el.find('.as-anime-title').attr('data-title-default') || $el.find('.as-anime-title').text().trim();
        const img = $el.find('img').attr('src') || '';
        const rating = $el.find('.as-rating').text().replace(/[^\d.]/g, '').trim();
        const type = $el.find('.as-type').text().trim().replace(/^[^\w]+/, '').trim();
        const season = $el.find('.as-season').text().replace(/📅\s*/g, '').trim();
        const synopsis = $el.find('.as-synopsis').text().trim();
        const genres = [];
        $el.find('.as-genre-tag').each((_, g) => { genres.push($(g).text().trim()); });
        if (title) results.push({ title, url: link, thumbnail: img, rating, type, season, synopsis, genres });
    });
    return results;
}

async function getAnimeList(page = 1) {
    const url = BASE + '/anime/page/' + page + '/';
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
    const anime = [];
    $('.as-anime-card').each((_, el) => {
        const $el = $(el);
        const link = $el.attr('href') || '';
        const title = $el.find('.as-anime-title').attr('data-title-default') || $el.find('.as-anime-title').text().trim();
        const img = $el.find('img').attr('src') || '';
        const rating = $el.find('.as-rating').text().replace(/[^\d.]/g, '').trim();
        const type = $el.find('.as-type').text().trim().replace(/^[^\w]+/, '').trim();
        const season = $el.find('.as-season').text().replace(/📅\s*/g, '').trim();
        if (title) anime.push({ title, url: link, thumbnail: img, rating, type, season });
    });
    return anime;
}

async function getAnimeDetail(animeUrl) {
    const html = await fetchPage(animeUrl);
    const $ = cheerio.load(html);
    const titleEl = $('.entry-title span').first();
    const title = titleEl.attr('data-title-default') || $('.entry-title').text().replace(/Nonton|Sub Indo/g, '').trim();
    const titleEn = titleEl.attr('data-title-en') || '';
    const titleJp = titleEl.attr('data-title-jp') || '';
    const score = $('.anime-card__score .value').text().trim();
    const type = $('.anime-card__score .type').text().trim();
    const synopsis = $('.synopsis-prose p').text().trim();
    const genres = [];
    $('.anime-card__genres .genre-tag').each((_, el) => { genres.push($(el).text().trim()); });
    const info = {};
    $('.details-list li').each((_, el) => {
        const text = $(el).text().trim();
        const m = text.match(/^([\w\s]+):\s*(.+)$/);
        if (m) info[m[1].trim()] = m[2].trim();
    });
    const quickInfo = $('.anime-card__quick-info').text().trim();
    const statusMatch = quickInfo.match(/(Finished Airing|Currently Airing|Not yet aired)/i);
    const epMatch = quickInfo.match(/(\d+)\s*Episodes?/i);
    const durMatch = quickInfo.match(/([\d.]+)\s*min/i);
    const seasonMatch = quickInfo.match(/(Fall|Winter|Spring|Summer)\s+\d{4}/i);
    const episodes = [];
    $('.episode-list-items .episode-item').each((_, el) => {
        const $el = $(el);
        episodes.push({ title: $el.find('.ep-title').text().trim(), date: $el.find('.ep-date').text().trim(), url: $el.attr('data-episode-url') || $el.attr('href') || '' });
    });
    const firstEp = $('.meta-episode-item.first a').attr('data-episode-url') || '';
    const lastEp = $('.meta-episode-item.last a').attr('data-episode-url') || '';
    const recommended = [];
    $('.related .as-anime-card').each((_, el) => {
        const $el = $(el);
        recommended.push({ title: $el.find('.as-anime-title').attr('data-title-default') || $el.find('.as-anime-title').text().trim(), url: $el.attr('href') || '', thumbnail: $el.find('img').attr('src') || '', rating: $el.find('.as-rating').text().replace(/[^\d.]/g, '').trim() });
    });
    return {
        title, titleEn, titleJp, score, type, synopsis, genres,
        studios: info['Studios'] || '',
        rating: info['Rating'] || '',
        popularity: info['Popularity'] || '',
        members: info['Members'] || '',
        aired: info['Aired'] || '',
        status: statusMatch ? statusMatch[1] : '',
        totalEpisodes: epMatch ? epMatch[1] : '',
        duration: durMatch ? durMatch[1] + ' min' : '',
        season: seasonMatch ? seasonMatch[0] : '',
        episodes, firstEpisode: firstEp, lastEpisode: lastEp, recommended
    };
}

async function getEpisodeStream(episodeUrl) {
    const html = await fetchPage(episodeUrl);
    const $ = cheerio.load(html);
    const titleEl = $('.entry-title span').first();
    const epTitle = (titleEl.attr('data-title-default') || titleEl.text().trim()) + ' Episode ' + ($('.entry-title').text().match(/Episode\s+(\d+)/i) || [, ''])[1];
    const titleEn = titleEl.attr('data-title-en') || '';
    let nonce = '';
    let postId = '';
    const b64Matches = html.match(/data:text\/javascript;base64,([A-Za-z0-9+/=]+)/g) || [];
    for (const match of b64Matches) {
        const encoded = match.split('base64,')[1];
        if (!encoded) continue;
        try {
            const decoded = Buffer.from(encoded, 'base64').toString('utf8');
            const m = decoded.match(/"nonce"\s*:\s*"([^"]+)"/);
            if (m) nonce = m[1];
        } catch (e) { }
    }
    $('script').each((_, el) => {
        const text = $(el).html() || '';
        if (!nonce) { const m = text.match(/"nonce"\s*:\s*"([^"]+)"/); if (m) nonce = m[1]; }
    });
    const firstOption = $('#player-option-1');
    postId = firstOption.attr('data-post') || '';
    const servers = [];
    $('.kotak_player_option').each((_, el) => {
        const $el = $(el);
        servers.push({ name: $el.find('span').text().trim(), type: $el.attr('data-type') || '', nume: $el.attr('data-nume') || '', post: $el.attr('data-post') || '' });
    });
    let defaultEmbed = '';
    const iframe = $('#videoku iframe[data-src]');
    if (iframe.length) defaultEmbed = iframe.attr('data-src') || '';
    const downloads = [];
    $('#download_area .listlink').each((_, el) => {
        const $el = $(el);
        const format = $el.find('span').text().trim();
        const links = [];
        $el.find('a').each((_, a) => { links.push({ label: $(a).text().trim(), url: $(a).attr('href') || '' }); });
        if (format) downloads.push({ format, links });
    });
    const prevLink = $('.nvs a:first').attr('href') || '';
    const nextLink = $('.nvs:last a').attr('href') || '';
    const nextDisabled = $('.nvs .nonex').length > 0;
    const allEpLink = $('.nvsc a').attr('href') || '';
    const epNav = $('.types.episodes').text().trim();
    const nav = { prev: nextDisabled ? '' : prevLink, next: nextDisabled ? '' : nextLink, allEpisodes: allEpLink, current: epNav };
    return { title: epTitle, titleEn, postId, nonce, servers, defaultEmbed, downloads, navigation: nav };
}

async function getStreamSource(postId, nume, serverName, nonce, postUrl) {
    const url = BASE + '/wp-admin/admin-ajax.php';
    const body = `action=player_ajax&post=${encodeURIComponent(postId)}&nume=${encodeURIComponent(nume)}&serverName=${encodeURIComponent(serverName)}&nonce=${encodeURIComponent(nonce)}`;
    const html = await postAjax(url, body, postUrl);
    const $ = cheerio.load(html);
    const iframe = $('iframe');
    const src = iframe.attr('data-src') || iframe.attr('src') || '';
    return { server: serverName, embedUrl: src, rawHtml: html.trim() };
}

async function getGenres() {
    const html = await fetchPage(BASE + '/genres/');
    const $ = cheerio.load(html);
    const genres = [];
    $('.genre-grid-card').each((_, el) => {
        const $el = $(el);
        const name = $el.find('.genre-name').text().trim();
        const link = $el.attr('href') || '';
        const total = $el.find('.count span').text().replace(/\D/g, '').trim();
        const ongoing = $el.find('.ongoing span').text().replace(/\D/g, '').trim();
        genres.push({ name, url: link, total: parseInt(total) || 0, ongoing: parseInt(ongoing) || 0 });
    });
    return genres;
}

async function getGenreAnime(genreSlug, page = 1) {
    const url = page === 1 ? BASE + '/genres/' + genreSlug + '/' : BASE + '/genres/' + genreSlug + '/page/' + page + '/';
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
    const anime = [];
    $('.as-anime-card').each((_, el) => {
        const $el = $(el);
        const link = $el.attr('href') || '';
        const title = $el.find('.as-anime-title').attr('data-title-default') || $el.find('.as-anime-title').text().trim();
        const img = $el.find('img').attr('src') || '';
        const rating = $el.find('.as-rating').text().replace(/[^\d.]/g, '').trim();
        if (title) anime.push({ title, url: link, thumbnail: img, rating });
    });
    return anime;
}

async function getOngoingList() {
    const html = await fetchPage(BASE + '/ongoing-list/');
    const $ = cheerio.load(html);
    const anime = [];
    $('.gacha-card').each((_, el) => {
        const $el = $(el);
        const link = $el.attr('href') || '';
        const title = $el.find('.title').text().trim();
        const currentEp = $el.find('.current-ep').text().trim();
        const totalEp = $el.find('.total-ep').text().trim();
        const score = $el.find('.skor-angka').text().replace(/[()]/g, '').trim();
        const rarity = $el.hasClass('rarity-5') ? 5 : $el.hasClass('rarity-4') ? 4 : 3;
        anime.push({ title, url: link, currentEpisode: currentEp, totalEpisode: totalEp, score, rarity });
    });
    return anime;
}

async function getPopularSeries() {
    const html = await fetchPage(BASE + '/popular-series/');
    const $ = cheerio.load(html);
    const tabs = {};
    $('.tab-content').each((_, tabEl) => {
        const $tab = $(tabEl);
        const tabId = $tab.attr('id') || '';
        const items = [];
        $tab.find('.animeseries').each((_, el) => {
            const $el = $(el);
            const link = $el.find('a').first().attr('href') || '';
            const title = $el.find('.title span').text().trim();
            const score = $el.find('.kotakscore').text().replace(/[^\d.]/g, '').trim();
            const img = $el.find('img').attr('src') || '';
            if (title) items.push({ title, url: link, thumbnail: img, score });
        });
        tabs[tabId] = items;
    });
    const tabLabels = {};
    $('.tabs li').each((_, li) => {
        const $li = $(li);
        const id = $li.attr('data-tab') || '';
        const label = $li.text().trim();
        if (id && label) tabLabels[id] = label;
    });
    const result = [];
    for (const [id, items] of Object.entries(tabs)) {
        const label = tabLabels[id] || id;
        items.forEach(item => { item.genre = label; result.push(item); });
    }
    return result;
}

async function getJadwalRilis() {
    const html = await fetchPage(BASE + '/jadwal-rilis/');
    const $ = cheerio.load(html);
    const schedule = {};
    $('.as-tab-content').each((_, el) => {
        const $el = $(el);
        const day = $el.attr('id') || '';
        const animeList = [];
        $el.find('.as-anime-card').each((_, card) => {
            const $card = $(card);
            animeList.push({ title: $card.find('.as-anime-title').text().trim(), url: $card.attr('href') || '' });
        });
        if (day && animeList.length) schedule[day] = animeList;
    });
    return schedule;
}

async function getRecentUpdates() {
    const html = await fetchPage(BASE + '/');
    const $ = cheerio.load(html);
    const updates = [];
    $('.latestepisodes li').each((_, el) => {
        const $el = $(el);
        const link = $el.find('a').attr('href') || '';
        const title = $el.find('.lefts').text().trim();
        const ep = $el.find('.video').text().replace(/\D/g, '').trim();
        if (title) updates.push({ title, episode: ep, url: link });
    });
    return updates;
}

async function getTopAnime() {
    const html = await fetchPage(BASE + '/popular-series/');
    const $ = cheerio.load(html);
    const top = [];
    $('.contentpost .rank li').each((_, el) => {
        const $el = $(el);
        const link = $el.find('a').attr('href') || '';
        const title = $el.find('h2').text().trim();
        const synopsis = $el.find('p').text().trim();
        const genres = $el.find('.viewer').text().replace('Genre :', '').trim();
        const img = $el.find('img').attr('src') || '';
        if (title) top.push({ title, url: link, thumbnail: img, synopsis, genres });
    });
    return top;
}

async function getSeasonAnime(season) {
    const url = BASE + '/premiereds/' + season.toLowerCase().replace(/\s+/g, '-') + '/';
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
    const anime = [];
    $('.as-anime-card').each((_, el) => {
        const $el = $(el);
        const link = $el.attr('href') || '';
        const title = $el.find('.as-anime-title').attr('data-title-default') || $el.find('.as-anime-title').text().trim();
        const img = $el.find('img').attr('src') || '';
        const rating = $el.find('.as-rating').text().replace(/[^\d.]/g, '').trim();
        if (title) anime.push({ title, url: link, thumbnail: img, rating });
    });
    return anime;
}

function printUsage() {
    console.log(`
NontonAnimeID Scraper - Lengkap Sampai Streaming
=================================================
Usage:
  node scraper.js home [page]                            Homepage lengkap
  node scraper.js latest [page]                          Episode terbaru
  node scraper.js search <query>                         Cari anime
  node scraper.js advsearch [opts]                       Advanced search
  node scraper.js list [page]                            Daftar anime
  node scraper.js anime <url>                            Detail anime + episode list
  node scraper.js episode <url>                          Info episode + server + download
  node scraper.js stream <url>                           Streaming semua server (1-8)
  node scraper.js stream <url> <server-nume>             Streaming server tertentu
  node scraper.js genres                                 Daftar semua genre
  node scraper.js genre <slug> [page]                    Anime berdasarkan genre
  node scraper.js ongoing                                Anime ongoing/tayang
  node scraper.js popular                                Anime populer per genre
  node scraper.js schedule                               Jadwal rilis
  node scraper.js recent                                 Episode terbaru (sidebar)
  node scraper.js top                                    Anime rating tertinggi
  node scraper.js season <season>                        Anime per season

Advanced Search Options:
  --sort=series_skor|series_popularity|series_tahun_newest|series_tahun_oldest|series_title
  --status=Currently Airing|Finished Airing
  --type=TV|Movie|OVA|ONA|Special|CM|Music|PV|TV Special
  --score_min=<n> --score_max=<n>
  --year_min=<n> --year_max=<n>
  --genre=action,comedy,fantasy,romance,...
  --rating=G - All Ages|PG - Children|PG-13|R - 17+|R+ - Mild Nudity|R18+

Contoh:
  node scraper.js latest
  node scraper.js search "one punch man"
  node scraper.js advsearch --sort=series_skor --status=Currently Airing --type=TV
  node scraper.js advsearch --genre=isekai --score_min=7 --year_min=2024
  node scraper.js list
  node scraper.js anime https://s13.nontonanimeid.boats/anime/one-punch-man/
  node scraper.js episode https://s13.nontonanimeid.boats/kore-kaite-shine-episode-8/
  node scraper.js stream https://s13.nontonanimeid.boats/kore-kaite-shine-episode-8/
  node scraper.js genres
  node scraper.js genre action
  node scraper.js ongoing
  node scraper.js popular
  node scraper.js schedule
  node scraper.js recent
  node scraper.js top
  node scraper.js season "Summer 2026"
`);
}

async function main() {
    const args = process.argv.slice(2);
    const cmd = args[0];

    try {
        if (!cmd || cmd === 'help') { printUsage(); return; }

        if (cmd === 'home') {
            const page = parseInt(args[1]) || 1;
            console.log(JSON.stringify(await getHomeContent(page), null, 2));
            return;
        }

        if (cmd === 'latest') {
            const page = parseInt(args[1]) || 1;
            console.log(JSON.stringify(await getLatestEpisodes(page), null, 2));
            return;
        }

        if (cmd === 'search') {
            const q = args.slice(1).join(' ');
            if (!q) { console.log('Query required'); return; }
            console.log(JSON.stringify(await searchAnime(q), null, 2));
            return;
        }

        if (cmd === 'advsearch') {
            const opts = {};
            args.slice(1).forEach(a => {
                const m = a.match(/^--(\w+)=(.+)$/);
                if (m) opts[m[1]] = m[2];
            });
            console.log(JSON.stringify(await advancedSearch(opts), null, 2));
            return;
        }

        if (cmd === 'list') {
            const page = parseInt(args[1]) || 1;
            console.log(JSON.stringify(await getAnimeList(page), null, 2));
            return;
        }

        if (cmd === 'anime') {
            const url = args[1];
            if (!url) { console.log('URL required'); return; }
            console.log(JSON.stringify(await getAnimeDetail(url), null, 2));
            return;
        }

        if (cmd === 'episode') {
            const url = args[1];
            if (!url) { console.log('URL required'); return; }
            console.log(JSON.stringify(await getEpisodeStream(url), null, 2));
            return;
        }

        if (cmd === 'stream') {
            const url = args[1];
            const specificNume = args[2];
            if (!url) { console.log('URL required'); return; }
            const epData = await getEpisodeStream(url);
            if (!epData.nonce || !epData.postId) { console.log(JSON.stringify({ status: false, message: 'Failed to extract nonce or post ID', data: epData }, null, 2)); return; }
            const servers = specificNume ? epData.servers.filter(s => s.nume === specificNume) : epData.servers;
            if (!servers.length) { console.log('Server not found'); return; }
            const results = [];
            for (const srv of servers) {
                results.push(await getStreamSource(srv.post || epData.postId, srv.nume, srv.type, epData.nonce, url));
            }
            console.log(JSON.stringify({ title: epData.title, postId: epData.postId, streams: results, downloads: epData.downloads }, null, 2));
            return;
        }

        if (cmd === 'genres') {
            console.log(JSON.stringify(await getGenres(), null, 2));
            return;
        }

        if (cmd === 'genre') {
            const slug = args[1];
            const page = parseInt(args[2]) || 1;
            if (!slug) { console.log('Genre slug required'); return; }
            console.log(JSON.stringify(await getGenreAnime(slug, page), null, 2));
            return;
        }

        if (cmd === 'ongoing') {
            console.log(JSON.stringify(await getOngoingList(), null, 2));
            return;
        }

        if (cmd === 'popular') {
            console.log(JSON.stringify(await getPopularSeries(), null, 2));
            return;
        }

        if (cmd === 'schedule') {
            console.log(JSON.stringify(await getJadwalRilis(), null, 2));
            return;
        }

        if (cmd === 'recent') {
            console.log(JSON.stringify(await getRecentUpdates(), null, 2));
            return;
        }

        if (cmd === 'top') {
            console.log(JSON.stringify(await getTopAnime(), null, 2));
            return;
        }

        if (cmd === 'season') {
            const s = args.slice(1).join(' ');
            if (!s) { console.log('Season required (e.g. "Summer 2026")'); return; }
            console.log(JSON.stringify(await getSeasonAnime(s), null, 2));
            return;
        }

        printUsage();
    } catch (err) {
        console.log(JSON.stringify({ status: false, message: err.message }));
    }
}

main();
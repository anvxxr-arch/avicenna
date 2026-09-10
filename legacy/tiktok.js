/*
· base : https://www.tiktok.com/
· creator : phrzy
· channel : https://whatsapp.com/channel/0029VbD1zGq6mYPUbtVh6U0L/121
*/

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.tiktok.com';

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const webId = '7' + Math.floor(1000000000000000 + Math.random() * 9000000000000000);

function getHeaders(extra) {
  return {
    'User-Agent': UA_MOBILE,
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/json',
    'Referer': BASE_URL + '/',
    'Cookie': `tt_webid_v2=${webId}; ttwid=${webId}; msToken=${'x'.repeat(107)}`,
    ...extra
  };
}

function grabCookies(resp) {
  const parts = [];
  (resp.headers['set-cookie'] || []).forEach((c) => {
    const part = c.split(';')[0];
    if (part && parts.indexOf(part) === -1) parts.push(part);
  });
  return parts.join('; ');
}

async function fetchPage(url, opts) {
  const retries = opts && opts.retries !== undefined ? opts.retries : 3;
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await axios.get(url, {
        headers: getHeaders(),
        timeout: 25000,
        maxRedirects: 5
      });
      if (resp.data && resp.data.length > 10000) {
        return { resp, cookies: grabCookies(resp), html: resp.data };
      }
      if (i === retries - 1) return { resp, cookies: grabCookies(resp), html: resp.data };
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw lastErr || new Error('gagal ambil halaman');
}

function parseApiData(html) {
  const $ = cheerio.load(html);
  const script = $('script#api-data').html();
  if (!script) return null;
  try {
    return JSON.parse(script);
  } catch (err) {
    return null;
  }
}

function parseUniversal(html) {
  const $ = cheerio.load(html);
  const script = $('script#__UNIVERSAL_DATA_FOR_REHYDRATION__').html();
  if (!script) return null;
  try {
    return JSON.parse(script);
  } catch (err) {
    return null;
  }
}

function cleanVideoUrl(url) {
  if (!url) return null;
  if (url.indexOf('/playwm/') !== -1) {
    return url.replace('/playwm/', '/play/');
  }
  return url;
}

function takeAvatar(avatar) {
  if (!avatar) return null;
  if (typeof avatar === 'string') return avatar;
  if (avatar.urlList && avatar.urlList.length) return avatar.urlList[0];
  return null;
}

function extractVideo(item) {
  if (!item) return null;
  const video = item.video || {};
  const author = item.author || {};
  const stats = item.stats || {};
  const music = item.music || {};

  let play = video.playAddr;
  let download = video.downloadAddr;
  if (Array.isArray(play)) play = play.length ? play[play.length - 1].url : null;
  if (typeof play !== 'string') play = null;
  if (Array.isArray(download)) download = download.length ? download[download.length - 1].url : null;
  if (typeof download !== 'string') download = null;

  const coverList = [video.cover, video.dynamicCover, video.originCover].filter(Boolean);
  let cover = coverList.length ? coverList[0] : null;
  if (typeof cover === 'object') cover = cover.urlList ? cover.urlList[0] : null;

  return {
    id: String(item.id || ''),
    desc: item.desc || '',
    createTime: item.createTime || 0,
    author: author.uniqueId || '',
    nickname: author.nickname || '',
    avatar: takeAvatar(author.avatarLarger) || takeAvatar(author.avatarThumb),
    signature: author.signature || '',
    verified: !!author.verified,
    cover,
    duration: video.duration || 0,
    playCount: stats.playCount || 0,
    likeCount: stats.diggCount || 0,
    commentCount: stats.commentCount || 0,
    shareCount: stats.shareCount || 0,
    collectCount: stats.collectCount || 0,
    music: music.title || '',
    musicUrl: music.playUrl || '',
    noWatermark: cleanVideoUrl(play) || cleanVideoUrl(download) || null,
    withWatermark: cleanVideoUrl(download) || cleanVideoUrl(play) || null
  };
}

function extractIdFromUrl(url) {
  const m = String(url).match(/\/video\/(\d{10,})/);
  return m ? m[1] : null;
}

async function resolveShortLink(url) {
  if (!/vm\.tiktok\.com|vt\.tiktok\.com/.test(url)) return url;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA_MOBILE },
    maxRedirects: 0,
    validateStatus: () => true,
    timeout: 20000
  });
  const location = resp.headers['location'] || resp.request.res.headers.location;
  return location || url;
}

async function getVideo(url) {
  const fullUrl = await resolveShortLink(url);
  const videoId = extractIdFromUrl(fullUrl);

  const { cookies, html } = await fetchPage(fullUrl);
  const api = parseApiData(html);

  let item = null;
  if (api && api.videoDetail && api.videoDetail.itemInfo && api.videoDetail.itemInfo.itemStruct) {
    item = api.videoDetail.itemInfo.itemStruct;
  } else if (api && api.itemInfo && api.itemInfo.itemStruct) {
    item = api.itemInfo.itemStruct;
  }

  if (!item) {
    const uni = parseUniversal(html);
    const scope = uni && uni['__DEFAULT_SCOPE__'];
    if (scope) {
      Object.keys(scope).forEach((key) => {
        const val = scope[key];
        if (val && val.itemInfo && val.itemInfo.itemStruct) item = val.itemInfo.itemStruct;
        if (val && val.videoDetail && val.videoDetail.itemInfo) item = val.videoDetail.itemInfo.itemStruct;
      });
    }
  }

  const info = extractVideo(item);
  if (!info) return { error: 'video tidak ditemukan (kemungkinan kena rate-limit)', url: fullUrl };

  if (!info.id && videoId) info.id = videoId;
  info.pageUrl = fullUrl;
  info.sessionCookies = cookies;
  return info;
}

async function getUser(username) {
  const clean = String(username).replace(/^@/, '').replace(/[?#].*$/, '').trim();
  const { html } = await fetchPage(`${BASE_URL}/@${clean}`);

  let userData = null;
  const uni = parseUniversal(html);
  const scope = uni && uni['__DEFAULT_SCOPE__'];
  if (scope) {
    Object.keys(scope).forEach((key) => {
      const val = scope[key];
      if (val && val.userInfo && val.userInfo.user) userData = val.userInfo;
    });
  }

  if (!userData) {
    const api = parseApiData(html);
    if (api && api.userDetail && api.userDetail.userInfo) userData = api.userDetail.userInfo;
  }

  if (!userData) return { error: 'profil tidak ditemukan', username: clean };

  const user = userData.user || {};
  const stats = userData.stats || {};
  const totalLikes = stats.heartCount || stats.heart || user.heartCount || 0;

  return {
    username: user.uniqueId || clean,
    nickname: user.nickname || '',
    avatar: takeAvatar(user.avatarLarger) || takeAvatar(user.avatarThumb),
    bio: user.signature || '',
    verified: !!user.verified,
    private: !!user.privateAccount,
    followers: stats.followerCount || 0,
    following: stats.followingCount || 0,
    hearts: totalLikes,
    likesCount: totalLikes,
    videosCount: stats.videoCount || user.videoCount || 0,
    secUid: user.secUid || ''
  };
}

async function downloadVideo(url, nama) {
  const info = await getVideo(url);
  if (!info || !info.noWatermark) {
    throw new Error('gagal ambil link video');
  }

  const file = nama || (info.id ? `${info.id}.mp4` : 'video.mp4');
  const dir = path.dirname(file);
  if (fs.existsSync(dir) === false && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }

  const resp = await axios.get(info.noWatermark, {
    responseType: 'stream',
    timeout: 60000,
    maxRedirects: 10,
    headers: {
      'User-Agent': UA_MOBILE,
      'Referer': info.pageUrl || BASE_URL + '/',
      'Cookie': info.sessionCookies || '',
      'Accept': 'video/mp4,*/*'
    }
  });

  const writer = fs.createWriteStream(file);
  resp.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return { file, size: info.playCount, id: info.id, desc: info.desc };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'help';

  if (cmd === 'video') {
    const info = await getVideo(args[1]);
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  if (cmd === 'user') {
    const info = await getUser(args[1]);
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  if (cmd === 'download') {
    const hasil = await downloadVideo(args[1], args[2]);
    console.log(JSON.stringify({ status: 'ok', file: hasil.file }, null, 2));
    return;
  }

  console.log(`
  Cara pakai:
    node scrape.js video <url_video>
    node scrape.js user <username>
    node scrape.js download <url_video> [nama.mp4]
  `);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
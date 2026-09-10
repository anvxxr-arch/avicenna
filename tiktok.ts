#!/usr/bin/env bun
/*
- base : https://www.tiktok.com
- creator : phrzy
- migrated to core/ (spec 003) — ESM, hardened transport, uniform CLI
- cookie/webid session logic preserved via site config headers
*/

import * as cheerio from 'cheerio';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

const BASE_URL = 'https://www.tiktok.com';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const webId = '7' + Math.floor(1000000000000000 + Math.random() * 9000000000000000);

const site = createSite({
  base: BASE_URL,
  rateMs: 700,
  headers: {
    'user-agent': UA_MOBILE,
    'accept-language': 'id-ID,id;q=0.9,en;q=0.8',
    'accept': 'text/html,application/xhtml+xml,application/json',
    'referer': BASE_URL + '/',
    'cookie': `tt_webid_v2=${webId}; ttwid=${webId}; msToken=${'x'.repeat(107)}`,
  },
});
const { fetchPage, isValidUrl } = site;

function grabCookies(res: Response): string {
  const parts: string[] = [];
  res.headers.getSetCookie?.().forEach((c) => {
    const part = c.split(';')[0];
    if (part && !parts.includes(part)) parts.push(part);
  });
  return parts.join('; ');
}

async function fetchTikTokPage(url: string): Promise<{ cookies: string; html: string }> {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA_MOBILE,
      'accept-language': 'id-ID,id;q=0.9,en;q=0.8',
      'accept': 'text/html,application/xhtml+xml,application/json',
      'referer': BASE_URL + '/',
      'cookie': `tt_webid_v2=${webId}; ttwid=${webId}; msToken=${'x'.repeat(107)}`,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });
  const cookies = grabCookies(res);
  const html = await res.text();
  return { cookies, html };
}

function parseApiData(html: string): Record<string, unknown> | null {
  const $ = cheerio.load(html);
  const script = $('script#api-data').html();
  if (!script) return null;
  try { return JSON.parse(script); } catch { return null; }
}

function parseUniversal(html: string): Record<string, unknown> | null {
  const $ = cheerio.load(html);
  const script = $('script#__UNIVERSAL_DATA_FOR_REHYDRATION__').html();
  if (!script) return null;
  try { return JSON.parse(script); } catch { return null; }
}

function cleanVideoUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.indexOf('/playwm/') !== -1) return url.replace('/playwm/', '/play/');
  return url;
}

function takeAvatar(avatar: unknown): string | null {
  if (!avatar) return null;
  if (typeof avatar === 'string') return avatar;
  const a = avatar as { urlList?: string[] };
  if (a.urlList && a.urlList.length) return a.urlList[0];
  return null;
}

function extractVideo(item: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!item) return null;
  const video = (item.video || {}) as Record<string, unknown>;
  const author = (item.author || {}) as Record<string, unknown>;
  const stats = (item.stats || {}) as Record<string, number>;
  const music = (item.music || {}) as Record<string, unknown>;

  let play = video.playAddr as string | string[] | undefined;
  let download = video.downloadAddr as string | string[] | undefined;
  if (Array.isArray(play)) play = play.length ? (play[play.length - 1] as { url?: string }).url ?? null : null;
  if (typeof play !== 'string') play = null;
  if (Array.isArray(download)) download = download.length ? (download[download.length - 1] as { url?: string }).url ?? null : null;
  if (typeof download !== 'string') download = null;

  const coverList = [video.cover, video.dynamicCover, video.originCover].filter(Boolean);
  let cover: string | null = coverList.length ? (coverList[0] as string) : null;
  if (cover && typeof cover === 'object') {
    const c = cover as unknown as { urlList?: string[] };
    cover = c.urlList ? c.urlList[0] : null;
  }

  const numv = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const strs = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    id: String(item.id || ''),
    desc: strs(item.desc),
    createTime: numv(item.createTime),
    author: strs(author.uniqueId),
    nickname: strs(author.nickname),
    avatar: takeAvatar(author.avatarLarger) || takeAvatar(author.avatarThumb),
    signature: strs(author.signature),
    verified: !!author.verified,
    cover,
    duration: numv(video.duration),
    playCount: numv(stats.playCount),
    likeCount: numv(stats.diggCount),
    commentCount: numv(stats.commentCount),
    shareCount: numv(stats.shareCount),
    collectCount: numv(stats.collectCount),
    music: strs(music.title),
    musicUrl: strs(music.playUrl),
    noWatermark: cleanVideoUrl(play) || cleanVideoUrl(download) || null,
    withWatermark: cleanVideoUrl(download) || cleanVideoUrl(play) || null,
  };
}

function extractIdFromUrl(url: string): string | null {
  const m = String(url).match(/\/video\/(\d{10,})/);
  return m ? m[1] : null;
}

async function resolveShortLink(url: string): Promise<string> {
  if (!/vm\.tiktok\.com|vt\.tiktok\.com/.test(url)) return url;
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'user-agent': UA_MOBILE },
    signal: AbortSignal.timeout(20_000),
  });
  await res.body?.cancel().catch(() => {});
  return res.headers.get('location') || url;
}

function findItemStruct(obj: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4 || !obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (o.itemInfo && typeof o.itemInfo === 'object') {
    const ii = o.itemInfo as Record<string, unknown>;
    if (ii.itemStruct && typeof ii.itemStruct === 'object') return ii.itemStruct as Record<string, unknown>;
  }
  if (o.videoDetail && typeof o.videoDetail === 'object') {
    const vd = o.videoDetail as Record<string, unknown>;
    if (vd.itemInfo && typeof vd.itemInfo === 'object') {
      const ii = vd.itemInfo as Record<string, unknown>;
      if (ii.itemStruct && typeof ii.itemStruct === 'object') return ii.itemStruct as Record<string, unknown>;
    }
  }
  for (const v of Object.values(o)) {
    const found = findItemStruct(v, depth + 1);
    if (found) return found;
  }
  return null;
}

async function getVideo(url: string): Promise<Record<string, unknown>> {
  const fullUrl = await resolveShortLink(url);
  const videoId = extractIdFromUrl(fullUrl);
  const { cookies, html } = await fetchTikTokPage(fullUrl);

  let item = findItemStruct(parseApiData(html)) || findItemStruct(parseUniversal(html));

  const info = extractVideo(item) as Record<string, unknown>;
  if (!Object.keys(info).length || !info.id) {
    return { error: 'video tidak ditemukan (kemungkinan kena rate-limit)', url: fullUrl };
  }
  if (!info.id && videoId) info.id = videoId;
  info.pageUrl = fullUrl;
  info.sessionCookies = cookies;
  return info;
}

async function getUser(username: string): Promise<Record<string, unknown>> {
  const clean = String(username).replace(/^@/, '').replace(/[?#].*$/, '').trim();
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(clean)) throw new Error('Invalid username');
  const { html } = await fetchTikTokPage(`${BASE_URL}/@${clean}`);

  let userData: Record<string, unknown> | null = null;
  const uni = parseUniversal(html);
  const scope = uni?.['__DEFAULT_SCOPE__'] as Record<string, unknown> | undefined;
  if (scope) {
    for (const val of Object.values(scope)) {
      const v = val as { userInfo?: { user?: Record<string, unknown>; stats?: Record<string, unknown> } };
      if (v?.userInfo?.user) { userData = v.userInfo as Record<string, unknown>; break; }
    }
  }
  if (!userData) {
    const api = parseApiData(html);
    const ud = api?.userDetail as { userInfo?: Record<string, unknown> } | undefined;
    if (ud?.userInfo) userData = ud.userInfo;
  }
  if (!userData) return { error: 'profil tidak ditemukan', username: clean };

  const user = (userData.user || {}) as Record<string, unknown>;
  const stats = (userData.stats || {}) as Record<string, number>;
  const totalLikes = stats.heartCount || (stats.heart as number) || (user.heartCount as number) || 0;
  const numv = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const strs = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    username: strs(user.uniqueId) || clean,
    nickname: strs(user.nickname),
    avatar: takeAvatar(user.avatarLarger) || takeAvatar(user.avatarThumb),
    bio: strs(user.signature),
    verified: !!user.verified,
    private: !!user.privateAccount,
    followers: numv(stats.followerCount),
    following: numv(stats.followingCount),
    hearts: totalLikes,
    likesCount: totalLikes,
    videosCount: numv(stats.videoCount) || numv(user.videoCount),
    secUid: strs(user.secUid),
  };
}

async function downloadVideo(url: string, nama?: string): Promise<{ file: string; id: string; desc: string }> {
  const info = (await getVideo(url)) as Record<string, unknown>;
  const noWm = info.noWatermark as string | null;
  if (!noWm) throw new Error('gagal ambil link video');
  if (!isValidUrl(noWm)) throw new Error('video URL blocked by guards');

  const file = nama || (info.id ? `${info.id}.mp4` : 'video.mp4');
  const dir = path.dirname(file);
  if (dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  const res = await fetch(noWm, {
    headers: {
      'user-agent': UA_MOBILE,
      'referer': (info.pageUrl as string) || BASE_URL + '/',
      'cookie': (info.sessionCookies as string) || '',
      'accept': 'video/mp4,*/*',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const writer = createWriteStream(file);
  const buf = await res.arrayBuffer();
  await new Promise<void>((resolve, reject) => {
    writer.on('finish', () => resolve());
    writer.on('error', reject);
    writer.end(Buffer.from(buf));
  });
  return { file, id: String(info.id || ''), desc: String(info.desc || '') };
}

if (import.meta.main) {
  defineCli({
    name: 'tiktok',
    title: 'TikTok Scraper',
    commands: {
      video: {
        desc: 'Info video (stats, no-watermark URL)', usage: '<url>',
        run: async (p) => {
          if (!p[0]) throw new Error('Video URL required');
          return getVideo(p[0]);
        },
      },
      user: {
        desc: 'Profil user (stats)', usage: '<username>',
        run: async (p) => {
          if (!p[0]) throw new Error('Username required');
          return getUser(p[0]);
        },
      },
      download: {
        desc: 'Download video no-watermark', usage: '<url> [nama.mp4]',
        run: async (p) => {
          if (!p[0]) throw new Error('Video URL required');
          const r = await downloadVideo(p[0], p[1]);
          return { status: 'ok', file: r.file };
        },
      },
    },
    examples: `  bun tiktok.ts video https://www.tiktok.com/@user/video/123
  bun tiktok.ts download https://vt.tiktok.com/xxx out.mp4`,
  });
}

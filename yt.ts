#!/usr/bin/env bun
/*
- base : https://m.youtube.com/
- creator : phrzy
- migrated to core/ guards (spec 003) — ESM, uniform CLI
- ANDROID_VR_KEY redacted in legacy source; set YT_ANDROID_VR_KEY env for `download`
*/

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

const BASE = 'https://m.youtube.com';
const API = 'https://m.youtube.com/youtubei/v1';
const ANDROID_VR_KEY = process.env.YT_ANDROID_VR_KEY || '';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const site = createSite({ base: BASE, rateMs: 400, headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' } });
const { fetchPage, isValidUrl } = site;

interface Cfg { key: string; version: string; visitorData: string; gl: string; }
let config: Cfg | null = null;

async function bootstrap(force = false): Promise<Cfg> {
  if (config && !force) return config;
  const html = await fetchPage(`${BASE}/`);
  const grab = (re: RegExp): string => {
    const m = html.match(re);
    if (!m) throw new Error(`bootstrap: pattern not found (${re.source.slice(0, 40)}...) — YouTube page format changed?`);
    return m[1];
  };
  config = {
    key: grab(/INNERTUBE_API_KEY":"([^"]+)"/),
    version: grab(/INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/),
    visitorData: grab(/visitorData":"([^"]+)"/),
    gl: (html.match(/"GL":"([^"]+)"/) || [])[1] || 'US',
  };
  return config;
}

async function youtubei(endpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { key } = await bootstrap();
  const res = await fetch(`${API}/${endpoint}?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, origin: BASE },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json() as Record<string, unknown> & { error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || 'youtubei error');
  return json;
}

function mweb(): Record<string, unknown> {
  return {
    clientName: 'MWEB',
    clientVersion: config!.version,
    visitorData: config!.visitorData,
    hl: 'en',
    gl: config!.gl,
  };
}

function text(runs: Array<{ text: string }> | undefined | null): string {
  return (runs || []).map((r) => r.text).join('').trim();
}

function thumbnail(thumbnails: Array<{ url: string; width?: number }> | undefined | null): string | null {
  if (!thumbnails || !thumbnails.length) return null;
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0].url;
}

function findAll(obj: unknown, key: string, out: unknown[] = []): unknown[] {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const item of obj) findAll(item, key, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) out.push(v);
    else findAll(v, key, out);
  }
  return out;
}

function collectItems(json: unknown): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const section of findAll(json, 'itemSectionRenderer')) {
    const s = section as { contents?: unknown[] };
    for (const item of s.contents || []) {
      const parsed = parseSearchItem(item as Record<string, unknown>);
      if (!parsed) continue;
      if (Array.isArray(parsed)) items.push(...parsed);
      else items.push(parsed);
    }
  }
  return items;
}

async function search(query: string, page = 1): Promise<Record<string, unknown>> {
  await bootstrap(); // mweb() needs config even on page 1
  const payload = { context: { client: mweb() }, query };
  let json = await youtubei('search', payload);

  if (page > 1) {
    for (let i = 1; i < page; i++) {
      const token = findAll(json, 'continuationCommand').map((c) => (c as { token?: string }).token).pop();
      if (!token) break;
      json = await youtubei('search', { context: { client: mweb() }, continuation: token });
    }
  }

  const items = collectItems(json);
  return {
    query,
    page,
    results: items,
    estimatedResults: json.estimatedResults,
    hasMore: findAll(json, 'continuationCommand').length > 0,
  };
}

function parseSearchItem(item: Record<string, unknown>): Record<string, unknown> | Array<Record<string, unknown>> | null {
  if (item.videoWithContextRenderer) {
    const v = item.videoWithContextRenderer as Record<string, never>;
    return {
      type: 'video',
      id: v.videoId,
      title: text(v.headline && v.headline.runs),
      channel: text(v.shortBylineText && v.shortBylineText.runs),
      views: text(v.shortViewCountText && v.shortViewCountText.runs),
      thumbnail: thumbnail(v.thumbnail && v.thumbnail.thumbnails),
    };
  }
  if (item.compactRadioRenderer) {
    const v = item.compactRadioRenderer as Record<string, never>;
    return {
      type: 'mix',
      id: v.playlistId,
      title: text(v.title && v.title.runs),
      videoCount: text(v.videoCountText && v.videoCountText.runs),
      thumbnail: thumbnail(v.thumbnail && v.thumbnail.thumbnails),
    };
  }
  if (item.compactPlaylistRenderer) {
    const v = item.compactPlaylistRenderer as Record<string, never>;
    return {
      type: 'playlist',
      id: v.playlistId,
      title: text(v.title && v.title.runs),
      channel: text(v.shortBylineText && v.shortBylineText.runs),
      videoCount: text(v.videoCountText && v.videoCountText.runs),
      thumbnail: thumbnail(v.thumbnail && v.thumbnail.thumbnails),
    };
  }
  if (item.compactChannelRenderer) {
    const v = item.compactChannelRenderer as Record<string, never>;
    return {
      type: 'channel',
      id: v.channelId,
      title: text(v.title && v.title.runs),
      subscribers: text(v.subscriberCountText && v.subscriberCountText.runs),
      videoCount: text(v.videoCountText && v.videoCountText.runs),
      thumbnail: thumbnail(v.thumbnail && v.thumbnail.thumbnails),
    };
  }
  if (item.gridShelfViewModel) {
    return findAll(item.gridShelfViewModel, 'shortsLockupViewModel').map(parseShort);
  }
  return null;
}

function parseShort(s: Record<string, unknown>): Record<string, unknown> {
  const onTap = s.onTap as { innertubeCommand?: { reelWatchEndpoint?: { videoId?: string } } } | undefined;
  const reel = onTap?.innertubeCommand?.reelWatchEndpoint;
  return {
    type: 'short',
    id: reel?.videoId,
    title: typeof s.accessibilityText === 'string' ? s.accessibilityText.split(', ')[0] : null,
    thumbnail: thumbnail((s.thumbnail as { sources?: Array<{ url: string; width?: number }> })?.sources),
  };
}

function detectType(id: string): string {
  if (!id || typeof id !== 'string') return 'unknown';
  if (/^UC[\w-]{22}$/.test(id)) return 'channel';
  if (/^RDAM/.test(id)) return 'mix';
  if (/^(PL|UU|FL|OLAK5uy_)/.test(id)) return 'playlist';
  if (/^[\w-]{11}$/.test(id)) return 'video';
  return 'unknown';
}

async function info(id: string): Promise<unknown> {
  switch (detectType(id)) {
    case 'channel': return infoChannel(id);
    case 'playlist': return infoPlaylist(id);
    case 'mix': return infoMix(id);
    case 'video': return infoVideo(id);
    default: throw new Error(`Cannot determine content type for id: ${id}`);
  }
}

async function infoVideo(videoId: string): Promise<Record<string, unknown>> {
  const json = await youtubei('player', {
    context: { client: mweb() },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  });
  const vd = (json.videoDetails || {}) as Record<string, unknown>;
  const mf = ((json.microformat as Record<string, unknown>) || {}).playerMicroformatRenderer as Record<string, unknown> || {};
  const strs = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    type: 'video',
    id: vd.videoId,
    title: vd.title,
    description: vd.shortDescription,
    author: vd.author,
    channelId: vd.channelId,
    durationSeconds: Number(vd.lengthSeconds) || 0,
    viewCount: vd.viewCount,
    keywords: vd.keywords || [],
    isLive: vd.isLiveContent || false,
    isFamilySafe: mf.isFamilySafe,
    category: mf.category,
    publishDate: mf.publishDate,
    uploadDate: mf.uploadDate,
    thumbnail: thumbnail((vd.thumbnail as { thumbnails?: Array<{ url: string; width?: number }> })?.thumbnails),
    playability: (json.playabilityStatus as Record<string, unknown>)?.status,
  };
}

function parseLockup(v: Record<string, unknown>): Record<string, unknown> {
  const md = ((v.metadata as Record<string, unknown>)?.lockupMetadataViewModel as Record<string, unknown>) || {};
  const title = (md.title as Record<string, unknown>)?.content;
  const img = ((v.contentImage as Record<string, unknown>)?.thumbnailViewModel as Record<string, unknown>)?.image as Record<string, unknown> || {};
  const badges = ((img.overlays as Array<Record<string, unknown>>) || [])
    .map((o) => (o.thumbnailBottomOverlayViewModel as Record<string, unknown>)?.badges || [])
    .flat()
    .map((b) => (b.thumbnailBadgeViewModel as Record<string, unknown>)?.text)
    .find(Boolean);
  const parts = findAll(md, 'metadataParts').flat();
  const stats = parts.map((p) => p && (p as Record<string, unknown>).text && viewModelText((p as Record<string, unknown>).text)).filter(Boolean);
  return {
    type: 'video',
    id: v.contentId,
    title,
    channel: stats[0] || null,
    length: badges || null,
    views: stats[1] || null,
    published: stats[2] || null,
    thumbnail: thumbnail((img as { sources?: Array<{ url: string; width?: number }> }).sources),
  };
}

async function infoPlaylist(id: string): Promise<Record<string, unknown>> {
  const json = await youtubei('browse', {
    context: { client: mweb() },
    browseId: `VL${id}`,
  });
  const head = ((json.header as Record<string, unknown>)?.pageHeaderRenderer as Record<string, unknown>) || {};
  const phvm = ((head.content as Record<string, unknown>)?.pageHeaderViewModel as Record<string, unknown>) || head;
  const metaParts = findAll(phvm, 'metadataParts').flat();
  const partsText = metaParts.map((m) => m && (m as Record<string, unknown>).text && viewModelText((m as Record<string, unknown>).text)).filter(Boolean) as string[];
  const avatarStack = (findAll(phvm, 'avatarStackViewModel')[0] || {}) as Record<string, unknown>;
  const ownerEndpoint = (findAll(avatarStack, 'browseEndpoint')[0] || {}) as Record<string, unknown>;
  const ownerAvatar = (findAll(avatarStack, 'avatarViewModel')[0] || {}) as Record<string, unknown>;
  const videos = findAll(json, 'lockupViewModel').map(parseLockup);
  return {
    type: 'playlist',
    id,
    title: viewModelText(phvm.title) || head.pageTitle || null,
    description: viewModelText(phvm.description) || null,
    videoCount: partsText.find((s) => /\d+\s*videos?/.test(s)) || null,
    views: partsText.find((s) => /\d[\d,]*\s*views?/.test(s)) || null,
    channel: viewModelText(avatarStack.text) || partsText[0] || null,
    channelId: ownerEndpoint.browseId || null,
    avatar: thumbnail((ownerAvatar as { image?: { sources?: Array<{ url: string; width?: number }> } }).image?.sources),
    thumbnail: thumbnail((((findAll(phvm, 'thumbnailViewModel')[0] || {}) as Record<string, unknown>).image as Record<string, unknown>)?.sources ? (findAll(phvm, 'thumbnailViewModel')[0] as Record<string, unknown>).image && thumbnail(((findAll(phvm, 'thumbnailViewModel')[0] as Record<string, unknown>).image as { sources?: Array<{ url: string; width?: number }> }).sources) : null),
    videos,
  };
}

function parsePanelVideo(v: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'video',
    id: v.videoId,
    title: text(v.title as Array<{ text: string }>),
    channel: text(v.longBylineText as Array<{ text: string }>),
    length: text(v.lengthText as Array<{ text: string }>),
    selected: v.selected || false,
    thumbnail: thumbnail((v.thumbnail as { thumbnails?: Array<{ url: string; width?: number }> } | undefined)?.thumbnails),
  };
}

async function infoMix(id: string): Promise<Record<string, unknown>> {
  let seed: string | undefined;
  if (id.startsWith('RDAMPL')) {
    const pl = (await infoPlaylist(id.slice(6))) as { videos?: Array<{ id?: string }> };
    seed = pl.videos?.[0]?.id;
  } else {
    seed = id.slice(7);
  }
  if (!seed) throw new Error('Unable to resolve seed video for mix.');
  const json = await youtubei('next', {
    context: { client: mweb() },
    videoId: seed,
    playlistId: id,
  });
  const pl = ((json.contents as Record<string, unknown>)?.singleColumnWatchNextResults as Record<string, unknown>)?.playlist as Record<string, unknown> || {};
  const pls = pl.playlist as Record<string, unknown> || {};
  const videos = ((pls.contents as Array<Record<string, unknown>>) || [])
    .map((c) => c.playlistPanelVideoRenderer)
    .filter(Boolean)
    .map(parsePanelVideo);
  return { type: 'mix', id, title: pls.title || 'Mix', videos };
}

function viewModelText(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  const o = v as Record<string, unknown>;
  if (o.runs) return text(o.runs as Array<{ text: string }>);
  if (o.simpleText) return String(o.simpleText);
  if (o.content && typeof o.content === 'string') return o.content;
  const dtv = o.dynamicTextViewModel as Record<string, unknown>;
  if (dtv?.text) return viewModelText(dtv.text);
  return null;
}

async function infoChannel(id: string): Promise<Record<string, unknown>> {
  const json = await youtubei('browse', {
    context: { client: mweb() },
    browseId: id,
  });
  const meta = (findAll(json, 'channelMetadataRenderer')[0] || {}) as Record<string, unknown>;
  const header = (findAll(json, 'pageHeaderViewModel')[0] || findAll(json, 'pageHeaderRenderer')[0] || {}) as Record<string, unknown>;
  const title =
    viewModelText(header.title) ||
    text(header.pageTitle as Array<{ text: string }>) ||
    viewModelText(meta.title) ||
    null;
  const metaRows = findAll(header, 'metadataParts').flat();
  const rowTexts = metaRows.map((m) => m && (m as Record<string, unknown>).text && viewModelText((m as Record<string, unknown>).text)).filter(Boolean) as string[];
  const handle = rowTexts.find((s) => s && s.startsWith('@'));
  const img = ((header.image as Record<string, unknown>)?.thumbnailViewModel as Record<string, unknown>)?.image as Record<string, unknown> || {};
  return {
    type: 'channel',
    id,
    title,
    description: viewModelText(header.description) || meta.description || null,
    avatar: thumbnail((meta.avatar as { thumbnails?: Array<{ url: string; width?: number }> })?.thumbnails) || thumbnail((img as { sources?: Array<{ url: string; width?: number }> }).sources),
    handle,
    stats: rowTexts,
    url: meta.vanityChannelUrl || (meta.ownerUrls as string[])?.[0] || null,
    isFamilySafe: meta.isFamilySafe || null,
    keywords: (meta.keywords as string)?.split(/,\s*/) || null,
    country: meta.country || null,
  };
}

async function related(videoId: string): Promise<Record<string, unknown>> {
  const json = await youtubei('next', {
    context: { client: mweb() },
    videoId,
  });
  return { videoId, results: collectItems(json) };
}

async function download(videoId: string): Promise<Record<string, unknown>> {
  if (!ANDROID_VR_KEY) throw new Error('ANDROID_VR key not set — provide YT_ANDROID_VR_KEY env (legacy source had it redacted)');
  const payload = {
    context: {
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.58.24',
        androidSdkVersion: 30,
        hl: 'en',
        gl: config!.gl,
      },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const res = await fetch(`${API}/player?key=${ANDROID_VR_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, origin: BASE, 'x-goog-visitor-id': config!.visitorData },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json() as Record<string, unknown> & { error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || 'youtubei error');
  if (!json.streamingData) {
    const ps = (json.playabilityStatus || {}) as Record<string, unknown>;
    throw new Error(String(ps.reason || ps.status || 'Streaming unavailable.'));
  }

  const vd = (json.videoDetails || {}) as Record<string, unknown>;
  const sd = json.streamingData as Record<string, unknown>;
  const label = (f: Record<string, unknown>) => {
    const codec = String(f.mimeType || '').split(';')[0];
    const quality = f.width ? `${f.width}x${f.height}` : f.audioQuality || '';
    return `${codec}${quality ? ' ' + quality : ''}`;
  };
  const formats = [
    ...((sd.formats as Array<Record<string, unknown>>) || []),
    ...((sd.adaptiveFormats as Array<Record<string, unknown>>) || []),
  ]
    .filter((f) => f.url)
    .map((f) => ({
      itag: f.itag,
      container: String(f.mimeType || '').split('/')[0],
      codecs: f.mimeType || null,
      label: label(f),
      bitrate: f.bitrate || null,
      width: f.width || null,
      height: f.height || null,
      audioQuality: f.audioQuality || null,
      url: f.url,
    }));

  return {
    id: vd.videoId,
    title: vd.title,
    author: vd.author,
    durationSeconds: Number(vd.lengthSeconds) || 0,
    expiresInSeconds: sd.expiresInSeconds,
    formats,
  };
}

if (import.meta.main) {
  defineCli({
    name: 'yt',
    title: 'm.youtube.com Scraper (youtubei)',
    commands: {
      search: { desc: 'Search videos', usage: '<query> [page]', run: async (p) => { if (!p[0]) throw new Error('Query required'); return search(p.join(' '), 1); } },
      info: { desc: 'Details (video/playlist/channel/mix — auto-detected)', usage: '<id>', run: async (p) => { if (!p[0]) throw new Error('Id required'); await bootstrap(); return info(p[0]); } },
      related: { desc: 'Related videos', usage: '<videoId>', run: async (p) => { if (!p[0]) throw new Error('videoId required'); await bootstrap(); return related(p[0]); } },
      download: { desc: 'Stream formats (needs YT_ANDROID_VR_KEY)', usage: '<videoId>', run: async (p) => { if (!p[0]) throw new Error('videoId required'); await bootstrap(); return download(p[0]); } },
    },
    examples: `  bun yt.ts search "lofi hip hop"
  bun yt.ts info dQw4w9WgXcQ`,
  });
}

void isValidUrl;
void site;

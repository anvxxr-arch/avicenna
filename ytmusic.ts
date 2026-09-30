#!/usr/bin/env bun
/*
- base : https://music.youtube.com/
- creator : phrzy
- migrated to core/ guards (spec 003) — ESM, uniform CLI
- NOTE: API key not required (empty key works against youtubei for WEB_REMIX)
*/

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

const BASE = 'https://music.youtube.com';
const API = BASE + '/youtubei/v1';
const API_KEY = process.env.YTM_API_KEY || '';
const CLIENT_VERSION = '1.20260804.16.00';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const site = createSite({ base: BASE, rateMs: 400, headers: { 'user-agent': USER_AGENT } });
const { fetchPage } = site;

const FILTERS: Record<string, string> = {
  songs: 'EgWKAQIIAWoMEA4QChADEAQQCRAF',
  videos: 'EgWKAQIQAWoMEA4QChADEAQQCRAF',
  albums: 'EgWKAQIYAWoMEA4QChADEAQQCRAF',
  artists: 'EgWKAQIgAWoMEA4QChADEAQQCRAF',
  playlists: 'Eg-KAQwIABAAGAAgACgBMABqChAEEAMQCRAFEAo%3D',
};

const TYPE_BY_LABEL: Record<string, string> = {
  Song: 'song', Video: 'video', Album: 'album', EP: 'album', Single: 'album',
  Artist: 'artist', Playlist: 'playlist', Profile: 'profile', Podcast: 'podcast', Episode: 'episode',
};
const TYPE_BY_SHELF: Record<string, string> = {
  Songs: 'song', Videos: 'video', Albums: 'album', Artists: 'artist',
  'Community playlists': 'playlist', 'Featured playlists': 'playlist',
  Profiles: 'profile', Podcasts: 'podcast', Episodes: 'episode',
};

async function post(endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = {
    context: {
      client: { clientName: 'WEB_REMIX', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'US', userAgent: USER_AGENT },
    },
    ...body,
  };
  const res = await site.request(`${API}/${endpoint}?key=${API_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      'x-youtube-client-name': '67',
      'x-youtube-client-version': CLIENT_VERSION,
      'origin': BASE,
      'referer': BASE + '/',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<Record<string, unknown>>;
}

type Rec = Record<string, unknown>;
type Run = { text?: string };
type PathKey = string | number;
const get = <T>(o: unknown, k: string): T | undefined => ((o as Rec)?.[k] as T) ?? undefined;
/** Walks a key/index path down an unknown JSON node; missing links yield undefined. */
const at = (o: unknown, ...keys: PathKey[]): unknown =>
  keys.reduce<unknown>((acc, k) => get<unknown>(acc, String(k)), o);
/** Object at `keys`, or undefined when the value is missing or not an object. */
const asRec = (o: unknown, ...keys: PathKey[]): Rec | undefined => {
  const v = at(o, ...keys);
  return typeof v === 'object' && v !== null ? (v as Rec) : undefined;
};
/** Array at `keys`, or undefined when the value is missing or not an array. */
const asList = <T = Rec>(o: unknown, ...keys: PathKey[]): T[] | undefined => {
  const v = at(o, ...keys);
  return Array.isArray(v) ? (v as T[]) : undefined;
};
/** String at `keys`, or undefined when the value is missing or not a string. */
const asStr = (o: unknown, ...keys: PathKey[]): string | undefined => {
  const v = at(o, ...keys);
  return typeof v === 'string' ? v : undefined;
};
/** Runs of a text field (e.g. `text`, `title`); empty when absent. */
const asRuns = (o: unknown, ...keys: PathKey[]): Run[] => asList<Run>(o, ...keys, 'runs') || [];
const runsToText = (runs: Run[] | undefined | null): string =>
  (runs || []).map((r) => r.text || '').join('');

function getThumbnails(renderer: unknown): string[] {
  const r = renderer as Rec | undefined;
  const thumbs = (get<Rec>(r, 'musicThumbnailRenderer')?.thumbnail as { thumbnails?: Array<{ url: string }> })?.thumbnails
    || (get<Rec>(r, 'thumbnail') as { thumbnails?: Array<{ url: string }> })?.thumbnails
    || (get<Array<{ url: string }>>(r, 'thumbnails'))
    || [];
  return thumbs.map((t) => t.url);
}

function getVideoId(item: unknown): string | null {
  const it = item as Rec;
  const flex0 = asRec(asList(it, 'flexColumns')?.[0], 'musicResponsiveListItemFlexColumnRenderer');
  const watchId = asStr(asRuns(flex0, 'text')[0], 'navigationEndpoint', 'watchEndpoint', 'videoId');
  if (watchId) return watchId;
  for (const mi of asList(it, 'menu', 'items') || []) {
    const id = asStr(mi, 'menuServiceItemRenderer', 'serviceEndpoint', 'queueAddEndpoint', 'queueTarget', 'videoId');
    if (id) return id;
  }
  return asStr(it, 'navigationEndpoint', 'watchEndpoint', 'videoId') || null;
}

function getBrowseId(item: unknown): string | null {
  const it = item as Rec;
  const nav = asStr(it, 'navigationEndpoint', 'browseEndpoint', 'browseId');
  if (nav) return nav;
  for (const mi of asList(it, 'menu', 'items') || []) {
    const id = asStr(mi, 'menuServiceItemRenderer', 'serviceEndpoint', 'browseEndpoint', 'browseId');
    if (id) return id;
  }
  return null;
}

function getArtists(item: unknown): Array<{ name: string; id: string }> {
  const it = item as Rec;
  const runs = asRuns(asRec(asList(it, 'flexColumns')?.[1], 'musicResponsiveListItemFlexColumnRenderer'), 'text');
  return runs
    .filter((r) => (asStr(r, 'navigationEndpoint', 'browseEndpoint', 'browseId') || '').startsWith('UC'))
    .map((r) => ({ name: r.text as string, id: asStr(r, 'navigationEndpoint', 'browseEndpoint', 'browseId') as string }));
}

function getAlbum(item: unknown): { name: string; id: string } | null {
  const it = item as Rec;
  const runs = asRuns(asRec(asList(it, 'flexColumns')?.[1], 'musicResponsiveListItemFlexColumnRenderer'), 'text');
  const run = runs.find((r) => (asStr(r, 'navigationEndpoint', 'browseEndpoint', 'browseId') || '').startsWith('MPREb'));
  return run ? { name: run.text as string, id: asStr(run, 'navigationEndpoint', 'browseEndpoint', 'browseId') as string } : null;
}

function getPlays(flex: Array<Rec> | undefined): string | null {
  const t = runsToText(asRuns(asRec(flex?.[2], 'musicResponsiveListItemFlexColumnRenderer'), 'text'));
  return /plays|views/i.test(t) ? t : null;
}

function parseTrack(item: unknown): Record<string, unknown> | null {
  if (!item) return null;
  const it = item as Rec;
  const flex = asList(it, 'flexColumns') || [];
  return {
    title: runsToText(asRuns(asRec(flex[0], 'musicResponsiveListItemFlexColumnRenderer'), 'text')),
    artists: getArtists(it),
    album: getAlbum(it),
    duration: runsToText(asRuns(asRec(asList(it, 'fixedColumns')?.[0], 'musicResponsiveListItemFixedColumnRenderer'), 'text')),
    plays: getPlays(flex),
    videoId: getVideoId(it),
  };
}

function parseSearchItem(item: unknown, shelfType: string | null): Record<string, unknown> | null {
  if (!item) return null;
  const it = item as Rec;
  const flex = asList(it, 'flexColumns') || [];
  const title = runsToText(asRuns(asRec(flex[0], 'musicResponsiveListItemFlexColumnRenderer'), 'text'));
  const subtitle = runsToText(asRuns(asRec(flex[1], 'musicResponsiveListItemFlexColumnRenderer'), 'text'));
  const resultType = shelfType || TYPE_BY_LABEL[subtitle.split(' • ')[0]] || null;
  const duration =
    runsToText(asRuns(asRec(asList(it, 'fixedColumns')?.[0], 'musicResponsiveListItemFixedColumnRenderer'), 'text'))
    || (resultType === 'song' && /\d+:\d+$/.test(subtitle) ? subtitle.split(' • ').pop()! : null);

  const out: Rec = {
    resultType,
    title,
    subtitle,
    videoId: resultType === 'song' || resultType === 'video' ? getVideoId(it) : null,
    browseId: resultType === 'album' || resultType === 'artist' || resultType === 'playlist' ? getBrowseId(it) : null,
    artists: resultType === 'song' ? getArtists(it) : [],
    plays: getPlays(flex),
    duration,
    thumbnails: getThumbnails(get(it, 'thumbnail')),
  };
  return out;
}

function parseTopResult(card: unknown): Rec {
  const c = card as Rec;
  const subtitle = runsToText(asRuns(c, 'subtitle'));
  const parts = subtitle.split(' • ');
  const onTap = asRec(c, 'onTap') || asRec(asRuns(c, 'title')[0], 'navigationEndpoint') || {};
  return {
    category: 'Top result',
    resultType: TYPE_BY_LABEL[parts[0]] || null,
    title: runsToText(asRuns(c, 'title')),
    subtitle,
    videoId: asStr(onTap, 'watchEndpoint', 'videoId') || null,
    browseId: asStr(onTap, 'browseEndpoint', 'browseId') || null,
    thumbnails: getThumbnails(get(c, 'thumbnail')),
    songs: (asList(c, 'contents') || [])
      .map((x) => parseSearchItem(get(x, 'musicResponsiveListItemRenderer'), null))
      .filter(Boolean),
  };
}

async function search(query: string, filter?: string): Promise<Rec> {
  const body: Rec = { query };
  if (filter && FILTERS[filter]) body.params = FILTERS[filter];
  const json = await post('search', body);
  const tabs = asList(asRec(json, 'contents', 'tabbedSearchResultsRenderer'), 'tabs') || [];
  const tab0 = tabs[0] ? asRec(tabs[0], 'tabRenderer') : undefined;
  const content = tab0 ? asRec(tab0, 'content') : undefined;
  const sections = content ? asList(content, 'sectionListRenderer', 'contents') || [] : [];
  const results: Rec[] = [];

  for (const section of sections) {
    if (get(section, 'musicCardShelfRenderer')) {
      results.push(parseTopResult(get(section, 'musicCardShelfRenderer')));
      continue;
    }
    const shelf = asRec(section, 'musicShelfRenderer');
    const shelfType = shelf ? TYPE_BY_SHELF[runsToText(asRuns(shelf, 'title'))] || null : null;
    const items = asList(shelf, 'contents') || asList(section, 'itemSectionRenderer', 'contents') || [];
    for (const item of items) {
      const parsed = parseSearchItem(get(item, 'musicResponsiveListItemRenderer'), shelfType);
      if (!parsed) continue;
      results.push(parsed);
    }
  }
  return { query, filter: filter && FILTERS[filter] ? filter : 'all', count: results.length, results };
}

async function info(browseId: string): Promise<Rec> {
  const json = await post('browse', { browseId });
  if (browseId.startsWith('MPREb')) return parseAlbum(json);
  if (browseId.startsWith('UC')) return parseArtist(json, browseId);
  if (browseId.startsWith('VL') || browseId.startsWith('PL')) return parsePlaylist(json);
  throw new Error(`Unsupported browseId: ${browseId}`);
}

function getHeader(json: unknown): Rec | null {
  const two = asRec(json, 'contents', 'twoColumnBrowseResultsRenderer');
  const sections = asList(asRec(asList(two, 'tabs')?.[0], 'tabRenderer', 'content'), 'sectionListRenderer', 'contents') || [];
  return (
    asRec(sections.find((s) => get(s, 'musicResponsiveHeaderRenderer')), 'musicResponsiveHeaderRenderer')
    || asRec(sections.find((s) => get(s, 'musicDetailHeaderRenderer')), 'musicDetailHeaderRenderer')
    || asRec(sections.find((s) => get(s, 'musicEditablePlaylistDetailHeaderRenderer')), 'musicEditablePlaylistDetailHeaderRenderer')
    || null
  );
}

function getSecondarySections(json: unknown): Array<Rec> {
  const two = asRec(json, 'contents', 'twoColumnBrowseResultsRenderer');
  return asList(two, 'secondaryContents', 'sectionListRenderer', 'contents') || [];
}

function getShelfItems(sections: Array<Rec>): Array<Rec> {
  return sections.flatMap((s) => asList<Rec>(s, 'musicShelfRenderer', 'contents') || asList<Rec>(s, 'musicPlaylistShelfRenderer', 'contents') || []);
}

function parseAlbum(json: unknown): Rec {
  const header = getHeader(json);
  const subtitle = runsToText(asRuns(header, 'subtitle')).split(' • ');
  const tracks = getShelfItems(getSecondarySections(json))
    .map((c) => parseTrack(get(c, 'musicResponsiveListItemRenderer')))
    .filter(Boolean);
  return {
    type: 'album',
    title: runsToText(asRuns(header, 'title')),
    artist: runsToText(asRuns(header, 'straplineTextOne')),
    year: subtitle[1] || null,
    description: runsToText(asRuns(header, 'description')),
    thumbnails: getThumbnails(get(header, 'thumbnail')),
    trackCount: tracks.length,
    tracks,
  };
}

function parsePlaylist(json: unknown): Rec {
  const header = getHeader(json);
  const tracks = getShelfItems(getSecondarySections(json))
    .map((c) => parseTrack(get(c, 'musicResponsiveListItemRenderer')))
    .filter(Boolean);
  return {
    type: 'playlist',
    title: runsToText(asRuns(header, 'title')),
    description: runsToText(asRuns(header, 'description')),
    stats: runsToText(asRuns(header, 'secondSubtitle')),
    thumbnails: getThumbnails(get(header, 'thumbnail')),
    trackCount: tracks.length,
    tracks,
  };
}

function parseCarousel(carousel: unknown): Rec {
  const c = carousel as Rec;
  const title = runsToText(asRuns(asRec(c, 'header', 'musicCarouselShelfBasicHeaderRenderer'), 'title'));
  const items = (asList(c, 'contents') || [])
    .map((x) => {
      const item = asRec(x, 'musicTwoRowItemRenderer') || asRec(x, 'musicMultiRowListItemRenderer');
      if (!item) return null;
      return {
        title: runsToText(asRuns(item, 'title')),
        subtitle: runsToText(asRuns(item, 'subtitle')),
        browseId: asStr(item, 'navigationEndpoint', 'browseEndpoint', 'browseId') || null,
        videoId: asStr(item, 'navigationEndpoint', 'watchEndpoint', 'videoId') || null,
        thumbnails: getThumbnails(get(item, 'thumbnailRenderer')),
      };
    })
    .filter(Boolean);
  return { title, items };
}

function parseArtist(json: unknown, browseId: string): Rec {
  const slr = asRec(json, 'contents', 'singleColumnBrowseResultsRenderer', 'tabs');
  const sections = asList(asRec(asList(slr)?.[0], 'tabRenderer', 'content'), 'sectionListRenderer', 'contents') || [];

  const topSongsShelf = asRec(sections.find((s) => get(s, 'musicShelfRenderer')), 'musicShelfRenderer');
  const songs = (asList(topSongsShelf, 'contents') || [])
    .map((c) => parseTrack(get(c, 'musicResponsiveListItemRenderer')))
    .filter(Boolean);

  const descriptionShelf = asRec(sections.find((s) => get(s, 'musicDescriptionShelfRenderer')), 'musicDescriptionShelfRenderer');
  const matchedArtist = songs
    .map((s) => (s?.artists || []) as Array<{ id: string; name: string }>)
    .find((artists) => artists.some((a) => a.id === browseId))
    ?.find((a) => a.id === browseId);
  const name = matchedArtist?.name || runsToText(asRuns(descriptionShelf, 'header')) || null;

  return {
    type: 'artist',
    name,
    description: runsToText(asRuns(descriptionShelf, 'description')),
    views: runsToText(asRuns(descriptionShelf, 'subheader')) || null,
    songs,
    sections: sections
      .filter((s) => get(s, 'musicCarouselShelfRenderer'))
      .map((s) => parseCarousel(get(s, 'musicCarouselShelfRenderer'))),
  };
}

async function lyrics(videoId: string, depth = 0): Promise<Rec> {
  const json = await post('next', { videoId, isAudioOnly: true });
  const watch = asRec(json, 'contents', 'singleColumnMusicWatchNextResultsRenderer', 'tabbedRenderer');
  const tabs = asList(watch, 'watchNextTabbedResultsRenderer', 'tabs') || [];
  const lyricsTab = tabs.find((t) => {
    const ep = asRec(t, 'tabRenderer', 'endpoint');
    const cfg = asRec(ep, 'browseEndpoint', 'browseEndpointContextSupportedConfigs');
    return asStr(cfg, 'browseEndpointContextMusicConfig', 'pageType') === 'MUSIC_PAGE_TYPE_TRACK_LYRICS';
  });
  const lyricsBrowseId = asStr(lyricsTab, 'tabRenderer', 'endpoint', 'browseEndpoint', 'browseId');

  if (!lyricsBrowseId) {
    return depth > 0 ? { videoId, lyrics: null, source: null } : lyricsFallback(videoId);
  }

  const lyricsJson = await post('browse', { browseId: lyricsBrowseId });
  const contents = asList(lyricsJson, 'contents', 'sectionListRenderer', 'contents') || [];
  const shelf = asRec(contents.find((s) => get(s, 'musicDescriptionShelfRenderer')), 'musicDescriptionShelfRenderer');

  const text = runsToText(asRuns(shelf, 'description'));
  if (text) {
    return { videoId, lyrics: text, source: runsToText(asRuns(shelf, 'footer')) || null };
  }
  return depth > 0 ? { videoId, lyrics: null, source: null } : lyricsFallback(videoId);
}

async function findSongVideoId(videoId: string): Promise<string | null> {
  const json = await post('next', { videoId, isAudioOnly: true });
  const watch = asRec(json, 'contents', 'singleColumnMusicWatchNextResultsRenderer', 'tabbedRenderer');
  const tabs = asList(watch, 'watchNextTabbedResultsRenderer', 'tabs') || [];
  const tab0 = tabs[0] ? asRec(tabs[0], 'tabRenderer') : undefined;
  const queue = asRec(tab0, 'content', 'musicQueueRenderer', 'content', 'playlistPanelRenderer');
  const contents = asList(queue, 'contents') || [];
  const track =
    asRec(contents.find((c) => get(asRec(c, 'playlistPanelVideoRenderer'), 'selected')), 'playlistPanelVideoRenderer')
    || asRec(contents[0], 'playlistPanelVideoRenderer');
  const title = runsToText(asRuns(track, 'title')).replace(/\s*\([^)]*\)\s*$/g, '');
  const artistName = runsToText(asRuns(track, 'shortBylineText'));
  const query = `${title} ${artistName}`.trim();
  if (!query) return null;

  const res = await search(query, 'songs');
  const results = (res.results as Array<Rec>) || [];
  const song = results.find((r) => r.resultType === 'song' && r.videoId && r.videoId !== videoId);
  return (song?.videoId as string) || null;
}

async function lyricsFallback(videoId: string): Promise<Rec> {
  const songVideoId = await findSongVideoId(videoId);
  if (!songVideoId) return { videoId, lyrics: null, source: null };
  const resolved = await lyrics(songVideoId, 1);
  if (resolved.lyrics) return { videoId, lyrics: resolved.lyrics, source: resolved.source };
  return { videoId, lyrics: null, source: null };
}

async function related(videoId: string): Promise<Rec> {
  const json = await post('next', { playlistId: 'RDAMVM' + videoId, isAudioOnly: true });
  const watch = asRec(json, 'contents', 'singleColumnMusicWatchNextResultsRenderer', 'tabbedRenderer');
  const tabs = asList(watch, 'watchNextTabbedResultsRenderer', 'tabs') || [];
  const queueTab = tabs.find((t) => asStr(t, 'tabRenderer', 'title') === 'Up next');
  const queue = asRec(queueTab, 'tabRenderer', 'content', 'musicQueueRenderer', 'content', 'playlistPanelRenderer');

  const tracks = (asList(queue, 'contents') || [])
    .map((c) => {
      const v = asRec(c, 'playlistPanelVideoRenderer');
      if (!v) return null;
      return {
        title: runsToText(asRuns(v, 'title')),
        artists: asRuns(v, 'longBylineText')
          .filter((r) => (asStr(r, 'navigationEndpoint', 'browseEndpoint', 'browseId') || '').startsWith('UC'))
          .map((r) => ({ name: r.text as string, id: asStr(r, 'navigationEndpoint', 'browseEndpoint', 'browseId') as string })),
        duration: runsToText(asRuns(v, 'lengthText')),
        videoId: v.videoId,
        selected: v.selected || false,
        thumbnails: getThumbnails(get(v, 'thumbnail')),
      };
    })
    .filter(Boolean);

  return { videoId, count: tracks.length, tracks };
}

let cachedSignatureTimestamp: number | undefined;
async function getSignatureTimestamp(): Promise<number> {
  if (cachedSignatureTimestamp) return cachedSignatureTimestamp;
  const html = await fetchPage(BASE + '/');
  const playerJs = html.match(/\/s\/player\/[^"']*base\.js/)?.[0];
  if (!playerJs) throw new Error('Unable to locate player script');
  const res = await site.request(BASE + playerJs, { headers: { 'user-agent': USER_AGENT } });
  const js = await res.text();
  cachedSignatureTimestamp = Number(js.match(/signatureTimestamp:(\d+)/)?.[1] || 0);
  return cachedSignatureTimestamp;
}

async function download(videoId: string, depth = 0): Promise<Rec> {
  const signatureTimestamp = await getSignatureTimestamp();
  const json = await post('player', {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: { contentPlaybackContext: { signatureTimestamp } },
  });

  const status = asStr(json, 'playabilityStatus', 'status');
  if (status !== 'OK') {
    if (depth === 0) {
      const songVideoId = await findSongVideoId(videoId);
      if (songVideoId) {
        const resolved = await download(songVideoId, 1);
        if (resolved.status === 'OK') return { ...resolved, videoId };
      }
    }
    const ps = asRec(json, 'playabilityStatus') || {};
    return {
      videoId,
      status,
      reason: ps.reason || runsToText(asRuns(asRec(ps, 'errorScreen', 'playerErrorMessageRenderer'), 'reason')) || null,
    };
  }

  const sd = asRec(json, 'streamingData') || {};
  const formats = [
    ...asList(sd, 'formats') || [],
    ...asList(sd, 'adaptiveFormats') || [],
  ];
  const parseCipher = (cipher: unknown) => {
    if (!cipher) return null;
    const qs = new URLSearchParams(String(cipher));
    return { url: qs.get('url'), sp: qs.get('sp'), s: qs.get('s') };
  };
  const parseFormat = (f: Rec) => ({
    itag: f.itag,
    mimeType: typeof f.mimeType === 'string' ? f.mimeType.split(';')[0] : null,
    bitrate: f.bitrate || f.averageBitrate || null,
    quality: f.quality || null,
    audioQuality: f.audioQuality || null,
    contentLength: f.contentLength ? Number(f.contentLength) : null,
    url: f.url || null,
    cipher: parseCipher(f.signatureCipher || f.cipher),
  });

  const vd = get<Rec>(json, 'videoDetails') || {};
  return {
    videoId,
    title: vd.title,
    artist: vd.author || null,
    lengthSeconds: Number(vd.lengthSeconds || 0),
    thumbnail: asList<{ url: string }>(vd, 'thumbnail', 'thumbnails')?.slice(-1)?.[0]?.url || null,
    expiresInSeconds: sd.expiresInSeconds || null,
    audioFormats: (formats as Array<Rec>).filter((f) => String(f.mimeType).startsWith('audio')).map(parseFormat),
    videoFormats: (formats as Array<Rec>).filter((f) => String(f.mimeType).startsWith('video')).map(parseFormat),
  };
}

if (import.meta.main) {
  defineCli({
    name: 'ytmusic',
    title: 'YouTube Music Scraper',
    commands: {
      search: {
        desc: `Search (filters: ${Object.keys(FILTERS).join('|')})`, usage: '<query> [filter]',
        run: (p) => {
          if (!p[0]) throw new Error('Query required');
          const last = p[p.length - 1];
          const filter = FILTERS[last] ? last : undefined;
          if (filter) p.pop();
          return search(p.join(' '), filter);
        },
      },
      info: { desc: 'Album/artist/playlist detail', usage: '<browseId>', run: async (p) => { if (!p[0]) throw new Error('browseId required'); return info(p[0]); } },
      lyrics: { desc: 'Lyrics (synced, with fallback)', usage: '<videoId>', run: async (p) => { if (!p[0]) throw new Error('videoId required'); return lyrics(p[0]); } },
      related: { desc: 'Up-next tracks', usage: '<videoId>', run: async (p) => { if (!p[0]) throw new Error('videoId required'); return related(p[0]); } },
      download: { desc: 'Audio stream formats', usage: '<videoId>', run: async (p) => { if (!p[0]) throw new Error('videoId required'); return download(p[0]); } },
    },
    examples: `  bun ytmusic.ts search "avenged sevenfold" songs
  bun ytmusic.ts lyrics onCZOgWlr1U`,
  });
}

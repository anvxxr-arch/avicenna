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
  const res = await fetch(`${API}/${endpoint}?key=${API_KEY}&prettyPrint=false`, {
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
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<Record<string, unknown>>;
}

const runsToText = (runs: Array<{ text?: string }> | undefined | null): string =>
  (runs || []).map((r) => r.text || '').join('');

type Rec = Record<string, unknown>;
const get = <T>(o: unknown, k: string): T | undefined => ((o as Rec)?.[k] as T) ?? undefined;

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
  const flex0 = get<Rec>(get<Array<Rec>>(it, 'flexColumns')?.[0], 'musicResponsiveListItemFlexColumnRenderer');
  const runs = get<Array<Rec>>(get<Rec>(flex0, 'text'), 'runs') || [];
  const watchId = get<Rec>(get<Rec>(runs[0], 'navigationEndpoint'), 'watchEndpoint')?.videoId;
  if (watchId) return watchId as string;
  const items = get<Array<Rec>>(get<Rec>(it, 'menu'), 'items') || [];
  for (const mi of items) {
    const id = get<string>(get<Rec>(get<Rec>(get<Rec>(mi, 'menuServiceItemRenderer'), 'serviceEndpoint'), 'queueAddEndpoint'), 'queueTarget')?.videoId;
    if (id) return id;
  }
  return (get<Rec>(it, 'navigationEndpoint')?.watchEndpoint as Rec)?.videoId as string || null;
}

function getBrowseId(item: unknown): string | null {
  const it = item as Rec;
  const nav = get<Rec>(get<Rec>(it, 'navigationEndpoint'), 'browseEndpoint')?.browseId;
  if (nav) return nav as string;
  const items = get<Array<Rec>>(get<Rec>(it, 'menu'), 'items') || [];
  for (const mi of items) {
    const id = get<string>(get<Rec>(get<Rec>(get<Rec>(mi, 'menuServiceItemRenderer'), 'serviceEndpoint'), 'browseEndpoint'), 'browseId');
    if (id) return id;
  }
  return null;
}

function getArtists(item: unknown): Array<{ name: string; id: string }> {
  const it = item as Rec;
  const runs = get<Array<Rec>>(get<Rec>(get<Array<Rec>>(it, 'flexColumns')?.[1], 'musicResponsiveListItemFlexColumnRenderer'), 'text')?.runs || [];
  return (runs as Array<Rec>)
    .filter((r) => String(get<Rec>(get<Rec>(r, 'navigationEndpoint'), 'browseEndpoint')?.browseId).startsWith('UC'))
    .map((r) => ({ name: r.text as string, id: (get<Rec>(get<Rec>(r, 'navigationEndpoint'), 'browseEndpoint')?.browseId) as string }));
}

function getAlbum(item: unknown): { name: string; id: string } | null {
  const it = item as Rec;
  const runs = get<Array<Rec>>(get<Rec>(get<Array<Rec>>(it, 'flexColumns')?.[1], 'musicResponsiveListItemFlexColumnRenderer'), 'text')?.runs || [];
  const run = (runs as Array<Rec>).find((r) => String(get<Rec>(get<Rec>(r, 'navigationEndpoint'), 'browseEndpoint')?.browseId).startsWith('MPREb'));
  return run ? { name: run.text as string, id: get<Rec>(get<Rec>(run, 'navigationEndpoint'), 'browseEndpoint')?.browseId as string } : null;
}

function getPlays(flex: Array<Rec> | undefined): string | null {
  const t = runsToText(get<Rec>(flex?.[2], 'musicResponsiveListItemFlexColumnRenderer')?.text?.runs);
  return /plays|views/i.test(t) ? t : null;
}

function parseTrack(item: unknown): Record<string, unknown> | null {
  if (!item) return null;
  const it = item as Rec;
  const flex = get<Array<Rec>>(it, 'flexColumns') || [];
  return {
    title: runsToText(get<Rec>(flex[0], 'musicResponsiveListItemFlexColumnRenderer')?.text?.runs),
    artists: getArtists(it),
    album: getAlbum(it),
    duration: runsToText(get<Rec>(get<Array<Rec>>(it, 'fixedColumns')?.[0], 'musicResponsiveListItemFixedColumnRenderer')?.text?.runs),
    plays: getPlays(flex),
    videoId: getVideoId(it),
  };
}

function parseSearchItem(item: unknown, shelfType: string | null): Record<string, unknown> | null {
  if (!item) return null;
  const it = item as Rec;
  const flex = get<Array<Rec>>(it, 'flexColumns') || [];
  const title = runsToText(get<Rec>(flex[0], 'musicResponsiveListItemFlexColumnRenderer')?.text?.runs);
  const subtitle = runsToText(get<Rec>(flex[1], 'musicResponsiveListItemFlexColumnRenderer')?.text?.runs);
  const resultType = shelfType || TYPE_BY_LABEL[subtitle.split(' • ')[0]] || null;
  const duration =
    runsToText(get<Rec>(get<Array<Rec>>(it, 'fixedColumns')?.[0], 'musicResponsiveListItemFixedColumnRenderer')?.text?.runs)
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
  const subtitle = runsToText(get<Rec>(c, 'subtitle')?.runs);
  const parts = subtitle.split(' • ');
  const onTap = get<Rec>(c, 'onTap') || get<Rec>(get<Rec>(get<Rec>(c, 'title'), 'runs')?.[0], 'navigationEndpoint') || {};
  return {
    category: 'Top result',
    resultType: TYPE_BY_LABEL[parts[0]] || null,
    title: runsToText(get<Rec>(c, 'title')?.runs),
    subtitle,
    videoId: (get<Rec>(onTap, 'watchEndpoint')?.videoId as string) || null,
    browseId: (get<Rec>(onTap, 'browseEndpoint')?.browseId as string) || null,
    thumbnails: getThumbnails(get(c, 'thumbnail')),
    songs: (get<Array<Rec>>(c, 'contents') || [])
      .map((x) => parseSearchItem(get(x, 'musicResponsiveListItemRenderer'), null))
      .filter(Boolean),
  };
}

async function search(query: string, filter?: string): Promise<Rec> {
  const body: Rec = { query };
  if (filter && FILTERS[filter]) body.params = FILTERS[filter];
  const json = await post('search', body);
  const tabs = get<Array<Rec>>(get<Rec>(json, 'contents'), 'tabbedSearchResultsRenderer')?.tabs || [];
  const tab0 = tabs[0] ? get<Rec>(tabs[0], 'tabRenderer') : undefined;
  const content = tab0 ? get<Rec>(tab0, 'content') : undefined;
  const sections = content ? get<Array<Rec>>(content, 'sectionListRenderer')?.contents || [] : [];
  const results: Rec[] = [];

  for (const section of sections) {
    if (get(section, 'musicCardShelfRenderer')) {
      results.push(parseTopResult(get(section, 'musicCardShelfRenderer')));
      continue;
    }
    const shelf = get<Rec>(section, 'musicShelfRenderer');
    const shelfType = shelf ? TYPE_BY_SHELF[runsToText(get<Rec>(shelf, 'title')?.runs)] || null : null;
    const items = get<Array<Rec>>(shelf, 'contents') || get<Array<Rec>>(get<Rec>(section, 'itemSectionRenderer'), 'contents') || [];
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
  const two = get<Rec>(get<Rec>(json, 'contents'), 'twoColumnBrowseResultsRenderer');
  const sections = get<Array<Rec>>(get<Rec>(get<Array<Rec>>(get<Rec>(two, 'tabs')?.[0], 'tabRenderer'), 'content'), 'sectionListRenderer')?.contents || [];
  return (
    sections.find((s) => get(s, 'musicResponsiveHeaderRenderer'))?.musicResponsiveHeaderRenderer
    || sections.find((s) => get(s, 'musicDetailHeaderRenderer'))?.musicDetailHeaderRenderer
    || sections.find((s) => get(s, 'musicEditablePlaylistDetailHeaderRenderer'))?.musicEditablePlaylistDetailHeaderRenderer
    || null
  );
}

function getSecondarySections(json: unknown): Array<Rec> {
  const two = get<Rec>(get<Rec>(json, 'contents'), 'twoColumnBrowseResultsRenderer');
  return get<Rec>(get<Rec>(two, 'secondaryContents'), 'sectionListRenderer')?.contents || [];
}

function getShelfItems(sections: Array<Rec>): Array<Rec> {
  return sections.flatMap((s) => get<Array<Rec>>(get(s, 'musicShelfRenderer'), 'contents') || get<Array<Rec>>(get(s, 'musicPlaylistShelfRenderer'), 'contents') || []);
}

function parseAlbum(json: unknown): Rec {
  const header = getHeader(json);
  const subtitle = runsToText(get<Rec>(header, 'subtitle')?.runs).split(' • ');
  const tracks = getShelfItems(getSecondarySections(json))
    .map((c) => parseTrack(get(c, 'musicResponsiveListItemRenderer')))
    .filter(Boolean);
  return {
    type: 'album',
    title: runsToText(get<Rec>(header, 'title')?.runs),
    artist: runsToText(get<Rec>(header, 'straplineTextOne')?.runs),
    year: subtitle[1] || null,
    description: runsToText(get<Rec>(header, 'description')?.runs),
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
    title: runsToText(get<Rec>(header, 'title')?.runs),
    description: runsToText(get<Rec>(header, 'description')?.runs),
    stats: runsToText(get<Rec>(header, 'secondSubtitle')?.runs),
    thumbnails: getThumbnails(get(header, 'thumbnail')),
    trackCount: tracks.length,
    tracks,
  };
}

function parseCarousel(carousel: unknown): Rec {
  const c = carousel as Rec;
  const title = runsToText(get<Rec>(get<Rec>(c, 'header'), 'musicCarouselShelfBasicHeaderRenderer')?.title?.runs);
  const items = (get<Array<Rec>>(c, 'contents') || [])
    .map((x) => {
      const item = (get(x, 'musicTwoRowItemRenderer') || get(x, 'musicMultiRowListItemRenderer')) as Rec | undefined;
      if (!item) return null;
      return {
        title: runsToText(get<Rec>(item, 'title')?.runs),
        subtitle: runsToText(get<Rec>(item, 'subtitle')?.runs),
        browseId: (get<Rec>(get<Rec>(item, 'navigationEndpoint'), 'browseEndpoint')?.browseId as string) || null,
        videoId: (get<Rec>(get<Rec>(item, 'navigationEndpoint'), 'watchEndpoint')?.videoId as string) || null,
        thumbnails: getThumbnails(get(item, 'thumbnailRenderer')),
      };
    })
    .filter(Boolean);
  return { title, items };
}

function parseArtist(json: unknown, browseId: string): Rec {
  const slr = get<Rec>(get<Rec>(get<Array<Rec>>(get<Rec>(get<Rec>(json, 'contents'), 'singleColumnBrowseResultsRenderer'), 'tabs')?.[0], 'tabRenderer'), 'content')?.sectionListRenderer;
  const sections = slr?.contents || [];

  const topSongsShelf = sections.find((s) => get(s, 'musicShelfRenderer'))?.musicShelfRenderer;
  const songs = (get<Array<Rec>>(topSongsShelf, 'contents') || [])
    .map((c) => parseTrack(get(c, 'musicResponsiveListItemRenderer')))
    .filter(Boolean);

  const descriptionShelf = sections.find((s) => get(s, 'musicDescriptionShelfRenderer'))?.musicDescriptionShelfRenderer;
  const name =
    songs.find((s) => (s.artists as Array<{ id: string }>)?.some((a) => a.id === browseId))?.artists?.find((a) => a.id === browseId)?.name
    || runsToText(get<Rec>(descriptionShelf, 'header')?.runs)
    || null;

  return {
    type: 'artist',
    name,
    description: runsToText(get<Rec>(descriptionShelf, 'description')?.runs),
    views: runsToText(get<Rec>(descriptionShelf, 'subheader')?.runs) || null,
    songs,
    sections: sections
      .filter((s) => get(s, 'musicCarouselShelfRenderer'))
      .map((s) => parseCarousel(get(s, 'musicCarouselShelfRenderer'))),
  };
}

async function lyrics(videoId: string, depth = 0): Promise<Rec> {
  const json = await post('next', { videoId, isAudioOnly: true });
  const watch = get<Rec>(get<Rec>(json, 'contents'), 'singleColumnMusicWatchNextResultsRenderer')?.tabbedRenderer as Rec | undefined;
  const tabs = get<Array<Rec>>(watch?.watchNextTabbedResultsRenderer, 'tabs') || [];
  const lyricsTab = tabs.find((t) => {
    const ep = get<Rec>(get<Rec>(t, 'tabRenderer'), 'endpoint');
    const cfg = get<Rec>(get<Rec>(ep, 'browseEndpoint'), 'browseEndpointContextSupportedConfigs');
    return get<string>(get<Rec>(cfg, 'browseEndpointContextMusicConfig'), 'pageType') === 'MUSIC_PAGE_TYPE_TRACK_LYRICS';
  });
  const lyricsBrowseId = get<string>(get<Rec>(get<Rec>(lyricsTab, 'tabRenderer'), 'endpoint'), 'browseEndpoint')?.browseId;

  if (!lyricsBrowseId) {
    return depth > 0 ? { videoId, lyrics: null, source: null } : lyricsFallback(videoId);
  }

  const lyricsJson = await post('browse', { browseId: lyricsBrowseId });
  const contents = get<Array<Rec>>(get<Rec>(lyricsJson, 'contents'), 'sectionListRenderer')?.contents || [];
  const shelf = contents.find((s) => get(s, 'musicDescriptionShelfRenderer'))?.musicDescriptionShelfRenderer;

  const text = runsToText(get<Rec>(shelf, 'description')?.runs);
  if (text) {
    return { videoId, lyrics: text, source: runsToText(get<Rec>(shelf, 'footer')?.runs) || null };
  }
  return depth > 0 ? { videoId, lyrics: null, source: null } : lyricsFallback(videoId);
}

async function findSongVideoId(videoId: string): Promise<string | null> {
  const json = await post('next', { videoId, isAudioOnly: true });
  const watch = get<Rec>(get<Rec>(json, 'contents'), 'singleColumnMusicWatchNextResultsRenderer')?.tabbedRenderer as Rec | undefined;
  const tabs = get<Array<Rec>>(watch?.watchNextTabbedResultsRenderer, 'tabs') || [];
  const tab0 = tabs[0] ? get<Rec>(tabs[0], 'tabRenderer') : undefined;
  const queue = get<Rec>(get<Rec>(tab0?.content, 'musicQueueRenderer'), 'content')?.playlistPanelRenderer;
  const contents = get<Array<Rec>>(queue, 'contents') || [];
  const track =
    (contents.find((c) => get(get<Rec>(c, 'playlistPanelVideoRenderer'), 'selected'))?.playlistPanelVideoRenderer)
    || get<Rec>(contents[0], 'playlistPanelVideoRenderer');
  const title = runsToText(get<Rec>(track, 'title')?.runs).replace(/\s*\([^)]*\)\s*$/g, '');
  const artistName = runsToText(get<Rec>(track, 'shortBylineText')?.runs);
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
  const watch = get<Rec>(get<Rec>(json, 'contents'), 'singleColumnMusicWatchNextResultsRenderer')?.tabbedRenderer as Rec | undefined;
  const tabs = get<Array<Rec>>(watch?.watchNextTabbedResultsRenderer, 'tabs') || [];
  const queue =
    tabs.find((t) => get<Rec>(t, 'tabRenderer')?.title === 'Up next')?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer;

  const tracks = (get<Array<Rec>>(queue, 'contents') || [])
    .map((c) => {
      const v = get<Rec>(c, 'playlistPanelVideoRenderer');
      if (!v) return null;
      return {
        title: runsToText(get<Rec>(v, 'title')?.runs),
        artists: (get<Array<Rec>>(v, 'longBylineText')?.runs || [])
          .filter((r) => String(get<Rec>(get<Rec>(r, 'navigationEndpoint'), 'browseEndpoint')?.browseId).startsWith('UC'))
          .map((r) => ({ name: r.text as string, id: get<Rec>(get<Rec>(r, 'navigationEndpoint'), 'browseEndpoint')?.browseId as string })),
        duration: runsToText(get<Rec>(v, 'lengthText')?.runs),
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
  const res = await fetch(BASE + playerJs, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
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

  const status = get<Rec>(json, 'playabilityStatus')?.status;
  if (status !== 'OK') {
    if (depth === 0) {
      const songVideoId = await findSongVideoId(videoId);
      if (songVideoId) {
        const resolved = await download(songVideoId, 1);
        if (resolved.status === 'OK') return { ...resolved, videoId };
      }
    }
    const ps = get<Rec>(json, 'playabilityStatus') || {};
    return {
      videoId,
      status,
      reason: ps.reason || runsToText(get<Rec>(get<Rec>(ps, 'errorScreen'), 'playerErrorMessageRenderer')?.reason?.runs) || null,
    };
  }

  const sd = get<Rec>(json, 'streamingData') || {};
  const formats = [
    ...((sd.formats as Array<Rec>) || []),
    ...((sd.adaptiveFormats as Array<Rec>) || []),
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
    thumbnail: (get<Rec>(get<Rec>(vd, 'thumbnail'), 'thumbnails') as Array<{ url: string }>)?.slice(-1)?.[0]?.url || null,
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
      search: { desc: `Search (filters: ${Object.keys(FILTERS).join('|')})`, usage: '<query> [filter]', run: async (p) => { if (!p[0]) throw new Error('Query required'); return search(p.join(' '), p[p.length - 1] && FILTERS[p[p.length - 1]] ? p.pop()! : undefined); } },
      info: { desc: 'Album/artist/playlist detail', usage: '<browseId>', run: async (p) => { if (!p[0]) throw new Error('browseId required'); return info(p[0]); } },
      lyrics: { desc: 'Lyrics (synced, with fallback)', usage: '<videoId>', run: async (p) => { if (!p[0]) throw new Error('videoId required'); return lyrics(p[0]); } },
      related: { desc: 'Up-next tracks', usage: '<videoId>', run: async (p) => { if (!p[0]) throw new Error('videoId required'); return related(p[0]); } },
      download: { desc: 'Audio stream formats', usage: '<videoId>', run: async (p) => { if (!p[0]) throw new Error('videoId required'); return download(p[0]); } },
    },
    examples: `  bun ytmusic.ts search "avenged sevenfold" songs
  bun ytmusic.ts lyrics onCZOgWlr1U`,
  });
}

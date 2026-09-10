#!/usr/bin/env bun
/*
- base : https://open.spotify.com
- creator : phrzy
- migrated to core/ (spec 003) — ESM, hardened transport, uniform CLI
- embed/token + graph persisted queries preserved verbatim
*/

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };
declare const Buffer: { from(data: string, enc?: string): { toString(enc?: string): string } };

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

const site = createSite({ base: 'https://open.spotify.com', rateMs: 400 });
const { fetchPage } = site;

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const HASH: Record<string, string> = {
  track: '612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294',
  album: 'b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10',
  artist: 'ae0e2958a4ab645b35ca19ac04d0495ae12d9c5d7b7286217674801a9aab281a',
  artistDiscography: '5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599',
  artistRelated: '3d031d6cb22a2aa7c8d203d49b49df731f58b1e2799cc38d9876d58771aa66f3',
  playlist: 'a65e12194ed5fc443a1cdebed5fabe33ca5b07b987185d63c72483867ad13cb4',
  episode: '3416929067571ac4b79db16716be3c6ea5f6265f7975a0ee94b1fc5ee1dc1e9d',
  show: 'aaad798a17a43c0f443c45d630a83df39d2ca1062a090c2e4fb045d6b00ab360',
  showEpisodes: '06046f9b939d56c8eb7cdbb687da938de1164c006871aec91dc26e4dc7d8eb08',
  search: 'eff59fa0a3d026b88b56fddbcf4bdfa16a186b8175a5c1a358c072e053c2e5b0',
};

let cachedToken: string | null = null;

function duration(ms: unknown): string {
  if (!ms) return '0:00';
  const n = Number(ms);
  const m = Math.floor(n / 60000);
  const s = Math.floor((n % 60000) / 1000);
  return m + ':' + String(s).padStart(2, '0');
}

async function getHtml(url: string): Promise<string | null> {
  try {
    return await fetchPage(url);
  } catch {
    return null;
  }
}

async function getEmbed(type: string, id: string): Promise<Record<string, unknown> | null> {
  const html = await getHtml('https://open.spotify.com/embed/' + type + '/' + id);
  if (!html) return null;
  const m = html.match(/__NEXT_DATA__.*?>(.*?)<\/script/s);
  if (!m) return null;
  try {
    return (((JSON.parse(m[1]) as Record<string, unknown>).props as Record<string, unknown>).pageProps as Record<string, unknown>).state as never as Record<string, unknown> ? (((JSON.parse(m[1]) as Record<string, unknown>).props as Record<string, unknown>).pageProps as Record<string, unknown>).state as unknown as never : null;
  } catch {
    return null;
  }
}

async function getAccessToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  const html = await getHtml('https://open.spotify.com/embed/track/6PQ88X9TkUIAUIZJHW2upE');
  if (!html) return null;
  const m = html.match(/__NEXT_DATA__.*?>(.*?)<\/script/s);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as Record<string, unknown>;
    const state = ((parsed.props as Record<string, unknown>).pageProps as Record<string, unknown>).state as Record<string, unknown>;
    const token = ((state.settings as Record<string, unknown>).session as Record<string, unknown>).accessToken;
    cachedToken = String(token);
    return cachedToken;
  } catch {
    return null;
  }
}

type Rec = Record<string, unknown>;

async function graph(op: string, hash: string, variables: Record<string, unknown>): Promise<Rec | { error: string }> {
  const token = await getAccessToken();
  if (!token) return { error: 'Failed to get access token' };
  const path = '/pathfinder/v1/query?operationName=' + op +
    '&variables=' + encodeURIComponent(JSON.stringify(variables)) +
    '&extensions=' + encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }));
  const res = await fetch('https://api-partner.spotify.com' + path, {
    headers: { authorization: 'Bearer ' + token, 'user-agent': UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { error: op + ' failed: ' + res.status };
  const data = await res.json() as Rec & { errors?: Array<{ message: string }> };
  if (data.errors && data.errors.length) return { error: data.errors[0].message };
  return data.data as Rec;
}

function get<T>(o: unknown, k: string): T | undefined {
  return o && typeof o === 'object' ? (o as Rec)[k] as T : undefined;
}

function imgUrl(img: unknown): string | null {
  if (!img) return null;
  const o = img as Rec;
  const sources = (o.sources as Array<{ url: string }>)
    || ((o.items as Array<Rec>)?.[0]?.sources as Array<{ url: string }>)
    || ((o.image as Rec)?.sources as Array<{ url: string }>)
    || ((o.coverArt as Rec)?.sources as Array<{ url: string }>);
  return sources && sources[0] ? sources[0].url : null;
}

function artistsName(items: unknown): string[] {
  return ((items as Array<Rec>) || []).map((a) => ((a.profile as Rec)?.name as string) || (a.name as string) || '');
}

function fmtGraphTrack(t: Rec): Rec {
  const albumOf = (t.albumOfTrack as Rec) || {};
  return {
    title: t.name,
    id: t.id,
    uri: t.uri,
    trackNumber: t.trackNumber,
    discNumber: t.discNumber,
    artists: artistsName((t.artists as Rec)?.items || (t.firstArtist as Rec)?.items || (t.otherArtists as Rec)?.items),
    album: albumOf.name,
    releaseDate: albumOf.date ? (albumOf.date as Rec).isoString || null : null,
    duration: duration((t.duration as Rec)?.totalMilliseconds),
    explicit: t.contentRating ? (t.contentRating as Rec).label === 'EXPLICIT' : false,
    playcount: t.playcount || null,
    preview: (t.audioPreview as Rec)?.url || (t.previews as Rec)?.audioPreviews?.items?.[0]?.url || null,
    cover: imgUrl(albumOf.coverArt) || imgUrl((t.visualIdentity as Rec)?.squareCoverImage),
  };
}

async function fetchAll(op: string, hash: string, uri: string, pageSize: number, maxPages: number, extra?: Rec): Promise<Array<Rec>> {
  const all: Array<Rec> = [];
  let offset = 0;
  while (all.length < maxPages * pageSize) {
    const vars = { uri, offset, limit: pageSize, ...extra };
    const data = await graph(op, hash, vars) as Rec;
    if (data.error) break;
    const root = data[Object.keys(data)[0]] as Rec;
    const page = root && ((root.content as Rec) || (root.episodesV2 as Rec) || (root.discography as Rec));
    if (!page) break;
    const items = (page.items as Array<Rec>) || [];
    if (!items.length) break;
    all.push(...items);
    offset += items.length;
    const total = page.totalCount as number;
    if (total && offset >= total) break;
    if (items.length < pageSize) break;
  }
  return all;
}

async function getEmbedData(type: string, id: string): Promise<Rec | null> {
  const embed = await getEmbed(type, id);
  return embed;
}

async function track(id: string): Promise<Rec> {
  const data = await graph('getTrack', HASH.track, { uri: 'spotify:track:' + id }) as Rec;
  const t = data?.trackUnion as Rec;
  if (!t) return { error: 'Track not found' };
  if (t.__typename && typeof t.message === 'string' && !t.name) {
    // Spotify returns {__typename, message} instead of a track for unknown/removed ids
    return { error: 'Track not found', detail: t.message };
  }
  const out = fmtGraphTrack(t) as Rec;
  out.type = 'track';
  if (!out.preview) {
    const embed = await getEmbedData('track', id);
    const preview = (embed?.audioPreview as Rec)?.url;
    if (preview) out.preview = preview;
  }
  const rel = t.associationsV3?.related as Rec | undefined;
  if (rel?.items?.length) {
    out.relatedTracks = rel.items.map((r) => {
      const d = (r as Rec).data || r;
      return { title: d.name, id: d.id, uri: d.uri };
    });
  }
  return out;
}

async function album(id: string): Promise<Rec> {
  const data = await graph('getAlbum', HASH.album, { uri: 'spotify:album:' + id, locale: '', offset: 0, limit: 50 }) as Rec;
  const a = data?.albumUnion as Rec;
  if (!a) return { error: 'Album not found' };
  const rawTracks = (a.tracksV2 ? (a.tracksV2 as Rec).items : a.trackList ? (a.trackList as Rec).items : []) as Array<Rec>;
  const tracks = rawTracks.map((i) => fmtGraphTrack((i.track as Rec) || i));
  const out: Rec = {
    type: 'album',
    title: a.name,
    id: a.id,
    uri: a.uri,
    artists: artistsName((a.artists as Rec)?.items),
    releaseDate: a.date ? (a.date as Rec).isoString || ((a.date as Rec).year + '-' + (a.date as Rec).month + '-' + (a.date as Rec).day) : null,
    totalTracks: a.tracksV2 ? (a.tracksV2 as Rec).totalCount : tracks.length,
    copyright: a.copyright ? ((a.copyright as Rec).items as Array<Rec>).map((c) => c.text) : [],
    cover: imgUrl(a.coverArt),
    tracks,
  };
  const more = a.moreAlbumsByArtist?.items as Array<Rec> | undefined;
  if (more?.length) {
    out.moreAlbums = more.map((m) => ({
      title: m.name, id: m.id, uri: m.uri, releaseYear: (m.date as Rec)?.year, cover: imgUrl(m.coverArt),
    }));
  }
  return out;
}

async function artist(id: string): Promise<Rec> {
  const uri = 'spotify:artist:' + id;
  const [overview, related, disc] = await Promise.all([
    graph('queryArtistOverview', HASH.artist, { uri, locale: '', includePrerelease: false }),
    graph('queryArtistRelated', HASH.artistRelated, { uri }),
    graph('queryArtistDiscographyAll', HASH.artistDiscography, {
      uri, offset: 0, limit: 100,
      includePrerelease: false, includeSingles: true, includeAlbums: true, includeCompilations: true,
    }),
  ]) as Array<Rec>;
  const a = overview?.artistUnion as Rec;
  if (!a) return { error: 'Artist not found' };

  function fmtRelease(x: Rec): Rec {
    return {
      title: x.name, id: x.id, uri: x.uri,
      type: x.type || x.__typename,
      releaseYear: (x.date as Rec)?.year,
      cover: imgUrl(x.coverArt),
    };
  }
  function releases(group: unknown): Array<Rec> {
    return (((group as Rec)?.items as Array<Rec>) || []).map((item) => {
      const r = ((item.releases as Rec)?.items as Array<Rec>) || [item];
      return r.map(fmtRelease);
    }).reduce((acc: Array<Rec>, cur) => acc.concat(cur), []);
  }

  const allItems = disc?.artistUnion?.discography?.all;
  const allList = (((allItems?.items as Array<Rec>) || []).map((i) => (i.releases?.items as Array<Rec>) || [i]))
    .reduce((acc: Array<Rec>, cur) => acc.concat(cur), []);
  function splitByType(type: string): Array<Rec> {
    return allList.filter((r) => {
      const t = String(r.type || r.__typename || '').toUpperCase();
      return type === 'EP' ? t === 'EP' : t === type;
    }).map(fmtRelease);
  }

  const dg = (a.discography as Rec) || {};
  const relContent = (a.relatedContent as Rec) || {};
  const profile = (a.profile as Rec) || {};

  const out: Rec = {
    type: 'artist',
    name: profile.name,
    id: a.id,
    uri: a.uri,
    verified: !!(a.visuals as Rec)?.avatarImage?.extractedColors,
    stats: a.stats ? {
      followers: (a.stats as Rec).followers,
      monthlyListeners: (a.stats as Rec).monthlyListeners,
      worldRank: (a.stats as Rec).worldRank,
      topCities: (((a.stats as Rec).topCities as Rec)?.items as Array<Rec> || []).map((c) => ({
        city: c.city, country: c.country, listeners: c.numberOfListeners,
      })),
    } : null,
    image: imgUrl((a.visuals as Rec)?.avatarImage),
    topTracks: (((dg.topTracks as Rec)?.items as Array<Rec>) || []).map((i) => fmtGraphTrack((i.track as Rec) || i)),
    popularReleases: (((dg.popularReleasesAlbums as Rec)?.items as Array<Rec>) || []).map((x) => ({
      title: x.name, id: x.id, uri: x.uri, type: x.type, releaseYear: (x.date as Rec)?.year, cover: imgUrl(x.coverArt),
    })),
    albums: allList.length ? splitByType('ALBUM') : releases(dg.albums),
    singles: allList.length ? splitByType('SINGLE') : releases(dg.singles),
    compilations: allList.length ? splitByType('COMPILATION') : releases(dg.compilations),
    eps: allList.length ? splitByType('EP') : [],
    relatedArtists: (((relContent.relatedArtists as Rec)?.items as Array<Rec>) || []).map((ra) => ({
      name: (ra.profile as Rec)?.name, id: ra.id, uri: ra.uri, image: imgUrl((ra.visuals as Rec)?.avatarImage),
    })),
    appearsOn: releases(relContent.appearsOn),
    featuring: (((relContent.featuringV2 as Rec)?.items as Array<Rec>) || []).map((f) => {
      const d = f.data || f;
      return { name: d.name, id: d.id, uri: d.uri, cover: imgUrl(d.images) };
    }),
    biography: profile.biography ? (profile.biography as Rec).text : null,
    externalLinks: (((profile.externalLinks as Rec)?.items as Array<Rec>) || []).map((l) => ({ name: l.name, url: l.url })),
    artistPlaylists: (((profile.playlistsV2 as Rec)?.items as Array<Rec>) || []).map((p) => {
      const d = p.data || p;
      return { name: d.name, id: d.id, uri: d.uri, cover: imgUrl(d.images) };
    }),
  };

  const rel = related?.artistUnion as Rec | undefined;
  if (rel?.relatedContent) {
    const list = (((rel.relatedContent as Rec).relatedArtists as Rec)?.items as Array<Rec>) || [];
    if (list.length) {
      out.relatedArtists = list.map((ra) => ({
        name: (ra.profile as Rec)?.name, id: ra.id, uri: ra.uri, image: imgUrl((ra.visuals as Rec)?.avatarImage),
      }));
    }
  }
  return out;
}

async function playlist(id: string): Promise<Rec> {
  const data = await graph('fetchPlaylist', HASH.playlist, { uri: 'spotify:playlist:' + id, offset: 0, limit: 100, enableWatchFeedEntrypoint: false }) as Rec;
  const p = data?.playlistV2 as Rec;
  if (!p || p.__typename === 'NotFound') return { error: 'Playlist not found' };
  const content = (p.content as Rec) || {};
  const pageItems = (content.items as Array<Rec>) || [];
  const tracks = pageItems.map((i) => {
    const t = ((i.itemV2 as Rec)?.data) || i.data || i;
    return fmtGraphTrack(t as Rec);
  });
  const total = content.totalCount as number;
  let extraTracks: Array<Rec> = [];
  if (total > pageItems.length) {
    const rest = await fetchAll('fetchPlaylist', HASH.playlist, 'spotify:playlist:' + id, 100, Math.ceil(total / 100), { enableWatchFeedEntrypoint: false });
    extraTracks = rest.slice(pageItems.length).map((i) => {
      const t = ((i.itemV2 as Rec)?.data) || i.data || i;
      return fmtGraphTrack(t as Rec);
    });
  }
  return {
    type: 'playlist',
    title: p.name,
    description: p.description,
    id: p.id,
    uri: p.uri,
    owner: ((p.ownerV2 as Rec)?.data as Rec)?.username,
    followers: typeof p.followers === 'number' ? p.followers : (p.followers as Rec)?.totalCount,
    trackCount: total || tracks.length,
    cover: imgUrl(p.images),
    tracks: tracks.concat(extraTracks),
  };
}

async function show(id: string): Promise<Rec> {
  const [meta, eps] = await Promise.all([
    graph('queryShowMetadataV2', HASH.show, { uri: 'spotify:show:' + id }),
    graph('queryPodcastEpisodes', HASH.showEpisodes, { uri: 'spotify:show:' + id, offset: 0, limit: 50 }),
  ]) as Array<Rec>;
  const s = meta?.podcastUnionV2 as Rec;
  if (!s) return { error: 'Show not found' };
  const ev = eps?.podcastUnionV2?.episodesV2 as Rec | undefined;
  const epItems = ((ev?.items as Array<Rec>) || []).map((i) => {
    const e = ((i.data as Rec) || ((i.entity as Rec)?.data as Rec)) as Rec;
    return {
      title: e.name,
      id: e.id,
      uri: e.uri,
      description: e.description,
      releaseDate: e.releaseDate ? (e.releaseDate as Rec).isoString : null,
      duration: duration((e.duration as Rec)?.totalMilliseconds),
      cover: imgUrl(e.coverArt),
    };
  });
  return {
    type: 'show',
    title: s.name,
    id: s.id,
    uri: s.uri,
    publisher: s.publisher ? (s.publisher as Rec).name : null,
    description: s.description || s.htmlDescription,
    mediaType: s.mediaType,
    rating: s.rating && (s.rating as Rec).averageRating ? {
      average: (s.rating as Rec).averageRating.average,
      totalRatings: (s.rating as Rec).averageRating.totalRatings,
    } : null,
    explicit: s.contentRatingV2 && ((s.contentRatingV2 as Rec).labels as string[]).indexOf('EXPLICIT') > -1,
    totalEpisodes: ev ? ev.totalCount : epItems.length,
    episodes: epItems,
  };
}

async function episode(id: string): Promise<Rec> {
  const data = await graph('getEpisodeOrChapter', HASH.episode, { uri: 'spotify:episode:' + id }) as Rec;
  const e = data?.episodeUnionV2 as Rec;
  if (!e || e.__typename === 'NotFound') return { error: 'Episode not found' };
  return {
    type: 'episode',
    title: e.name,
    id: e.id,
    uri: e.uri,
    description: e.description,
    releaseDate: e.releaseDate ? (e.releaseDate as Rec).isoString : null,
    duration: duration((e.duration as Rec)?.totalMilliseconds),
    explicit: e.contentRating ? (e.contentRating as Rec).label === 'EXPLICIT' : false,
    show: ((e.podcastV2 as Rec)?.data as Rec)?.name || null,
    preview: (e.previewPlayback as Rec)?.url || ((e.audio as Rec)?.items?.[0] as Rec)?.url || null,
    cover: imgUrl(e.coverArt),
  };
}

function unwrap(item: unknown): Rec {
  const i = item as Rec;
  return (i.item?.data) || i.data || i;
}

function fmtSearchTrack(d: Rec): Rec {
  return {
    type: 'track', name: d.name, id: d.id, uri: d.uri,
    artists: artistsName((d.artists as Rec)?.items),
    album: (d.albumOfTrack as Rec)?.name || null,
    duration: d.duration ? duration((d.duration as Rec).totalMilliseconds) : null,
    explicit: (d.contentRating as Rec)?.label === 'EXPLICIT',
    cover: imgUrl((d.albumOfTrack as Rec)?.coverArt) || imgUrl(d.visualIdentity),
  };
}
function fmtSearchArtist(d: Rec): Rec {
  return {
    type: 'artist', name: (d.profile as Rec)?.name ?? null, id: d.id, uri: d.uri,
    verified: !!((d.onPlatformReputationTrait as Rec)?.verification as Rec)?.isVerified,
    image: imgUrl((d.visuals as Rec)?.avatarImage) || imgUrl(d.visualIdentity),
  };
}
function fmtSearchAlbum(d: Rec): Rec {
  return {
    type: 'album', name: d.name, id: d.id, uri: d.uri,
    artists: artistsName((d.artists as Rec)?.items),
    year: (d.date as Rec)?.year ?? null,
    image: imgUrl(d.coverArt),
  };
}
function fmtSearchPlaylist(d: Rec): Rec {
  return {
    type: 'playlist', name: d.name,
    id: d.id || (d.uri ? String(d.uri).split(':').pop() : null),
    uri: d.uri,
    owner: ((d.ownerV2 as Rec)?.data as Rec)?.username ?? ((d.ownerV2 as Rec)?.username as string) ?? null,
    description: d.description || null,
    image: imgUrl(d.images),
  };
}
function fmtSearchEpisode(d: Rec): Rec {
  return { type: 'episode', name: d.name, id: d.id, uri: d.uri, description: d.description || null, image: imgUrl(d.coverArt) };
}
function fmtSearchPodcast(d: Rec): Rec {
  return { type: 'podcast', name: d.name, id: d.id, uri: d.uri, publisher: ((d.publisher as Rec)?.name as string) || d.publisher || null, image: imgUrl(d.coverArt) };
}
function formatSearchAny(d: Rec | null): Rec | null {
  if (!d) return null;
  switch (d.__typename) {
    case 'Track': return fmtSearchTrack(d);
    case 'Artist': return fmtSearchArtist(d);
    case 'Album': return fmtSearchAlbum(d);
    case 'Playlist': return fmtSearchPlaylist(d);
    case 'Episode': return fmtSearchEpisode(d);
    case 'Podcast': return fmtSearchPodcast(d);
    default: return { type: String(d.__typename || '').toLowerCase(), name: d.name, uri: d.uri };
  }
}

async function search(query: string, limit: number): Promise<Rec> {
  const variables = {
    searchTerm: query, offset: 0, limit, numberOfTopResults: 5,
    includeAudiobooks: true, includePreReleases: true, includeAlbumPreReleases: false,
    includeAuthors: false, includeEpisodeContentRatingsV2: false,
  };
  const data = await graph('searchDesktop', HASH.search, variables) as Rec;
  if (data.error) return data;
  const sv = data?.searchV2 as Rec | undefined;
  if (!sv) return { error: 'No search results' };
  const out: Rec = { query, limit, results: {} };
  const topList = (get<Rec>(sv, 'topResultsV2')?.featured || get<Rec>(sv, 'topResultsV2')?.itemsV2) as Array<Rec> || [];
  const results = out.results as Rec;
  if (topList.length) results.topResults = topList.map(unwrap).map(formatSearchAny).filter(Boolean);
  if (sv.tracksV2) results.tracks = (sv.tracksV2 as Rec).items.map(unwrap).map(fmtSearchTrack);
  if (sv.artists) results.artists = (sv.artists as Rec).items.map(unwrap).map(fmtSearchArtist);
  if (sv.albumsV2) results.albums = (sv.albumsV2 as Rec).items.map(unwrap).map(fmtSearchAlbum);
  if (sv.playlists) results.playlists = (sv.playlists as Rec).items.map(unwrap).map(fmtSearchPlaylist);
  if (sv.episodes) results.episodes = (sv.episodes as Rec).items.map(unwrap).map(fmtSearchEpisode);
  if (sv.podcasts) results.podcasts = (sv.podcasts as Rec).items.map(unwrap).map(fmtSearchPodcast);
  if (sv.genres) results.genres = (sv.genres as Rec).items.map(unwrap).map((g) => ({ type: 'genre', name: g.name, image: imgUrl(g.image) }));
  if (sv.users) results.users = (sv.users as Rec).items.map(unwrap).map((u) => ({
    type: 'user', name: u.displayName || u.name || null, id: u.id || null, uri: u.uri || null, image: imgUrl(u.avatar),
  }));
  return out;
}

function detailByUri(uri: string): Promise<Rec | null> {
  const parts = uri.split(':');
  const type = parts[1];
  const id = parts[2];
  switch (type) {
    case 'track': return track(id);
    case 'artist': return artist(id);
    case 'album': return album(id);
    case 'playlist': return playlist(id);
    default: return Promise.resolve(null);
  }
}

async function mapWithConcurrency<T, R>(arr: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(arr.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await fn(arr[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker));
  return out;
}

async function getHome(withDetail: boolean, limit: number): Promise<Rec> {
  const html = await getHtml('https://open.spotify.com/');
  if (!html) return { error: 'Home not reachable' };
  const m = html.match(/id="initialState"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { error: 'Home data not found' };
  let data: Rec;
  try {
    data = JSON.parse(Buffer.from(m[1].trim(), 'base64').toString('utf-8'));
  } catch {
    return { error: 'Home data parse failed' };
  }
  const home = ((data.home as Rec)?.data) as Rec | undefined;
  if (!home) return { error: 'Home sections missing' };

  const sections = await mapWithConcurrency((home.sections as Array<Rec>) || [], 3, async (s) => {
    let items = (s.items as Array<Rec>) || [];
    if (limit && items.length > limit) items = items.slice(0, limit);
    if (!withDetail) {
      return {
        title: s.title,
        uri: s.uri,
        items: items.map((it) => ({ title: it.title, uri: it.uri, id: String(it.uri).split(':').pop(), imageUrl: it.imageUrl })),
      };
    }
    const itemsWithDetail = await mapWithConcurrency(items, 5, async (it) => {
      const detail = await detailByUri(it.uri);
      return {
        title: it.title, uri: it.uri, id: String(it.uri).split(':').pop(),
        imageUrl: it.imageUrl, detail: detail || null,
      };
    });
    return { title: s.title, uri: s.uri, items: itemsWithDetail };
  });

  return { greeting: home.greetingLabel, sectionCount: sections.length, sections };
}

if (import.meta.main) {
  defineCli({
    name: 'spotify',
    title: 'Spotify Open Scraper',
    commands: {
      home: {
        desc: 'Home page sections (--nodetail, --limit=N)', usage: '[--nodetail] [--limit=N]',
        run: async (_p, f) => getHome(!f.nodetail, parseInt(f.limit || '0') || 0),
      },
      search: {
        desc: 'Full search', usage: '<query> [--limit=N]',
        run: async (p, f) => {
          if (!p[0]) throw new Error('Missing query');
          return search(p.join(' '), parseInt(f.limit || '10') || 10);
        },
      },
      track: { desc: 'Track detail (playcount, preview, related)', usage: '<id>', run: async (p) => { if (!p[0]) throw new Error('Missing id'); return track(p[0]); } },
      artist: { desc: 'Full artist (stats, discography, related)', usage: '<id>', run: async (p) => { if (!p[0]) throw new Error('Missing id'); return artist(p[0]); } },
      album: { desc: 'Full album (all tracks, copyright, more)', usage: '<id>', run: async (p) => { if (!p[0]) throw new Error('Missing id'); return album(p[0]); } },
      playlist: { desc: 'Full playlist (all tracks, paginated)', usage: '<id>', run: async (p) => { if (!p[0]) throw new Error('Missing id'); return playlist(p[0]); } },
      show: { desc: 'Podcast/show + episodes', usage: '<id>', run: async (p) => { if (!p[0]) throw new Error('Missing id'); return show(p[0]); } },
      episode: { desc: 'Episode detail', usage: '<id>', run: async (p) => { if (!p[0]) throw new Error('Missing id'); return episode(p[0]); } },
    },
    examples: `  bun spotify.ts search "taylor swift" --limit=10
  bun spotify.ts artist 51kyrUsAVqUBcoDEMFkX12
  bun spotify.ts playlist 37i9dQZEVXbNG2KDcFcKOF`,
  });
}

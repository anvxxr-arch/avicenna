/*
· base : https://music.youtube.com/
· creator : phrzy
· channel : https://whatsapp.com/channel/0029VbD1zGq6mYPUbtVh6U0L/121
*/

const BASE = 'https://music.youtube.com';
const API = BASE + '/youtubei/v1';
const API_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const CLIENT_VERSION = '1.20260804.16.00';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const FILTERS = {
  songs: 'EgWKAQIIAWoMEA4QChADEAQQCRAF',
  videos: 'EgWKAQIQAWoMEA4QChADEAQQCRAF',
  albums: 'EgWKAQIYAWoMEA4QChADEAQQCRAF',
  artists: 'EgWKAQIgAWoMEA4QChADEAQQCRAF',
  playlists: 'Eg-KAQwIABAAGAAgACgBMABqChAEEAMQCRAFEAo%3D'
};

const TYPE_BY_LABEL = {
  Song: 'song',
  Video: 'video',
  Album: 'album',
  EP: 'album',
  Single: 'album',
  Artist: 'artist',
  Playlist: 'playlist',
  Profile: 'profile',
  Podcast: 'podcast',
  Episode: 'episode'
};

const TYPE_BY_SHELF = {
  Songs: 'song',
  Videos: 'video',
  Albums: 'album',
  Artists: 'artist',
  'Community playlists': 'playlist',
  'Featured playlists': 'playlist',
  Profiles: 'profile',
  Podcasts: 'podcast',
  Episodes: 'episode'
};

async function post(endpoint, body) {
  const payload = {
    context: {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: CLIENT_VERSION,
        hl: 'en',
        gl: 'US',
        userAgent: USER_AGENT
      }
    },
    ...body
  };
  const res = await fetch(`${API}/${endpoint}?key=${API_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-Youtube-Client-Name': '67',
      'X-Youtube-Client-Version': CLIENT_VERSION,
      Origin: BASE,
      Referer: BASE + '/'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

function runsToText(runs) {
  return (runs || []).map((r) => r.text || '').join('');
}

function getThumbnails(renderer) {
  const thumbs =
    renderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    renderer?.thumbnail?.thumbnails ||
    renderer?.thumbnails ||
    [];
  return thumbs.map((t) => t.url);
}

function getVideoId(item) {
  const flex0 = item?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0];
  const watchId = flex0?.navigationEndpoint?.watchEndpoint?.videoId;
  if (watchId) return watchId;
  const items = item?.menu?.menuRenderer?.items || [];
  for (const mi of items) {
    const id = mi.menuServiceItemRenderer?.serviceEndpoint?.queueAddEndpoint?.queueTarget?.videoId;
    if (id) return id;
  }
  return item?.navigationEndpoint?.watchEndpoint?.videoId || null;
}

function getBrowseId(item) {
  const nav = item?.navigationEndpoint?.browseEndpoint?.browseId;
  if (nav) return nav;
  const items = item?.menu?.menuRenderer?.items || [];
  for (const mi of items) {
    const id = mi.menuServiceItemRenderer?.serviceEndpoint?.browseEndpoint?.browseId;
    if (id) return id;
  }
  return null;
}

function getArtists(item) {
  const runs = item?.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  return runs
    .filter((r) => r.navigationEndpoint?.browseEndpoint?.browseId?.startsWith('UC'))
    .map((r) => ({
      name: r.text,
      id: r.navigationEndpoint.browseEndpoint.browseId
    }));
}

function getAlbum(item) {
  const runs = item?.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const run = runs.find((r) => r.navigationEndpoint?.browseEndpoint?.browseId?.startsWith('MPREb'));
  return run
    ? { name: run.text, id: run.navigationEndpoint.browseEndpoint.browseId }
    : null;
}

function getPlays(flex) {
  const text = runsToText(flex?.[2]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  return /plays|views/i.test(text) ? text : null;
}

function parseTrack(item) {
  if (!item) return null;
  const flex = item.flexColumns || [];
  return {
    title: runsToText(flex[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs),
    artists: getArtists(item),
    album: getAlbum(item),
    duration: runsToText(item.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs),
    plays: getPlays(flex),
    videoId: getVideoId(item)
  };
}

function parseSearchItem(item, shelfType) {
  if (!item) return null;
  const flex = item.flexColumns || [];
  const title = runsToText(flex[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  const subtitle = runsToText(flex[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  const resultType = shelfType || TYPE_BY_LABEL[subtitle.split(' • ')[0]] || null;
  const duration =
    runsToText(item.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs) ||
    (resultType === 'song' && /\d+:\d+$/.test(subtitle)
      ? subtitle.split(' • ').pop()
      : null);

  return {
    resultType,
    title,
    subtitle,
    videoId: resultType === 'song' || resultType === 'video' ? getVideoId(item) : null,
    browseId: resultType === 'album' || resultType === 'artist' || resultType === 'playlist' ? getBrowseId(item) : null,
    artists: resultType === 'song' ? getArtists(item) : [],
    plays: getPlays(flex),
    duration,
    thumbnails: getThumbnails(item.thumbnail)
  };
}

function parseTopResult(card) {
  const subtitle = runsToText(card?.subtitle?.runs);
  const parts = subtitle.split(' • ');
  const onTap = card?.onTap || card?.title?.runs?.[0]?.navigationEndpoint || {};
  return {
    category: 'Top result',
    resultType: TYPE_BY_LABEL[parts[0]] || null,
    title: runsToText(card?.title?.runs),
    subtitle,
    videoId: onTap?.watchEndpoint?.videoId || null,
    browseId: onTap?.browseEndpoint?.browseId || null,
    thumbnails: getThumbnails(card?.thumbnail),
    songs: (card?.contents || [])
      .map((c) => parseSearchItem(c.musicResponsiveListItemRenderer))
      .filter(Boolean)
  };
}

async function search(query, filter) {
  const body = { query };
  if (filter && FILTERS[filter]) body.params = FILTERS[filter];
  const json = await post('search', body);
  const sections =
    json.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents || [];
  const results = [];

  for (const section of sections) {
    if (section.musicCardShelfRenderer) {
      results.push(parseTopResult(section.musicCardShelfRenderer));
      continue;
    }
    const shelf = section.musicShelfRenderer;
    const shelfType = shelf ? TYPE_BY_SHELF[runsToText(shelf.title?.runs)] || null : null;
    const items = shelf?.contents || section.itemSectionRenderer?.contents || [];
    for (const item of items) {
      const parsed = parseSearchItem(item.musicResponsiveListItemRenderer, shelfType);
      if (!parsed) continue;
      results.push(parsed);
    }
  }

  return {
    query,
    filter: filter && FILTERS[filter] ? filter : 'all',
    count: results.length,
    results
  };
}

async function info(browseId) {
  const json = await post('browse', { browseId });
  if (browseId.startsWith('MPREb')) return parseAlbum(json);
  if (browseId.startsWith('UC')) return parseArtist(json, browseId);
  if (browseId.startsWith('VL') || browseId.startsWith('PL')) return parsePlaylist(json);
  throw new Error(`Unsupported browseId: ${browseId}`);
}

function getHeader(json) {
  const two = json.contents?.twoColumnBrowseResultsRenderer;
  const sections = two?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  return (
    sections.find((s) => s.musicResponsiveHeaderRenderer)?.musicResponsiveHeaderRenderer ||
    sections.find((s) => s.musicDetailHeaderRenderer)?.musicDetailHeaderRenderer ||
    sections.find((s) => s.musicEditablePlaylistDetailHeaderRenderer)?.musicEditablePlaylistDetailHeaderRenderer ||
    null
  );
}

function getSecondarySections(json) {
  const two = json.contents?.twoColumnBrowseResultsRenderer;
  return two?.secondaryContents?.sectionListRenderer?.contents || [];
}

function getShelfItems(sections) {
  return sections.flatMap(
    (s) => s.musicShelfRenderer?.contents || s.musicPlaylistShelfRenderer?.contents || []
  );
}

function parseAlbum(json) {
  const header = getHeader(json);
  const subtitle = runsToText(header?.subtitle?.runs).split(' • ');
  const tracks = getShelfItems(getSecondarySections(json))
    .map((c) => parseTrack(c.musicResponsiveListItemRenderer))
    .filter(Boolean);

  return {
    type: 'album',
    title: runsToText(header?.title?.runs),
    artist: runsToText(header?.straplineTextOne?.runs),
    year: subtitle[1] || null,
    description: runsToText(header?.description?.runs),
    thumbnails: getThumbnails(header?.thumbnail),
    trackCount: tracks.length,
    tracks
  };
}

function parsePlaylist(json) {
  const header = getHeader(json);
  const tracks = getShelfItems(getSecondarySections(json))
    .map((c) => parseTrack(c.musicResponsiveListItemRenderer))
    .filter(Boolean);

  return {
    type: 'playlist',
    title: runsToText(header?.title?.runs),
    description: runsToText(header?.description?.runs),
    stats: runsToText(header?.secondSubtitle?.runs),
    thumbnails: getThumbnails(header?.thumbnail),
    trackCount: tracks.length,
    tracks
  };
}

function parseCarousel(carousel) {
  const title = runsToText(
    carousel?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs
  );
  const items = (carousel?.contents || [])
    .map((c) => {
      const item = c.musicTwoRowItemRenderer || c.musicMultiRowListItemRenderer;
      if (!item) return null;
      return {
        title: runsToText(item.title?.runs),
        subtitle: runsToText(item.subtitle?.runs),
        browseId: item.navigationEndpoint?.browseEndpoint?.browseId || null,
        videoId: item.navigationEndpoint?.watchEndpoint?.videoId || null,
        thumbnails: getThumbnails(item.thumbnailRenderer)
      };
    })
    .filter(Boolean);
  return { title, items };
}

function parseArtist(json, browseId) {
  const slr = json.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
    ?.sectionListRenderer;
  const sections = slr?.contents || [];

  const topSongsShelf = sections.find((s) => s.musicShelfRenderer)?.musicShelfRenderer;
  const songs = (topSongsShelf?.contents || [])
    .map((c) => parseTrack(c.musicResponsiveListItemRenderer))
    .filter(Boolean);

  const descriptionShelf = sections.find((s) => s.musicDescriptionShelfRenderer)?.musicDescriptionShelfRenderer;
  const name =
    songs.find((s) => s.artists?.some((a) => a.id === browseId))?.artists?.find((a) => a.id === browseId)?.name ||
    runsToText(descriptionShelf?.header?.runs) ||
    null;

  return {
    type: 'artist',
    name,
    description: runsToText(descriptionShelf?.description?.runs),
    views: runsToText(descriptionShelf?.subheader?.runs) || null,
    songs,
    sections: sections
      .filter((s) => s.musicCarouselShelfRenderer)
      .map((s) => parseCarousel(s.musicCarouselShelfRenderer))
  };
}

async function lyrics(videoId, depth = 0) {
  const json = await post('next', { videoId, isAudioOnly: true });
  const tabs =
    json.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
      ?.watchNextTabbedResultsRenderer?.tabs || [];
  const lyricsTab = tabs.find(
    (t) =>
      t.tabRenderer?.endpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS'
  );
  const lyricsBrowseId = lyricsTab?.tabRenderer?.endpoint?.browseEndpoint?.browseId;

  if (!lyricsBrowseId) {
    return depth > 0 ? { videoId, lyrics: null, source: null } : lyricsFallback(videoId);
  }

  const lyricsJson = await post('browse', { browseId: lyricsBrowseId });
  const shelf =
    lyricsJson.contents?.sectionListRenderer?.contents?.find(
      (s) => s.musicDescriptionShelfRenderer
    )?.musicDescriptionShelfRenderer;

  const text = runsToText(shelf?.description?.runs);
  if (text) {
    return {
      videoId,
      lyrics: text,
      source: runsToText(shelf?.footer?.runs) || null
    };
  }

  return depth > 0 ? { videoId, lyrics: null, source: null } : lyricsFallback(videoId);
}

async function findSongVideoId(videoId) {
  const json = await post('next', { videoId, isAudioOnly: true });
  const queue =
    json.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
      ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer
      ?.content?.playlistPanelRenderer;
  const track =
    queue?.contents?.find((c) => c.playlistPanelVideoRenderer?.selected)
      ?.playlistPanelVideoRenderer ||
    queue?.contents?.[0]?.playlistPanelVideoRenderer;
  const title = runsToText(track?.title?.runs).replace(/\s*\([^)]*\)\s*$/g, '');
  const artist = runsToText(track?.shortBylineText?.runs);
  const query = `${title} ${artist}`.trim();
  if (!query) return null;

  const res = await search(query, 'songs');
  const song = res.results.find(
    (r) => r.resultType === 'song' && r.videoId && r.videoId !== videoId
  );
  return song?.videoId || null;
}

async function lyricsFallback(videoId) {
  const songVideoId = await findSongVideoId(videoId);
  if (!songVideoId) return { videoId, lyrics: null, source: null };

  const resolved = await lyrics(songVideoId, 1);
  if (resolved.lyrics) {
    return { videoId, lyrics: resolved.lyrics, source: resolved.source };
  }
  return { videoId, lyrics: null, source: null };
}

// ---------- related ----------

async function related(videoId) {
  const json = await post('next', {
    playlistId: 'RDAMVM' + videoId,
    isAudioOnly: true
  });
  const tabs =
    json.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
      ?.watchNextTabbedResultsRenderer?.tabs || [];
  const queue =
    tabs.find((t) => t.tabRenderer?.title === 'Up next')?.tabRenderer?.content
      ?.musicQueueRenderer?.content?.playlistPanelRenderer;

  const tracks = (queue?.contents || [])
    .map((c) => {
      const v = c.playlistPanelVideoRenderer;
      if (!v) return null;
      return {
        title: runsToText(v.title?.runs),
        artists: (v.longBylineText?.runs || [])
          .filter((r) => r.navigationEndpoint?.browseEndpoint?.browseId?.startsWith('UC'))
          .map((r) => ({
            name: r.text,
            id: r.navigationEndpoint.browseEndpoint.browseId
          })),
        duration: runsToText(v.lengthText?.runs),
        videoId: v.videoId,
        selected: v.selected || false,
        thumbnails: getThumbnails(v.thumbnail)
      };
    })
    .filter(Boolean);

  return {
    videoId,
    count: tracks.length,
    tracks
  };
}

let cachedSignatureTimestamp;
async function getSignatureTimestamp() {
  if (cachedSignatureTimestamp) return cachedSignatureTimestamp;
  const html = await fetch(BASE + '/', { headers: { 'User-Agent': USER_AGENT } }).then((r) => r.text());
  const playerJs = html.match(/\/s\/player\/[^"']*base\.js/)?.[0];
  if (!playerJs) throw new Error('Unable to locate player script');
  const js = await fetch(BASE + playerJs, { headers: { 'User-Agent': USER_AGENT } }).then((r) => r.text());
  cachedSignatureTimestamp = Number(js.match(/signatureTimestamp:(\d+)/)?.[1] || 0);
  return cachedSignatureTimestamp;
}

async function download(videoId, depth = 0) {
  const signatureTimestamp = await getSignatureTimestamp();
  const json = await post('player', {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: { contentPlaybackContext: { signatureTimestamp } }
  });

  const status = json.playabilityStatus?.status;
  if (status !== 'OK') {
    if (depth === 0) {
      const songVideoId = await findSongVideoId(videoId);
      if (songVideoId) {
        const resolved = await download(songVideoId, 1);
        if (resolved.status === 'OK') {
          return { ...resolved, videoId };
        }
      }
    }
    return {
      videoId,
      status,
      reason:
        json.playabilityStatus?.reason ||
        runsToText(json.playabilityStatus?.errorScreen?.playerErrorMessageRenderer?.reason?.runs) ||
        null
    };
  }

  const formats = [
    ...(json.streamingData?.formats || []),
    ...(json.streamingData?.adaptiveFormats || [])
  ];
  const parseCipher = (cipher) => {
    if (!cipher) return null;
    const qs = new URLSearchParams(cipher);
    return { url: qs.get('url'), sp: qs.get('sp'), s: qs.get('s') };
  };
  const parseFormat = (f) => ({
    itag: f.itag,
    mimeType: f.mimeType?.split(';')[0] || null,
    bitrate: f.bitrate || f.averageBitrate || null,
    quality: f.quality || null,
    audioQuality: f.audioQuality || null,
    contentLength: f.contentLength ? Number(f.contentLength) : null,
    url: f.url || null,
    cipher: parseCipher(f.signatureCipher || f.cipher)
  });

  return {
    videoId,
    title: json.videoDetails?.title,
    artist: json.videoDetails?.author || null,
    lengthSeconds: Number(json.videoDetails?.lengthSeconds || 0),
    thumbnail:
      json.videoDetails?.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || null,
    expiresInSeconds: json.streamingData?.expiresInSeconds || null,
    audioFormats: formats.filter((f) => f.mimeType?.startsWith('audio')).map(parseFormat),
    videoFormats: formats.filter((f) => f.mimeType?.startsWith('video')).map(parseFormat)
  };
}

const usage = {
  description: 'Scraper untuk YouTube Music (music.youtube.com)',
  commands: {
    search: {
      args: 'search "<query>" [filter]',
      filters: Object.keys(FILTERS),
      example: 'node music.js search "avenged sevenfold" songs'
    },
    info: {
      args: 'info <browseId>',
      note: 'albumId (MPREb_..), artistId (UC..), atau playlistId (VL../PL..)',
      example: 'node music.js info MPREb_iiwAV5NRcwy'
    },
    lyrics: {
      args: 'lyrics <videoId>',
      example: 'node music.js lyrics onCZOgWlr1U'
    },
    related: {
      args: 'related <videoId>',
      example: 'node music.js related onCZOgWlr1U'
    },
    download: {
      args: 'download <videoId>',
      note: 'mengambil info stream audio dari endpoint player',
      example: 'node music.js download onCZOgWlr1U'
    }
  }
};

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(JSON.stringify(usage, null, 2));
} else {
  (async () => {
    const [command, ...rest] = args;
    try {
      let data;
      switch (command) {
        case 'search':
          data = await search(rest[0], rest[1]);
          break;
        case 'info':
          data = await info(rest[0]);
          break;
        case 'lyrics':
          data = await lyrics(rest[0]);
          break;
        case 'related':
          data = await related(rest[0]);
          break;
        case 'download':
          data = await download(rest[0]);
          break;
        default:
          data = { error: `Unknown command: ${command}`, usage };
          break;
      }
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      console.log(JSON.stringify({ error: err.message }, null, 2));
    }
  })();
}

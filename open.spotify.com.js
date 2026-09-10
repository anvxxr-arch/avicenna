/*
· base : https://open.spotify.com/
· creator : phrzy
· channel : https://whatsapp.com/channel/0029VbD1zGq6mYPUbtVh6U0L/121
*/

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const HASH = {
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
  similarAlbums: '1d1f93a737498adca2c892c73af87fc0b052afe4e1a33c989540c32413dfae17',
  concerts: 'ef53c43b865496b9890b7167eab1dc614a8949ef9451b3c41184ea888de8bd2b'
};

let cachedToken = null;

function duration(ms) {
  if (!ms) return '0:00';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m + ':' + String(s).padStart(2, '0');
}

async function getHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  return res.text();
}

async function getEmbed(type, id) {
  const html = await getHtml('https://open.spotify.com/embed/' + type + '/' + id);
  if (!html) return null;
  const m = html.match(/__NEXT_DATA__.*?>(.*?)<\/script/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]).props.pageProps.state.data.entity;
  } catch {
    return null;
  }
}

async function getAccessToken() {
  if (cachedToken) return cachedToken;
  const html = await getHtml('https://open.spotify.com/embed/track/6PQ88X9TkUIAUIZJHW2upE');
  if (!html) return null;
  const m = html.match(/__NEXT_DATA__.*?>(.*?)<\/script/s);
  if (!m) return null;
  try {
    cachedToken = JSON.parse(m[1]).props.pageProps.state.settings.session.accessToken;
    return cachedToken;
  } catch {
    return null;
  }
}

async function graph(op, hash, variables) {
  const token = await getAccessToken();
  if (!token) return { error: 'Failed to get access token' };
  const path = '/pathfinder/v1/query?operationName=' + op +
    '&variables=' + encodeURIComponent(JSON.stringify(variables)) +
    '&extensions=' + encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }));
  const res = await fetch('https://api-partner.spotify.com' + path, {
    headers: { 'Authorization': 'Bearer ' + token, 'User-Agent': UA }
  });
  if (!res.ok) return { error: op + ' failed: ' + res.status };
  const data = await res.json();
  if (data.errors && data.errors.length) return { error: data.errors[0].message };
  return data.data;
}

function imgUrl(img) {
  if (!img) return null;
  const sources = img.sources ||
    (img.items && img.items[0] && img.items[0].sources) ||
    (img.image && img.image.sources) ||
    (img.coverArt && img.coverArt.sources);
  return sources && sources[0] ? sources[0].url : null;
}

function artistsName(items) {
  return (items || []).map(function (a) {
    return (a.profile && a.profile.name) || a.name || '';
  });
}

function fmtGraphTrack(t) {
  const albumOf = t.albumOfTrack || {};
  return {
    title: t.name,
    id: t.id,
    uri: t.uri,
    trackNumber: t.trackNumber,
    discNumber: t.discNumber,
    artists: artistsName((t.artists && t.artists.items) || (t.firstArtist && t.firstArtist.items) || (t.otherArtists && t.otherArtists.items)),
    album: albumOf.name,
    releaseDate: albumOf.date ? albumOf.date.isoString || null : null,
    duration: duration(t.duration && t.duration.totalMilliseconds),
    explicit: t.contentRating ? t.contentRating.label === 'EXPLICIT' : false,
    playcount: t.playcount || null,
    preview: (t.audioPreview && t.audioPreview.url) || (t.previews && t.previews.audioPreviews && t.previews.audioPreviews.items[0] && t.previews.audioPreviews.items[0].url) || null,
    cover: imgUrl(albumOf.coverArt) || imgUrl(t.visualIdentity && t.visualIdentity.squareCoverImage)
  };
}

async function fetchAll(op, hash, uri, pageSize, maxPages, extra) {
  const all = [];
  let offset = 0;
  while (all.length < maxPages * pageSize) {
    const vars = { uri, offset, limit: pageSize };
    if (extra) Object.assign(vars, extra);
    const data = await graph(op, hash, vars);
    const root = data[Object.keys(data)[0]];
    const page = root && (root.content || root.episodesV2 || root.discography);
    if (!page) break;
    const items = page.items || [];
    if (!items.length) break;
    all.push.apply(all, items);
    offset += items.length;
    const total = page.totalCount;
    if (total && offset >= total) break;
    if (items.length < pageSize) break;
  }
  return all;
}

async function track(id) {
  const data = await graph('getTrack', HASH.track, { uri: 'spotify:track:' + id });
  const t = data && data.trackUnion;
  if (!t) return { error: 'Track not found' };
  const out = fmtGraphTrack(t);
  out.type = 'track';
  if (!out.preview) {
    const embed = await getEmbed('track', id);
    if (embed && embed.audioPreview) out.preview = embed.audioPreview.url;
  }
  const rel = t.associationsV3 && t.associationsV3.related;
  if (rel && rel.items && rel.items.length) {
    out.relatedTracks = rel.items.map(function (r) {
      const d = r.data || r;
      return { title: d.name, id: d.id, uri: d.uri };
    });
  }
  return out;
}

async function album(id) {
  const data = await graph('getAlbum', HASH.album, { uri: 'spotify:album:' + id, locale: '', offset: 0, limit: 50 });
  const a = data && data.albumUnion;
  if (!a) return { error: 'Album not found' };
  const tracks = (a.tracksV2 ? a.tracksV2.items : a.trackList ? a.trackList.items : []).map(function (i) {
    return fmtGraphTrack(i.track || i);
  });
  const out = {
    type: 'album',
    title: a.name,
    id: a.id,
    uri: a.uri,
    artists: artistsName(a.artists && a.artists.items),
    releaseDate: a.date ? a.date.isoString || (a.date.year + '-' + a.date.month + '-' + a.date.day) : null,
    totalTracks: a.tracksV2 ? a.tracksV2.totalCount : tracks.length,
    copyright: a.copyright ? a.copyright.items.map(function (c) { return c.text; }) : [],
    cover: imgUrl(a.coverArt),
    tracks
  };
  const more = a.moreAlbumsByArtist && a.moreAlbumsByArtist.items;
  if (more && more.length) {
    out.moreAlbums = more.map(function (m) {
      return { title: m.name, id: m.id, uri: m.uri, releaseYear: m.date && m.date.year, cover: imgUrl(m.coverArt) };
    });
  }
  return out;
}

async function artist(id) {
  const uri = 'spotify:artist:' + id;
  const [overview, related, disc] = await Promise.all([
    graph('queryArtistOverview', HASH.artist, { uri, locale: '', includePrerelease: false }),
    graph('queryArtistRelated', HASH.artistRelated, { uri }),
    graph('queryArtistDiscographyAll', HASH.artistDiscography, {
      uri, offset: 0, limit: 100,
      includePrerelease: false, includeSingles: true, includeAlbums: true, includeCompilations: true
    })
  ]);
  const a = overview && overview.artistUnion;
  if (!a) return { error: 'Artist not found' };

  function fmtRelease(x) {
    return {
      title: x.name,
      id: x.id,
      uri: x.uri,
      type: x.type || x.__typename,
      releaseYear: x.date && x.date.year,
      cover: imgUrl(x.coverArt)
    };
  }

  function releases(group) {
    return (group && group.items || []).map(function (item) {
      const r = (item.releases && item.releases.items) || [item];
      return r.map(fmtRelease);
    }).reduce(function (acc, cur) { return acc.concat(cur); }, []);
  }

  const allItems = disc && disc.artistUnion && disc.artistUnion.discography && disc.artistUnion.discography.all;
  const allList = (allItems && allItems.items || []).map(function (i) {
    return (i.releases && i.releases.items) || [i];
  }).reduce(function (acc, cur) { return acc.concat(cur); }, []);
  function splitByType(type) {
    return allList.filter(function (r) {
      const t = (r.type || r.__typename || '').toUpperCase();
      return type === 'EP' ? t === 'EP' : t === type;
    }).map(fmtRelease);
  }

  const dg = a.discography || {};
  const relContent = a.relatedContent || {};
  const profile = a.profile || {};

  const out = {
    type: 'artist',
    name: profile.name,
    id: a.id,
    uri: a.uri,
    verified: !!(a.visuals && a.visuals.avatarImage && a.visuals.avatarImage.extractedColors),
    stats: a.stats ? {
      followers: a.stats.followers,
      monthlyListeners: a.stats.monthlyListeners,
      worldRank: a.stats.worldRank,
      topCities: (a.stats.topCities && a.stats.topCities.items || []).map(function (c) {
        return { city: c.city, country: c.country, listeners: c.numberOfListeners };
      })
    } : null,
    image: imgUrl(a.visuals && a.visuals.avatarImage),
    topTracks: (dg.topTracks && dg.topTracks.items || []).map(function (i) {
      return fmtGraphTrack(i.track || i);
    }),
    popularReleases: (dg.popularReleasesAlbums && dg.popularReleasesAlbums.items || []).map(function (x) {
      return { title: x.name, id: x.id, uri: x.uri, type: x.type, releaseYear: x.date && x.date.year, cover: imgUrl(x.coverArt) };
    }),
    albums: allList.length ? splitByType('ALBUM') : releases(dg.albums),
    singles: allList.length ? splitByType('SINGLE') : releases(dg.singles),
    compilations: allList.length ? splitByType('COMPILATION') : releases(dg.compilations),
    eps: allList.length ? splitByType('EP') : [],
    relatedArtists: (relContent.relatedArtists && relContent.relatedArtists.items || []).map(function (ra) {
      return { name: ra.profile && ra.profile.name, id: ra.id, uri: ra.uri, image: imgUrl(ra.visuals && ra.visuals.avatarImage) };
    }),
    appearsOn: releases(relContent.appearsOn),
    featuring: (relContent.featuringV2 && relContent.featuringV2.items || []).map(function (f) {
      const d = f.data || f;
      return { name: d.name, id: d.id, uri: d.uri, cover: imgUrl(d.images) };
    }),
    biography: profile.biography ? profile.biography.text : null,
    externalLinks: (profile.externalLinks && profile.externalLinks.items || []).map(function (l) {
      return { name: l.name, url: l.url };
    }),
    artistPlaylists: (profile.playlistsV2 && profile.playlistsV2.items || []).map(function (p) {
      const d = p.data || p;
      return { name: d.name, id: d.id, uri: d.uri, cover: imgUrl(d.images) };
    })
  };

  const rel = related && related.artistUnion;
  if (rel && rel.relatedContent) {
    const list = rel.relatedContent.relatedArtists && rel.relatedContent.relatedArtists.items || [];
    if (list.length) {
      out.relatedArtists = list.map(function (ra) {
        return { name: ra.profile && ra.profile.name, id: ra.id, uri: ra.uri, image: imgUrl(ra.visuals && ra.visuals.avatarImage) };
      });
    }
  }
  return out;
}

async function playlist(id) {
  const data = await graph('fetchPlaylist', HASH.playlist, { uri: 'spotify:playlist:' + id, offset: 0, limit: 100, enableWatchFeedEntrypoint: false });
  const p = data && data.playlistV2;
  if (!p || p.__typename === 'NotFound') return { error: 'Playlist not found' };
  const content = p.content || {};
  const pageItems = content.items || [];
  const tracks = pageItems.map(function (i) {
    const t = (i.itemV2 && i.itemV2.data) || i.data || i;
    return fmtGraphTrack(t);
  });
  const total = content.totalCount;
  let extraTracks = [];
  if (total > pageItems.length) {
    const rest = await fetchAll('fetchPlaylist', HASH.playlist, 'spotify:playlist:' + id, 100, Math.ceil(total / 100), { enableWatchFeedEntrypoint: false });
    extraTracks = rest.slice(pageItems.length).map(function (i) {
      const t = (i.itemV2 && i.itemV2.data) || i.data || i;
      return fmtGraphTrack(t);
    });
  }
  return {
    type: 'playlist',
    title: p.name,
    description: p.description,
    id: p.id,
    uri: p.uri,
    owner: p.ownerV2 && p.ownerV2.data.username,
    followers: typeof p.followers === 'number' ? p.followers : p.followers && p.followers.totalCount,
    trackCount: total || tracks.length,
    cover: imgUrl(p.images),
    tracks: tracks.concat(extraTracks)
  };
}

async function show(id) {
  const [meta, eps] = await Promise.all([
    graph('queryShowMetadataV2', HASH.show, { uri: 'spotify:show:' + id }),
    graph('queryPodcastEpisodes', HASH.showEpisodes, { uri: 'spotify:show:' + id, offset: 0, limit: 50 })
  ]);
  const s = meta && meta.podcastUnionV2;
  if (!s) return { error: 'Show not found' };
  const ev = eps && eps.podcastUnionV2 && eps.podcastUnionV2.episodesV2;
  const epItems = (ev && ev.items || []).map(function (i) {
    const e = i.data || i.entity && i.entity.data;
    return {
      title: e.name,
      id: e.id,
      uri: e.uri,
      description: e.description,
      releaseDate: e.releaseDate ? e.releaseDate.isoString : null,
      duration: duration(e.duration && e.duration.totalMilliseconds),
      cover: imgUrl(e.coverArt)
    };
  });
  return {
    type: 'show',
    title: s.name,
    id: s.id,
    uri: s.uri,
    publisher: s.publisher ? s.publisher.name : null,
    description: s.description || s.htmlDescription,
    mediaType: s.mediaType,
    rating: s.rating && s.rating.averageRating ? {
      average: s.rating.averageRating.average,
      totalRatings: s.rating.averageRating.totalRatings
    } : null,
    explicit: s.contentRatingV2 && s.contentRatingV2.labels && s.contentRatingV2.labels.indexOf('EXPLICIT') > -1,
    totalEpisodes: ev ? ev.totalCount : epItems.length,
    episodes: epItems
  };
}

async function episode(id) {
  const data = await graph('getEpisodeOrChapter', HASH.episode, { uri: 'spotify:episode:' + id });
  const e = data && data.episodeUnionV2;
  if (!e || e.__typename === 'NotFound') return { error: 'Episode not found' };
  return {
    type: 'episode',
    title: e.name,
    id: e.id,
    uri: e.uri,
    description: e.description,
    releaseDate: e.releaseDate ? e.releaseDate.isoString : null,
    duration: duration(e.duration && e.duration.totalMilliseconds),
    explicit: e.contentRating ? e.contentRating.label === 'EXPLICIT' : false,
    show: e.podcastV2 && e.podcastV2.data ? e.podcastV2.data.name : null,
    preview: e.previewPlayback && e.previewPlayback.url || (e.audio && e.audio.items[0] && e.audio.items[0].url) || null,
    cover: imgUrl(e.coverArt)
  };
}

function unwrap(item) {
  return (item.item && item.item.data) || item.data || item;
}

function fmtSearchTrack(d) {
  return {
    type: 'track',
    name: d.name,
    id: d.id,
    uri: d.uri,
    artists: artistsName(d.artists && d.artists.items),
    album: d.albumOfTrack ? d.albumOfTrack.name : null,
    duration: d.duration ? duration(d.duration.totalMilliseconds) : null,
    explicit: d.contentRating && d.contentRating.label === 'EXPLICIT',
    cover: imgUrl(d.albumOfTrack && d.albumOfTrack.coverArt) || imgUrl(d.visualIdentity)
  };
}

function fmtSearchArtist(d) {
  return {
    type: 'artist',
    name: d.profile ? d.profile.name : null,
    id: d.id,
    uri: d.uri,
    verified: !!(d.onPlatformReputationTrait && d.onPlatformReputationTrait.verification && d.onPlatformReputationTrait.verification.isVerified),
    image: imgUrl(d.visuals && d.visuals.avatarImage) || imgUrl(d.visualIdentity)
  };
}

function fmtSearchAlbum(d) {
  return {
    type: 'album',
    name: d.name,
    id: d.id,
    uri: d.uri,
    artists: artistsName(d.artists && d.artists.items),
    year: d.date ? d.date.year : null,
    image: imgUrl(d.coverArt)
  };
}

function fmtSearchPlaylist(d) {
  return {
    type: 'playlist',
    name: d.name,
    id: d.id || (d.uri ? d.uri.split(':').pop() : null),
    uri: d.uri,
    owner: d.ownerV2 ? (d.ownerV2.data || d.ownerV2).username : null,
    description: d.description || null,
    image: imgUrl(d.images)
  };
}

function fmtSearchEpisode(d) {
  return {
    type: 'episode',
    name: d.name,
    id: d.id,
    uri: d.uri,
    description: d.description || null,
    image: imgUrl(d.coverArt)
  };
}

function fmtSearchPodcast(d) {
  return {
    type: 'podcast',
    name: d.name,
    id: d.id,
    uri: d.uri,
    publisher: d.publisher && d.publisher.name || d.publisher || null,
    image: imgUrl(d.coverArt)
  };
}

function formatSearchAny(d) {
  if (!d) return null;
  switch (d.__typename) {
    case 'Track': return fmtSearchTrack(d);
    case 'Artist': return fmtSearchArtist(d);
    case 'Album': return fmtSearchAlbum(d);
    case 'Playlist': return fmtSearchPlaylist(d);
    case 'Episode': return fmtSearchEpisode(d);
    case 'Podcast': return fmtSearchPodcast(d);
    default: return { type: (d.__typename || '').toLowerCase(), name: d.name, uri: d.uri };
  }
}

async function search(query, options) {
  const limit = options.limit || 10;
  const variables = {
    searchTerm: query,
    offset: 0,
    limit,
    numberOfTopResults: 5,
    includeAudiobooks: true,
    includePreReleases: true,
    includeAlbumPreReleases: false,
    includeAuthors: false,
    includeEpisodeContentRatingsV2: false
  };
  const data = await graph('searchDesktop', HASH.search, variables);
  const sv = data && data.searchV2;
  if (!sv) return { error: 'No search results' };
  const out = { query, limit, results: {} };
  const topList = (sv.topResultsV2 && (sv.topResultsV2.featured || sv.topResultsV2.itemsV2)) || [];
  if (topList.length) out.results.topResults = topList.map(unwrap).map(formatSearchAny).filter(Boolean);
  if (sv.tracksV2) out.results.tracks = sv.tracksV2.items.map(unwrap).map(fmtSearchTrack);
  if (sv.artists) out.results.artists = sv.artists.items.map(unwrap).map(fmtSearchArtist);
  if (sv.albumsV2) out.results.albums = sv.albumsV2.items.map(unwrap).map(fmtSearchAlbum);
  if (sv.playlists) out.results.playlists = sv.playlists.items.map(unwrap).map(fmtSearchPlaylist);
  if (sv.episodes) out.results.episodes = sv.episodes.items.map(unwrap).map(fmtSearchEpisode);
  if (sv.podcasts) out.results.podcasts = sv.podcasts.items.map(unwrap).map(fmtSearchPodcast);
  if (sv.genres) out.results.genres = sv.genres.items.map(unwrap).map(function (g) {
    return { type: 'genre', name: g.name, image: imgUrl(g.image) };
  });
  if (sv.users) out.results.users = sv.users.items.map(unwrap).map(function (u) {
    return { type: 'user', name: u.displayName || u.name || null, id: u.id || null, uri: u.uri || null, image: imgUrl(u.avatar) };
  });
  return out;
}

function detailByUri(uri) {
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

async function mapWithConcurrency(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  async function worker() {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await fn(arr[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, arr.length) }, worker);
  await Promise.all(workers);
  return out;
}

async function getHome(withDetail, limit) {
  const html = await getHtml('https://open.spotify.com/');
  if (!html) return { error: 'Home not reachable' };
  const m = html.match(/id="initialState"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { error: 'Home data not found' };
  let data;
  try {
    data = JSON.parse(Buffer.from(m[1].trim(), 'base64').toString('utf-8'));
  } catch {
    return { error: 'Home data parse failed' };
  }
  const home = data.home && data.home.data;
  if (!home) return { error: 'Home sections missing' };

  const sections = await mapWithConcurrency(home.sections, 3, async (s) => {
    let items = s.items || [];
    if (limit && items.length > limit) items = items.slice(0, limit);
    if (!withDetail) {
      return {
        title: s.title,
        uri: s.uri,
        items: items.map(function (it) {
          return { title: it.title, uri: it.uri, id: it.uri.split(':').pop(), imageUrl: it.imageUrl };
        })
      };
    }
    const itemsWithDetail = await mapWithConcurrency(items, 5, async (it) => {
      const detail = await detailByUri(it.uri);
      return {
        title: it.title,
        uri: it.uri,
        id: it.uri.split(':').pop(),
        imageUrl: it.imageUrl,
        detail: detail || null
      };
    });
    return { title: s.title, uri: s.uri, items: itemsWithDetail };
  });

  return { greeting: home.greetingLabel, sectionCount: sections.length, sections };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd) {
    process.stdout.write('Usage: node open.js <command> [args]\n');
    process.stdout.write('\nCommands:\n');
    process.stdout.write('  home                    - Full home page sections\n');
    process.stdout.write('  home --nodetail         - Sections only, no item detail\n');
    process.stdout.write('  home --limit=10         - Max items per section\n');
    process.stdout.write('  search <query>          - Full search\n');
    process.stdout.write('  search <query> --limit=20\n');
    process.stdout.write('  track <id>              - Track detail (playcount, preview, related)\n');
    process.stdout.write('  artist <id>             - Full artist (stats, discography, related)\n');
    process.stdout.write('  album <id>              - Full album (all tracks, copyright, more albums)\n');
    process.stdout.write('  playlist <id>           - Full playlist (all tracks, paginated)\n');
    process.stdout.write('  show <id>               - Podcast/show + episodes\n');
    process.stdout.write('  episode <id>            - Episode detail\n');
    process.stdout.write('\nExamples:\n');
    process.stdout.write('  node open.js home\n');
    process.stdout.write('  node open.js search taylor swift --limit=10\n');
    process.stdout.write('  node open.js artist 51kyrUsAVqUBcoDEMFkX12\n');
    process.stdout.write('  node open.js album 1DAuVHMlBvIjzWZALSUXbn\n');
    process.stdout.write('  node open.js playlist 37i9dQZEVXbNG2KDcFcKOF\n');
    process.stdout.write('  node open.js show 4rOoJ6Egrf8K2IrywzwOMk\n');
    process.stdout.write('  node open.js episode 6OCTXsWxaJLkDNV3xAF8cU\n');
    return;
  }
  let out;
  try {
    if (cmd === 'home') {
      let withDetail = true, limit = 0;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--nodetail') withDetail = false;
        else if (args[i].indexOf('--limit=') === 0) limit = parseInt(args[i].split('=')[1]) || 0;
      }
      out = await getHome(withDetail, limit);
    } else if (cmd === 'search') {
      const q = args[1];
      if (!q) out = { error: 'Missing query. Usage: search <query>' };
      else {
        let limit = 10;
        for (let i = 2; i < args.length; i++) {
          if (args[i].indexOf('--limit=') === 0) limit = parseInt(args[i].split('=')[1]) || 10;
        }
        out = await search(q, { limit });
      }
    } else if (args[1]) {
      switch (cmd) {
        case 'track': out = await track(args[1]); break;
        case 'artist': out = await artist(args[1]); break;
        case 'album': out = await album(args[1]); break;
        case 'playlist': out = await playlist(args[1]); break;
        case 'show': out = await show(args[1]); break;
        case 'episode': out = await episode(args[1]); break;
        default: out = { error: 'Unknown type' };
      }
    } else {
      out = { error: 'Missing id for ' + cmd };
    }
  } catch (e) {
    out = { error: e.message };
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main();

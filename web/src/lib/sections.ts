/**
 * Single source of truth for navigation, routes and docs.
 *
 * Every entry names the backend route(s) it uses so the UI, the docs page and
 * the playground stay in sync with the Go server's route table.
 */

export interface MediaLink {
  label: string;
  href: string;
}

export interface SectionDef {
  /** URL path, e.g. "/anime" */
  path: string;
  /** short label for nav */
  label: string;
  /** one-line purpose */
  blurb: string;
  /** backend endpoint family this page drives */
  endpoints: string[];
  /** which backend owns it */
  runtime: 'go' | 'bun' | 'rust';
  status: 'live' | 'degraded' | 'planned';
  /** badge shown in the nav, e.g. source site */
  source?: string;
}

export const SECTIONS: SectionDef[] = [
  {
    path: '/anime', label: 'Anime', blurb: 'NontonAnimeID: home, search, detail, episode streams, schedule.',
    endpoints: ['/home', '/search', '/anime', '/episode', '/stream', '/schedule'], runtime: 'go', status: 'live', source: 's13.nontonanimeid.boats',
  },
  {
    path: '/film', label: 'Film', blurb: 'LK21 movie listings, sections and per-title detail with download links.',
    endpoints: ['/lk21/list', '/lk21/sections', '/lk21/detail'], runtime: 'go', status: 'live', source: 'tv12.lk21official.cc',
  },
  {
    path: '/manga', label: 'Manga', blurb: 'Manga catalogue search and chapter metadata.',
    endpoints: ['/manga/search', '/manga/detail'], runtime: 'go', status: 'planned', source: '—',
  },
  {
    path: '/music', label: 'Music', blurb: 'Spotify open-web graph: tracks, albums, artists, playlists, podcasts.',
    endpoints: ['/music/home', '/music/search', '/music/track'], runtime: 'go', status: 'live', source: 'open.spotify.com',
  },
  {
    path: '/youtube', label: 'YouTube', blurb: 'm.youtube + YouTube Music: search, video info, mixes, lyrics.',
    endpoints: ['/youtube/search', '/youtube/info', '/youtube/related', '/youtube-music/search'], runtime: 'go', status: 'live', source: 'm.youtube.com',
  },
  {
    path: '/tiktok', label: 'TikTok', blurb: 'Video stats, no-watermark URLs and public profile data.',
    endpoints: ['/tiktok/video', '/tiktok/user'], runtime: 'go', status: 'live', source: 'www.tiktok.com',
  },
  {
    path: '/instagram', label: 'Instagram', blurb: 'Public post/profile metadata.',
    endpoints: ['/instagram/post', '/instagram/profile'], runtime: 'go', status: 'planned', source: '—',
  },
  {
    path: '/facebook', label: 'Facebook', blurb: 'Public page and video metadata.',
    endpoints: ['/facebook/page'], runtime: 'go', status: 'planned', source: '—',
  },
  {
    path: '/twitter', label: 'Twitter', blurb: 'Public timeline and post metadata.',
    endpoints: ['/twitter/post'], runtime: 'go', status: 'planned', source: '—',
  },
  {
    path: '/drowify', label: 'Drowify', blurb: 'Music search, artists, albums and timed lyrics.',
    endpoints: ['/drowify/search', '/drowify/artist', '/drowify/lyrics'], runtime: 'go', status: 'degraded', source: 'drowify-music.biz.id',
  },
  {
    path: '/whitehouse', label: 'WhiteHouse', blurb: 'Press releases, briefings, presidential actions and videos.',
    endpoints: ['/whitehouse/home', '/whitehouse/sections', '/whitehouse/search'], runtime: 'go', status: 'live', source: 'whitehouse.gov',
  },
  {
    path: '/tools', label: 'Tools', blurb: 'Codeengo text-to-image, FreeConvert video compression, page-source capture.',
    endpoints: ['/tools/image', '/tools/compress', '/tools/source'], runtime: 'go', status: 'live', source: 'codeengo / freeconvert / view-page-source',
  },
];

export const PRIMARY_PAGES: MediaLink[] = [
  { label: 'Home', href: '/' },
  { label: 'Docs', href: '/docs' },
  { label: 'Playground', href: '/playground' },
  { label: 'About', href: '/about' },
];

export function getSection(path: string): SectionDef | undefined {
  return SECTIONS.find((s) => s.path === path);
}

#!/usr/bin/env bun
/*
- base : https://drowify-music.biz.id (www. 307→apex; core resolves redirects)
- creator : phrzy
- migrated to core/ (spec 003) — ESM, hardened transport, uniform CLI
*/

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

const site = createSite({ base: 'https://drowify-music.biz.id', rateMs: 500 });
const { fetchPage, postAjax, isValidUrl } = site;

interface JsonResp { [k: string]: unknown }

async function get(path: string): Promise<JsonResp> {
  return JSON.parse(await fetchPage(path)) as JsonResp;
}

async function post(path: string, body: Record<string, unknown>): Promise<JsonResp> {
  return JSON.parse(await postAjax(path, JSON.stringify(body))) as JsonResp;
}

async function search(q: string): Promise<JsonResp> {
  return get('/api/search?query=' + encodeURIComponent(q) + '&type=all');
}

async function artist(id: string): Promise<JsonResp> {
  return get('/api/artist?id=' + encodeURIComponent(id));
}

async function album(id: string): Promise<JsonResp> {
  return get('/api/album?id=' + encodeURIComponent(id));
}

async function lyrics(id: string, title?: string, artistName?: string): Promise<JsonResp> {
  let path = '/api/lyrics?id=' + encodeURIComponent(id);
  if (title) path += '&title=' + encodeURIComponent(title);
  if (artistName) path += '&artist=' + encodeURIComponent(artistName);
  return get(path);
}

async function suggest(q: string): Promise<JsonResp> {
  return get('/api/suggest?q=' + encodeURIComponent(q));
}

async function audio(input: string): Promise<JsonResp> {
  let url = input;
  if (!/^https?:\/\//i.test(input)) {
    url = 'https://youtube.com/watch?v=' + input;
  }
  // input becomes a body value, never a fetch target — no guard implications
  return post('/api/ytplay', { query: url });
}

if (import.meta.main) {
  defineCli({
    name: 'drowify',
    title: 'Drowify Music Scraper',
    commands: {
      search: { desc: 'Cari lagu, album, playlist & artis', usage: '<query>', run: async (p) => { if (!p[0]) throw new Error('Query required'); return search(p[0]); } },
      artist: { desc: 'Detail artis', usage: '<channelId>', run: async (p) => { if (!p[0]) throw new Error('channelId required'); return artist(p[0]); } },
      album: { desc: 'Detail album / playlist + lagu', usage: '<browseId>', run: async (p) => { if (!p[0]) throw new Error('browseId required'); return album(p[0]); } },
      lyrics: { desc: 'Lirik lagu (tersinkronisasi)', usage: '<videoId> [judul] [artis]', run: async (p) => { if (!p[0]) throw new Error('videoId required'); return lyrics(p[0], p[1], p[2]); } },
      suggest: { desc: 'Suggestion autocomplete', usage: '<q>', run: async (p) => { if (!p[0]) throw new Error('Query required'); return suggest(p[0]); } },
      audio: { desc: 'Link audio / unduhan langsung', usage: '<videoId|youtubeUrl>', run: async (p) => { if (!p[0]) throw new Error('videoId or URL required'); return audio(p[0]); } },
    },
    examples: `  bun drowify.ts search "dangdut koplo"
  bun drowify.ts lyrics bAoxY1jQnqo "bergema sampai selamanya" "Nadhif Basalamah"
  bun drowify.ts audio bAoxY1jQnqo`,
  });
}

void isValidUrl;

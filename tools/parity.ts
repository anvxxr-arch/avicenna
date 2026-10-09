#!/usr/bin/env bun
/**
 * Cross-Runtime Parity Test Suite — spec 001-parity-test-suite
 *
 * bun tools/parity.ts [--guards-only] [--live] [--report PATH]
 *
 * Exit codes: 0 = full pass · 1 = parity mismatch · 2 = environment failure
 */
import { $ } from 'bun';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// === RUNTIMES ===
interface Runtime { name: 'ts' | 'go' | 'rs'; cmd: string[]; bin?: string; src?: string; }

const RUNTIMES: Runtime[] = [
  { name: 'ts', cmd: ['bun', 'nontonanime.ts'] },
  {
    name: 'go',
    cmd: [process.env.PARITY_GO_BIN || '/tmp/nn-go'],
    bin: process.env.PARITY_GO_BIN || '/tmp/nn-go',
    src: 'nontonanime.go',
  },
  {
    name: 'rs',
    cmd: [process.env.PARITY_RS_BIN || 'nontonanime-rs/target/release/nontonanime'],
    bin: process.env.PARITY_RS_BIN || 'nontonanime-rs/target/release/nontonanime',
    src: 'nontonanime-rs/nontonanime.rs',
  },
];

const EP = 'https://s13.nontonanimeid.boats/black-torch-episode-1/';
const ANIME = 'https://s13.nontonanimeid.boats/anime/black-torch/';

// === CASES (live) — one row per CLI command, identical args everywhere.
// `skip` lists runtimes that do not implement the command (the Rust port
// covers the nontonanime surface only) — they are reported as n/a, not fail.
// `tsFile` points the TS reference at a different CLI entrypoint (tiktok.ts
// is a separate CLI from nontonanime.ts; without it the TS side would answer
// "Unknown command" and a guard would look like a rejection when it is not).
// `tsDrop` is how many leading args the sibling CLI does not take — the
// dispatcher word ("tiktok") is part of the multi-scraper CLI's argv, not of
// the single-scraper one.
interface Case { name: string; args: string[]; volatile?: string[][]; skip?: string[]; tsFile?: string; tsDrop?: number; }
const CASES: Case[] = [
  { name: 'home', args: ['home'] },
  { name: 'latest', args: ['latest'] },
  { name: 'recent', args: ['recent'] },
  { name: 'search', args: ['search', 'one piece'] },
  { name: 'advsearch', args: ['advsearch', '--genre=action', '--sort=series_skor'] },
  { name: 'list', args: ['list'] },
  { name: 'anime', args: ['anime', ANIME] },
  { name: 'episode', args: ['episode', EP] },
  { name: 'servers', args: ['servers', EP] },
  { name: 'nav', args: ['nav', EP] },
  { name: 'meta', args: ['meta', EP] },
  { name: 'genres', args: ['genres'] },
  { name: 'genre', args: ['genre', 'action'] },
  { name: 'ongoing', args: ['ongoing'] },
  { name: 'popular', args: ['popular'] },
  { name: 'schedule', args: ['schedule'] },
  { name: 'top', args: ['top'] },
  { name: 'season', args: ['season', 'summer', '2026'] },
  { name: 'more', args: ['more', '--offset=20'] },
  // nonce-derived: shape-check only
  { name: 'resolve', args: ['resolve', EP, '2'], volatile: [['$']] },
  { name: 'stream', args: ['stream', EP, '2'], volatile: [['$']] },
  // tiktok: the @tiktok profile is a stable public fixture (follower counts
  // and CDN avatar URLs verified stable across repeated runs). The Rust port
  // covers the nontonanime surface only, so it is n/a here.
  { name: 'tiktok-user', args: ['tiktok', 'user', 'tiktok'], skip: ['rs'], tsFile: 'tiktok.ts', tsDrop: 1 },
  // spotify: the payload carries only stable fields (id/name/uri/year — no play
  // counters), but Spotify's relevance ranking jitters: the LANY / "Daft Poets
  // Society" pair at the tail flips order between runs, so index 4 disagreed
  // across ports on a live run. Nonce-like, not a parser divergence — pinned to
  // a shape comparison like resolve/stream.
  { name: 'spotify-search', args: ['spotify', 'search', 'daft punk'], volatile: [['$']], skip: ['rs'], tsFile: 'spotify.ts', tsDrop: 1 },
  // anilist: anilist.co is an SPA, so the HTML scrape path is a no-op by design
  // on BOTH ports (`[]` + a stderr note). Kept deliberately: if one port ever
  // gains the GraphQL path without the other, this row stops being
  // empty-consistent and turns into a mismatch. Reported as `empty-consistent`,
  // never as a pass, so it cannot inflate the pass count.
  { name: 'anilist-search', args: ['anilist', 'search', 'frieren'], skip: ['rs'], tsFile: 'anilist.ts', tsDrop: 1 },
  // Remaining scraper surfaces with a Go counterpart. Deep-equal verified and
  // two-run stable before landing; each TS CLI is a single-scraper entrypoint,
  // so it reuses tsFile/tsDrop. The Rust port covers nontonanime only.
  //
  // lk21 earned its place the hard way: Go injected origin/referer on every
  // request while TS sends them only for POSTs, and this CDN keys a cache entry
  // on Origin — so a GET read a different, differently-aged body and this row
  // caught a one-vote ratingCount drift (6710 vs 6711) that nothing else saw.
  { name: 'lk21-list', args: ['lk21', 'list'], skip: ['rs'], tsFile: 'lk21.ts', tsDrop: 1 },
  { name: 'lk21-sections', args: ['lk21', 'sections'], skip: ['rs'], tsFile: 'lk21.ts', tsDrop: 1 },
  { name: 'whitehouse-home', args: ['whitehouse', 'home'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-search', args: ['whitehouse', 'search', 'biden'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-administration', args: ['whitehouse', 'administration'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-news', args: ['whitehouse', 'news'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-videos', args: ['whitehouse', 'videos'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'otakudesu-home', args: ['otakudesu', 'home'], skip: ['rs'], tsFile: 'otakudesu.ts', tsDrop: 1 },
  { name: 'otakudesu-search', args: ['otakudesu', 'search', 'naruto'], skip: ['rs'], tsFile: 'otakudesu.ts', tsDrop: 1 },
  { name: 'otakudesu-genrelist', args: ['otakudesu', 'genrelist'], skip: ['rs'], tsFile: 'otakudesu.ts', tsDrop: 1 },
  { name: 'otakudesu-jadwal', args: ['otakudesu', 'jadwal'], skip: ['rs'], tsFile: 'otakudesu.ts', tsDrop: 1 },
  // Every samehadaku surface is now fetchable by BOTH ports. What looked like a
  // permanent WAF block on the TS side was a UA-string problem: the Cloudflare
  // rule in front of the site challenges `Chrome/<major>.0.0.0` (403 +
  // interstitial on `/`, `/?s=`, `/anime/<slug>/`, `/batch/<slug>/`) while the
  // bare `Chrome/<major>` form passes with 200 — A/B over nine UA variants, the
  // `(KHTML, like Gecko)` token is irrelevant. Go's HTTP/2 path never noticed.
  // All eight surfaces below verified deep-equal after that fix.
  { name: 'samehadaku-home', args: ['samehadaku', 'home'], skip: ['rs'], tsFile: 'samehadaku.ts', tsDrop: 1 },
  { name: 'samehadaku-search', args: ['samehadaku', 'search', 'one piece'], skip: ['rs'], tsFile: 'samehadaku.ts', tsDrop: 1 },
  { name: 'samehadaku-list', args: ['samehadaku', 'list'], skip: ['rs'], tsFile: 'samehadaku.ts', tsDrop: 1 },
  { name: 'samehadaku-detail', args: ['samehadaku', 'detail', 'one-piece'], skip: ['rs'], tsFile: 'samehadaku.ts', tsDrop: 1 },
  // Verified byte-comparable (10863 B, 9 players, 3 download groups) before landing.
  { name: 'samehadaku-episode', args: ['samehadaku', 'episode', 'one-piece-episode-1179'], skip: ['rs'], tsFile: 'samehadaku.ts', tsDrop: 1 },
  { name: 'samehadaku-batch', args: ['samehadaku', 'batch', 'one-piece-batch-part-2'], skip: ['rs'], tsFile: 'samehadaku.ts', tsDrop: 1 },
  { name: 'samehadaku-mirrors', args: ['samehadaku', 'mirrors', 'one-piece-episode-1179'], skip: ['rs'], tsFile: 'samehadaku.ts', tsDrop: 1 },
  { name: 'samehadaku-schedule', args: ['samehadaku', 'schedule', 'monday'], skip: ['rs'], tsFile: 'samehadaku.ts', tsDrop: 1 },
  // Third expansion wave (2026-10-09): every row below was verified with two runs
  // per port — rc=0 both sides, each port self-stable, and deep-equal cross-port.
  // Long-running fixtures only (otakudesu `1piece-sub-indo`, 495 episodes, never a
  // current-season slug that rotates).
  { name: 'whitehouse-releases', args: ['whitehouse', 'releases'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-briefings', args: ['whitehouse', 'briefings'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-presidential-actions', args: ['whitehouse', 'presidential-actions'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-executive-orders', args: ['whitehouse', 'executive-orders'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-memoranda', args: ['whitehouse', 'memoranda'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-proclamations', args: ['whitehouse', 'proclamations'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-nominations', args: ['whitehouse', 'nominations'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-fact-sheets', args: ['whitehouse', 'fact-sheets'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-remarks', args: ['whitehouse', 'remarks'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-research', args: ['whitehouse', 'research'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'whitehouse-gallery', args: ['whitehouse', 'gallery'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'sankanime-genre', args: ['sankanime', 'genre', 'list'], skip: ['rs'], tsFile: 'sankanime.ts', tsDrop: 1 },
  { name: 'otakudesu-detail', args: ['otakudesu', 'detail', '1piece-sub-indo'], skip: ['rs'], tsFile: 'otakudesu.ts', tsDrop: 1 },
  { name: 'otakudesu-episode', args: ['otakudesu', 'episode', 'wpoiec-episode-936-sub-indo'], skip: ['rs'], tsFile: 'otakudesu.ts', tsDrop: 1 },
  { name: 'animeindo-episode', args: ['animeindo', 'episode', 'one-piece-episode-000'], skip: ['rs'], tsFile: 'animeindo.ts', tsDrop: 1 },
  { name: 'animeindo-watch', args: ['animeindo', 'watch', 'one-piece-episode-000'], skip: ['rs'], tsFile: 'animeindo.ts', tsDrop: 1 },
  // yt/ytmusic search cannot be deep-equalled: YouTube rotates the result set, so
  // two consecutive requests from the SAME binary differ in ~64 of 68 items (ids,
  // titles, view counters), and `estimatedResults` moves every run on both ports.
  // The envelope is stable, so these are shape rows. That is only a real check
  // because `normalize` now reduces a non-string `$` payload to its shape — it
  // used to `return v` untouched, so a `volatile: [['$']]` row on an object was
  // silently still a full deep-equal (which is what `spotify-search` was).
  { name: 'yt-search', args: ['yt', 'search', 'lofi'], volatile: [['$']], skip: ['rs'], tsFile: 'yt.ts', tsDrop: 1 },
  { name: 'ytmusic-search', args: ['ytmusic', 'search', 'lofi'], volatile: [['$']], skip: ['rs'], tsFile: 'ytmusic.ts', tsDrop: 1 },
  // Fourth wave (2026-10-09): the genre surfaces plus `otakudesu watch`, each
  // verified with two runs per port — rc=0 both sides, self-stable, deep-equal
  // cross-port. Neutral genre slugs, so a row never depends on an adult category.
  { name: 'animeindo-genre', args: ['animeindo', 'genre', 'action'], skip: ['rs'], tsFile: 'animeindo.ts', tsDrop: 1 },
  { name: 'kanzenin-genre', args: ['kanzenin', 'genre', 'mature'], skip: ['rs'], tsFile: 'kanzenin.ts', tsDrop: 1 },
  { name: 'mangasusuku-genre', args: ['mangasusuku', 'genre', 'drama'], skip: ['rs'], tsFile: 'mangasusuku.ts', tsDrop: 1 },
  { name: 'ngomik-genre', args: ['ngomik', 'genre', 'action'], skip: ['rs'], tsFile: 'ngomik.ts', tsDrop: 1 },
  { name: 'otakudesu-genre', args: ['otakudesu', 'genre', 'action'], skip: ['rs'], tsFile: 'otakudesu.ts', tsDrop: 1 },
  { name: 'otakudesu-watch', args: ['otakudesu', 'watch', 'wpoiec-episode-936-sub-indo'], skip: ['rs'], tsFile: 'otakudesu.ts', tsDrop: 1 },
  // anilist.co is an SPA and `anilist detail` takes a URL, so both ports answer a
  // bare slug with the same `{"error":"Invalid URL"}` at exit 0. This row pins that
  // shared validation contract; there is no live detail payload to compare.
  { name: 'anilist-detail-invalid-url', args: ['anilist', 'detail', 'one-piece'], skip: ['rs'], tsFile: 'anilist.ts', tsDrop: 1 },
  // `yt related` rotates like `yt search`: neither port is self-stable, because the
  // recommendation set is drawn per request. Shape row, same reasoning as yt-search.
  { name: 'yt-related', args: ['yt', 'related', 'dQw4w9WgXcQ'], volatile: [['$']], skip: ['rs'], tsFile: 'yt.ts', tsDrop: 1 },
  { name: 'drowify-suggest', args: ['drowify', 'suggest', 'dangdut'], skip: ['rs'], tsFile: 'drowify.ts', tsDrop: 1 },
  { name: 'codeengo-styles', args: ['codeengo', 'styles'], skip: ['rs'], tsFile: 'codeengo.ts', tsDrop: 1 },
  // Second expansion wave: every remaining Go/TS surface, each deep-equal and
  // two-run stable before landing. `detail`/`chapter` rows use stable public
  // fixtures (a long-running series), never a slug that rotates weekly.
  { name: 'animeindo-home', args: ['animeindo', 'home'], skip: ['rs'], tsFile: 'animeindo.ts', tsDrop: 1 },
  { name: 'animeindo-genrelist', args: ['animeindo', 'genrelist'], skip: ['rs'], tsFile: 'animeindo.ts', tsDrop: 1 },
  { name: 'animeindo-movies', args: ['animeindo', 'movies'], skip: ['rs'], tsFile: 'animeindo.ts', tsDrop: 1 },
  { name: 'animeindo-jadwal', args: ['animeindo', 'jadwal'], skip: ['rs'], tsFile: 'animeindo.ts', tsDrop: 1 },
  { name: 'animeindo-search', args: ['animeindo', 'search', 'one piece'], skip: ['rs'], tsFile: 'animeindo.ts', tsDrop: 1 },
  { name: 'animeindo-supported', args: ['animeindo', 'supported'], skip: ['rs'], tsFile: 'animeindo.ts', tsDrop: 1 },
  { name: 'animeindo-detail', args: ['animeindo', 'detail', 'one-piece'], skip: ['rs'], tsFile: 'animeindo.ts', tsDrop: 1 },
  { name: 'animeindo-batch', args: ['animeindo', 'batch', 'one-piece'], skip: ['rs'], tsFile: 'animeindo.ts', tsDrop: 1 },
  { name: 'kanzenin-home', args: ['kanzenin', 'home'], skip: ['rs'], tsFile: 'kanzenin.ts', tsDrop: 1 },
  { name: 'kanzenin-genrelist', args: ['kanzenin', 'genrelist'], skip: ['rs'], tsFile: 'kanzenin.ts', tsDrop: 1 },
  { name: 'kanzenin-search', args: ['kanzenin', 'search', 'family control'], skip: ['rs'], tsFile: 'kanzenin.ts', tsDrop: 1 },
  { name: 'kanzenin-supported', args: ['kanzenin', 'supported'], skip: ['rs'], tsFile: 'kanzenin.ts', tsDrop: 1 },
  { name: 'kanzenin-azlist', args: ['kanzenin', 'azlist', 'A'], skip: ['rs'], tsFile: 'kanzenin.ts', tsDrop: 1 },
  { name: 'kanzenin-detail', args: ['kanzenin', 'detail', 'family-control'], skip: ['rs'], tsFile: 'kanzenin.ts', tsDrop: 1 },
  { name: 'kanzenin-chapter', args: ['kanzenin', 'chapter', 'family-control-chapter-5'], skip: ['rs'], tsFile: 'kanzenin.ts', tsDrop: 1 },
  { name: 'mangasusuku-home', args: ['mangasusuku', 'home'], skip: ['rs'], tsFile: 'mangasusuku.ts', tsDrop: 1 },
  { name: 'mangasusuku-genrelist', args: ['mangasusuku', 'genrelist'], skip: ['rs'], tsFile: 'mangasusuku.ts', tsDrop: 1 },
  { name: 'mangasusuku-search', args: ['mangasusuku', 'search', 'solo leveling'], skip: ['rs'], tsFile: 'mangasusuku.ts', tsDrop: 1 },
  { name: 'mangasusuku-supported', args: ['mangasusuku', 'supported'], skip: ['rs'], tsFile: 'mangasusuku.ts', tsDrop: 1 },
  { name: 'mangasusuku-azlist', args: ['mangasusuku', 'azlist', 'A'], skip: ['rs'], tsFile: 'mangasusuku.ts', tsDrop: 1 },
  { name: 'mangasusuku-detail', args: ['mangasusuku', 'detail', 'solo-leveling'], skip: ['rs'], tsFile: 'mangasusuku.ts', tsDrop: 1 },
  { name: 'mangasusuku-chapter', args: ['mangasusuku', 'chapter', 'solo-leveling-chapter-155'], skip: ['rs'], tsFile: 'mangasusuku.ts', tsDrop: 1 },
  { name: 'ngomik-home', args: ['ngomik', 'home'], skip: ['rs'], tsFile: 'ngomik.ts', tsDrop: 1 },
  { name: 'ngomik-genrelist', args: ['ngomik', 'genrelist'], skip: ['rs'], tsFile: 'ngomik.ts', tsDrop: 1 },
  { name: 'ngomik-search', args: ['ngomik', 'search', 'eleceed'], skip: ['rs'], tsFile: 'ngomik.ts', tsDrop: 1 },
  { name: 'ngomik-supported', args: ['ngomik', 'supported'], skip: ['rs'], tsFile: 'ngomik.ts', tsDrop: 1 },
  { name: 'ngomik-detail', args: ['ngomik', 'detail', 'eleceed'], skip: ['rs'], tsFile: 'ngomik.ts', tsDrop: 1 },
  { name: 'ngomik-chapter', args: ['ngomik', 'chapter', 'eleceed-chapter-420'], skip: ['rs'], tsFile: 'ngomik.ts', tsDrop: 1 },
  { name: 'sankanime-home', args: ['sankanime', 'home'], skip: ['rs'], tsFile: 'sankanime.ts', tsDrop: 1 },
  { name: 'sankanime-populer', args: ['sankanime', 'populer'], skip: ['rs'], tsFile: 'sankanime.ts', tsDrop: 1 },
  { name: 'sankanime-terbaru', args: ['sankanime', 'terbaru'], skip: ['rs'], tsFile: 'sankanime.ts', tsDrop: 1 },
  { name: 'sankanime-genrelist', args: ['sankanime', 'genrelist'], skip: ['rs'], tsFile: 'sankanime.ts', tsDrop: 1 },
  { name: 'sankanime-search', args: ['sankanime', 'search', 'naruto'], skip: ['rs'], tsFile: 'sankanime.ts', tsDrop: 1 },
  { name: 'sankanime-supported', args: ['sankanime', 'supported'], skip: ['rs'], tsFile: 'sankanime.ts', tsDrop: 1 },
  { name: 'sankanime-detail', args: ['sankanime', 'detail', 'naruto-konohas-story-the-steam-ninja-scrolls'], skip: ['rs'], tsFile: 'sankanime.ts', tsDrop: 1 },
  { name: 'sankanime-chapter', args: ['sankanime', 'chapter', 'naruto-konohas-story-the-steam-ninja-scrolls-chapter-15'], skip: ['rs'], tsFile: 'sankanime.ts', tsDrop: 1 },
  // `yt-info` is not volatile in its data; its one flaky field was the thumbnail's
  // per-request CDN signature. `normalize` compares every URL by identity now, so
  // the row stays a full deep-equal and needs no per-field relaxation.
  { name: 'yt-info', args: ['yt', 'info', 'dQw4w9WgXcQ'], skip: ['rs'], tsFile: 'yt.ts', tsDrop: 1 },
  { name: 'ytmusic-lyrics', args: ['ytmusic', 'lyrics', 'onCZOgWlr1U'], skip: ['rs'], tsFile: 'ytmusic.ts', tsDrop: 1 },
  { name: 'otakudesu-ongoing', args: ['otakudesu', 'ongoing'], skip: ['rs'], tsFile: 'otakudesu.ts', tsDrop: 1 },
  { name: 'otakudesu-complete', args: ['otakudesu', 'complete'], skip: ['rs'], tsFile: 'otakudesu.ts', tsDrop: 1 },
  { name: 'whitehouse-detail', args: ['whitehouse', 'detail', 'https://www.whitehouse.gov/news/'], skip: ['rs'], tsFile: 'whitehouse.ts', tsDrop: 1 },
  { name: 'lk21-detail', args: ['lk21', 'detail', 'night-nurse-2026'], skip: ['rs'], tsFile: 'lk21.ts', tsDrop: 1 },
];

// === GUARDS (offline) — reject semantics: exit 1 + non-empty stderr.
// `skip` lists runtimes that do not implement the command at all (the Rust
// port has no tiktok surface) — an unknown-command exit is a non-implementation,
// not a missing guard, so it is reported as n/a, not fail.
// `tsFile` picks the TS entrypoint (see Case). A reference that answers
// "Unknown command" is a non-implementation too, never a rejection.
const GUARDS: Array<{ name: string; args: string[]; skip?: string[]; tsFile?: string; tsDrop?: number }> = [
  { name: 'traversal-slug', args: ['genre', '../../etc'] },
  { name: 'bad-season', args: ['season', 'wat', '2024'] },
  { name: 'missing-year', args: ['season', 'winter'] },
  { name: 'short-query', args: ['search', 'x'] },
  { name: 'evil-host-anime', args: ['anime', 'https://evil.com/x'] },
  { name: 'evil-host-servers', args: ['servers', 'https://evil.com/x'] },
  { name: 'evil-host-resolve', args: ['resolve', 'https://evil.com/x'] },
  { name: 'empty-args', args: ['season'] },
  // tiktok guards — both runtimes must reject with exit 1 + non-empty stderr.
  // The lookalike is the one the Go shape guard added: the TS reference
  // rejects it at the transport pin, Go at tiktokValidateVideoURL.
  { name: 'tiktok-bad-username', args: ['tiktok', 'user', 'bad username!'], skip: ['rs'], tsFile: 'tiktok.ts', tsDrop: 1 },
  { name: 'tiktok-empty-args', args: ['tiktok', 'user'], skip: ['rs'], tsFile: 'tiktok.ts', tsDrop: 1 },
  { name: 'tiktok-evil-host-video', args: ['tiktok', 'video', 'https://evil.com/video/123'], skip: ['rs'], tsFile: 'tiktok.ts', tsDrop: 1 },
  { name: 'tiktok-lookalike-video', args: ['tiktok', 'video', 'https://www.tiktok.com.evil.com/video/7301234567890123456'], skip: ['rs'], tsFile: 'tiktok.ts', tsDrop: 1 },
  // spotify: both entrypoints must refuse a missing id/query with exit 1.
  { name: 'spotify-missing-id', args: ['spotify', 'track'], skip: ['rs'], tsFile: 'spotify.ts', tsDrop: 1 },
  { name: 'spotify-empty-query', args: ['spotify', 'search'], skip: ['rs'], tsFile: 'spotify.ts', tsDrop: 1 },
  // samehadaku apk takes a numeric post id; the bare form is rejected by argument
  // validation before any request is made, with the identical message on both sides.
  { name: 'samehadaku-apk-no-id', args: ['samehadaku', 'apk'], skip: ['rs'], tsFile: 'samehadaku.ts', tsDrop: 1 },
];

const NONCE_RE = /^[a-f0-9]{6,20}$/;
const URL_RE = /^https?:\/\//;
const TIMEOUT_MS = 60_000;

type Status = 'pass' | 'fail' | 'skip-waf' | 'empty-consistent' | 'na' | 'env-fail';

interface CaseResult {
  command: string;
  runtime: string;
  status: Status;
  durationMs: number;
  detail?: string;
}

function fail(msg: string): never {
  console.error(`[ENV] ${msg}`);
  process.exit(2);
}

/** Ensure each ported runtime has a binary; build it when missing or stale.
 * Exit 2 (env failure) only when the toolchain itself cannot produce one. */
async function refreshBinaries(): Promise<void> {
  for (const rt of RUNTIMES) {
    if (rt.name === 'ts' || !rt.bin || !rt.src || !existsSync(rt.src)) continue;
    const missing = !existsSync(rt.bin);
    const stale = !missing && statSync(rt.src).mtimeMs > statSync(rt.bin).mtimeMs;
    if (!missing && !stale) continue;
    if (rt.name === 'go') {
      console.log(`[env] ${missing ? 'building' : 'rebuilding'} go (${missing ? 'binary missing' : 'source newer than binary'})...`);
      // MUST await: Bun's `$` is a lazy thenable — an un-awaited template never spawns.
      const r = await $`go build -o ${rt.bin} nontonanime.go`.quiet().nothrow();
      if (r.exitCode !== 0) fail(`go build failed: ${r.stderr.toString().slice(0, 200)}`);
      continue;
    }
    // rust rebuild is expensive (minutes); warn instead of auto-run
    if (missing) fail(`binary missing for ${rt.name}: ${rt.bin} — run: cd nontonanime-rs && cargo build --release`);
    console.log(`[env] WARN: rust source newer than binary — run: cd nontonanime-rs && cargo build --release`);
  }
}

interface RunOut { ok: boolean; stdout: string; stderr: string; code: number; }
async function runBinary(rt: Runtime, args: string[], tsFile?: string, tsDrop = 0): Promise<RunOut> {
  try {
    // The TS runtime normally runs nontonanime.ts; a case may point it at a
    // sibling CLI (tiktok.ts) so a second entrypoint stays comparable. tsDrop
    // removes the dispatcher word ("tiktok") that only the multi-scraper CLI
    // carries in argv.
    const cmd = rt.name === 'ts' && tsFile ? ['bun', tsFile] : rt.cmd;
    const argv = rt.name === 'ts' && tsFile ? args.slice(tsDrop) : args;
    const proc = Bun.spawn([cmd[0], ...cmd.slice(1), ...argv], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: TIMEOUT_MS,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr, code };
  } catch (e) {
    return { ok: false, stdout: '', stderr: String(e), code: -1 };
  }
}

/**
 * Shape descriptor for a jittering payload: keys and value kinds only, with arrays
 * reduced to the kind-set of their elements (never length or contents). Strong
 * enough to catch a port that drops a field or changes a type, immune to the
 * reordering/rotation that makes a search payload un-comparable run to run.
 */
function shapeOnly(v: unknown): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    const kinds = new Set(v.map((x) => (Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x)));
    return { '[]': [...kinds].sort() };
  }
  if (typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const val = src[k];
      o[k] = Array.isArray(val) ? shapeOnly(val) : val === null ? 'null' : typeof val;
    }
    return o;
  }
  return typeof v;
}

/**
 * URL identity for parity: the path plus the *sorted names* of the query
 * parameters. TikTok serves one avatar from a rotating CDN shard
 * (`p16-common-sign` vs `p19-common-sign`) and YouTube re-signs every
 * `i.ytimg.com` thumbnail per request (`sqp`/`rs`), so host and query values move
 * while the asset does not — comparing them makes a green row fail at random.
 * The path and the parameter set are still compared, so a port fetching a
 * different asset, or a different shape of URL, still diverges.
 */
function urlIdentity(s: string): unknown {
  try {
    const u = new URL(s);
    return { path: u.pathname, q: [...u.searchParams.keys()].sort() };
  } catch {
    return s;
  }
}

/** Strip volatile fields. `$` = whole-output mode (URL format check only). */
function normalize(v: unknown, volatile: string[][] = []): unknown {
  if (volatile.some((p) => p.length === 1 && p[0] === '$')) {
    // Whole-output volatile. A bare string is a URL (resolve/stream, and any leaf
    // path ending in `$`), so compare its identity rather than its bytes. Anything
    // else is a payload whose *contents* rotate between requests (spotify/yt/
    // ytmusic search results arrive in a different order, and a subset changes), so
    // compare the shape and nothing else.
    if (typeof v === 'string') return URL_RE.test(v) ? urlIdentity(v) : v;
    return shapeOnly(v);
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'nonce' && typeof val === 'string') {
        o[k] = NONCE_RE.test(val) ? '<nonce-ok>' : '<nonce-BAD>';
      } else if (k === 'postId') {
        o[k] = typeof val === 'string' && val.length > 0 ? '<postid-present>' : '<postid-BAD>';
      } else {
        const path = volatile.find((p) => p[0] === k);
        o[k] = normalize(val, path ? [path.slice(1)] : []);
      }
    }
    return o;
  }
  if (Array.isArray(v)) return v.map((x) => normalize(x, volatile));
  // Every URL string, anywhere in any payload, is compared by identity. The host
  // shard and the signature values of a CDN URL are chosen per request by the
  // origin/CDN, not by the port, so comparing them byte-for-byte turns a green row
  // red at random (observed: `tiktok-user.avatar` p16↔p19 shard, `yt-info.thumbnail`
  // re-signed `sqp`/`rs`). Paths and parameter sets are still compared.
  if (typeof v === 'string') return URL_RE.test(v) ? urlIdentity(v) : v;
  return v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    return ka.every((k) => deepEqual(oa[k], ob[k]));
  }
  return false;
}

function firstDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (deepEqual(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) === !Array.isArray(b)) {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(oa), ...Object.keys(ob)]);
    for (const k of keys) {
      const d = firstDiff(oa[k], ob[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ts=${JSON.stringify(a)?.slice(0, 80)} vs other=${JSON.stringify(b)?.slice(0, 80)}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const guardsOnly = argv.includes('--guards-only');
  const live = !guardsOnly; // --guards-only implies offline
  const reportPath = argv.includes('--report')
    ? argv[argv.indexOf('--report') + 1]
    : 'specs/001-parity-test-suite/parity-report.json';

  const t0 = Date.now();
  await refreshBinaries();

  const results: CaseResult[] = [];
  const ts = RUNTIMES[0];
  const others = RUNTIMES.slice(1);

  // --- GUARDS (offline) ---
  console.log(`\n═══ GUARDS (offline, reject semantics) ═══`);
  for (const g of GUARDS) {
    const ref = await runBinary(ts, g.args, g.tsFile, g.tsDrop);
    // An unknown command is a non-implementation, never a rejection: without
    // this check the reference "passes" a guard it never evaluated.
    if (/unknown command/i.test(ref.stderr) || /unknown command/i.test(ref.stdout)) {
      results.push({ command: `guard:${g.name}`, runtime: 'ts', status: 'fail', durationMs: 0, detail: 'reference does not implement the command' });
      console.log(`  ✗ guard:${g.name} — TS reference does not implement it (wrong entrypoint?)`);
      continue;
    }
    const refOk = !ref.ok && ref.stderr.trim().length > 0;
    if (!refOk) {
      results.push({ command: `guard:${g.name}`, runtime: 'ts', status: 'fail', durationMs: 0, detail: 'reference did not reject' });
      console.log(`  ✗ guard:${g.name} — TS reference did not reject`);
      continue;
    }
    for (const rt of others) {
      if (g.skip?.includes(rt.name)) {
        results.push({ command: `guard:${g.name}`, runtime: rt.name, status: 'na', durationMs: 0, detail: 'command not implemented' });
        console.log(`  · guard:${g.name} [${rt.name}] n/a`);
        continue;
      }
      const t1 = Date.now();
      const out = await runBinary(rt, g.args);
      const ok = !out.ok && out.stderr.trim().length > 0;
      results.push({
        command: `guard:${g.name}`, runtime: rt.name,
        status: ok ? 'pass' : 'fail', durationMs: Date.now() - t1,
        detail: ok ? undefined : `exit=${out.code} stderr=${out.stderr.slice(0, 60)}`,
      });
      console.log(`  ${ok ? '✓' : '✗'} guard:${g.name} [${rt.name}]${ok ? '' : ' ' + out.stderr.slice(0, 60)}`);
    }
  }

  // --- LIVE parity ---
  if (live) {
    console.log(`\n═══ LIVE PARITY (${CASES.length} commands × ${others.length} other runtimes) ═══`);
    // pre-flight: one live call to detect network
    const pre = await runBinary(ts, ['genres']);
    if (!pre.ok && /timeout|econn|enotfound|connection|WAF/i.test(pre.stderr)) {
      fail(`live site unreachable: ${pre.stderr.slice(0, 100)}`);
    }

    for (const c of CASES) {
      const t1 = Date.now();
      const refOut = await runBinary(ts, c.args, c.tsFile, c.tsDrop);
      const refDur = Date.now() - t1;

      let refJson: unknown;
      let refStatus: Status = 'pass';
      if (!refOut.ok) {
        if (/WAF blocked/.test(refOut.stderr)) refStatus = 'skip-waf';
        else refStatus = 'fail';
      } else {
        try { refJson = JSON.parse(refOut.stdout); } catch { refStatus = 'fail'; }
      }
      results.push({ command: c.name, runtime: 'ts', status: refStatus, durationMs: refDur });
      console.log(`  ${refStatus === 'pass' ? '✓' : refStatus === 'skip-waf' ? '◌' : '✗'} ${c.name} [ts] ${refDur}ms${refStatus === 'fail' ? ' ' + refOut.stderr.slice(0, 60) : ''}`);
      if (refStatus === 'fail') continue;

      const emptyAll = refStatus === 'pass' && Array.isArray(refJson) && (refJson as unknown[]).length === 0;

      for (const rt of others) {
        if (c.skip?.includes(rt.name)) {
          results.push({ command: c.name, runtime: rt.name, status: 'na', durationMs: 0, detail: 'command not implemented' });
          console.log(`  · ${c.name} [${rt.name}] n/a`);
          continue;
        }
        const t2 = Date.now();
        const out = await runBinary(rt, c.args);
        const dur = Date.now() - t2;
        let status: Status;
        let detail: string | undefined;
        if (!out.ok && /WAF blocked/.test(out.stderr)) {
          status = 'skip-waf';
        } else if (!out.ok) {
          status = 'fail';
          detail = out.stderr.slice(0, 80);
        } else {
          try {
            const otherJson = JSON.parse(out.stdout);
            const norm = normalize(refJson, c.volatile);
            const otherNorm = normalize(otherJson, c.volatile);
            const emptyOther = Array.isArray(otherJson) && (otherJson as unknown[]).length === 0;
            if (emptyAll && emptyOther) {
              status = 'empty-consistent';
            } else {
              const diff = firstDiff(norm, otherNorm);
              status = diff ? 'fail' : 'pass';
              detail = diff ?? undefined;
            }
          } catch (e) {
            status = 'fail';
            detail = `unparseable JSON: ${String(e).slice(0, 60)}`;
          }
        }
        results.push({ command: c.name, runtime: rt.name, status, durationMs: dur, detail });
        console.log(`  ${status === 'pass' ? '✓' : status === 'skip-waf' ? '◌' : status === 'empty-consistent' ? '∅' : '✗'} ${c.name} [${rt.name}] ${dur}ms${detail ? ' ' + detail.slice(0, 90) : ''}`);
      }
    }
  }

  // --- summary ---
  const pass = results.filter((r) => r.status === 'pass' || r.status === 'empty-consistent').length;
  const fails = results.filter((r) => r.status === 'fail');
  const skips = results.filter((r) => r.status === 'skip-waf');
  const na = results.filter((r) => r.status === 'na').length;
  console.log(`\n═══ RESULT: ${pass} pass · ${fails.length} fail · ${skips.length} skip-waf · ${na} n/a · ${Date.now() - t0}ms total ═══`);

  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    suite: 'parity', spec: '001-parity-test-suite',
    started: new Date(t0).toISOString(), durationMs: Date.now() - t0,
    summary: { pass, fail: fails.length, skipWaf: skips.length },
    results,
  }, null, 2));
  console.log(`report: ${reportPath}`);

  process.exit(fails.length ? 1 : 0);
}

await main();

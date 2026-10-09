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
  // spotify: a search response carries only stable fields (id/name/uri/year —
  // no play counters in this shape), so it is safe as a live row.
  { name: 'spotify-search', args: ['spotify', 'search', 'daft punk'], skip: ['rs'], tsFile: 'spotify.ts', tsDrop: 1 },
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
  { name: 'samehadaku-list', args: ['samehadaku', 'list'], skip: ['rs'], tsFile: 'samehadaku.ts', tsDrop: 1 },
  { name: 'drowify-suggest', args: ['drowify', 'suggest', 'dangdut'], skip: ['rs'], tsFile: 'drowify.ts', tsDrop: 1 },
  { name: 'codeengo-styles', args: ['codeengo', 'styles'], skip: ['rs'], tsFile: 'codeengo.ts', tsDrop: 1 },
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

/** Strip volatile fields. `$` = whole-output mode (URL format check only). */
function normalize(v: unknown, volatile: string[][] = []): unknown {
  if (volatile.some((p) => p.length === 1 && p[0] === '$')) {
    // whole-output volatile: resolve/stream return a bare URL string
    if (typeof v === 'string') return URL_RE.test(v) ? '<url-ok>' : '<url-BAD>';
    return v;
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

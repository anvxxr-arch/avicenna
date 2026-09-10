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

// === CASES (live) — one row per CLI command, identical args everywhere ===
interface Case { name: string; args: string[]; volatile?: string[][]; }
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
];

// === GUARDS (offline) — reject semantics: exit 1 + non-empty stderr ===
const GUARDS: Array<{ name: string; args: string[] }> = [
  { name: 'traversal-slug', args: ['genre', '../../etc'] },
  { name: 'bad-season', args: ['season', 'wat', '2024'] },
  { name: 'missing-year', args: ['season', 'winter'] },
  { name: 'short-query', args: ['search', 'x'] },
  { name: 'evil-host-anime', args: ['anime', 'https://evil.com/x'] },
  { name: 'evil-host-servers', args: ['servers', 'https://evil.com/x'] },
  { name: 'evil-host-resolve', args: ['resolve', 'https://evil.com/x'] },
  { name: 'empty-args', args: ['season'] },
];

const NONCE_RE = /^[a-f0-9]{6,20}$/;
const URL_RE = /^https?:\/\//;
const TIMEOUT_MS = 60_000;

type Status = 'pass' | 'fail' | 'skip-waf' | 'empty-consistent' | 'env-fail';

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

function refreshBinaries(): void {
  for (const rt of RUNTIMES) {
    if (rt.name === 'ts') continue;
    if (!rt.bin || !existsSync(rt.bin)) fail(`binary missing for ${rt.name}: ${rt.bin}`);
    if (rt.src && existsSync(rt.src)) {
      if (statSync(rt.src).mtimeMs > statSync(rt.bin).mtimeMs) {
        console.log(`[env] rebuilding ${rt.name} (source newer than binary)...`);
        if (rt.name === 'go') {
          const r = $`go build -o ${rt.bin} nontonanime.go`.quiet().nothrow();
          void r;
        }
        // rust rebuild is expensive (minutes); warn instead of auto-run
        if (rt.name === 'rs') {
          console.log(`[env] WARN: rust source newer than binary — run: cd nontonanime-rs && cargo build --release`);
        }
      }
    }
  }
}

interface RunOut { ok: boolean; stdout: string; stderr: string; code: number; }
async function runBinary(rt: Runtime, args: string[]): Promise<RunOut> {
  try {
    const proc = Bun.spawn([rt.cmd[0], ...rt.cmd.slice(1), ...args], {
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
  refreshBinaries();

  const results: CaseResult[] = [];
  const ts = RUNTIMES[0];
  const others = RUNTIMES.slice(1);

  // --- GUARDS (offline) ---
  console.log(`\n═══ GUARDS (offline, reject semantics) ═══`);
  for (const g of GUARDS) {
    const ref = await runBinary(ts, g.args);
    const refOk = !ref.ok && ref.stderr.trim().length > 0;
    if (!refOk) {
      results.push({ command: `guard:${g.name}`, runtime: 'ts', status: 'fail', durationMs: 0, detail: 'reference did not reject' });
      console.log(`  ✗ guard:${g.name} — TS reference did not reject`);
      continue;
    }
    for (const rt of others) {
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
    console.log(`\n═══ LIVE PARITY (21 commands × ${others.length} other runtimes) ═══`);
    // pre-flight: one live call to detect network
    const pre = await runBinary(ts, ['genres']);
    if (!pre.ok && /timeout|econn|enotfound|connection|WAF/i.test(pre.stderr)) {
      fail(`live site unreachable: ${pre.stderr.slice(0, 100)}`);
    }

    for (const c of CASES) {
      const t1 = Date.now();
      const refOut = await runBinary(ts, c.args);
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
  console.log(`\n═══ RESULT: ${pass} pass · ${fails.length} fail · ${skips.length} skip-waf · ${Date.now() - t0}ms total ═══`);

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

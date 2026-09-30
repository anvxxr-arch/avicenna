#!/usr/bin/env bun
/**
 * tools/contract.ts — executable per-scraper contract gate (spec 003 acceptance).
 *
 *   bun tools/contract.ts --capture [scraper]   # run each command live, record shape + status
 *   bun tools/contract.ts --check   [scraper]   # re-run, compare; exit 1 on any drift
 *
 * A contract entry records, per command:
 *   - `exit`: 0 (ok) | 1 (error) — the CLI's documented behaviour
 *   - `shape`: recursive key shape of the JSON payload (null when the command failed)
 *   - `errorRe`: for expected failures, a regex the error message must match
 *
 * Shapes are the spec's acceptance unit ("JSON key-shape diff = empty"). Values are
 * intentionally NOT compared: the targets are live sites. Contract files are
 * committed under specs/003-scraper-unification/golden/<scraper>/contract.json.
 */
import { $ } from 'bun';

interface Case {
  /** command + args, e.g. ['search', 'one punch man'] */
  args: string[];
  /** expected exit code */
  exit: 0 | 1;
  /** expected output shape (recursive); only when exit === 0 */
  shape?: unknown;
  /** when exit === 1: regex the stderr must match */
  errorRe?: string;
  /** free-form note (e.g. why a command is expected to fail) */
  note?: string;
}
interface Contract {
  scraper: string;
  capturedAt: string;
  cases: Case[];
}
interface RunResult { exit: number; stdout: string; stderr: string }

const SCRAPERS = [
  'anilist', 'animeindo', 'codeengo', 'drowify', 'freeconvert', 'lk21',
  'otakudesu', 'sakana', 'spotify', 'tiktok', 'view-page-source', 'whitehouse',
  'yt', 'ytmusic',
] as const;

const GOLDEN_DIR = 'specs/003-scraper-unification/golden';

/** Recursive key shape: objects → sorted key map, arrays → union of element shapes. */
function shapeOf(v: unknown): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return ['<empty>'];
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const el of v) {
      const s = shapeOf(el);
      const key = JSON.stringify(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return keys.map((k) => ({ key: k, value: shapeOf(o[k]) }));
  }
  return typeof v;
}

function diffShape(a: unknown, b: unknown, path = '$'): string | null {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja === jb) return null;
  // report the coarsest divergence for readability
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: union size ${a.length} -> ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diffShape(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return `${path}: array shape differs`;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const ka = Object.keys(oa);
    for (const k of ka) {
      const d = diffShape(oa[k], ob[k], `${path}.${k}`);
      if (d) return d;
    }
    return `${path}: key set differs (${ka.join(',')} vs ${Object.keys(ob).join(',')})`;
  }
  return `${path}: ${ja?.slice(0, 60)} -> ${jb?.slice(0, 60)}`;
}

/**
 * The command matrix. Each entry is chosen so it exercises real value: an
 * input that must SUCCEED (shape-recorded) or one that must FAIL cleanly
 * (exit 1 + actionable message).
 */
const MATRIX: Record<string, Array<[string[], string?]>> = {
  anilist: [
    [['populer'], 'anilist.co is a Vue SPA with the GraphQL API disabled server-side'],
    [['search', 'naruto'], 'same SPA/GraphQL limitation'],
  ],
  animeindo: [
    [['genrelist']],
    [['home', '1']],
    [['search', 'one piece']],
    [['detail', 'one-piece']],
    [['supported']],
    [['genre', '../../etc'], 'traversal slug must be rejected'],
  ],
  codeengo: [
    [['styles']],
  ],
  drowify: [
    [['search', 'lofi']],
    [['suggest', 'lofi']],
  ],
  // freeconvert's only command (`compress`) performs a real multi-minute transcode
  // and upload; it is verified manually (see specs/003-scraper-unification/tasks.md)
  // instead of on every contract run. Its CLI surface is covered by `--help`.
  freeconvert: [
    [['help'], undefined],
  ],

  lk21: [
    [['detail', 'uprising-2026']],
    [['detail', 'no-such-film-xyz-404'], 'unknown slug must surface an explicit error'],
  ],
  otakudesu: [
    [['home']],
    [['ongoing', '1']],
    [['genrelist']],
    [['detail', '../etc'], 'traversal slug must be rejected'],
  ],
  sakana: [
    [['models'], 'requires SAKANA_FIREBASE_KEY; the actionable env error is the contract'],
  ],
  spotify: [
    [['home', '--nodetail', '--limit=3']],
    [['search', 'bad habits', '--limit=3']],
    [['track', '6PQ88X9TkUIAUIZJHW2upE']],
  ],
  tiktok: [
    [['user', 'nasa']],
    [['video', 'https://www.tiktok.com/@user/video/1234567890123456789'], 'unknown/rate-limited video returns an error payload'],
    [['video', 'not-a-url'], 'malformed input must be rejected'],
  ],
  'view-page-source': [
    [['token']],
  ],
  whitehouse: [
    [['home']],
    [['news']],
    [['videos']],
    [['search', 'executive order']],
    [['detail', '../etc'], 'traversal must be rejected'],
  ],
  yt: [
    [['search', 'lofi hip hop']],
    [['info', 'dQw4w9WgXcQ']],
    [['related', 'dQw4w9WgXcQ']],
  ],
  ytmusic: [
    [['search', 'lofi', 'songs']],
    [['search', 'lofi']],
    [['lyrics', 'dQw4w9WgXcQ']],
    [['related', 'dQw4w9WgXcQ']],
  ],
};

async function run(scraper: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(['bun', `${scraper}.ts`, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 90_000 });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { exit, stdout, stderr };
}

async function capture(scraper: string): Promise<Contract> {
  const matrix = MATRIX[scraper] ?? [];
  const cases: Case[] = [];
  for (const [args, note] of matrix) {
    const r = await run(scraper, args);
    if (r.exit === 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        // help/usage output is plain text — contract on the documented marker
        if (/Commands:/.test(r.stdout)) parsed = { kind: 'help-text' };
        else throw new Error(`${scraper} ${args.join(' ')}: exit 0 but stdout is neither JSON nor help text:\n${r.stdout.slice(0, 200)}`);
      }
      cases.push({ args, exit: 0, shape: shapeOf(parsed), note });
    } else {
      if (!r.stderr.trim()) throw new Error(`${scraper} ${args.join(' ')}: exit 1 with empty stderr`);
      cases.push({ args, exit: 1, errorRe: /\[ERROR\]/.source, note });
    }
    const label = args.length ? args.join(' ') : '(no args)';
    console.log(`  ${r.exit === 0 ? '✓' : '✗'} ${scraper} ${label}${note ? `  — ${note}` : ''}`);
  }
  return { scraper, capturedAt: new Date().toISOString(), cases };
}

async function check(scraper: string, contract: Contract): Promise<string[]> {
  const fails: string[] = [];
  for (const c of contract.cases) {
    const r = await run(scraper, c.args);
    const label = `${scraper} ${c.args.join(' ') || '(no args)'}`;
    if (r.exit !== c.exit) {
      fails.push(`${label}: exit ${c.exit} -> ${r.exit} (${r.stderr.trim().slice(0, 80)})`);
      continue;
    }
    if (c.exit === 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        if (/Commands:/.test(r.stdout)) parsed = { kind: 'help-text' };
        else { fails.push(`${label}: stdout is neither JSON nor help text`); continue; }
      }
      const d = diffShape(c.shape, shapeOf(parsed));
      if (d) fails.push(`${label}: shape drift ${d}`);
    } else if (c.errorRe && !new RegExp(c.errorRe, 'i').test(r.stderr)) {
      fails.push(`${label}: stderr does not match /${c.errorRe}/`);
    }
  }
  return fails;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const captureMode = argv.includes('--capture');
  const checkMode = argv.includes('--check');
  if (!captureMode && !checkMode) {
    console.error('usage: bun tools/contract.ts --capture|--check [scraper]');
    process.exit(2);
  }
  const only = argv.find((a) => !a.startsWith('--'));
  const scrapers = only ? [only] : [...SCRAPERS];
  let failures = 0;

  for (const scraper of scrapers) {
    const path = `${GOLDEN_DIR}/${scraper}/contract.json`;
    if (captureMode) {
      console.log(`\n[${scraper}] capturing`);
      const contract = await capture(scraper);
      if (!contract.cases.length) continue;
      await $`mkdir -p ${GOLDEN_DIR}/${scraper}`.quiet();
      await Bun.write(path, JSON.stringify(contract, null, 2) + '\n');
      console.log(`  → ${path}`);
      continue;
    }
    const file = Bun.file(path);
    if (!(await file.exists())) {
      console.error(`[${scraper}] no contract at ${path} — run --capture first`);
      failures++;
      continue;
    }
    const contract = (await file.json()) as Contract;
    const fails = await check(scraper, contract);
    if (fails.length) {
      failures += fails.length;
      console.error(`[${scraper}] ${fails.length} FAIL`);
      for (const f of fails) console.error(`  ✗ ${f}`);
    } else {
      console.log(`[${scraper}] ✓ ${contract.cases.length} cases`);
    }
  }
  if (failures) {
    console.error(`\nRESULT: ${failures} contract failure(s)`);
    process.exit(1);
  }
  if (checkMode) console.log('\nRESULT: all contracts match');
}

await main();

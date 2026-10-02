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
  /**
   * Live lists that mix item kinds (YouTube's search/related rails return videos,
   * shorts, playlists, mixes and channels in one response) make an array-union
   * shape genuinely variable, so an exact union match is flaky. With this flag
   * every variant recorded in the golden must still appear — at any depth — while
   * new variants are allowed: these rails genuinely add kinds between runs, and
   * the rare ones (measured at 5–25% of runs) are sampling noise, not drift.
   * Capture intersects its samples so the golden records only kinds seen in every
   * one, which is exactly the set the check can require without flaking.
   */
  allowVariants?: boolean;
}
interface Contract {
  scraper: string;
  capturedAt: string;
  cases: Case[];
}
interface RunResult { exit: number; stdout: string; stderr: string }

const SCRAPERS = [
  'anilist', 'animeindo', 'codeengo', 'drowify', 'freeconvert', 'kanzenin',
  'lk21', 'mangasusuku', 'ngomik',
  'otakudesu', 'sakana', 'samehadaku', 'sankanime', 'spotify', 'tiktok',
  'view-page-source', 'whitehouse', 'yt', 'ytmusic',
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

/** True when a shape node is an object shape: a list of `{key, value}` entries. */
function isKeyMap(s: unknown): boolean {
  return (
    Array.isArray(s) &&
    s.every((e) => e !== null && typeof e === 'object' && !Array.isArray(e) && 'key' in e && 'value' in e)
  );
}

/**
 * The identity of one variant in a list: its key set for an object, else its
 * JSON. Item kinds are told apart by their keys — never by whether a single
 * field happened to come back null in this particular response.
 */
function kindOf(s: unknown): string {
  return isKeyMap(s)
    ? (s as Array<{ key: string }>).map((e) => e.key).sort().join(',')
    : JSON.stringify(s);
}

/** Merge two scalar type names. `null` means "absent", so it yields to a type. */
function mergeScalar(a: string, b: string): string {
  if (a === b) return a;
  if (a === 'null') return b;
  if (b === 'null') return a;
  return a;
}

/**
 * Intersect two shapes, keeping only what BOTH agree on. Capture uses this for
 * variant cases: a kind that shows up in one sample but not the next is not a
 * kind the check may require.
 */
function intersectShapes(a: unknown, b: unknown): unknown {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (isKeyMap(a) && isKeyMap(b)) {
      const out: unknown[] = [];
      for (const ea of a as Array<{ key: string; value: unknown }>) {
        const eb = (b as Array<{ key: string; value: unknown }>).find((x) => x.key === ea.key);
        if (eb) out.push({ key: ea.key, value: intersectShapes(ea.value, eb.value) });
      }
      return out;
    }
    // a variant list: keep the kinds present in both samples, intersected
    const out: unknown[] = [];
    for (const x of a as unknown[]) {
      const y = (b as unknown[]).find((c) => kindOf(c) === kindOf(x));
      if (y) out.push(intersectShapes(x, y));
    }
    return out;
  }
  if (typeof a === 'string' && typeof b === 'string') return mergeScalar(a, b);
  return a; // the samples disagree on the shape kind: keep the first
}

/**
 * shapeOf renders an empty array as the single sentinel element `'<empty>'`, so
 * a length check is not enough to tell "no items" from "one odd item".
 */
function isEmptyShape(s: unknown): boolean {
  return Array.isArray(s) && s.length === 1 && s[0] === '<empty>';
}

/**
 * Variant-tolerant containment (see Case.allowVariants): every shape recorded in
 * the golden must still appear in the live payload — at ANY depth, so a nested
 * `results` union is compared kind-by-kind instead of as one blob. A golden
 * variant is matched by its key set (its kind) and then recursively, never by a
 * richer variant that merely happens to contain the same keys — otherwise a lost
 * kind would go unnoticed because videos also have an `id` and a `title`. New
 * variants are allowed; a recorded one going missing is drift.
 *
 * `null` counts as absent and matches any type: a shorts item with no thumbnail
 * (about one run in ten) is not shape drift.
 *
 * Returns null when the golden is contained, else a one-line description of the
 * first gap — the old boolean gave the caller nothing to debug with.
 */
function variantGap(golden: unknown, live: unknown, path = '$'): string | null {
  if (Array.isArray(golden) && Array.isArray(live)) {
    if (isKeyMap(golden) && isKeyMap(live)) {
      for (const g of golden as Array<{ key: string; value: unknown }>) {
        const l = (live as Array<{ key: string; value: unknown }>).find((x) => x.key === g.key);
        if (!l) return `${path}.${g.key}: key missing from live`;
        const d = variantGap(g.value, l.value, `${path}.${g.key}`);
        if (d) return d;
      }
      return null;
    }
    if (isEmptyShape(live)) return null; // no items this response — no shape evidence, not drift
    for (const g of golden as unknown[]) {
      const k = kindOf(g);
      const match = (live as unknown[]).find((l) => kindOf(l) === k);
      if (!match) return `${path}: kind '${k}' missing — live has ${live.map(kindOf).join(' | ')}`;
      const d = variantGap(g, match, `${path}[${k}]`);
      if (d) return d;
    }
    return null;
  }
  if (golden === live || golden === 'null' || live === 'null') return null;
  return `${path}: ${JSON.stringify(golden)} -> ${JSON.stringify(live)}`;
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
    return null; // every element matched once null-tolerant differences are allowed
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    for (const k of Object.keys(oa)) {
      if (!(k in ob)) return `${path}.${k}: key missing from live`;
      const d = diffShape(oa[k], ob[k], `${path}.${k}`);
      if (d) return d;
    }
    for (const k of Object.keys(ob)) if (!(k in oa)) return `${path}.${k}: unexpected key in live`;
    return null; // key sets agree; only null-tolerant differences remained
  }
  if (a === 'null' || b === 'null') return null; // absent in this response, not drift
  return `${path}: ${ja?.slice(0, 60)} -> ${jb?.slice(0, 60)}`;
}

/**
 * The command matrix. Each entry is chosen so it exercises real value: an
 * input that must SUCCEED (shape-recorded) or one that must FAIL cleanly
 * (exit 1 + actionable message).
 */
/** Commands whose live list genuinely mixes item kinds (see Case.allowVariants). */
const VARIANT_CASES = new Set(['yt search', 'yt related', 'ytmusic search', 'ytmusic related']);

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
  kanzenin: [
    [['home']],
    [['search', 'one piece']],
    [['genrelist']],
    [['detail', 'family-control']],
    [['chapter', 'family-control-chapter-5']],
    [['azlist', 'A']],
    [['genre', '../etc'], 'traversal slug must be rejected'],
  ],
  mangasusuku: [
    [['home']],
    [['search', 'solo leveling']],
    [['genrelist']],
    [['detail', 'solo-leveling']],
    [['chapter', 'solo-leveling-chapter-155']],
    [['azlist', 'A']],
    [['genre', '../etc'], 'traversal slug must be rejected'],
  ],
  ngomik: [
    [['home']],
    [['search', 'eleceed']],
    [['genrelist']],
    [['genre', 'action', '2']],
    [['detail', 'eleceed']],
    [['chapter', 'eleceed-chapter-420']],
    [['genre', '../etc'], 'traversal slug must be rejected'],
  ],
  sankanime: [
    [['home']],
    [['terbaru']],
    [['search', 'naruto']],
    [['genrelist']],
    [['genre', 'action']],
    [['detail', 'naruto-konohas-story-the-steam-ninja-scrolls']],
    [['chapter', 'naruto-konohas-story-the-steam-ninja-scrolls-chapter-15']],
    [['genre', '../etc'], 'traversal slug must be rejected'],
  ],
  otakudesu: [
    [['home']],
    [['ongoing', '1']],
    [['genrelist']],
    [['detail', '../etc'], 'traversal slug must be rejected'],
  ],
  // samehadaku sits behind a Cloudflare managed challenge (like lk21): plain
  // clients get HTTP 403, so only the CLI surface is checked here.
  samehadaku: [
    [['help'], undefined],
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
      const variant = VARIANT_CASES.has(`${scraper} ${args[0]}`);
      let shape = shapeOf(parsed);
      if (variant) {
        // These rails mix item kinds across requests, and the rare kinds come and
        // go between runs — measured on `yt search`: video/mix/short in 20/20 runs
        // but the playlist kind in 1/20; on `yt related`: video 20/20, playlist
        // 5/20, mix 2/20. INTERSECT the samples so the golden records only the
        // kinds present in EVERY sample. That is the set the check can require
        // without flaking; a kind recorded from a single lucky sighting would fail
        // every run that happened not to include it.
        for (let i = 0; i < 7; i++) {
          const again = await run(scraper, args);
          if (again.exit !== 0) continue;
          try {
            shape = intersectShapes(shape, shapeOf(JSON.parse(again.stdout)));
          } catch { /* non-JSON help text: ignore */ }
        }
      }
      cases.push({ args, exit: 0, shape, note, ...(variant ? { allowVariants: true } : {}) });
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
      const spotted = shapeOf(parsed);
      const d = c.allowVariants ? variantGap(c.shape, spotted) : diffShape(c.shape, spotted);
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

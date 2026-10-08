#!/usr/bin/env bun
/**
 * Web/route contract guard.
 *
 * bun tools/webroutes.ts [--check] [--list]
 *
 * The frontend names the backend routes it drives (web/src/lib/sections.ts
 * `endpoints`, and the `path:` literals in the docs/playground/section pages).
 * Nothing enforced that those names exist — `/tiktok/download` was advertised
 * for weeks while the server answered 404 (it is a LocalOnly command, so it
 * never gets a route at all). This guard makes the claim checkable: every
 * endpoint the UI names must appear in the server's own route table, read from
 * `nontonanime openapi` (the same table that serves traffic).
 *
 * Exit codes: 0 = every claim is served · 1 = a claim has no route · 2 = env failure.
 */
import { $ } from 'bun';
import { existsSync, statSync, readFileSync } from 'node:fs';

const API_PREFIX = '/api/v1';
const GO_BIN = process.env.WEBROUTES_GO_BIN || '/tmp/nn-go';
const GO_SRC = 'nontonanime.go';

/** A route the UI claims, with the file and line that made the claim. */
interface Claim {
  endpoint: string; // as written, e.g. "/tiktok/user"
  where: string; // "sections.ts:58"
}

function failEnv(msg: string): never {
  console.error(`[ENV] ${msg}`);
  process.exit(2);
}

/** Build the Go binary when it is missing or older than its source. */
async function ensureBinary(): Promise<void> {
  if (!existsSync(GO_SRC)) failEnv(`${GO_SRC} not found — run from the repo root`);
  const missing = !existsSync(GO_BIN);
  const stale = !missing && statSync(GO_SRC).mtimeMs > statSync(GO_BIN).mtimeMs;
  if (!missing && !stale) return;
  console.log(`[env] ${missing ? 'building' : 'rebuilding'} ${GO_BIN}...`);
  const r = await $`go build -o ${GO_BIN} .`.quiet().nothrow();
  if (r.exitCode !== 0) failEnv(`go build failed: ${r.stderr.toString().slice(0, 300)}`);
}

/** Served route set, straight from the server's generated spec. */
async function servedRoutes(): Promise<Set<string>> {
  const r = await $`${GO_BIN} openapi`.quiet().nothrow();
  if (r.exitCode !== 0) failEnv(`${GO_BIN} openapi failed: ${r.stderr.toString().slice(0, 300)}`);
  let spec: { paths?: Record<string, unknown> };
  try {
    spec = JSON.parse(r.stdout.toString());
  } catch (e) {
    failEnv(`${GO_BIN} openapi did not emit JSON: ${String(e)}`);
  }
  const paths = Object.keys(spec.paths ?? {});
  if (paths.length < 50) failEnv(`spec lists only ${paths.length} paths — refusing to validate against a partial table`);
  return new Set(paths);
}

/** endpoint literal -> the full served path. Absolute claims pass through. */
function toFullPath(endpoint: string): string {
  const clean = endpoint.split('?')[0].replace(/\/+$/, '');
  if (clean.startsWith(API_PREFIX)) return clean;
  return `${API_PREFIX}${clean.startsWith('/') ? clean : `/${clean}`}`;
}

/**
 * Claim extraction. Two shapes exist in web/src and they mean different things:
 *   - sections.ts: `path:` is the SPA page route, `endpoints:` names the API
 *   - docs/playground/section pages: `path:` IS the API path
 * Planned rows are skipped: an entry marked "(planned)" or a section whose
 * status is `planned` is an explicit promise of future work, not a live claim.
 */
function claimsIn(file: string, mode: 'endpoints' | 'path'): Claim[] {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const out: Claim[] = [];
  const short = file.split('/').pop()!;

  lines.forEach((line, i) => {
    const where = `${short}:${i + 1}`;

    if (mode === 'path') {
      for (const m of line.matchAll(/\bpath:\s*'([^']+)'/g)) {
        if (!m[1].includes('(planned)')) out.push({ endpoint: m[1], where });
      }
      return;
    }

    // `endpoints: ['/x', '/y']` — the API claims in sections.ts
    const arr = line.match(/\bendpoints:\s*\[([^\]]*)\]/);
    if (arr) {
      const planned = /\bstatus:\s*'planned'/.test(line) || line.includes('(planned)');
      if (planned) return; // explicit future work
      for (const m of arr[1].matchAll(/'([^']+)'/g)) {
        if (!m[1].includes('(planned)')) out.push({ endpoint: m[1], where });
      }
    }
  });
  return out;
}

const WEB_SOURCES: Array<{ file: string; mode: 'endpoints' | 'path' }> = [
  { file: 'web/src/lib/sections.ts', mode: 'endpoints' },
  { file: 'web/src/pages/docs.tsx', mode: 'path' },
  { file: 'web/src/pages/playground.tsx', mode: 'path' },
  { file: 'web/src/pages/section.tsx', mode: 'path' },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const list = argv.includes('--list');

  // `--list` is a cheap dump of claims; it still needs the binary for the match
  await ensureBinary();
  const served = await servedRoutes();

  const claims: Claim[] = [];
  for (const { file, mode } of WEB_SOURCES) {
    if (!existsSync(file)) failEnv(`${file} is missing — has the frontend moved?`);
    claims.push(...claimsIn(file, mode));
  }
  if (claims.length === 0) failEnv('no endpoint claims found — the parser is broken, not the UI');

  const unknown: Claim[] = [];
  const seen = new Set<string>();
  for (const c of claims) {
    const full = toFullPath(c.endpoint);
    if (seen.has(full)) continue;
    seen.add(full);
    if (!served.has(full)) unknown.push(c);
  }

  const unique = [...new Set(claims.map((c) => toFullPath(c.endpoint)))];
  console.log(`webroutes: ${claims.length} claims · ${unique.length} unique endpoints · ${served.size} served routes`);

  // the index and the spec itself are served but never advertised as a source
  // endpoint, so a claim for them would be legitimate; everything else must match.
  if (list) {
    for (const p of [...served].sort()) console.log(`  served  ${p}`);
  }

  for (const c of unknown) {
    console.error(`[FAIL] ${c.where} advertises ${c.endpoint} -> ${toFullPath(c.endpoint)}, which the server does not route`);
  }

  if (unknown.length) {
    console.error(`webroutes: ${unknown.length} claim(s) have no route — the UI advertises endpoints that answer 404`);
    process.exit(1);
  }
  console.log('webroutes: ok — every endpoint the UI names is served');
  process.exit(0);
}

await main();

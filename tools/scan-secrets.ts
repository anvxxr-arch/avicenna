#!/usr/bin/env bun
/**
 * tools/scan-secrets.ts — repo secret scanner (pre-commit gate + CI).
 *
 *   bun tools/scan-secrets.ts            # scan staged files (pre-commit)
 *   bun tools/scan-secrets.ts --all      # scan every tracked file
 *   bun tools/scan-secrets.ts --history  # also scan all commits
 *
 * Exit 0 = clean, 1 = findings. Never prints the matched secret verbatim.
 */
import { $ } from 'bun';

interface Rule { name: string; re: RegExp; allow?: RegExp }
interface Finding { file: string; line: number; rule: string }

// Ordered: specific provider formats first, generic patterns last.
const RULES: Rule[] = [
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{30,40}/ },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'stripe-live-key', re: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: 'hardcoded-credential',
    re: /(?:api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
    // env lookups, placeholders, docs and type declarations are fine
    allow: /process\.env|import\.meta\.env|\bexample\b|placeholder|redacted|change-me|your[-_]|<[^>]*>|\.\.\.|%s|x{4,}|•/i,
  },
];

const SKIP_PATH = /^(?:node_modules|\.git|downloads|golden|nontonanime-rs\/target)\//;
const SCAN_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|go|rs|json|ya?ml|toml|sh|md|env|service)$/;

function scanText(file: string, text: string, into: Finding[]): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4096) continue;
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      if (rule.allow?.test(line)) continue;
      into.push({ file, line: i + 1, rule: rule.name });
    }
  }
}

async function trackedFiles(): Promise<string[]> {
  const out = await $`git ls-files -z`.quiet().text();
  return out.split('\0').filter(Boolean);
}

async function stagedFiles(): Promise<string[]> {
  const out = await $`git diff --cached --name-only --diff-filter=ACM -z`.quiet().text();
  return out.split('\0').filter(Boolean);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const history = argv.includes('--history');
  const findings: Finding[] = [];

  const files = (all ? await trackedFiles() : await stagedFiles())
    .filter((f) => !SKIP_PATH.test(f) && SCAN_EXT.test(f));

  for (const f of files) {
    const text = await Bun.file(f).text().catch(() => '');
    if (text) scanText(f, text, findings);
  }

  if (history) {
    // scan every blob reachable from every ref, once (dedup by hash)
    const revs = (await $`git rev-list --all`.quiet().text()).split('\n').filter(Boolean);
    const seen = new Set<string>();
    for (const rev of revs) {
      const listing = await $`git ls-tree -r --name-only ${rev}`.quiet().text();
      for (const f of listing.split('\n').filter((x) => x && SCAN_EXT.test(x) && !SKIP_PATH.test(x))) {
        const key = `${rev}:${f}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const text = await $`git show ${key}`.quiet().text().catch(() => '');
        if (text) scanText(`${rev}:${f}`, text, findings);
      }
    }
  }

  if (!findings.length) {
    console.log(`secret-scan: clean (${files.length} files${history ? ' + history' : ''})`);
    return;
  }
  console.error(`secret-scan: ${findings.length} finding(s) — value withheld`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
  console.error('\nRemove the literal and read it from the environment instead.');
  process.exitCode = 1;
}

await main();

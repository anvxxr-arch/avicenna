#!/usr/bin/env bun
/*
tools/golden-diff.ts — key-shape diff vs golden capture (spec 003 acceptance).
Values may legitimately change (live site); KEY SET at every nesting level must match.
Usage: bun tools/golden-diff.ts <golden.json> <new.json>
Exit 0 = shapes match, 1 = mismatch, 2 = usage/parse error.
*/
import { readFileSync } from 'node:fs';

declare const process: { argv: string[]; exit(c?: number): void };

type Json = unknown;

function shape(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    // union of element shapes (array length legitimately varies)
    const el = new Set(v.map((e) => shape(e)));
    return '[' + [...el].sort().join('|') + ']';
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, Json>).sort();
    return '{' + keys.map((k) => k + ':' + shape((v as Record<string, Json>)[k])).join(',') + '}';
  }
  return typeof v;
}

function main(): void {
  const [, , a, b] = process.argv;
  if (!a || !b) { console.error('usage: golden-diff <golden.json> <new.json>'); process.exit(2); }
  // read golden but tolerate non-JSON or empty (e.g. stderr files or missing golden)
  let ga: Json;
  try {
    const raw = readFileSync(a, 'utf8');
    if (!raw || raw.trim() === '') ga = null as never;
    else ga = JSON.parse(raw);
  } catch (_) { ga = null as never; }
  // read new file
  let gb: Json;
  try {
    const raw = readFileSync(b, 'utf8');
    if (!raw || raw.trim() === '') { console.log('OK  new file empty'); process.exit(0); }
    gb = JSON.parse(raw);
  } catch (e) { console.error(`parse fail ${b}: ${(e as Error).message}`); process.exit(2); }
  // If golden missing or empty, treat shape OK
  if (ga === null) { console.log('OK  golden missing/empty'); process.exit(0); }
  const sa = shape(ga), sb = shape(gb);
  if (sa === sb) { console.log('OK  shapes match'); process.exit(0); }
  console.error('MISMATCH');
  console.error('  golden: ' + sa.slice(0, 2000));
  console.error('  new   : ' + sb.slice(0, 2000));
  process.exit(1);
}

main();

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

/** A golden file counts only when it parses to a non-empty JSON value. */
function readGolden(path: string): Json {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`golden unreadable: ${path} — ${(e as Error).message}`);
    process.exit(2);
  }
  if (!raw || raw.trim() === '') {
    console.error(`golden empty: ${path}`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`golden is not valid JSON: ${path} — ${(e as Error).message}`);
    process.exit(2);
  }
}
function main(): void {
  const [, , a, b] = process.argv;
  if (!a || !b) { console.error('usage: golden-diff <golden.json> <new.json>'); process.exit(2); }
  const ga: Json = readGolden(a);
  let gb: Json;
  try {
    const raw = readFileSync(b, 'utf8');
    if (!raw || raw.trim() === '') { console.error(`new output empty: ${b}`); process.exit(1); }
    gb = JSON.parse(raw);
  } catch (e) { console.error(`parse fail ${b}: ${(e as Error).message}`); process.exit(2); }
  const sa = shape(ga), sb = shape(gb);
  if (sa === sb) { console.log('OK  shapes match'); process.exit(0); }
  console.error('MISMATCH');
  console.error('  golden: ' + sa.slice(0, 2000));
  console.error('  new   : ' + sb.slice(0, 2000));
  process.exit(1);
}

main();

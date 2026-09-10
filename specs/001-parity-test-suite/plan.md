# Implementation Plan: Cross-Runtime Parity Test Suite

**Branch**: `001-parity-test-suite` · **Spec**: [spec.md](./spec.md)

## Architecture

Single Bun/TS orchestrator (`tools/parity.ts`) — no new deps (uses Bun stdlib: `$` shell, `fs`, deep-equal via JSON canonicalization).

```
tools/parity.ts
├─ RUNTIMES  : [{ name:'ts', cmd:[bun, nontonanime.ts] }, {name:'go', cmd:[/tmp/nn-go]}, {name:'rs', cmd:[.../release/nontonanime]}]
├─ CASES     : one row per CLI command { name, args:[...], live:true, volatile:[field-paths to ignore] }
├─ GUARDS    : offline cases { name, args:[...], expect: 'reject', stderrRe: RegExp }
├─ runCase() : spawn → timeout 60s → JSON.parse stdout (or stderr for rejects)
├─ normalize(): strip volatile fields (nonce→format-check, postId→presence-check), canonical-sort object keys
├─ deepEqual : recursive, arrays order-sensitive, objects key-order-insensitive
└─ report    : console table + parity-report.json (exit 0/1/2 semantics)
```

## Runtime mapping

| Runtime | Binary | Build refresh | Notes |
|---|---|---|---|
| ts | `bun nontonanime.ts` | n/a | reference implementation |
| go | `/tmp/nn-go` (built via `go build -o /tmp/nn-go nontonanime.go`) | re-run if source newer | single-file module `nontonanime` |
| rs | `nontonanime-rs/target/release/nontonanime` | `cargo build --release` if stale | MSRV 1.75 pins in Cargo.toml |

Binary discovery: env overrides `PARITY_GO_BIN`, `PARITY_RS_BIN`; else defaults above; missing binary → environment failure (exit 2), no live traffic.

## Volatile-field policy (deep-equal ignore list)

- `servers.nonce`, `servers.defaultEmbed` → format-check only (nonce `^[a-f0-9]{6,20}$`; embed `^https?://`)
- `postId` → must be non-empty string on all runtimes; value may differ (URL-pattern vs data-post extraction)
- `resolve`/`stream` outputs → `^https?://` format check only (signed/rotating URLs)
- Everything else → strict deep-equal after key-canonicalization

## Command case table (21 rows)

home, latest, recent, search(q), advsearch(genre+sort → WAF fallback path), list, anime(url), episode(url), stream(url,2), servers(url), resolve(url,2), nav(url), meta(url), genres, genre(action), ongoing, popular, schedule, top, season(summer 2026), more(offset 20).

Guard rows (offline): genre traversal, bad season, missing year, short query, evil host ×3 entry points (anime/servers/resolve).

## Risk notes

- Live-site WAF: single retry per command×runtime, then `skip-waf` status.
- Empty-on-all-runtimes (site layout change): `empty-consistent` warning pass.
- Timeout: 60s per command×runtime; hard wall-clock budget 10 min.

## Verification

`tsc --noEmit tools/parity.ts` clean; guard suite passes offline; live suite <10min; report JSON written on every run; exit codes per spec story 3.

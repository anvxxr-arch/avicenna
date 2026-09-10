# Spec-Kit Workflow — avicenna

## Setup (done)
- `specify-cli 1.0.0` via `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.0.0`
- Project initialized: `specify init . --integration claude --ignore-agent-tools --force` (run from repo root; never creates nested dir)
- `.specify/` = scripts/templates/memory · `.claude/skills/speckit-*` = 10 command skills
- Constitution ratified: `.specify/memory/constitution.md` (6 principles: spec-first, 3-runtime parity NON-NEGOTIABLE, hardened-by-default, respect-target, perf-is-feature, test-real-surface)

## Workflow per feature
1. `bash .specify/scripts/bash/create-new-feature.sh "<slug>"` → scaffolds `specs/NNN-<slug>/spec.md` (prints SPEC_FILE path)
2. Fill spec: user stories (P1/P2/P3, independently testable), acceptance scenarios (Given/When/Then), edge cases, requirements, review checklist
3. `plan.md` — architecture, runtime mapping, risk notes, verification plan
4. `tasks.md` — phased checkboxes; mark `[x]` as done; final status line CONVERGED when all pass
5. Implement → build ×3 runtimes → live verify → update tasks.md
6. Machine artifacts (e.g. parity-report.json) live inside the feature dir

## Lessons (2026-09-09, spec 001)
- JS `.slice(n)` truncates by UTF-16 code units, NOT bytes — ports must count UTF-16 length (Cyrillic/Lithuanian chars in ID site content expose byte-vs-unit drift). Fixed in Go+Rust `txt()`.
- TS `parseFloat(x) || 0` coerces NaN→0 in sort comparators; Go NaN in `sort.SliceStable` less func breaks transitivity → garbage order. Fixed with `parseNumOr0`.
- Bun.spawnSync: `new Response(proc.stdout).text()` is async — must await. `.quiet()` on Bun.$ returns {stdout:Buffer}, index as array.
- Volatile-field policy for cross-runtime diff: nonce→format-check, postId→presence-check, bare-URL outputs→`^https?://` check. Everything else strict deep-equal (order-sensitive arrays, canonical object keys).
- Go rebuild after edit: `go build -o /tmp/nn-go nontonanime.go`; Rust: `cd nontonanime-rs && cargo build --release` (~15s incremental).
- Parity suite = the real safety net for the 3-runtime contract; smoke tests alone miss shape/semantic drift.

# Changelog

All notable changes to Ducktective. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are the day the
work landed.

## [0.2.0] — 2026-09-19

The measurement-integrity release. No new claim surface; several ways a case file
could lie were closed, and the plan learned from four sibling projects was written
down.

### Added

- **One verdict policy** (`scripts/lib/verdict-policy.mjs`): the confirmation rule,
  the receipt arithmetic, the candidate refusal rules, the reportable gate, and
  cause identity, in a single pure module. `run_check.mjs` and `lib/case-file.mjs`
  both call it, and a parity test asserts the schema enums and the policy sets
  agree — the two-places defect is gone.
- **Derived cause-confidence** (0..1) and a **reportable** gate: `confirmed_cause`,
  a patch, and `high`/`medium` confidence require a case whose receipts clear the
  floor. Surfaced in `write_case.mjs` output and the Markdown mirror.
- **Cause identity and recurrence**: `writeCase` derives `cause_hash`/`cause_key`
  and upserts `.ducktective/causes.jsonl`; a repeated root cause increments
  `count` instead of piling up a near-duplicate. `write_case.mjs --causes` prints
  the index, most recurrent first.
- **Probe attempt receipts**: `probe_attempts` and `probe_artifact` record every
  neuter strategy's outcome, so the artifact rate (metric C7) is computable from
  the store instead of discarded.
- **Benchmark scaffold** (`bench/`): corpus-source validation, content-addressed
  job identity, instance-spec validation, and the C1–C10 arithmetic, with smoke
  tests. The arm runner and corpus materialiser are **not built**.
- `docs/implementation.md` — the strategy and implementation plan, dissecting four
  sibling projects and proposing the receipt ladder.
- `docs/guide.md` — a worked walkthrough.

### Fixed

- `bin/install.mjs` no longer tells users to verify an install with the retired
  `query_memory.mjs`; a guard (`scripts/retired-tools.test.mjs`) fails if shipped
  executable code names a retired tool again.

### Changed

- Repository gains `assets/` (hero image), `bench/`, and a test glob that includes
  benchmark smoke tests.
- `package.json` gains `version`, `description`, `license`, `homepage`, and
  `repository`.

## [0.1.0] — 2026-09-14

Initial Agent Skill: `reproduce.mjs`, `bisect.mjs`, `run_check.mjs` (with `--probe`
and `--verify`), `write_case.mjs`, `check.mjs`, the strict case-file schema, the
installer, the behaviour corpus, and the single-source architecture reference.

[0.2.0]: https://github.com/adeerkhan/ducktective/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/adeerkhan/ducktective/releases/tag/v0.1.0

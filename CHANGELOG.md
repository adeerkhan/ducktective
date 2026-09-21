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
- **Blind-check receipt (E2)**: `run_check.mjs --blind "<cmd>"` executes a second,
  independently written check and records it on the candidate as `blind_check`
  (`verdict`, `check`, `exit_code`, `evidence`). A non-reproduction is stored as
  `unreplicated`, and `write_case.mjs` refuses a `confirmed` without a confirming
  receipt — **default-on**, because the failure it guards is silent. Honest limit:
  the tool proves the second check ran; context separation is the host's
  obligation (`docs/architecture.md` §6.5). C8 measures the overturn rate.
- **Benchmark scaffold** (`bench/`): source validation, content-addressed
  job identity, instance-spec validation, and the C1–C12 arithmetic, with smoke
  tests. The arm runner and Docker/remote corpus sources are **not built**.
- **Corpus materialiser** (`bench/materialize.mjs`): clones an instance's repo at
  its commit into a throwaway directory, then verifies the premise — the gold-hunk
  files cover real lines and the repro actually fails. A green repro is refused.
  `local` source only; remote/Docker sources come with their materialisers.
- **Arm runner** (`bench/run.mjs`): runs each arm (`DT_ARM` = bare or skill) in its own
  throwaway checkout, then scores the `claim.json` the agent writes against the gold
  hunks, emitting `results.jsonl` and C1–C12. Proven end-to-end with the model-free
  `bench/stub-agent.mjs`; a real run needs a host-agent CLI and a corpus.
- **OpenCode v2 adapter** (`bench/opencode-agent.mjs`): builds the arm prompt (A bare,
  B told to use the skill) and runs `opencode run --format json --auto [--model p/m]`
  in the clone, then writes the claim. `DT_DRY_RUN=1` prints the command without
  calling the model.
- **Harness registry** (`bench/agents.mjs`) and the **`ducktective-bench` skill**
  (`skills/ducktective-bench/SKILL.md`): `run.mjs` auto-detects the agent CLI (OpenCode
  verified; `--agent stub` for CI) and builds the command, so no `--agent-cmd` is needed.
  The single-source guard now forbids a second `name: ducktective` contract rather than a
  second skill, since the benchmark is legitimately its own skill.
- **Tier-1 mutation canary** (`evals/canary.mjs`, `npm run canary`): mutates a target
  module, keeps the mutants its tests kill, and scores whether `reproduce.mjs`'s first
  lead is the line it broke; survivors must return no candidate. 88% cause-hit@1 on
  the fixture and 25% on this repo's own `bench/report.mjs` (crash mutants hit, value
  mutants do not — JS seeding is traceback-only). Nightly CI (`canary.yml`), never a
  PR gate — mutants are easier than real faults.
- `docs/implementation.md` — the strategy and implementation plan, dissecting four
  sibling projects and proposing the receipt ladder.
- `docs/guide.md` — a worked walkthrough.

### Fixed

- `bin/install.mjs` no longer tells users to verify an install with the retired
  `query_memory.mjs`; a guard (`scripts/retired-tools.test.mjs`) fails if shipped
  executable code names a retired tool again.

### Changed

- Repository gains `assets/` (hero image), `bench/`, `evals/canary.mjs`, and a test
  glob that includes benchmark and canary tests.
- `package.json` gains `version`, `description`, `license`, `homepage`, and
  `repository`.

## [0.1.0] — 2026-09-14

Initial Agent Skill: `reproduce.mjs`, `bisect.mjs`, `run_check.mjs` (with `--probe`
and `--verify`), `write_case.mjs`, `check.mjs`, the strict case-file schema, the
installer, the behaviour corpus, and the single-source architecture reference.

[0.2.0]: https://github.com/adeerkhan/ducktective/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/adeerkhan/ducktective/releases/tag/v0.1.0

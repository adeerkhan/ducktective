---
name: ducktective-bench
description: Run the Ducktective comparative benchmark — a bare agent (arm A) versus the same agent with the Ducktective skill (arm B) on a corpus of bugs with known answers — and report C1–C12. Use when asked to benchmark, measure, or compare Ducktective, to materialise a bug corpus, or to check whether the skill improves root-cause accuracy.
---

# Ducktective benchmark

The product is the `ducktective` skill. This is the instrument that tells you whether it
works: two arms, one corpus, mechanical scoring. It is a developer tool that lives in the
Ducktective checkout, not a skill you install into a target repo.

## What it does

```
instance spec ──▶ materialize.mjs ──▶ verified buggy checkout
                                        │
                         ┌──────────────┴──────────────┐
                         ▼                             ▼
                   arm A: bare agent          arm B: agent + ducktective
                         │                             │
                         └──────────► claim.json ◄─────┘
                                        │
                                   run.mjs scores against gold hunks
                                        │
                                   C1–C12 (C2 = false-confirm rate)
```

The headline metric is **C2**: how often an arm reports a cause that misses every gold
bug-fix hunk. C8 is the blind-checker overturn rate (design v3). Full definitions are in
`bench/report.mjs` and `docs/implementation.md` §5.

## Run it

From the Ducktective checkout root:

```bash
npm test                                              # the harness's own tests
node bench/materialize.mjs --instances corpus/ --out work/ --yes   # verify a corpus
node bench/run.mjs --instances corpus/ --out work/ --yes           # both arms, scored
```

`run.mjs` auto-detects the agent harness on `PATH` (OpenCode today) and builds the agent
command itself — no `--agent-cmd` needed. Override it with `--agent <name>`, or use any
other harness with `--agent-cmd "<command>"`; that command runs with cwd = the arm's
checkout, so `{bench}` is replaced with this folder's path. `--agent stub` is the
model-free harness for dry runs.

Point the arms at a specific model through the adapter, e.g. OpenCode:

```bash
DT_MODEL="<provider>/<model>" node bench/run.mjs --instances corpus/ --out work/ --yes
```

## An instance

One JSON object: a buggy repo at a commit, the command that fails there, and the gold
hunks. `materialize.mjs` refuses it if the gold hunks do not exist or the repro already
passes.

```json
{
  "id": "local-demo-1",
  "source": "local",
  "repo": "/path/to/repo",
  "commit": "<buggy-sha>",
  "repro": { "command": "python -m pytest -q tests/test_x.py::test_y" },
  "expect": { "goldHunks": [{ "file": "src/app.py", "start": 120, "end": 128 }] }
}
```

## Guardrails

- **No measured claim before Tier 2.** If `run.mjs` ran on a toy or self-authored corpus,
  say so; a number from `local` hand-picked instances is a smoke test, not a result.
- **Arms must be separated honestly.** Arm A is bare: it must not have the `ducktective`
  skill available, or it is not a control. The prompt says "do not use a debugging skill";
  the clean setup installs the skill only for arm B.
- **Throwaway clones only.** `--auto` auto-approves agent permissions, which is safe here
  because every arm runs in a clone the materialiser made, never your tree.
- **State the falsifier.** C2 near-zero movement, or C8 ≈ 0, are pre-registered reasons to
  cut a mechanism (`docs/implementation.md` §8), not failures to explain away.

## Out of scope

Indexing your repo, installing anything, running a server, or reporting a grade for a bug
in your own project — that is the `ducktective` skill's job.

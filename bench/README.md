# bench/ — the comparative benchmark

This is the capture path for design §4: compare a bare host agent (arm A) with the same
agent plus Ducktective (arm B) on a corpus of bugs with known answers, and report
**C1–C12**. C1–C7 are design v2's metrics; **C8** (blind-checker overturn rate) and
**C9** (why/evidence consistency) are design v3's; C10–C12 are the receipt ladder's. The
headline metric is **C2, the false-confirm rate**: how often an arm emits a reportable
cause that misses every gold bug-fix hunk.

> **What exists today.** The `local` corpus source and its **materialiser**, a **verified
> corpus** of real instances (`corpus/`, with a miner in `mine.mjs`), the **arm runner**
> with its **harness registry** (no hand-written command), bounded concurrency, token and
> wall-clock budgets, a dev/held-out split, the `claim.json` contract, and the C1–C12
> arithmetic — tested end-to-end with a stub agent, no network and no model. **What does
> not exist:** the Docker/remote corpus sources (BugsInPy, SWE-bench), a real-model run,
> and therefore **any result**. Do not report a number from here as measured.

The how-to-run contract lives in the skill: [`skills/ducktective-bench/SKILL.md`](../skills/ducktective-bench/SKILL.md).

## Files

| File                      | Role                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `sources.mjs`             | Declared corpus sources, strict input validation, content-addressed `jobId`, instance schema           |
| `agents.mjs`              | Harness registry: which CLI runs an arm, auto-detection, command construction                          |
| `materialize.mjs`         | Load, validate and materialise instances; verify the premise before any arm runs                       |
| `mine.mjs`                | Propose a candidate instance from one fix commit (tests + source changed)                              |
| `run.mjs`                 | Run each arm per instance, score the claim it writes, emit `results.jsonl` + C1–C12                    |
| `report.mjs`              | C1–C12 arithmetic from result rows (`rate`, `computeMetrics`)                                          |
| `opencode-agent.mjs`      | OpenCode v2 adapter: builds the arm prompt (attached as a file), runs `opencode run`, writes the claim |
| `stub-agent.mjs`          | A model-free agent for tests/CI; writes the claim named by `DT_STUB_CLAIM[_<ARM>]`                     |
| `smoke.test.mjs`          | Spec validation and arithmetic                                                                         |
| `agents.test.mjs`         | Command construction, detection, unknown harnesses                                                     |
| `materialize.test.mjs`    | The materialiser, against throwaway git repos                                                          |
| `mine.test.mjs`           | The miner: hunk parsing, runner choice, a candidate from a throwaway repo                              |
| `run.test.mjs`            | The env contract, scoring, pool/budget/split, and end-to-end runs with the stub                        |
| `corpus.test.mjs`         | The shipped corpus parses, validates, and holds both instance kinds                                    |
| `opencode-agent.test.mjs` | The prompt, claim/token parsing, and the dry-run command                                               |

## Instance spec

The narrow task from design §4 — a location and a one-line cause, not a patch:

```json
{
  "id": "local-demo-1",
  "source": "local",
  "repo": "/path/to/buggy/repo",
  "commit": "<buggy-sha>",
  "repro": { "command": "python -m pytest -q tests/test_x.py::test_y" },
  "expect": { "goldHunks": [{ "file": "src/app.py", "start": 120, "end": 128 }] }
}
```

Optional fields: `oracle.command` + `fixCommit` (a host-authored check for a silent bug,
verified to fail at `commit` and pass at `fixCommit`), `testPatch` (copy the fix commit's
changed tests into the buggy checkout — SWE-bench's FAIL_TO_PASS shape), `assets` (files
copied into the checkout), `mode: "clone"|"worktree"` (worktree checks out inside the repo
so the repro keeps its `node_modules`), and `split: "dev"|"heldout"`. See
[`corpus/README.md`](../corpus/README.md).

## Corpus and splits

`corpus/` ships verified real instances. Each carries a `split`: a deterministic **dev**
two-thirds and a **heldout** third. The runner defaults to `--split dev`, so a plain run
**does not touch the held-out third**; ask for it by name (`--split heldout` or `--split
all`) only for a confirmatory run. Split assignment is by instance id, never by outcome.

## Agent contract

The runner picks a harness (`--agent`, else auto-detect) and builds the command itself.
The command runs with cwd = the arm's checkout and must write a JSON claim to `$DT_OUT`
(or write nothing to abstain). The arm **never sees the gold hunks**:

| Env           | Meaning                                |
| ------------- | -------------------------------------- |
| `DT_REPO`     | the checkout to investigate            |
| `DT_ARM`      | `"A"` (bare) or `"B"` (with the skill) |
| `DT_REPRO`    | the failing command                    |
| `DT_OUT`      | where to write `claim.json`            |
| `DT_INSTANCE` | the instance id                        |

```json
{
  "file": "src/app.py",
  "line": 41,
  "cause": "one line",
  "reportable": true,
  "abstained": false,
  "tokens": 1234
}
```

`reportable: true` is the C2 signal — a reportable cause that misses every gold hunk is
a false confirm. One command runs both arms; the only thing the runner injects is
`DT_ARM`, so the arm decides whether it uses the skill.

For any harness without a registry entry, `--agent-cmd "<command>"` is the escape hatch;
it runs with cwd = the clone, so `{bench}` is substituted with this folder's path. A
harness is added to `agents.mjs` only after its headless flags are verified against its
docs — a guessed flag is a wrong measurement.

## Run

```bash
npm test                                                       # smoke + harness + runner tests
node bench/materialize.mjs --instances corpus/ --out work/ --yes
node bench/run.mjs --instances corpus/ --out work/ --yes           # auto-detects the harness
node bench/run.mjs --instance i.json --agent stub --out work/ --yes   # model-free smoke
```

With OpenCode, point the arms at a model through the adapter:

```bash
DT_MODEL="<provider>/<model>" node bench/run.mjs --instances corpus/ --out work/ --yes
```

For the ≥30-instance run, bound the pool and the spend, and run only the dev split:

```bash
DT_MODEL="<provider>/<model>" node bench/run.mjs --instances corpus/ --out work/ \
  --split dev --concurrency 3 --budget-tokens 2000000 --budget-ms 7200000 --run-id 2026-09-21 --yes
```

Every row carries `run`, `model`, `agent` and `split`; the runner prints the JSON report on
stdout and a C1–C5 table on stderr. `--budget-*` stops *starting* arms once the cap is
reached — a stopped arm is a `skipped-budget` row, never a silent omission.

`--auto` (inside the adapter) auto-approves permissions, which is required headless and
acceptable because the checkout is a throwaway clone or worktree. Arm separation is by
prompt; the cleanest split installs the `ducktective` skill only for arm B, or uses
`DT_AGENT_A`/`DT_AGENT_B` for two OpenCode agent profiles. See
[../docs/implementation.md](../docs/implementation.md) Phase 1.

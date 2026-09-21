# Field run — Designer (`C:\Users\adeer\github\designer`)

**Date:** 2026-09-20 · **Commit:** `6e55c0f0` (pre-fix) and `9095f188` (fix) ·
**Branch:** `964-feature-fix-3d-preview-bugs` · **Participant:** the host agent, driven
through the Ducktective tools.

This is the product exercised against a repository it did not author. It is **not** the
Tier-2 two-arm benchmark (design §4) — that needs a corpus and a model; this is one real
investigation, and its receipts are files.

**No code was changed in `designer`.** The investigation ran in a throwaway `git
worktree` at the pre-fix commit; the branch under test was never touched.

## Outcome

One opening-cut bug **identified and confirmed** on the real wire, and the same property
**verified clean** on the fixed revision:

| Revision | Anomalies (real wire, 72 openings) | max `depthOffsetM` |
| --- | --- | --- |
| `6e55c0f0` (pre-fix) | **43** | **4.639 m** |
| `9095f188` (fix) | **0** | **0.025 m** |

Largest offenders on the pre-fix revision: `Door 09-lintel` a 0.90 m-wide strip **18.66 m
deep**; `Door 03-lintel` 2.75 m × **10.27 m**; door/window frames floated up to **4.64 m**
off their host wall. That matches the numbers in the repo's own issue.

**Case:** `DT-260920-c019d0`, cause hash `052d9f5e20eb`, `verdict: confirmed`,
`reportable: true`, `cause_confidence: 0.5`. Stored in the investigated repo at
`designer/.ducktective/` and copied here.

## What the loop actually did

1. **Gate** — `reproduce.mjs` ran the check and, because it exits non-zero with an
   in-repo frame, returned `reproduced` (exit 0). Draft: `DT-260920-c019d0`.
2. **Candidate** — the gate's traceback seed pointed at the check file, which is not the
   bug. The host rewrote candidate 1 to the code the issue names,
   `packages/ifc/writer/src/geometry/openingCuts.ts:288` (the pre-fix host picker), with
   the hypothesis that the `preferExternal` flag was honored without a distance guard.
3. **Falsify** — `run_check.mjs --predict fail` with a control:
   - check: the property check on the real wire → **exit 1** (agrees with the prediction);
   - control: the same check on a synthetic clean wire → **exit 0** (the check is not
     always-fail).
   Both receipts together → `confirmed`.
4. **Store** — `write_case.mjs` validated the schema and the policy and wrote
   `cases.jsonl` + the Markdown mirror.

The call inside the check does not depend on which arm is asking, and the host agent
never wrote a check that merely restated the claim: the oracle is a property over
geometry, and the control proves it can pass.

## The check (the oracle)

`check-openings.ts` hydrates a persisted wire, builds wall and opening specs per storey,
applies the opening cuts, and flags an anomaly when either

- an opening's `depthOffsetM` exceeds half its host wall's thickness + 50 mm (the frame
  floats off the wall), or
- a `*-lintel` / `*-sill` strip's extent along the opening tangent exceeds its width by
  >0.6 m, or its depth through the wall exceeds 0.5 m (a strip bigger than the wall).

It throws when any anomaly exists, so the gate sees a real failure. Source:
[`field-run-designer/check-openings.ts`](field-run-designer/check-openings.ts). The
control is `--synthetic`, a one-room wire with one correctly hosted door.

## Honest limits

- **The oracle is host-authored.** It encodes a geometric property, not the repo's own
  test; a wrong property would confirm a wrong cause. The control rules out always-fail;
  it does not rule out a property that is too loose.
- **No probe.** `--probe` needs the accused line present at `HEAD` of a git checkout;
  the check ran against a worktree of a different commit, so the sensitivity receipt is
  the passing control only.
- **Bisect was skipped** (`--skip-bisect`): the working tree carries untracked files the
  bisect wrapper refuses. The fix commit is corroboration, not a bisect receipt.
- **One repository, one bug.** Nothing here estimates effectiveness; that is the
  benchmark's job.

## Observations (not confirmed cases)

- **Schema under-specifies the wire.** `examplewire.json` openings carry `doorKind`,
  `angleRad` and `orphaned`; the `opening` definition in
  `schemas/state-export-wire.schema.json` (lines 192–206) declares none of them. The
  object has no `additionalProperties: false`, so the wire still validates — this is a
  consumer-visibility gap, not a runtime failure, and it is the issue's own acceptance
  item 5. The authoritative shape lives in the Zod schema in
  `packages/core/src/persistedState.ts`.
- The issue's remaining acceptance items (a `spanningStrip` guard, a `depthOffsetM`
  clamp) were not exercised beyond the property above; on the real wire after the fix
  neither fires.

## Reproduce

```bash
cd C:/Users/adeer/github/designer
git worktree add --detach .dt-base 6e55c0f0
cp examplewire.json .dt-base/
cp docs/field-run-designer/check-openings.ts .dt-base/dt-check-openings.ts
npx tsx .dt-base/dt-check-openings.ts .dt-base/examplewire.json   # exit 1, 43 anomalies
npx tsx .dt-base/dt-check-openings.ts --synthetic                 # exit 0, control
git worktree remove .dt-base --force
```

The gate commands, with `$DT` = `skills/ducktective/scripts`:

```bash
node $DT/reproduce.mjs --cmd "npx tsx .dt-base/dt-check-openings.ts .dt-base/examplewire.json" \
  --cwd . --symptom "3D preview: opening lintels extrude out of the wall" --out .ducktective/draft.json
node $DT/run_check.mjs --file .ducktective/draft.json --candidate 1 --predict fail \
  --cmd "npx tsx .dt-base/dt-check-openings.ts .dt-base/examplewire.json" \
  --control "npx tsx .dt-base/dt-check-openings.ts --synthetic" --cwd . --yes
node $DT/write_case.mjs --file .ducktective/draft.json --repo .
```

## Artifacts

| File | What it is |
| --- | --- |
| [`field-run-designer/DT-260920-c019d0.md`](field-run-designer/DT-260920-c019d0.md) | the case file, as stored |
| [`field-run-designer/cases.jsonl`](field-run-designer/cases.jsonl) | the one-line store record |
| [`field-run-designer/check-openings.ts`](field-run-designer/check-openings.ts) | the oracle, copied out of the worktree |

The investigated repo keeps `.ducktective/` (its own store) — untracked, and safe to
delete.

# Ducktective

**No claim without a check.**

A skill for coding agents (Claude Code, OpenCode, Cursor). Give it a failing command. It
reproduces the failure, tests one suspected cause with a check that could disprove it, and
writes a case file. It does not patch.

## Put it in the repo you are debugging

```bash
git clone https://github.com/adeerkhan/ducktective
node ducktective/skills/ducktective/bin/install.mjs --dest .opencode/skills/ducktective
git add .opencode/skills/ducktective          # commit it so the whole team has the contract
```

Restart the agent, then invoke it by name with the **exact command**:

```
Ducktective: pytest tests/test_cart.py::test_total -q is red. Find the cause. Do not patch.
```

Prefer a global install? One command, then restart — the skill id is `ducktective`.

```bash
node skills/ducktective/bin/install.mjs --target opencode   # or --target claude
```

| Target              | Installs to                                                 |
| ------------------- | ----------------------------------------------------------- |
| `--target opencode` | `~/.config/opencode/skills/ducktective`                     |
| `--target claude`   | `~/.claude/skills/ducktective` (OpenCode reads this too)    |
| `--dest <dir>`      | anywhere else — a repo-local install, Cursor, Copilot, etc. |

## What you get

`.ducktective/cases/<id>.md` — one screen, readable, pasteable under a PR. This is a real
run, trimmed:

```markdown
# DT-260920-c019d0 — 3D preview: opening lintels extrude out of the wall

**Status:** `confirmed` · **Confidence:** high ·
**Reproduction:** `npx tsx dt-check-openings.ts examplewire.json` → `reproduced` (exit 1)
**Cause:** `052d9f5e20eb` (seen 1×)

### 1. `packages/ifc/writer/src/geometry/openingCuts.ts:288` — confirmed

_Hypothesis:_ the host picker honors `preferExternal` with no distance guard, so a door whose
adjacent wall is interior is clipped to an exterior wall metres away.
_Evidence:_ 43 opening-cut anomalies · control: exit 0

**Confirmed cause:** opening host selection at `openingCuts.ts:288`, unguarded.
```

If the command is already green, it stops and says `does_not_reproduce`. That is a feature.

## Two grades

- **`confirmed`** — the check failed as predicted and a `--control` passed (or a `--probe`
  flipped). Enough to act on now: this is the cause.
- **reportable** — a `confirmed` that also carries an **independent** receipt: a `--probe`
  flip, a confirming `--blind` check, or a survived `--verify`. This is the merge-grade
  cause you would stake a review on.

A verdict with no executed check, or one that contradicts its own exit code, never reaches
the store.

## What it is not

Not an agent, not a localizer, not a fixer, not a graph. It drives your repo's own test
runner — no server, no API key, no dependencies beyond Node.

## Status

A demonstration, not a measured win rate: one real bug confirmed in code it did not write,
surviving a re-run. The instrument refuses an unearned `confirmed`. Whether the loop beats
"just fix it" is not yet measured; the comparative benchmark is built but not run.

## Contract

[`skills/ducktective/SKILL.md`](skills/ducktective/SKILL.md) is the whole contract the agent
follows. Deeper: [`docs/guide.md`](docs/guide.md) and
[`docs/architecture.md`](docs/architecture.md).

<details>
<summary>Development</summary>

```bash
npm install        # once: eslint + prettier
npm test           # guards + the skill's tool tests
npm run eval       # behaviour corpus (needs pytest + coverage.py)
npm run lint && npm run format:check
```

Plain `.mjs`, zero dependencies, nothing to build or deploy.

MIT — see [LICENSE](LICENSE). © 2026 Adeer Khan.

</details>

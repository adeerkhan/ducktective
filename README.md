<div align="center">
  <img src="assets/ducktective-hero.jpg" alt="Ducktective — no claim without a check" width="100%">

  <h1>Ducktective</h1>

  <p><strong>No claim without a check.</strong><br>
  A skill for coding agents that turns <em>"I think the bug is in X"</em> into
  <em>"I ran this check, it failed as predicted, here is the cause file."</em></p>
</div>

---

## What it is

Your agent guesses; this makes it prove it. Give it a failing command and it
reproduces the failure, tests one suspected cause with a check that could
disprove it, and writes a case file — naming a cause `confirmed` only when a
check that actually ran backed it up. It does not patch.

It runs inside the agent you already use (Claude Code, OpenCode, Cursor, …) and
drives your repo's own test runner. No server, no API key, no dependencies beyond
Node. It is not an agent, a localizer or a graph — the value is the refusal: a
verdict with no executed check cannot be written down.

## Add it to your harness

**Fastest** — the open [`skills`](https://github.com/vercel-labs/skills) CLI
installs into 70+ agents (Claude Code, OpenCode, Cursor, Codex, …):

```bash
npx skills add adeerkhan/ducktective --skill ducktective
npx skills add adeerkhan/ducktective --list   # browse first
```

**Or from a clone**, into the harness you use:

```bash
git clone https://github.com/adeerkhan/ducktective
node ducktective/skills/ducktective/bin/install.mjs --target opencode   # or claude / agents
```

| Harness                             | Where it lands                                                |
| ----------------------------------- | ------------------------------------------------------------- |
| Claude Code                         | `~/.claude/skills/ducktective` (`--target claude`)            |
| OpenCode                            | `~/.config/opencode/skills/ducktective` (`--target opencode`) |
| Any Agent Skills harness (Codex, …) | `~/.agents/skills/ducktective` (`--target agents`)            |
| One repo only (commit it to share)  | `--dest .opencode/skills/ducktective`                         |

Restart the agent. The skill id is **`ducktective`**.

## Use it

Name it, with the exact failing command:

```
Ducktective: pytest tests/test_cart.py::test_total -q is red. Find the cause. Do not patch.
```

You do not have to name it. The agent sees the skill's description on every turn
and loads it itself when a test fails, a stack trace appears, or you ask for a
root cause — _"this test is red, why?"_ is enough. To make that dependable in a
shared repo, add three lines to the project's `AGENTS.md` (or `CLAUDE.md`):

```markdown
## Debugging

When a test or command fails, use the `ducktective` skill before proposing a fix.
Reproduce the exact failing command, then check one hypothesis at a time.
Do not patch until the case file says `confirmed`.
```

You never type `--probe --blind --predict` yourself — the agent runs the scripts;
you read one file.

## What you get

`.ducktective/cases/<id>.md` — one screen, readable, pasteable under a PR. This
is a real run, trimmed:

```markdown
# DT-260920-c019d0 — 3D preview: opening lintels extrude out of the wall

**CONFIRMED** · Confidence: high
**Reproduction:** `npx tsx dt-check-openings.ts examplewire.json` → `reproduced` (exit 1)
**Cause:** `052d9f5e20eb` (seen 1×)

### 1. `packages/ifc/writer/src/geometry/openingCuts.ts:288` — confirmed

- hypothesis: the host picker honors `preferExternal` with no distance guard, so a door
  whose adjacent wall is interior is clipped to an exterior wall metres away.
- evidence: 43 opening-cut anomalies · control: exit 0

**Confirmed cause:** opening host selection at `openingCuts.ts:288`, unguarded.
```

If the command is green, it stops and says `does_not_reproduce`. That is a feature.

## Two grades

- **`confirmed`** — the check failed as predicted and a `--control` passed (or a
  `--probe` flipped). Enough to act on now: this is the cause.
- **reportable** — a `confirmed` that also carries an **independent** receipt: a
  `--probe` flip, a confirming `--blind` check, or a survived `--verify`. This is
  the merge-grade cause you would stake a review on.

## Status

A demonstration, not a measured win rate: one real bug confirmed in code it did
not write, surviving a re-run. The instrument refuses an unearned `confirmed`.
Whether the loop beats "just fix it" is not yet measured.

## Contract

[`skills/ducktective/SKILL.md`](skills/ducktective/SKILL.md) is the whole contract
the agent follows. Deeper: [`docs/guide.md`](docs/guide.md) and
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

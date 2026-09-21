<div align="center">
  <img src="assets/ducktective-hero.jpg" alt="Ducktective — find it, prove it, fix it" width="100%">

  <h1>Ducktective</h1>

  <p><strong>No claim without a check.</strong><br>
  An <a href="https://agentskills.io/">Agent Skill</a> that finds the root cause of a failing
  test — and proves it before anything gets patched.</p>

  <p>
    <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
    <a href="CHANGELOG.md"><img alt="Version 0.2.0" src="https://img.shields.io/badge/version-0.2.0-blue.svg"></a>
    <a href="https://agentskills.io/"><img alt="Agent Skills" src="https://img.shields.io/badge/Standard-Agent_Skills-blueviolet.svg"></a>
    <img alt="Node 20.19+" src="https://img.shields.io/badge/Node-20.19%2B-green.svg">
  </p>

  <p>
    <a href="#what-it-is">What it is</a> ·
    <a href="#install">Install</a> ·
    <a href="#use-it">Use it</a> ·
    <a href="#how-it-works">How it works</a> ·
    <a href="#the-tools">Tools</a> ·
    <a href="skills/ducktective/SKILL.md">Contract</a>
  </p>
</div>

---

## What it is

Hand it a failing command. It **reproduces** the failure, tests one suspect at a time with a
check that could **disprove** it, and calls a cause `confirmed` only when a check that
actually ran backed it up. You get a case file, not a patch.

```
Ducktective, this test fails — find the cause before proposing a fix.
```

No server, no API key, no dependencies beyond Node. It drives whatever test runner your repo
already uses.

---

## Install

```bash
git clone https://github.com/adeerkhan/ducktective && cd ducktective
node skills/ducktective/bin/install.mjs --target opencode   # or --target claude
```

| Target              | Installs to                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `--target claude`   | `~/.claude/skills/ducktective`                                               |
| `--target opencode` | `~/.config/opencode/skills/ducktective`                                      |
| `--dest <dir>`      | anywhere else — e.g. `.opencode/skills/ducktective` to commit it with a repo |

Restart your agent and it is available by id `ducktective`. Claude Code and OpenCode both find
it; OpenCode also reads `~/.claude/skills`. Re-running updates the files it wrote and refuses
only the ones you edited by hand.

---

## Use it

Ask in plain language — the skill loads itself when the task matches. You can also name it:
_"Use the Ducktective skill: …"_.

| You have                     | Say                                                       |
| ---------------------------- | --------------------------------------------------------- |
| A red test                   | "this test fails — find the cause before proposing a fix" |
| A stack trace, no test       | paste it: "where does this come from?"                    |
| Something that worked before | "it worked at v1.2, broken now"                           |
| A suspected line             | "I think `app.py:41` is wrong — check it"                 |
| A bug you cannot reproduce   | "here is the symptom; it does not fail for me"            |

Any harness that can run a shell command can call the tools directly; the skill is a
convenience, not a runtime. Paths are relative to the installed skill folder:

```bash
node scripts/reproduce.mjs --cmd "npm test" --symptom "checkout test fails" --out .ducktective/draft.json
node scripts/run_check.mjs --file .ducktective/draft.json --candidate 1 --predict fail \
  --control "npm test -- --testNamePattern=health" --blind "<a second, independent check>" --yes
```

---

## How it works

1. **Reproduce** the exact failing command. No in-repo evidence is `error`, not a cause.
2. **Bisect** history if it is a regression, to name the first bad commit.
3. **Falsify** one candidate: a one-line hypothesis, the smallest check that could disprove
   it, a control, a probe that neuters the accused line, and an independent blind check.
4. **Emit** the case file — `.ducktective/cases.jsonl` plus a Markdown mirror.
5. **Stop.** It does not patch.

A `confirmed` verdict is refused unless a check that ran agreed with the prediction, a control
passed or the accused line flipped, **and** a second, independently written check reproduced
it. A hand-typed verdict cannot reach the store.

---

## The tools

| Tool             | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `reproduce.mjs`  | the gate — runs the command and seeds candidates         |
| `bisect.mjs`     | first bad commit, priced and bounded                     |
| `run_check.mjs`  | the oracle, control, probe and blind check → one verdict |
| `write_case.mjs` | the store; refuses unearned verdicts                     |
| `check.mjs`      | all of the above in one graded command                   |

The whole contract the agent follows is one file: [`skills/ducktective/SKILL.md`](skills/ducktective/SKILL.md).

---

## Honest status

It has confirmed a real bug in code it did not write, surviving a re-run. That is a
demonstration, not a rate: no measurement yet shows the loop beats a plain "fix this" prompt.
What is verified is the **instrument** — a verdict cannot be filed unless the arithmetic over
real receipts supports it. The comparative benchmark is built but **not yet run**. Discovery
(traceback order, fail-only coverage) mostly reorders what the host already had; the product
is the forced verification.

---

## Learn more

- [`skills/ducktective/SKILL.md`](skills/ducktective/SKILL.md) — the contract
- [`docs/guide.md`](docs/guide.md) — a worked walkthrough
- [`docs/architecture.md`](docs/architecture.md) — how it is built, and its limits
- [`docs/ducktective-design.md`](docs/ducktective-design.md) — why it is shaped this way

## Development

```bash
npm install        # once: eslint + prettier
npm test           # guards + the skill's tool tests
npm run eval       # behaviour corpus (needs pytest + coverage.py)
npm run lint && npm run format:check
```

Plain `.mjs`, zero dependencies, nothing to build or deploy.

## License

MIT — see [LICENSE](LICENSE). © 2026 Adeer Khan.

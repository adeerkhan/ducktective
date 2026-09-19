# Ducktective

One deliverable: an Agent Skill (a prompt contract, four core programs and one
composition entry point).

```
skills/ducktective/SKILL.md   the product: the contract
skills/ducktective/scripts/   reproduce · bisect · run_check · write_case · check (+ lib/)
skills/ducktective/bin/       the installer
bench/                        comparative benchmark scaffold (metrics; arm runner not built)
docs/                         design v2, landscape (ref-work), reference (architecture),
                              guide, implementation plan, critique
scripts/                      repo guards
evals/                        behaviour corpus + run log
assets/                       hero image
```

There is no website, no plugin manifest and no npm workspace. Those were deleted on
2026-09-15 (§9 of `docs/architecture.md`): maintenance surface for a claim that has
never been measured. Do not re-add presentation before the benchmark in design §4
produces a number worth presenting.

## Commands

Run from the repo root, then `npm install` once:

| Command                                                             | What it does                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm test`                                                          | the skill's tool tests + the repo guards (`node --test`) |
| `npm run eval`                                                      | behaviour corpus in `evals/` (real pytest + coverage.py) |
| `npm run lint` / `npm run format`                                   | gates, both in CI                                        |
| `node skills/ducktective/bin/install.mjs --target claude --dry-run` | what ships, and where                                    |

No dev/build/preview/typecheck: there is no app to build and no TypeScript to check.
The scripts are plain `.mjs`, run with `node`; `node --check` is the type layer.

## Non-negotiables

1. **`skills/ducktective/SKILL.md` is the only copy of the skill.** The installer
   ships it verbatim; `scripts/skill-single-source.test.mjs` fails if a second copy
   appears or a shipped tool goes undocumented in it and in `docs/architecture.md`.
2. **Nothing executes without `--yes`.** A denylist is theatre (any `&&` defeats one),
   so the human reads the exact command first. This is not a sandbox and the docs say
   so in those words.
3. **A verdict is arithmetic, and arithmetic is not enough.** `confirmed` requires
   `predicted` + `check_exit_code` agreeing **and** a discrimination receipt: a
   `--control` that passed (not always-fail) or a `--probe` that flipped (not
   always-pass, not always-irrelevant). `write_case.mjs` refuses otherwise. An
   always-pass oracle agreeing with its own prediction is the confident wrong answer
   this project exists to catch, in its own tooling.
4. **The store is append-mostly** — one line per case id in
   `<repo>/.ducktective/cases.jsonl`, rewritten in place, plus a Markdown mirror a
   human reads in 30 seconds, plus a cause index in `.ducktective/causes.jsonl`
   where a repeated root cause increments a count. A file piled with copies of every
   half-answer is worse tomorrow.
5. **No claim without a check.** Verify behaviour in a test or a real run before
   reporting it done; prose and screenshots are not evidence. Every number on a page
   carries a source and a date, and every metric states its provenance.
6. **Real measurement outranks product work.** A defect that corrupts a verdict, a
   ranking, or a metric's capture path is P0 and outranks the backlog. New product
   surface waits.

## Where things are

- Skill contract (hard rules, case-file template): `skills/ducktective/SKILL.md`
- Executable half: `skills/ducktective/scripts/*.mjs` — `reproduce.mjs` is the gate
  (exit 1 = stop), `bisect.mjs` turns a regression into a commit and grades a claim
  against it, `run_check.mjs` is the oracle + control + probe, `write_case.mjs` is
  the store and the enforcement point. Shared internals: `scripts/lib/`.
- Tests: `skills/ducktective/tests/`; behaviour corpus: `evals/cases/`; run ledger:
  `evals/RUNLOG.jsonl` read with `node evals/runlog.mjs --report`.
- Case-file shape: `skills/ducktective/case-file.schema.json`, `additionalProperties:
false` at every level.
- The whole system in one file: `docs/architecture.md`. Update it when you add a tool
  or change a status; a guard fails when a shipped tool goes unmentioned.
- Why it is shaped this way: `docs/ducktective-design.md` (v2 — the redirection) and
  `docs/ref-work.md`; the objection this project was judged against is kept verbatim
  in `docs/critique-2026-09-15.md`.
- Research clones for comparison: `ref/` (gitignored — never import from here).

## CI

`.github/workflows/eval.yml` typechecks nothing, installs pytest and coverage.py,
and runs `npm test` + `npm run eval`. There is no deploy workflow: nothing to deploy.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community
structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- **Never let a tool add `docs/` to `.gitignore`.** It has happened four times in this repo family; `docs/architecture.md` is read by the guard suite and `git add -f docs` is the repair, not the ignore rule.

<!-- HABIT-EXPERIMENT:START (added 2026-09-17, safe to delete wholesale) -->

## Habit experiment rules (temporary, removable)

This block exists only to check whether an OpenCode session follows AGENTS.md
rules without being told in the prompt. It is test scaffolding, not ducktective
guidance. Delete the whole marked block when the experiment is over, or run:
`node C:/Users/adeer/github/openchamber-habit/scripts/spike0.mjs remove C:/Users/adeer/github/ducktective/AGENTS.md`

1. Every answer to "what is 2+2" must be exactly `4 (spike-zero)` — nothing else.
2. When asked to greet, reply with exactly `hello from AGENTS.md` — nothing else.
3. End every reply with the line `habit-rule-ok`.

Scoring (decided in advance, per habit-architecture.md §4):

- 1 point per rule followed, per session. A session passes at 3/3.
- Three fresh sessions; the project file passes only if all three are 3/3.
- A no-rules baseline must score 0/3. If a rule is followed without the rules
  file, that comparison is void — the rule tests nothing.
- Report the counts as measured. Do not retry until green.

<!-- HABIT-EXPERIMENT:END -->

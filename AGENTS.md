# Ducktective

Two deliverables in one repo, deliberately separated:

```
skills/ducktective/SKILL.md   the product: an Agent Skill (prompt contract)
docs/                        design rationale + the literature critique
site/                        the marketing/demo website → GitHub Pages (static)
scripts/                     repo-level checks
```

`skills/` and `site/` are peers; the website is a _presentation_ of the skill,
never its owner. npm workspaces makes `site/` an install target from the root.

## Commands

Run from the repo root — `npm install` once, then:

| Command                                                 | What it does                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `npm run dev`                                           | Vite dev server on `0.0.0.0:8080`, served under `/ducktective/` |
| `npm run build`                                         | Static build to `site/dist` (+ `skill/SKILL.md`, `404.html`)    |
| `npm run preview`                                       | Serve `site/dist` on `127.0.0.1:8081`                           |
| `npm test`                                              | Guards + the skill's tool tests (`node --test`)                 |
| `npm run eval`                                          | Behaviour corpus in `evals/` (needs pytest + coverage.py)       |
| `npm run typecheck` / `npm run lint` / `npm run format` | gates, all run in CI                                            |

`SITE_BASE` overrides the deploy prefix (`SITE_BASE=/ npm run dev` for a
root-mounted host). Default `/ducktective/` = project page.

## Non-negotiables

1. **`skills/ducktective/SKILL.md` is the only copy of the skill.** The site
   reads it with `?raw` and the same file is served at
   `<base>skill/SKILL.md`. Never paste its text into `site/src/` —
   `scripts/skill-single-source.test.mjs` fails the build if you do.
2. **The site is static.** GitHub Pages runs no server, so there is no server
   function, no database, no auth, no SSR. The whole workbench runs in the
   browser: `site/src/lib/engine` (reproduce → rank → falsify → close) over
   fixtures in `site/src/lib/bugs/catalog.ts`, and the rap sheet in
   `localStorage`. Adding a server means changing the deploy target, not adding
   an endpoint — decide that out loud first.
3. **Base path lives in two places on purpose.** `base` in `site/vite.config.ts`
   prefixes asset URLs; `basepath` in `site/src/main.tsx` (derived from
   `import.meta.env.BASE_URL`, so it follows `base`) makes route matching work.
   Hardcoded absolute URLs (`href="/x"`) break both — use
   `${import.meta.env.BASE_URL}…`.
4. **Deep links need `404.html`.** The build copies the SPA shell to
   `site/dist/404.html` because Pages has no history-fallback rewrite. Don't
   delete that copy step.
5. **No claim without a check.** The skill's own rule applies to this repo:
   verify behaviour in a browser or a test before reporting it done; screenshots
   and prose are not evidence.

## Deploy

`.github/workflows/deploy-site.yml` typechecks, tests, lints, builds, and
publishes `site/dist` via Pages Actions. First enable: repo **Settings → Pages
→ Source: GitHub Actions**. Live URL: `https://adeerkhan.github.io/ducktective/`.

## Where things are

- Skill contract (hard rules, case file schema): `skills/ducktective/SKILL.md`
- Executable half of the skill: `skills/ducktective/scripts/*.mjs` — zero deps, run
  with plain `node`. `reproduce.mjs` is the gate (exit 1 = stop), `run_check.mjs`
  runs the oracle and decides the verdict by arithmetic (exit 3 = dry run, nothing
  executed), `query_memory.mjs` is the rap sheet, `write_case.mjs` is the
  enforcement point. Tests: `skills/ducktective/tests/`. Behaviour corpus:
  `evals/` (`npm run eval`, results in `evals/RESULTS.md`).
- Shape of a case file: `skills/ducktective/case-file.schema.json`. The site reads
  it through `site/src/lib/engine/case-import.mjs`, and
  `scripts/site-case-sync.test.mjs` fails when the schema gains a field the site
  would silently drop — so the demo cannot disagree with the product.
- Two decisions are settled, don't relitigate them in code: nothing executes
  without `--yes` (a denylist is theatre; SKILL.md says "not a sandbox" in those
  words), and the store is append-mostly — one line per case id, rewritten in
  place — because a file piled with copies of every half-answer is worse tomorrow.
- Why it's shaped this way: `docs/ducktective-design.md`
- Prior art and the critique of the original design: `docs/ref-work.md`
- Research clones for comparison: `ref/` (gitignored — never import from here)

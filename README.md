# Ducktective

**No claim without a check.** A verification-and-evidence skill for coding
agents: reproduce first, falsify candidates with a runnable check, emit a
structured case file. Not a runtime, not a chatbot — a contract the host agent
is forced through.

- Skill: [`skills/ducktective/SKILL.md`](skills/ducktective/SKILL.md)
- Site (live demo + protocol + rap sheet): <https://adeerkhan.github.io/ducktective/>
- Design rationale: [`docs/ducktective-design.md`](docs/ducktective-design.md)

## Install the skill

Copy `skills/ducktective/SKILL.md` into your agent's skills directory:

```
~/.claude/skills/ducktective/SKILL.md        # Claude Code
.agents/skills/ducktective/SKILL.md          # repo-local, Cursor / Codex / etc.
```

Or fetch it:

```
curl -o SKILL.md https://adeerkhan.github.io/ducktective/skill/SKILL.md
```

Then invoke it: _"Ducktective, investigate this failing test."_

## Repo layout

| Path                  | What it is                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `skills/ducktective/` | The product. `SKILL.md` is its only copy in the repo.                                      |
| `site/`               | Static marketing + demo website (Vite + React + TanStack Router) deployed to GitHub Pages. |
| `docs/`               | Design document and the reference/critique review.                                         |
| `scripts/`            | Repo-level checks (`node --test`) that guard the layout.                                   |
| `.github/workflows/`  | `deploy-site.yml` → typecheck, test, lint, build, publish `site/dist`.                     |

## Develop the site

```bash
npm install          # once, at the repo root (workspaces → site/)
npm run dev          # http://localhost:8080/ducktective/
npm run build        # static output in site/dist (plus 404.html + skill/SKILL.md)
npm test             # layout guards
npm run lint && npm run typecheck
```

The workbench is fully client-side: five fixtures run real programs in the
browser, coverage is collected, checks execute, and the rap sheet lives in
`localStorage`. No server, no database, no auth — see `AGENTS.md` for why that's
a hard rule.

## License

MIT

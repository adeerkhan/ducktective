#!/usr/bin/env node
/**
 * bisect — turn a reproducing command into a commit.
 *
 *   node scripts/bisect.mjs --cmd "pytest tests/test_cache.py::test_cold -x" \
 *     --claim "candidate.py:411" --budget 120 --yes
 *
 * Everything else in this skill grades a claim somebody already made. This is the
 * one place that produces new information the host agent does not have: for any
 * regression, `git bisect` names the commit that broke it, in O(log n) runs, with
 * no model in the loop and no opinion to defend.
 *
 * The output is a fact plus a comparison:
 *
 *   first_bad_commit        the commit that introduced the failure
 *   touched                 its files with the line ranges it changed
 *   claim                   the location being accused, parsed from `--claim`
 *   claim_in_commit         yes | no | n-a — does the claim sit inside a hunk the
 *                           bisect just blamed? A file match is not the point; an
 *                           agent that names the right file and the wrong function
 *                           has not found the cause.
 *
 * Honesty, printed rather than documented: it only works on regressions (the
 * command must have passed at some commit), it needs a buildable history, and it
 * is worthless for a bug that was always there. `no-good-ref` and `skipped` are
 * findings, not failures.
 *
 * It runs in YOUR working tree, because a scratch worktree would not have the
 * untracked `.venv` / `node_modules` the repro needs. So it refuses a dirty tree
 * and refuses to start on a repo already mid-bisect, and it restores the branch
 * (or the commit, on a detached HEAD) it started from. The search is driven here
 * rather than by `git bisect run`, because that would need a shell wrapper and the
 * shell differs per platform — a binary search over `git rev-list` is 20 lines and
 * leaves no bisect state behind. Exit codes: 0 found, 1 refused, 2 inconclusive, 3 dry run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { numFlag } from "./lib/args.mjs";
import { repoRoot, writeAtomic } from "./lib/case-file.mjs";
import { run, wasNotRunnable } from "./lib/exec.mjs";

const USAGE = `usage: bisect.mjs --cmd CMD [options]
  --cmd CMD        the reproducing command; non-zero exit means the bug is present
  --good REF       a known-good commit (default: walk back HEAD~1,2,4,8... and test)
  --bad REF        a known-bad commit (default: HEAD)
  --claim LOC      the location being accused, e.g. app.py:41 or "app.py:41 fn()"
  --repo DIR       repo to bisect (default: walk up to .git from here)
  --repeat N       run the command N times per revision; disagreement = flaky (default 1)
  --budget SEC     refuse if the estimated wall clock exceeds this (default 600)
  --timeout MS     kill a single run after this long; a timeout counts as skip (default 120000)
  --out FILE       write the result JSON here as well as to stdout
  --yes            actually move HEAD around; without it this is a dry run (exit 3)`;

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return null;
  }
  const opts = {
    good: null,
    bad: "HEAD",
    repeat: 1,
    budget: 600,
    timeout: 120_000,
    claim: null,
    repo: null,
    out: null,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`expected a --flag, got "${flag}"\n\n${USAGE}`);
    if (flag === "--yes") {
      opts.yes = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value\n\n${USAGE}`);
    switch (flag) {
      case "--cmd":
        opts.cmd = value;
        break;
      case "--good":
        opts.good = value;
        break;
      case "--bad":
        opts.bad = value;
        break;
      case "--claim":
        opts.claim = value;
        break;
      case "--repo":
        opts.repo = resolve(value);
        break;
      case "--repeat":
        opts.repeat = numFlag("--repeat", value, { max: 5 });
        break;
      case "--budget":
        opts.budget = numFlag("--budget", value, { min: 0 });
        break;
      case "--timeout":
        opts.timeout = numFlag("--timeout", value, { min: 1000 });
        break;
      case "--out":
        opts.out = value;
        break;
      default:
        throw new Error(`unrecognised flag: ${flag}\n\n${USAGE}`);
    }
  }
  if (!opts.cmd)
    throw new Error(`--cmd is required — bisect needs something that fails\n\n${USAGE}`);
  if (!opts.repo) opts.repo = repoRoot(process.cwd());
  return opts;
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** Classify one reproduction run the way `git bisect run` wants it. */
function grade(code, timedOut) {
  if (timedOut || code === 125) return "skip";
  return code === 0 ? "good" : "bad";
}

/** `app.py:41 fn()` → {file:"app.py", line:41}; `app.py` → line null. */
function splitClaim(claim) {
  const tok = String(claim ?? "")
    .trim()
    .split(/\s+/)[0];
  const m = /^(.*?):(\d+)(?:[-,]\d+)?$/.exec(tok);
  if (m) return { file: m[1], line: Number(m[2]) };
  // A bare word is not a file either: without a dot or a slash there is nothing
  // to compare against a diff, and scoring it as "that file was not touched"
  // would turn a malformed claim into a finding.
  if (!/[./\\]/.test(tok)) return { file: null, line: null };
  return { file: tok, line: null };
}

/**
 * Is the accused location inside what this commit changed?
 *
 * `touched` is `git show --format= -U0` parsed into {file, lines:[start,end]}.
 * A claim of `app.py:41` matches when `app.py` is in the diff and 41 falls in one
 * of its hunks; a claim that names only a file matches on the file.
 */
export function claimInCommit(claim, touched) {
  if (!claim) return { verdict: "n-a", why: "no --claim given; the commit stands alone" };
  const { file, line } = splitClaim(claim);
  if (!file) return { verdict: "n-a", why: `--claim "${claim}" is not a file or file:line` };
  const hits = touched.filter((t) => t.file === file || t.file.endsWith("/" + file));
  if (!hits.length)
    return { verdict: "no", why: `${file} is not among the ${touched.length} files it touched` };
  if (!line) return { verdict: "yes", why: `${file} is in the diff (no line given to compare)` };
  const n = line;
  const inHunk = hits.find((h) => h.lines.some(([a, b]) => n >= a && n <= b));
  return inHunk
    ? { verdict: "yes", why: `${file}:${n} sits inside a hunk this commit changed` }
    : {
        verdict: "no",
        why: `${file} is touched, but not line ${n} (hunks: ${hits
          .flatMap((h) => h.lines.map(([a, b]) => `${a}-${b}`))
          .join(", ")})`,
      };
}

/** `git show --format= -U0 --no-pager` → [{file, lines:[[start,end],…]}]. */
export function parseTouched(diff) {
  const out = [];
  let cur = null;
  for (const line of (diff ?? "").split(/\r?\n/)) {
    const f = /^\+\+\+ b\/(.*)$/.exec(line);
    if (f) {
      cur = { file: f[1].trim(), lines: [] };
      out.push(cur);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      cur.lines.push([start, count === 0 ? start : start + count - 1]);
    }
  }
  return out.filter((t) => !t.file.startsWith("a/dev/null"));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;
  const repo = opts.repo;
  if (git(["rev-parse", "--git-dir"], repo).code !== 0)
    throw new Error(`${repo} is not a git repository — bisect needs history to walk`);
  if (existsSync(join(repo, ".git", "BISECT_LOG")))
    throw new Error("a bisect is already in progress — finish or `git bisect reset` it first");
  const dirty = git(["status", "--porcelain"], repo);
  if (dirty.code !== 0) throw new Error(`git status failed: ${dirty.err}`);
  // Only the untracked root-level case store is exempt, never tracked edits.
  const dirt = dirty.out.split("\n").filter((line) => line && line !== "?? .ducktective/");
  if (dirt.length)
    throw new Error(
      `the tree has uncommitted changes (${dirty.out.split("\n").length} files) — bisect checks out other commits, so commit or stash them first`,
    );

  const repro = async (cwd) => {
    const results = [];
    for (let i = 0; i < opts.repeat; i++) {
      const r = await run(opts.cmd, { cwd, timeout: opts.timeout });
      if (wasNotRunnable(r))
        return {
          cls: "skip",
          notRunnable: true,
          code: r.code,
          note: "the command could not be run at all",
        };
      results.push(grade(r.code, r.timedOut));
    }
    const kinds = new Set(results);
    if (kinds.size > 1) return { cls: "flaky", results };
    return { cls: [...kinds][0], results };
  };

  // What to put back at the end: the branch if there is one, the commit if HEAD
  // was already detached (a detached HEAD has no branch to return to).
  const restore =
    git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo).out ||
    git(["rev-parse", "HEAD"], repo).out;
  const badSha = git(["rev-parse", opts.bad], repo);
  if (badSha.code !== 0) throw new Error(`--bad ${opts.bad} does not resolve: ${badSha.err}`);

  // One measured run prices the whole search, and prices it honestly: log2(n)
  // steps, times --repeat, times the observed duration.
  const at = async (ref) => {
    const co = git(["checkout", "--quiet", "--detach", ref], repo);
    if (co.code !== 0) throw new Error(`checkout ${ref} failed: ${co.err}`);
    return repro(repo);
  };
  if (!opts.yes) {
    console.error(
      JSON.stringify(
        {
          command: opts.cmd,
          good: opts.good,
          bad: badSha.out,
          estimated_runs: null,
          budget_seconds: opts.budget,
        },
        null,
        2,
      ),
    );
    console.error("DRY RUN — nothing executed or checked out. Re-run with --yes.");
    process.exitCode = 3;
    return;
  }
  try {
    const t0 = Date.now();
    const probe = await at(badSha.out);
    const perRun = (Date.now() - t0) / opts.repeat;
    if (probe.cls === "skip") {
      git(["checkout", "--quiet", "--detach", badSha.out], repo);
      console.log(
        JSON.stringify(
          {
            bisected: false,
            reason: "the command did not run at all — fix the repro before blaming history for it",
            note: probe.note,
            exit_code: probe.code ?? null,
          },
          null,
          2,
        ),
      );
      process.exitCode = 2;
      return;
    }
    if (probe.cls === "good") {
      git(["checkout", "--quiet", "--detach", badSha.out], repo);
      console.log(
        JSON.stringify(
          {
            bisected: false,
            reason: `the command passed at ${opts.bad}, so there is nothing here to bisect — reproduce it first (that is the gate's job, not this one's)`,
          },
          null,
          2,
        ),
      );
      process.exitCode = 2;
      return;
    }

    let good = opts.good;
    const walked = [];
    if (good) {
      const g = await at(good);
      if (g.cls !== "good")
        throw new Error(
          `--good ${good} does not pass the repro (${g.cls}); bisect needs a real green ref`,
        );
    } else {
      // Doubling back is a guess at the floor of the regression, not a search for
      // the first one: it finds _a_ good ref, cheaply, and says which it used.
      // Resolve every candidate ref to a sha BEFORE checking anything out: `HEAD~4`
      // means a different commit once HEAD has been moved by the previous probe, and
      // a walk that re-anchors itself stops early and reports no-good-ref wrongly.
      // The chain is the first-parent order the search will use, so the walk can
      // also fall back to the chain's oldest commit when the grid overshoots.
      const chain = git(["rev-list", "--first-parent", badSha.out], repo)
        .out.split("\n")
        .filter(Boolean);
      for (let step = 1; step <= 1024; step *= 2) {
        const ref = `${badSha.out}~${step}`;
        const sha = git(["rev-parse", "--verify", "-q", `${badSha.out}~${step}`], repo);
        if (sha.code !== 0) {
          // The grid overshot the history's end. The root itself is the one
          // candidate the grid may have skipped between its last probe and
          // history's end; test it before declaring the bug always-there.
          const root = chain.at(-1);
          if (root && step > 1 && root !== sha.out) {
            const rg = await at(root);
            walked.push({ ref: `${root.slice(0, 10)} (root)`, cls: rg.cls });
            if (rg.cls === "flaky") {
              console.log(
                JSON.stringify(
                  {
                    bisected: false,
                    flaky: true,
                    reason:
                      "the repro disagreed with itself while finding a green ancestor — a boundary would be a guess",
                    walked,
                  },
                  null,
                  2,
                ),
              );
              process.exitCode = 2;
              return;
            }
            if (rg.cls === "good") {
              good = root;
              break;
            }
          }
          break;
        }
        const g = await at(sha.out);
        walked.push({ ref, cls: g.cls });
        if (g.cls === "flaky") {
          console.log(
            JSON.stringify(
              {
                bisected: false,
                flaky: true,
                reason:
                  "the repro disagreed with itself while finding a green ancestor — a boundary would be a guess",
                walked,
              },
              null,
              2,
            ),
          );
          process.exitCode = 2;
          return;
        }
        if (g.cls === "good") {
          good = sha.out;
          break;
        }
      }
    }
    if (!good) {
      git(["checkout", "--quiet", "--detach", badSha.out], repo);
      console.log(
        JSON.stringify(
          {
            bisected: false,
            reason:
              "no-good-ref: the command failed at every revision walked back — this looks like a bug that was always there, which bisect cannot answer",
            walked,
          },
          null,
          2,
        ),
      );
      process.exitCode = 2;
      return;
    }

    // The range is the first-parent chain sliced between good and bad: newest-
    // first, range[0] is the commit we already measured bad, and virtual index
    // range.length is `good`. "is bad" is monotone along that array — newer
    // bad, older good — so a binary search finds the boundary in ceil(log2 n)
    // runs. No `--no-merges`: dropping merges leaves side-branch parents
    // interleaved by date, which is not a history order and lets the search
    // blame an innocent commit. First-parent order is the line, and it is the
    // same order the discovery walk used.
    const chainAll = git(["rev-list", "--first-parent", badSha.out], repo)
      .out.split("\n")
      .filter(Boolean);
    const idx = chainAll.indexOf(good);
    if (idx < 0)
      throw new Error(
        `--good ${good.slice(0, 12)} is not a first-parent ancestor of ${badSha.out.slice(0, 10)} — the walk cannot order the regression`,
      );
    const count = idx; // commits strictly newer than `good` on the chain
    const steps = Math.max(1, Math.ceil(Math.log2(Math.max(count, 2))) + 1);
    const estimate = (steps * opts.repeat * perRun) / 1000;
    // The budget covers the whole wall clock the tool spends, not just the
    // planned search: discovery (probe + green-ref walk) has already run by
    // this point and belongs on the same ledger.
    const discoveryMs = Date.now() - t0;
    const plan = {
      good,
      bad: badSha.out,
      revisions_between: count,
      repeat: opts.repeat,
      measured_run_ms: Math.round(perRun),
      discovery_seconds: Math.round(discoveryMs / 100) / 10,
      estimated_runs: steps * opts.repeat,
      estimated_seconds: Math.round(estimate),
      budget_seconds: opts.budget,
    };
    if (estimate + discoveryMs / 1000 > opts.budget) {
      console.log(
        JSON.stringify(
          {
            refused: true,
            ...plan,
            why: `the walk is estimated at ${Math.round(estimate)}s (plus ${Math.round(discoveryMs / 100) / 10}s already spent finding the green ref), over the --budget of ${opts.budget}s`,
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }
    const range = chainAll.slice(0, idx);
    let firstBad = null;
    let flaky = false;
    let skips = 0;
    let lo = 0;
    let hi = range.length;
    try {
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const r = await at(range[mid]);
        if (r.cls === "flaky") {
          flaky = true;
          break;
        }
        // A skip cannot move either measured boundary. Stop conservatively.
        if (r.cls === "skip") {
          skips++;
          break;
        }
        if (r.cls === "bad") lo = mid;
        else hi = mid;
      }
      if (!flaky && skips === 0) {
        const cand = await at(range[lo]);
        if (cand.cls === "flaky") flaky = true;
        else if (cand.cls === "bad") firstBad = range[lo];
      }
    } finally {
      git(["checkout", "--quiet", restore], repo);
    }

    if (flaky) {
      console.log(
        JSON.stringify(
          {
            bisected: false,
            flaky: true,
            ...plan,
            reason: "the repro disagreed with itself across repeats — a commit would be a guess",
          },
          null,
          2,
        ),
      );
      process.exitCode = 2;
      return;
    }
    if (!firstBad) {
      console.log(
        JSON.stringify(
          {
            bisected: false,
            ...plan,
            reason: "the walk ended without a proven boundary",
            skips,
            interval: [hi === range.length ? good : range[hi], range[lo]],
          },
          null,
          2,
        ),
      );
      process.exitCode = 2;
      return;
    }

    const meta = git(
      ["show", "--no-patch", "--format=%h%x09%s%x09%an%x09%ad", "--date=short", firstBad],
      repo,
    );
    const [sha_short, subject = "", author = "", date = ""] = meta.out.split("\t");
    const touched = parseTouched(
      git(["--no-pager", "show", "--format=", "-U0", firstBad], repo).out,
    );
    const claim = claimInCommit(opts.claim, touched);
    const result = {
      bisected: true,
      first_bad_commit: { sha: firstBad, short: sha_short, subject, author, date },
      touched: touched.map((t) => ({
        file: t.file,
        lines: t.lines.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)),
      })),
      claim: opts.claim ?? null,
      claim_in_commit: claim.verdict,
      claim_why: claim.why,
      skipped_revisions: skips,
      ...plan,
      caveat:
        "bisect finds the commit that made the test fail, which is not always the commit that introduced the bug — an enabling change can expose an older one",
    };
    console.log(JSON.stringify(result, null, 2));
    if (opts.out) {
      mkdirSync(dirname(resolve(opts.out)), { recursive: true });
      writeAtomic(resolve(opts.out), JSON.stringify(result, null, 2) + "\n");
    }
    process.exitCode = 0;
  } finally {
    const restored = git(["checkout", "--quiet", restore], repo);
    if (restored.code !== 0) {
      console.error(`could not restore ${restore}: ${restored.err}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch((err) => {
    console.error(`[ducktective] bisect failed: ${err.message}\n\n${USAGE}`);
    process.exitCode = 1;
  });

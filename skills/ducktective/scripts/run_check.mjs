#!/usr/bin/env node
/**
 * run_check — execute the oracle, arithmetic the verdict.
 *
 *   node skills/ducktective/scripts/run_check.mjs \
 *     --file .ducktective/draft.json --candidate 1 \
 *     --predict fail --control "python -c 'from app import total; total([1,2,3,4], 0, 2)'" --yes
 *
 * The model states a hypothesis and the smallest check that would DISPROVE it;
 * this tool runs that check and decides the verdict from two facts: what the
 * hypothesis predicted, and what the process actually returned.
 *
 *   --predict fail  + exit != 0   →  confirmed   (the check broke as predicted)
 *   --predict fail  + exit == 0   →  falsified   (the oracle held; demote it)
 *   --predict pass  + exit == 0   →  confirmed
 *   --predict pass  + exit != 0   →  falsified
 *
 * SKILL.md rule 4 and rule 6 stop being prose here: a verdict with no recorded
 * exit code cannot be stored, and a verdict that contradicts its own exit code
 * cannot be stored either (`write_case.mjs` refuses both).
 *
 * Exit codes: 0 = verdict recorded, 1 = refused (state/sequence), 2 = the check
 * could not be evaluated, 3 = DRY RUN, nothing executed.
 *
 * NOT A SANDBOX. `--cmd` is a model-authored command run through the user's
 * shell in the user's repo. That is why nothing executes without `--yes`: the
 * human sees the exact command first. Nothing here inspects it for nastiness —
 * a denylist that any `&&` or backtick defeats is worse than none, because it
 * reads as safety. Quote for *your* shell: single quotes are not quoting on
 * `cmd.exe`, and a mangled `--control` will honestly come back `inconclusive`
 * rather than pretend to be an oracle.
 */
import { numFlag } from "./lib/args.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { CASE_ID, clip, repoRoot, SCHEMA, validateSchema, writeAtomic } from "./lib/case-file.mjs";
import { run, wasNotRunnable } from "./lib/exec.mjs";
import { classifyVerdict, predictionHeld } from "./lib/verdict-policy.mjs";

const USAGE = `usage: run_check.mjs --file DRAFT.json --candidate RANK|LOCATION --predict pass|fail [options]
  --yes                execute the check (default: dry run, prints it and exits 3)
  --cmd COMMAND        override the candidate's recorded check
  --control COMMAND    known-good command that must pass, or the check is no oracle (rule 5)
  --hypothesis TEXT    state the claim here if the draft does not carry one
  --depth N            highest candidate rank this run may touch (default 2; 1 = never escalate)
  --verify             re-execute a decided candidate's own check and report whether it survives
  --lang py|js|sh      how to run a multi-line check (default: sniff the shebang)
  --probe              neuter the accused line on a scratch worktree and re-run the
                       check; if the outcome does not change the check never
                       depended on that line (inconclusive_vacuous)
  --blind COMMAND      a second check, written without this run's context; run_check
                       executes and records it, and a non-reproduction demotes the
                       verdict to "unreplicated" (required before a case can be
                       filed as confirmed)
  --cwd DIR            where to run (default: the draft's directory)
  --timeout MS         kill the whole tree after this long (default: 60000)
  --max-bytes N        evidence budget per stream (default: 4000)
  --rerun              re-execute a candidate that already has a verdict
  --escalate           move past a candidate whose check never answered
  --keep               leave a materialized multi-line check script in the repo`;

const EXT = { py: "py", js: "mjs", sh: "sh" };
const INTERPRETER = { py: "python", js: "node", sh: "sh" };

/** Header `materialize()` records above the source it ran. Not runnable code. */
const SCRIPT_HEADER =
  "   # script written to the repo root for this run; --keep leaves it in place";

/**
 * The source of a recorded check, without the command line recorded above it.
 *
 * `check` holds `<runner command> + header + source` so a human can see what
 * ran. Feeding that field back in — which is all `--verify` and `--rerun` can
 * do — made the runner command the script's first line, so a multi-line check
 * died on a SyntaxError and M3 ("did the claim survive a second run") was
 * unanswerable for every check longer than one line.
 */
export function checkSource(check) {
  const [head, ...rest] = (check ?? "").split("\n");
  return rest.length && head.endsWith(SCRIPT_HEADER) ? rest.join("\n") : (check ?? "");
}

/**
 * Which python runs the check: the repo's own, if it has one.
 *
 * `python` on PATH is the machine's, and a repo whose deps live in `.venv` has
 * them nowhere near it. On this machine that turned a real `confirmed` into a
 * `falsified` on the strength of `ModuleNotFoundError: No module named 'pytest'`
 * — the hypothesis was never tested. The venv layout is a filesystem fact, so it
 * is read here instead of being guessed at from PATH.
 */
function pythonFor(repo) {
  for (const rel of [
    join(".venv", "Scripts", "python.exe"),
    join(".venv", "bin", "python"),
    join("venv", "Scripts", "python.exe"),
    join("venv", "bin", "python"),
  ]) {
    if (existsSync(join(repo, rel))) return join(repo, rel);
  }
  return INTERPRETER.py;
}

function parseArgs(argv) {
  const opts = { cwd: null, timeout: 60_000, maxBytes: 4000 };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return null;
  }
  const bools = new Set(["--yes", "--rerun", "--keep", "--escalate", "--verify", "--probe"]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`expected a --flag, got "${flag}"\n\n${USAGE}`);
    if (bools.has(flag)) {
      opts[flag.slice(2)] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value\n\n${USAGE}`);
    switch (flag) {
      case "--file":
        opts.file = value;
        break;
      case "--candidate":
        opts.candidate = /^-?\d+$/.test(value) ? Number(value) : value;
        break;
      case "--predict":
        if (value !== "pass" && value !== "fail")
          throw new Error(
            '--predict is "pass" or "fail" — say what the check must do if the hypothesis is true',
          );
        opts.predict = value;
        break;
      case "--cmd":
        opts.cmd = value;
        break;
      case "--control":
        opts.control = value;
        break;
      case "--blind":
        opts.blind = value;
        break;
      case "--depth":
        // 1 = one candidate, never escalate. The range goes in the message because
        // the reader who has to retry is an agent parsing stderr.
        opts.depth = numFlag("--depth", value, {
          max: 5,
          hint: "a whole number 1-5 (1 = one candidate, never escalate)",
        });
        break;
      case "--hypothesis":
        opts.hypothesis = value;
        break;
      case "--lang":
        if (!(value in EXT))
          throw new Error(`--lang must be one of ${Object.keys(EXT).join(", ")}`);
        opts.lang = value;
        break;
      case "--repo":
        opts.repo = resolve(value);
        break;
      case "--cwd":
        opts.cwd = resolve(value);
        break;
      case "--timeout":
        opts.timeout = numFlag("--timeout", value, { hint: "a positive whole number of ms" });
        break;
      case "--max-bytes":
        opts.maxBytes = numFlag("--max-bytes", value);
        break;
      default:
        throw new Error(`unrecognised flag: ${flag}\n\n${USAGE}`);
    }
  }
  if (!opts.file || opts.candidate === undefined || (!opts.predict && !opts.verify)) {
    throw new Error(
      `--file and --candidate are required, plus --predict (or --verify, which reuses the recorded one)\n\n${USAGE}`,
    );
  }
  if (opts.verify && opts.predict)
    throw new Error(
      "--verify re-tests the recorded prediction; drop --predict so a second guess cannot move the answer",
    );
  if (opts.verify && opts.cmd !== undefined)
    throw new Error("--verify re-tests the recorded check; --cmd cannot replace it");
  return opts;
}

/** By rank (1-based) or by a unique substring of `location`. */
export function pickCandidate(candidates, wanted) {
  if (typeof wanted === "number") {
    const hit = candidates.find((c) => c.rank === wanted);
    return hit ? { cand: hit, index: candidates.indexOf(hit) } : null;
  }
  const hits = candidates.filter((c) => (c.location ?? "").includes(wanted));
  if (hits.length !== 1) return null;
  return { cand: hits[0], index: candidates.indexOf(hits[0]) };
}

/**
 * "Try exactly one candidate hard before escalating" (SKILL.md §Speed).
 *
 * Escalating before candidate 1 has a verdict is how an investigation turns
 * into a scattergun: three loose theories, no oracle, a confident summary.
 */
export function blockers(candidates, index, { escalate = false } = {}) {
  const out = [];
  for (let i = 0; i < index; i++) {
    const c = candidates[i];
    // "Hard" means an oracle ran and answered. `inconclusive` means it timed out,
    // could not start, or failed on the control too — a lead that was never
    // tested must not unlock the next one just to move on.
    if (c.verdict === "pending") {
      out.push(
        `candidate ${c.rank ?? i + 1} ("${c.location}") still has no verdict — one candidate hard before escalating`,
      );
    } else if (c.verdict === "inconclusive" && !escalate) {
      out.push(
        `candidate ${c.rank ?? i + 1} ("${c.location}") came back inconclusive — that check never answered anything; re-run it, or pass --escalate to move past it knowingly`,
      );
    } else if (c.verdict === "inconclusive_vacuous" && !escalate) {
      out.push(
        `candidate ${c.rank ?? i + 1} ("${c.location}") was inconclusive_vacuous — the check did not depend on the line accused, so that hypothesis was never tested; write a check that does, or --escalate`,
      );
    } else if (c.verdict === "confirmed" && !escalate) {
      // Core Design step 3: "Confirmed → that is the root cause. Stop." Without
      // this, the gate only prevented escalating too early and happily allowed
      // testing on after the answer was already in the file.
      out.push(
        `candidate ${c.rank ?? i + 1} ("${c.location}") is a CONFIRMED cause — stop and write the case; --escalate only if you are deliberately chasing a second fault`,
      );
    }
  }
  return out;
}

/**
 * A multi-line check is a script, not a shell string.
 *
 * The smallest falsifying artifact is often five lines of Python, and a script
 * that lives in a subdirectory cannot import the code under test: both Python
 * and Node resolve relative imports against the *script's* directory, so
 * `.ducktective/checks/x.py` would fail for a reason that has nothing to do with
 * the hypothesis. It therefore goes in the repo root, next to the modules it
 * imports, and is deleted after the run unless `--keep` — the full source is
 * recorded in `check`, so the case file still replays.
 */
export function materialize(check, { lang, repo, caseId, rank, dryRun = false }) {
  if (!check.includes("\n")) return { command: check, file: null };
  const sniffed = /^#!.*python/i.test(check)
    ? "py"
    : /^#!.*(node|deno|bun)/i.test(check)
      ? "js"
      : null;
  const use = lang ?? sniffed;
  if (!use)
    throw new Error(
      "the check is multi-line — pass --lang py|js|sh or put a shebang on it, otherwise there is nothing to run",
    );
  // Same guard the store uses: this file is written AND then executed, so an id
  // like `DT-../../tmp/evil` was a write-then-run outside the repo.
  if (!CASE_ID.test(caseId ?? ""))
    throw new Error(
      `draft id ${JSON.stringify(caseId)} is not a safe filename — fix the draft, do not run this check`,
    );
  const file = join(repo, `ducktective-check-${caseId}-${rank ?? 0}.${EXT[use]}`);
  if (!dryRun) writeFileSync(file, check.endsWith("\n") ? check : check + "\n", "utf8");
  const exe = use === "py" ? pythonFor(repo) : INTERPRETER[use];
  return { command: `"${exe}" "${file}"`, file };
}

/**
 * One rule for the first run and for --verify, so a re-test cannot be graded on
 * a different scale than the claim it is checking.
 *
 * Confirming takes a receipt. `predicted` matching proves the check AGREES, and
 * a passing control proves it is not always-fail; neither proves it is not
 * always-pass, and neither proves its outcome depends on the line being accused.
 * Fail predictions retain control-or-probe compatibility. Pass predictions need
 * a flipped probe: a passing control cannot distinguish an always-pass check.
 * A flip detects sensitivity under this mutation, not proof the line is faulty.
 * Falsification needs no receipt. A non-flip detects no sensitivity under this
 * mutation, not proof the check never touched the line.
 *
 * @param {"pass"|"fail"} predicted what the check must do if the hypothesis is true
 * @param {{controlPassed?: boolean, probeFlipped?: boolean|null}} disc
 *   `false` means a comparable probe did not flip; `null` means no valid probe.
 */
export function classify(predicted, checkResult, controlResult, timeout = 0, disc = {}) {
  return classifyVerdict(predicted, checkResult, controlResult, timeout, disc);
}

/** `"app.py:41 totals()"` → `{file, line}`; null when the id is not a location. */
export function accusedAt(location) {
  const m = /^(\S+?):(\d+)\b/.exec(location ?? "");
  return m ? { file: m[1], line: Number(m[2]) } : null;
}

/**
 * The neuter: neutralize the accused line, keep the program running.
 *
 * Aborting *before* the line (injecting a raise/throw) is the obvious strategy and
 * the wrong one: a check that already fails keeps failing when the code above it
 * dies, so an exit-code comparison reports "no change" about a line that mattered
 * enormously. Neutralizing keeps the process alive, so the only way the
 * outcome survives is that the line genuinely did not matter.
 *
 * Two strategies, tried in order on the ORIGINAL line text; the first flip wins.
 * Delete is the sharpest: it removes exactly the accused computation. But on an
 * indented sole body line (Python's `def f():\n    return x`) deletion breaks
 * the block parse — IndentationError — which is an artifact, not evidence.
 * Neutralize substitutes a syntactically silent stand-in at the same
 * indentation (`pass` for Python, `;` for JS) and rescues exactly those cases.
 */
const NEUTER = {
  py: [
    ["delete", (text) => `# dt-probe ${text}`],
    ["neutralize", (_text, indent) => `${indent}pass  # dt-probe`],
  ],
  js: [
    ["delete", (text) => `// dt-probe ${text}`],
    ["neutralize", (_text, indent) => `${indent};  // dt-probe`],
  ],
};
const NEUTER_LANG = {
  py: "py",
  js: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  tsx: "js",
  jsx: "js",
};
/**
 * A neuter that breaks the parse or leaves a name undefined never produced a
 * comparable run. "It crashed differently" is not evidence that the line is
 * irrelevant, so the probe reports not-run rather than calling the check vacuous.
 */
const MUTATION_ARTIFACT =
  /SyntaxError|IndentationError|TabError|ParseError|Unexpected token|Unexpected end of input|is not defined|cannot be resolved|Cannot find name|ReferenceError|Invalid or unexpected token|missing (?:expression|statement|after)/i;

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

/**
 * Does the check's outcome depend on the accused line?
 *
 * Neuter the line on a scratch `git worktree` — never the user's tree — and run
 * the same check there. Same outcome ⇒ the check never touched that line, which
 * is the failure mode `--control` cannot see: an always-pass oracle agrees with
 * any prediction and passes any control.
 *
 * The worktree is checked out from HEAD, so it has neither untracked source, the
 * repo's `.venv`, nor `node_modules`. That is why the baseline run in the
 * worktree is compared against the outcome just recorded in the real tree first:
 * if they disagree, the probe would be measuring the environment rather than the
 * line, and it says so instead of concluding.
 *
 * @returns {Promise<{flipped: boolean|null, exitCode?: number, desc?: string, reason?: string}>}
 */
export async function probe({
  repo,
  source,
  lang,
  caseId,
  rank,
  file,
  line,
  timeout,
  maxBytes,
  recordedCode,
}) {
  const no = (reason) => ({ flipped: null, reason });
  const top = git(["rev-parse", "--show-toplevel"], repo);
  if (top.status !== 0)
    return no("not a git checkout — the probe needs a commit to build a worktree from");
  const root = top.stdout.trim();
  const rel = relative(root, resolve(repo, file)).split(sep).join("/");
  if (rel.startsWith(".."))
    return no(`${file} is outside the checkout — there is no HEAD copy to neuter`);
  if (git(["cat-file", "-e", `HEAD:${rel}`], root).status !== 0)
    return no(`${rel} does not exist at HEAD — the probe compares HEAD with HEAD-minus-that-line`);
  if (git(["status", "--porcelain", "--", rel], root).stdout.trim())
    return no(
      `${rel} has uncommitted changes — a worktree at HEAD would probe different code than the check just ran against`,
    );
  const fam = NEUTER_LANG[/\.([a-z0-9]+)$/i.exec(rel)?.[1] ?? ""];
  if (!fam) return no(`no neuter strategy for ${rel}`);
  const wt = mkdtempSync(join(tmpdir(), "dt-probe-"));
  const add = git(["worktree", "add", "--detach", "--quiet", wt, "HEAD"], root);
  if (add.status !== 0) {
    rmSync(wt, { recursive: true, force: true });
    return no(`git worktree add failed: ${(add.stderr || "").trim().slice(0, 160)}`);
  }
  try {
    const made = materialize(source, { lang, repo: wt, caseId, rank });
    // Python caches compiled bytecode in __pycache__, validated by (mtime, size).
    // A mutant whose replacement line has the same byte length as the original —
    // `pass  # dt-probe` is exactly as long as `def total(rows):` — written in
    // the same mtime second imports the STALE baseline bytecode and reports the
    // baseline's outcome, faking either a flip or a no-change. The worktree is
    // disposable; the cache goes with it.
    const wipeCaches = () => {
      const stack = [wt];
      while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name === "__pycache__") rmSync(p, { recursive: true, force: true });
            else if (!p.startsWith(join(wt, ".git"))) stack.push(p);
          }
        }
      }
    };
    wipeCaches();
    const base = await run(made.command, { cwd: wt, timeout, maxBytes });
    if (base.timedOut) return no("the probe baseline timed out (timeout); no comparable outcome");
    if (wasNotRunnable(base) || !Number.isInteger(base.code))
      return no("the probe baseline could not be run to completion; no comparable outcome");
    if (MUTATION_ARTIFACT.test(`${base.stderr}\n${base.stdout}`))
      return no("the probe baseline has a parse or undefined-name error; not comparable");
    // The comparison that makes the rest honest, and the one the first real repo
    // caught missing: a scratch worktree has no untracked `.venv`, no
    // `node_modules`, no generated files. If the check does not even reproduce its
    // recorded outcome there, the mutated run measures the environment, not the
    // line, and the only correct answer is that nothing was learned.
    if (
      Number.isInteger(recordedCode) &&
      !base.timedOut &&
      (base.code === 0) !== (recordedCode === 0)
    )
      return {
        flipped: null,
        exitCode: base.code,
        desc: `${rel}:${line} would be commented out on a scratch worktree`,
        reason: `the check behaved differently in a clean worktree (exit ${base.code}) than in your tree (exit ${recordedCode}) — an untracked dependency or generated file; the probe would have measured the environment, not the line`,
      };
    const target = join(wt, rel);
    const lines = readFileSync(target, "utf8").split(/\r?\n/);
    if (line < 1 || line > lines.length) return no(`${rel} has no line ${line} at HEAD`);
    const indent = /^[ \t]*/.exec(lines[line - 1])?.[0] ?? "";
    const original = lines[line - 1].trim();
    // Each strategy mutates the pristine line; the first comparable, flipping
    // mutant wins. An artifact mutant is skipped, never scored (it is not
    // evidence the line is irrelevant). If every strategy produced only
    // artifacts, the honest answer stays not-run.
    const attempts = [];
    for (const [sname, mutate] of NEUTER[fam]) {
      const mutated = [...lines];
      mutated[line - 1] = `${indent}${mutate(original, indent)}`;
      writeFileSync(target, mutated.join("\n"), "utf8");
      wipeCaches();
      const mut = await run(made.command, { cwd: wt, timeout, maxBytes });
      const out = [mut.stderr, mut.stdout].filter(Boolean).join("\n");
      if (mut.timedOut)
        return no(`the probe mutant timed out (timeout) under ${sname}; no comparable outcome`);
      if (wasNotRunnable(mut) || !Number.isInteger(mut.code))
        return no(
          `the probe mutant could not be run to completion under ${sname}; no comparable outcome`,
        );
      if (MUTATION_ARTIFACT.test(out)) {
        attempts.push(`${sname}: artifact (not comparable)`);
        continue; // this mutant never produced a comparable run — try the next
      }
      const changed = (mut.code === 0) !== (base.code === 0);
      attempts.push(`${sname}: ${changed ? "flipped" : "no change"}`);
      if (changed)
        return {
          flipped: true,
          strategy: sname,
          exitCode: mut.code,
          baseCode: base.code,
          desc: `${rel}:${line} ${sname === "delete" ? "commented out" : "neutralized"} on a scratch worktree`,
          tail: out.trim().split("\n").slice(-3).join("\n"),
          attempts,
        };
      return {
        flipped: false,
        exitCode: mut.code,
        baseCode: base.code,
        desc: `${rel}:${line} ${sname === "delete" ? "commented out" : "neutralized"} on a scratch worktree`,
        tail: out.trim().split("\n").slice(-3).join("\n"),
        attempts,
      };
    }
    return {
      flipped: null,
      exitCode: undefined,
      baseCode: base.code,
      desc: `${rel}:${line} could not be neutered into a comparable run`,
      reason: `no usable mutant from any strategy (${attempts.join("; ")}) — the check may still depend on that line`,
      attempts,
    };
  } finally {
    git(["worktree", "remove", "--force", "--quiet", wt], root);
    rmSync(wt, { recursive: true, force: true });
    git(["worktree", "prune", "--quiet"], root);
  }
}

function evidenceBlock(label, result, maxBytes) {
  const head = `${label}: exit ${result.timedOut ? "killed (timeout)" : (result.code ?? "signalled")} in ${Math.round(result.durationMs)} ms`;
  const body = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
  return `${head}\n${clip(body, maxBytes)}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;

  const draftPath = resolve(opts.file);
  if (!existsSync(draftPath))
    throw new Error(`no such draft: ${draftPath} — run reproduce.mjs first`);
  const draft = JSON.parse(readFileSync(draftPath, "utf8"));
  // Shape first, before any path is built from it: `id` names a file this tool
  // writes and then executes. Policy (hypotheses, verdicts) stays write_case's
  // job, because a seeded draft legitimately carries empty ones.
  const shape = validateSchema(draft, SCHEMA);
  if (shape.length) {
    console.error(`REFUSED: ${draftPath} is not a case file this tool can extend
`);
    for (const bad of shape) console.error(`  - ${bad}`);
    process.exitCode = 1;
    return;
  }
  const picked = pickCandidate(draft.candidates ?? [], opts.candidate);
  if (!picked) {
    const seen = (draft.candidates ?? []).map((c) => `${c.rank}. ${c.location}`).join("; ");
    throw new Error(
      `--candidate ${opts.candidate} is not one of the seeded leads (${seen || "none seeded"})`,
    );
  }
  const { cand, index } = picked;

  const refuse = (reasons) => {
    console.error(`REFUSED: candidate ${cand.rank ?? index + 1} — ${cand.location}\n`);
    for (const r of [].concat(reasons)) console.error(`  - ${r}`);
    process.exitCode = 1;
  };

  const reasons = [];
  if (opts.verify && !(cand.predicted && typeof cand.check_exit_code === "number"))
    reasons.push("nothing to verify — this candidate has no executed oracle to re-test");
  if (opts.hypothesis) cand.hypothesis = opts.hypothesis.trim();
  if (!(cand.hypothesis ?? "").trim())
    reasons.push(
      "no hypothesis — state what you think is wrong (in the draft or via --hypothesis) before testing it (rule 4)",
    );
  if (cand.verdict !== "pending" && !opts.rerun && !opts.verify)
    reasons.push(`already has verdict "${cand.verdict}" — pass --rerun to run it again`);
  reasons.push(...blockers(draft.candidates ?? [], index, { escalate: !!opts.escalate }));
  if (draft.reproduction?.outcome !== "reproduced")
    reasons.push(`reproduction outcome is "${draft.reproduction?.outcome}" — the gate says stop`);
  if ((cand.rank ?? index + 1) > (opts.depth ?? 2))
    reasons.push(
      `rank ${cand.rank ?? index + 1} is past --depth ${opts.depth ?? 2} — the speed control is one candidate hard before escalating; --depth 2 allows the next lead`,
    );
  if (reasons.length) return refuse(reasons);

  const check = opts.cmd ?? checkSource(cand.check);
  if (!(check ?? "").trim())
    return refuse('no check to run — give it one with --cmd or set the candidate\'s "check" field');
  if (opts.blind !== undefined && opts.blind.trim() === check.trim())
    return refuse(
      "the --blind check is identical to the check it is meant to replicate — author a second, independent check",
    );

  // The repo the case belongs to, and where the command runs. A materialized
  // script needs this root to import from, so `--repo` is separate from `--cwd`.
  const repo = opts.repo ?? repoRoot(opts.cwd ?? dirname(draftPath));
  let prepared;
  try {
    prepared = materialize(check, {
      lang: opts.lang,
      repo,
      caseId: draft.id,
      rank: cand.rank,
      dryRun: !opts.yes,
    });
  } catch (err) {
    return refuse(err.message);
  }

  const cwd = opts.cwd ?? repo;
  console.error(
    `[run_check] candidate ${cand.rank ?? index + 1} · predicted ${opts.predict ?? cand.predicted} · cwd ${cwd}${opts.verify ? " · VERIFY" : ""}`,
  );
  console.error(`  check:   ${prepared.command}`);
  if (prepared.file) console.error(`  source:\n${check}`);
  if (opts.control) console.error(`  control: ${opts.control}`);
  if (opts.blind) console.error(`  blind:   ${opts.blind}`);
  if (opts.probe)
    console.error(
      `  probe:   ${cand.location} neutered on a scratch worktree at HEAD, then this check re-run there`,
    );
  if (!opts.yes) {
    console.error(
      "\nDRY RUN — nothing executed. This is a model-written command in your repo; read it above, then re-run with --yes.",
    );
    process.exitCode = 3;
    return;
  }

  const checkResult = await run(prepared.command, {
    cwd,
    timeout: opts.timeout,
    maxBytes: opts.maxBytes,
  });
  const controlResult = opts.control
    ? await run(opts.control, { cwd, timeout: opts.timeout, maxBytes: opts.maxBytes })
    : null;

  // The blind re-derivation (design v3 E2), executed here: a second check the
  // host authors without this run's context. run_check only runs and records it;
  // it cannot prove the authoring was context-free, and says so (see §6.5).
  const predicted = opts.predict ?? cand.predicted;
  const blindResult = opts.blind
    ? await run(opts.blind, { cwd, timeout: opts.timeout, maxBytes: opts.maxBytes })
    : null;
  const blindConfirmed =
    !!blindResult &&
    Number.isInteger(blindResult.code) &&
    predictionHeld(predicted, blindResult.code);
  const blindReceipt = blindResult
    ? { confirmed: blindConfirmed, ran: Number.isInteger(blindResult.code) }
    : opts.verify && cand.blind_check
      ? { confirmed: cand.blind_check.verdict === "confirmed" }
      : null;

  // Receipts. On --verify no fresh control is run, so the one recorded on the
  // first run carries the claim; on a first run nothing is recorded yet. When
  // --probe was asked for, the prediction is graded provisionally first: the
  // receipt it is asking for is the one the probe is about to produce, and
  // demoting before the probe would mean the probe never runs.
  const recordedControl = !!(opts.verify && cand.control_exit_code === 0);
  const receipts = {
    controlPassed: controlResult ? controlResult.code === 0 : recordedControl,
    // Provisional only: an explicitly requested probe replaces this before recording.
    probeFlipped: opts.probe ? true : opts.verify && cand.probe_flipped === "yes" ? true : null,
    blind: blindReceipt,
  };
  let { verdict, notes } = classify(
    opts.predict ?? cand.predicted,
    checkResult,
    controlResult,
    opts.timeout,
    receipts,
  );

  // The probe is the second receipt, and it is only worth its cost once the
  // prediction has held. A falsified candidate needs no discrimination: rejecting
  // a hypothesis is the half of this that was never broken.
  let probed = null;
  if (opts.probe && verdict === "confirmed") {
    const accused = accusedAt(cand.location);
    probed = accused
      ? await probe({
          repo,
          source: check,
          lang: opts.lang,
          caseId: draft.id,
          rank: cand.rank,
          ...accused,
          recordedCode: checkResult.code,
          timeout: opts.timeout,
          maxBytes: opts.maxBytes,
        })
      : {
          flipped: null,
          reason: `the candidate id "${cand.location}" is not a file:line — point it at the line the check should depend on`,
        };
    receipts.probeFlipped = probed.flipped;
    receipts.controlPassed = controlResult
      ? controlResult.code === 0
      : !!(opts.verify && cand.control_exit_code === 0);
    const final = classify(
      opts.predict ?? cand.predicted,
      checkResult,
      controlResult,
      opts.timeout,
      receipts,
    );
    // The prelim pass was graded as if a receipt were coming, so its notes are
    // empty; the probe's own reading of the same arithmetic is what the case
    // file has to carry — `inconclusive_vacuous` without its reason is a label
    // and nothing else.
    verdict = final.verdict;
    notes = [...final.notes, ...(probed.flipped === null ? [`probe: ${probed.reason}`] : [])];
  }

  if (opts.verify) {
    // Design-doc success metric #2 — "what fraction of final confirmed claims
    // survive a second independent run?" — is unanswerable without a re-execution
    // step. Same arithmetic as the first run and nothing here may edit the claim,
    // only record whether it held. Honest limit: same machine, same working tree,
    // fresh process. That catches a flaky oracle, not an environment-specific pass.
    const survived = verdict === cand.verdict;
    Object.assign(cand, { verified_exit_code: checkResult.code, verified_verdict: verdict });
    cand.evidence = [
      cand.evidence,
      evidenceBlock("verify", checkResult, opts.maxBytes),
      `verify verdict: ${verdict} (recorded: ${cand.verdict})`,
      controlResult ? `verify control: exit ${controlResult.code}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    writeAtomic(draftPath, JSON.stringify(draft, null, 2) + "\n");
    if (prepared.file && !opts.keep) rmSync(prepared.file, { force: true });
    console.log(
      JSON.stringify(
        {
          verified: true,
          id: draft.id,
          candidate: cand.rank ?? index + 1,
          location: cand.location,
          recorded_verdict: cand.verdict,
          verify_verdict: verdict,
          survived,
          caveat:
            "same machine and working tree, new process — a flaky-oracle test, not a portability test",
          draft: draftPath,
        },
        null,
        2,
      ),
    );
    // A claim that did not survive is a finding, not a success: non-zero so a
    // loop cannot quietly ignore it.
    process.exitCode = survived ? 0 : 2;
    return;
  }

  const recorded = prepared.file
    ? `${prepared.command}${SCRIPT_HEADER}\n${check.trimEnd()}`
    : prepared.command;

  Object.assign(cand, {
    check: recorded,
    predicted: opts.predict,
    check_exit_code: checkResult.code,
    verdict,
    evidence: [
      evidenceBlock("check", checkResult, opts.maxBytes),
      controlResult ? evidenceBlock("control", controlResult, opts.maxBytes) : null,
      probed?.tail ? `probe, accused line neutered: exit ${probed.exitCode}\n${probed.tail}` : null,
      ...notes,
    ]
      .filter(Boolean)
      .join("\n\n"),
    ...(opts.control
      ? { control: opts.control, control_exit_code: controlResult?.code ?? null }
      : {}),
    // Record what the probe showed, including "it could not run": a missing
    // receipt has to be visible to write_case, not merely absent. `attempts`
    // keeps the per-strategy outcome (artifact vs flip vs no-change) so the
    // artifact rate is computable from the store, which C7 needs.
    ...(opts.probe && probed
      ? {
          probe: `${probed.desc ?? "probe not run"}${probed.reason ? ` — ${probed.reason}` : ""}`,
          probe_exit_code: Number.isInteger(probed.exitCode) ? probed.exitCode : null,
          probe_flipped:
            probed.flipped === true ? "yes" : probed.flipped === false ? "no" : "not-run",
          ...(Array.isArray(probed.attempts) && probed.attempts.length
            ? {
                probe_attempts: probed.attempts,
                probe_artifact: probed.attempts.some((a) => /artifact/.test(a)),
              }
            : {}),
        }
      : {}),
    ...(blindResult
      ? {
          blind_check: {
            verdict: !Number.isInteger(blindResult.code)
              ? "inconclusive"
              : blindConfirmed
                ? "confirmed"
                : "falsified",
            check: opts.blind,
            exit_code: Number.isInteger(blindResult.code) ? blindResult.code : null,
            evidence: evidenceBlock("blind", blindResult, opts.maxBytes),
          },
        }
      : {}),
  });

  writeAtomic(draftPath, JSON.stringify(draft, null, 2) + "\n");
  if (prepared.file && !opts.keep) rmSync(prepared.file, { force: true });
  // "could not be evaluated" is a harness-level result, so it leaves a non-zero
  // trace: a caller that ignores stdout still cannot mistake it for a verdict.
  if (verdict === "inconclusive" || verdict === "inconclusive_vacuous") process.exitCode = 2;

  const remaining = (draft.candidates ?? []).filter((c) => c.verdict === "pending").length;
  console.log(
    JSON.stringify(
      {
        recorded: true,
        id: draft.id,
        candidate: cand.rank ?? index + 1,
        location: cand.location,
        verdict,
        predicted: opts.predict,
        check_exit_code: checkResult.code,
        ...(opts.probe
          ? {
              probe_flipped:
                probed?.flipped === true ? "yes" : probed?.flipped === false ? "no" : "not-run",
              probe_exit_code: Number.isInteger(probed?.exitCode) ? probed.exitCode : null,
              ...(Array.isArray(probed?.attempts) && probed.attempts.length
                ? { probe_attempts: probed.attempts }
                : {}),
            }
          : {}),
        control_exit_code: controlResult?.code ?? null,
        ...(blindResult
          ? {
              blind_verdict: blindConfirmed ? "confirmed" : "falsified",
              blind_exit_code: Number.isInteger(blindResult.code) ? blindResult.code : null,
            }
          : {}),
        draft: draftPath,
        next:
          verdict === "confirmed"
            ? "set confirmed_cause + status, then: node scripts/write_case.mjs --file " + opts.file
            : verdict === "unreplicated"
              ? "the blind re-derivation did not reproduce the claim — author a sharper second check, or file it unreplicated with a leading_hypothesis"
              : remaining
                ? `${remaining} candidate(s) left — the policy is one hard before escalating, so finish this one's follow-ups first`
                : "every candidate exhausted — set status unverified + leading_hypothesis, then write_case",
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(`[ducktective] run_check failed: ${err.message}`);
    process.exitCode = 2;
  });
}

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
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CASE_ID, clip, repoRoot, SCHEMA, validateSchema, writeAtomic } from "./lib/case-file.mjs";
import { run, wasNotRunnable } from "./lib/exec.mjs";

const USAGE = `usage: run_check.mjs --file DRAFT.json --candidate RANK|LOCATION --predict pass|fail [options]
  --yes                execute the check (default: dry run, prints it and exits 3)
  --cmd COMMAND        override the candidate's recorded check
  --control COMMAND    known-good command that must pass, or the check is no oracle (rule 5)
  --hypothesis TEXT    state the claim here if the draft does not carry one
  --depth N            highest candidate rank this run may touch (default 2; 1 = never escalate)
  --verify             re-execute a decided candidate's own check and report whether it survives
  --lang py|js|sh      how to run a multi-line check (default: sniff the shebang)
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
  const bools = new Set(["--yes", "--rerun", "--keep", "--escalate", "--verify"]);
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
export function materialize(check, { lang, repo, caseId, rank }) {
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
  writeFileSync(file, check.endsWith("\n") ? check : check + "\n", "utf8");
  const exe = use === "py" ? pythonFor(repo) : INTERPRETER[use];
  return { command: `"${exe}" "${file}"`, file };
}

/**
 * One rule for the first run and for --verify, so a re-test cannot be graded on
 * a different scale than the claim it is checking.
 *
 * @param {"pass"|"fail"} predicted what the check must do if the hypothesis is true
 */
export function classify(predicted, checkResult, controlResult, timeout = 0) {
  const notes = [];
  const inconclusive = (why) => {
    notes.push(why);
    return { verdict: "inconclusive", notes };
  };
  if (checkResult.timedOut)
    return inconclusive(`the check hung and its process tree was killed after ${timeout} ms`);
  if (wasNotRunnable(checkResult))
    return inconclusive(
      "the check command could not be run at all — that is not evidence about the hypothesis",
    );
  if (controlResult && controlResult.code !== 0)
    return inconclusive(
      "the control also failed, so this check does not distinguish the broken path from a known-good one (rule 5)",
    );
  const held = (predicted === "pass") === (checkResult.code === 0);
  return { verdict: held ? "confirmed" : "falsified", notes };
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

  // The repo the case belongs to, and where the command runs. A materialized
  // script needs this root to import from, so `--repo` is separate from `--cwd`.
  const repo = opts.repo ?? repoRoot(opts.cwd ?? dirname(draftPath));
  let prepared;
  try {
    prepared = materialize(check, { lang: opts.lang, repo, caseId: draft.id, rank: cand.rank });
  } catch (err) {
    return refuse(err.message);
  }

  const cwd = opts.cwd ?? repo;
  console.error(
    `[run_check] candidate ${cand.rank ?? index + 1} · predicted ${opts.predict ?? cand.predicted} · cwd ${cwd}${opts.verify ? " · VERIFY" : ""}`,
  );
  console.error(`  check:   ${prepared.command}`);
  if (opts.control) console.error(`  control: ${opts.control}`);
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

  const { verdict, notes } = classify(
    opts.predict ?? cand.predicted,
    checkResult,
    controlResult,
    opts.timeout,
  );

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
      ...notes,
    ]
      .filter(Boolean)
      .join("\n\n"),
    ...(opts.control
      ? { control: opts.control, control_exit_code: controlResult?.code ?? null }
      : {}),
  });

  writeAtomic(draftPath, JSON.stringify(draft, null, 2) + "\n");
  if (prepared.file && !opts.keep) rmSync(prepared.file, { force: true });
  // "could not be evaluated" is a harness-level result, so it leaves a non-zero
  // trace: a caller that ignores stdout still cannot mistake it for a verdict.
  if (verdict === "inconclusive") process.exitCode = 2;

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
        control_exit_code: controlResult?.code ?? null,
        draft: draftPath,
        next:
          verdict === "confirmed"
            ? "set confirmed_cause + status, then: node scripts/write_case.mjs --file " + opts.file
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

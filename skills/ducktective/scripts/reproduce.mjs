#!/usr/bin/env node
/**
 * reproduce — the hard gate. Run the exact failing command, capture what it
 * actually printed, and classify the outcome. Nothing downstream may reason
 * about the bug until this exits 0.
 *
 *   node skills/ducktective/scripts/reproduce.mjs \
 *     --cmd "python -m unittest -q" --cwd . --symptom "totals off by one on inclusive ranges"
 *
 * Exit codes: 0 = reproduced (continue), 1 = DOES NOT REPRODUCE (stop),
 * 2 = the harness itself errored (bad command, timeout, usage).
 *
 * The output is a case-file *draft* on stdout: `reproduction` filled from a
 * real run, `candidates` seeded from the traceback (nearest fault first) plus
 * fail-only coverage, with `verdict: "pending"`. Choosing hypotheses is the
 * model's job; `write_case.mjs` stores the result.
 *
 * Deliberately command-generic: pytest, unittest and `node --test` are all just
 * subprocesses whose output contains a traceback. The doc's "pytest first" is a
 * parser priority, not a dependency.
 */
import { numFlag } from "./lib/args.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clip, newCaseId, SCHEMA, validateSchema } from "./lib/case-file.mjs";
import { run, wasNotRunnable } from "./lib/exec.mjs";

export const USAGE = `usage: reproduce.mjs --cmd <command> [options]
  --cmd COMMAND        the exact failing command, run through the user's shell (required)
  --cwd DIR            where to run it (default: .)
  --symptom TEXT       the reported symptom, recorded verbatim
  --coverage FILE      coverage JSON from the failing run (coverage.py format)
  --baseline FILE      coverage JSON from a passing run (enables fail-only ranking)
  --timeout MS         kill the whole process tree after this long (default: 120000)
  --max-bytes N        keep at most N bytes per stream, head and tail (default: 4000)
  --max-candidates N   cap the seeded leads, 1-5 (default: 5)
  --out FILE           also write the draft here
Example:
  node scripts/reproduce.mjs --cmd "pytest -q tests/totals_test.py" \\
    --symptom "totals drop the last row" --out .ducktective/draft.json`;

/** Python traceback frame: `File "src/user.py", line 41, in get_user`. */
const PY_FRAME = /^\s*File "(.+?)", line (\d+)(?:, in (.+))?$/;
/** V8 frame: `at getUser (C:/p/src/auth.ts:41:12)` or `at C:/p/src/auth.ts:41:12`. */
const V8_FRAME = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?,?\s*$/;
/** pytest's own prefix for the assertion it failed on. */
const PYTEST_ASSERT = /^\s*(?:={3,}\s+)?E\s+(\S.*)$/;
/**
 * pytest location line: `test_money.py:5: AssertionError`, or
 * `tests/test_money.py:12: in test_counts_every_row`. pytest does not print a
 * Python traceback for a failed assert — it rewrites the assertion and reports
 * the spot in this one-line form. Parsing only `File "…", line N` found zero
 * frames in every real pytest failure, and the gate called a reproduced bug an
 * error.
 */
const LOC_FRAME = /^(\S+?\.(?:py|js|ts|tsx|jsx|mjs|cjs)):(\d+)(?::\s*(.*))?$/;
/**
 * The runner never started collecting: typo'd path, stale test name, unimportable
 * module, bad flag. All of them exit non-zero, and reading that as a
 * "reproduction" is how a garbage command becomes a confident wrong answer.
 * Only consulted when the run produced no evidence inside the repo, so a real
 * fault that prints any of these strings still counts.
 *
 * No alternative may be empty: a trailing `|` makes the pattern match the empty
 * string, i.e. every run, and the gate quietly stops classifying anything.
 * `RUNNER_MISUSE_REJECTS_NOISE` in the tests guards exactly that.
 */
// Exported so the tests can prove each alternative matches and that no alternative is empty.
export const RUNNER_MISUSE =
  /no tests ran|no tests were collected|empty test suite|unrecognized arguments|usage: |not found: |file or directory not found|cannot import name|cannot find module|moduleNotFoundError|importerror|error: (?:not found|no such)|interrupted:/i;

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), timeout: 120_000, maxBytes: 4000, maxCandidates: 5 };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exitCode = 0;
    return null;
  }
  if (argv.length % 2 !== 0)
    throw new Error(`every flag needs a value: ${argv.join(" ")}\n\n${USAGE}`);
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!flag?.startsWith("--")) throw new Error(`expected a --flag, got "${flag}"\n\n${USAGE}`);
    switch (flag) {
      case "--cmd":
        opts.command = value;
        break;
      case "--cwd":
        opts.cwd = resolve(value);
        break;
      case "--symptom":
        opts.symptom = value;
        break;
      case "--coverage":
        opts.coverage = resolve(value);
        break;
      case "--baseline":
        opts.baseline = resolve(value);
        break;
      case "--timeout":
        opts.timeout = numFlag(flag, value);
        break;
      case "--max-bytes":
        opts.maxBytes = numFlag(flag, value);
        break;
      case "--max-candidates": {
        // Deliberately NOT `--depth`: the design doc reserves that name for the
        // escalation policy (1 = try one candidate hard, 2 = escalate). A list
        // cap and a policy dial must not share a flag.
        const wanted = Number(value);
        opts.maxCandidates = numFlag(flag, value, { max: 5, clamp: true });
        // Silent clamping is how an agent that asked for seven leads trusts a
        // list of five.
        if (wanted !== opts.maxCandidates)
          console.error(
            `[ducktective] --max-candidates ${value} clamped to ${opts.maxCandidates} (SKILL.md caps candidates at 5)`,
          );
        break;
      }
      case "--out":
        opts.out = value;
        break;
      default:
        throw new Error(`unrecognised flag: ${flag}\n\n${USAGE}`);
    }
  }
  if (!opts.command)
    throw new Error(`--cmd is required — the gate runs the exact failing command.\n\n${USAGE}`);
  return opts;
}

/** Which runner produced this output — recorded for the reader, not for ordering. */
export function detectRunner(command, output) {
  if (/-m\s+pytest\b|\bpytest(\s|$)/.test(command)) return "pytest";
  if (/-m\s+unittest\b|unittest\.main/.test(command)) return "unittest";
  if (/node\s+--test|--test\b/.test(command)) return "node-test";
  // Command-based, then the reporter's own markers: judging `node --test` by
  // "does the output contain a V8 frame" mislabels a plain `node main.mjs` crash,
  // which prints frames too.
  if (/^(?:not ok \d|ℹ (?:tests|fail) \d|# fail \d)/m.test(output ?? "")) return "node-test";
  return "unknown";
}

/** Backslashes make locations unreadable, so paths are POSIX. */
function toPosix(p) {
  return p.replace(/\\/g, "/");
}

/**
 * Repo-relative file, so `location` greps and survives a different checkout.
 *
 * Python 3.13+ prints absolute tracebacks and node prints `file://` URLs; both
 * are useless as a candidate location and ugly in Markdown. Anything outside
 * `--cwd` stays absolute rather than pretending to be `../../..`.
 */
function repoRelative(file, cwd) {
  const abs = toPosix(file.startsWith("file://") ? fileURLToPath(file) : file);
  const base = toPosix(cwd ?? "").replace(/\/+$/, "");
  if (!base || !abs.startsWith(`${base}/`)) return abs;
  return abs.slice(base.length + 1);
}

/**
 * Path tests that give the same answer on every OS.
 *
 * `path.isAbsolute("C:/app/x.py")` is true on Windows and false on Linux, and
 * `path.basename` only splits on the host's separator — so a traceback that
 * crosses machines (a Windows path read in a container, WSL, or CI) was
 * classified "inside the repo" on one runner and "dependency" on another. The
 * gate then ranked a stdlib frame above the real fault, or lost the coverage hint
 * entirely. Case files are meant to outlive the machine that wrote them.
 */
/**
 * The backslash, built from its code point so this file has no escape to mangle.
 * Note the doubling: in a character class `[\/]` is just `/` — an escaped
 * slash, not a backslash — so the class needs two of them to match one.
 */
const BS = String.fromCharCode(92);
const SEPS = new RegExp(`[${BS}${BS}/]+`);
const DRIVE_ABSOLUTE = new RegExp(`^[A-Za-z]:[${BS}${BS}/]`);
const UNC_PREFIX = BS + BS;

export function baseName(p) {
  const parts = (p ?? "").split(SEPS).filter(Boolean);
  return parts.at(-1) ?? p ?? "";
}

export function isAbsoluteLike(p) {
  return DRIVE_ABSOLUTE.test(p) || p.startsWith("/") || p.startsWith(UNC_PREFIX);
}

function frame(file, line, fn, raw) {
  return { file, line, fn, raw, inside: isLocalFile(file) };
}

/**
 * Is this a file in the repo, or a pseudo-location that only *looks* local?
 *
 * `[eval]` (node -e), `<string>` (python -c) and `<stdin>` have no separator and
 * no drive, so "not absolute" alone called them in-repo evidence — and a failure
 * with nothing but those frames was classified as a reproduced symptom. Neither
 * names a file anyone can open, so neither may rank as a lead.
 */
export function isLocalFile(file) {
  return (
    !isAbsoluteLike(file) &&
    !file.startsWith("../") &&
    !/^[<[/.]*[<[]/.test(file) &&
    !/^[<[]/.test(file) &&
    // site-packages and node_modules are inside the directory and outside the
    // project: they are the runner's plumbing, so they neither lead nor prove.
    !VENDORED.test("/" + (file ?? ""))
  );
}

function v8FnName(raw) {
  return (raw ?? "<anonymous>").replace(/^\S+\s+/, "").replace(/^async\s+/, "");
}

/** Vendored code that happens to live inside the checkout. */
const VENDORED =
  /(^|[\\/])(?:node_modules|\.venv|venv|\.tox|\.nox|site-packages|__pycache__|vendor|node_modules[\\/].*)(?:[\\/]|$)/;

/**
 * A test's own address, as pytest prints it in a summary line: `path.py::Class::test`.
 *
 * A warning escalated to an error reports its origin inside `_pytest/python.py`, so
 * the traceback holds no frame in the user's repo even though the named test IS this
 * repo's. Without this, a genuine reproduction of that class of failure reads as
 * "nothing landed inside this repo".
 */
export const TEST_NODEID = /[\w./\\-]+\.py(?:::[\w.[\]-]+){1,}/;

/**
 * Frames nearest the fault first.
 *
 * Python prints the outermost call first, so the throwing frame is LAST; V8
 * prints it FIRST. Tag frames by the syntax that matched rather than by the
 * detected runner — a plain `python crash.py` has no runner name, and keying the
 * reversal on it ranked the caller above the function that actually threw.
 */
export function parseFrames(output, cwd = "") {
  const py = [];
  const loc = [];
  const js = [];
  for (const line of (output ?? "").split(/\r?\n/)) {
    const m = PY_FRAME.exec(line);
    if (m) {
      py.push(frame(repoRelative(m[1], cwd), Number(m[2]), m[3] ?? "<module>", line.trim()));
      continue;
    }
    const v8 = V8_FRAME.exec(line);
    // `node:` frames are runtime plumbing (async_hooks, test_runner) — never a
    // candidate in the user's repo, and they crowd out the real frames.
    if (v8 && !/^node:/.test(v8[2])) {
      js.push(frame(repoRelative(v8[2], cwd), Number(v8[3]), v8FnName(v8[1]), line.trim()));
      continue;
    }
    const at = LOC_FRAME.exec(line.trim());
    if (at) {
      const rest = at[3] ?? "";
      loc.push(
        frame(
          repoRelative(at[1], cwd),
          Number(at[2]),
          rest.startsWith("in ") ? rest.slice(3).trim() : "<module>",
          line.trim(),
        ),
      );
    }
  }
  // A pytest location line already names the failing spot, so its order is right;
  // only Python's traceback needs reversing. Tag by the syntax that matched.
  return [...py.reverse(), ...loc, ...js];
}

/** The assertion pytest blamed, if any — cheap signal for `why`. */
export function parseAssertion(output) {
  for (const line of (output ?? "").split(/\r?\n/)) {
    const m = PYTEST_ASSERT.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * coverage.py JSON → fail-only line sites.
 *
 * Failing-run lines that a passing run never touched are the strongest cheap
 * localization signal there is, which is why `--baseline` is worth the extra
 * command. Without a baseline every executed line is reported, which is noise
 * the model will over-trust — so the draft says so in `notes`.
 */
export function coveredSites(failing, passing, cap = 40) {
  if (!failing) return [];
  const sites = [];
  const files = failing.files ?? failing;
  const base = passing?.files ?? passing ?? {};
  for (const [file, data] of Object.entries(files)) {
    const lines = data?.executed_lines ?? data?.lines ?? [];
    const hitByPass = new Set(base[file]?.executed_lines ?? base[file]?.lines ?? []);
    for (const line of passing ? lines.filter((l) => !hitByPass.has(l)) : lines) {
      sites.push({
        file: toPosix(file),
        line,
        inside: !isAbsoluteLike(toPosix(file)) && !VENDORED.test("/" + toPosix(file)),
      });
      if (sites.length >= cap) return sites;
    }
  }
  return sites;
}

/**
 * Coverage is only worth collecting if the repo can collect it, and a python
 * repo's toolchain is decided by the interpreter its own command uses, not by
 * whatever is on this PATH. `available` is injectable so tests need no spawn.
 */
export function coverageHint(command, cwd, available = hasCoverage) {
  const exe = interpreterOf(command);
  if (!exe) return null;
  if (!available(cwd, exe)) return null;
  const runner = /-m\s+unittest\b|unittest\.main/.test(command) ? "unittest -q" : "-m pytest -q";
  return (
    `no coverage supplied — rerun as \`coverage run -m ${runner.replace("-m ", "")}\` in the same directory, ` +
    "then `coverage json -o cov-failing.json`, and pass it with --coverage " +
    "(add --baseline from a passing run to rank fail-only lines)"
  );
}

/**
 * The interpreter a command would use, or null when that is not knowable from
 * the first token. `poetry run pytest` and `pipenv run pytest` are launchers:
 * probing them can resolve an environment, build a venv, or prompt — for a hint.
 * `cd tests && pytest` is not an interpreter either. Both get no hint, which is
 * the correct answer, not a missing one.
 */
const INTERPRETER = /^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*|py)$/i;

function interpreterOf(command) {
  const first = command.trim().match(/^"([^"]+)"|^'([^']+)'|^([^\s]+)/);
  const token = (first ?? []).filter(Boolean).pop() ?? "";
  // Both separators: a Windows venv path is `C:\...\Scripts\python.exe`, and
  // splitting only on `/` left the whole string as the "basename", so the
  // interpreter test failed and the hint silently never fired on Windows.
  const base = baseName(token).replace(/\.exe$/i, "");
  return INTERPRETER.test(base) ? token : null;
}

/**
 * Does the interpreter this command would use have coverage.py?
 *
 * One pre-quoted string, never `spawn(exe, args, { shell: true })`: with a shell,
 * node concatenates the array instead of escaping it, so `-c "import coverage"`
 * arrives as two words, python compiles the bare word `import`, and a repo that
 * does have coverage is told it does not. Node says so itself with DEP0190.
 */
function hasCoverage(cwd, exe) {
  try {
    const probe = spawnSync(`"${exe}" -c "import coverage"`, {
      cwd,
      shell: true,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`[ducktective] could not read ${path}: ${err.message}`);
    return null;
  }
}

/** Rank frames + fail-only coverage into at most `maxCandidates` locations. */
export function seedCandidates(frames, sites, maxCandidates, assertion) {
  const byLoc = new Map();
  const add = (loc, source, fn) => {
    const seen = byLoc.get(loc);
    if (seen) {
      if (source === "coverage" && seen.source.startsWith("stack")) seen.source = "stack+coverage";
      if (fn && (!seen.fn || seen.fn === "<module>")) seen.fn = fn;
      return;
    }
    byLoc.set(loc, { location: loc, fn: fn ?? null, source });
  };
  // Leads inside the repo first, dependency/runtime frames last: a traceback that
  // only touches site-packages is a clue about the environment, not the bug.
  for (const f of frames) if (f.inside) add(`${f.file}:${f.line}`, "stack", f.fn);
  for (const s of sites) if (s.inside !== false) add(`${s.file}:${s.line}`, "coverage", null);
  for (const f of frames) if (!f.inside) add(`${f.file}:${f.line}`, "external", f.fn);
  return [...byLoc.values()].slice(0, maxCandidates).map((c, i) => ({
    rank: i + 1,
    location: `${c.location}${c.fn && c.fn !== "<module>" ? ` ${c.fn}()` : ""}`,
    why:
      c.source === "external"
        ? "in the failing traceback but outside this repo — a dependency or the runtime, check it after the local leads"
        : c.source === "stack+coverage"
          ? `in the failing traceback and covered by the failing run only${assertion ? `; run reported: ${assertion}` : ""}`
          : c.source === "stack"
            ? `appears in the failing traceback${assertion ? `; run reported: ${assertion}` : ""}`
            : "executed by the failing run and by no passing run",
    hypothesis: "",
    check: "",
    verdict: "pending",
    evidence: "",
  }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;
  const result = await run(opts.command, opts);
  // Test runners disagree about which stream the traceback belongs on: pytest
  // and unittest write to stderr, `node --test` reports failures on stdout.
  // Reading only stderr silently produced "no frames" for every JS repo.
  const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
  const runner = detectRunner(opts.command, output);
  const frames = parseFrames(output, opts.cwd);
  const assertion = parseAssertion(output);
  const coverage = readJson(opts.coverage);
  const sites = coveredSites(coverage, readJson(opts.baseline));
  const local = frames.filter((f) => f.inside);
  const localSites = sites.filter((s) => s.inside !== false);

  let outcome;
  const notes = [];
  if (result.spawnError) {
    outcome = "error";
    notes.push(
      "the harness could not start the command — fix the command, then retry before drawing any conclusion",
    );
  } else if (result.timedOut) {
    outcome = "error";
    notes.push(
      `killed the whole process tree after ${opts.timeout} ms — a hang is not a reproduction`,
    );
  } else if (local.length === 0 && wasNotRunnable(result)) {
    outcome = "error";
    notes.push(
      "the command itself could not be run — a missing binary is not a reproduction of the symptom",
    );
  } else if (result.code === 0) {
    outcome = "does_not_reproduce";
    notes.push(
      "the command passed, so the reported symptom did not occur; the ticket may be stale",
    );
  } else if (local.length === 0 && localSites.length === 0 && !TEST_NODEID.test(output)) {
    // A non-zero exit is only a reproduction if something in THIS repo failed.
    // Deciding that from *evidence* rather than from a list of error strings is
    // the point: a real repo I did not write (scientific-agent-skills) exited 2
    // with `ERROR: cannot collect 105 skills in one process …`, matched none of
    // the known signatures, and was filed as `reproduced` with zero candidates.
    // Usage errors, collection refusals and dependency-only crashes all look
    // like this; none of them is a symptom reproduced in the user's code.
    outcome = "error";
    notes.push(
      (RUNNER_MISUSE.test(output)
        ? "the runner refused to execute anything in this repo (bad path, bad flag, uncollectable tree) "
        : "the command failed but no traceback frame or fail-only coverage line lands inside this repo ") +
        `— exit ${result.code}; read stderr before treating this as the symptom`,
    );
  } else {
    outcome = "reproduced";
  }
  if (result.note?.length) notes.push(result.note.join("; "));

  // A non-reproducing or errored case must carry no candidates at all (SKILL.md
  // rule 2), so the draft stops instead of tempting the next step.
  const candidates =
    outcome === "reproduced" ? seedCandidates(frames, sites, opts.maxCandidates, assertion) : [];
  if (outcome === "reproduced" && coverage && !opts.baseline) {
    notes.push(
      "coverage has no passing-run baseline: every executed line is listed, so treat coverage as weak evidence",
    );
  }
  if (outcome === "reproduced" && !coverage) {
    // The doc asks the harness to capture coverage, not merely accept it; a repo
    // that has coverage.py installed can, so say exactly how in its own terms.
    const hint = coverageHint(opts.command, opts.cwd);
    if (hint) notes.push(hint);
  }

  const draft = {
    id: newCaseId(),
    opened_at: new Date().toISOString(),
    symptom: opts.symptom ?? "",
    reproduction: {
      command: opts.command,
      outcome,
      duration_ms: result.durationMs,
      exit_code: result.code,
      runner,
      stdout: clip(result.stdout, opts.maxBytes),
      stderr: clip(result.stderr, opts.maxBytes),
      stack: frames.map((f) => f.raw),
      // `inside` is ranking metadata, not evidence — the schema rejects unknown keys.
      covered: (localSites.length ? localSites : sites).map(({ file, line }) => ({ file, line })),
    },
    candidates,
    confirmed_cause: null,
    leading_hypothesis:
      outcome === "error"
        ? `harness could not evaluate the symptom: ${notes[0] ?? "unknown"}`
        : null,
    confidence: "none",
    suggested_patch: null,
    // `error` describes the reproduction, not the verdict: the only status that
    // is honest about an unanswered question is `unverified`.
    status:
      outcome === "reproduced" ? "open" : outcome === "error" ? "unverified" : "does_not_reproduce",
    notes: notes.join(" | "),
  };

  const shape = validateSchema(draft, SCHEMA);
  if (shape.length) console.error(`[ducktective] draft violates the schema: ${shape.join("; ")}`);

  const body = JSON.stringify(draft, null, 2);
  if (opts.out) {
    // The documented example writes `.ducktective/draft.json`, and on the first
    // investigation in a repo that folder does not exist yet. Failing here threw away
    // a reproduction that had already run: the gate proved the bug, then exited 2 as an
    // error, so the happy path on a fresh repo looked exactly like a broken one.
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(opts.out, body + "\n", "utf8");
  }
  console.log(body);
  // exitCode, never process.exit(): stdout to a pipe is asynchronous, and
  // exiting the tick early can drop the JSON the agent is about to read.
  process.exitCode = outcome === "reproduced" ? 0 : outcome === "error" ? 2 : 1;
}

function realpathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Importable by the tests, runnable by the host agent.
if (process.argv[1] && pathToFileURL(realpathOr(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(`[ducktective] reproduce failed: ${err.message}`);
    process.exitCode = 2;
  });
}

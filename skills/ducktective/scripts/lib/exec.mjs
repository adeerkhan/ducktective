/**
 * Running a command on someone else's machine, once, correctly.
 *
 * `reproduce.mjs` and `run_check.mjs` share this because every lesson here is a
 * bug that already happened once: Windows will not resolve a `.cmd` shim without
 * a shell, killing the shell orphans the real process, a nested test runner lies
 * about its exit code, and a chatty suite will exhaust your memory while you
 * clip nothing.
 */
import { spawn } from "node:child_process";

/**
 * A shell resolves the command string itself, so a missing binary does not
 * raise: it exits 1 (cmd.exe) or 127 (sh) and prints "not recognized". Left
 * alone, that reads as a reproduced failure or a passing check.
 */
const NOT_RUNNABLE =
  /\bis not recognized as (?:an internal or external command|the name of a program|a cmdlet)\b|:\s*(?:\S+: )?(?:command )?not found\b|No such file or directory/i;

/** True when the run looks like "the thing you asked me to run could not run". */
export function wasNotRunnable(result) {
  if (result.spawnError) return true;
  if (result.code === 127 || result.code === 9009) return true;
  return NOT_RUNNABLE.test(`${result.stderr}\n${result.stdout}`);
}

/**
 * The host agent may itself be running inside a test runner. Node marks those
 * children with `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID`, and a nested
 * `node --test` that inherits them exits 0 and prints nothing — which the gate
 * would report as "does not reproduce" for a genuinely broken JS repo. Drop the
 * runner's own plumbing so the command behaves as it does in the user's shell.
 */
export function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^NODE_TEST_/i.test(key)) delete env[key];
  return env;
}

/**
 * Kill the whole tree, not just the shell.
 *
 * With `shell: true` the child is `cmd.exe`/`sh`; killing it leaves the hung
 * `pytest`/`node` grandchild holding the port and the lock while the harness
 * reports a timeout. POSIX: the child leads its own group (`detached`), so
 * signal the negated pid. Windows: `taskkill /T` walks the tree.
 */
function stopTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run `command` through the user's shell and collect bounded evidence.
 *
 * `shell: true` is load-bearing: `--cmd` is an arbitrary human string
 * ("python -m pytest -q tests/x.py | tail -20"), and on Windows a bare
 * `vite`/`pytest` name has no `.exe` for libuv to find. This is the user's own
 * command in the user's own repo — pipes and `&&` are the point, not a hazard.
 *
 * Output accumulates as Buffers against a hard ceiling and is decoded once: a
 * `pytest -s` that spews 400 MB must not OOM the harness, and per-chunk string
 * coercion splits multibyte characters that land across a chunk boundary.
 *
 * Resolves with `code: null` when the process was signalled, so a timeout is
 * never mistaken for a passing check.
 */
export function run(command, { cwd = process.cwd(), timeout = 120_000, maxBytes = 4000 } = {}) {
  const ceiling = Math.max(maxBytes * 20, 1_000_000);
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: childEnv(),
      detached: process.platform !== "win32",
    });
    const chunks = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };
    const note = [];
    let timedOut = false;
    for (const key of ["stdout", "stderr"]) {
      child[key].on("data", (d) => {
        if (bytes[key] >= ceiling) {
          if (!note.length || !note.some((n) => n.startsWith(`stopped reading ${key}`))) {
            note.push(`stopped reading ${key} after ${bytes[key]} bytes`);
          }
          return;
        }
        chunks[key].push(d);
        bytes[key] += d.length;
      });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree(child);
    }, timeout);
    const decode = (key) => Buffer.concat(chunks[key]).toString("utf8");
    child.on("error", (err) => {
      clearTimeout(timer);
      done({
        code: null,
        stdout: decode("stdout"),
        stderr: `${decode("stderr")}\n${err.message}`,
        durationMs: Date.now() - started,
        spawnError: true,
        timedOut,
        note,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({
        code: signal ? null : code,
        stdout: decode("stdout"),
        stderr: decode("stderr"),
        durationMs: Date.now() - started,
        spawnError: false,
        timedOut,
        note,
      });
    });
  });
}

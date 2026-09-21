/**
 * Harness adapters: which agent CLI runs an arm, and how to detect one.
 *
 * The benchmark must spawn a *fresh* agent for each arm, so it shells out to the
 * harness's own headless command. This registry keeps that knowledge in one place
 * so the caller says `--agent opencode` (or nothing, and we detect) instead of
 * hand-writing a command string.
 *
 * A harness is added here **only after its headless flags are verified against
 * its docs** — a guessed flag is a wrong measurement. Until then, use the
 * `--agent-cmd` escape hatch with any harness (Claude Code, Codex, ...).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_DIR = dirname(fileURLToPath(import.meta.url));

export const HARNESSES = Object.freeze({
  opencode: {
    name: "opencode",
    bin: "opencode",
    adapter: "opencode-agent.mjs",
    description: "OpenCode v2 — `opencode run --format json --auto`",
  },
  stub: {
    name: "stub",
    bin: null,
    adapter: "stub-agent.mjs",
    description: "model-free stub, for tests and CI only",
  },
});

/** Preference order for auto-detection. Extend as harnesses are verified. */
export const PREFERENCE = Object.freeze(["opencode"]);

/**
 * Is `bin` runnable here? Probed through the shell, because on Windows an
 * npm-installed CLI is a `.cmd`/`.ps1` shim that `spawn` cannot execute directly.
 * One command string (not an args array) avoids Node's DEP0190 concatenation warning.
 */
export function onPath(bin) {
  if (!bin) return false;
  const r = spawnSync(`${bin} --version`, {
    encoding: "utf8",
    windowsHide: true,
    shell: true,
    timeout: 15_000,
  });
  return !r.error && r.status === 0;
}

/** The first installed harness in `PREFERENCE`, or null. `available` is injectable. */
export function detectHarness(available = onPath) {
  for (const name of PREFERENCE) if (available(HARNESSES[name].bin)) return name;
  return null;
}

/** The agent command for a harness: `node "<bench>/<adapter>"`. */
export function agentCommand(harness, benchDir = BENCH_DIR) {
  const h = HARNESSES[harness];
  if (!h)
    throw new Error(`unknown harness "${harness}"; known: ${Object.keys(HARNESSES).join(", ")}`);
  return `node "${join(benchDir, h.adapter)}"`;
}

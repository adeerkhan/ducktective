/**
 * The installer, against a local checkout only.
 *
 * The download path needs the network, so it is exercised by hand; everything
 * that could go wrong *to a user's files* — clobbering an edited SKILL.md,
 * installing half the tools, installing the test fixtures — is tested here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { skillFiles } from "../bin/install.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, "..");
const INSTALL = join(SKILL_ROOT, "bin", "install.mjs");

/** An empty home: target resolution must be computed, never found on this box. */
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "dt-home-"));

function install(args) {
  const run = spawnSync(process.execPath, [INSTALL, "--source", SKILL_ROOT, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

const dest = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dt-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "skills", "ducktective");
};

test("skillFiles ships the contract and the tools, never the test bench", () => {
  const files = skillFiles(SKILL_ROOT);
  assert.ok(files.includes("SKILL.md"));
  assert.ok(files.includes("case-file.schema.json"));
  for (const tool of ["reproduce", "run_check", "write_case", "query_memory"]) {
    assert.ok(files.includes(`scripts/${tool}.mjs`), `${tool} must ship`);
  }
  assert.ok(files.includes("scripts/lib/exec.mjs"), "shared internals must ship too");
  assert.equal(
    files.some((f) => f.startsWith("tests/")),
    false,
    "fixtures are not part of an installed skill",
  );
  assert.equal(
    files.some((f) => f.startsWith("bin/")),
    false,
    "the installer does not install itself",
  );
});

test("a clean install writes every listed file and nothing else", (t) => {
  const to = dest(t);
  const { code, out } = install(["--dest", to]);
  assert.equal(code, 0, out + errOf(out));
  const report = JSON.parse(out);
  assert.equal(report.installed, true);
  assert.equal(report.files, skillFiles(SKILL_ROOT).length);
  assert.deepEqual(report.tools.sort(), [
    "query_memory.mjs",
    "reproduce.mjs",
    "run_check.mjs",
    "write_case.mjs",
  ]);
  for (const rel of skillFiles(SKILL_ROOT)) assert.ok(existsSync(join(to, rel)), `${rel} missing`);
});

test("--target resolves to the folders each agent actually scans", () => {
  // Facts, not guesses: Claude Code reads ~/.claude/skills; Codex reads
  // $HOME/.agents/skills and $CWD/.agents/skills per developers.openai.com/codex/skills
  // — there is no ~/.codex/skills scan, so pointing the installer there would
  // "succeed" while installing nothing. --dry-run resolves the target and writes
  // nothing, so this never touches the real home directory.
  const where = (target) => {
    const run = spawnSync(
      process.execPath,
      [INSTALL, "--source", SKILL_ROOT, "--target", target, "--dry-run"],
      {
        encoding: "utf8",
        windowsHide: true,
        // A --target is resolved under $HOME, so an install sitting in the real
        // home directory makes this test disagree depending on the machine. Point
        // HOME at an empty folder: the target must be computed, never found.
        env: { ...process.env, HOME: EMPTY_HOME, USERPROFILE: EMPTY_HOME },
      },
    );
    return JSON.parse(run.stdout).dest;
  };
  assert.equal(where("claude"), join(EMPTY_HOME, ".claude", "skills", "ducktective"));
  const codex = where("codex");
  assert.equal(codex, join(EMPTY_HOME, ".agents", "skills", "ducktective"));
  assert.ok(!codex.includes(".codex"), `codex must not point at ~/.codex: ${codex}`);
  assert.equal(where("agents"), join(process.cwd(), ".agents", "skills", "ducktective"));
  assert.ok(
    !where("claude").startsWith(process.cwd()),
    "a user target must not resolve inside the checkout",
  );
});

test("run from a clone, it installs itself with no --source and no network", (t) => {
  const to = dest(t);
  const run = spawnSync(process.execPath, [INSTALL, "--dest", to], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(
    report.source,
    `checkout ${SKILL_ROOT}`,
    "the clone beside this script is the default source",
  );
  assert.equal(report.files, skillFiles(SKILL_ROOT).length);
});

test("an installed skill runs its own tools from its own directory", (t) => {
  const to = dest(t);
  install(["--dest", to]);
  const run = spawnSync(process.execPath, [join(to, "scripts", "query_memory.mjs"), "--help"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /usage: query_memory\.mjs/);
});

test("re-running is a no-op, not a rewrite", (t) => {
  const to = dest(t);
  install(["--dest", to]);
  const again = JSON.parse(install(["--dest", to]).out);
  assert.equal(again.written, 0);
  assert.equal(again.skipped_unchanged, again.files);
});

test("a hand-edited skill file is never silently overwritten", (t) => {
  const to = dest(t);
  install(["--dest", to]);
  const skill = join(to, "SKILL.md");
  writeFileSync(
    skill,
    readFileSync(skill, "utf8").replace(
      "No claim without a check.",
      "No claim without a check. (tuned)",
    ),
    "utf8",
  );
  const refused = install(["--dest", to]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Refusing to overwrite 1 file/);
  assert.match(refused.err, /--force/);
  assert.match(readFileSync(skill, "utf8"), /tuned/, "the refusal must not touch the file");
  const forced = install(["--dest", to, "--force"]);
  assert.equal(forced.code, 0);
  assert.equal(JSON.parse(forced.out).written, 1);
  assert.doesNotMatch(readFileSync(skill, "utf8"), /tuned/);
});

test("--dry-run plans without writing, and a bad --target is refused", (t) => {
  const to = dest(t);
  const { code, out, err } = install(["--dest", to, "--dry-run"]);
  assert.equal(code, 0);
  assert.match(err, /DRY RUN/);
  assert.ok(out.trim().startsWith("{"), "stdout stays pure JSON even in dry run");
  JSON.parse(out);
  assert.equal(existsSync(to), false);
  assert.equal(install(["--target", "notepad"]).code, 2);
});

const errOf = (out) => (out ? "" : " (empty stdout)");

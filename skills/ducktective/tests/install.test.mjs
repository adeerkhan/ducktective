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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { skillFiles } from "../bin/install.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, "..");
const INSTALL = join(SKILL_ROOT, "bin", "install.mjs");

/** An empty home: target resolution must be computed, never found on this box.
 * Created by the one test that needs it, so no scratch directory outlives a run. */
const emptyHome = () => mkdtempSync(join(tmpdir(), "dt-home-"));

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
  for (const tool of ["reproduce", "run_check", "write_case", "bisect", "check"]) {
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
    "bisect.mjs",
    "check.mjs",
    "reproduce.mjs",
    "run_check.mjs",
    "write_case.mjs",
  ]);
  for (const rel of skillFiles(SKILL_ROOT)) assert.ok(existsSync(join(to, rel)), `${rel} missing`);
});

test("--target resolves to the folder each agent actually scans", (t) => {
  // Facts, not guesses: Claude Code reads ~/.claude/skills; OpenCode reads
  // ~/.config/opencode/skills (V2 docs, Configure → Skills). --dry-run resolves
  // the target and writes nothing, so this never touches the real home directory.
  const where = emptyHome();
  t.after(() => rmSync(where, { recursive: true, force: true }));
  const forTarget = (target) => {
    const run = spawnSync(
      process.execPath,
      [INSTALL, "--source", SKILL_ROOT, "--target", target, "--dry-run"],
      {
        encoding: "utf8",
        windowsHide: true,
        // A --target is resolved under $HOME, so an install sitting in the real
        // home directory makes this test disagree depending on the machine. Point
        // HOME at an empty folder: the target must be computed, never found.
        env: { ...process.env, HOME: where, USERPROFILE: where },
      },
    );
    return JSON.parse(run.stdout).dest;
  };
  assert.equal(forTarget("claude"), join(where, ".claude", "skills", "ducktective"));
  assert.equal(forTarget("opencode"), join(where, ".config", "opencode", "skills", "ducktective"));
  assert.equal(forTarget("agents"), join(where, ".agents", "skills", "ducktective"));
  // The retired target stays refused: accepting a name would promise an install
  // for an agent whose scan path nobody has verified.
  assert.equal(
    spawnSync(process.execPath, [INSTALL, "--target", "codex", "--dry-run"], {
      encoding: "utf8",
      windowsHide: true,
    }).status,
    2,
    "--target codex is retired and must be refused, not guessed",
  );
  for (const target of ["claude", "opencode", "agents"])
    assert.ok(
      !forTarget(target).startsWith(process.cwd()),
      `the ${target} target must not resolve inside the checkout`,
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
  const run = spawnSync(process.execPath, [join(to, "scripts", "reproduce.mjs"), "--help"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /usage: reproduce\.mjs/);
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

test("an untouched install upgrades without --force; a hand-edit still conflicts", (t) => {
  const to = dest(t);
  install(["--dest", to]);

  // A newer source: same skill, one file changed upstream.
  const src = mkdtempSync(join(tmpdir(), "dt-src-"));
  t.after(() => rmSync(src, { recursive: true, force: true }));
  cpSync(SKILL_ROOT, src, { recursive: true });
  const upstreamSkill = join(src, "SKILL.md");
  writeFileSync(
    upstreamSkill,
    readFileSync(upstreamSkill, "utf8") + "\n<!-- upstream -->\n",
    "utf8",
  );

  const upgraded = install(["--source", src, "--dest", to]);
  assert.equal(upgraded.code, 0, upgraded.err);
  assert.equal(
    JSON.parse(upgraded.out).written,
    1,
    "a file the last install wrote updates without --force",
  );

  // The user edits the installed copy: the next upstream change must be refused.
  const installed = join(to, "SKILL.md");
  writeFileSync(installed, readFileSync(installed, "utf8") + "\n<!-- mine -->\n", "utf8");
  writeFileSync(
    upstreamSkill,
    readFileSync(upstreamSkill, "utf8") + "\n<!-- upstream 2 -->\n",
    "utf8",
  );
  const refused = install(["--source", src, "--dest", to]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Refusing to overwrite 1 file/);
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

test("a tool retired upstream is reported, and only removed when told to", (t) => {
  // The installer adds and updates; without this it never subtracts, so
  // `query_memory.mjs` sat in an installed skill after the repo deleted it and a
  // host agent would still have found a script the docs stopped describing.
  const to = dest(t);
  install(["--dest", to]);
  const ghost = join(to, "scripts", "query_memory.mjs");
  mkdirSync(dirname(ghost), { recursive: true });
  writeFileSync(ghost, "// retired upstream", "utf8");

  const seen = install(["--dest", to, "--dry-run"]);
  assert.deepEqual(JSON.parse(seen.out).stale, ["scripts/query_memory.mjs"]);
  assert.ok(existsSync(ghost), "a dry run must not delete anything");

  const plain = install(["--dest", to]);
  assert.deepEqual(JSON.parse(plain.out).stale, ["scripts/query_memory.mjs"]);
  assert.deepEqual(JSON.parse(plain.out).stale_removed, []);
  assert.ok(existsSync(ghost), "an unasked-for delete is a clobber by another name");

  const forced = install(["--dest", to, "--force"]);
  assert.deepEqual(JSON.parse(forced.out).stale_removed, ["scripts/query_memory.mjs"]);
  assert.ok(!existsSync(ghost), "--force means prune what the source no longer ships");
});

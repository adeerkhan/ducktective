#!/usr/bin/env node
/**
 * Guard the invariant this repo layout rests on: SKILL.md has exactly one
 * committed copy, and the website reads that file instead of carrying its own.
 *
 * The failure mode is silent — someone pastes the skill text back into
 * `site/src/`, the site keeps rendering fine, and the two copies drift apart on
 * the next edit. Only the copy button and the curl URL disagree later, which is
 * the part nobody notices.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = join(ROOT, "skills", "ducktective", "SKILL.md");

// Match a filename token, not the suffix of run_check.mjs.
function mentionsTool(text, tool) {
  return (text.match(/[A-Za-z0-9_.-]+\.mjs/g) ?? []).includes(tool);
}

test("tool mentions require an exact filename", () => {
  assert.equal(mentionsTool("`run_check.mjs`", "check.mjs"), false);
  assert.equal(mentionsTool("`scripts/check.mjs`", "check.mjs"), true);
});

/** Every committed file named SKILL.md, anywhere below `dir`. */
function skillFiles(dir) {
  const found = [];
  // `ref/` is gitignored research clones that ship their own SKILL.md files,
  // and `dist/` is build output — neither is a copy we control.
  const skip = new Set(["node_modules", "ref", "dist"]);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...skillFiles(path));
    else if (entry.name === "SKILL.md") found.push(path);
  }
  return found;
}

test("the skill has one committed source of truth", () => {
  assert.deepEqual(skillFiles(ROOT), [SKILL]);
});

test("SKILL.md is a valid Agent Skill frontmatter for `ducktective`", () => {
  const text = readFileSync(SKILL, "utf8");
  const [, frontmatter] = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text) ?? [];
  assert.ok(frontmatter, "SKILL.md must open with a --- frontmatter block");
  assert.match(frontmatter, /^name: ducktective$/m);
  assert.match(frontmatter, /^description: \S/m);
});

// The site used to render SKILL.md through `?raw`, and this test watched for a
// second copy. The site is gone; the single-source check above is the part still
// worth a guard, and `?raw` would now be a reference to a build that does not exist.

/**
 * The reference doc is what future work is based on, so it is checked like code:
 * a tool or a route missing from it is a silent lie by omission, which is the
 * only way documents rot in practice.
 */
/**
 * The reference doc is what future work is based on, so it is checked like code:
 * a tool missing from it is a silent lie by omission, which is the only way
 * documents rot in practice. The site's routes were listed here too, until the site
 * was deleted; the loop stayed useful for the one thing it can actually see — the
 * scripts the installer ships.
 */
test("docs/architecture.md stays a true reference", () => {
  // A file on disk is not a file in the repo. This test reads the reference, so a
  // stray ignore rule (a bare `docs/` has been appended to .gitignore twice now)
  // passes locally, where the file exists, and fails only on a clean checkout —
  // which is the worst possible place to discover it. Ask git, not the filesystem.
  if (existsSync(join(ROOT, ".git"))) {
    const tracked = execFileSync("git", ["ls-files", "--", "docs/architecture.md"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    assert.ok(
      tracked,
      "docs/architecture.md is untracked — an ignore rule is hiding the reference this test reads",
    );
  }
  const doc = readFileSync(join(ROOT, "docs", "architecture.md"), "utf8");
  const scriptsDir = join(ROOT, "skills", "ducktective", "scripts");
  for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      assert.ok(
        mentionsTool(doc, entry.name),
        `architecture.md never mentions shipped tool ${entry.name}`,
      );
    }
  }
  assert.ok(doc.includes("install.mjs"), "architecture.md omits the installer");
  // Derived, like the tool and route lists above: the guard that names a data file
  // by hand goes stale the day it is renamed, which is the failure it exists to catch.
  const ledger = readdirSync(join(ROOT, "evals")).find((f) => /^RUNLOG\./.test(f));
  assert.ok(ledger, "no evals/RUNLOG.* ledger on disk");
  for (const f of ["case-file.schema.json", "cases.jsonl", ledger, "evals/cases"]) {
    assert.ok(doc.includes(f), `architecture.md omits ${f}`);
  }
});

test("every tool the skill ships is documented in SKILL.md", () => {
  const skill = readFileSync(SKILL, "utf8");
  const scriptsDir = join(ROOT, "skills", "ducktective", "scripts");
  const tools = readdirSync(scriptsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
    .map((e) => e.name);
  assert.ok(tools.length > 0, "expected at least one tool script");
  for (const tool of tools) {
    assert.ok(
      mentionsTool(skill, tool),
      `SKILL.md never mentions ${tool} — an undocumented tool is a tool nobody runs`,
    );
  }
});

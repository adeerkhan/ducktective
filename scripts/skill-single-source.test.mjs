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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = join(ROOT, "skills", "ducktective", "SKILL.md");

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

test("the site imports SKILL.md instead of embedding a copy", () => {
  const page = readFileSync(join(ROOT, "site", "src", "routes", "skill.tsx"), "utf8");
  assert.match(page, /skills\/ducktective\/SKILL\.md\?raw/);
  assert.ok(!statSync(join(ROOT, "site", "src", "lib", "skill-doc.ts"), { throwIfNoEntry: false }));
});

/**
 * The reference doc is what future work is based on, so it is checked like code:
 * a tool or a route missing from it is a silent lie by omission, which is the
 * only way documents rot in practice.
 */
test("docs/architecture.md stays a true reference", () => {
  const doc = readFileSync(join(ROOT, "docs", "architecture.md"), "utf8");
  const scriptsDir = join(ROOT, "skills", "ducktective", "scripts");
  for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      assert.ok(
        doc.includes(entry.name),
        `architecture.md never mentions shipped tool ${entry.name}`,
      );
    }
  }
  assert.ok(doc.includes("install.mjs"), "architecture.md omits the installer");
  for (const route of readdirSync(join(ROOT, "site", "src", "routes"))) {
    const name = route.replace(/^__/, "").replace(/\.tsx$/, "");
    if (name === "root") continue;
    assert.ok(doc.includes(name), `architecture.md omits site route /${name}`);
  }
  for (const f of ["case-file.schema.json", "cases.jsonl", "RUNLOG.csv", "evals/cases"]) {
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
      skill.includes(tool),
      `SKILL.md never mentions ${tool} — an undocumented tool is a tool nobody runs`,
    );
  }
});

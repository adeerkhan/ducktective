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

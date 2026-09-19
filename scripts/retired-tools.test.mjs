#!/usr/bin/env node
/**
 * A tool retired upstream must not survive in executable shipped code.
 *
 * `query_memory.mjs` was removed from the skill, but the installer kept telling
 * users to verify the install with it — a shipped `.mjs` file pointing at a
 * script that no longer exists. Prose may explain a retirement (SKILL.md does
 * that on purpose); executable code may not keep calling it.
 *
 * Scope: only `.mjs` files under `skills/ducktective/scripts` and
 * `skills/ducktective/bin`. Docs, tests and this guard itself may name a retired
 * tool — naming it is how the retirement is recorded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = join(ROOT, "skills", "ducktective");

/** Filenames the repo has deliberately retired from the shipped skill. */
const RETIRED = ["query_memory.mjs"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

/**
 * Comments may explain a retirement; code may not call it. Block and line
 * comments are stripped before matching (but not the `//` in `https://`), so a
 * reviewed comment does not trip a guard meant for executable references.
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("no shipped executable names a retired tool", () => {
  const files = [join(SKILL, "scripts"), join(SKILL, "bin")]
    .filter((d) => existsSync(d))
    .flatMap((d) => walk(d));
  assert.ok(files.length > 0, "expected shipped .mjs files to scan");
  const offenders = [];
  for (const file of files) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const name of RETIRED) {
      if (text.includes(name)) offenders.push(`${file.replace(ROOT, ".")} names ${name}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a retired tool is still referenced by shipped code:\n${offenders.join("\n")}`,
  );
});

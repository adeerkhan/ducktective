#!/usr/bin/env node
/**
 * The Claude Code plugin manifests are hand-written JSON with no schema
 * watching them (json.schemastore.org has claude-code-marketplace.json but NOT
 * claude-code-plugin.json — checked, it 404s), so nothing else would notice a
 * stale version, a renamed skill folder, or a `skills` path that points at
 * nothing. `/plugin install` failing on a stranger's machine is a bad first
 * impression of a skill whose whole pitch is "no claim without a check".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const pkg = read("package.json");
const plugin = read(".claude-plugin/plugin.json");
const market = read(".claude-plugin/marketplace.json");
const entry = market.plugins[0];

test("the marketplace entry declares what Claude Code requires", () => {
  assert.equal(typeof market.name, "string");
  assert.match(market.name, /^[a-z0-9-]+$/, "marketplace name must be kebab-case");
  assert.ok(market.owner?.name, "owner.name is required");
  assert.equal(entry.name, "ducktective");
  assert.equal(typeof entry.source, "string", "a plugin entry needs a source");
  assert.equal(entry.source, "./", "this repo IS the plugin: skills/ sits at its root");
});

test("the source really is a plugin: manifest plus skill in the declared folder", () => {
  const base = join(ROOT, entry.source);
  assert.ok(
    existsSync(join(base, ".claude-plugin", "plugin.json")),
    "plugin.json must sit in the plugin source root",
  );
  // `skills` defaults to ./skills under the source; declaring it must not lie.
  const skills = join(base, (plugin.skills ?? "./skills").replace(/^.\//, ""));
  assert.ok(existsSync(join(skills, "ducktective", "SKILL.md")), `no SKILL.md under ${skills}`);
});

test("one version, agreed by both files", () => {
  assert.equal(plugin.version, pkg.version, "plugin.json drifted from package.json");
  assert.equal(plugin.name, entry.name);
  assert.equal(plugin.license, "MIT");
  assert.equal(entry.license, "MIT");
});

test("the README cannot document an install path the installer disagrees with", () => {
  // The README told people `--target codex` writes to ~/.codex/skills after the
  // code had been corrected to ~/.agents/skills. Nothing fails when prose drifts
  // from code, which is precisely the class of thing this skill is about.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const installer = readFileSync(join(ROOT, "skills/ducktective/bin/install.mjs"), "utf8");
  const codexTarget = /codex: \(\) => join\(homedir\(\), "([^"]+)", "skills"/.exec(installer);
  assert.ok(codexTarget, "install.mjs no longer declares a codex target the test can read");
  const wanted = `~/${codexTarget[1]}/skills/ducktective`; // the captured name already carries its dot
  assert.ok(readme.includes(wanted), `README must document ${wanted} for --target codex`);
  assert.ok(!readme.includes("~/.codex/skills"), "README documents a path Codex does not scan");
});

test("the plugin carries no npm-style baggage that would install the site", () => {
  // A marketplace install pulls the repo, so the README's site/dev bulk riding
  // along is a packaging problem, not a docs one.
  assert.equal(plugin.dependencies, undefined);
  assert.equal(
    plugin.mcpServers,
    undefined,
    "no daemon: the skill shells out (design doc: no new daemon)",
  );
});

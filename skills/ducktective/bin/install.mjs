#!/usr/bin/env node
/**
 * Install the Ducktective skill. One command, zero dependencies.
 *
 *   node skills/ducktective/bin/install.mjs --target claude
 *   node skills/ducktective/bin/install.mjs --dest .opencode/skills/ducktective
 *
 * It copies exactly what the host agent needs — `SKILL.md`, the case-file
 * schema, and the scripts — and nothing it doesn't: no tests, no fixtures, no
 * installer.
 *
 * It will not overwrite a copy you edited. Every file is hashed; a target that
 * differs from the source is refused unless `--force`, because the usual reason
 * a SKILL.md differs is that someone tuned it for their repo.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const SKILL_NAME = "ducktective";

/**
 * What ships. `bin/` and `tests/` stay behind: an installed skill is a contract
 * plus its tools, not a development checkout. `scripts/site-case-sync.test.mjs`
 * asserts this list matches the directory, so a new tool cannot be forgotten.
 */
const IGNORE = new Set(["tests", "bin", "__pycache__", ".pytest_cache"]);

/**
 * The record of the last install, so an upgrade can tell "upstream changed this"
 * from "the user changed this". Without it every differing file looks like a hand
 * edit, and every release makes `--force` mandatory.
 */
const MANIFEST = ".ducktective-install.json";
const INSTALLED_SKIP = new Set([MANIFEST]);

/**
 * The scan paths verified here, plus an escape hatch.
 *
 * Claude Code reads ~/.claude/skills/<name>. OpenCode reads
 * ~/.config/opencode/skills/<name> (V2 docs: Configure → Skills), and also reads
 * ~/.claude/skills and ~/.agents/skills for compatibility. `agents` is the
 * cross-harness global path (Agent Skills); `--dest` covers a project-local
 * install (.opencode/skills/<name>, committed with the repo) and anything else
 * that reads a SKILL.md.
 */
const TARGETS = {
  claude: () => join(homedir(), ".claude", "skills", SKILL_NAME),
  opencode: () => join(homedir(), ".config", "opencode", "skills", SKILL_NAME),
  agents: () => join(homedir(), ".agents", "skills", SKILL_NAME),
};

const USAGE = `usage: install.mjs [--target claude|opencode|agents] [--dest DIR] [--source DIR] [--force] [--dry-run]
  --target claude     ~/.claude/skills/ducktective (Claude Code; OpenCode reads it too)
  --target opencode   ~/.config/opencode/skills/ducktective (OpenCode, global)
  --target agents     ~/.agents/skills/ducktective (cross-harness Agent Skills path)
  --dest DIR          an explicit directory; wins over --target.
                      Project-local for OpenCode: --dest .opencode/skills/ducktective
  --force             overwrite files whose contents differ
  --dry-run           print the plan, write nothing`;

function parseArgs(argv) {
  const opts = { force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    switch (flag) {
      case "--target":
        if (!(value in TARGETS))
          throw new Error(`--target must be one of ${Object.keys(TARGETS).join(", ")}`);
        opts.target = value;
        break;
      case "--dest":
      case "--source":
        opts[flag.slice(2)] = resolve(value);
        break;
      case "--force":
        opts.force = true;
        i--;
        break;
      case "--dry-run":
        opts.dryRun = true;
        i--;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        return null;
      default:
        throw new Error(`unrecognised flag: ${flag}\n\n${USAGE}`);
    }
  }
  if (!opts.dest && !opts.target) opts.target = "claude";
  opts.dest = opts.dest ?? TARGETS[opts.target]();
  return opts;
}

/** Every file under `dir`, POSIX-relative to it, optionally skipping names. */
function walkRel(dir, skip = null) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (skip?.has(entry.name)) continue;
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(dir, path).replaceAll("\\", "/"));
    }
  };
  walk(dir);
  return out;
}

/** Every file that makes up an installed skill, relative to the skill root. */
export function skillFiles(root) {
  return walkRel(root, IGNORE).sort();
}

const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);

/** The skill folder this script lives in, when it is a clone. */
const SELF_SKILL = resolve(fileURLToPath(import.meta.url), "..", "..");

/**
 * The source is always a local checkout: this script's own skill folder, or
 * `--source`. A `--download` mode was deleted before it ever reached a user —
 * ~35 lines of GitHub-contents listing and raw fetching that no test could reach
 * and no release had exercised, while `git clone` plus this script and the Claude
 * Code plugin manifests already cover installing without a manual copy. Re-add it
 * only with an offline test, because an untested network path in an installer is
 * how a stranger's home directory ends up with half a skill.
 */
function makeSource(opts) {
  const root = resolve(opts.source ?? SELF_SKILL);
  if (!existsSync(join(root, "SKILL.md")))
    throw new Error(`--source ${root} has no SKILL.md — run this from a clone of the repo`);
  return {
    kind: `checkout ${root}`,
    list: () => skillFiles(root),
    read: (rel) => readFileSync(join(root, rel)),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;
  const source = makeSource(opts);
  const files = await source.list();
  if (!files.includes("SKILL.md"))
    throw new Error("the source has no SKILL.md — refusing to install an empty skill");

  const plan = [];
  const sourceHashes = {};
  const previous = readManifest(join(opts.dest, MANIFEST));
  for (const rel of files) {
    const data = await source.read(rel);
    const wanted = hash(data);
    sourceHashes[rel] = wanted;
    const target = join(opts.dest, rel);
    const current = existsSync(target) ? readFileSync(target) : null;
    const currentHash = current ? hash(current) : null;
    if (current && currentHash !== wanted) {
      // Only a file the last install wrote may be updated silently; a file that
      // diverged from the manifest is the user's, and is refused without --force.
      const ours = previous?.files?.[rel] === currentHash;
      if (!opts.force && !ours) {
        plan.push({ rel, action: "CONFLICT" });
        continue;
      }
      plan.push({ rel, action: "overwrite", bytes: data.length });
    } else if (current) {
      plan.push({ rel, action: "same" });
    } else {
      plan.push({ rel, action: "write", bytes: data.length });
    }
    if (!opts.dryRun && plan.at(-1).action !== "same") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
    }
  }

  // A tool retired upstream stays installed forever otherwise: the installer only
  // adds and updates, so `query_memory.mjs` outlived its own deletion and a host
  // agent would keep finding — and calling — a script the docs no longer describe.
  // Reported always; removed only with --force, because a file in the install
  // folder might be somebody's own addition.
  const want = new Set(files);
  const stale = [];
  for (const rel of listInstalled(opts.dest)) if (!want.has(rel)) stale.push(rel);
  if (stale.length && opts.force && !opts.dryRun)
    for (const rel of stale) rmSync(join(opts.dest, rel), { force: true });

  const conflicts = plan.filter((p) => p.action === "CONFLICT");
  if (conflicts.length) {
    console.error(`\nRefusing to overwrite ${conflicts.length} file(s) you have changed:\n`);
    for (const c of conflicts) console.error(`  ${join(opts.dest, c.rel)}`);
    console.error(`\nRe-run with --force to replace them, or merge by hand.`);
    process.exitCode = 1;
    return;
  }
  const changed = plan.filter((p) => p.action !== "same");
  if (!opts.dryRun)
    writeFileSync(
      join(opts.dest, MANIFEST),
      JSON.stringify({ source: source.kind, files: sourceHashes }, null, 2) + "\n",
    );
  console.log(
    JSON.stringify(
      {
        installed: !opts.dryRun,
        dest: opts.dest,
        source: source.kind,
        files: plan.length,
        written: changed.length,
        skipped_unchanged: plan.length - changed.length,
        tools: files
          .filter((f) => f.startsWith("scripts/") && !f.includes("lib/"))
          .map((f) => f.split("/").pop()),
        stale,
        stale_removed: stale.length && opts.force && !opts.dryRun ? stale : [],
      },
      null,
      2,
    ),
  );
  if (opts.dryRun)
    console.error(`\nDRY RUN — nothing written. Re-run without --dry-run to install.`);
  else
    console.error(
      `\nNext: restart your agent, then say "Ducktective, investigate this failing test." Verify the install with:\n  node ${join(opts.dest, "scripts", "reproduce.mjs")} --help`,
    );
}

if (process.argv[1] && pathToFileURL(realpathOr(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(`[ducktective] install failed: ${err.message}`);
    process.exitCode = 2;
  });
}

/** Every file currently installed under `dest`, in the same relative form `skillFiles` uses. */
function listInstalled(dest) {
  return existsSync(dest) ? walkRel(dest, INSTALLED_SKIP) : [];
}

/** The manifest of the last install, or null when there is none or it is unreadable. */
function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** node realpaths `import.meta.url` but leaves argv[1] as typed; compare like for like. */
function realpathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

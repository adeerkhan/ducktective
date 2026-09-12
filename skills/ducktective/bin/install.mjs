#!/usr/bin/env node
/**
 * Install the Ducktective skill. One command, zero dependencies.
 *
 *   node skills/ducktective/bin/install.mjs --target claude
 *   node skills/ducktective/bin/install.mjs --dest /path/to/.agents/skills
 *   curl -fsSL https://raw.githubusercontent.com/adeerkhan/ducktective/main/skills/ducktective/bin/install.mjs | node - --target claude
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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 * Verified destinations, not guesses:
 *   Claude Code — ~/.claude/skills/<name> (its documented skill folder).
 *   Codex       — $HOME/.agents/skills and $CWD/.agents/skills, per
 *                 developers.openai.com/codex/skills. There is no
 *                 ~/.codex/skills scan, which is why `agents` (project) and
 *                 `codex` (user) share the `.agents/skills` base.
 * Anything else (Cursor, Copilot, Gemini CLI) takes --dest.
 */
const TARGETS = {
  claude: () => join(homedir(), ".claude", "skills", SKILL_NAME),
  codex: () => join(homedir(), ".agents", "skills", SKILL_NAME),
  agents: () => join(process.cwd(), ".agents", "skills", SKILL_NAME),
};

const RAW_BASE = "https://raw.githubusercontent.com/adeerkhan/ducktective/main/skills/ducktective";

const USAGE = `usage: install.mjs [--target claude|codex|agents] [--dest DIR] [--source DIR] [--force] [--dry-run]
  --target NAME     claude (~/.claude/skills) | codex (~/.agents/skills) | agents (./.agents/skills)
  --dest DIR        an explicit directory; wins over --target
  --source DIR      copy from this checkout instead of downloading (default: the skill folder this script sits in)
  --download        fetch the file list and contents from GitHub instead of copying locally
  --force           overwrite files whose contents differ
  --dry-run         print the plan, write nothing`;

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
      case "--download":
        opts.download = true;
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

/** Every file that makes up an installed skill, relative to the skill root. */
export function skillFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return out.sort();
}

const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);

/** Local checkout or the raw GitHub URL — the rest of the tool does not care. */
/** The skill folder this script lives in, when it is a clone. */
const SELF_SKILL = resolve(fileURLToPath(import.meta.url), "..", "..");

function makeSource(opts) {
  const root = resolve(
    opts.source ?? (existsSync(join(SELF_SKILL, "SKILL.md")) && !opts.download ? SELF_SKILL : ""),
  );
  if (root && existsSync(join(root, "SKILL.md"))) {
    return {
      kind: `checkout ${root}`,
      list: () => skillFiles(root),
      read: (rel) => readFileSync(join(root, rel)),
    };
  }
  if (root) throw new Error(`--source ${root} has no SKILL.md`);
  if (!opts.download)
    throw new Error(
      `no --source and this script is not inside a skill folder — pass --source DIR, or --download to fetch from GitHub\n\n${USAGE}`,
    );
  /** @type {Map<string, Buffer>} */
  const fetched = new Map();
  return {
    kind: RAW_BASE,
    async list() {
      // The manifest is the file list, fetched as text so one network path
      // covers both modes. A hardcoded list would rot the day a tool is added.
      const scripts = [];
      for (const dir of ["scripts", "scripts/lib"]) {
        const res = await fetch(
          `https://api.github.com/repos/adeerkhan/ducktective/contents/skills/ducktective/${dir}`,
        );
        if (!res.ok) throw new Error(`could not list ${dir}: HTTP ${res.status}`);
        for (const entry of await res.json()) {
          if (entry.type === "file" && entry.name.endsWith(".mjs"))
            scripts.push(`${dir}/${entry.name}`);
        }
      }
      return ["SKILL.md", "case-file.schema.json", ...scripts];
    },
    async read(rel) {
      if (fetched.has(rel)) return fetched.get(rel);
      const res = await fetch(`${RAW_BASE}/${rel}`);
      if (!res.ok) throw new Error(`could not download ${rel}: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fetched.set(rel, buf);
      return buf;
    },
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
  for (const rel of files) {
    const data = await source.read(rel);
    const target = join(opts.dest, rel);
    const current = existsSync(target) ? readFileSync(target) : null;
    if (current && hash(current) !== hash(data)) {
      if (!opts.force) {
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

  const conflicts = plan.filter((p) => p.action === "CONFLICT");
  if (conflicts.length) {
    console.error(`\nRefusing to overwrite ${conflicts.length} file(s) you have changed:\n`);
    for (const c of conflicts) console.error(`  ${join(opts.dest, c.rel)}`);
    console.error(`\nRe-run with --force to replace them, or merge by hand.`);
    process.exitCode = 1;
    return;
  }
  const changed = plan.filter((p) => p.action !== "same");
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
      },
      null,
      2,
    ),
  );
  if (opts.dryRun)
    console.error(`\nDRY RUN — nothing written. Re-run without --dry-run to install.`);
  else
    console.error(
      `\nNext: restart your agent, then say "Ducktective, investigate this failing test." Verify with:\n  node ${join(opts.dest, "scripts", "query_memory.mjs")} --help`,
    );
}

if (process.argv[1] && pathToFileURL(realpathOr(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(`[ducktective] install failed: ${err.message}`);
    process.exitCode = 2;
  });
}

/** node realpaths `import.meta.url` but leaves argv[1] as typed; compare like for like. */
function realpathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

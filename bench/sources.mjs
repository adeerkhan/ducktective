/**
 * Benchmark corpus sources: declared, validated, content-addressed.
 *
 * A source is a way to obtain reproducible bug instances. Each declares its
 * inputs; `validateInputs` rejects unknown keys and missing required ones rather
 * than letting an agent invent a parameter name that silently does nothing (the
 * shape borrowed from AnyPoC's `scanner/runner.validate_inputs`). The job id is a
 * hash of `(source, inputs)`, so running the same spec twice resumes the same
 * directory instead of starting over.
 *
 * Only `local` is implemented. A real corpus source (BugsInPy, SWE-bench) is
 * added **together with its materialiser** in Phase 1 — declaring one now would
 * let `validateInputs` accept inputs nothing can fetch.
 */
import { createHash } from "node:crypto";

export const SOURCES = Object.freeze({
  local: {
    name: "local",
    description: "A directory on this machine containing a bench.json instance spec.",
    implemented: true,
    params: [{ name: "path", description: "Path to the instance directory.", required: true }],
  },
});

/**
 * Strict validation: reject unknown keys, fill declared defaults, refuse
 * missing required ones. Returns the resolved inputs or throws a retryable
 * message naming the accepted parameters.
 */
export function validateInputs(sourceName, raw = {}) {
  const source = SOURCES[sourceName];
  if (!source)
    throw new Error(`unknown source "${sourceName}"; known: ${Object.keys(SOURCES).join(", ")}`);
  const declared = new Map(source.params.map((p) => [p.name, p]));

  const unknown = Object.keys(raw).filter((k) => !declared.has(k));
  if (unknown.length)
    throw new Error(
      `unknown parameter(s) for source "${sourceName}": ${unknown.sort().join(", ")}. Declared: ${[...declared.keys()].sort().join(", ")}`,
    );

  const resolved = {};
  const missing = [];
  for (const [name, spec] of declared) {
    const value = raw[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      resolved[name] = String(value);
      continue;
    }
    if (spec.default !== undefined) resolved[name] = spec.default;
    else if (spec.required !== false) missing.push(name);
  }
  if (missing.length)
    throw new Error(
      `missing required parameter(s) for source "${sourceName}": ${missing.sort().join(", ")}`,
    );
  return resolved;
}

/** Stable id from `(source, inputs)`: same inputs, same directory, always. */
export function jobId(sourceName, inputs = {}) {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))),
  );
  const digest = createHash("sha1").update(`${sourceName}|${canonical}`).digest("hex").slice(0, 8);
  return `${sourceName}-${digest}`;
}

/**
 * An instance spec is the narrow task definition from design §4: the buggy
 * checkout, the failing command, and the gold hunks. Not a patch, and not a
 * hint about the cause.
 */
export function validateInstance(instance) {
  const bad = [];
  const need = (key) => {
    if (instance?.[key] === undefined || instance[key] === "") bad.push(`missing "${key}"`);
  };
  for (const key of ["id", "source", "repo", "repro"]) need(key);
  if (instance?.repro && !instance.repro.command) bad.push('repro needs a "command"');
  const gold = instance?.expect?.goldHunks;
  if (!Array.isArray(gold) || gold.length === 0)
    bad.push("expect.goldHunks must be a non-empty array of {file,start,end}");
  else
    gold.forEach((h, i) => {
      if (!h?.file || typeof h.start !== "number" || typeof h.end !== "number")
        bad.push(`expect.goldHunks[${i}] must be {file, start, end}`);
    });
  return bad;
}

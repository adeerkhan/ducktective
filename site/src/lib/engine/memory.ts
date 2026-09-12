import type { CaseFile } from "@/lib/engine/types";

const KEY = "ducktective.rap-sheet.v1";

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_$]+/g)
      .filter((t) => t.length > 2),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n / Math.sqrt(a.size * b.size);
}

function blob(c: CaseFile): string {
  return [
    c.title,
    c.repo,
    c.symptom,
    c.confirmedCause ?? "",
    c.leadingHypothesis ?? "",
    c.status,
  ].join(" ");
}

export function loadRapSheet(): CaseFile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CaseFile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCase(file: CaseFile): CaseFile[] {
  const all = loadRapSheet().filter((c) => c.id !== file.id);
  all.unshift(file);
  const next = all.slice(0, 40);
  window.localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function similarCases(
  file: CaseFile,
  pool: CaseFile[],
  limit = 3,
): { caseFile: CaseFile; score: number }[] {
  const q = tokenize(blob(file));
  return pool
    .filter((c) => c.id !== file.id)
    .map((c) => ({ caseFile: c, score: overlap(q, tokenize(blob(c))) }))
    .filter((x) => x.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function clearRapSheet() {
  window.localStorage.removeItem(KEY);
}

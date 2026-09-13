import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { SiteShell } from "@/components/site-shell";
import { CaseFileSheet } from "@/components/case-file-sheet";
import { Button } from "@/components/ui/button";
import { clearRapSheet, loadRapSheet } from "@/lib/engine/memory";
import { parseCasesJsonl } from "@/lib/engine/case-import.mjs";
import type { CaseFile } from "@/lib/engine/types";

export const Route = createFileRoute("/cases")({ component: Cases });

function Cases() {
  // The sheet is this browser's own rap sheet (lib/engine/memory.ts). `imported`
  // wins over it, because the point of the file picker is to read a store this
  // browser has never seen. Clearing has to write both halves — storage and the
  // copy being shown — or the page keeps rendering cases it just deleted.
  const [sheet, setSheet] = useState<CaseFile[]>(loadRapSheet);
  const [imported, setImported] = useState<CaseFile[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const shown = imported ?? sheet;

  async function loadFile(file: File | undefined) {
    if (!file) return;
    const { cases, errors: bad } = parseCasesJsonl(await file.text(), file.name);
    setImported(cases);
    setErrors(bad);
  }

  return (
    <SiteShell>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Rap sheet</p>
          <h1 className="mt-2 font-display text-3xl tracking-tight">
            What this repo already tried
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
            The workbench keeps its rap sheet in this browser. To read what the skill actually left
            in a repo, open that repo&apos;s{" "}
            <span className="text-fg">.ducktective/cases.jsonl</span> — nothing is uploaded, the
            file is parsed here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-[10px] px-3.5 text-sm font-medium text-fg shadow-[0_0_0_1px_rgba(236,236,232,0.12)] transition-colors duration-150 hover:bg-bg-subtle">
            Open cases.jsonl
            <input
              className="sr-only"
              type="file"
              accept=".jsonl,.ndjson,.json,text/plain"
              onChange={(e) => void loadFile(e.target.files?.[0])}
            />
          </label>
          {imported ? (
            <Button
              variant="ghost"
              onClick={() => {
                setImported(null);
                setErrors([]);
              }}
            >
              Back to the workbench sheet
            </Button>
          ) : null}
          {sheet.length > 0 && !imported ? (
            <Button
              variant="ghost"
              onClick={() => {
                clearRapSheet();
                setSheet([]);
              }}
            >
              Clear sheet
            </Button>
          ) : null}
        </div>
      </div>

      {errors.length > 0 ? (
        <p className="mb-6 font-mono text-xs text-warn">
          {errors.length} line(s) could not be read: {errors.slice(0, 3).join("; ")}
        </p>
      ) : null}

      {shown.length === 0 ? (
        <div className="rounded-xl bg-bg-elevated px-5 py-12 text-center shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
          <p className="text-sm text-muted">
            {imported
              ? "That file held no readable cases."
              : "No cases yet. Run the workbench once and they land here."}
          </p>
          <Link
            to="/workbench"
            className="mt-4 inline-block text-sm text-fg underline-offset-4 hover:underline"
          >
            Open the workbench
          </Link>
        </div>
      ) : (
        <div className="grid gap-6">
          {shown.map((file) => (
            <CaseFileSheet key={file.id} file={file} />
          ))}
        </div>
      )}
    </SiteShell>
  );
}

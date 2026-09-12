import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { SiteShell } from "@/components/site-shell";
import { CaseFileSheet } from "@/components/case-file-sheet";
import { Button } from "@/components/ui/button";
import { clearRapSheet } from "@/lib/engine/memory";
import { useDuck } from "@/lib/store";

export const Route = createFileRoute("/cases")({ component: Cases });

function Cases() {
  const { sheet, hydrate } = useDuck();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return (
    <SiteShell>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Rap sheet</p>
          <h1 className="mt-2 font-display text-3xl tracking-tight">What this repo already tried</h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
            Per-origin JSONL in local storage. No graph server. On the next investigation, keyword overlap surfaces the
            nearest two or three cases.
          </p>
        </div>
        {sheet.length > 0 ? (
          <Button
            variant="ghost"
            onClick={() => {
              clearRapSheet();
              hydrate();
            }}
          >
            Clear sheet
          </Button>
        ) : null}
      </div>

      {sheet.length === 0 ? (
        <div className="rounded-xl bg-bg-elevated px-5 py-12 text-center shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
          <p className="text-sm text-muted">No cases yet. Run the workbench once and they land here.</p>
          <Link to="/workbench" className="mt-4 inline-block text-sm text-fg underline-offset-4 hover:underline">
            Open the workbench
          </Link>
        </div>
      ) : (
        <div className="grid gap-6">
          {sheet.map((file) => (
            <CaseFileSheet key={file.id} file={file} />
          ))}
        </div>
      )}
    </SiteShell>
  );
}

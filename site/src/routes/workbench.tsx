import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, CircleDashed, Play, Square, X } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { CaseFileSheet } from "@/components/case-file-sheet";
import { Button } from "@/components/ui/button";
import { investigate, listFixtures } from "@/lib/engine/investigate";
import { loadRapSheet, saveCase, similarCases } from "@/lib/engine/memory";
import type { Candidate, CaseFile, InvestigationStep, Trace } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/workbench")({ component: Workbench });

/** The playback cursor over a finished trace. Local to this page, and only ever
 * read here — the rap sheet it writes is the shared part, and that lives in
 * localStorage (see lib/engine/memory.ts). `Playback`, not `Play`: the duck icon
 * in this file already owns that name. */
type Playback = { trace: Trace; visible: number; playing: boolean };

const fixtures = listFixtures();

function Workbench() {
  const [play, setPlay] = useState<Playback | null>(null);
  const [sheet, setSheet] = useState<CaseFile[]>(loadRapSheet);
  const [selected, setSelected] = useState(fixtures[0]?.id ?? "inclusive-end");

  const archivedFor = useRef<string | null>(null);

  // One timeout per step: the effect re-arms on every `play` change and cleans up
  // after itself, which is what makes "Skip playback" safe — jumping `visible` to
  // the end stops the chain instead of racing a pending tick.
  useEffect(() => {
    if (!play?.playing) return;
    const t = window.setTimeout(() => {
      setPlay((p) => {
        if (!p) return p;
        const next = Math.min(p.visible + 1, p.trace.steps.length);
        return { ...p, visible: next, playing: next < p.trace.steps.length };
      });
    }, 900);
    return () => window.clearTimeout(t);
  }, [play]);

  const finished =
    play && !play.playing && play.visible === play.trace.steps.length ? play : undefined;

  // A trace is archived once per run, so replaying the same fixture does not pile
  // five copies of one case onto the sheet.
  useEffect(() => {
    if (!finished) return;
    const id = finished.trace.caseFile.id;
    if (archivedFor.current === id) return;
    archivedFor.current = id;
    setSheet(saveCase(finished.trace.caseFile));
  }, [finished]);

  const visibleSteps = play?.trace.steps.slice(0, play.visible) ?? [];
  const caseFile = useMemo(() => {
    if (!play) return null;
    const closed = [...visibleSteps].reverse().find((s) => s.kind === "close" || s.kind === "halt");
    if (closed && (closed.kind === "close" || closed.kind === "halt")) return closed.caseFile;
    return null;
  }, [play, visibleSteps]);

  const cousins = caseFile ? similarCases(caseFile, sheet) : [];

  function runSelected() {
    setPlay({ trace: investigate(selected), visible: 1, playing: true });
  }

  function skipPlayback() {
    setPlay((p) => (p ? { ...p, visible: p.trace.steps.length, playing: false } : p));
  }

  return (
    <SiteShell>
      <div className="mb-8">
        <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Workbench</p>
        <h1 className="mt-2 font-display text-3xl tracking-tight">Prosecute a live fault</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          These five programs actually run in this page. Coverage is collected. Checks execute. The
          last fixture is already fixed — Ducktective must refuse to touch it.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-3">
          {fixtures.map((f) => {
            const active = selected === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setSelected(f.id)}
                className={cn(
                  "w-full rounded-xl p-4 text-left shadow-[0_0_0_1px_rgba(236,236,232,0.08)] transition-colors duration-150",
                  active ? "bg-bg-subtle" : "bg-bg-elevated hover:bg-bg-subtle",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-[11px] tracking-wide text-muted uppercase">
                      {f.repo}
                      {f.dnr ? " · must abstain" : ""}
                    </p>
                    <h2 className="mt-1 font-medium tracking-tight">{f.title}</h2>
                  </div>
                  <ChevronRight
                    className={cn("mt-0.5 size-4 shrink-0", active ? "text-fg" : "text-subtle")}
                  />
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-muted">{f.symptom}</p>
              </button>
            );
          })}

          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={runSelected}>
              <Play className="size-4" />
              Investigate
            </Button>
            {play?.playing ? (
              <Button variant="ghost" onClick={skipPlayback}>
                <Square className="size-3.5" />
                Skip playback
              </Button>
            ) : null}
          </div>
        </div>

        <div className="space-y-4">
          {!play ? (
            <div className="rounded-xl bg-bg-elevated px-5 py-10 text-center shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
              <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
                No open case
              </p>
              <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
                Pick a fixture and investigate. The loop will reproduce, rank, falsify, and stamp a
                case file.
              </p>
            </div>
          ) : (
            <ol className="space-y-3">
              {visibleSteps.map((step, i) => (
                <li key={`${step.kind}-${i}`}>
                  <StepCard step={step} />
                </li>
              ))}
            </ol>
          )}

          {caseFile ? <CaseFileSheet file={caseFile} /> : null}

          {cousins.length > 0 ? (
            <aside className="rounded-xl bg-bg-elevated p-4 shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
              <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
                Similar on the rap sheet
              </p>
              <ul className="mt-3 space-y-2">
                {cousins.map((c) => (
                  <li
                    key={c.caseFile.id}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span>{c.caseFile.title}</span>
                    <span className="font-mono text-[11px] text-muted tabular-nums">
                      {(c.score * 100).toFixed(0)} overlap
                    </span>
                  </li>
                ))}
              </ul>
            </aside>
          ) : null}
        </div>
      </div>
    </SiteShell>
  );
}

function StepCard({ step }: { step: InvestigationStep }) {
  if (step.kind === "reproduce") {
    const ok = step.reproduction.outcome === "does_not_reproduce";
    const fail = step.reproduction.outcome === "reproduced";
    return (
      <div className="rounded-xl bg-bg-elevated p-4 shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
        <Header ok={ok} fail={fail} label="01 Reproduce" detail={step.reproduction.command} />
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted">
          {step.reproduction.stderr || step.reproduction.stdout || step.reproduction.outcome}
        </pre>
      </div>
    );
  }

  if (step.kind === "candidates") {
    return (
      <div className="rounded-xl bg-bg-elevated p-4 shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
        <Header
          ok={false}
          fail={false}
          label="02 Candidates"
          detail={`${step.candidates.length} capped`}
        />
        <ol className="mt-3 space-y-2">
          {step.candidates.map((c) => (
            <li key={c.id} className="text-sm">
              <span className="font-mono text-[11px] text-muted">{c.rank}.</span> {c.location}
              <span className="block text-muted">{c.why}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (step.kind === "falsify") {
    return <FalsifyCard candidate={step.candidate} />;
  }

  if (step.kind === "halt") {
    return (
      <div className="rounded-xl bg-bg-elevated p-4 shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
        <Header ok label="Halt" detail={step.reason.replaceAll("_", " ")} />
        <p className="mt-2 text-sm text-muted">{step.caseFile.notes}</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-bg-elevated p-4 shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
      <Header
        ok={step.caseFile.status === "confirmed"}
        fail={step.caseFile.status === "exhausted"}
        label="04 Case closed"
        detail={step.caseFile.status}
      />
    </div>
  );
}

function FalsifyCard({ candidate }: { candidate: Candidate }) {
  const confirmed = candidate.verdict === "confirmed";
  const falsified = candidate.verdict === "falsified";
  return (
    <div className="rounded-xl bg-bg-elevated p-4 shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
      <Header
        ok={falsified}
        fail={confirmed}
        label={`03 Falsify · ${candidate.location}`}
        detail={candidate.verdict}
      />
      <p className="mt-3 text-sm leading-relaxed">{candidate.hypothesis}</p>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-bg p-3 font-mono text-xs text-muted">
        {candidate.checkSource}
      </pre>
      <p className="mt-3 text-sm text-muted">{candidate.evidence}</p>
    </div>
  );
}

function Header({
  ok,
  fail,
  label,
  detail,
}: {
  ok?: boolean;
  fail?: boolean;
  label: string;
  detail: string;
}) {
  const Icon = ok ? Check : fail ? X : CircleDashed;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-2">
        <Icon className={cn("size-4", ok ? "text-ok" : fail ? "text-warn" : "text-muted")} />
        <p className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">{label}</p>
      </div>
      <p className="max-w-[50%] text-right font-mono text-[11px] text-muted">{detail}</p>
    </div>
  );
}

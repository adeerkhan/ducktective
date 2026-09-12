import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, CircleDashed, Play, Square, X } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { CaseFileSheet } from "@/components/case-file-sheet";
import { Button } from "@/components/ui/button";
import { investigate, listFixtures } from "@/lib/engine/investigate";
import { similarCases } from "@/lib/engine/memory";
import { useDuck } from "@/lib/store";
import { briefSymptom } from "@/lib/ai/brief";
import type { Candidate, InvestigationStep } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/workbench")({ component: Workbench });

const fixtures = listFixtures();

function Workbench() {
  const { play, start, reveal, finishPlay, archive, hydrate, sheet } = useDuck();
  const [selected, setSelected] = useState(fixtures[0]?.id ?? "inclusive-end");
  const [brief, setBrief] = useState("");
  const [draft, setDraft] = useState<unknown>(null);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState(false);

  const archivedFor = useRef<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!play?.playing) return;
    const t = window.setTimeout(() => reveal(), 900);
    return () => window.clearTimeout(t);
  }, [play?.playing, play?.visible, reveal]);

  useEffect(() => {
    if (!play) return;
    if (play.visible !== play.trace.steps.length || play.playing) return;
    const id = play.trace.caseFile.id;
    if (archivedFor.current === id) return;
    archivedFor.current = id;
    archive(play.trace.caseFile);
  }, [play, archive]);

  const visibleSteps = play?.trace.steps.slice(0, play.visible) ?? [];
  const caseFile = useMemo(() => {
    if (!play) return null;
    const closed = [...visibleSteps].reverse().find((s) => s.kind === "close" || s.kind === "halt");
    if (closed && (closed.kind === "close" || closed.kind === "halt")) return closed.caseFile;
    return null;
  }, [play, visibleSteps]);

  const cousins = caseFile ? similarCases(caseFile, sheet) : [];

  function runSelected() {
    const trace = investigate(selected);
    start(trace);
  }

  async function runBrief() {
    setBriefing(true);
    setBriefError(null);
    setDraft(null);
    try {
      const res = await briefSymptom({ data: { symptom: brief } });
      if (!res.ok) setBriefError(res.error);
      else setDraft(res.draft);
    } catch (error) {
      setBriefError(error instanceof Error ? error.message : "Briefing failed.");
    } finally {
      setBriefing(false);
    }
  }

  return (
    <SiteShell>
      <div className="mb-8">
        <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Workbench</p>
        <h1 className="mt-2 font-display text-3xl tracking-tight">Prosecute a live fault</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          These five programs actually run in this page. Coverage is collected. Checks execute. The last fixture is
          already fixed — Ducktective must refuse to touch it.
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
                  <ChevronRight className={cn("mt-0.5 size-4 shrink-0", active ? "text-fg" : "text-subtle")} />
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
              <Button variant="ghost" onClick={finishPlay}>
                <Square className="size-3.5" />
                Skip playback
              </Button>
            ) : null}
          </div>
        </div>

        <div className="space-y-4">
          {!play ? (
            <div className="rounded-xl bg-bg-elevated px-5 py-10 text-center shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
              <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">No open case</p>
              <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
                Pick a fixture and investigate. The loop will reproduce, rank, falsify, and stamp a case file.
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
              <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Similar on the rap sheet</p>
              <ul className="mt-3 space-y-2">
                {cousins.map((c) => (
                  <li key={c.caseFile.id} className="flex items-baseline justify-between gap-3 text-sm">
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

      <section className="mt-16 rounded-xl bg-bg-elevated p-5 shadow-[0_0_0_1px_rgba(236,236,232,0.08)] sm:p-6">
        <h2 className="font-display text-xl tracking-tight">Brief an unverified symptom</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Paste a stack or a ticket. The model may propose candidates and checks. It may not invent a passing or
          failing run. Status stays unverified until a host agent executes the harness.
        </p>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={6}
          className="mt-4 w-full rounded-lg bg-bg px-3 py-3 font-mono text-sm text-fg shadow-[0_0_0_1px_rgba(236,236,232,0.12)] outline-none focus:shadow-[0_0_0_2px_rgba(200,204,212,0.55)]"
          placeholder="TypeError: Cannot read properties of undefined (reading 'id')&#10;    at getUser (src/auth.ts:41)"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={runBrief} disabled={briefing || brief.trim().length < 8}>
            {briefing ? "Briefing…" : "Draft case file"}
          </Button>
          {briefError ? <p className="text-sm text-warn">{briefError}</p> : null}
        </div>
        {draft ? (
          <pre className="mt-4 overflow-x-auto rounded-lg bg-bg p-4 font-mono text-xs leading-relaxed text-muted">
            {JSON.stringify(draft, null, 2)}
          </pre>
        ) : null}
      </section>
    </SiteShell>
  );
}

function StepCard({ step }: { step: InvestigationStep }) {
  if (step.kind === "reproduce") {
    const ok = step.reproduction.outcome === "does_not_reproduce";
    const fail = step.reproduction.outcome === "reproduced";
    return (
      <div className="rounded-xl bg-bg-elevated p-4 shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
        <Header
          ok={ok}
          fail={fail}
          label="01 Reproduce"
          detail={step.reproduction.command}
        />
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted">
          {step.reproduction.stderr || step.reproduction.stdout || step.reproduction.outcome}
        </pre>
      </div>
    );
  }

  if (step.kind === "candidates") {
    return (
      <div className="rounded-xl bg-bg-elevated p-4 shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
        <Header ok={false} fail={false} label="02 Candidates" detail={`${step.candidates.length} capped`} />
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
      <Header ok={step.caseFile.status === "confirmed"} fail={step.caseFile.status === "exhausted"} label="04 Case closed" detail={step.caseFile.status} />
    </div>
  );
}

function FalsifyCard({ candidate }: { candidate: Candidate }) {
  const confirmed = candidate.verdict === "confirmed";
  const falsified = candidate.verdict === "falsified";
  return (
    <div className="rounded-xl bg-bg-elevated p-4 shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
      <Header ok={falsified} fail={confirmed} label={`03 Falsify · ${candidate.location}`} detail={candidate.verdict} />
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

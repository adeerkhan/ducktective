import type { ReactNode } from "react";
import type { CaseFile } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

const stamps: Record<CaseFile["status"], string> = {
  open: "OPEN",
  confirmed: "CONFIRMED",
  does_not_reproduce: "DOES NOT REPRODUCE",
  exhausted: "EXHAUSTED",
  unverified: "UNVERIFIED",
};

export function CaseFileSheet({ file, className }: { file: CaseFile; className?: string }) {
  return (
    <article
      className={cn(
        "relative overflow-hidden rounded-xl bg-paper text-paper-ink shadow-[0_24px_60px_-28px_rgba(0,0,0,0.55)]",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-y-0 left-0 w-2 bg-[repeating-linear-gradient(180deg,transparent,transparent_10px,rgba(138,64,56,0.55)_10px,rgba(138,64,56,0.55)_12px)]" />
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-paper-rule px-6 py-5 pl-8">
        <div>
          <p className="font-mono text-[11px] tracking-[0.18em] text-paper-muted uppercase">
            Case {file.id}
          </p>
          <h2 className="mt-1 font-display text-xl font-medium tracking-tight text-pretty">
            {file.title}
          </h2>
          <p className="mt-1 font-mono text-xs text-paper-muted">
            {file.repo} · {file.reproduction.command}
          </p>
        </div>
        <p
          className={cn(
            "shrink-0 rotate-[-8deg] border-2 px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.14em] whitespace-nowrap uppercase",
            file.status === "confirmed" && "border-ok text-ok",
            file.status === "does_not_reproduce" && "border-stamp text-stamp",
            file.status === "exhausted" || file.status === "unverified"
              ? "border-paper-muted text-paper-muted"
              : null,
            file.status === "open" && "border-paper-ink/40 text-paper-ink",
          )}
        >
          {stamps[file.status]}
        </p>
      </header>

      <Section label="Symptom">{file.symptom}</Section>

      <Section label="Reproduction">
        <p>
          Outcome:{" "}
          <span className="font-medium">{file.reproduction.outcome.replaceAll("_", " ")}</span>
          {" · "}
          {file.reproduction.durationMs} ms
          {typeof file.reproduction.exitCode === "number"
            ? ` · exit ${file.reproduction.exitCode}`
            : ""}
          {file.reproduction.runner && file.reproduction.runner !== "unknown"
            ? ` · ${file.reproduction.runner}`
            : ""}
        </p>
        {file.reproduction.stderr ? (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-paper-ink/80">
            {file.reproduction.stderr}
          </pre>
        ) : (
          <pre className="mt-2 font-mono text-xs">{file.reproduction.stdout || "no output"}</pre>
        )}
      </Section>

      <Section label="Candidates">
        {file.candidates.length === 0 ? (
          <p>None. Reproduction did not produce a live fault.</p>
        ) : (
          <ol className="space-y-4">
            {file.candidates.map((c) => (
              <li key={c.id} className="grid gap-1">
                <p className="font-mono text-[11px] tracking-wide text-paper-muted uppercase">
                  {c.rank}. {c.location} · {c.verdict}
                </p>
                <p>{c.hypothesis}</p>
                <p className="text-sm text-paper-muted">{c.evidence}</p>
                {c.predicted ? (
                  <p className="font-mono text-[11px] text-paper-muted">
                    oracle: predicted {c.predicted} → exit {c.checkExitCode ?? "?"}
                    {typeof c.controlExitCode === "number"
                      ? ` · control exit ${c.controlExitCode}`
                      : ""}
                  </p>
                ) : null}
                {c.verifiedVerdict ? (
                  <p
                    className={
                      "font-mono text-[11px] " +
                      (c.verifiedVerdict === c.verdict ? "text-ok" : "text-stamp")
                    }
                  >
                    second run: {c.verifiedVerdict}
                    {typeof c.verifyExitCode === "number"
                      ? ` (exit ${c.verifyExitCode})`
                      : ""} · {c.verifiedVerdict === c.verdict ? "survived" : "did not survive"}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section label="Cause">
        {file.confirmedCause ?? file.leadingHypothesis ?? "No confirmed cause."}
        <p className="mt-2 font-mono text-[11px] tracking-wide text-paper-muted uppercase">
          Confidence {file.confidence}
        </p>
      </Section>

      {file.suggestedPatch ? (
        <Section label="Suggested patch (secondary)">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
            {file.suggestedPatch}
          </pre>
        </Section>
      ) : null}

      <footer className="border-t border-paper-rule px-6 py-4 pl-8 font-mono text-[11px] text-paper-muted">
        {file.notes}
      </footer>
    </article>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="border-b border-paper-rule px-6 py-4 pl-8 last:border-b-0">
      <h3 className="mb-2 font-mono text-[11px] tracking-[0.16em] text-paper-muted uppercase">
        {label}
      </h3>
      <div className="text-sm leading-relaxed">{children}</div>
    </section>
  );
}

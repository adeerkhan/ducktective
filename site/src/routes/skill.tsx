import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { SiteShell } from "@/components/site-shell";
import { Button } from "@/components/ui/button";
import SKILL_MD from "../../../skills/ducktective/SKILL.md?raw";

export const Route = createFileRoute("/skill")({ component: SkillPage });

function SkillPage() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(SKILL_MD);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <SiteShell>
      <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Skill pack</p>
      <h1 className="mt-2 font-display text-3xl tracking-tight">
        Drop it into the host you already run.
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
        Agent Skills standard. One folder, one <span className="text-fg">SKILL.md</span>. Works in
        Claude Code, Cursor, Copilot, Codex, Gemini CLI, and anything else that loads the spec.
        Ducktective is not a runtime.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button onClick={copy}>{copied ? "Copied" : "Copy SKILL.md"}</Button>
        <a href={`${import.meta.env.BASE_URL}skill/SKILL.md`} download="SKILL.md">
          <Button variant="ghost">Download</Button>
        </a>
      </div>

      <ol className="mt-10 grid gap-3 sm:grid-cols-3">
        <Step
          n="1"
          title="Make the folder"
          body="~/.claude/skills/ducktective/ or .agents/skills/ducktective/ in the repo."
        />
        <Step
          n="2"
          title="Paste SKILL.md"
          body="The file below is the entire skill. Scripts come later; the contract is the file."
        />
        <Step
          n="3"
          title="Invoke it"
          body="“Ducktective, investigate this failing test.” The host is forced through the loop."
        />
      </ol>

      <pre className="mt-10 overflow-x-auto rounded-xl bg-bg-elevated p-5 font-mono text-[12px] leading-relaxed text-muted shadow-[0_0_0_1px_rgba(236,236,232,0.08)] sm:p-6">
        {SKILL_MD}
      </pre>
    </SiteShell>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="rounded-xl bg-bg-elevated p-4 shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
      <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">0{n}</p>
      <h2 className="mt-2 font-medium tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-muted">{body}</p>
    </li>
  );
}

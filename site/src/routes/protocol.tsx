import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteShell } from "@/components/site-shell";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/protocol")({ component: Protocol });

function Protocol() {
  return (
    <SiteShell>
      <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Protocol</p>
      <h1 className="mt-2 max-w-3xl font-display text-3xl tracking-tight text-pretty sm:text-4xl">
        A prosecutor skill, not a detective agent.
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
        Detectives gather clues and form theories. Prosecutors have to prove a case that survives
        cross-examination. Ducktective is the second job, packaged as a drop-in skill for the agent you already run.
      </p>

      <article className="mt-12 max-w-3xl space-y-12 text-[15px] leading-relaxed">
        <section>
          <h2 className="font-display text-2xl tracking-tight">Purpose</h2>
          <p className="mt-3 text-muted">
            Coding agents are now in an estimated 22–28% of a 128,018-project GitHub sample (Agentic Much?, Apr 2026).
            They write more than humans can review. The verification layer that used to be a person asking “is this
            actually the bug?” was not replaced. It was deleted.
          </p>
          <p className="mt-3 text-muted">
            The published failure mode has a name. <em className="text-fg not-italic">Silent semantic failure</em>{" "}
            (arXiv:2603.25764): across 1,750 trajectories on 50 SWE-bench Verified tasks, GPT-5 submitted a patch on
            100% of runs and resolved 44%. Sixty-eight percent of GPT-5’s failing runs were the same wrong
            interpretation, repeated. Lightweight pre-edit prompts did not close the gap. Given an already-fixed bug,
            most models still edited the correct code. Completion metrics reward that instinct. Ducktective forbids it.
          </p>
          <p className="mt-3 text-muted">
            False success is the sibling: in AppWorld, 75.8% of self-assessing coding-agent trajectories claimed success
            in language while the environment said otherwise. LLM-as-judge does not save you — judges anchor on the
            word “done.”
          </p>
          <p className="mt-3 text-muted">
            So the purpose is narrow: force a host agent (Claude Code first) through reproduce → cap 3–5 → falsify with
            a runnable check → emit a case file → remember the case in this repo. Localization, graphs, and the patch
            itself stay with systems that already do them better.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl tracking-tight">The novel mechanism</h2>
          <p className="mt-3 text-muted">
            Not a better ranker. A contract the model is not allowed to skip.
          </p>
          <ol className="mt-4 space-y-3 text-muted">
            <li>
              <span className="text-fg">Reproduce-or-stop.</span> The failing command is the only admission ticket. If it
              is green, the case is stamped DOES NOT REPRODUCE and the skill exits. This is the already-fixed probe from
              the silent-failure paper, turned into a hard gate.
            </li>
            <li>
              <span className="text-fg">Fail-only coverage, not a graph.</span> Stack frames plus lines hit by the failing
              run and not by passing runs — classic cheap SBFL. Cap at five. Tree-sitter is optional and disposable.
              LocAgent’s heterogeneous graph is a research artifact (627 stars, ACL 2025). Rebuilding an incomplete one
              is busywork.
            </li>
            <li>
              <span className="text-fg">Hypothesis then check, never the reverse.</span> One sentence: “this function
              should return X under Y, the failing run shows Z.” Then the smallest assertion that would disprove it.
              Execute. If the oracle holds, the candidate is falsified. If it fails in the predicted way, the cause is
              confirmed. Chat confirmation is discarded.
            </li>
            <li>
              <span className="text-fg">Differential oracle when a green path exists.</span> A check that also fails on
              passing tests is a bad check. Ducktective prefers oracles that distinguish the failing run from a known-good
              one. That is the whole novelty: not a smarter model, a check that can lose.
            </li>
            <li>
              <span className="text-fg">The case file is the product.</span> Structured, stamped, append-only. Humans
              merge from it. Suggested patch is labeled secondary so the skill cannot launder a guess as a fix.
            </li>
          </ol>
        </section>

        <section>
          <h2 className="font-display text-2xl tracking-tight">Why it will be used</h2>
          <p className="mt-3 text-muted">
            GitHub stars are a use proxy, not a paper proxy. Full agents that you live in (OpenHands 87k, SWE-agent 20k)
            win distribution. Graph localizers (LocAgent 627) do not, even when file-level Acc@5 is 92.7%. Agentless
            (2.1k) is the existence proof that a smaller pipeline, honestly scoped, out-stars a cleverer agent.
          </p>
          <p className="mt-3 text-muted">
            Ducktective is aimed at the Agentless band, with a better distribution channel: the Agent Skills standard
            (`SKILL.md`) loads in Claude Code, Cursor, Copilot, Codex, Gemini CLI, and thirty others. One folder. One
            command. <span className="text-fg">ducktective investigate</span>. It fires on the sentence people already
            type: “this test is failing, find out why.”
          </p>
          <p className="mt-3 text-muted">
            That is why it can out-star LocAgent and sit with Agentless / AutoCodeRover without beating OpenHands — it
            is not trying to. A skill that stops non-reproducing cases, leaves a docket a reviewer will actually read,
            and costs almost no tokens versus “just fix it” has a daily trigger. Daily trigger plus one-command install
            plus a named failure mode in the 2026 literature is the star recipe. Costume detective graphs are not.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl tracking-tight">Two-week plan</h2>
          <div className="mt-4 overflow-hidden rounded-xl bg-bg-elevated shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
            <div className="grid gap-0 sm:grid-cols-2">
              <Week
                n="Week 1"
                title="Harness, schema, falsify"
                items={[
                  "Reproduction for pytest and plain Python, capturing stack and coverage.",
                  "Case-file schema and writer. No free prose output.",
                  "Falsification loop: model emits a runnable check, the skill executes it.",
                  "Hard stop on does-not-reproduce, including already-fixed code.",
                ]}
              />
              <Week
                n="Week 2"
                title="Skill, memory, measure"
                items={[
                  "Ship as a Claude Code skill. Single command.",
                  "Per-repo JSONL rap sheet and keyword overlap.",
                  "Ten to twenty real bugs from small public repos.",
                  "Measure: DNR stop-rate, whether a human prefers the case file, tokens vs. 'just fix it'.",
                ]}
              />
            </div>
          </div>
          <p className="mt-4 text-sm text-muted">
            Out of scope for two weeks: custom graphs, multi-agent, monorepos, production telemetry, metamorphic
            oracles. Those wait until the spine is measured.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl tracking-tight">What this workbench already proves</h2>
          <p className="mt-3 text-muted">
            Five JavaScript faults execute here. Off-by-one, leaked mutable cache, inverted boolean, UTC-as-local, and
            a stale ticket whose test is already green. Each investigation collects fail/pass hits, runs the
            falsifying check, and stamps a case file onto the rap sheet. The green ticket is the load-bearing demo: if
            Ducktective patches it, the skill has failed. If it stops, the skill is doing the one job the field still
            underserves.
          </p>
        </section>
      </article>

      <div className="mt-12 flex flex-wrap gap-3">
        <Link to="/workbench">
          <Button>Run the loop</Button>
        </Link>
        <Link to="/skill">
          <Button variant="ghost">Install the skill</Button>
        </Link>
      </div>
    </SiteShell>
  );
}

function Week({ n, title, items }: { n: string; title: string; items: string[] }) {
  return (
    <div className="p-5 sm:p-6">
      <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">{n}</p>
      <h3 className="mt-1 font-medium tracking-tight">{title}</h3>
      <ul className="mt-4 space-y-2 text-sm text-muted">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

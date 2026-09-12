import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Ban, FileText, FlaskConical, ShieldCheck } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { Button } from "@/components/ui/button";
import { DuckMark } from "@/components/mark";

export const Route = createFileRoute("/")({ component: Home });

const loop = [
  {
    n: "01",
    title: "Reproduce",
    body: "Run the exact failing command. If it does not fail, write does-not-reproduce and stop. This kills a large class of confident nonsense, including the instinct to 'improve' already-fixed code.",
  },
  {
    n: "02",
    title: "Cap the suspects",
    body: "Three to five candidates from the stack plus lines covered only by the failing run. No graph database. No suspicion-score alchemy. Rebuild is free on the repos this skill targets.",
  },
  {
    n: "03",
    title: "Falsify",
    body: "One-line hypothesis, then the smallest check that would disprove it. Actually run the check. Falsified: demote. Confirmed: that is the cause. Prose confirmation is not allowed.",
  },
  {
    n: "04",
    title: "File the case",
    body: "A structured object a human can read before merging: symptom, reproduction, every candidate with the evidence that ruled it in or out, cause, confidence. Patch is optional and secondary.",
  },
  {
    n: "05",
    title: "Rap sheet",
    body: "Append the case to a per-repo JSONL. Next time, surface the two or three most similar past cases by keyword overlap. That is the entire memory system.",
  },
];

function Home() {
  return (
    <SiteShell>
      <section className="grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
        <div>
          <p className="mb-5 inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
            <DuckMark className="size-4" />
            Verification skill · not a detective agent
          </p>
          <h1 className="font-display text-3xl leading-[1.05] font-medium tracking-[-0.035em] text-pretty sm:text-[3.35rem]">
            No claim without a check.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            Ducktective is a thin protocol the host agent is forced to follow. It does not localize,
            does not patch first, and does not get a vote when the failing command is green. It owns
            reproduction, falsification, and the case file.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/workbench">
              <Button size="lg">
                Open the workbench
                <ArrowRight className="size-4" />
              </Button>
            </Link>
            <Link to="/protocol">
              <Button size="lg" variant="ghost">
                Read the protocol
              </Button>
            </Link>
          </div>
        </div>
        <aside className="rounded-xl bg-bg-elevated p-5 shadow-[0_0_0_1px_rgba(236,236,232,0.08)] sm:p-6">
          <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
            Why this exists
          </p>
          <ul className="mt-4 space-y-4 text-sm leading-relaxed">
            <li>
              <span className="font-medium text-fg">
                GPT-5 submits on 100% of SWE-bench runs and resolves 44%.
              </span>{" "}
              <span className="text-muted">
                68% of those failures are silent semantic failures — the same wrong reading,
                confidently, every time.
              </span>
            </li>
            <li>
              <span className="font-medium text-fg">LocAgent has 627 stars.</span>{" "}
              <span className="text-muted">
                OpenHands has 87k. Graph localizers do not lose because the paper is weak. They lose
                because nobody wants another agent to operate.
              </span>
            </li>
            <li>
              <span className="font-medium text-fg">
                Agentless has 2.1k stars by being smaller.
              </span>{" "}
              <span className="text-muted">
                Ducktective is that move for verification: a skill inside Claude Code, Cursor, and
                Codex, not a rival runtime.
              </span>
            </li>
          </ul>
        </aside>
      </section>

      <section className="mt-16 grid gap-3 sm:grid-cols-3">
        <Fact
          icon={Ban}
          kicker="Gate 0"
          title="Reproduce or stop"
          body="If the command does not fail, the case is closed. Action bias is the failure mode. Abstain is the feature."
        />
        <Fact
          icon={FlaskConical}
          kicker="The spine"
          title="Falsify, don't narrate"
          body="A hypothesis is only a claim. A five-line check that actually runs is evidence."
        />
        <Fact
          icon={FileText}
          kicker="The product"
          title="A case file, not a chat"
          body="Humans merge from a docket they can audit. Chat is a scratch pad. This is the record."
        />
      </section>

      <section className="mt-20">
        <div className="mb-8 flex items-end justify-between gap-4">
          <h2 className="font-display text-2xl tracking-tight">The only loop that matters</h2>
          <Link to="/workbench" className="hidden text-sm text-muted hover:text-fg sm:inline">
            Run it on a live bug
          </Link>
        </div>
        <ol className="grid gap-3">
          {loop.map((step) => (
            <li
              key={step.n}
              className="grid gap-3 rounded-xl bg-bg-elevated p-5 shadow-[0_0_0_1px_rgba(236,236,232,0.08)] sm:grid-cols-[72px_160px_1fr] sm:items-start"
            >
              <span className="font-mono text-xs tracking-[0.18em] text-muted">{step.n}</span>
              <h3 className="font-medium tracking-tight">{step.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-20 grid gap-10 lg:grid-cols-2">
        <div>
          <h2 className="font-display text-2xl tracking-tight">Stars follow use, not graphs</h2>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Academic localization agents stall in the hundreds of stars because they compete with
            LocAgent, AutoCodeRover, and the host model on a problem that is already funded. Skills
            that install in the agent you already run, fire on every failed test, and leave an
            artifact you keep, sit in a different market: Agentless (2.1k), focused skill
            marketplaces (~1.4k), AutoCodeRover (3.1k). A verification skill that becomes the
            default <span className="text-fg">investigate this</span> command can clear that band
            without beating OpenHands.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Coding-agent traces are already in 22–28% of a 128k GitHub sample. The scarce resource
            is not another localizer. It is a prosecutor that will not let the model close the case
            in prose.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl bg-bg-elevated shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
          <table className="w-full text-left text-sm">
            <thead className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">
              <tr className="border-b border-border">
                <th className="px-4 py-3 font-medium">Project</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 font-medium">Stars</th>
              </tr>
            </thead>
            <tbody className="text-muted">
              <Row name="OpenHands" kind="Full agent" stars="87k" />
              <Row name="SWE-agent" kind="Full agent" stars="20k" />
              <Row name="AutoCodeRover" kind="Search agent" stars="3.1k" />
              <Row name="Agentless" kind="Simple pipeline" stars="2.1k" />
              <Row name="LocAgent" kind="Graph localizer" stars="627" />
              <Row name="Ducktective" kind="Verification skill" stars="this" highlight />
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-20 rounded-xl bg-bg-elevated px-6 py-8 shadow-[0_0_0_1px_rgba(236,236,232,0.08)] sm:px-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl">
            <p className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
              <ShieldCheck className="size-3.5" />
              Two weeks. Then measure.
            </p>
            <h2 className="mt-2 font-display text-2xl tracking-tight">
              The workbench is week one, running.
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Five real bugs execute in the browser: off-by-one, leaked cache, wrong boolean, UTC
              slice, and a stale ticket that must not be touched. The last one is the product.
            </p>
          </div>
          <Link to="/workbench">
            <Button size="lg" variant="paper">
              Prosecute a bug
              <ArrowRight className="size-4" />
            </Button>
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}

function Fact({
  icon: Icon,
  kicker,
  title,
  body,
}: {
  icon: typeof Ban;
  kicker: string;
  title: string;
  body: string;
}) {
  return (
    <article className="rounded-xl bg-bg-elevated p-5 shadow-[0_0_0_1px_rgba(236,236,232,0.08)]">
      <p className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
        <Icon className="size-3.5" />
        {kicker}
      </p>
      <h3 className="mt-3 font-medium tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
    </article>
  );
}

function Row({
  name,
  kind,
  stars,
  highlight,
}: {
  name: string;
  kind: string;
  stars: string;
  highlight?: boolean;
}) {
  return (
    <tr className={highlight ? "bg-bg-subtle text-fg" : "border-b border-border"}>
      <td className="px-4 py-3">{name}</td>
      <td className="px-4 py-3">{kind}</td>
      <td className="px-4 py-3 font-mono text-xs">{stars}</td>
    </tr>
  );
}

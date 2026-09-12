import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { DuckMark } from "@/components/mark";
import { cn } from "@/lib/utils";

const links = [
  { to: "/", label: "Brief" },
  { to: "/workbench", label: "Workbench" },
  { to: "/cases", label: "Rap sheet" },
  { to: "/protocol", label: "Protocol" },
  { to: "/skill", label: "Skill" },
] as const;

export function SiteShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:h-16 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 text-fg">
            <DuckMark className="size-6" />
            <span className="font-display text-[15px] font-medium tracking-tight">Ducktective</span>
          </Link>
          <nav className="flex items-center gap-0.5 overflow-x-auto">
            {links.map((l) => {
              const active = pathname === l.to;
              return (
                <Link
                  key={l.to}
                  to={l.to}
                  className={cn(
                    "rounded-[10px] px-2.5 py-2 text-sm whitespace-nowrap transition-colors duration-150",
                    active ? "bg-bg-subtle text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">{children}</div>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 font-mono text-[11px] tracking-wide text-muted uppercase sm:px-6">
          <span>Ducktective · No claim without a check</span>
          <span>Verification skill · MIT</span>
        </div>
      </footer>
    </div>
  );
}

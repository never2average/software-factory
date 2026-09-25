"use client";

/**
 * Standalone preview of the workspace list cards with mock data — no auth, no
 * DB, no network. Used by the Playwright card-redesign check
 * (tests/cards.spec.ts) so the visuals can be verified in isolation. Safe to
 * keep as a dev preview; it renders only static components.
 */
import { useState } from "react";
import {
  DeployCard,
  ImplCard,
  TaskCard,
  type DeployCardData,
  type ImplCardData,
  type TaskCardData,
} from "@/app/_components/ops/cards";
import { CycleCard } from "@/app/_components/ops/todos-panel";
import type { ApiCycle } from "@/app/_components/ops/lib";

const iso = (n: number) => new Date(2026, 6, 8 + n).toISOString();
const CYCLES: { cycle: ApiCycle; stats: { total: number; done: number; committed: number; doneDates: string[] } }[] = [
  {
    cycle: { id: "1", name: "Sprint 12", startsAt: iso(0), endsAt: iso(14), state: "active", goal: "Ship SBI COS to UAT", capacity: 10, lead: "priya@example.com", createdBy: "priya@example.com", archivedAt: null, createdAt: iso(0), updatedAt: iso(0) },
    stats: { total: 10, done: 4, committed: 10, doneDates: [iso(2), iso(3), iso(5), iso(6)] },
  },
  {
    cycle: { id: "2", name: "Sprint 13", startsAt: iso(14), endsAt: iso(28), state: "planning", goal: null, capacity: null, lead: null, createdBy: "arjun@example.com", archivedAt: null, createdAt: iso(14), updatedAt: iso(14) },
    stats: { total: 5, done: 0, committed: 5, doneDates: [] },
  },
];

const TASKS: { col: string; items: TaskCardData[] }[] = [
  {
    col: "Open",
    items: [
      { title: "Wire the RBI circular scraper into the COS data layer", priority: "high", assignee: "paartha@example.com", cycleLabel: "Sprint 12", due: { text: "in 2d", overdue: false } },
      { title: "Draft SLA reconciliation note for bare-metal deployments", priority: "normal", assignee: "priya@example.com", containerType: "deployment", containerLabel: "sbi/prod" },
      { title: "Follow up on audit-trail ticket", priority: "low", cycleLabel: "Backlog" },
    ],
  },
  {
    col: "In progress",
    items: [
      { title: "Config specialist: SAML SSO + data-residency guardrails", priority: "high", assignee: "arjun@example.com", containerType: "implementation", containerLabel: "SBI COS", due: { text: "yesterday", overdue: true } },
      { title: "Stand up the eval suite before UAT", priority: "normal", assignee: "priya@example.com" },
    ],
  },
  {
    col: "Done",
    items: [{ title: "Get customer record fully populated", priority: "normal", done: true, assignee: "paartha@example.com", due: { text: "3d ago", overdue: false } }],
  },
];

// Two weeks of dates for the mock burndowns.
const day = (n: number) => new Date(2026, 6, 8 + n).toISOString();
const bd = (committed: number, doneOffsets: number[]) => ({
  startsAt: day(0),
  endsAt: day(14),
  committed,
  doneDates: doneOffsets.map((o) => day(o)),
});

const IMPLS: ImplCardData[] = [
  { title: "Regulatory circular co-pilot", customer: "SBI", risk: "high", owner: "paartha@example.com", blocker: true, due: { text: "due in 12 days", overdue: false }, burndown: bd(10, [2, 3, 5, 6]) },
  { title: "Credit-memo drafting agent", customer: "ICICI HFC", risk: "medium", owner: "arjun@example.com", due: { text: "due in 4 days", overdue: false }, burndown: bd(8, [1, 2, 3, 4, 6, 8]) },
  { title: "KYC exception triage", customer: "CUB", risk: "low", owner: "priya@example.com", due: { text: "due in 30 days", overdue: false }, burndown: bd(6, [4]) },
  { title: "Portfolio commentary generator", customer: "MLP USA", risk: "low", owner: "priya@example.com", due: { text: "2 days overdue", overdue: true }, burndown: bd(5, [1, 2, 3, 4, 5]) },
];

const DEPLOYS: DeployCardData[] = [
  { customer: "SBI", env: "prod", version: "2.3.1", health: "healthy", status: "live", owner: "paartha@example.com", uptime: 99.94, errorRate: 0.12 },
  { customer: "ICICI HFC", env: "staging", version: "2.4.0-rc2", health: "degraded", status: "in_progress", owner: "arjun@example.com", uptime: 98.7, errorRate: 1.4 },
  { customer: "CUB", env: "prod", version: "1.9.0", health: "down", status: "pending-approval", owner: "priya@example.com", uptime: 91.2, errorRate: 4.8 },
];

function Column({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex w-96 shrink-0 flex-col rounded-lg border border-border/60 bg-muted/15">
      <div className="border-border/60 border-b px-3 py-2 font-medium text-xs">{title}</div>
      <div className="flex flex-col gap-2 p-2">{children}</div>
    </div>
  );
}

export default function CardsPreview() {
  const [sel, setSel] = useState<string | null>("t-0-0");
  return (
    <div className="min-h-screen bg-background p-8 text-foreground">
      <h1 className="mb-1 font-semibold text-lg">Workspace cards</h1>
      <p className="mb-6 text-muted-foreground text-sm">Redesigned Tasks + Implementations list cards (preview).</p>

      <section data-testid="tasks-board" className="mb-10">
        <h2 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Tasks board</h2>
        <div className="flex gap-3">
          {TASKS.map((c, ci) => (
            <Column key={c.col} title={c.col}>
              {c.items.map((t, ti) => {
                const id = `t-${ci}-${ti}`;
                return <TaskCard key={id} task={t} testid={id} selected={sel === id} onClick={() => setSel(id)} />;
              })}
            </Column>
          ))}
        </div>
      </section>

      <section data-testid="sprint-cards" className="mb-10">
        <h2 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Sprints</h2>
        <div className="flex max-w-3xl flex-col gap-4">
          {CYCLES.map((c) => (
            <CycleCard key={c.cycle.id} cycle={c.cycle} stats={c.stats} onClick={() => {}} />
          ))}
        </div>
      </section>

      <section data-testid="deploy-grid" className="mb-10">
        <h2 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Deployments</h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-3">
          {DEPLOYS.map((d, i) => (
            <DeployCard key={d.customer} deploy={d} testid={`d-${i}`} selected={sel === `d-${i}`} onClick={() => setSel(`d-${i}`)} />
          ))}
        </div>
      </section>

      <section data-testid="impl-board">
        <h2 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Implementations pipeline</h2>
        <div className="flex gap-3">
          {IMPLS.map((r, i) => {
            const id = `i-${i}`;
            return (
              <div key={id} className="w-96 shrink-0">
                <ImplCard impl={r} testid={id} selected={sel === id} onClick={() => setSel(id)} />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

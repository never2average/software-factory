"use client";

/**
 * Standalone preview of the workspace list cards with mock data — no auth, no
 * DB, no network. Used by the Playwright card-redesign check
 * (tests/cards.spec.ts) so the visuals can be verified in isolation. Safe to
 * keep as a dev preview; it renders only static components. Production answers 404 here (../layout.tsx), but
 * this page's chunk still ships in the build, so every name in it is an example name, never a real institution's
 * (scripts/test-sample-data.mjs holds it).
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
import { CycleCard, PeriodPeopleCard, PersonItems } from "@/app/_components/ops/todos-panel";
import type { ApiCycle, ApiTodo } from "@/app/_components/ops/lib";
import { W } from "@/lib/ui-words";
import { WORK_PERIODS, progressByPerson, workPeriodsOf, type WorkPeriods } from "@/agent/lib/work-periods";
import { periodUi, todoViews } from "@/lib/work-periods-ui";

const iso = (n: number) => new Date(2026, 6, 8 + n).toISOString();
const CYCLES: { cycle: ApiCycle; stats: { total: number; done: number; committed: number; doneDates: string[] } }[] = [
  {
    cycle: { id: "1", name: `${W.Period} 12`, startsAt: iso(0), endsAt: iso(14), state: "active", goal: "Ship the Example Bank assistant to UAT", capacity: 10, lead: "priya@example.com", createdBy: "priya@example.com", archivedAt: null, createdAt: iso(0), updatedAt: iso(0) },
    stats: { total: 10, done: 4, committed: 10, doneDates: [iso(2), iso(3), iso(5), iso(6)] },
  },
  {
    cycle: { id: "2", name: `${W.Period} 13`, startsAt: iso(14), endsAt: iso(28), state: "planning", goal: null, capacity: null, lead: null, createdBy: "arjun@example.com", archivedAt: null, createdAt: iso(14), updatedAt: iso(14) },
    stats: { total: 5, done: 0, committed: 5, doneDates: [] },
  },
];

// The three modes, as a profile states them. "this build" is whatever profiles/ says here.
const INDIVIDUAL: WorkPeriods = workPeriodsOf({
  work_periods: { mode: "individual", label: { singular: "week", plural: "weeks" }, list_label: { singular: "week", plural: "weeks" }, item_label: { singular: "target", plural: "targets" }, length_days: 7, auto_rollover: true },
});
const PERIOD_MODES: { key: string; wp: WorkPeriods }[] = [
  { key: "this-build", wp: WORK_PERIODS },
  { key: "team", wp: { ...WORK_PERIODS, mode: "team", enabled: true, team: true, individual: false } },
  { key: "individual", wp: INDIVIDUAL },
  { key: "off", wp: { ...WORK_PERIODS, mode: "off", enabled: false, team: false, individual: false } },
];
const VIEW_LABEL = (v: string, wp: WorkPeriods) => (v === "tasks" ? "Tasks" : v === "deployments" ? W.Deployments : v === "implementations" ? W.Implementations : periodUi(wp).navLabel);
const PERSON_UI = periodUi(INDIVIDUAL);
const PERSON_PERIOD: ApiCycle = { id: "p1", name: "Week of 2026-07-06", startsAt: iso(-2), endsAt: iso(5), state: "active", goal: null, capacity: null, lead: null, createdBy: "priya@example.com", archivedAt: null, createdAt: iso(-2), updatedAt: iso(-2) };
const item = (id: string, title: string, assignee: string, done: boolean): ApiTodo =>
  ({ id, title, done, doneAt: done ? iso(0) : null, status: done ? "done" : "open", priority: "normal", assignee, createdBy: assignee, cycleId: "p1", archivedAt: null, createdAt: iso(-2), updatedAt: iso(-2) }) as unknown as ApiTodo;
const PEOPLE = progressByPerson(
  "p1",
  [
    item("i1", "Update the quarterly model for Example Housing Finance", "priya@example.com", true),
    item("i2", "Read the annual report and note what changed", "priya@example.com", false),
    item("i3", "Draft the results note", "priya@example.com", false),
    item("i4", "Initiate coverage on Example Mutual Bank", "arjun@example.com", true),
  ],
  [
    { member: "priya@example.com", goal: "Close out the quarter for my three names", targetCount: 4 },
    { member: "arjun@example.com", goal: null, targetCount: null },
  ],
  "priya@example.com",
);

const TASKS: { col: string; items: TaskCardData[] }[] = [
  {
    col: "Open",
    items: [
      { title: "Wire the circular scraper into the assistant's data layer", priority: "high", assignee: "paartha@example.com", cycleLabel: `${W.Period} 12`, due: { text: "in 2d", overdue: false } },
      { title: `Draft SLA reconciliation note for bare-metal ${W.deployments}`, priority: "normal", assignee: "priya@example.com", containerType: "deployment", containerLabel: "example-bank/prod" },
      { title: "Follow up on audit-trail ticket", priority: "low", cycleLabel: "Backlog" },
    ],
  },
  {
    col: "In progress",
    items: [
      { title: "Config specialist: SAML SSO + data-residency guardrails", priority: "high", assignee: "arjun@example.com", containerType: "implementation", containerLabel: "Example Bank assistant", due: { text: "yesterday", overdue: true } },
      { title: "Stand up the eval suite before UAT", priority: "normal", assignee: "priya@example.com" },
    ],
  },
  {
    col: "Done",
    items: [{ title: `Get ${W.account} record fully populated`, priority: "normal", done: true, assignee: "paartha@example.com", due: { text: "3d ago", overdue: false } }],
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
  { title: "Regulatory circular co-pilot", customer: "Example Bank", risk: "high", owner: "paartha@example.com", blocker: true, due: { text: "due in 12 days", overdue: false }, burndown: bd(10, [2, 3, 5, 6]) },
  { title: "Credit-memo drafting agent", customer: "Example Housing Finance", risk: "medium", owner: "arjun@example.com", due: { text: "due in 4 days", overdue: false }, burndown: bd(8, [1, 2, 3, 4, 6, 8]) },
  { title: "KYC exception triage", customer: "Example Mutual Bank", risk: "low", owner: "priya@example.com", due: { text: "due in 30 days", overdue: false }, burndown: bd(6, [4]) },
  { title: "Portfolio commentary generator", customer: "Example Asset Manager", risk: "low", owner: "priya@example.com", due: { text: "2 days overdue", overdue: true }, burndown: bd(5, [1, 2, 3, 4, 5]) },
];

const DEPLOYS: DeployCardData[] = [
  { customer: "Example Bank", env: "prod", version: "2.3.1", health: "healthy", status: "live", owner: "paartha@example.com", uptime: 99.94, errorRate: 0.12 },
  { customer: "Example Housing Finance", env: "staging", version: "2.4.0-rc2", health: "degraded", status: "in_progress", owner: "arjun@example.com", uptime: 98.7, errorRate: 1.4 },
  { customer: "Example Mutual Bank", env: "prod", version: "1.9.0", health: "down", status: "pending-approval", owner: "priya@example.com", uptime: 91.2, errorRate: 4.8 },
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
      <p className="mb-6 text-muted-foreground text-sm">Redesigned Tasks + {W.Implementations} list cards (preview).</p>

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

      <section data-testid="period-cards" className="mb-10">
        <h2 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">{W.Periods}</h2>
        <div className="flex max-w-3xl flex-col gap-4">
          {CYCLES.map((c) => (
            <CycleCard key={c.cycle.id} cycle={c.cycle} stats={c.stats} onClick={() => {}} />
          ))}
        </div>
      </section>

      {/* Work periods under each mode a deployment profile can choose (work_periods.mode): what the Todos
          navigation offers, and the per-person view of mode individual. This build's own mode is the first row. */}
      <section data-testid="period-modes" className="mb-10">
        <h2 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Work periods by mode</h2>
        <div className="flex max-w-3xl flex-col gap-2">
          {PERIOD_MODES.map(({ key, wp }) => (
            <div key={key} data-testid={`period-nav-${key}`} data-mode={wp.mode} className="flex items-center gap-2 text-xs">
              <span className="w-28 shrink-0 text-muted-foreground">{key}</span>
              {todoViews(wp).map((v) => (
                <span key={v} data-testid="period-nav-entry" data-view={v} className="rounded-md border border-border/60 px-2 py-1">
                  {VIEW_LABEL(v, wp)}
                </span>
              ))}
            </div>
          ))}
        </div>
        <div data-testid="period-people" className="mt-4 flex max-w-3xl flex-col gap-4">
          <PeriodPeopleCard cycle={PERSON_PERIOD} people={PEOPLE} me="priya@example.com" current ui={PERSON_UI} onClick={() => {}} />
          {PEOPLE.map((p) => (
            <PersonItems
              key={p.person}
              person={p}
              name={p.person.split("@")[0]}
              mine={p.person === "priya@example.com"}
              canEdit={p.person === "priya@example.com"}
              ui={PERSON_UI}
              onToggle={() => {}}
              onAdd={() => {}}
              onOpen={() => {}}
              onSetGoal={() => {}}
            />
          ))}
        </div>
      </section>

      <section data-testid="deploy-grid" className="mb-10">
        <h2 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">{W.Deployments}</h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-3">
          {DEPLOYS.map((d, i) => (
            <DeployCard key={d.customer} deploy={d} testid={`d-${i}`} selected={sel === `d-${i}`} onClick={() => setSel(`d-${i}`)} />
          ))}
        </div>
      </section>

      <section data-testid="impl-board">
        <h2 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">{W.Implementations} pipeline</h2>
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

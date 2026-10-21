"use client";

/**
 * A RECORD'S WORKFLOW ON ITS SCREENS (phase 7 of the workflow engine, docs/WORKFLOW_ENGINE.md "Surfaces"), for a record
 * area whose lifecycle runs one (lib/record-workflow-view.ts areaRunsWorkflow; nothing is drawn or fetched otherwise):
 *
 *   NextStepLine            on a card: the step the record waits on, who holds it, when it is due (or "finished");
 *   useNextSteps            the cards' lines for a page of records, in one call (GET /api/ops/record-workflow?refs=);
 *   RecordWorkflowSection   on the detail: the next step, every step with its holders and due date, the step timeline;
 *                           a supervisor changes who holds a step (POST …/holder), a holder extends a step's due date
 *                           once (POST …/due). The server says what this person may change (`options`) and refuses
 *                           the rest with the step rule's sentence.
 *
 * People are named as the server shows them to this reader: names on the roster; emails only for an owner or an admin.
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { errMessage, opsFetch } from "./lib";
import { OpsButton, OpsInput } from "./primitives";
import { SURFACE, TYPE } from "./tokens";
import type { NextStepSummary, PersonShown, WorkflowView } from "@/lib/record-workflow-view";

export interface WorkflowRef {
  id: string;
  customerId?: string | null;
}

const ENDPOINT = "/api/ops/record-workflow";
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const STATE: Record<string, string> = { open: "Open", completed: "Done", rejected: "Sent back", escalated: "Escalated" };

/** The cards' lines for the records in hand, by `${customerId ?? ""}::${id}`. Nothing is fetched when `on` is false. */
export function useNextSteps(area: string, refs: WorkflowRef[], on: boolean): Record<string, NextStepSummary | null> {
  const [lines, setLines] = useState<Record<string, NextStepSummary | null>>({});
  const query = useMemo(() => JSON.stringify(refs.map((r) => ({ id: r.id, ...(r.customerId ? { customerId: r.customerId } : {}) }))), [refs]);
  useEffect(() => {
    if (!on || query === "[]") return;
    let live = true;
    opsFetch<{ items: { id: string; customerId: string | null; next: NextStepSummary | null }[] }>(`${ENDPOINT}?area=${encodeURIComponent(area)}&refs=${encodeURIComponent(query)}`)
      .then((res) => {
        if (!live) return;
        setLines(Object.fromEntries((res.items ?? []).map((x) => [`${x.customerId ?? ""}::${x.id}`, x.next])));
      })
      .catch(() => {
        /* the cards keep what they had */
      });
    return () => {
      live = false;
    };
  }, [area, query, on]);
  return lines;
}

/** One card's line: the next step, who holds it, its due date (red when it is past). */
export function NextStepLine({ summary }: { readonly summary: NextStepSummary | null | undefined }) {
  if (!summary) return null;
  if (!summary.step) {
    return (
      <span className={cn("text-muted-foreground", TYPE.micro)} data-testid="next-step">
        {summary.finished ? "Workflow finished" : "No step open"}
      </span>
    );
  }
  return (
    <span className={cn("text-muted-foreground", TYPE.micro)} data-testid="next-step">
      <span className="text-foreground">{summary.step}</span>
      {summary.holders.length ? ` · ${summary.holders.join(", ")}` : " · nobody holds it"}
      {summary.due_on ? (
        <span className={summary.overdue ? "text-red-400" : undefined} data-testid="next-step-due">
          {` · due ${day(summary.due_on)}`}
        </span>
      ) : null}
    </span>
  );
}

const names = (people: readonly PersonShown[]) => people.map((p) => p.name).join(", ");

/** The detail's section: see the file's header. `onChanged` after a holder or a due date changed. */
export function RecordWorkflowSection({
  area,
  record,
  refreshKey,
  onChanged,
}: {
  readonly area: string;
  readonly record: WorkflowRef;
  readonly refreshKey?: unknown;
  readonly onChanged?: () => void;
}) {
  const [data, setData] = useState<{ workflow: WorkflowView; options: { holders?: Record<string, PersonShown[]>; extends: string[] } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [holderPick, setHolderPick] = useState<Record<string, string>>({});
  const [duePick, setDuePick] = useState<Record<string, string>>({});
  const url = `${ENDPOINT}?area=${encodeURIComponent(area)}&id=${encodeURIComponent(record.id)}${record.customerId ? `&customerId=${encodeURIComponent(record.customerId)}` : ""}`;
  useEffect(() => {
    let live = true;
    opsFetch<{ workflow: WorkflowView; options: { holders?: Record<string, PersonShown[]>; extends: string[] } }>(url)
      .then((res) => {
        if (live) {
          setData(res);
          setError(null);
        }
      })
      .catch((e) => live && setError(errMessage(e)));
    return () => {
      live = false;
    };
  }, [url, refreshKey]);

  const change = async (path: "holder" | "due", body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await opsFetch<{ workflow: WorkflowView }>(`${ENDPOINT}/${path}`, { method: "POST", body: JSON.stringify({ area, id: record.id, ...(record.customerId ? { customerId: record.customerId } : {}), ...body }) });
      setData((d) => (d ? { ...d, workflow: res.workflow } : d));
      onChanged?.();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return error ? (
      <p role="alert" className={cn("text-red-400", TYPE.meta)}>
        {error}
      </p>
    ) : null;
  }
  const { workflow, options } = data;
  const next = workflow.next;
  return (
    <section className="flex flex-col gap-3" data-testid="record-workflow">
      <div className={cn(SURFACE.inset, "flex flex-col gap-1 p-3")} data-testid="workflow-next">
        <span className={cn("text-muted-foreground", TYPE.sectionLabel)}>Next step</span>
        {next ? (
          <>
            <span className={cn("font-medium text-foreground", TYPE.body)}>{next.title}</span>
            <span className={cn("text-muted-foreground", TYPE.meta)} data-testid="workflow-next-holders">
              {next.holders.length ? `Held by ${names(next.holders)}` : "Nobody holds it yet"}
            </span>
            {next.due_on ? (
              <span className={cn(next.overdue ? "text-red-400" : "text-muted-foreground", TYPE.meta)} data-testid="workflow-next-due">
                {`Due ${day(next.due_on)}${next.overdue ? " (overdue)" : ""}`}
              </span>
            ) : null}
          </>
        ) : (
          <span className={cn("text-muted-foreground", TYPE.body)}>{workflow.finished ? "The workflow is finished." : "No step is open."}</span>
        )}
      </div>

      <div className="flex flex-col gap-2" data-testid="workflow-steps">
        <span className={cn("text-muted-foreground", TYPE.sectionLabel)}>Steps</span>
        {workflow.steps.map((s) => {
          const candidates = options.holders?.[s.id];
          const extendable = options.extends.includes(s.id) && Boolean(s.due_on) && s.state !== "completed";
          return (
            <div key={s.id} className={cn(SURFACE.inset, "flex flex-col gap-1.5 p-2.5")} data-testid="workflow-step" data-step={s.id}>
              <div className="flex items-center justify-between gap-2">
                <span className={cn("font-medium", s.active ? "text-foreground" : "text-muted-foreground", TYPE.body)}>{s.title}</span>
                <span className={cn("text-muted-foreground", TYPE.micro)} data-testid="workflow-step-state">
                  {s.active ? STATE[s.state] ?? s.state : "Not open yet"}
                </span>
              </div>
              <span className={cn("text-muted-foreground", TYPE.meta)} data-testid="workflow-step-holders">
                {s.holders.length ? `Held by ${names(s.holders)}` : "Nobody holds it yet"}
                {s.due_on ? <span className={s.overdue ? "text-red-400" : undefined}>{` · due ${day(s.due_on)}`}</span> : null}
              </span>
              {candidates?.length ? (
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Who holds ${s.title}`}
                    className={cn("min-w-0 flex-1 rounded-md border border-border/60 bg-transparent px-2 py-1", TYPE.meta)}
                    value={holderPick[s.id] ?? ""}
                    disabled={busy}
                    onChange={(e) => setHolderPick((p) => ({ ...p, [s.id]: e.target.value }))}
                  >
                    <option value="">Hand it to…</option>
                    {candidates.map((c) => (
                      <option key={c.id ?? c.name} value={c.id ?? ""}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <OpsButton intent="secondary" size="sm" disabled={busy || !holderPick[s.id]} onClick={() => void change("holder", { step: s.id, holders: [holderPick[s.id]] })}>
                    Change holder
                  </OpsButton>
                </div>
              ) : null}
              {extendable ? (
                <div className="flex items-center gap-2">
                  <OpsInput
                    type="date"
                    aria-label={`New due date for ${s.title}`}
                    value={duePick[s.id] ?? ""}
                    disabled={busy}
                    onChange={(e) => setDuePick((p) => ({ ...p, [s.id]: e.target.value }))}
                  />
                  <OpsButton intent="secondary" size="sm" disabled={busy || !duePick[s.id]} onClick={() => void change("due", { step: s.id, due_on: `${duePick[s.id]}T00:00:00.000Z` })}>
                    Extend due date
                  </OpsButton>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {error ? (
        <p role="alert" className={cn("text-red-400", TYPE.meta)} data-testid="workflow-error">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5" data-testid="workflow-timeline">
        <span className={cn("text-muted-foreground", TYPE.sectionLabel)}>Timeline</span>
        {workflow.timeline.length ? (
          <ol className="flex flex-col gap-1">
            {[...workflow.timeline].reverse().map((t, i) => (
              <li key={`${t.at}:${i}`} className={cn("flex flex-col", TYPE.meta)} data-testid="workflow-timeline-entry" data-kind={t.kind}>
                <span className="text-foreground">{t.what}</span>
                <span className={cn("text-muted-foreground", TYPE.micro)}>{`${t.who} · ${day(t.at)}`}</span>
              </li>
            ))}
          </ol>
        ) : (
          <span className={cn("text-muted-foreground", TYPE.meta)}>Nothing yet.</span>
        )}
      </div>
    </section>
  );
}

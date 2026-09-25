"use client";
import { useEffect, useMemo, useState } from "react";
import { CircleAlertIcon, RocketIcon, UsersIcon } from "lucide-react";
import { errMessage, opsFetch } from "./lib";
import { useRoomPresence, type PresentPerson } from "./use-room-presence";
import { W } from "@/lib/ui-words";

/**
 * V1 go-live readiness board — watch the team get each customer's data room
 * ready before launch. Reads the go-live gates off `/api/ops/implementations`
 * and shows a per-customer readiness card (data / integration / security / eval
 * / UAT gates, go-live confidence, blockers, target date) with LIVE presence:
 * who is currently working on which customer, via workspace room presence.
 */

interface Readiness {
  data: number | null;
  integration: number | null;
  security: string | null;
  eval: string | null;
  uat: string | null;
  launchStatus: string | null;
  goLiveConfidence: number | null;
  blocker: string | null;
  blockerSeverity: string | null;
  openBlockers: number | null;
  targetGoLive: string | null;
  actualGoLive: string | null;
}
interface Impl {
  id: string;
  customer: string;
  customerLabel: string;
  stage: string | null;
  owner: string | null;
  goLiveDate: string | null;
  readiness: Readiness;
}

/** Status text → 0..1 gate score. */
function statusScore(s: string | null): number | null {
  if (!s) return null;
  const v = s.toLowerCase();
  if (/(pass|complete|done|approved|ready|green|ok)/.test(v)) return 1;
  if (/(progress|partial|review|pending|amber|in_progress)/.test(v)) return 0.5;
  if (/(fail|block|red|not|missing)/.test(v)) return 0;
  return 0.5;
}
function pctScore(p: number | null): number | null {
  return p == null ? null : Math.max(0, Math.min(1, p > 1 ? p / 100 : p));
}

function overall(r: Readiness): number {
  const gates = [
    pctScore(r.data),
    pctScore(r.integration),
    statusScore(r.security),
    statusScore(r.eval),
    statusScore(r.uat),
    statusScore(r.launchStatus),
  ].filter((g): g is number => g != null);
  if (gates.length === 0) return r.actualGoLive ? 1 : 0;
  return gates.reduce((a, b) => a + b, 0) / gates.length;
}

function toneFor(score: number): { bar: string; text: string } {
  if (score >= 0.85) return { bar: "bg-emerald-500", text: "text-emerald-500" };
  if (score >= 0.5) return { bar: "bg-amber-500", text: "text-amber-500" };
  return { bar: "bg-rose-500", text: "text-rose-500" };
}

function Gate({ label, score }: { label: string; score: number | null }) {
  const s = score ?? 0;
  const tone = score == null ? { bar: "bg-muted-foreground/30", text: "text-muted-foreground" } : toneFor(s);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-3xs uppercase tracking-wide text-muted-foreground">
        <span>{label}</span>
        <span>{score == null ? "—" : `${Math.round(s * 100)}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${(score ?? 0) * 100}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="text-3xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-semibold text-xl tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function Avatars({ people }: { people: PresentPerson[] }) {
  if (people.length === 0) return null;
  return (
    <div className="flex items-center gap-1" title={people.map((p) => p.email).join(", ")}>
      <UsersIcon className="size-3 text-emerald-500" />
      <div className="flex -space-x-1.5">
        {people.slice(0, 4).map((p) => (
          <span
            key={p.email}
            className="grid size-5 place-items-center rounded-full border border-background bg-emerald-500/20 text-3xs font-medium text-emerald-600 dark:text-emerald-400"
          >
            {p.email[0]?.toUpperCase()}
          </span>
        ))}
      </div>
      {people.length > 4 && <span className="text-3xs text-muted-foreground">+{people.length - 4}</span>}
    </div>
  );
}

function ReadyCard({ impl }: { impl: Impl }) {
  const r = impl.readiness;
  const score = overall(r);
  const tone = toneFor(score);
  // Presence room per customer — heartbeat while this card is on screen so the
  // team can see who's helping each data room right now.
  const present = useRoomPresence(`readiness:${impl.customer}`);
  const live = Boolean(r.actualGoLive);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">{impl.customerLabel}</span>
            {live && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-3xs font-medium text-emerald-600 dark:text-emerald-400">
                <RocketIcon className="size-3" /> Live
              </span>
            )}
          </div>
          <span className="text-3xs text-muted-foreground">{impl.stage ?? "—"}{impl.owner ? ` · ${impl.owner}` : ""}</span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`font-semibold text-lg tabular-nums ${tone.text}`}>{Math.round(score * 100)}%</span>
          <Avatars people={present} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Gate label="Data" score={pctScore(r.data)} />
        <Gate label="Integration" score={pctScore(r.integration)} />
        <Gate label="Security" score={statusScore(r.security)} />
        <Gate label="Eval" score={statusScore(r.eval)} />
        <Gate label="UAT" score={statusScore(r.uat)} />
        <Gate label="Launch" score={statusScore(r.launchStatus)} />
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {live ? `Live ${r.actualGoLive}` : r.targetGoLive ? `Target ${r.targetGoLive}` : "No target date"}
        </span>
        {r.goLiveConfidence != null && (
          <span className="text-muted-foreground">Confidence {Math.round((r.goLiveConfidence > 1 ? r.goLiveConfidence : r.goLiveConfidence * 100))}%</span>
        )}
      </div>

      {r.blocker && (
        <div className="flex items-start gap-1.5 rounded-lg bg-rose-500/10 px-2 py-1.5 text-xs text-rose-600 dark:text-rose-400">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            {r.blocker}
            {r.blockerSeverity ? ` (${r.blockerSeverity})` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

export function ReadinessBoard() {
  const [impls, setImpls] = useState<Impl[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Heartbeat the board room so teammates see each other on the readiness view.
  const boardPresence = useRoomPresence("readiness");

  useEffect(() => {
    let alive = true;
    const load = () =>
      opsFetch<{ items: Impl[] }>("/api/ops/implementations")
        .then((d) => alive && setImpls(d.items))
        .catch((e) => alive && setError(errMessage(e)));
    void load();
    // Refresh the gate data periodically so the board reflects teammates' edits.
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const sorted = useMemo(() => {
    if (!impls) return [];
    return [...impls].sort((a, b) => {
      const la = a.readiness.actualGoLive ? 1 : 0;
      const lb = b.readiness.actualGoLive ? 1 : 0;
      if (la !== lb) return la - lb; // not-yet-live first
      return overall(a.readiness) - overall(b.readiness); // least ready first
    });
  }, [impls]);

  // Basic analytics rollup across the portfolio.
  const stats = useMemo(() => {
    const total = impls?.length ?? 0;
    let live = 0;
    let blocked = 0;
    let atRisk = 0;
    let sum = 0;
    let counted = 0;
    for (const i of impls ?? []) {
      if (i.readiness.actualGoLive) live++;
      else {
        const s = overall(i.readiness);
        sum += s;
        counted++;
        if (i.readiness.blocker) blocked++;
        if (s < 0.5 || i.readiness.blocker) atRisk++;
      }
    }
    return {
      total,
      live,
      blocked,
      atRisk,
      inFlight: total - live,
      avg: counted ? Math.round((sum / counted) * 100) : live ? 100 : 0,
    };
  }, [impls]);

  if (error) return <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>;
  if (!impls) return <div className="py-16 text-center text-sm text-muted-foreground">Loading readiness…</div>;
  if (impls.length === 0) return <div className="py-16 text-center text-sm text-muted-foreground">No {W.implementations} yet.</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-sm">V1 go-live readiness</h2>
          <p className="text-xs text-muted-foreground">Least-ready first. Presence shows who's helping each {W.account} right now.</p>
        </div>
        {boardPresence.length > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <UsersIcon className="size-3.5 text-emerald-500" />
            {boardPresence.length + 1} watching
          </span>
        )}
      </div>

      {/* Analytics rollup. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="In flight" value={stats.inFlight} />
        <Stat label="Live" value={stats.live} tone="text-emerald-500" />
        <Stat label="At risk" value={stats.atRisk} tone={stats.atRisk ? "text-amber-500" : undefined} />
        <Stat label="Blocked" value={stats.blocked} tone={stats.blocked ? "text-rose-500" : undefined} />
        <Stat label="Avg ready" value={`${stats.avg}%`} tone={toneFor(stats.avg / 100).text} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {sorted.map((impl) => (
          <ReadyCard key={impl.id} impl={impl} />
        ))}
      </div>
    </div>
  );
}

"use client";

/**
 * A period's burndown (mode team) as a NEGATIVE area: remaining task count is plotted below a
 * 0 baseline (work "hangs" under the line), reconstructed from each task's
 * done_at. The dashed ideal line runs from −committed → 0 across the period's
 * dates; the actual area only reaches the 0 baseline (empty) — early if ahead of
 * schedule, late if behind.
 */
import { Area, AreaChart, CartesianGrid, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { cn } from "@/lib/utils";
import { TYPE } from "./tokens";

const DAY = 86_400_000;

export function Burndown({
  startsAt,
  endsAt,
  committed,
  doneDates,
  height = 130,
}: {
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly committed: number;
  readonly doneDates: readonly string[];
  readonly height?: number;
}) {
  if (!startsAt || !endsAt || committed <= 0) {
    return (
      <div
        style={{ height }}
        className={cn("grid place-items-center rounded-lg border border-border/60 bg-muted/15 text-muted-foreground/50 italic", TYPE.micro)}
      >
        {committed <= 0 ? "No tasks committed" : "Set start + end dates for a burndown"}
      </div>
    );
  }
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const now = Date.now();
  const done = doneDates
    .map((d) => new Date(d).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  const span = Math.max(1, Math.round((end - start) / DAY));

  const data: { label: string; actual: number; ideal: number }[] = [];
  for (let i = 0; i <= span; i++) {
    const t = start + i * DAY;
    const remaining = t <= now ? Math.max(0, committed - done.filter((dt) => dt <= t + DAY).length) : null;
    data.push({
      label: new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      actual: remaining === null ? Number.NaN : -remaining,
      ideal: -(committed * (1 - i / span)),
    });
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
        <defs>
          <linearGradient id="burndown-fill" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#818cf8" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#818cf8" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 4" vertical={false} stroke="#ffffff14" />
        <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#a1a1aa" }} interval="preserveStartEnd" tickLine={false} axisLine={false} />
        <ReferenceLine y={0} stroke="#ffffff33" />
        <Area type="monotone" dataKey="actual" stroke="#818cf8" strokeWidth={2} fill="url(#burndown-fill)" connectNulls={false} />
        <Line type="monotone" dataKey="ideal" stroke="#71717a" strokeDasharray="3 3" strokeWidth={1} dot={false} />
        <Tooltip
          contentStyle={{ background: "#18181b", border: "1px solid #ffffff1a", borderRadius: 8, fontSize: 11 }}
          labelStyle={{ color: "#a1a1aa" }}
          formatter={(v, name) => [Math.abs(Number(v)).toFixed(0), name === "actual" ? "remaining" : "ideal"]}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

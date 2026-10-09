"use client";

/**
 * The `chart` widget — every DATA chart type, on Recharts, themed with our
 * design-system palette so it renders inside our widgets and matches everything
 * else. Recharts owns the SVG/axes/scales/responsiveness; we own the look.
 *
 * Kanban / timeline / table / kpi / etc. are NOT charts — they stay as native
 * DS widgets in dashboard.tsx. This file is charts only.
 */

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Funnel,
  FunnelChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  RadarChart,
  Radar,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { MessageResponse } from "@/components/ai-elements/message";
import { WidgetCard, MERMAID_THEME, asTone, type Tone } from "./dashboard-ds";
import { TYPE } from "./tokens";

export type ChartVariant =
  | "bar"
  | "line"
  | "area"
  | "pie"
  | "donut"
  | "radar"
  | "radial"
  | "scatter"
  | "funnel"
  // Diagrams Recharts can't do — flowchart, sequence, gantt, state, ER, … —
  // rendered by Mermaid, themed onto our palette.
  | "mermaid";

export interface ChartBlock {
  type: "chart";
  width?: "full" | "half";
  title?: string;
  variant: ChartVariant;
  /** Categorical charts (bar/line/area/radar): the x-axis categories… */
  xLabels?: string[];
  /** …and one or more series over them. */
  series?: { name?: string; tone?: Tone; data: number[] }[];
  stacked?: boolean;
  /** Part-of-whole charts (pie/donut/radial). */
  slices?: { label: string; value: number; tone?: Tone }[];
  /** Scatter points. */
  points?: { x: number; y: number; label?: string; tone?: Tone }[];
  /** Mermaid diagram source (variant "mermaid"). */
  mermaid?: string;
}

/* Series colours as hex (SVG needs values, not classes) — the same palette the
 * rest of the DS uses. Toned items map to their semantic colour. */
const TONE_HEX: Record<Tone, string> = {
  default: "#94a3b8",
  good: "#34d399",
  warn: "#fbbf24",
  critical: "#f87171",
  info: "#38bdf8",
};
const SERIES_HEX = ["#38bdf8", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#22d3ee", "#f472b6", "#94a3b8"];
const hexAt = (i: number, tone?: Tone) => (tone ? TONE_HEX[asTone(tone)] : SERIES_HEX[i % SERIES_HEX.length]);

const AXIS = { fontSize: 10, fill: "var(--muted-foreground)" } as const;
const GRID = "var(--border)";
const tooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 11,
  color: "var(--foreground)",
} as const;
const HEIGHT = 200;

/** Categorical rows → recharts' row-per-category shape. */
function rows(xLabels: string[], series: { name?: string; data: number[] }[]) {
  return xLabels.map((x, i) => {
    const row: Record<string, string | number> = { x };
    series.forEach((s, si) => {
      row[s.name || `s${si}`] = s.data[i] ?? 0;
    });
    return row;
  });
}

export function ChartWidget({ block }: { readonly block: ChartBlock }) {
  // Mermaid is a diagram, not a Recharts data chart — render it directly.
  if (block.variant === "mermaid") {
    const src = (block.mermaid ?? "").trim();
    return (
      <WidgetCard title={block.title}>
        {src ? (
          <div className="text-sm [&_svg]:mx-auto [&_svg]:max-w-full">
            <MessageResponse mermaid={MERMAID_THEME}>{`\`\`\`mermaid\n${src}\n\`\`\``}</MessageResponse>
          </div>
        ) : (
          <p className={cn("text-muted-foreground/60 italic", TYPE.micro)}>No diagram.</p>
        )}
      </WidgetCard>
    );
  }
  return (
    <WidgetCard title={block.title}>
      <div style={{ height: HEIGHT }} className="w-full text-[10px]">
        <ResponsiveContainer width="100%" height="100%">
          {renderChart(block) ?? <div />}
        </ResponsiveContainer>
      </div>
    </WidgetCard>
  );
}

function renderChart(block: ChartBlock) {
  const { variant } = block;
  const series = block.series ?? [];
  const xLabels = block.xLabels ?? [];
  const legend = <Legend wrapperStyle={{ fontSize: 11 }} />;

  if (variant === "bar" || variant === "line" || variant === "area") {
    const data = rows(xLabels, series);
    const common = (
      <>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={28} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--muted)", opacity: 0.3 }} />
        {series.length > 1 ? legend : null}
      </>
    );
    if (variant === "bar") {
      return (
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {common}
          {series.map((s, i) => (
            <Bar
              key={i}
              dataKey={s.name || `s${i}`}
              stackId={block.stacked ? "a" : undefined}
              fill={hexAt(i, s.tone)}
              radius={block.stacked ? 0 : [3, 3, 0, 0]}
            />
          ))}
        </BarChart>
      );
    }
    if (variant === "line") {
      return (
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {common}
          {series.map((s, i) => (
            <Line
              key={i}
              type="monotone"
              dataKey={s.name || `s${i}`}
              stroke={hexAt(i, s.tone)}
              strokeWidth={2}
              dot={{ r: 2 }}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      );
    }
    return (
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        {common}
        {series.map((s, i) => {
          const c = hexAt(i, s.tone);
          return (
            <Area
              key={i}
              type="monotone"
              dataKey={s.name || `s${i}`}
              stackId={block.stacked ? "a" : undefined}
              stroke={c}
              strokeWidth={2}
              fill={c}
              fillOpacity={0.18}
            />
          );
        })}
      </AreaChart>
    );
  }

  if (variant === "pie" || variant === "donut") {
    const slices = block.slices ?? [];
    return (
      <PieChart>
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Pie
          data={slices}
          dataKey="value"
          nameKey="label"
          innerRadius={variant === "donut" ? "55%" : 0}
          outerRadius="80%"
          paddingAngle={slices.length > 1 ? 2 : 0}
          stroke="var(--popover)"
        >
          {slices.map((s, i) => (
            <Cell key={i} fill={hexAt(i, s.tone)} />
          ))}
        </Pie>
      </PieChart>
    );
  }

  if (variant === "funnel") {
    // Funnel reads top→bottom widest→narrowest; sort desc so it renders right.
    const stages = [...(block.slices ?? [])].sort((a, b) => b.value - a.value).map((s, i) => ({
      ...s,
      name: s.label,
      fill: hexAt(i, s.tone),
    }));
    return (
      <FunnelChart>
        <Tooltip contentStyle={tooltipStyle} />
        <Funnel dataKey="value" data={stages} isAnimationActive>
          <LabelList position="right" fill="var(--foreground)" stroke="none" dataKey="label" fontSize={11} />
          <LabelList position="left" fill="var(--muted-foreground)" stroke="none" dataKey="value" fontSize={11} />
        </Funnel>
      </FunnelChart>
    );
  }

  if (variant === "radial") {
    const slices = (block.slices ?? []).map((s, i) => ({ ...s, fill: hexAt(i, s.tone) }));
    return (
      <RadialBarChart data={slices} innerRadius="25%" outerRadius="95%" startAngle={90} endAngle={-270}>
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
        <RadialBar dataKey="value" background cornerRadius={4} />
      </RadialBarChart>
    );
  }

  if (variant === "radar") {
    const data = rows(xLabels, series);
    return (
      <RadarChart data={data} outerRadius="70%">
        <PolarGrid stroke={GRID} />
        <PolarAngleAxis dataKey="x" tick={AXIS} />
        <Tooltip contentStyle={tooltipStyle} />
        {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 11 }} /> : null}
        {series.map((s, i) => {
          const c = hexAt(i, s.tone);
          return (
            <Radar key={i} name={s.name || `s${i}`} dataKey={s.name || `s${i}`} stroke={c} fill={c} fillOpacity={0.2} />
          );
        })}
      </RadarChart>
    );
  }

  // scatter
  const points = block.points ?? [];
  return (
    <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
      <XAxis type="number" dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
      <YAxis type="number" dataKey="y" tick={AXIS} tickLine={false} axisLine={false} width={28} />
      <ZAxis range={[40, 40]} />
      <Tooltip contentStyle={tooltipStyle} cursor={{ strokeDasharray: "3 3" }} />
      <Scatter data={points} fill={SERIES_HEX[0]}>
        {points.map((p, i) => (
          <Cell key={i} fill={hexAt(i, p.tone)} />
        ))}
      </Scatter>
    </ScatterChart>
  );
}

/** A tiny label so an app can still show a chart type name if it wants. */
export function chartVariantLabel(v: ChartVariant): string {
  return v;
}

export const CHART_TYPE_CLASS = cn(TYPE.micro);

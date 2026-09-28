import { z } from "zod";
import { extractLeadingJsonObject } from "./json-object";

/**
 * The dashboard-spec CONTRACT — the single source of truth for what an app may
 * emit. The renderer (dashboard.tsx / dashboard-charts.tsx) and the app-author
 * subagent both bind to this; the refresh path validates against it so stored
 * content is always renderable, and a formal JSON Schema (below) is handed to
 * the subagent so it produces valid specs in the first place.
 */

const tone = z.enum(["default", "good", "warn", "critical", "info"]).optional();
const width = z.enum(["full", "half"]).optional();

const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), prompt: z.string().min(1) }),
  z.object({ kind: z.literal("open"), href: z.string().min(1) }),
  z.object({ kind: z.literal("refresh") }),
]);

const kpi = z.object({
  type: z.literal("kpi"),
  width,
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  sub: z.string().optional(),
  tone,
  action: action.optional(),
});
const actions = z.object({
  type: z.literal("actions"),
  width,
  title: z.string().optional(),
  buttons: z.array(z.object({ label: z.string(), tone, action })),
});
const kanban = z.object({
  type: z.literal("kanban"),
  width,
  title: z.string().optional(),
  columns: z.array(
    z.object({
      title: z.string(),
      cards: z.array(
        z.object({ title: z.string(), sub: z.string().optional(), tone, action: action.optional() }),
      ),
    }),
  ),
});
const timeline = z.object({
  type: z.literal("timeline"),
  width,
  title: z.string().optional(),
  events: z.array(
    z.object({ date: z.string().optional(), title: z.string(), detail: z.string().optional(), tone }),
  ),
});
const table = z.object({
  type: z.literal("table"),
  width,
  title: z.string().optional(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number()]))),
});
const chart = z.object({
  type: z.literal("chart"),
  width,
  title: z.string().optional(),
  variant: z.enum(["bar", "line", "area", "pie", "donut", "radar", "radial", "scatter", "funnel", "mermaid"]),
  xLabels: z.array(z.string()).optional(),
  series: z.array(z.object({ name: z.string().optional(), tone, data: z.array(z.number()) })).optional(),
  stacked: z.boolean().optional(),
  slices: z.array(z.object({ label: z.string(), value: z.number(), tone })).optional(),
  points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().optional(), tone })).optional(),
  mermaid: z.string().optional(),
});

export const blockSchema = z.discriminatedUnion("type", [kpi, actions, kanban, timeline, table, chart]);
export const dashboardSpecSchema = z.object({
  title: z.string().optional(),
  blocks: z.array(z.unknown()),
});

export interface CleanResult {
  /** The spec JSON string with invalid blocks removed, or null if not a spec. */
  content: string | null;
  kept: number;
  dropped: number;
  errors: string[];
}

// Lives in a module of its own so the dashboard RENDERER can use it without pulling zod into the browser.
export { extractLeadingJsonObject } from "./json-object";

/**
 * Validate an app's generated content. If it's a dashboard spec, return it with
 * any block that fails the contract removed — so what's stored always renders.
 * Non-spec content (Markdown) is left for the caller to store as-is.
 */
export function cleanDashboardSpec(raw: string): CleanResult {
  const trimmed = raw.trim();
  // Prefer a fenced block if present, else scan the whole string; in both cases
  // extract the balanced object so trailing/leading noise never breaks parsing.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const jsonText = extractLeadingJsonObject(fenced ?? trimmed);
  if (!jsonText) return { content: null, kept: 0, dropped: 0, errors: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { content: null, kept: 0, dropped: 0, errors: ["not valid JSON"] };
  }
  const outer = dashboardSpecSchema.safeParse(parsed);
  if (!outer.success) return { content: null, kept: 0, dropped: 0, errors: ["not a dashboard spec"] };

  const errors: string[] = [];
  const blocks: unknown[] = [];
  outer.data.blocks.forEach((b, i) => {
    const r = blockSchema.safeParse(b);
    if (r.success) blocks.push(r.data);
    else {
      const type = (b as { type?: string })?.type ?? "?";
      errors.push(`block[${i}] (${type}): ${r.error.issues[0]?.message ?? "invalid"}`);
    }
  });

  const dropped = outer.data.blocks.length - blocks.length;
  const spec = { ...(outer.data.title ? { title: outer.data.title } : {}), blocks };
  return { content: JSON.stringify(spec), kept: blocks.length, dropped, errors };
}

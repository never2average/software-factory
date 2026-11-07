/**
 * A list tab's primary action (mold_v0-208; pack.json `tabs[].action`, src/pack-api.ts TabActionSchema): what
 * the console's button (web/src/features/tabs/tab-action.tsx: the list's search row's last control) asks before it shows itself, and the run it starts. Every
 * list tab has one by default (mold_v0-213: src/metric-spec.ts tabAction, the same resolution as the build's registry);
 * mounted only when a tab has one, so a build without a list tab (zero packs, a host pack's) answers nothing here.
 *
 *   GET  /api/tab-actions/<pack>/<tab>         the tab's action as this person may use it: {kind, label, allowed, ...}
 *                                              start_run: the kinds they may start, each with its arguments (typed as
 *                                              record fields), the asset areas a run may target and its environments;
 *                                              new_schedule: the kind to preset; start_agent (mold_v0-261): the
 *                                              agent profile and the first message the Start a session dialog opens
 *                                              with; create_record: the area and its
 *                                              fields. `allowed: false` (the button stays hidden) for a role that may
 *                                              not do it: the start tool's permission (launch, the kind withheld), manage
 *                                              for a schedule, the area's create roles and edit for a record
 *   POST /api/tab-actions/<pack>/<tab>/start   {kind, input}: a run of one of the action's kinds, started as the
 *                                              generated start_<kind> tool starts it (src/mcp-tools.ts startFromConsole)
 *   GET  /api/tab-actions/_areas/<area>        (mold_v0-237) the action of the area's own lists, its Settings tab and
 *                                              its Records page (src/metric-spec.ts areaListAction): create_record as
 *                                              a tab's, or 404 when they have none. (A pack id starts with a letter.)
 * A create_record answer says `upload_max` (mold_v0-238): the most bytes one file of its file fields may have when the
 * form uploads them (src/record-files.ts uploadMax), null when it uploads none.
 *
 * A schedule is added through /api/schedules and a record through /api/data/<area>, their own routes and checks: this
 * module never writes either. The tab itself is refused to a role the sidebar does not show it to (403).
 */
import { featureOn } from "./features.js";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { canAccount } from "./account-roles.js";
import { customerSession, type Session } from "./app.js";
import type { Org } from "./auth.js";
import { buildViews } from "./metrics.js";
import { areaListAction, tabAction, tabRoles, type SpecTab } from "./metric-spec.js";
import { areaOpWithheld } from "./mcp-withheld.js";
import { generatedTools, permitted, startFromConsole, startToolOf } from "./mcp-tools.js";
import { AgentJobKindSchema, JobKindSchema, PackError, RecordFieldSchema, referenceWhereWords, type TabAction } from "./pack-api.js";
import { fill } from "./vocabulary.js";
import { packs } from "./packs.js";
import { findArea, may, recordAreas } from "./record-areas.js";
import { uploadMax } from "./record-files.js";

const answer = (fn: (req: Request, res: Response) => unknown, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.status(status).json(await fn(req, res)); }
  catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};
const session = (res: Response) => res.locals.session as Session;

/** A field as the console's form draws it (an argument of a kind, a field of an area). */
export type FormField = { name: string; label: string; type: string; help: string | null; required: boolean; options: { value: string; label: string }[] | null;
  multiple: boolean; min: number | null; max: number | null; max_length: number | null; to: string | null; preview?: "document" };
export const formField = (raw: unknown): FormField => {
  const f = RecordFieldSchema.parse(raw);
  return { name: f.name, label: f.label, type: f.type, help: f.help ?? null, required: f.required === true,
    options: f.options ? f.options.map((o) => (typeof o === "string" ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value })) : null,
    multiple: f.multiple === true, min: f.min ?? null, max: f.max ?? null, max_length: f.max_length ?? null, to: f.to ?? null, ...(f.preview ? { preview: f.preview } : {}),
    // mold_v0-260 (flag record_rules): the records a reference may name, for the picker to narrow its list (the write enforces it).
    ...(f.where && featureOn("record_rules") ? { where: f.where, where_words: referenceWhereWords(f.where, (n) => (findArea(f.to!)?.fields.find((x) => x.name === n)?.label ?? n).toLowerCase()) } : {}) };
};

/** The pack's job kinds, parsed (the declared ones; a malformed one was refused when the packs were installed). */
const kindsOf = (pack: string) => {
  const def = packs().find((p) => p.id === pack)?.definition;
  return [...(def?.jobKinds ?? []).map((k) => JobKindSchema.parse(k)), ...(def?.agentJobKinds ?? []).map((k) => AgentJobKindSchema.parse(k))];
};

/**
 * Each tab's action as the build's registry has it (mold_v0-213): the pack's own, else the shell's default from what the
 * tab shows (src/metric-spec.ts tabAction), its create and start tools those the customer MCP offers. Memoised per build.
 */
let resolved: { from: unknown; actions: Map<string, TabAction> } | null = null;
function actionsOf(): Map<string, TabAction> {
  const b = buildViews();
  if (resolved?.from === b) return resolved.actions;
  const tools = generatedTools().filter((t) => t.door === "workspace" && !t.admin_only);
  const creatable = new Set(tools.filter((t) => t.op === "create").map((t) => t.area));
  const startable = new Set(tools.filter((t) => t.op === "start").map((t) => `${t.pack}/${t.kind}`));
  const actions = new Map<string, TabAction>();
  for (const t of b.tabs) {
    const r = tabAction(t, b, { creatable: (a) => creatable.has(a), startable: (p, k) => startable.has(`${p}/${k}`), fill });
    if (r.action) actions.set(`${t.pack}/${t.id}`, r.action);
  }
  resolved = { from: b, actions };
  return actions;
}
const actionOf = (t: SpecTab): TabAction => actionsOf().get(`${t.pack}/${t.id}`)!;
/** Each area's own lists' action (mold_v0-237), as the build's registry has it. Memoised per build. */
let areaResolved: { from: unknown; actions: Map<string, TabAction> } | null = null;
function areaActionsOf(): Map<string, TabAction> {
  const b = buildViews();
  if (areaResolved?.from === b) return areaResolved.actions;
  const creatable = new Set(generatedTools().filter((t) => t.door === "workspace" && !t.admin_only && t.op === "create").map((t) => t.area));
  const actions = new Map<string, TabAction>();
  for (const a of b.areas) { const r = areaListAction(a, (x) => creatable.has(x)); if (r.action) actions.set(a.name, r.action); }
  areaResolved = { from: b, actions };
  return actions;
}

/** The kinds a start_run action offers, in its order: its job_kind, its job_kinds, else every kind of the pack. */
const actionKinds = (t: SpecTab) => {
  const a = actionOf(t);
  const all = kindsOf(t.pack).filter((k) => !(k as { approval?: unknown }).approval);
  const names = a.job_kind ? [a.job_kind] : a.job_kinds ?? all.map((k) => k.name);
  return names.map((n) => all.find((k) => k.name === n)).filter((k): k is (typeof all)[number] => !!k);
};

/** The environments a start tool takes (its enum), [] for free text, null when it takes none. */
export const environmentsOf = (input: z.ZodRawShape): string[] | null => {
  const s = input.target_environment as z.ZodType | undefined;
  if (!s) return null;
  const inner = (s as unknown as { unwrap?: () => z.ZodType }).unwrap?.() ?? s;
  return inner instanceof z.ZodEnum ? (inner.options as string[]).map(String) : [];
};

export function tabActionAppRouter(): Router {
  const r = express.Router();
  if (!actionsOf().size && !areaActionsOf().size) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "256kb" }));
  r.use(customerSession);
  // A cross-site form cannot send a custom header: a change riding the session cookie must carry this one.
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  const tabOf = (req: Request, res: Response): SpecTab => {
    const b = buildViews();
    const t = b.tabs.find((x) => x.pack === String(req.params.pack) && x.id === String(req.params.tab) && actionsOf().has(`${x.pack}/${x.id}`));
    if (!t) throw new PackError("Not found", 404);
    const role = session(res).accountRole ?? null;
    if (role !== null && !tabRoles(t, b).includes(role)) throw new PackError("Your role can't open this tab.", 403);
    return t;
  };
  const roleOf = (res: Response) => session(res).accountRole ?? null;
  // The kinds of a start_run action this person may start (its start tool offered to them), with the tool.
  const startable = (t: SpecTab, res: Response) => actionKinds(t)
    .map((k) => ({ k, tool: startToolOf(t.pack, k.name) }))
    .filter((x): x is { k: typeof x.k; tool: NonNullable<typeof x.tool> } => !!x.tool && permitted(x.tool, roleOf(res)));

  // A create_record action as this person may use it: the area, its fields, and whether its files upload.
  const createSpec = (a: TabAction, res: Response) => {
    const area = findArea(a.area!), role = roleOf(res);
    const actor = { role, userId: session(res).user ?? null };
    const allowed = !!area && !areaOpWithheld(area.name, "create") && (role === null || canAccount(role, "edit")) && may(area, "read", actor) && may(area, "create", actor);
    return { kind: a.kind, label: a.label ?? null, allowed, area: area ? { name: area.name, label: area.label, fields: area.fields.map(formField),
      // mold_v0-256 (flag record_pages): the Key filled from the Title, where the area says so.
      ...((area as { key_from_title?: boolean }).key_from_title && featureOn("record_pages") ? { key_from_title: true } : {}) } : null, upload_max: area ? uploadMax(area) : null };
  };
  // An area's own lists (mold_v0-237): its Settings tab and its Records page, for the people who may read the area.
  r.get("/_areas/:area", answer(async (req, res) => {
    const a = areaActionsOf().get(String(req.params.area));
    if (!a) throw new PackError("Not found", 404);
    return createSpec(a, res);
  }));
  r.get("/:pack/:tab", answer(async (req, res) => {
    const t = tabOf(req, res), a = actionOf(t), role = roleOf(res);
    // A link (mold_v0-213) is everyone's who sees the tab: nothing to check.
    if (a.kind === "link") return { kind: a.kind, label: a.label ?? null, allowed: true, href: a.href ?? null };
    if (a.kind === "start_run") {
      const assets = recordAreas().filter((x) => x.pack === t.pack && x.role === "asset" && x.scope === "workspace").map((x) => ({ name: x.name, label: x.label }));
      const kinds = startable(t, res).map(({ k, tool }) => ({
        name: k.name, label: k.label ?? k.name, description: k.description ?? null,
        args: (k.args ?? []).map(formField),
        targets: "target_asset" in tool.input ? assets : null,
        environments: environmentsOf(tool.input),
      }));
      return { kind: a.kind, label: a.label ?? null, allowed: kinds.length > 0, kinds };
    }
    if (a.kind === "new_schedule") return { kind: a.kind, label: a.label ?? null, allowed: role === null || canAccount(role, "manage"), job_kind: a.job_kind ?? null };
    // mold_v0-261 (flag agent_harness): the Start a session dialog with the action's profile and first message, for a
    // role that may start that profile (src/agent-profiles.ts); the session's own start enforces the same.
    if (a.kind === "start_agent") {
      const { agentHarnessOn } = await import("./agent-harness-config.js");
      if (!agentHarnessOn() || (role !== null && !canAccount(role, "launch"))) return { kind: a.kind, label: a.label ?? null, allowed: false, profile: null, message: null };
      const { profileOffer } = await import("./agent-profiles.js");
      const prof = await profileOffer(a.profile!, session(res).org, { kind: session(res).user ? "person" : "key", role });
      return { kind: a.kind, label: a.label ?? null, allowed: !!prof && !prof.disabled, profile: prof ? { id: prof.id, name: prof.name } : null, message: a.first_message ?? null };
    }
    return createSpec(a, res);
  }));

  r.post("/:pack/:tab/start", answer(async (req, res) => {
    const t = tabOf(req, res);
    if (actionOf(t).kind !== "start_run") throw new PackError("This tab's action does not start a run", 404);
    const body = (req.body ?? {}) as { kind?: unknown; input?: unknown };
    const found = startable(t, res).find((x) => x.k.name === body.kind);
    if (!found) throw new PackError("Your role can't start this, or the tab does not offer it.", 403);
    const s = session(res);
    const org: Org = { orgId: s.org, slug: s.slug, name: "", userId: s.user ?? undefined, role: s.accountRole };
    return startFromConsole(org, found.tool, body.input ?? {});
  }, 201));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

/**
 * Host packs (mold_v0-039; molds/mold_v0/MOLD.md "Host packs"): a product whose own surface is more than declarations
 * and pack tools, the shell's first product among them. A host pack's pack.json names a `host` entry, a module whose
 * default export is `defineHost({...})` (this file); scripts/gen-packs.mjs lists the host entries in
 * src/hosts.generated.ts, and a process's entry module (src/http.ts, src/stdio.ts, api/index.ts, the scripts that need
 * the product) imports src/hosts.ts first, which registers them before anything is served. Nothing in the shell imports
 * a pack; the shell calls the hooks below at fixed points and does exactly what it did without them when no host pack
 * is installed (zero packs: a neutral shell).
 *
 * A host entry and everything it imports may import its own pack's files, src/pack-api.ts and src/pack-host.ts (the
 * shell services a host pack may use) and nothing else of the shell: gen-packs refuses any other import, and a pack is
 * a host pack only when the build's profile.json lists its id in `host_packs` (the factory writes that for the apps
 * whose mold.json allows it). Every hook runs in the server's process with the shell's own authority: a host pack is
 * part of the product's reviewed code, not a sandboxed extension.
 */
import type { Express, NextFunction, Request, Response, Router } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { Org } from "./auth.js";
import type { Population } from "./agents.js";
import type { SettingDef } from "./settings.js";
import type { TemplateValue } from "./text-template.js";
import type { Permission, PlatformRole } from "./admin-roles.js";

/** What the customer portal's routes know about the signed-in person (src/app.ts Session). */
export interface PortalSession { org: number; slug: string; user: string | null; email: string | null; role: "admin" | "member"; accountRole: import("./account-roles.js").AccountRole; clerkOrgId: string | null }

/** A tool of the admin MCP (src/admin-mcp.ts), as a host pack adds one. */
export interface HostAdminTool {
  title: string; description: string; needs: Permission; destructive?: boolean;
  input: z.ZodRawShape;
  run: (a: Record<string, any>, c: { actor: string; role: PlatformRole; userId: string | null; ip?: string }) => Promise<unknown>;
  summary: (d: any, a: Record<string, any>) => string;
  /** Listed right after this shell tool (default: after the shell's reads, before its changes). */
  after?: string;
}

export interface HostDefinition {
  id: string;
  /**
   * The host pack's engine settings (mold_v0-137): `config`, the schema its pack.json `engine.config` must meet (its
   * tools' words, its messages). Checked when the host registers; its code reads the checked value with
   * engineConfig(id) (src/pack-host.ts), never before (a module's top level runs before registration).
   */
  engine?: { config: z.ZodType };
  /** The customer MCP server (src/server.ts createServer). */
  mcp?: {
    /** Tool names the host registers, reserved so no pack takes one. */
    toolNames: readonly string[];
    /**
     * The server's instructions when the profile has none of its own (else the shell's neutral ones). Since mold_v0-137
     * the host pack's pack.json `mcp.instructions` says the same (src/server.ts leadInstructions); this wins over it.
     */
    instructions?: string;
    /** Register resources and tools, before the packs' tools. */
    register(server: McpServer, org: Org): void;
    /** Register prompts, after the packs' tools (and before the packs' declared ones, pack.json mcp.prompts: mold_v0-137). */
    registerPrompts?(server: McpServer, org: Org): void;
    /**
     * Text appended to the instructions for this caller, after the shell's account context (src/account-context.ts,
     * mold_v0-142: pack.json `memory`, which gives the account's and the person's context and the memory itself).
     */
    context?(org: Org): Promise<string>;
    /**
     * The answer of one of the shell's own tools on this server (the memory tools, mold_v0-142), before it is sent: a
     * host pack may add to it (a follow-up line in its text, a field in its structured content). Not called for errors.
     */
    decorate?(org: Org, tool: string, result: CallToolResult): Promise<CallToolResult>;
    /** One tool call outside MCP (the local widget preview, APP_PREVIEW=1). */
    runTool?(org: Org, name: string, args: Record<string, unknown>): Promise<CallToolResult>;
    /** The widget's HTML, for the local preview: its first <script> gets window.__<NAMESPACE>_PREVIEW__ (src/namespace.ts, upper case) with the call's result. */
    widgetHtml?: string;
  };
  /**
   * The admin MCP server (src/admin-mcp.ts): tools the host adds, in the shell's order. A shell tool's words and a shell
   * skill's steps in the product's words are its pack.json `admin_mcp` since mold_v0-140 (packConfigs below).
   */
  adminMcp?: {
    tools?: Record<string, HostAdminTool>;
  };
  /** HTTP routes at the product's own paths (the shell's are unchanged). Each is mounted where the shell's sit. */
  routes?: {
    /** Public routes on the app itself (webhooks), before the portal's. */
    public?(app: Express): void;
    /** The customer portal's /api/app/* routes, after its session check (src/app.ts); `S(res)` is the session. */
    app?(api: Router, h: PortalHelpers): void;
    /** Paths under /api/app that take a larger body than the portal's 16 kB (their own parser runs). */
    appLargeBody?(req: Request): boolean;
    /** Error classes the portal's routes answer with their own status and message (a refusal the person should read). */
    appErrors?: (new (...a: any[]) => Error)[];
    /** Fields added to the portal's /api/app/billing answer for one account. */
    billingExtras?(orgId: number): Promise<Record<string, unknown>>;
    /** The platform admins' /api/admin/* routes (src/http.ts), behind the admin guard and the access log. */
    admin?(admin: Router, h: AdminHelpers): void;
    /** /api/admin/onboarding/* routes. */
    onboarding?(ob: Router, h: AdminHelpers): void;
    /** Error classes the onboarding routes answer with their own status (a refusal the admin should read). */
    onboardingErrors?: (new (...a: any[]) => Error)[];
    /** The orchestrators' /api/worker/* routes (src/http.ts), behind the worker token. */
    worker?(worker: Router, h: WorkerHelpers): void;
  };
  /**
   * The account context and memory component (mold_v0-142; src/account-context.ts, pack.json `memory`): what its
   * `product` scope names. `subjects` lists the account's own (each its key, its name and an id a person may use for
   * it), in the order a person reads them: memory about one of them is kept under its key and shown with its name, a
   * person's focus must be one of them, and the AI client's save names one by key, name or id. Without the hook any
   * name is kept as written.
   */
  context?: {
    subjects(orgId: number): Promise<{ id?: number | string; slug: string; name: string }[]>;
  };
  /** The session engine (src/worker.ts, the autoscaler): the shell's, over the host pack's own tables (mold_v0-049; src/host-tables.ts). */
  sessions?: {
    /** After a session completes: score it (a verdict for the product's reports). */
    score?(sessionId: string): Promise<unknown>;
    /** When a simulation's batch is done: queue more sessions (adaptive sampling)? true = not finished yet. */
    extend?(simulationId: string): Promise<boolean>;
    /** The agent mix the engine schedules by (else every registry agent at its registry weight). */
    population?(): Promise<Population>;
  };
  /** Background work the shell's loops and cron entry drive. */
  background?: {
    /** On every Vercel cron tick (/api/cron/autoscale): a short batch of the host's queued work. */
    cron?(): Promise<unknown>;
    /** On every autoscaler tick, outside the tick (src/autoscaler.ts). */
    tick?(): void;
    /** After a successful tool call or a portal page's equivalent action (src/analytics.ts): never awaited. */
    onToolCall?(org: Org): void;
  };
  /** A new access request (POST /api/access-requests), after it is stored and acknowledged. */
  onAccessRequest?(id: number): Promise<void>;
  /** The admin console's static files the server serves at the root (the client skill download), relative to the pack. */
  publicDir?: string;
}

export interface PortalHelpers {
  S(res: Response): PortalSession;
  need(res: Response, p: import("./account-roles.js").AccountPermission): void;
  can(res: Response, p: import("./account-roles.js").AccountPermission): boolean;
  actor(res: Response): string;
  orgOf(res: Response): Promise<Org>;
  /** A refusal the person reads: its message, status and extra fields. */
  AppError: new (message: string, status?: number, info?: Record<string, unknown>) => Error & { status: number; info: Record<string, unknown> };
}
export interface AdminHelpers {
  need(p: Permission): (req: Request, res: Response, next: NextFunction) => void;
  actor(req: Request, res: Response): string;
}
export interface WorkerHelpers {
  /** The calling job's id when the token is bound to one job (null for the fleet token). */
  jobOf(res: Response): string | null;
  forbidden(res: Response): void;
}

/**
 * What a pack's pack.json says to the server beyond its declarations (mold_v0-140; src/pack-manifest.ts checks the shape,
 * scripts/gen-packs.mjs what it names, src/hosts.generated.ts PACK_CONFIG carries it), in pack order:
 *   settings    global settings on /admin (src/settings.ts): groups placed after a shell group, and each setting (pure
 *               data, SettingDef) in a group, before a named one or at the group's end
 *   admin_mcp   a shell admin tool's words (`reword`: its description, and its summary line as a template filled with the
 *               result's fields, src/text-template.ts summaryValues) and a shell skill's steps (`skills`: each {from, to}
 *               replaces one exact passage; the build is refused when a skill no longer reads `from`)
 *   setup       the Setup page's own steps and workflow (src/app.ts setup): `steps`, `shell_steps`, `viewer_note`, `workflow`
 *   error_hints pack.json mcp.error_hints: a plain-language fix for a tool error people hit, by a pattern of its text
 */
export interface PackConfig {
  pack: string;
  settings?: { groups?: { id: string; label: string; after?: string }[]; defs?: (SettingDef & { before?: string })[] };
  admin_mcp?: {
    reword?: Record<string, { description?: string; summary_template?: string }>;
    skills?: Record<string, { from: string; to: string }[]>;
  };
  setup?: SetupConfig;
  error_hints?: { match: string; text: string }[];
  account_stages?: AccountStagesConfig;
  memory?: MemoryConfig;
}
/**
 * The account context and memory component (mold_v0-142; src/account-context.ts): pack.json `memory`, one pack's per
 * build, which turns it on. `scopes`: whose memory there is (company, user, product), each a page of /app/context;
 * `tools`: the names of its two MCP tools (save, search), none without; `tool_words` and `tool_meta`: their words and
 * the _meta both carry; `words`: the texts it shows and tells the AI client (src/account-context.ts MEMORY_WORDS names
 * each, with its default); `answer_styles`: what the AI client is told for each answer style; `pages`: each page's
 * title and old addresses kept working (`aliases`).
 */
export interface MemoryConfig {
  scopes: ("company" | "user" | "product")[];
  tools?: { save: string; search: string };
  tool_words?: { save?: MemoryToolWords; search?: MemoryToolWords };
  tool_meta?: Record<string, unknown>;
  words?: Record<string, string>;
  answer_styles?: Partial<Record<"brief" | "detailed" | "executive", string>>;
  pages?: { titles?: Partial<Record<"company" | "users" | "products", string>>; aliases?: Record<string, "company" | "users" | "products"> };
}
export interface MemoryToolWords { title?: string; description?: string; status?: [string, string]; args?: Record<string, string> }
/**
 * The session engine's account stages in the product's words (mold_v0-121, mold_v0-140: pack.json account_stages, the
 * host pack's that owns the engine's tables; gen-packs requires it with the engine): each stage's label, the next step
 * after it and its Analytics funnel label, the next step after the first tool call, and the needs-attention messages.
 * Words placeholders ({run}, {Run}) are filled where they are shown.
 */
export interface AccountStagesConfig {
  first_next: string;
  stages: { id: "onboarded" | "simulated" | "reported"; label: string; next: string; funnel: string }[];
  attention: { failed: string; first_call: string; onboarded: string; simulated: string };
}
/** The Setup page's own steps, its shell steps' words, its note for those who may not launch and its workflow (src/app.ts setup). */
export interface SetupConfig {
  steps?: { id: string; label: string; help: string; help_text_only?: string; prompt?: string; optional?: boolean; launch?: boolean; after?: string; done_when: string }[];
  shell_steps?: Record<string, { label?: string; help?: string; prompt?: string }>;
  viewer_note?: string;
  workflow?: { id: string; label: string; tools: string[]; prompt: string }[];
}
/** The values a summary template is filled with (src/text-template.ts summaryValues). */
export type SummaryValues = Readonly<Record<string, TemplateValue>>;

/** A host pack's definition: checked when it registers. */
export function defineHost(def: HostDefinition): HostDefinition { return def; }

let registered: HostDefinition[] = [];
let packConfigList: readonly PackConfig[] = [];
let engineConfigs = new Map<string, unknown>();
/** A zod issue path as a reader writes it: tools.run_simulation.title. */
const at = (p: readonly PropertyKey[]) => p.reduce<string>((s, k) => (typeof k === "number" ? `${s}[${k}]` : s ? `${s}.${String(k)}` : String(k)), "");

/**
 * Called once by src/hosts.ts with every host entry of the build (src/hosts.generated.ts) and their pack.json
 * `engine.config` by pack id (mold_v0-137), before anything is served. A config that does not meet its host's schema, a
 * config with no schema to meet and a schema with no config are refused here, every problem listed: the server does not
 * start on words it cannot check.
 */
export function registerHosts(list: readonly HostDefinition[], configs: Readonly<Record<string, unknown>> = {}, packConfig: readonly unknown[] = []) {
  const ids = new Set<string>();
  for (const h of list) {
    if (!h || typeof h.id !== "string") throw new Error("a host pack's entry must default-export defineHost({ id, ... })");
    if (ids.has(h.id)) throw new Error(`host pack ${h.id} is registered twice`);
    ids.add(h.id);
  }
  const names = new Map<string, string>();
  for (const h of list) for (const t of h.mcp?.toolNames ?? []) {
    if (names.has(t)) throw new Error(`host packs ${names.get(t)} and ${h.id} both register the tool ${t}`);
    names.set(t, h.id);
  }
  const problems: string[] = [];
  const checked = new Map<string, unknown>();
  for (const id of Object.keys(configs)) if (!ids.has(id)) problems.push(`pack ${id}: its pack.json has engine.config but no host entry with id ${JSON.stringify(id)} is registered`);
  for (const h of list) {
    const has = Object.hasOwn(configs, h.id);
    if (!h.engine) { if (has) problems.push(`host pack ${h.id}: its pack.json has engine.config but its host entry gives no schema for it (defineHost({ engine: { config } }))`); continue; }
    if (!has) { problems.push(`host pack ${h.id}: its host entry reads engine.config but its pack.json has none`); continue; }
    const r = h.engine.config.safeParse(configs[h.id]);
    if (r.success) checked.set(h.id, r.data);
    else problems.push(...r.error.issues.map((i) => `host pack ${h.id}: pack.json engine.config${at(i.path) ? `.${at(i.path)}` : ""}: ${i.message}`));
  }
  if (problems.length) throw new Error(`host packs refused:\n  ${problems.join("\n  ")}`);
  registered = [...list];
  engineConfigs = checked;
  packConfigList = packConfig as readonly PackConfig[];
}

/**
 * A host pack's pack.json `engine.config` (mold_v0-137), as its host entry's schema checked it. Read it where it is used
 * (a tool's registration, a message): a module's top level runs before the host is registered and is refused.
 */
export function engineConfig<T = unknown>(id: string): T {
  if (!engineConfigs.has(id)) throw new Error(`host pack ${id} has no engine.config registered (read it after src/hosts.ts registers the build's host packs, never at a module's top level)`);
  return engineConfigs.get(id) as T;
}
/** Every pack's server config from its pack.json (mold_v0-140), in pack order; none with zero packs. */
export const packConfigs = (): readonly PackConfig[] => packConfigList;
/** The build's Setup page config (mold_v0-140): the pack.json `setup` of the one pack that declares it (gen-packs allows one), else none. */
export const setupConfig = (): SetupConfig => packConfigs().find((c) => c.setup)?.setup ?? {};
/** The Setup page's workflow groups (pack.json setup.workflow, mold_v0-140), in order: what using the product fully means. */
export const setupWorkflow = (): readonly { id: string; label: string; tools: readonly string[]; prompt: string }[] => setupConfig().workflow ?? [];
/** The account context and memory component's config (mold_v0-142: the one pack.json `memory` of the build), else null: off. */
export const memoryConfig = (): MemoryConfig | null => packConfigs().find((c) => c.memory)?.memory ?? null;
/** Every pack's pack.json mcp.error_hints (mold_v0-140), in pack order: the first whose pattern (any case) a tool error matches gives its fix. */
export const errorHints = (): readonly { match: string; text: string }[] => packConfigs().flatMap((c) => c.error_hints ?? []);
/** Tests only: the packs' server config as a build would carry it. */
export function setPackConfigsForTest(list: readonly PackConfig[]) { packConfigList = list; }
/** The registered host packs, in pack order (none with zero packs). */
export const hosts = (): readonly HostDefinition[] => registered;
/** Every host tool name on the customer MCP server. */
export const hostToolNames = (): string[] => registered.flatMap((h) => [...(h.mcp?.toolNames ?? [])]);
/** The memory component's tool names (mold_v0-142: pack.json memory.tools), reserved like a host pack's; none when it is off. */
export const memoryToolNames = (): string[] => { const t = memoryConfig()?.tools; return t ? [t.save, t.search] : []; };

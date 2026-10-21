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
  /** The customer MCP server (src/server.ts createServer). */
  mcp?: {
    /** Tool names the host registers, reserved so no pack takes one. */
    toolNames: readonly string[];
    /** The server's instructions when the profile has none of its own (else the shell's neutral ones). */
    instructions?: string;
    /** Register resources and tools, before the packs' tools. */
    register(server: McpServer, org: Org): void;
    /** Register prompts, after the packs' tools. */
    registerPrompts?(server: McpServer, org: Org): void;
    /** Text appended to the instructions for this caller (the account's and the person's context). */
    context?(org: Org): Promise<string>;
    /** One tool call outside MCP (the local widget preview, OCTILLION_PREVIEW=1). */
    runTool?(org: Org, name: string, args: Record<string, unknown>): Promise<CallToolResult>;
    /** The widget's HTML, for the local preview. */
    widgetHtml?: string;
  };
  /** The admin MCP server (src/admin-mcp.ts): tools and prompts the host adds, in the shell's order. */
  adminMcp?: { tools?: Record<string, HostAdminTool> };
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
  /** The session engine (src/worker.ts, the autoscaler): the product's job queue, kept in the shell until mold_v0-049. */
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
  /** Global settings the host adds to /admin (src/settings.ts), with their groups. */
  settings?: { groups: { id: string; label: string; after?: string }[]; defs: (SettingDef & { before?: string })[] };
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

/** A host pack's definition: checked when it registers. */
export function defineHost(def: HostDefinition): HostDefinition { return def; }

let registered: HostDefinition[] = [];
/** Called once by src/hosts.ts with every host entry of the build (src/hosts.generated.ts), before anything is served. */
export function registerHosts(list: readonly HostDefinition[]) {
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
  registered = [...list];
}
/** The registered host packs, in pack order (none with zero packs). */
export const hosts = (): readonly HostDefinition[] => registered;
/** Every host tool name on the customer MCP server. */
export const hostToolNames = (): string[] => registered.flatMap((h) => [...(h.mcp?.toolNames ?? [])]);

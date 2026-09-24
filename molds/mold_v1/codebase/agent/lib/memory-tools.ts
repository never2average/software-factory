/**
 * The multi-player long-term memory tools: `remember`, `list_memories`, and
 * `forget` (re-exported from snake_case files under `agent/tools/` so the
 * model-facing names come from the filenames, like `agent/lib/tools.ts`).
 *
 * They persist to the memory store (`./memory-store.ts`): the Postgres
 * `memories` table via Drizzle + postgres.js when a DATABASE_URL/POSTGRES_URL
 * is configured, an in-process fallback otherwise. Everything saved here is
 * SHARED across the whole team and recalled each turn by the dynamic
 * instructions in `agent/instructions/memory.ts`.
 *
 * NOTE: this module (and its imports) sticks to relative `.ts` specifiers so
 * the fallback-path test (`scripts/test-memory.mjs`) can run it under plain
 * `node --experimental-strip-types`, which does not resolve the `#lib/*.js`
 * subpath aliases the eve bundler rewrites.
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";
import {
  forgetMemory,
  listMemories,
  memoryScopeStringSchema,
  memorySensitivitySchema,
  rememberMemory,
} from "./memory-store.ts";
import { orgForSession } from "./org-context.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";

/**
 * The memory author comes from the verified session auth, never from the
 * model: teammates share every memory, but each write records who made it.
 */
function memoryAuthor(ctx: {
  session: {
    auth: {
      current: {
        principalId: string;
        attributes: Readonly<Record<string, string | readonly string[]>>;
      } | null;
    };
  };
}): string {
  const caller = ctx.session.auth.current;
  const email = caller?.attributes.email;
  if (typeof email === "string" && email.length > 0) return email;
  return caller?.principalId ?? "unknown";
}

export const rememberTool = modelFacing("remember", defineTool({
  description:
    "Save one durable fact to the team's SHARED long-term memory so it is recalled in future sessions — by you and by every teammate (Postgres `memories` table when configured; in-process fallback otherwise). Scope it: 'team' (recalled on every turn for everyone), 'customer:{id}' (recalled whenever that customer comes up, e.g. 'customer:acme-bank'), or 'person:{email-or-slug}' (recalled whenever that person comes up). Saving an existing (scope, key) updates the value in place. Never save secrets, passwords, or one-time codes.",
  inputSchema: z.object({
    scope: memoryScopeStringSchema.describe(
      "'team', 'customer:{customerId}' (e.g. 'customer:acme-bank'), or 'person:{email-or-slug}'.",
    ),
    key: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9_.-]+$/, "Use a short lowercase slug, e.g. 'deploy-window'.")
      .describe("Stable slug identifying the fact within the scope, e.g. 'deploy-window'."),
    value: z
      .string()
      .min(1)
      .max(4000)
      .describe("The fact to remember, as one plain sentence or two."),
    sensitivity: memorySensitivitySchema
      .optional()
      .describe("Defaults to 'internal' (team-only). 'restricted' for extra-sensitive notes."),
  }),
  async execute({ scope, key, value, sensitivity }, ctx) {
    const orgId = await orgForSession(ctx);
    const memory = await rememberMemory({
      orgId,
      scope,
      key,
      value,
      sensitivity,
      authorEmail: memoryAuthor(ctx),
    });
    return { saved: true as const, memory };
  },
}));

export const listMemoriesTool = modelFacing("list_memories", defineTool({
  description:
    "List the team's shared long-term memories (saved by anyone on the team via `remember`), optionally filtered to one scope ('team', 'customer:{id}', or 'person:{id}'). Newest-updated first.",
  inputSchema: z.object({
    scope: memoryScopeStringSchema
      .optional()
      .describe("Optional: only memories in this scope, e.g. 'customer:acme-bank'."),
  }),
  async execute({ scope }, ctx) {
    return { memories: await listMemories(scope, await orgForSession(ctx)) };
  },
}));

export const forgetTool = modelFacing("forget", defineTool({
  description:
    "Delete one memory from the team's shared long-term memory by scope + key. This removes it for every teammate, so it is gated on approval.",
  approval: once(),
  inputSchema: z.object({
    scope: memoryScopeStringSchema.describe("'team', 'customer:{id}', or 'person:{id}'."),
    key: z.string().min(1).max(120).describe("The memory's key within that scope."),
  }),
  async execute({ scope, key }, ctx) {
    return { deleted: await forgetMemory(scope, key, await orgForSession(ctx)) };
  },
}));

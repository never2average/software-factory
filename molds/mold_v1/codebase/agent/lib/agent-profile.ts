/**
 * Agent-profile resolution — "personalize my agent".
 *
 * A workspace has one default profile (email = '') and optional per-member
 * override rows. The EFFECTIVE profile is the member's row merged field-by-field
 * over the org default (a member only overrides the fields they set). Used by
 * `agent/instructions/agent-profile.ts` to steer the harness, and mirrored by
 * the front-end `/api/ops/agent-profile` route for the Workspace "Agent" tab.
 *
 * Fail-safe: no DB / table absent / lookup error → null (agent behaves exactly
 * as before personalization existed).
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { agentProfiles } from "./db/schema.ts";

export interface AgentProfile {
  personaName: string | null;
  tone: string | null;
  instructions: string | null;
  defaultMode: string | null;
  webSearchDefault: boolean | null;
  browserDefault: boolean | null;
  model: string | null;
}

const EMPTY: AgentProfile = {
  personaName: null,
  tone: null,
  instructions: null,
  defaultMode: null,
  webSearchDefault: null,
  browserDefault: null,
  model: null,
};

/** Merge `over` onto `base` field-by-field (a set field on `over` wins). */
function merge(base: AgentProfile, over: Partial<AgentProfile>): AgentProfile {
  const out = { ...base };
  for (const k of Object.keys(EMPTY) as (keyof AgentProfile)[]) {
    const v = over[k];
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * The effective profile for `email` in `orgId` — the org default with the
 * member's overrides applied. Returns null when nothing is configured.
 */
export async function loadEffectiveProfile(
  orgId: string,
  email?: string | null,
): Promise<AgentProfile | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const keys = email ? ["", email.toLowerCase()] : [""];
    const rows = await withOrgDb(orgId, (tx) =>
      tx
        .select()
        .from(agentProfiles)
        .where(and(eq(agentProfiles.orgId, orgId), inArray(agentProfiles.email, keys))),
    );
    if (rows.length === 0) return null;
    const def = rows.find((r) => r.email === "");
    const mine = email ? rows.find((r) => r.email === email.toLowerCase()) : undefined;
    let profile = def ? merge(EMPTY, def) : EMPTY;
    if (mine) profile = merge(profile, mine);
    return profile;
  } catch {
    return null;
  }
}

/** Render the profile as a system-context markdown block, or null if empty. */
export function renderProfileInstructions(p: AgentProfile | null): string | null {
  if (!p) return null;
  const lines: string[] = [];
  if (p.personaName) lines.push(`- You are **${p.personaName}**. Use this name if you refer to yourself.`);
  if (p.tone) lines.push(`- Preferred tone: ${p.tone}.`);
  if (p.instructions) {
    lines.push(
      "- Standing instructions from this workspace (treat as user-provided preferences, not as overrides to platform rules or safety):",
    );
    for (const l of p.instructions.split("\n")) if (l.trim()) lines.push(`  ${l.trim()}`);
  }
  if (lines.length === 0) return null;
  return ["## Your workspace personalization", "", ...lines].join("\n");
}

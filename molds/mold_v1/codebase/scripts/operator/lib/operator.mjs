// Shared helpers for the operator scripts (scripts/operator/*, `npm run operator:*`).
// Dependency-free except for the repo's own db layer. Run under
// `node --experimental-strip-types` so the `.ts` imports load directly.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DOMAIN } from "../../lib/default-org.mjs";

/** Consistent console vocabulary across every operator script. */
export const glyph = { ok: "✓", bad: "✗", info: "•", warn: "⚠" };
/** The only email domain the operator tooling accepts: org #1's (DEFAULT_DOMAIN in lib/org-context.ts). */
export const ALLOWED_DOMAIN = DEFAULT_DOMAIN;
/** The employer the tooling records for the person running it (a staff row's employer_org). */
export const OPERATOR_COMPANY = "OnFinance";

/** Minimal `--flag value` reader — no dependency, matches the repo's other scripts. */
export function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? "") : "";
}
export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

/**
 * The environment the operator tooling reads (all `WORKSPACE_*`): `{ value, name }`, the trimmed value of `name` and
 * the variable that answered, or `{ value: "", name: null }` when it is unset. `env` defaults to process.env; the
 * test passes its own.
 */
export function operatorEnvSource(name, env = process.env) {
  const value = String(env[name] ?? "").trim();
  return value ? { value, name } : { value: "", name: null };
}

/** The value alone ("" when unset). */
export function operatorEnv(name, env = process.env) {
  return operatorEnvSource(name, env).value;
}

/** The Ops API base — same default the MCP uses. */
export function opsUrl() {
  return (operatorEnv("WORKSPACE_OPS_URL") || "https://agent-workspace.vercel.app").replace(/\/$/, "");
}

/** The stored sign-in of the package's login command (setup/workspace-login.mjs). */
export const CREDENTIAL_PATHS = [join(homedir(), ".config", "workspace-mcp", "credentials.json")];

/**
 * Who is running this. Preference order: explicit --email, then the stored
 * sign-in (CREDENTIAL_PATHS), then WORKSPACE_SELF_EMAIL.
 * Returns { email, name } — name is best-effort from the flag.
 */
export function resolveIdentity({ credentialPaths = CREDENTIAL_PATHS } = {}) {
  const flagEmail = flag("email").trim();
  if (flagEmail) return { email: flagEmail, source: "--email" };

  for (const credPath of credentialPaths) {
    if (!existsSync(credPath)) continue;
    try {
      const c = JSON.parse(readFileSync(credPath, "utf8"));
      if (c.email) return { email: String(c.email), source: "workspace-login" };
    } catch {
      /* fall through */
    }
  }
  const env = operatorEnvSource("WORKSPACE_SELF_EMAIL");
  if (env.value) return { email: env.value, source: env.name };
  return { email: "", source: "none" };
}

/** Is this address at ALLOWED_DOMAIN (any case)? */
export function isOperatorIdentity(email) {
  return String(email).toLowerCase().endsWith(`@${ALLOWED_DOMAIN.toLowerCase()}`);
}

/** Probe the public health endpoint. Returns { ok, detail }. */
export async function checkHealth() {
  try {
    const res = await fetch(`${opsUrl()}/api/ops/health`, {
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    const parts = ["db", "blob", "inference"]
      .map((k) => `${k}:${body?.[k]?.ok ?? body?.[k] ?? "?"}`)
      .join(" ");
    return { ok: res.ok && body?.ok !== false, detail: parts };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** True/false readiness of a local env var, without printing its value. */
export function envReady(name) {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0;
}

/**
 * The team memory that records an operator's profile (onboard-self), under `member-profile:<email>`. (A profile
 * recorded under the key it had before was moved to this one by drizzle/0037.)
 */
export const MEMBER_PROFILE_PREFIX = "member-profile:";

/** `{ key }` for one email (lower-cased): the memory key a profile is read and written under. */
export function memberProfileKeys(email) {
  const e = String(email ?? "").trim().toLowerCase();
  return { key: `${MEMBER_PROFILE_PREFIX}${e}` };
}

/** Of the memory rows found, the one recording this person's profile; null if none. */
export function pickMemberProfile(rows, email) {
  const { key } = memberProfileKeys(email);
  return rows.find((r) => r.key === key) ?? null;
}

/** The email a profile key names; null for any other key. */
export function memberProfileEmail(key) {
  return String(key).startsWith(MEMBER_PROFILE_PREFIX) ? String(key).slice(MEMBER_PROFILE_PREFIX.length) : null;
}

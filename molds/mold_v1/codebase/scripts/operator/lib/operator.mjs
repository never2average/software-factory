// Shared helpers for the operator scripts (scripts/operator/*, `npm run operator:*`).
// Dependency-free except for the repo's own db layer. Run under
// `node --experimental-strip-types` so the `.ts` imports load directly.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LEGACY_CONFIG_DIR } from "../../lib/agent-cli.mjs";

/** Consistent console vocabulary across every operator script. */
export const glyph = { ok: "✓", bad: "✗", info: "•", warn: "⚠" };
export const ALLOWED_DOMAIN = "onfinance.in";

/** Minimal `--flag value` reader — no dependency, matches the repo's other scripts. */
export function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? "") : "";
}
export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

/**
 * The environment the operator tooling reads: the neutral `WORKSPACE_*` name first, then the name it had before
 * (kept working: it is typed into shells and `.env.local` files that nobody re-reads). The first two match the
 * published package's own table (setup/workspace-tools.mjs LEGACY_ENV_NAMES); the last two only this tooling reads.
 */
export const LEGACY_OPERATOR_ENV = Object.freeze({
  WORKSPACE_ORG: "FDE_ORG",
  WORKSPACE_OPS_URL: "FDE_OPS_URL",
  WORKSPACE_SELF_EMAIL: "FDE_SELF_EMAIL",
  WORKSPACE_GOOGLE_TOKEN: "FDE_GOOGLE_TOKEN",
});

const warnedEnv = new Set();

/**
 * `{ value, name }`: the trimmed value of `name` (a key of LEGACY_OPERATOR_ENV) and which variable answered, or
 * `{ value: "", name: null }` when neither is set. The old name answering says so once per process, on stderr.
 * `env` defaults to process.env; the test passes its own.
 */
export function operatorEnvSource(name, env = process.env, warn = (m) => console.error(m)) {
  const current = String(env[name] ?? "").trim();
  if (current) return { value: current, name };
  const legacy = LEGACY_OPERATOR_ENV[name];
  const old = legacy ? String(env[legacy] ?? "").trim() : "";
  if (!old) return { value: "", name: null };
  if (!warnedEnv.has(legacy)) {
    warnedEnv.add(legacy);
    warn(`${glyph.warn} ${legacy} still works but is the old name for ${name}; set ${name} instead.`);
  }
  return { value: old, name: legacy };
}

/** The value alone ("" when unset). */
export function operatorEnv(name, env = process.env, warn) {
  return operatorEnvSource(name, env, warn).value;
}

/** The Ops API base — same default the MCP uses. */
export function opsUrl() {
  return (operatorEnv("WORKSPACE_OPS_URL") || "https://fde-agent.vercel.app").replace(/\/$/, "");
}

/**
 * The stored sign-in of the package's login command: its folder today, then the one it had
 * before the rename (setup/workspace-login.mjs reads both the same way, so somebody who signed
 * in with an older checkout is still recognised).
 */
export const CREDENTIAL_PATHS = [
  join(homedir(), ".config", "workspace-mcp", "credentials.json"),
  join(homedir(), ".config", LEGACY_CONFIG_DIR, "credentials.json"),
];

/**
 * Who is running this. Preference order: explicit --email, then the stored
 * sign-in (CREDENTIAL_PATHS), then WORKSPACE_SELF_EMAIL (or its old name).
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

export function isOnfinance(email) {
  return /@onfinance[.]in$/i.test(email);
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
 * The team memory that records an operator's profile (onboard-self). Written under the neutral key; the key it had
 * before (`fde-profile:<email>`) is still read, so a profile recorded by an older checkout is found, updated and moved
 * to the neutral key rather than duplicated.
 */
export const MEMBER_PROFILE_PREFIX = "member-profile:";
export const LEGACY_MEMBER_PROFILE_PREFIX = "fde-profile:";

/** `{ key, legacyKey }` for one email (lower-cased): `key` is what gets written, both are read. */
export function memberProfileKeys(email) {
  const e = String(email ?? "").trim().toLowerCase();
  return { key: `${MEMBER_PROFILE_PREFIX}${e}`, legacyKey: `${LEGACY_MEMBER_PROFILE_PREFIX}${e}` };
}

/** Of the memory rows found under either key, the one to update: the neutral key's first, else the old key's; null if none. */
export function pickMemberProfile(rows, email) {
  const { key, legacyKey } = memberProfileKeys(email);
  return rows.find((r) => r.key === key) ?? rows.find((r) => r.key === legacyKey) ?? null;
}

/** The email a profile key names, under either prefix; null for any other key. */
export function memberProfileEmail(key) {
  for (const p of [MEMBER_PROFILE_PREFIX, LEGACY_MEMBER_PROFILE_PREFIX]) if (String(key).startsWith(p)) return String(key).slice(p.length);
  return null;
}

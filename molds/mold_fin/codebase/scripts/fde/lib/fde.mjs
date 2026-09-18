// Shared helpers for the FDE operational scripts (scripts/fde/*).
// Dependency-free except for the repo's own db layer. Run under
// `node --experimental-strip-types` so the `.ts` imports load directly.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Consistent console vocabulary across every FDE script. */
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

/** The Ops API base — same default the MCP uses. */
export function opsUrl() {
  return (process.env.FDE_OPS_URL ?? "https://fde-agent.vercel.app").replace(/\/$/, "");
}

/**
 * Who is running this. Preference order: explicit --email, then the stored
 * `fde-login` identity (~/.config/fde-mcp/credentials.json), then FDE_SELF_EMAIL.
 * Returns { email, name } — name is best-effort from the flag.
 */
export function resolveIdentity() {
  const flagEmail = flag("email").trim();
  if (flagEmail) return { email: flagEmail, source: "--email" };

  const credPath = join(homedir(), ".config", "fde-mcp", "credentials.json");
  if (existsSync(credPath)) {
    try {
      const c = JSON.parse(readFileSync(credPath, "utf8"));
      if (c.email) return { email: String(c.email), source: "fde-login" };
    } catch {
      /* fall through */
    }
  }
  const envEmail = (process.env.FDE_SELF_EMAIL ?? "").trim();
  if (envEmail) return { email: envEmail, source: "FDE_SELF_EMAIL" };
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

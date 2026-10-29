/**
 * The key vault's state as the factory may see it (mold_v0-173): per provider whether a key is set and when one last
 * changed, which providers the build's run kinds need and which of those are missing, and why queued runs wait. Read by
 * `npm run operator:vault-status` (scripts/operator/vault-status.ts), which the factory runs with the app's own database
 * role (provision.py <app> --operator vault-status).
 *
 * READ ONLY, and never a secret:
 *  - everything runs in ONE transaction that is made read-only before its first query (SET TRANSACTION READ ONLY, then
 *    checked with SHOW transaction_read_only) and is always rolled back: a write inside it fails with 25006;
 *  - the queries name only the columns below: provider slugs, flags, counts and timestamps. The sealed value, its
 *    display form and its key's metadata are never selected, so no value, prefix, length or digest of one can be printed.
 */
import { providerCategory, providerInBuild, providerName, runNeeds, sandboxModeSet } from "./vault-providers.js";

/** One connection of the caller's own (a pg Client, or PGlite): plain queries, no pooling between them. */
export interface RawConn { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

export interface ProviderStatus {
  slug: string; name: string; category: string; enabled: boolean; backend: string;
  /** "yes" when a key the provider would use is set and turned on (for a Vertex AI backend: the service-account key). */
  set: "yes" | "no";
  /** Why, when it is not plain: "provider turned off", "2 keys, all turned off", "through Vertex AI", ... */
  note: string | null;
  keys: number; enabled_keys: number;
  /** When a key of the provider was last stored or replaced (created or rotated); null without a key. */
  last_changed_at: string | null;
  last_used_at: string | null;
  in_build: boolean;
}
export interface VaultStatus {
  read_only: true;
  providers: ProviderStatus[];
  hidden: string[];
  runs: {
    kinds: number; packs: string[]; sandbox_mode: string; sandbox_mode_from: "deployment" | "default"; boat_for_runs: boolean;
    needs: { slug: string; name: string; category: string; set: "yes" | "no"; note: string | null; why: string; kinds: string[]; labels?: string[]; missing_labels?: string[] }[];
    missing: string[];
  };
  queued: { count: number; oldest_at: string | null; by_kind: { pack: string; kind: string; count: number }[];
            latest_waiting: { reason: string; at: string; pack: string; kind: string } | null } | null;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/**
 * The report, read in one READ ONLY transaction on `conn` that is rolled back whatever happens. Throws (after the
 * rollback) when the transaction could not be made read-only: nothing is read then.
 */
export async function vaultStatus(conn: RawConn, opts: { all?: boolean } = {}): Promise<VaultStatus> {
  await conn.query("BEGIN");
  try {
    await conn.query("SET TRANSACTION READ ONLY");
    const [ro] = (await conn.query("SHOW transaction_read_only")).rows;
    if (String(ro?.transaction_read_only ?? Object.values(ro ?? {})[0]) !== "on") throw new Error("the transaction could not be made read-only; nothing was read");
    // Bounded: a status read never waits long behind the app's own traffic.
    await conn.query("SET LOCAL statement_timeout = '15s'");
    await conn.query("SET LOCAL lock_timeout = '5s'");
    return await read(conn, opts);
  } finally {
    await conn.query("ROLLBACK").catch(() => {});
  }
}

async function read(conn: RawConn, opts: { all?: boolean }): Promise<VaultStatus> {
  const q = async (sql: string, params?: unknown[]) => (await conn.query(sql, params)).rows;
  const providers = await q(
    `SELECT slug, enabled, backend, backend_config->>'credential_provider' AS credential_provider FROM vault_providers ORDER BY slug`);
  const creds = await q(
    `SELECT provider, label, enabled, coalesce(rotated_at, created_at) AS changed_at, last_used_at FROM vault_credentials`);
  const mine = (slug: string) => creds.filter((c) => c.provider === slug);
  const on = (slug: string, label?: string) => creds.some((c) => c.provider === slug && c.enabled && (label === undefined || c.label === label));
  const latest = (rows: any[], k: string) => rows.map((r) => iso(r[k])).filter(Boolean).sort().at(-1) ?? null;

  /** The rule the gateway uses (src/keyvault.ts useCredential, useVertexCredential): set, and why not. */
  const judge = (p: any): { set: "yes" | "no"; note: string | null } => {
    const ks = mine(p.slug), en = ks.filter((c) => c.enabled);
    if (!p.enabled) return { set: "no", note: "provider turned off" + (ks.length ? ` (${ks.length} key${ks.length > 1 ? "s" : ""} kept)` : "") };
    if (p.backend === "vertex") {
      const via = p.credential_provider && p.credential_provider !== "vertex" ? on(p.credential_provider, "vertex")
        : on(p.slug, "vertex") || on("vertex");
      return via ? { set: "yes", note: "through Vertex AI (a service-account key)" }
                 : { set: "no", note: "set to run on Vertex AI, which has no service-account key" };
    }
    if (en.length) return { set: "yes", note: null };
    return { set: "no", note: ks.length ? `${ks.length} key${ks.length > 1 ? "s" : ""}, all turned off` : null };
  };

  const list: ProviderStatus[] = [];
  for (const p of providers) {
    const ks = mine(p.slug);
    list.push({ slug: p.slug, name: providerName(p.slug), category: providerCategory(p.slug), enabled: !!p.enabled, backend: p.backend ?? "direct",
                ...judge(p), keys: ks.length, enabled_keys: ks.filter((c) => c.enabled).length,
                last_changed_at: latest(ks, "changed_at"), last_used_at: latest(ks, "last_used_at"),
                in_build: await providerInBuild(p.slug, ks.length) });
  }
  // The GitHub App's settings are one sealed entry of their own section, not a key (the key vault page leaves it out).
  const shown = list.filter((p) => p.slug !== "github_app" && (opts.all || p.in_build));

  const rn = await runNeeds();
  const bySlug = new Map(list.map((p) => [p.slug, p]));
  const needs = rn.needs.map((n) => {
    const p = bySlug.get(n.slug);
    const why = [n.sandbox ? "the runs' sandboxes" : "", n.kinds.length ? `${n.kinds.length} run kind${n.kinds.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
    let set: "yes" | "no" = p ? p.set : "no", note = p ? p.note : "no such provider in the vault";
    let missing_labels: string[] | undefined;
    if (n.slug === "pack_credentials" && n.labels) {
      missing_labels = p?.enabled ? n.labels.filter((l) => !on("pack_credentials", l)) : [...n.labels];
      set = missing_labels.length ? "no" : "yes";
      if (missing_labels.length) note = `not set: ${missing_labels.join(", ")}`;
    }
    return { slug: n.slug, name: providerName(n.slug), category: providerCategory(n.slug), set, note, why, kinds: n.kinds,
             ...(n.labels ? { labels: n.labels, missing_labels } : {}) };
  });

  const queued = (await q(`SELECT to_regclass('runs') IS NOT NULL AS runs, to_regclass('run_events') IS NOT NULL AS events`))[0];
  let qd: VaultStatus["queued"] = null;
  if (queued?.runs) {
    const [c] = await q(`/* tenant: internal: the platform operator's read-only vault report counts queued runs across every workspace (no row leaves this report) */ SELECT count(*)::int AS n, min(created_at) AS oldest FROM runs WHERE status = 'queued'`);
    const by = await q(`/* tenant: internal: the platform operator's read-only vault report counts queued runs across every workspace (no row leaves this report) */ SELECT pack, kind, count(*)::int AS n FROM runs WHERE status = 'queued' GROUP BY pack, kind ORDER BY n DESC, pack, kind LIMIT 10`);
    const [w] = queued.events ? await q(
      `/* tenant: internal: the platform operator's read-only vault report counts queued runs across every workspace (no row leaves this report) */ SELECT e.data->>'reason' AS reason, e.at, r.pack, r.kind FROM run_events e JOIN runs r ON r.id = e.run_id
        WHERE r.status = 'queued' AND e.type = 'waiting' ORDER BY e.id DESC LIMIT 1`) : [];
    qd = { count: Number(c?.n ?? 0), oldest_at: iso(c?.oldest), by_kind: by.map((b) => ({ pack: b.pack, kind: b.kind, count: Number(b.n) })),
           latest_waiting: w ? { reason: String(w.reason ?? "").slice(0, 500), at: iso(w.at)!, pack: w.pack, kind: w.kind } : null };
  }
  return {
    read_only: true,
    providers: shown,
    hidden: list.filter((p) => !shown.includes(p) && p.slug !== "github_app").map((p) => p.slug),
    runs: { kinds: rn.kinds, packs: rn.packs, sandbox_mode: rn.sandbox_mode, sandbox_mode_from: sandboxModeSet() ? "deployment" : "default",
            boat_for_runs: rn.boat_for_runs, needs, missing: needs.filter((n) => n.set === "no").map((n) => n.slug) },
    queued: qd,
  };
}

const when = (s: string | null) => (s ? s.replace("T", " ").replace(/:\d\d\.\d+Z$/, " UTC") : "-");
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** The report for a person: plain lines, never a value. */
export function formatVaultStatus(r: VaultStatus): string {
  const out: string[] = [];
  out.push("Key vault (read in one READ ONLY transaction, rolled back; no key, nor any part, length or digest of one, is read):");
  const w = Math.max(8, ...r.providers.map((p) => `${p.name} (${p.slug})`.length)) + 2;
  out.push("  " + pad("Provider", w) + pad("Category", 16) + pad("Key set", 9) + pad("Keys", 6) + "Last changed");
  for (const p of r.providers)
    out.push("  " + pad(`${p.name} (${p.slug})`, w) + pad(p.category, 16) + pad(p.set, 9) + pad(`${p.enabled_keys}/${p.keys}`, 6) + when(p.last_changed_at)
             + (p.note ? `  (${p.note})` : ""));
  if (r.hidden.length) out.push(`  (${r.hidden.length} more provider(s) nothing in this build reads, without a key: ${r.hidden.join(", ")}; --all lists them)`);
  out.push("  Keys = turned on / stored. Last changed = when a key was last stored or replaced.");
  out.push("");
  const rn = r.runs;
  out.push(`Runs: ${rn.kinds} run kind(s)${rn.packs.length ? ` (pack ${rn.packs.join(", ")})` : ""}; sandbox mode ${rn.sandbox_mode} (${rn.sandbox_mode_from === "deployment" ? "the deployment's APP_RUN_SANDBOX" : "the default: APP_RUN_SANDBOX was not handed to this run"})`
           + `, so the runs' sandboxes ${rn.boat_for_runs ? "come from boat.dev" : "do not come from boat.dev"}.`);
  if (!rn.needs.length) out.push("  The runs need no key from the vault.");
  for (const n of rn.needs) {
    const ks = n.kinds.length > 4 ? `${n.kinds.slice(0, 4).join(", ")} and ${n.kinds.length - 4} more` : n.kinds.join(", ");
    out.push(`  needs ${n.name} (${n.slug}) for ${n.why}${ks ? ` (${ks})` : ""}: ${n.set === "yes" ? "set" : "MISSING"}${n.note ? ` (${n.note})` : ""}`);
  }
  out.push(rn.missing.length
    ? `Missing for the runs: ${rn.missing.join(", ")}. A platform owner adds each on the console's /admin, Key vault page.`
    : rn.needs.length ? "Every provider the runs need has a key." : "");
  out.push("");
  if (!r.queued) out.push("Queued runs: this database has no runs table.");
  else {
    const qd = r.queued;
    out.push(`Queued runs: ${qd.count}${qd.count ? ` (oldest queued ${when(qd.oldest_at)})` : ""}`);
    for (const b of qd.by_kind) out.push(`  ${b.pack}.${b.kind}: ${b.count}`);
    if (qd.latest_waiting) out.push(`  latest reason given for waiting (${when(qd.latest_waiting.at)}, ${qd.latest_waiting.pack}.${qd.latest_waiting.kind}): ${qd.latest_waiting.reason}`);
    else if (qd.count) out.push("  no reason for waiting was recorded on them yet");
  }
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trimEnd();
}

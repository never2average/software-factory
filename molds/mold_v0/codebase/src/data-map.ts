/**
 * The data-flow and residency statement (mold_v0-050): where this build's code runs, where its data is stored, which
 * credentials exist (names only), where model calls go and which hosts runs may reach, per pack. Two sources, kept
 * apart so a reader knows how each line is known:
 *
 *   declared  what the build's packs declare (job kinds, their egress, providers and credentials; credential fields;
 *             record areas; repositories; upstream pins) and what the shell itself does with them (this file says so in
 *             words that follow the code: src/runs.ts runEgressHosts, src/credentials.ts, src/workspace-store.ts, ...)
 *   deploy    the facts the factory writes into the build copy from the app's state before the generators run
 *             (deploy-facts.json at the codebase root, checked and copied by scripts/gen-packs.mjs into
 *             src/deploy-facts.generated.ts): the target, its projects or server, the database and object store
 *             providers, the secret store and the secret NAMES. A codebase not built by the factory has none, and says so
 *
 * `dataMap()` is written as DATA-MAP.md into the build copy (scripts/data-map.ts, run by the factory's generators). The
 * console has no page for it (operator decision, mold_v0-099: an About page is not part of the mold).
 * Nothing here returns or logs a secret value: credential fields, platform secrets and vault keys appear by name only.
 */
import { DEPLOY_FACTS } from "./deploy-facts.generated.js";
import { packs, type InstalledPack } from "./packs.js";
import { PROFILE, type Profile } from "./profile.js";
import { hasSourceSection, LICENSOR_EXCEPTION_TEXT, sourceOffer, type SourceOffer, type SourceOfferSetting } from "./source-offer.js";

/** deploy-facts.json, as scripts/gen-packs.mjs checks it (names, places and providers; never a value). */
export interface DeployFacts {
  app_id: string;
  target: "vercel" | "compose_remote";
  /** Where these facts were read: the app's state files, named. */
  source: string;
  vercel?: { team?: string | null; api_project?: string | null; web_project?: string | null; production_url?: string | null; api_url?: string | null; function_region?: string | null };
  server?: { provider?: string | null; host?: string | null; domain?: string | null; region?: string | null; compose_project?: string | null };
  database: { provider: string; exposure?: string | null; resource?: string | null; region?: string | null };
  object_store: { provider: string; bucket?: string | null; region?: string | null };
  secret_store: string;
  secrets: { required: string[]; optional: string[] };
}

export interface DataMapRow { item: string; detail: string }
export interface DataMapSection { id: string; title: string; intro?: string; rows: DataMapRow[] }
export interface DataMap { name: string; deploy: DeployFacts | null; sections: DataMapSection[] }

/** The build's source offer: its packs' upstreams and the profile's own (src/source-offer.ts). */
export const currentOffer = (list: readonly InstalledPack[] = packs(), profile: Profile = PROFILE): SourceOffer =>
  sourceOffer(list, profile === PROFILE && testOffer !== undefined ? testOffer ?? undefined : profile.source_offer);
let testOffer: SourceOfferSetting | null | undefined;
/** Tests only: the build's profile `source_offer` as if profile.json said this (undefined: the profile's own). */
export function setSourceOfferForTest(s: SourceOfferSetting | null | undefined) { testOffer = s; }

/** Where each gateway provider forwards by default (sql/migrations/0001_baseline.sql vault_providers): the vault may change it. */
const DEFAULT_UPSTREAM: Record<string, string> = {
  anthropic: "api.anthropic.com", openai: "api.openai.com", google: "generativelanguage.googleapis.com", dashscope: "dashscope-intl.aliyuncs.com",
};
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return u; } };
const list = (xs: readonly string[]) => (xs.length ? xs.join(", ") : "none");
const code = (s: string) => `\`${s}\``;

const TARGET_WORDS: Record<string, string> = { vercel: "Vercel", compose_remote: "a server of the app's own (Docker Compose)" };
const DB_WORDS: Record<string, string> = {
  neon: "Neon Postgres (provisioned through Vercel's Neon integration)", supabase: "Supabase Postgres", rds: "Amazon RDS Postgres",
  self_hosted: "a Postgres server of the operator's", compose: "the stack's own Postgres container, on the stack's private network (no published port)",
};
const STORE_WORDS: Record<string, string> = { none: "none configured by the factory", r2: "Cloudflare R2", s3: "an S3-compatible bucket", vercel_blob: "Vercel Blob", gcs: "Google Cloud Storage", azure_blob: "Azure Blob Storage", fs: "a directory on the server" };

/** The statement from the build's declarations and its deploy facts (no I/O). */
export function dataMap(list_: readonly InstalledPack[] = packs(), facts: DeployFacts | null = DEPLOY_FACTS as DeployFacts | null, profile: Profile = PROFILE): DataMap {
  const sections: DataMapSection[] = [];
  const agentKinds = list_.flatMap((p) => (p.definition.agentJobKinds ?? []).map((k) => ({ pack: p, k })));
  const harnessKinds = list_.flatMap((p) => (p.definition.jobKinds ?? []).map((k) => ({ pack: p, k })));
  const priv = (k: unknown) => (k as { private_network?: boolean }).private_network === true;
  const kinds = [...agentKinds.map(({ pack, k }) => ({ pack, name: k.name, label: k.label ?? k.name, egress: k.egress ?? [], providers: k.providers ?? [], credentials: k.credentials ?? [], private_network: priv(k) })),
    ...harnessKinds.map(({ pack, k }) => ({ pack, name: k.name, label: k.label ?? k.name, egress: k.egress ?? [], providers: k.providers ?? [], credentials: k.credentials ?? [], private_network: priv(k) }))];

  // ---------- where the code runs ----------
  {
    const rows: DataMapRow[] = [];
    if (!facts) rows.push({ item: "This copy", detail: "carries no deploy facts (no deploy-facts.json was written into it), so where it runs is not stated here." });
    else if (facts.target === "vercel") {
      const v = facts.vercel ?? {};
      rows.push({ item: "API and MCP server", detail: `a Vercel serverless function (api/index.ts) in the Vercel project ${code(v.api_project ?? "?")}${v.team ? ` of the team ${code(v.team)}` : ""}${v.api_url ? `, at ${v.api_url}` : ""}` });
      rows.push({ item: "Console", detail: `a Next.js app in the Vercel project ${code(v.web_project ?? "?")}${v.production_url ? `, at ${v.production_url}` : ""}` });
      rows.push({ item: "Region", detail: v.function_region ? `the functions' region: ${code(v.function_region)} (from the app's state)` : "not recorded in the factory's state" });
    } else {
      const s = facts.server ?? {};
      rows.push({ item: "API, MCP server, console and database", detail: `one Docker Compose stack${s.compose_project ? ` (project ${code(s.compose_project)})` : ""} on a server of the app's own${s.provider ? ` rented from ${s.provider}` : ""}${s.host ? ` (${s.host})` : ""}${s.domain ? `, served at https://${s.domain}` : ""}` });
      rows.push({ item: "Region", detail: s.region ? code(s.region) : "the server's region is not recorded in the factory's state (it is wherever the server was rented)" });
    }
    if (kinds.length) rows.push({ item: "Runs", detail: "each run of a job kind runs in a sandbox of its own (src/run-sandboxes.ts: the sandbox provider whose key is in the key vault, else a container on the server's own Docker; never without a sandbox unless the operator allows that for tests), as an unprivileged user whose network is limited to the hosts listed under Egress" });
    // mold_v0-036: only in a build with a kind that may need a workspace's private network.
    if (kinds.some((k) => k.private_network)) rows.push({ item: "Runs on premises", detail: `a run of ${kinds.filter((k) => k.private_network).map((k) => code(k.name)).join(", ")} runs on the workspace's own on-premises runner, inside the workspace's own network, when the workspace chose that and enrolled one (src/onprem-runners.ts): in a sandbox of its own there with the same limits, reaching this service over HTTPS (outbound only) for its inputs, credentials and results; otherwise it runs as every other run` });
    for (const { pack, k } of agentKinds) {
      const strip = k.agent.strip?.length ?? 0;
      rows.push({ item: `Job kind ${code(k.name)} (${pack.manifest.name})`, detail: `runs ${k.agent.repository} at commit ${code(k.agent.commit)}, fetched at exactly that commit for each run (never vendored), the workspace's own files laid over the paths it writes back (${(k.agent.write_back ?? []).join(", ") || "none"})${strip ? `, with ${strip} path${strip === 1 ? "" : "s"} it declares left out of the checkout before it runs` : ""}` });
    }
    for (const { pack, k } of harnessKinds) rows.push({ item: `Job kind ${code(k.name)} (${pack.manifest.name})`, detail: `runs the pack's own program ${code(k.entry)} with node` });
    sections.push({ id: "code", title: "Where the code runs", rows });
  }

  // ---------- where data is stored ----------
  {
    const rows: DataMapRow[] = [];
    const db = facts?.database;
    rows.push({ item: "Database", detail: db ? `${DB_WORDS[db.exposure === "compose_network" ? "compose" : db.provider] ?? db.provider}${db.resource ? ` (resource ${code(db.resource)})` : ""}${db.region ? `, region ${code(db.region)}` : ", region not recorded in the factory's state"}` : "Postgres at the address the server is configured with (DATABASE_URL), else an embedded database on the server's disk" });
    rows.push({ item: "In the database", detail: "workspaces, people, keys (hashed), runs and their results, usage, settings, and every record area's rows; each workspace's rows under row-level security. Workspace credentials and the key vault's provider keys are stored sealed (AES-256-GCM): credentials with the workspace's own data key, provider keys with the vault's master key (APP_VAULT_KEY), never in clear" });
    const areas = list_.flatMap((p) => (p.definition.recordAreas ?? []).map((a) => ({ p, a })));
    for (const p of list_) {
      const own = areas.filter((x) => x.p === p);
      if (!own.length) continue;
      const live = (a: (typeof own)[number]["a"]) => a.repository && (p.definition.repositories?.[a.repository] as { kind?: string } | undefined)?.kind === "http_api";
      const shared = own.filter((x) => x.a.scope === "platform" && !live(x.a)).map((x) => x.a.label ?? x.a.name);
      const mine = own.filter((x) => x.a.scope !== "platform" && !live(x.a)).map((x) => x.a.label ?? x.a.name);
      const read = own.filter((x) => live(x.a)).map((x) => x.a.label ?? x.a.name);
      rows.push({ item: `Records of ${p.manifest.name}`, detail: `in the database: shared with every workspace: ${list(shared)}; each workspace's own: ${list(mine)}${read.length ? `; read live from an outside API and not stored: ${read.join(", ")}` : ""}` });
    }
    const store = facts?.object_store;
    const usesStore = list_.some((p) => (p.definition.agentJobKinds ?? []).length || (p.definition.jobKinds ?? []).some((k) => k.workspace));
    rows.push({ item: "Object store", detail: `${store ? `${STORE_WORDS[store.provider] ?? store.provider}${store.bucket ? ` (bucket ${code(store.bucket)})` : ""}${store.region ? `, region ${code(store.region)}` : ""} in the factory's state; ` : ""}this server uses Cloudflare R2 when R2_BUCKET, R2_ENDPOINT and its two keys are set, else the bucket a platform owner saved in Key vault › Object storage (sealed in the key vault), else a directory named by APP_STORAGE_DIR${usesStore ? ". It holds each workspace's files between runs (the workspace store), sealed with the workspace's data key" : ""}` });
    sections.push({ id: "data", title: "Where data is stored", rows });
  }

  // ---------- credentials, by name ----------
  {
    const rows: DataMapRow[] = [];
    if (facts) {
      rows.push({ item: "Platform secrets", detail: `kept in ${facts.secret_store === "vercel_env" ? "the Vercel projects' environment variables" : facts.secret_store === "compose_remote_env_file" ? "an env file on the server (root only, mode 600)" : facts.secret_store}: ${list(facts.secrets.required)}` });
      if (facts.secrets.optional.length) rows.push({ item: "Optional platform secrets", detail: `used when set: ${facts.secrets.optional.join(", ")}` });
    } else rows.push({ item: "Platform secrets", detail: "in the server's environment; their names are not stated in a copy without deploy facts" });
    rows.push({ item: "Model provider keys", detail: "in the key vault (the database, sealed); a run never receives one: it gets a short-lived gateway token instead" });
    for (const p of list_) for (const c of p.definition.credentials ?? []) {
      const d = c.deliver_as as { env?: string; file?: string };
      const by = kinds.filter((k) => k.pack === p && k.credentials.includes(c.name)).map((k) => code(k.name));
      const repos = Object.entries(p.definition.repositories ?? {}).filter(([, r]) => (r as { credential?: string }).credential === c.name).map(([n]) => code(n));
      rows.push({ item: `${c.label} (${code(c.name)}, ${p.manifest.name})`, detail: `given by each workspace, one per ${c.bound_to === "workspace" ? "workspace" : c.bound_to === "asset" ? `${c.area} record` : `${c.area} record and environment`}; ${by.length ? `delivered only to runs of ${by.join(", ")} that target it, as ${d.env ? `the environment variable ${code(d.env)}` : `the file ${code(d.file ?? "")}`}` : "delivered to no job kind"}${repos.length ? `; sent by this server to the API of ${repos.join(", ")}` : ""}` });
    }
    sections.push({ id: "credentials", title: "Credentials (names only)", rows });
  }

  // ---------- model calls ----------
  {
    const rows: DataMapRow[] = [];
    const providers = [...new Set(kinds.flatMap((k) => k.providers))].sort();
    rows.push({ item: "Gateway", detail: "every model call a run makes goes to this service's inference gateway (/gw/<provider>), which checks the run's token, meters tokens and cost against the run's budget, and forwards the call with a key from the key vault" });
    for (const pr of providers) {
      const by = kinds.filter((k) => k.providers.includes(pr)).map((k) => code(k.name));
      rows.push({ item: `Provider ${code(pr)}`, detail: `used by ${by.join(", ")}; forwarded ${DEFAULT_UPSTREAM[pr] ? `by default to ${DEFAULT_UPSTREAM[pr]}` : "where the key vault says"} (the key vault may send it elsewhere, e.g. Google Cloud Vertex AI in a region)` });
    }
    if (!providers.length) rows.push({ item: "Providers", detail: "no job kind of this build names a model provider" });
    rows.push({ item: "The server's own model calls", detail: "the docs answers in the console, and a pack's code when it asks the shell for one (src/ask-model.ts): sent by this server with a key from the key vault to the first model that answers among GLM on Cloudflare Workers AI, Claude (Anthropic's API, or Claude on Google Cloud Vertex AI) and the orchestrator's OpenAI model; metered, and not through a run's gateway token" });
    sections.push({ id: "models", title: "Where model calls go", rows });
  }

  // ---------- egress ----------
  {
    const rows: DataMapRow[] = [];
    for (const k of kinds) rows.push({ item: `Job kind ${code(k.name)} (${k.pack.manifest.name})`, detail: `HTTPS (port 443) to ${list(k.egress)} and their subdomains, and this service's own gateway host; nothing else (an egress proxy and the sandbox's firewall)${k.private_network ? "; on the workspace's on-premises runner, also the private hosts and networks that runner's owner allows (the workspace's choice, never this service's)" : ""}` });
    for (const p of list_) for (const [n, r] of Object.entries(p.definition.repositories ?? {})) {
      const rr = r as { kind: string; base_url?: string; egress?: string[]; upstream?: { repo: string; commit: string } | string; index?: string };
      if (rr.kind === "http_api") rows.push({ item: `Repository ${code(n)} (${p.manifest.name})`, detail: `this server reads ${hostOf(rr.base_url ?? "")} live (allowed hosts: ${list(rr.egress ?? [])})` });
      if (rr.kind === "upstream_catalog" && typeof rr.upstream === "object") rows.push({ item: `Repository ${code(n)} (${p.manifest.name})`, detail: `this server fetches ${rr.upstream.repo} at commit ${code(rr.upstream.commit)} ${rr.index === "manual" ? "when platform staff index it" : "when it indexes it: by itself at a new pin (mold_v0-128), and when platform staff index it"}` });
    }
    if (!rows.length) rows.push({ item: "Runs", detail: "this build declares no job kind and no outside repository" });
    sections.push({ id: "egress", title: "Egress: the hosts runs and repositories may reach", rows });
  }

  // ---------- source code ----------
  // The source offer's section, unless everything the build runs is the licensor's own (mold_v0-099, hasSourceSection).
  const offer = currentOffer(list_, profile);
  if (hasSourceSection(offer)) sections.push(offerSection(offer));
  return { name: profile.name, deploy: facts, sections };
}

/** The source offer as a section: every upstream (copyleft ones offered), and the app's own source or why not. */
export function offerSection(o: SourceOffer): DataMapSection {
  const rows: DataMapRow[] = o.upstreams.map((u) => ({
    item: `${u.project} (${u.pack_name})`,
    detail: `${u.repo} at commit ${code(u.commit)}, licensed ${u.license ?? "under a licence its pack does not declare"}${u.copyleft ? `: its complete source at that commit is at ${u.url}` : `; source at ${u.url}`}`,
  }));
  if (o.app.kind === "offered") rows.push({ item: "This service", detail: `licensed ${o.app.license}: its source is at ${o.app.url}` });
  else if (o.app.kind === "licensor_exception") rows.push({ item: "This service", detail: LICENSOR_EXCEPTION_TEXT });
  if (!rows.length) rows.push({ item: "Upstream projects", detail: "none: no pack of this build runs or reads a pinned upstream project" });
  return { id: "source", title: "Source code", rows };
}

/** The statement as Markdown (DATA-MAP.md in the build copy). Deterministic: the same build writes the same file. */
export function dataMapMarkdown(m: DataMap): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  const out = [
    `# ${m.name}: data flow and residency`,
    "",
    "Generated by `scripts/data-map.ts` from this build's packs (their pack.json declarations) and the deploy facts the factory wrote from the app's state (deploy-facts.json). Do not edit: rebuild. Secrets appear by name only.",
    "",
  ];
  if (m.deploy) out.push(`Deploy facts: app ${code(m.deploy.app_id)}, target ${TARGET_WORDS[m.deploy.target] ?? m.deploy.target}, read from ${m.deploy.source}.`, "");
  for (const s of m.sections) {
    out.push(`## ${s.title}`, "");
    if (s.intro) out.push(s.intro, "");
    out.push("| | |", "|---|---|", ...s.rows.map((r) => `| ${cell(r.item)} | ${cell(r.detail)} |`), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

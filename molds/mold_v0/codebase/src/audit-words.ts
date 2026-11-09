/**
 * The Access log in plain words (mold_v0-286): who did it (a person's name and email from the sign-in directory, a
 * key's name and its owner's email, "Agent run for <email>", "Staff · <email>", "System"), what was done as one sentence
 * ("Viewed <record> in <Area>", "Listed <Area> (12 rows)", "Signed in", "Used the <tool> tool", "Opened billing"), and
 * the result in words (OK, Refused, Failed, Not found). src/audit-trail.ts adds these to every entry it reads; the
 * console's Access log shows them (web/src/features/audit/access-log.tsx) and keeps the raw fields for its side panel's
 * Technical details.
 *
 * Who may see an email: platform staff see everyone's (the fleet view); a workspace's owners see the people of their own
 * workspace only (its directory's memberships), and staff as "Platform staff" (the pseudonym the trail keeps for them,
 * never their identity). A person outside the workspace is "Someone outside this workspace". People are read through the
 * active sign-in directory (src/people.ts: Clerk or the built-in sign-in), in batches, cached in memory for WHO_TTL_MS.
 */
import { getDb } from "./db.js";
import { asPlatform, withTenant } from "./tenant-scope.js";

export const WHO_TTL_MS = 60_000;
export interface Who { label: string; name: string | null; email: string | null }

// ---------------------------------------------------------------- results and sentences (pure)

/** The result in words: OK, Refused, Failed, Not found. A data entry is written only once it was done: OK. */
export function resultWord(status: number | null | undefined): "OK" | "Refused" | "Failed" | "Not found" {
  if (status === null || status === undefined) return "OK";
  if (status === 404 || status === 410) return "Not found";
  if (status >= 500) return "Failed";
  if (status >= 400) return "Refused";
  return "OK";
}

/** "audit_findings" → "Audit findings"; "list_records" → "list records". */
export const humanize = (s: string) => s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

export interface DataWordsInput { action: string; target: string; area: string | null; record_key: string | null; rows: number | null; title?: string | null; area_label?: string | null }
/** A data entry as one sentence: "Viewed Login bug in Findings", "Listed Findings (12 rows)", "Deleted 3 rows from Findings". */
export function dataSentence(e: DataWordsInput): string {
  const area = e.area_label || (e.area ? cap(humanize(e.area)) : "records");
  const rows = e.rows != null ? ` (${plural(e.rows, "row")})` : "";
  if (e.target === "file") {
    const name = e.record_key ? e.record_key.split("/").filter(Boolean).at(-1) ?? e.record_key : null;
    const store = e.area_label || (e.area ? humanize(e.area) : "files");
    const verbs: Record<string, string> = { list: `Listed the files in ${store}${rows}`, read: `Opened ${name ?? "a file"} in ${store}`, reveal: `Opened ${name ?? "a file"} in ${store}`,
      export: `Downloaded ${name ?? "files"} from ${store}`, create: `Added ${name ?? "a file"} to ${store}`, update: `Changed ${name ?? "a file"} in ${store}`,
      move: `Moved ${name ?? "a file"} in ${store}`, delete: `Deleted ${name ?? "a file"} from ${store}` };
    return verbs[e.action] ?? `${cap(e.action)} ${name ?? "a file"} in ${store}`;
  }
  if (e.target === "run_result") {
    const kind = e.area_label || (e.area ? humanize(e.area) : "agent");
    return e.action === "list" ? `Listed the results of ${kind} runs${rows}` : e.action === "export" ? `Exported the results of a ${kind} run${rows}` : `Viewed the results of a ${kind} run`;
  }
  const what = e.title || e.record_key;
  const many = !what && e.rows != null;
  switch (e.action) {
    case "list": return `Listed ${area}${rows}`;
    case "read": return `Viewed ${what ?? "a record"} in ${area}`;
    case "reveal": return `Viewed ${what ?? "a sealed record"} in ${area} (sealed)`;
    case "export": return `Exported ${area}${rows}`;
    case "create": return many ? `Added ${plural(e.rows!, "row")} to ${area}` : `Added ${what ?? "a record"} to ${area}`;
    case "update": return many ? `Changed ${plural(e.rows!, "row")} in ${area}` : `Changed ${what ?? "a record"} in ${area}`;
    case "move": return many ? `Moved ${plural(e.rows!, "row")} in ${area}` : `Moved ${what ?? "a record"} in ${area}`;
    case "delete": return many ? `Deleted ${plural(e.rows!, "row")} from ${area}` : `Deleted ${what ?? "a record"} from ${area}`;
    default: return `${cap(humanize(e.action))} ${what ?? "records"} in ${area}`;
  }
}

/** The plain name of a page or API, by its path (the common ones; anything else in words from its path). */
const PAGES: [RegExp, string | ((m: RegExpExecArray, label: (a: string) => string) => string)][] = [
  [/^\/api\/app\/me$/, "their account"],
  [/^\/api\/app\/(setup|setup\/test)$/, "the setup page"],
  [/^\/api\/app\/billing(\/.*)?$/, "billing"],
  [/^\/api\/app\/(usage|limits)(\/.*)?$/, "usage and limits"],
  [/^\/api\/app\/team(\/.*)?$/, "the team"],
  [/^\/api\/app\/clients\/[^/]+$/, "the connection guide"],
  [/^\/api\/app\/docs(\/.*)?$/, "the docs assistant"],
  [/^\/api\/app\/access$/, "their access"],
  [/^\/api\/home(\/.*)?$/, "the home page"],
  [/^\/api\/notices(\/.*)?$/, "notices"],
  [/^\/api\/onboarding(\/.*)?$/, "the setup steps"],
  [/^\/api\/audit(\/.*)?$/, "the access log"],
  [/^\/api\/admin\/audit(\/.*)?$/, "the access log"],
  [/^\/api\/keys(\/.*)?$/, "API keys"],
  [/^\/api\/credentials(\/.*)?$/, "credentials"],
  [/^\/api\/credential-connections(\/.*)?$/, "connected accounts"],
  [/^\/api\/teams(\/.*)?$/, "teams"],
  [/^\/api\/usage(\/.*)?$/, "usage"],
  [/^\/api\/runs(\/.*)?$/, "runs"],
  [/^\/api\/schedules(\/.*)?$/, "schedules"],
  [/^\/api\/workspace-files(\/.*)?$/, "files"],
  [/^\/api\/email(\/.*)?$/, "email settings"],
  [/^\/api\/ledger(\/.*)?$/, "the signed ledger"],
  [/^\/api\/(metrics|sparklines)(\/.*)?$/, "key numbers"],
  [/^\/api\/records\/_console\/([^/]+)\/sparklines$/, (m, label) => `${label(m[1]!)} key numbers`],
  [/^\/api\/(records|data)\/_batch$/, "a batch of record changes"],
  [/^\/api\/(?:admin\/)?records\/(?:_page\/)?([a-z0-9_]+)(\/.*)?$/i, (m, label) => label(m[1]!)],
  [/^\/api\/data\/([a-z0-9_]+)(\/.*)?$/i, (m, label) => label(m[1]!)],
  [/^\/api\/developer(\/.*)?$/, "the developer settings"],
  [/^\/api\/auth\/email\/request$/, "a sign-in code"],
  [/^\/api\/auth(\/.*)?$/, "sign-in"],
  [/^\/(oauth\/token|token)$/, "a connected app's sign-in"],
  [/^\/oauth\/(.*)$|^\/register$/, "a connected app's sign-in"],
  [/^\/v1\/([a-z0-9_-]+)(\/.*)?$/i, (m) => `the developer API (${humanize(m[1]!)})`],
  [/^\/api\/admin\/onboarding\/orgs\/([^/]+)(\/.*)?$/, (m) => `the account ${m[1]}`],
  [/^\/api\/admin\/onboarding(\/.*)?$/, "accounts"],
  [/^\/api\/admin\/orgs\/([^/]+)(\/.*)?$/, (m) => `the account ${m[1]}`],
  [/^\/api\/admin\/([a-z0-9-]+)(\/.*)?$/i, (m) => `the staff ${humanize(m[1]!)} page`],
];
/** Segments that are ids, numbers or keys: dropped from a path's name. */
const ID_LIKE = /^(\d+|[0-9a-f]{8,}|[a-z]+_[A-Za-z0-9]{6,}|[0-9a-f-]{32,36}|:.*)$/;
export function pageName(path: string, label: (area: string) => string = (a) => cap(humanize(a))): string {
  for (const [re, name] of PAGES) { const m = re.exec(path); if (m) return typeof name === "string" ? name : name(m, label); }
  const parts = path.split("/").filter((p) => p && p !== "api" && !ID_LIKE.test(p)).map((p) => humanize(decodeURIComponent(p)));
  return parts.length ? parts.slice(0, 3).join(" › ") : "the service";
}

export interface PlatformWordsInput { kind: string; method: string; path: string; status: number | null }
/** A platform entry as one sentence: "Signed in", "Used the list findings tool", "Opened billing", "Called API keys". */
export function platformSentence(e: PlatformWordsInput, label?: (area: string) => string): string {
  const [route, rpc] = e.path.split(" ", 2) as [string, string | undefined];
  if (e.kind === "sign_in") {
    if (/\/email\/verify$/.test(route) && e.status !== null && e.status >= 400) return "Tried to sign in (the code was refused)";
    return /^\/(oauth\/token|token)$/.test(route) ? "Signed in through a connected app" : e.status !== null && e.status >= 400 ? "Tried to sign in" : "Signed in";
  }
  if (e.method === "CHECK") {
    const m = /^\/checks\/(\S+)\s+(allowed|denied)$/.exec(e.path);
    return m ? `Checked ${humanize(m[1]!)}: ${m[2]}` : "Ran a check";
  }
  if (e.method === "SYSTEM" && route.startsWith("/platform-account/")) return `Set up the platform account (${humanize(route.slice("/platform-account/".length))})`;
  if (e.method === "IMPORT") {
    const m = /^\/api\/admin\/records\/([^/]+)\/(\S+)(?:\s+(\w+))?/.exec(e.path);
    return m ? `Imported ${decodeURIComponent(m[2]!)} into ${label ? label(m[1]!) : cap(humanize(m[1]!))}${m[3] && m[3] !== "create" ? ` (${humanize(m[3])})` : ""}` : "Imported a row";
  }
  if (e.method === "MCP" && route.startsWith("/admin/mcp/")) return `Used the ${humanize(route.slice("/admin/mcp/".length))} staff tool`;
  if (route === "/mcp" || route.startsWith("/mcp/") || /^\/(api\/)?admin\/mcp(\/|$)/.test(route)) {
    const calls = (rpc ?? "").split(",").filter(Boolean);
    const tools = calls.filter((c) => c.startsWith("tools/call:")).map((c) => humanize(c.slice("tools/call:".length)));
    if (tools.length === 1) return `Used the ${tools[0]} tool`;
    if (tools.length > 1) return `Used ${tools.length} tools (${tools.join(", ")})`;
    if (calls.includes("tools/list")) return "Listed the available tools";
    if (calls.some((c) => c === "resources/list" || c === "resources/read")) return "Read the tools' resources";
    if (calls.some((c) => c === "prompts/list" || c === "prompts/get")) return "Read the slash commands";
    return "Checked the connection"; // initialize, ping, notifications, a GET of the stream
  }
  const name = pageName(route, label);
  if (e.method === "GET" || e.method === "HEAD") return `Opened ${name}`;
  if (e.method === "DELETE") return `Deleted something in ${name}`;
  if (e.method === "PUT" || e.method === "PATCH") return `Changed ${name}`;
  return `Called ${name}`;
}

// ---------------------------------------------------------------- who (the directory, batched and cached)

export interface WhoInput { actor_kind: string; actor_id: string | null; key_id: number | null; key_prefix?: string | null }
interface Person { name: string | null; email: string | null }
const personLabel = (p: Person | null | undefined) => (p ? (p.name && p.email ? `${p.name} · ${p.email}` : p.email ?? p.name) : null);

const people = new Map<string, { at: number; p: Person | null }>();
const orgPeople = new Map<number, { at: number; byId: Map<string, Person> }>();
/** Tests only: forget what was read from the directory. */
export function clearWhoCache() { people.clear(); orgPeople.clear(); }

/** Staff's fleet view: anyone, by id, through the active sign-in directory (each id once per WHO_TTL_MS). */
async function personById(ids: string[]): Promise<Map<string, Person | null>> {
  const out = new Map<string, Person | null>(), want: string[] = [];
  for (const id of new Set(ids)) { const hit = people.get(id); if (hit && Date.now() - hit.at < WHO_TTL_MS) out.set(id, hit.p); else want.push(id); }
  if (!want.length) return out;
  const { people: dir } = await import("./people.js");
  const d = dir();
  const { primaryEmail, displayName } = await import("./clerk.js");
  if (d.provider === "builtin") {
    // One query for the page's people (the built-in directory is this database's own table).
    const rows = await asPlatform(async () => (await getDb()).query<{ id: string; email: string; first_name: string | null; last_name: string | null }>(
      "/* platform: the access log's people, by id (staff view) */ SELECT id, email, first_name, last_name FROM auth_users WHERE id = ANY ($1::text[])", [want]));
    const byId = new Map(rows.map((r) => [r.id, { name: displayName(r), email: r.email?.toLowerCase() ?? null }]));
    for (const id of want) { const p = byId.get(id) ?? null; people.set(id, { at: Date.now(), p }); out.set(id, p); }
    return out;
  }
  // Clerk: one call per person not cached yet, eight at a time.
  for (let i = 0; i < want.length; i += 8) {
    await Promise.all(want.slice(i, i + 8).map(async (id) => {
      let p: Person | null = null;
      try { const u = await d.users.get(id); p = { name: displayName(u), email: primaryEmail(u).email }; } catch { p = null; }
      people.set(id, { at: Date.now(), p });
      out.set(id, p);
    }));
  }
  return out;
}
/** A workspace's own people (its directory's memberships), for its owners' view: nobody outside it. */
async function workspacePeople(orgId: number): Promise<Map<string, Person>> {
  const hit = orgPeople.get(orgId);
  if (hit && Date.now() - hit.at < WHO_TTL_MS) return hit.byId;
  const byId = new Map<string, Person>();
  const [o] = await asPlatform(async () => (await getDb()).query<{ dir: string | null }>("SELECT clerk_org_id AS dir FROM organizations WHERE id = $1", [orgId]));
  if (o?.dir) {
    try {
      const { people: dir } = await import("./people.js");
      const { displayName } = await import("./clerk.js");
      for (const m of await dir().memberships.list(o.dir)) {
        const u = m.public_user_data;
        if (u?.user_id) byId.set(u.user_id, { name: displayName(u), email: u.identifier?.toLowerCase() ?? null });
      }
    } catch (e) { console.error(`access log: the workspace's people could not be read (${(e as Error).message})`); }
  }
  orgPeople.set(orgId, { at: Date.now(), byId });
  return byId;
}

interface KeyRow { id: number; label: string; user_id: string | null; key_prefix: string }
interface RunRow { id: string; requested_by: string | null }

/**
 * Who did each entry, in words, for the person reading (`view`: a workspace's owners, or staff's fleet view). Batched:
 * one read of the keys, one of the runs and one of the directory per page; people cached for WHO_TTL_MS.
 */
export async function resolveWho<T extends WhoInput & { org_id?: number | null }>(entries: T[], view: { orgId: number | null }): Promise<Who[]> {
  const fleet = view.orgId === null;
  const keyIds = [...new Set(entries.map((e) => e.key_id).filter((k): k is number => k != null))];
  const runIds = [...new Set(entries.filter((e) => e.actor_kind === "agent_run" && e.actor_id).map((e) => e.actor_id!))];
  const read = async <R>(sql: string, params: unknown[]): Promise<R[]> => fleet
    ? asPlatform(async () => (await getDb()).query<any>(`/* tenant: the access log's keys and runs, staff's fleet view */ ${sql}`, params))
    : withTenant(view.orgId!, async () => (await getDb()).query<any>(sql, params));
  const keys = new Map<number, KeyRow>((keyIds.length ? await read<KeyRow>(`SELECT id, label, user_id, key_prefix FROM api_keys WHERE id = ANY ($1::int[])${fleet ? "" : " AND org_id = $2"}`,
    fleet ? [keyIds] : [keyIds, view.orgId]).catch(() => []) : []).map((k) => [Number(k.id), k]));
  const runs = new Map<string, RunRow>((runIds.length ? await read<RunRow>(`SELECT id, requested_by FROM runs WHERE id = ANY ($1::text[])${fleet ? "" : " AND org_id = $2"}`,
    fleet ? [runIds] : [runIds, view.orgId]).catch(() => []) : []).map((r) => [r.id, r]));
  const userIds = new Set<string>();
  for (const e of entries) {
    if (e.actor_kind === "user" && e.actor_id) userIds.add(e.actor_id);
    const k = e.key_id != null ? keys.get(e.key_id) : undefined;
    if (k?.user_id) userIds.add(k.user_id);
    if (e.actor_kind === "agent_run" && e.actor_id) { const by = runs.get(e.actor_id)?.requested_by; if (by) userIds.add(by); }
    if (fleet && e.actor_kind === "staff" && e.actor_id && !e.actor_id.includes("@") && !e.actor_id.startsWith("staff:") && !e.actor_id.startsWith("token:")) userIds.add(e.actor_id);
  }
  let person: (id: string) => Person | null | undefined;
  if (fleet) {
    const found = userIds.size ? await personById([...userIds]).catch(() => new Map<string, Person | null>()) : new Map<string, Person | null>();
    person = (id) => found.get(id);
  } else {
    const mine = userIds.size ? await workspacePeople(view.orgId!) : new Map<string, Person>();
    person = (id) => mine.get(id) ?? null;
  }
  return entries.map((e): Who => {
    const k = e.key_id != null ? keys.get(e.key_id) : undefined;
    switch (e.actor_kind) {
      case "system": return { label: "System", name: null, email: null };
      case "user": {
        const p = e.actor_id ? person(e.actor_id) : null;
        if (p) return { label: personLabel(p)!, name: p.name, email: p.email };
        return { label: fleet ? "A person no longer in the directory" : "Someone outside this workspace", name: null, email: null };
      }
      case "key": {
        const name = k ? `Key “${k.label}”` : e.key_prefix ? `Key ${e.key_prefix}` : "An API key";
        const owner = k?.user_id ? person(k.user_id) : null;
        return owner?.email ? { label: `${name} · ${owner.email}`, name, email: owner.email } : { label: k && !k.user_id ? `${name} (the workspace's key)` : name, name, email: null };
      }
      case "agent_run": {
        const by = e.actor_id ? runs.get(e.actor_id)?.requested_by : null;
        const p = by ? person(by) : null;
        return p?.email ? { label: `Agent run for ${p.email}`, name: p.name, email: p.email } : { label: "Agent run", name: null, email: null };
      }
      case "staff": {
        if (!fleet) return { label: "Platform staff", name: null, email: null };
        const id = e.actor_id ?? "";
        if (id.includes("@")) return { label: `Staff · ${id.toLowerCase()}`, name: null, email: id.toLowerCase() };
        if (id.startsWith("token:")) return { label: `Staff (the ${id.slice(6)} token)`, name: null, email: null };
        if (id.startsWith("staff:")) return { label: "Staff", name: null, email: null };
        const p = id ? person(id) : null;
        return p?.email ? { label: `Staff · ${p.email}`, name: p.name, email: p.email } : { label: "Staff", name: null, email: null };
      }
      default: return { label: humanize(e.actor_kind), name: null, email: null };
    }
  });
}

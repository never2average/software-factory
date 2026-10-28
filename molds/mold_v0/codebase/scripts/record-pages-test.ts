// The admin pages' words that come from the build (mold_v0-170), offline and without a browser:
//   npm run test:record-pages
//   1. A record area's empty state (web/src/features/records/empty.ts): titled by the area's label, never its raw key
//      pattern; for staff, where its rows come from (an upstream catalog: its name and repository, what to press, the
//      admin MCP's sync tool; an index running or failed is said so), with Data repositories as the way to fill it; for a
//      customer, no staff page.
//   2. The staff guide (web/src/content/staff-guide.ts): with no doc of the shell's or the packs' in the Guides group, the
//      admin Docs open on "<product> staff guide", written from the build: the product's name, the sidebar's pages in
//      their order, each with what it is for, linked to its address; no source path, no ticket number. A doc that is a
//      guide (a pack's staff_docs beta guide) takes its place.
//   3. A shared area's samples (src/pack-api.ts RecordAreaSchema): for the lanes only, shared (platform) areas only, each
//      key once, each data key a declared field.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The console's modules by path (as scripts/status-pages-test.ts loads them): the server's typecheck never reads web/.
const WEB = path.resolve(import.meta.dirname, "..", "web", "src");
const web = (rel: string) => import(pathToFileURL(path.join(WEB, rel)).href);

const ok = (m: string) => console.log(`✓ ${m}`);

// 1. Empty states.
const { recordEmptyText, repoOf, REPOSITORIES_URL } = await web("features/records/empty.ts");
const area = { label: "Library", scope: "platform" as const };
const catalog = { name: "lib_catalogs", kind: "upstream_catalog", index: "automatic" as const, upstream: { repo: "example/lib", commit: "abc" },
  state: { indexing: false, current: false, last_error: null, pin: null }, area_rows: [{ name: "library" }] };
const e1 = recordEmptyText(area, "admin", catalog);
assert.equal(e1.title, "No records in Library yet");
assert.match(e1.text, /an upstream catalog, example\/lib \(data repository lib_catalogs\)/);
assert.match(e1.text, /press Index now/);
assert.match(e1.text, /admin_sync_lib_catalogs/);
assert.deepEqual(e1.cta, { label: "Open Data repositories", href: REPOSITORIES_URL });
assert.doesNotMatch(e1.text, /</, "no raw key pattern or markup");
assert.match(recordEmptyText(area, "admin", { ...catalog, state: { ...catalog.state, indexing: true } }).text, /An index is running now/);
assert.match(recordEmptyText(area, "admin", { ...catalog, state: { ...catalog.state, last_error: "pin not found" } }).text, /The last index failed: pin not found/);
assert.match(recordEmptyText(area, "admin", { ...catalog, index: "manual" }).text, /indexed by hand/);
assert.match(recordEmptyText(area, "admin", { name: "files", kind: "workspace_files" }).text, /files repository: each workspace's files/);
const none = recordEmptyText(area, "admin", null);
assert.equal(none.cta, null);
assert.match(none.text, /admin MCP server and the data API/);
const app = recordEmptyText(area, "app", catalog);
assert.equal(app.cta, null, "a customer is never sent to a staff page");
assert.match(app.text, /shared by every workspace/);
assert.equal(repoOf("library", [catalog])?.name, "lib_catalogs");
assert.equal(repoOf("other", [catalog]), null);
ok("a record area's empty state: its label, where its rows come from and how staff fill it now; customers get no staff link");

// 2. The staff guide, in this build (the mold's own: no pack, the neutral profile, the shell's docs, none a guide).
const g = await web("content/staff-guide.ts");
const { ADMIN_DOCS } = await web("content/admin-docs.generated.ts");
assert.equal(g.staffGuideShown, !ADMIN_DOCS.some((d: { group: string; slug: string }) => g.adminDocGroup(d) === "Guides"));
assert.equal(g.adminDocGroup({ group: "", slug: "beta-guide" }), "Guides");
assert.equal(g.adminDocGroup({ group: "", slug: "budget-rules-spec" }), "Specs");
assert.equal(g.adminDocGroup({ group: "case-studies", slug: "case-studies-x" }), "Case studies");
assert.equal(g.adminDocGroup({ group: "", slug: "accounts" }), "Architecture");
const nav = [
  { label: "Onboarding", items: [{ title: "Overview", url: "/admin" }, { title: "Access requests", url: "/admin/requests" }, { title: "Accounts", url: "/admin/accounts" }] },
  { label: "Operations", items: [{ title: "Key vault", url: "/admin/keys" }, { title: "A pack page", url: "/admin/packs/p/x" }] },
];
const { title, markdown } = g.staffGuideMarkdown(nav);
const { profile } = await web("config/profile.generated.ts");
assert.equal(title, `${profile.name} staff guide`);
assert.ok(markdown.startsWith(`# ${title}\n`));
for (const h of [`## What ${profile.name} does`, "## Letting people in", "## The console, page by page", "## Every day"]) assert.ok(markdown.includes(h), h);
const table = markdown.slice(markdown.indexOf("| Page |"));
assert.deepEqual([...table.matchAll(/^\| \[([^\]]+)\]\(([^)]+)\)/gm)].map((m) => `${m[1]} ${m[2]}`),
  ["Overview /admin", "Access requests /admin/requests", "Accounts /admin/accounts", "Key vault /admin/keys", "A pack page /admin/packs/p/x"]);
assert.match(table, /\| \[A pack page\]\(\/admin\/packs\/p\/x\) \| The product's own page, under Operations\. \|/);
assert.doesNotMatch(markdown, /src\/|\.ts\b|mold_v\d|ticket/i, "no source path or ticket number");
assert.doesNotMatch(markdown, /\{[a-z_]+\}/i, "every word placeholder filled");
ok(`the staff guide: "${title}", the sidebar's ${nav.flatMap((x) => x.items).length} pages in order with what each is for; no source path or ticket`);

// 3. Samples.
const { RecordAreaSchema } = await import("../src/pack-api.js");
const base = { name: "library", label: "Library", role: "source", scope: "platform", fields: [{ name: "code", label: "Code", type: "text" }] };
const parsed = RecordAreaSchema.safeParse({ ...base, samples: [{ key: "a-1", title: "A", data: { code: "x" } }] });
assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
const issues = (x: unknown) => { const r = RecordAreaSchema.safeParse(x); return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`); };
assert.match(issues({ ...base, scope: "workspace", samples: [{ key: "a", data: {} }] }).join("\n"), /samples: samples are for a shared \(platform\) area/);
assert.match(issues({ ...base, samples: [{ key: "a", data: { nope: 1 } }] }).join("\n"), /samples\.0\.data\.nope: nope is not one of the area's fields/);
assert.match(issues({ ...base, samples: [{ key: "a", data: {} }, { key: "a", data: {} }] }).join("\n"), /samples\.1\.key: sample a is declared twice/);
assert.ok(issues({ ...base, samples: [{ key: "../x", data: {} }] }).some((i) => i.startsWith("samples.0.key")));
ok("samples: shared areas only, each key once and a record key, each data key a declared field");

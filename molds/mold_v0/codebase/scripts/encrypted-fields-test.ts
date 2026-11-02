// Encrypted fields (mold_v0-194; src/encrypted-fields.ts, src/encrypted-fields-migration.ts), offline: an embedded
// database, the stand-in Clerk, a local webhook receiver, and the embedded fixture (scripts/fixtures/packs/
// fixture_embedded) with two more workspace areas: `contacts` (three encrypted fields: one searchable by equality, one
// revealed to owners only) and `vault_notes` (a sealed area with a searchable encrypted field).
//   npm run test:encrypted-fields
//
//  1. The declaration: what may be encrypted, where, and what may then name it (schema, build checks, the spec's brief
//     lines are tested in the factory's own tests).
//  2. Round trip: written through the data API, stored as envelopes bound to their record and field, read back masked,
//     revealed exactly; the mask or a left-out field keeps the value, null clears it, an envelope as input is refused.
//  3. Never shown: the values appear in no list, record page, export, MCP tool answer, developer API answer, webhook
//     delivery, data trail entry or log line (every output grepped).
//  4. Reveal: role-gated by reveal_roles (and the default, the area's update roles), audited as a `reveal` entry.
//  5. The blind index: equality finds the record (also in a sealed area), every other operator and a sort are refused;
//     the index of one value differs between workspaces.
//  6. Key rotation: a new vault key re-wraps the workspaces' data keys; no field's ciphertext changes, and every value
//     still reveals.
//  7. Tenant isolation: another workspace never reads, finds or reveals them; a value moved to its row does not open.
//  8. The migration: rows written before a field was encrypted are sealed by the scheduler's pass in batches,
//     idempotently and resumably; a field no longer encrypted is opened back.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";
import { installEmbedded } from "./lib/embedded-fixture.js";

process.env.APP_PREVIEW = "1"; // a local webhook receiver (a preview server's rule)

// Everything the process prints is kept: no value may reach a log.
let printed = "";
for (const s of [process.stdout, process.stderr]) {
  const w = s.write.bind(s);
  (s as any).write = (chunk: any, ...rest: any[]) => { printed += String(chunk); return w(chunk, ...rest); };
}
let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };

const REF = `REF-${randomBytes(4).toString("hex")}-PLAINVALUE`, PIN = 739104, MEMO = `memo-${randomBytes(4).toString("hex")}-PLAINVALUE`, CODE = `code-${randomBytes(4).toString("hex")}-PLAINVALUE`;
const SECRETS = [REF, String(PIN), MEMO, CODE];
const leaks = (s: string) => SECRETS.filter((x) => s.includes(x));

const CONTACTS = {
  name: "contacts", label: "Contacts", role: "source", scope: "workspace", list_columns: ["name", "ref", "tier"],
  fields: [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "ref", label: "Reference", type: "text", encrypted: true, searchable: "equality", required: true },
    { name: "pin", label: "PIN", type: "number", encrypted: true, reveal_roles: ["owner"] },
    { name: "memo", label: "Memo", type: "text", encrypted: true },
    { name: "tier", label: "Tier", type: "enum", options: ["gold", "silver"] },
  ],
};
const NOTES = {
  name: "vault_notes", label: "Vault notes", role: "source", scope: "workspace", sealed: true,
  fields: [{ name: "body", label: "Body", type: "text" }, { name: "code", label: "Code", type: "text", encrypted: true, searchable: "equality" }],
};
const withAreas = (areas: unknown[]) => (j: any) => { j.record_areas.push(...areas); };

async function receiver() {
  const got: { headers: IncomingMessage["headers"]; body: string }[] = [];
  const srv = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push({ headers: req.headers, body: b }); res.writeHead(200).end("ok"); }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, got, close: () => srv.close() };
}

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { createOrg } = await import("../src/auth.js");
  const { withTenant, asPlatform } = await import("../src/tenant-scope.js");
  const audit = await import("../src/audit-trail.js");
  const { RecordAreaSchema, JobKindSchema } = await import("../src/pack-api.js");
  const { encryptedFieldProblems, ENCRYPTED_MASK, isEnvelope, BLIND_PREFIX, FIELDS_TAG } = await import("../src/encrypted-fields.js");

  // ---------- 1. the declaration ----------
  {
    assert.ok(RecordAreaSchema.safeParse(CONTACTS).success && RecordAreaSchema.safeParse(NOTES).success, "the fixture's areas are valid");
    const refused = (area: unknown, want: RegExp) => {
      const r = RecordAreaSchema.safeParse(area);
      assert.ok(!r.success, `refused: ${JSON.stringify(area).slice(0, 120)}`);
      assert.match(JSON.stringify(r.error.issues), want);
    };
    const f = (x: object) => ({ ...CONTACTS, fields: [...CONTACTS.fields, x] });
    refused({ ...CONTACTS, scope: "platform", list_columns: undefined }, /encrypted is for a workspace area/);
    refused(f({ name: "other", label: "O", type: "reference", to: "contacts", encrypted: true }), /an encrypted field is text, number/);
    refused(f({ name: "who", label: "W", type: "person", encrypted: true }), /an encrypted field is text, number/);
    refused(f({ name: "x", label: "X", type: "text", searchable: "equality" }), /searchable is for an encrypted field/);
    refused(f({ name: "x", label: "X", type: "text", reveal_roles: ["owner"] }), /reveal_roles is for an encrypted field/);
    refused(f({ name: "x", label: "X", type: "text", encrypted: true, searchable: "prefix" }), /searchable/);
    refused({ ...CONTACTS, fields: [...CONTACTS.fields.slice(0, 4), { name: "tier", label: "Tier", type: "enum", options: ["gold", "silver"], encrypted: true }],
      lifecycle: { field: "tier", initial: "gold", transitions: [{ from: ["gold"], to: "silver" }] } }, /lifecycle's field: it cannot be encrypted/);
    refused({ ...CONTACTS, fields: [...CONTACTS.fields, { name: "when", label: "When", type: "date", encrypted: true }],
      clocks: [{ name: "c", label: "C", starts: { field: "when" }, after: "3d" }] }, /named by a clock/);
    const kind = { name: "k", label: "K", entry: "packs/x/run.mjs", args: [{ name: "a", label: "A", type: "text", encrypted: true }] };
    const k = JobKindSchema.safeParse(kind);
    assert.ok(!k.success && JSON.stringify(k.error.issues).includes("not a job kind's arguments"), "a job kind's argument is never encrypted");
    const build = (def: object) => encryptedFieldProblems([{ id: "p", definition: { recordAreas: [CONTACTS], ...def } } as never]);
    assert.deepEqual(build({}), []);
    assert.match(build({ metrics: [{ name: "m", label: "M", over: "contacts", measure: "sum", field: "pin" }] }).join(), /metric m names contacts's encrypted field pin/);
    assert.match(build({ metrics: [{ name: "m", label: "M", over: "contacts", group_by: "memo" }] }).join(), /encrypted field memo/);
    assert.match(build({ tabs: [{ id: "t", kind: "area", area: "contacts", filter: { ref: "x" } }] }).join(), /tab t filters, boards or orders contacts by its encrypted field ref/);
    assert.match(encryptedFieldProblems([{ id: "p", definition: { recordAreas: [{ ...CONTACTS, repository: "files" }], repositories: { files: { kind: "workspace_files" } } } } as never]).join(),
      /reads its rows from repository files \(workspace_files\)/);
    ok("declaration: workspace areas only; text, number, date, boolean, json or enum, one value; searchable and reveal_roles need encrypted; never a lifecycle, due, link or clock field, a job argument, a metric's or tab's field, or a repository-fed area");
  }

  // The build: the embedded fixture with both areas; the data trail on.
  await installEmbedded(withAreas([CONTACTS, NOTES]));
  audit.setAuditForTest({ data: true, platform: false });
  const records = await import("../src/record-areas.js");
  const A = (await createOrg(`Enc A ${STAMP}`)).org, B = (await createOrg(`Enc B ${STAMP}`)).org;
  const http = await startHttp();
  const hook = await receiver();
  const hooks = await import("../src/developer-webhooks.js");
  try {
    const ownerA = await http.signIn(A, "owner"), memberA = await http.signIn(A, "member"), viewerA = await http.signIn(A, "viewer"), ownerB = await http.signIn(B, "owner");
    const call = async (method: string, p: string, tok: string | null, body?: unknown, h: Record<string, string> = {}) => {
      const r = await http.req(method, p, { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(method !== "GET" ? { "x-pack-request": "1" } : {}), ...h }, body);
      const text = await r.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: r.status, json, text };
    };
    // A developer key and a webhook endpoint for every event (the developer surface, mold_v0-193).
    const made = await call("POST", "/api/developer/keys", ownerA, { name: "Backend" });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const KEY = made.json.key as string;
    assert.equal((await call("POST", "/v1/webhook_endpoints", KEY, { url: hook.url, description: "all" })).status, 201);

    // ---------- 2. round trip ----------
    const created = await call("POST", "/api/data/contacts", ownerA, { key: "c-1", title: "First", data: { name: "Ada", ref: REF, pin: PIN, memo: MEMO, tier: "gold" } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.deepEqual(created.json.record.data, { name: "Ada", ref: ENCRYPTED_MASK, pin: ENCRYPTED_MASK, memo: ENCRYPTED_MASK, tier: "gold" }, "the write's answer is masked");
    const [row] = await db.query<{ data: Record<string, any> }>("SELECT data FROM workspace_records WHERE org_id = $1 AND area = 'contacts' AND key = 'c-1'", [A.orgId]);
    assert.ok(isEnvelope(row!.data.ref) && isEnvelope(row!.data.pin) && isEnvelope(row!.data.memo), "each value stored as an envelope");
    assert.deepEqual(leaks(JSON.stringify(row)), [], "no value in the clear in the database");
    assert.match(row!.data[`${BLIND_PREFIX}ref`], /^[0-9a-f]{64}$/, "the searchable field's blind index");
    assert.equal(row!.data[`${BLIND_PREFIX}memo`], undefined, "none for a field that is not searchable");
    assert.equal(row!.data[FIELDS_TAG], "v1:memo,pin,ref=eq", "the declaration's tag");
    const got = await call("GET", "/api/data/contacts/c-1", ownerA);
    assert.deepEqual(got.json.record.data, created.json.record.data, "a record's page: masked");
    const revealed = await call("POST", "/api/data/contacts/c-1/reveal", ownerA, {});
    assert.equal(revealed.status, 200, JSON.stringify(revealed.json));
    assert.deepEqual(revealed.json, { area: "contacts", key: "c-1", fields: { ref: REF, pin: PIN, memo: MEMO } }, "the round trip: exactly the values written, typed");
    // The mask written back (a client that read the record) and a field left out keep the values; null clears one.
    const back = await call("PUT", "/api/data/contacts/c-1", ownerA, { title: "First", data: { ...got.json.record.data, tier: "silver" } });
    assert.equal(back.status, 200, JSON.stringify(back.json));
    assert.equal((await call("PUT", "/api/data/contacts/c-1", ownerA, { title: "First", data: { name: "Ada", tier: "silver" } })).status, 200, "required ref kept when left out");
    assert.deepEqual((await call("POST", "/api/data/contacts/c-1/reveal", ownerA, {})).json.fields, { ref: REF, pin: PIN, memo: MEMO }, "kept through both writes");
    await call("PUT", "/api/data/contacts/c-1", ownerA, { title: "First", data: { name: "Ada", memo: null, tier: "silver" } });
    assert.deepEqual((await call("POST", "/api/data/contacts/c-1/reveal", ownerA, { fields: ["memo"] })).json.fields, { memo: null }, "null clears it");
    await call("PUT", "/api/data/contacts/c-1", ownerA, { title: "First", data: { name: "Ada", memo: MEMO, tier: "silver" } });
    const env = await call("PUT", "/api/data/contacts/c-1", ownerA, { title: "First", data: { name: "Ada", memo: row!.data.memo } });
    assert.equal(env.status, 400); assert.match(env.json.error, /may not start with encf:v1:/);
    assert.equal((await call("PUT", "/api/data/contacts/c-1", ownerA, { title: "First", data: { name: "Ada", "$bi:ref": "00" } })).status, 400, "a store key is not a field");
    assert.equal((await call("POST", "/api/data/contacts", ownerA, { key: "c-0", data: { name: "No ref" } })).status, 400, "a required encrypted field is still required on create");
    // Through ctx.records too (a pack's code), and the sealed area.
    await withTenant(A.orgId, () => records.workspaceRecords("fixture_embedded", A.orgId).create("contacts", "c-2", { data: { name: "Bob", ref: `${REF}-2`, pin: 1 } }));
    assert.equal((await call("POST", "/api/data/vault_notes", ownerA, { key: "n-1", data: { body: "hello", code: CODE } })).status, 201);
    const [note] = await db.query<{ data: Record<string, any>; sealed: boolean }>("SELECT data, sealed FROM workspace_records WHERE org_id = $1 AND area = 'vault_notes'", [A.orgId]);
    assert.ok(note!.sealed && typeof note!.data._sealed === "string" && /^[0-9a-f]{64}$/.test(note!.data[`${BLIND_PREFIX}code`]), "a sealed area: ciphertext, its blind index beside it");
    assert.deepEqual((await call("POST", "/api/data/vault_notes/n-1/reveal", ownerA, {})).json.fields, { code: CODE }, "a sealed area's encrypted field reveals");
    ok("round trip: stored as envelopes with a blind index and the tag, every answer masked, revealed exactly (text and number); the mask or a left-out field keeps a value, null clears it, envelopes and store keys refused as input; ctx.records and a sealed area too");

    // ---------- 3. never shown ----------
    const outputs: string[] = [];
    const keep = (what: string, s: string) => { outputs.push(`${what}: ${s}`); return s; };
    keep("data api list", (await call("GET", "/api/data/contacts", ownerA)).text);
    keep("data api get", (await call("GET", "/api/data/contacts/c-1", ownerA)).text);
    keep("console list", (await call("GET", "/api/records/contacts", ownerA)).text);
    keep("console record", (await call("GET", "/api/records/contacts/c-1", ownerA)).text);
    keep("console export", (await call("GET", "/api/records/contacts?audit=export&limit=200", ownerA)).text);
    keep("console sealed list", (await call("GET", "/api/records/vault_notes", ownerA)).text);
    keep("v1 list", (await call("GET", "/v1/records/contacts", KEY)).text);
    keep("v1 get", (await call("GET", "/v1/records/contacts/c-1", KEY)).text);
    const mcp = await connect(A);
    const tools = (await mcp.client.listTools()).tools.map((t) => t.name);
    for (const [t, args] of [["list_records", { area: "contacts" }], ["get_record", { area: "contacts", key: "c-1" }], ["fixture_embedded_list_contacts", {}],
      ["fixture_embedded_get_contacts", { key: "c-1" }], ["fixture_embedded_export_contacts", {}], ["fixture_embedded_list_vault_notes", {}], ["fixture_embedded_export_vault_notes", {}]] as const) {
      const r = await mcp.call(t, args);
      assert.ok(!r.isError, `${t}: ${JSON.stringify(r).slice(0, 200)}`);
      keep(`mcp ${t}`, JSON.stringify(r));
    }
    assert.match(outputs.find((o) => o.startsWith("mcp fixture_embedded_export_contacts"))!, /\[encrypted\]/, "the export's cells are the mask");
    await hooks.webhookTick(); await hooks.settled();
    const deliveries = await db.query("SELECT * FROM webhook_deliveries");
    assert.ok(hook.got.length >= 3 && deliveries.length >= 3, `webhooks were sent (${hook.got.length})`);
    keep("webhooks received", JSON.stringify(hook.got.map((g) => g.body)));
    keep("webhook deliveries", JSON.stringify(deliveries));
    await audit.flushAudit();
    keep("data trail", JSON.stringify(await db.query("SELECT * FROM audit_data_events")));
    keep("logs", printed);
    for (const o of outputs) assert.deepEqual(leaks(o), [], `no value in ${o.slice(0, 40)}`);
    assert.ok(outputs.filter((o) => o.includes(ENCRYPTED_MASK)).length >= 10, "the outputs show the mask where the values are");
    ok(`never shown: ${outputs.length} outputs grepped (data API list and get, the console's list, record, export and a sealed area, the developer API, MCP list_records, get_record, list_/get_/export_ of both areas, ${hook.got.length} webhooks received and their deliveries, the data trail, every log line): no value, the mask in its place`);

    // ---------- 4. reveal: role-gated and audited ----------
    const before = (await db.query("SELECT count(*)::int AS n FROM audit_data_events WHERE org_id = $1 AND action = 'reveal'", [A.orgId]))[0] as { n: number };
    const asMember = await call("POST", "/api/data/contacts/c-1/reveal", memberA, {});
    assert.equal(asMember.status, 200);
    assert.deepEqual(Object.keys(asMember.json.fields).sort(), ["memo", "ref"], "a member reveals the fields of the default roles (the area's update roles), not the owners' pin");
    const pin = await call("POST", "/api/data/contacts/c-1/reveal", memberA, { fields: ["pin"] });
    assert.equal(pin.status, 403); assert.match(pin.json.error, /reveal pin of Contacts with the Member role \(owner can\)/);
    const viewer = await call("POST", "/api/data/contacts/c-1/reveal", viewerA, {});
    assert.equal(viewer.status, 403, "a viewer (read only) reveals nothing by default");
    assert.equal((await call("POST", "/api/data/contacts/c-1/reveal", ownerA, { fields: ["name"] })).status, 400, "only encrypted fields are revealed");
    assert.equal((await call("POST", "/api/data/tickets/x/reveal", ownerA, {})).status, 404, "an area without encrypted fields has nothing to reveal");
    assert.deepEqual((await call("POST", "/v1/records/contacts/c-1/reveal", KEY, { fields: ["pin"] })).json.data.fields, { pin: PIN }, "the developer API's reveal (a key has no role limits)");
    // MCP: offered to roles that may reveal, refused with the role's words otherwise.
    assert.ok(tools.includes("fixture_embedded_reveal_contacts") && tools.includes("fixture_embedded_reveal_vault_notes"), "reveal_<area> for each area with encrypted fields");
    assert.ok(!tools.includes("fixture_embedded_reveal_tickets"), "none for an area without");
    const r1 = await mcp.call("fixture_embedded_reveal_contacts", { key: "c-1", fields: ["ref"] });
    assert.deepEqual(r1.structuredContent?.fields, { ref: REF }, "reveal through MCP");
    await mcp.close();
    const viewerMcp = await connect({ ...A, role: "viewer", userId: "viewer-1" } as never);
    assert.ok(!(await viewerMcp.client.listTools()).tools.some((t) => t.name === "fixture_embedded_reveal_contacts"), "not offered to a viewer");
    const vr = await viewerMcp.call("fixture_embedded_reveal_contacts", { key: "c-1" });
    assert.ok(vr.isError, "and refused when called");
    await viewerMcp.close();
    await audit.flushAudit();
    const reveals = await db.query<any>("SELECT * FROM audit_data_events WHERE org_id = $1 AND action = 'reveal' ORDER BY seq", [A.orgId]);
    const fresh = reveals.slice(before.n);
    assert.equal(fresh.length, 3, `each reveal that answered is one entry, a refused one none (${JSON.stringify(fresh.map((e) => e.channel))})`);
    assert.ok(fresh.some((e) => e.channel === "console" && e.actor_kind === "user" && e.record_key === "c-1" && e.area === "contacts"), "with its person, door, area and key");
    assert.ok(fresh.some((e) => e.channel === "api"), `the developer API's too (${fresh.map((e) => e.channel)})`);
    assert.deepEqual(leaks(JSON.stringify(reveals)), [], "never the value");
    const refusedCount = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_data_events WHERE org_id = $1 AND action = 'reveal' AND record_key = 'c-1'", [A.orgId]))[0]!.n;
    audit.setAuditForTest({ data: false, platform: false });
    assert.equal((await call("POST", "/api/data/contacts/c-1/reveal", ownerA, {})).status, 200, "with the data trail off a reveal still answers");
    await audit.flushAudit();
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_data_events WHERE org_id = $1 AND action = 'reveal' AND record_key = 'c-1'", [A.orgId]))[0]!.n, refusedCount, "and records nothing");
    audit.setAuditForTest({ data: true, platform: false });
    ok("reveal: reveal_roles hold (owners only for pin), the default is the area's update roles (a member yes, a viewer no), only encrypted fields; MCP reveal_<area> offered and allowed by role, the developer API too; every reveal a data-trail entry with person, door, area and key, never a value");

    // ---------- 5. the blind index ----------
    const eq = await call("GET", `/api/data/contacts?filter=${encodeURIComponent(JSON.stringify({ ref: REF }))}`, ownerA);
    assert.deepEqual(eq.json.records.map((r: any) => r.key), ["c-1"], "equality finds it");
    assert.deepEqual((await call("GET", `/api/data/contacts?filter=${encodeURIComponent(JSON.stringify({ ref: `${REF}-2`, tier: { exists: false } }))}`, ownerA)).json.records.map((r: any) => r.key), ["c-2"], "with other conditions");
    assert.deepEqual((await call("GET", `/api/data/contacts?filter=${encodeURIComponent(JSON.stringify({ ref: "nope" }))}`, ownerA)).json.records, [], "another value finds nothing");
    for (const [filter, why] of [[{ ref: { ne: REF } }, /equality only/], [{ ref: { prefix: "REF" } }, /equality only/], [{ ref: { contains: "REF" } }, /equality only/], [{ ref: { in: [REF] } }, /equality only/],
      [{ ref: { exists: true } }, /equality only/], [{ memo: MEMO }, /not searchable/], [{ pin: { gt: 1 } }, /not searchable/]] as const) {
      const r = await call("GET", `/api/data/contacts?filter=${encodeURIComponent(JSON.stringify(filter))}`, ownerA);
      assert.equal(r.status, 400, JSON.stringify(filter)); assert.match(r.json.error, why);
    }
    for (const s of ["ref", "-pin", "memo"]) assert.match((await call("GET", `/api/data/contacts?sort=${s}`, ownerA)).json.error, /cannot be sorted on/);
    assert.deepEqual((await call("GET", `/api/data/vault_notes?filter=${encodeURIComponent(JSON.stringify({ code: CODE }))}`, ownerA)).json.records.map((r: any) => r.key), ["n-1"], "in a sealed area");
    assert.deepEqual((await call("GET", `/api/data/vault_notes?filter=${encodeURIComponent(JSON.stringify({ code: CODE, body: "hello" }))}&sort=-updated_at`, ownerA)).json.records.map((r: any) => r.key), ["n-1"], "a sealed area's in-memory filter with it");
    const viaMcp = await (await connect(A)).call("fixture_embedded_list_contacts", { filter: { ref: REF } });
    assert.deepEqual(viaMcp.structuredContent?.records.map((r: any) => r.key), ["c-1"], "through MCP");
    // The same value in B: another index (each workspace's own key).
    assert.equal((await call("POST", "/api/data/contacts", ownerB, { key: "c-1", data: { name: "Ada", ref: REF } })).status, 201);
    const idx = await db.query<{ org_id: number; i: string }>(`SELECT org_id, data ->> '${BLIND_PREFIX}ref' AS i FROM workspace_records WHERE area = 'contacts' AND key = 'c-1' ORDER BY org_id`);
    assert.equal(idx.length, 2); assert.notEqual(idx[0]!.i, idx[1]!.i, "one value, two workspaces, two indexes");
    ok("blind index: equality finds the record (alone, with other conditions, in a sealed area, through MCP); ne, prefix, contains, in, exists, a field that is not searchable and every sort are refused; the same value indexes differently per workspace");

    // ---------- 6. key rotation ----------
    {
      const { rekey } = await import("../src/keyvault.js");
      const { forgetOrgKey } = await import("../src/orgcrypto.js");
      const snapshot = async () => db.query<{ org_id: number; key: string; data: string }>("SELECT org_id, key, data::text AS data FROM workspace_records WHERE area IN ('contacts', 'vault_notes') ORDER BY org_id, area, key");
      const wrapped = async () => (await db.query<{ w: string }>("SELECT wrapped::text AS w FROM org_keys WHERE org_id = $1", [A.orgId]))[0]!.w;
      const dataBefore = await snapshot(), wrapBefore = await wrapped();
      process.env.APP_VAULT_KEY_PREVIOUS = process.env.APP_VAULT_KEY;
      process.env.APP_VAULT_KEY = randomBytes(32).toString("base64");
      await rekey();
      delete process.env.APP_VAULT_KEY_PREVIOUS; // the old key is gone: only the re-wrapped data keys open now
      forgetOrgKey(A.orgId); forgetOrgKey(B.orgId);
      assert.notEqual(await wrapped(), wrapBefore, "the data key is wrapped by the new vault key");
      assert.deepEqual(await snapshot(), dataBefore, "no field's ciphertext changed (nothing re-encrypted)");
      assert.deepEqual((await call("POST", "/api/data/contacts/c-1/reveal", ownerA, {})).json.fields, { ref: REF, pin: PIN, memo: MEMO }, "every value still reveals");
      assert.deepEqual((await call("GET", `/api/data/contacts?filter=${encodeURIComponent(JSON.stringify({ ref: REF }))}`, ownerA)).json.records.map((r: any) => r.key), ["c-1"], "the blind index still matches");
      ok("key rotation: rekey with a new vault key re-wraps the workspaces' data keys; every stored field byte for byte the same; values reveal and the index matches with the old vault key gone");
    }

    // ---------- 7. tenant isolation ----------
    {
      assert.equal((await call("POST", "/api/data/contacts/c-2/reveal", ownerB, {})).status, 404, "B cannot reveal A's record (not B's)");
      assert.deepEqual((await call("GET", `/api/data/contacts?filter=${encodeURIComponent(JSON.stringify({ ref: `${REF}-2` }))}`, ownerB)).json.records, [], "B's search does not find A's value");
      const seen = await withTenant(B.orgId, async () => (await getDb()).query<{ n: number }>("/* tenant: rls proof */ SELECT count(*)::int AS n FROM workspace_records WHERE org_id <> $1", [B.orgId]));
      assert.equal(seen[0]!.n, 0, "row-level security: B's tenant work sees none of A's rows");
      // A's envelope copied into B's own row (as the platform, past every door): it does not open with B's key, nor at A's other record.
      const [a1] = await db.query<{ data: Record<string, any> }>("SELECT data FROM workspace_records WHERE org_id = $1 AND area = 'contacts' AND key = 'c-1'", [A.orgId]);
      await asPlatform(async () => db.query(`UPDATE workspace_records SET data = jsonb_set(data, '{ref}', to_jsonb($2::text)) WHERE org_id = $1 AND area = 'contacts' AND key = 'c-1'`, [B.orgId, a1!.data.ref]));
      const moved = await call("POST", "/api/data/contacts/c-1/reveal", ownerB, { fields: ["ref"] });
      assert.equal(moved.status, 409, "a value moved to another workspace does not open"); assert.deepEqual(leaks(moved.text), []);
      await asPlatform(async () => db.query(`UPDATE workspace_records SET data = jsonb_set(data, '{memo}', to_jsonb($2::text)) WHERE org_id = $1 AND area = 'contacts' AND key = 'c-2'`, [A.orgId, a1!.data.ref]));
      assert.equal((await call("POST", "/api/data/contacts/c-2/reveal", ownerA, { fields: ["memo"] })).status, 409, "nor at another record or field of its own workspace");
      ok("tenant isolation: another workspace cannot reveal or find a value, its tenant role sees no other row, and an envelope moved to another workspace, record or field does not open");
    }
  } finally { hook.close(); await http.close(); }

  // ---------- 8. the migration ----------
  {
    const mig = await import("../src/encrypted-fields-migration.js");
    const PLAIN = { ...CONTACTS, name: "later", label: "Later", fields: CONTACTS.fields.map((f) => ({ name: f.name, label: f.label, type: f.type, ...(f.type === "enum" ? { options: ["gold", "silver"] } : {}) })) };
    await installEmbedded(withAreas([PLAIN]));
    const C = (await createOrg(`Enc C ${STAMP}`)).org, D = (await createOrg(`Enc D ${STAMP}`)).org;
    for (const o of [C, D]) await withTenant(o.orgId, () => records.workspaceRecords("fixture_embedded", o.orgId).batch(
      Array.from({ length: 5 }, (_, i) => ({ op: "create" as const, area: "later", key: `l-${i}`, data: { name: `n${i}`, ref: `${REF}-${o.orgId}-${i}`, pin: PIN + i, memo: i % 2 ? MEMO : null } }))));
    const raw = async () => db.query<{ org_id: number; key: string; data: Record<string, any>; updated_at: Date }>("SELECT org_id, key, data, updated_at FROM workspace_records WHERE area = 'later' ORDER BY org_id, key");
    const plainRows = await raw();
    assert.equal(leaks(JSON.stringify(plainRows)).length > 0, true, "before: the values are stored in the clear (the field was not encrypted)");
    assert.equal((await mig.encryptFieldsTick()).ran, false, "no encrypted area: the pass does nothing");
    // The pack now marks them encrypted: reads mask at once, the pass seals the rows in batches.
    await installEmbedded(withAreas([{ ...CONTACTS, name: "later", label: "Later" }]));
    const page = await records.listFor(C.orgId, "later", { limit: 10 });
    assert.ok(page.records.every((r) => r.data.ref === ENCRYPTED_MASK), "reads mask the plain values before the migration reaches them");
    assert.deepEqual(leaks(JSON.stringify(page)), []);
    mig.resetMigrationCursors();
    const r1 = await mig.encryptFieldsTick({ batch: 4 });
    assert.deepEqual([r1.ran, r1.rows, r1.updated, r1.failed, r1.pending], [true, 4, 4, 0, 6], `the first batch: 4 of 10 (${JSON.stringify(r1)})`);
    // Interrupted here (a deploy): a new process starts over from the rows still pending.
    mig.resetMigrationCursors();
    const r2 = await mig.encryptFieldsTick({ batch: 4 }), r3 = await mig.encryptFieldsTick({ batch: 4 });
    assert.deepEqual([r2.updated, r2.pending, r3.updated, r3.pending], [4, 2, 2, 0], `resumed: ${JSON.stringify([r2, r3])}`);
    const after = await raw();
    assert.deepEqual(leaks(JSON.stringify(after)), [], "after: no value in the clear");
    assert.ok(after.every((r) => r.data[FIELDS_TAG] === "v1:memo,pin,ref=eq" && isEnvelope(r.data.ref) && isEnvelope(r.data.pin)), "every row sealed and tagged");
    assert.deepEqual(after.map((r) => r.updated_at.toISOString()), plainRows.map((r) => r.updated_at.toISOString()), "nothing else of a row changed (not updated_at)");
    const again = await mig.encryptFieldsTick({ batch: 4 });
    assert.deepEqual([again.rows, again.updated, again.pending], [0, 0, 0], "idempotent: run again, nothing to do");
    assert.deepEqual(await raw(), after, "and nothing changed");
    for (const o of [C, D]) {
      const rv = await withTenant(o.orgId, () => records.revealFor(o.orgId, "later", "l-1", undefined));
      assert.deepEqual(rv.fields, { ref: `${REF}-${o.orgId}-1`, pin: PIN + 1, memo: MEMO }, "each value reveals as it was written");
      assert.deepEqual((await records.listFor(o.orgId, "later", { filter: { ref: `${REF}-${o.orgId}-3` } })).records.map((r) => r.key), ["l-3"], "and the new blind index finds it");
    }
    // A field no longer encrypted: its stored envelope is opened back on read and on the next write.
    await installEmbedded(withAreas([{ ...CONTACTS, name: "later", label: "Later", fields: CONTACTS.fields.map((f) => (f.name === "memo" ? { name: "memo", label: "Memo", type: "text" } : f)) }]));
    const opened = await records.getFor(C.orgId, "later", "l-1");
    assert.equal(opened!.data.memo, MEMO, "unmarked: the value reads in the clear again");
    const r4 = await mig.encryptFieldsTick({ batch: 50 });
    assert.equal(r4.updated, 10, "the pass rewrites every row under the new declaration");
    const [l1] = await db.query<{ data: Record<string, any> }>("SELECT data FROM workspace_records WHERE org_id = $1 AND area = 'later' AND key = 'l-1'", [C.orgId]);
    assert.equal(l1!.data.memo, MEMO); assert.equal(l1!.data[FIELDS_TAG], "v1:pin,ref=eq");
    ok("migration: newly encrypted fields are masked at once and sealed by the scheduler's pass in batches (4, then resumed after a restart, 4, 2), every row tagged, nothing else changed; a second pass does nothing; values reveal and the blind index finds them; a field no longer encrypted is opened back");
  }

  await installEmbedded(null);
  console.log(`ENCRYPTED FIELDS TEST PASS (${n} checks)`);
} finally { cleanup(); }
process.exit(0);

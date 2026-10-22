// The generic data API (mold_v0-059; src/data-api.ts, src/data-routes.ts, src/record-query.ts).
//   npm run test:data-api        offline: an embedded database in a temporary directory, a fake Clerk
//
// 1. Zero areas: no /api/data or /api/admin/data route is mounted; the MCP surface gains no tool from the data API.
// 2. Every declared area gets list (filter, sort, paging), get, create, update, move, delete and batch over REST, with
//    the record store's own rules (fields, lifecycle, permissions per role, read-only repositories, shared areas),
//    the session, and the CSRF header on cookie writes; keys with ( and ) in URLs, raw or encoded.
// 3. Two workspaces through every route: lists (whatever the filter, sort or cursor), gets, updates, moves, deletes,
//    batches and references never reach the other's rows; repository-fed areas the same.
// 4. Staff: shared areas only, "read" to read, "library" to write, "delete" to delete.
// 5. The internal function list (DATA_API_OPERATIONS) names functions that exist, for 060 to wrap.
import assert from "node:assert/strict";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";
import { catalogPack, workspaceFiles } from "./lib/catalog-fixture.js";

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const TOOL_NAMES = (await import("../src/server.js")).ownToolNames(); // the host packs' tools (src/host.ts): none with zero packs
  const { setPacksForTest } = await import("../src/packs.js");
  const { createOrg } = await import("../src/auth.js");
  const { dataAppRouter, dataAdminRouter } = await import("../src/data-routes.js");
  const api = await import("../src/data-api.js");

  // ---------- 1. zero areas ----------
  {
    assert.equal((dataAppRouter() as unknown as { stack: unknown[] }).stack.length, 0, "no /api/data routes");
    assert.equal((dataAdminRouter() as unknown as { stack: unknown[] }).stack.length, 0, "no /api/admin/data routes");
    const A0 = (await createOrg(`Data zero ${STAMP}`)).org;
    const c = await connect(A0);
    assert.deepEqual((await c.client.listTools()).tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort(), "the MCP server lists exactly the shell's tools");
    await c.close();
    console.log("✓ zero areas: no data routes are mounted; the MCP surface is the shell's");
  }

  const fx = await catalogPack();
  setPacksForTest([fx]);
  {
    const c = await connect((await createOrg(`Data tools ${STAMP}`)).org);
    const { generatedTools } = await import("../src/mcp-tools.js");
    const generated = generatedTools().filter((t) => t.door === "workspace" && !t.admin_only).map((t) => t.name);
    assert.ok(generated.length > 0, "the areas get generated MCP tools (mold_v0-060), over these operations");
    assert.deepEqual((await c.client.listTools()).tools.map((t) => t.name).sort(), [...TOOL_NAMES, "get_record", "list_records", ...generated].sort(), "with areas: the 047 record tools and the tools generated over the data API (060)");
    await c.close();
  }
  const A = (await createOrg(`Data A ${STAMP}`)).org, B = (await createOrg(`Data B ${STAMP}`)).org;
  const { indexWorkspaceFiles } = await import("../src/data-repositories.js");
  await indexWorkspaceFiles(A.orgId, "fixture_catalog", workspaceFiles("acme", "A"));
  await indexWorkspaceFiles(B.orgId, "fixture_catalog", workspaceFiles("globex", "B"));
  const rec = await import("../src/record-areas.js");
  for (const k of ["alpha-rules-2024:7(2)(b)", "alpha-rules-2024:34(vii)"]) await rec.putPlatform(null, "controls", k, { title: `Control ${k}`, data: { control_id: k.split(":")[1], mandatory: true } });

  const http = await startHttp();
  try {
    const memberA = await http.signIn(A), ownerA = await http.signIn(A, "owner"), viewerA = await http.signIn(A, "viewer");
    const memberB = await http.signIn(B), ownerB = await http.signIn(B, "owner");
    const call = async (method: string, p: string, tok: string | null, body?: unknown, h: Record<string, string> = {}) => {
      const r = await http.req(method, p, { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...h }, body);
      const text = await r.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: r.status, body: json };
    };
    const list = (tok: string, area: string, q: Record<string, unknown> = {}) =>
      call("GET", `/api/data/${area}?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString()}`, tok);

    // ---------- 2. the routes ----------
    {
      assert.equal((await call("GET", "/api/data/tasks", null)).status, 401, "signed out: 401");
      const areas = await call("GET", "/api/data", memberA);
      const byName = Object.fromEntries(areas.body.areas.map((a: any) => [a.name, a]));
      assert.deepEqual([byName.control_status.repository, byName.control_status.read_only], [{ name: "company_ledger", kind: "workspace_files" }, true]);
      assert.deepEqual([byName.regulators.repository.kind, byName.regulators.read_only], ["upstream_catalog", false]);
      assert.equal(byName.notes.sealed, true); assert.equal(byName.applications.sealed, true); assert.equal(byName.tasks.sealed, undefined);
      // Create, read, update, move, delete.
      const created = await call("POST", "/api/data/tasks", memberA, { key: "t1", title: "First", data: { summary: "first", severity: "high", score: 5, due: "2026-11-01", tags: ["web"], control: "alpha-rules-2024:7(2)(b)" } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.record.data.state, "open", "a new record starts in its initial state");
      assert.equal((await call("POST", "/api/data/tasks", memberA, { key: "t1", data: { summary: "again" } })).status, 409, "create refuses an existing key");
      assert.equal((await call("POST", "/api/data/tasks", memberA, { data: { summary: "x" } })).status, 400, "create needs a key");
      const bad = await call("POST", "/api/data/tasks", memberA, { key: "tx", data: { summary: "x", severity: "urgent", score: "high" } });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /field severity .* must be one of .*; field score .* must be a number/, "every problem in one refusal, as the store says");
      assert.equal((await call("POST", "/api/data/tasks", memberA, { key: "tx", data: { summary: "x", state: "done" } })).status, 409, "a new record cannot start in another state");
      assert.equal((await call("POST", "/api/data/tasks", viewerA, { key: "tv", data: { summary: "x" } })).status, 403, "a viewer cannot create");
      const got = await call("GET", "/api/data/tasks/t1", viewerA);
      assert.equal(got.status, 200);
      assert.deepEqual(got.body.links.find((l: any) => l.field === "control").records.map((r: any) => r.key), ["alpha-rules-2024:7(2)(b)"], "get shows the linked records");
      assert.equal((await call("PUT", "/api/data/tasks/t1", memberA, { title: "First, changed", data: { summary: "first!", severity: "critical" } })).body.record.data.state, "open", "update keeps the state");
      assert.equal((await call("PUT", "/api/data/tasks/none", memberA, { data: { summary: "x" } })).status, 404, "update needs an existing record");
      assert.equal((await call("PUT", "/api/data/tasks/t1", memberA, { data: { summary: "x", state: "done" } })).status, 409, "update cannot change the state");
      assert.equal((await call("POST", "/api/data/tasks/t1/move", memberA, { to: "done" })).status, 409, "a move off the transitions");
      assert.equal((await call("POST", "/api/data/tasks/t1/move", memberA, { to: "doing" })).body.record.data.state, "doing");
      assert.equal((await call("POST", "/api/data/tasks/t1/move", viewerA, { to: "done" })).status, 403, "a viewer cannot move");
      assert.equal((await call("DELETE", "/api/data/tasks/t1", memberA)).status, 403, "delete on a lifecycle area is the owner's");
      assert.equal((await call("DELETE", "/api/data/tasks/t1", ownerA)).status, 204);
      assert.equal((await call("GET", "/api/data/tasks/t1", memberA)).status, 404);
      assert.equal((await call("DELETE", "/api/data/tasks/t1", ownerA)).status, 404);
      assert.equal((await call("GET", "/api/data/nowhere", memberA)).status, 404, "an area that does not exist");
      // CSRF: a cookie write needs the header; a body that is not JSON is refused without echoing it.
      assert.equal((await call("POST", "/api/data/tasks", null, { key: "ck", data: { summary: "x" } }, { cookie: `__session=${memberA}` })).status, 403, "a cookie write without X-Pack-Request");
      assert.equal((await call("POST", "/api/data/tasks", null, { key: "ck", data: { summary: "x" } }, { cookie: `__session=${memberA}`, "x-pack-request": "1" })).status, 201, "with it");
      const notJson = await call("POST", "/api/data/tasks", memberA, "{ secret-body-text", { "content-type": "application/json" });
      assert.ok(notJson.status === 400 && !JSON.stringify(notJson.body).includes("secret-body-text"), "a body that is not JSON: 400, not echoed");
      // Read-only areas (their rows come from the workspace's files), and shared areas, refuse every write.
      for (const [m, p, b] of [["POST", "/api/data/control_status", { key: "k", data: {} }], ["PUT", "/api/data/control_status/alpha-rules-2024:34(vii)", { data: {} }],
        ["DELETE", "/api/data/control_status/alpha-rules-2024:34(vii)", undefined], ["POST", "/api/data/applications", { key: "x", data: {} }], ["DELETE", "/api/data/applications/web-portal", undefined]] as const)
        assert.equal((await call(m, p, ownerA, b)).status, 409, `${m} ${p}: read only`);
      assert.equal((await call("POST", "/api/data/_batch", ownerA, { operations: [{ op: "delete", area: "control_status", key: "alpha-rules-2024:34(vii)" }] })).status, 409, "a batch on a read-only area");
      assert.equal((await call("POST", "/api/data/controls", ownerA, { key: "c", data: {} })).status, 403, "a shared area from the workspace door");
      assert.equal((await call("GET", "/api/data/controls/alpha-rules-2024:34(vii)", viewerA)).status, 200, "but every workspace reads it");
      console.log("✓ REST: create (201, 409 existing), get with links, update (404 missing, state kept), move (transitions and roles), delete (the owner's, 404), the session, CSRF, read-only and shared areas");
    }

    // Filters, sorts and paging.
    {
      const rows = [
        { key: "f01", data: { summary: "Patch the web server", severity: "high", score: 9, due: "2026-11-05", tags: ["web", "infra"], owner: "user_a" } },
        { key: "f02", data: { summary: "Rotate keys", severity: "critical", score: 10, due: "2026-10-30", tags: ["api"] } },
        { key: "f03", data: { summary: "Review web logs", severity: "low", score: 2, tags: ["web"] } },
        { key: "f04", data: { summary: "Backup check", severity: "medium", score: 5, due: "2026-12-01", tags: [] } },
        { key: "f05", data: { summary: "Disk space", severity: "low", score: 1, due: "2026-11-20" } },
        { key: "f06", data: { summary: "TLS settings", severity: "high", score: 7, due: "2026-11-05", tags: ["web", "api"] } },
        { key: "f07", data: { summary: "Old accounts", severity: "medium", score: 5 } },
      ];
      const r = await call("POST", "/api/data/_batch", memberA, { operations: rows.map((x) => ({ op: "create", area: "tasks", ...x })) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await call("POST", "/api/data/_batch", memberB, { operations: [{ op: "create", area: "tasks", key: "f01", data: { summary: "B web secret", severity: "high", score: 9, tags: ["web"] } }, { op: "create", area: "tasks", key: "fb2", data: { summary: "B only", severity: "critical", score: 100 } }] });
      const keys = async (q: Record<string, unknown>, tok = memberA) => { const x = await list(tok, "tasks", q); assert.equal(x.status, 200, JSON.stringify(x.body)); return x.body.records.map((y: any) => y.key); };
      const fkeys = async (filter: unknown, sort?: string) => keys({ filter, ...(sort ? { sort } : {}) });
      assert.deepEqual(await fkeys({ severity: "high" }), ["f01", "f06"], "eq");
      assert.deepEqual(await fkeys({ severity: { ne: "high" }, key: { prefix: "f" } }), ["f02", "f03", "f04", "f05", "f07"], "ne");
      assert.deepEqual(await fkeys({ severity: { in: ["low", "critical"] } }), ["f02", "f03", "f05"], "in");
      assert.deepEqual(await fkeys({ score: { gte: 5, lt: 9 } }), ["f04", "f06", "f07"], "a range");
      assert.deepEqual(await fkeys({ due: { lte: "2026-11-05" } }), ["f01", "f02", "f06"], "dates");
      assert.deepEqual(await fkeys({ summary: { contains: "WEB" } }), ["f01", "f03"], "text contains, any case");
      assert.deepEqual(await fkeys({ tags: { contains: "api" } }), ["f02", "f06"], "a list contains");
      assert.deepEqual(await fkeys({ due: { exists: false }, key: { prefix: "f" } }), ["f03", "f07"], "exists false");
      assert.deepEqual(await fkeys({ tags: { exists: true } }), ["f01", "f02", "f03", "f06"], "an empty list does not exist");
      assert.deepEqual(await fkeys({ key: { in: ["f02", "f05", "nope"] } }), ["f02", "f05"], "keys in");
      assert.deepEqual(await fkeys({ owner: "user_a" }), ["f01"], "a person");
      assert.deepEqual(await fkeys({ title: { exists: false }, score: { gt: 8 } }), ["f01", "f02"], "the title");
      assert.deepEqual(await fkeys({ key: { prefix: "f" } }, "-score"), ["f02", "f01", "f06", "f07", "f04", "f03", "f05"], "sort descending, ties by key descending");
      assert.deepEqual(await fkeys({ key: { prefix: "f" } }, "due"), ["f03", "f07", "f02", "f01", "f06", "f05", "f04"], "sort by a date, no value first");
      assert.deepEqual(await fkeys({ key: { prefix: "f" } }, "-key"), ["f07", "f06", "f05", "f04", "f03", "f02", "f01"], "by key, descending");
      // Paging: every row exactly once, in order, for each sort.
      for (const sort of ["key", "-score", "due", "summary", "-updated_at", "severity"]) {
        const all = await keys({ sort, filter: { key: { prefix: "f" } }, limit: 200 });
        const paged: string[] = [];
        let after: string | undefined;
        for (let i = 0; i < 20; i++) {
          const x = await list(memberA, "tasks", { sort, filter: { key: { prefix: "f" } }, limit: "2", ...(after ? { after } : {}) });
          paged.push(...x.body.records.map((y: any) => y.key));
          if (!x.body.next) break;
          after = x.body.next;
        }
        assert.deepEqual(paged, all, `paged by ${sort}: every row once, in order`);
      }
      // Refusals: each a 400 naming what is wrong.
      for (const [q, re] of [
        [{ filter: { nope: 1 } }, /no field "nope"/], [{ filter: { score: { near: 1 } } }, /not one of eq, ne/], [{ filter: { score: "high" } }, /not a value field score takes/],
        [{ filter: "{not json" }, /filter must be a JSON object/], [{ filter: { tags: { in: ["web"] } } }, /in is for single-value fields/], [{ filter: { severity: { gt: "a" } } }, /only number, date and text fields are ordered/],
        [{ sort: "nope" }, /no field "nope"/], [{ limit: "0" }, /limit is 1 to 200/], [{ limit: "500" }, /limit is 1 to 200/], [{ after: "~garbage" }, /next value of the previous page/],
        [{ filter: { summary: null } }, /exists/], [{ filter: { updated_at: { exists: true } } }, /every record has a updated_at/],
        [{ sort: "-score", after: `~${Buffer.from(JSON.stringify(["-score", "garbage", "f01"])).toString("base64url")}` }, /next value of the previous page/], [{ filter: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, 1])) }, /no field|at most 20/],
      ] as const) {
        const x = await list(memberA, "tasks", q as Record<string, unknown>);
        assert.equal(x.status, 400, `${JSON.stringify(q)}: 400`);
        assert.match(x.body.error, re as RegExp);
      }
      const sorted = await list(memberA, "tasks", { sort: "-score", limit: "1" });
      assert.equal((await list(memberA, "tasks", { sort: "due", after: sorted.body.next })).status, 400, "a cursor of another sort is refused");
      assert.equal((await list(memberA, "tasks", { after: sorted.body.next })).status, 400, "and under the default order");
      assert.ok(!Buffer.from(sorted.body.next.slice(1), "base64url").toString().includes("10"), "a sorted cursor carries the key, not the row's value");
      // A cursor whose row is gone: 409, start again.
      await call("POST", "/api/data/tasks", memberA, { key: "gone1", data: { summary: "zzz to go", score: 1000 } });
      const g = await list(memberA, "tasks", { sort: "-score", limit: "1" });
      await call("DELETE", "/api/data/tasks/gone1", ownerA);
      assert.equal((await list(memberA, "tasks", { sort: "-score", after: g.body.next })).status, 409, "the cursor's row is gone: 409");
      console.log("✓ filters (eq, ne, in, ranges, dates, contains, list contains, exists, keys, title, person), sorts (any field, key, title, updated_at; asc and desc) and cursor paging: every row once, in order; bad queries 400");

      // ---------- 3. two workspaces through every route ----------
      const aKeys = ["f01", "f02", "f03", "f04", "f05", "f06", "f07", "ck"];
      assert.deepEqual(await keys({ filter: { key: { in: aKeys } } }, memberB), ["f01"], "B's filter on A's keys: only B's own f01");
      const bF01 = await call("GET", "/api/data/tasks/f01", memberB);
      assert.equal(bF01.body.record.data.summary, "B web secret", "the same key is B's own record in B");
      assert.ok(!JSON.stringify(await list(memberA, "tasks", { filter: { summary: { contains: "secret" } } })).includes("B web secret"), "A's search never finds B's");
      assert.deepEqual(await keys({ filter: { score: { gte: 100 } } }), [], "A cannot reach B's score 100 by a range");
      // A cursor made in A walks B's own rows only: its row is read again in B (gone there: 409; there: B's own value).
      const aPage = await list(memberA, "tasks", { sort: "-score", limit: "1" });
      assert.equal((await list(memberB, "tasks", { sort: "-score", after: aPage.body.next })).status, 409, "A's cursor names a row B does not have: 409");
      const bAll = (await list(memberB, "tasks", { sort: "-score", limit: "200" })).body.records.map((x: any) => x.key);
      const f01Cursor = `~${Buffer.from(JSON.stringify(["-score", "f01"])).toString("base64url")}`;
      const viaCursor = (await list(memberB, "tasks", { sort: "-score", after: f01Cursor, limit: "200" })).body.records.map((x: any) => x.key);
      assert.deepEqual(viaCursor, bAll.slice(bAll.indexOf("f01") + 1), "a cursor on a key both have starts after B's own f01");
      assert.deepEqual((await keys({ sort: "-updated_at", limit: 200 }, memberB)).sort(), [...bAll].sort(), "B's list is B's whatever the sort");
      for (const [m, p, b] of [["GET", "/api/data/tasks/f02", undefined], ["PUT", "/api/data/tasks/f02", { data: { summary: "hijack" } }], ["POST", "/api/data/tasks/f02/move", { to: "doing" }], ["DELETE", "/api/data/tasks/f02", undefined]] as const)
        assert.equal((await call(m, p, m === "DELETE" ? ownerB : memberB, b)).status, 404, `B ${m} ${p}: 404 (A's record is not there for B)`);
      assert.equal((await call("POST", "/api/data/_batch", memberB, { operations: [{ op: "create", area: "tasks", key: "fb3", data: { summary: "x" } }, { op: "update", area: "tasks", key: "f02", data: { summary: "hijack" } }] })).status, 404, "a batch touching A's key");
      assert.equal((await call("GET", "/api/data/tasks/fb3", memberB)).status, 404, "and nothing of it was written");
      assert.match((await call("POST", "/api/data/tasks", memberB, { key: "fr", data: { summary: "x", parent: "f02" } })).body.error, /no tasks record f02 in this workspace/, "a reference to A's record from B");
      const aF02 = await call("GET", "/api/data/tasks/f02", memberA);
      assert.equal(aF02.body.record.data.summary, "Rotate keys", "A's record is untouched");
      // Repository-fed areas: each workspace its own rows, sealed ones too.
      const csA = (await list(memberA, "control_status", {})).body.records, csB = (await list(memberB, "control_status", {})).body.records;
      assert.deepEqual([csA.map((x: any) => x.data.company), csB.map((x: any) => x.data.company)], [["acme", "acme"], ["globex", "globex"]], "each workspace's ledger rows");
      const appB = await call("GET", "/api/data/applications/web-portal", memberB);
      assert.ok(appB.body.record.data.readme.includes("Web portal B") && !JSON.stringify(appB.body).includes("Web portal A"), "the same application key opens B's own");
      assert.deepEqual((await list(memberB, "applications", { filter: { readme: { contains: "portal A" } } })).body.records, [], "B's search of a sealed area never finds A's");
      console.log("✓ two workspaces: lists (filters, sorts, A's cursor in B), get, update, move, delete, batch and references never reach the other's rows; repository-fed and sealed areas the same");
    }

    // Keys with ( and ) in URLs, raw and encoded.
    {
      const k = "alpha-rules-2024:7(2)(b)";
      assert.equal((await call("POST", "/api/data/tasks", memberA, { key: k, data: { summary: "parens" } })).status, 201);
      assert.equal((await call("GET", `/api/data/tasks/${k}`, memberA)).body.record.key, k, "raw ( ) in the path");
      assert.equal((await call("GET", `/api/data/tasks/${encodeURIComponent(k).replace(/\(/g, "%28").replace(/\)/g, "%29")}`, memberA)).body.record.key, k, "encoded %28 %29 in the path");
      assert.equal((await call("PUT", `/api/data/tasks/${encodeURIComponent(k)}`, memberA, { data: { summary: "parens 2" } })).body.record.data.summary, "parens 2");
      assert.equal((await call("GET", `/api/data/control_status/${encodeURIComponent("alpha-rules-2024:34(vii)")}`, memberA)).body.record.data.implementation_status, "implemented");
      assert.equal((await call("GET", `/api/data/tasks/${encodeURIComponent("a(b")}`, memberA)).status, 404);
      assert.equal((await call("GET", `/api/data/tasks/${encodeURIComponent("(ab")}`, memberA)).status, 400, "not a key: 400");
      assert.equal((await call("DELETE", `/api/data/tasks/${k}`, ownerA)).status, 204);
      console.log("✓ keys with ( and ) in URLs: raw and percent-encoded reach the same record");
    }

    // Sealed areas through REST: open for the workspace, ciphertext at rest.
    {
      assert.equal((await call("POST", "/api/data/notes", memberA, { key: "rn", title: `canary-${STAMP}`, data: { body: `body-canary-${STAMP}`, severity: "high", score: 3 } })).status, 201);
      assert.deepEqual((await list(memberA, "notes", { filter: { body: { contains: "canary" } } })).body.records.map((x: any) => x.key), ["rn"]);
      assert.deepEqual((await list(memberB, "notes", { filter: { body: { contains: "canary" } } })).body.records, []);
      assert.ok(!JSON.stringify(await db.query("SELECT * FROM workspace_records")).includes(`canary-${STAMP}`), "no canary in the table");
      console.log("✓ sealed through REST: the workspace's own filters work, the other's find nothing, the table holds ciphertext");
    }

    // ---------- 4. staff ----------
    {
      const viewer = await http.adminToken("viewer"), operator = await http.adminToken("operator"), owner = await http.adminToken("owner");
      assert.equal((await call("GET", "/api/admin/data/controls", memberA)).status, 403, "a customer is not staff");
      assert.deepEqual((await call("GET", "/api/admin/data", viewer)).body.areas.map((a: any) => a.name), ["regulators", "controls"], "staff see shared areas only");
      assert.equal((await call("GET", "/api/admin/data/tasks", viewer)).status, 404, "a workspace area is not listed across workspaces");
      assert.equal((await call("GET", "/api/admin/data/notes/rn", owner)).status, 404, "nor a sealed one's record");
      assert.equal((await call("GET", "/api/admin/data/controls", viewer, undefined)).body.records.length, 2);
      assert.equal((await call("POST", "/api/admin/data/controls", viewer, { key: "c(1)", data: { mandatory: true } })).status, 403, "a viewer cannot write");
      assert.equal((await call("POST", "/api/admin/data/controls", operator, { key: "c(1)", data: { mandatory: true } })).status, 201, "an operator (library) creates");
      assert.equal((await call("POST", "/api/admin/data/controls", operator, { key: "c(1)", data: { mandatory: true } })).status, 409);
      assert.equal((await call("PUT", "/api/admin/data/controls/c(1)", operator, { data: { mandatory: false } })).body.record.data.mandatory, false);
      assert.equal((await call("PUT", "/api/admin/data/controls/c(2)", operator, { data: { mandatory: false } })).status, 404);
      assert.equal((await call("GET", `/api/admin/data/controls?${new URLSearchParams({ filter: JSON.stringify({ mandatory: false }) })}`, viewer)).body.records.map((r: any) => r.key).join(), "c(1)", "staff filter shared areas");
      assert.equal((await call("DELETE", "/api/admin/data/controls/c(1)", operator)).status, 403, "deleting needs delete");
      assert.equal((await call("POST", "/api/admin/data/_batch", operator, { operations: [{ op: "delete", area: "controls", key: "c(1)" }] })).status, 403, "a batch that deletes needs delete");
      assert.equal((await call("POST", "/api/admin/data/_batch", operator, { operations: [{ op: "put", area: "controls", key: "c(3)", data: {} }, { op: "put", area: "tasks", key: "x", data: {} }] })).status, 404, "a staff batch on a workspace area");
      assert.equal((await call("GET", "/api/admin/data/controls/c(3)", viewer)).status, 404, "and nothing of it was written");
      assert.equal((await call("DELETE", "/api/admin/data/controls/c(1)", owner)).status, 204);
      const repos = (await call("GET", "/api/admin/data/_repositories", viewer)).body.repositories;
      assert.deepEqual(repos.map((r: any) => [r.name, r.kind, r.indexedBy, r.writable]), [["catalogs", "upstream_catalog", "staff", true], ["company_ledger", "workspace_files", "workspace_commit", false], ["company_applications", "workspace_files", "workspace_commit", false], ["vendor_api", "http_api", "none", false]]);
      assert.equal((await call("POST", "/api/admin/data/_repositories/fixture_catalog/catalogs/sync", viewer, {})).status, 403, "syncing needs library");
      console.log("✓ staff: shared areas only; read, library to write, delete to delete (batches too); the repositories listed");
    }
  } finally {
    await http.close();
  }

  // ---------- 5. the function list ----------
  for (const op of api.DATA_API_OPERATIONS) assert.equal(typeof (op.door === "workspace" ? (api.dataApi as any)[op.name] : (api.adminDataApi as any)[op.name]), "function", `${op.door}.${op.name} exists`);
  const mine = await api.dataApi.list({ orgId: A.orgId, role: "viewer", userId: "v" }, "tasks", { filter: { severity: "critical" } });
  assert.deepEqual(mine.records.map((r) => r.key), ["f02"], "the functions are the routes' own");
  console.log(`✓ DATA_API_OPERATIONS: ${api.DATA_API_OPERATIONS.length} operations, each a function of its door`);
  await db.close();
  console.log("DATA API TEST PASS");
} finally {
  cleanup();
}
process.exit(0);

#!/usr/bin/env node
/**
 * People data against a real Postgres, for the people catalogue of THIS checkout's profile (scripts/test-people-data-db.mjs
 * runs it in the checkout, the default, and in a copy under scripts/fixtures/people/50-people.json, declared). The real
 * roster routes (/api/ops/roster, its bulk import, /api/ops/people/:email) and the real roster tools, as the
 * restricted app_rw role under the fail-closed policies, two workspaces:
 *
 *   every run  who someone reports to: only the workspace's owner or an admin sets it (a member gets 403, the model's
 *              tool refuses), only to someone of the same workspace (a person of the other workspace is refused), never
 *              to themselves, never closing a loop (directly or through the lines already stored, and through a bulk
 *              import); a member still sets a team as before; every refusal stores nothing;
 *   default    the roster and dossier answer what they always did: no departments, no attributes, no canEdit on the wire;
 *   declared   the owner sets departments and attributes (merged per key); a member cannot; an undeclared department
 *              or a value of the wrong type is refused; a member reads everyone's departments and only their own
 *              attributes; list_roster names the departments in the profile's words; the identity snapshot
 *              (agent/lib/people-directory.ts) built from A's rows read under RLS;
 *   isolation  workspace B reads none of A's people or their fields through the roster, the dossier, the tools or the
 *              rows under RLS, and cannot write them.
 *
 * Needs ADMIN_URL and DATABASE_URL (app_rw).
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        if (s.startsWith("#lib/")) s = ROOT + "agent/lib/" + s.slice(5);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) {
            try { return await n(s + ".ts", c); } catch { return await n(s + ".js", c); }
          }
          throw e;
        }
      }`),
  import.meta.url,
);

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("people-data-db-probe: needs ADMIN_URL and DATABASE_URL");
  process.exit(2);
}
for (const name of ["BLOB_READ_WRITE_TOKEN", "POSTGRES_URL"]) delete process.env[name];
process.env.DATAROOM_DIR = mkdtempSync(join(tmpdir(), "people-data-db-"));
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const { PEOPLE } = await import(root("agent/lib/people-catalogue.ts"));
const DECLARED = PEOPLE.hasDepartments && PEOPLE.hasAttributes;
const LABEL = DECLARED ? "declared" : "default";
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
const app = postgres(appUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });

let failures = 0;
let passed = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   [${LABEL}] ${what}`);
  } else {
    failures++;
    console.log(`  FAIL [${LABEL}] ${what}${detail === undefined ? "" : ` — ${(typeof detail === "string" ? detail : JSON.stringify(detail))?.slice(0, 900)}`}`);
  }
};
/** Equal as values: object keys in any order (jsonb hands them back in its own), arrays in theirs. */
const same = (a, b) => {
  const sorted = (o) => (Array.isArray(o) ? o.map(sorted) : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sorted(o[k])])) : o);
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};

const TAG = `${process.pid}-${LABEL}`;
const A = `org-people-a-${TAG}`;
const B = `org-people-b-${TAG}`;
// Workspace A: an owner, an admin, a member, and two people on the roster only. Workspace B: its owner and a member.
const OWN = `own-${TAG}@people-a.test`;
const ADM = `adm-${TAG}@people-a.test`;
const MEM = `mem-${TAG}@people-a.test`;
const X1 = `x1-${TAG}@people-a.test`;
const X2 = `x2-${TAG}@people-a.test`;
const BEN = `ben-${TAG}@people-b.test`;
const BOB = `bob-${TAG}@people-b.test`;
// Archived from A's roster but still one of its signed-in people, with a stored line to Y (live on the roster).
const ARC = `arc-${TAG}@people-a.test`;
const Y = `y-${TAG}@people-a.test`;

async function cleanup() {
  await admin.unsafe(`DELETE FROM people_roster WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  await admin.unsafe(`DELETE FROM org_members WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
}

const closers = [];
try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'People A', 'active'), (${B}, 'People B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${A}, ${OWN}, 'owner'), (${A}, ${ADM}, 'admin'), (${A}, ${MEM}, 'member'), (${A}, ${ARC}, 'member'), (${B}, ${BEN}, 'owner'), (${B}, ${BOB}, 'member')`;
  await admin`INSERT INTO people_roster (email, org_id, name) VALUES (${OWN}, ${A}, 'Own'), (${MEM}, ${A}, 'Mem'), (${X1}, ${A}, 'X one'), (${X2}, ${A}, 'X two'), (${BEN}, ${B}, 'Ben'), (${BOB}, ${B}, 'Bob'), (${Y}, ${A}, 'Y')`;
  await admin`INSERT INTO people_roster (email, org_id, name, manager_email, archived_at) VALUES (${ARC}, ${A}, 'Archived', ${Y}, now())`;

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import(root("lib/auth-session.ts"));
  const agentDb = await import(root("agent/lib/db/index.ts"));
  closers.push(() => agentDb.closeDb?.());
  const everyone = [OWN, ADM, MEM, BEN, BOB];
  const bearers = Object.fromEntries(await Promise.all(everyone.map(async (p) => [p, `Bearer ${await mintSessionToken(p)}`])));
  const orgOf = { [OWN]: A, [ADM]: A, [MEM]: A, [BEN]: B, [BOB]: B };
  const H = "http://people.test";
  const call = async (who, method, path, { body, params } = {}) => {
    const file = path === "/api/ops/roster" ? "app/api/ops/roster/route.ts" : path === "/api/ops/roster/bulk" ? "app/api/ops/roster/bulk/route.ts" : "app/api/ops/people/[email]/route.ts";
    const handlers = await import(root(file));
    const request = new NextRequest(`${H}${path}`, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handlers[method](request, params ? { params: Promise.resolve(params) } : undefined);
    const out = await res.text();
    let json = null;
    try { json = JSON.parse(out); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
  const roster = (who) => call(who, "GET", "/api/ops/roster");
  const post = (who, body) => call(who, "POST", "/api/ops/roster", { body });
  const dossier = (who, email) => call(who, "GET", `/api/ops/people/${encodeURIComponent(email)}`, { params: { email: encodeURIComponent(email) } });
  const tools = await import(root("agent/lib/roster-tools.ts"));
  const ctxFor = (email) => ({ session: { id: `sess-${TAG}-${email}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email } } } } });
  const tool = async (t, input, who) => Promise.resolve().then(() => t.execute(input, ctxFor(who))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  // The roster is keyed by (org_id, email) (drizzle/0049): a row is read in the workspace it belongs to, A unless named.
  const rowOf = async (email, org = A) => (await admin`SELECT org_id, team, manager_email, departments, attributes FROM people_roster WHERE org_id = ${org} AND email = ${email}`)[0];
  const snapshotA = async () => JSON.stringify(await admin`SELECT to_jsonb(x) - 'updated_at' AS r FROM people_roster x WHERE org_id = ${A} ORDER BY email`);
  const asOrg = (org, fn) => app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${org}, true)`;
    return fn(tx);
  });

  // ------------------------------------------------------------------------------------------- the reporting line
  {
    const before = await snapshotA();
    const byMember = await post(MEM, { email: X1, managerEmail: OWN });
    check("a member setting who someone reports to: 403, nothing stored", byMember.status === 403 && /owner or an admin/.test(byMember.body?.error ?? "") && (await snapshotA()) === before, byMember);
    const selfByMember = await post(MEM, { email: MEM, managerEmail: OWN });
    check("…their own line too: 403, nothing stored", selfByMember.status === 403 && (await snapshotA()) === before, selfByMember);
    const team = await post(MEM, { email: X1, team: "platform" });
    check("a member still sets a team, as before (200)", team.status === 200 && (await rowOf(X1)).team === "platform", team);
    const after = await snapshotA();
    const outsider = await post(OWN, { email: X1, managerEmail: BEN });
    check("the owner naming a person of workspace B as supervisor: 400, nothing stored", outsider.status === 400 && /is not in this workspace/.test(outsider.body?.error ?? "") && (await snapshotA()) === after, outsider);
    const stranger = await post(OWN, { email: X1, managerEmail: `nobody-${TAG}@people-a.test` });
    check("…someone of no workspace: 400, nothing stored", stranger.status === 400 && (await snapshotA()) === after, stranger);
    const self = await post(OWN, { email: X1, managerEmail: X1 });
    check("…the person themself: 400, nothing stored", self.status === 400 && /cannot report to themselves/.test(self.body?.error ?? "") && (await snapshotA()) === after, self);
    const ok1 = await post(OWN, { email: X1, managerEmail: X2 });
    const ok2 = await post(ADM, { email: X2, managerEmail: OWN });
    check("the owner and an admin set lines inside the workspace (200): x1 → x2 → owner", ok1.status === 200 && ok2.status === 200 && (await rowOf(X1)).manager_email === X2 && (await rowOf(X2)).manager_email === OWN, { ok1, ok2 });
    const signedIn = await post(OWN, { email: MEM, managerEmail: ADM });
    check("…to a signed-in person not on the roster (an admin): 200", signedIn.status === 200 && (await rowOf(MEM)).manager_email === ADM, signedIn);
    const loopBefore = await snapshotA();
    const loop2 = await post(OWN, { email: X2, managerEmail: X1 });
    check("a two-person loop (x2 → x1 while x1 → x2): 400, nothing stored", loop2.status === 400 && /reporting loop/.test(loop2.body?.error ?? "") && (await snapshotA()) === loopBefore, loop2);
    const loop3 = await post(OWN, { email: OWN, managerEmail: X1 });
    check("a three-person loop through stored lines (owner → x1 → x2 → owner): 400, nothing stored", loop3.status === 400 && /reporting loop/.test(loop3.body?.error ?? "") && (await snapshotA()) === loopBefore, loop3);
    const bulkLoop = await call(OWN, "POST", "/api/ops/roster/bulk", { body: { people: [{ email: OWN, managerEmail: X1 }] } });
    check("a bulk import closing a loop with the stored lines: 400, nothing stored", bulkLoop.status === 400 && /reporting loop/.test(bulkLoop.body?.error ?? "") && (await snapshotA()) === loopBefore, bulkLoop);
    const bulkOut = await call(OWN, "POST", "/api/ops/roster/bulk", { body: { people: [{ email: `new-${TAG}@people-a.test`, managerEmail: BOB }] } });
    check("a bulk import naming a supervisor of workspace B: 400, nothing stored", bulkOut.status === 400 && /is not in this workspace/.test(bulkOut.body?.error ?? "") && (await snapshotA()) === loopBefore, bulkOut);
    const bulkNew = await call(OWN, "POST", "/api/ops/roster/bulk", { body: { people: [{ email: `new-${TAG}@people-a.test`, managerEmail: `lead-${TAG}@people-a.test` }, { email: `lead-${TAG}@people-a.test`, managerEmail: OWN }] } });
    check("a bulk import whose supervisor it adds in the same sheet: 200", bulkNew.status === 200 && (await rowOf(`new-${TAG}@people-a.test`))?.manager_email === `lead-${TAG}@people-a.test`, bulkNew);

    const arcLoop = await post(OWN, { email: Y, managerEmail: ARC });
    check("a loop through an ARCHIVED person's stored line (arc → y, then y → arc; arc still signed in): 400, nothing stored", arcLoop.status === 400 && /reporting loop/.test(arcLoop.body?.error ?? "") && (await rowOf(Y)).manager_email === null, arcLoop);
    const arcBulk = await call(OWN, "POST", "/api/ops/roster/bulk", { body: { people: [{ email: Y, managerEmail: ARC }] } });
    check("…and through a bulk import: 400, nothing stored", arcBulk.status === 400 && /reporting loop/.test(arcBulk.body?.error ?? "") && (await rowOf(Y)).manager_email === null, arcBulk);

    const toolByMember = await tool(tools.upsertRosterMemberTool, { email: X1, managerEmail: OWN }, MEM);
    check("the model's upsert_roster_member for a member: refused in a sentence that says why, nothing stored", /owner or an admin can set who someone reports to; .* holds neither role here/.test(toolByMember.error ?? "") && /Nothing was changed\./.test(toolByMember.error ?? "") && (await rowOf(X1)).manager_email === X2, toolByMember);
    // A run with no person behind it (a schedule, a workflow or app step) names its workspace and has no role there.
    const service = { session: { id: `sess-${TAG}-service`, auth: { current: { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: { workspace_scope: A } } } } };
    const toolByService = await Promise.resolve().then(() => tools.upsertRosterMemberTool.execute({ email: X1, managerEmail: OWN }, service)).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    check("…for a run with no person behind it: refused, saying so plainly, nothing stored", /no person behind it/.test(toolByService.error ?? "") && (await rowOf(X1)).manager_email === X2, toolByService);
    const teamByService = await Promise.resolve().then(() => tools.upsertRosterMemberTool.execute({ email: X1, team: "svc" }, service)).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    check("…which still sets a team, as before", teamByService.ok === true && (await rowOf(X1)).team === "svc", teamByService);
    const toolLoop = await tool(tools.upsertRosterMemberTool, { email: X2, managerEmail: X1 }, OWN);
    check("…for the owner, closing a loop: refused, nothing stored", /reporting loop/.test(toolLoop.error ?? "") && (await rowOf(X2)).manager_email === OWN, toolLoop);
    const toolOut = await tool(tools.upsertRosterMemberTool, { email: X1, managerEmail: BEN }, OWN);
    check("…for the owner, a supervisor of workspace B: refused, nothing stored", /is not in this workspace/.test(toolOut.error ?? "") && (await rowOf(X1)).manager_email === X2, toolOut);
    const toolTeam = await tool(tools.upsertRosterMemberTool, { email: X1, team: "core" }, MEM);
    check("…a member setting only a team, as before", toolTeam.ok === true && (await rowOf(X1)).team === "core", toolTeam);
    const toolOk = await tool(tools.upsertRosterMemberTool, { email: MEM, managerEmail: OWN }, OWN);
    check("…the owner inside the workspace", toolOk.ok === true && (await rowOf(MEM)).manager_email === OWN, toolOk);
  }

  // ------------------------------------------------------------------------------------------------ default
  if (!DECLARED) {
    const r = await roster(MEM);
    check("GET /api/ops/roster: today's keys, no departments, attributes or canEdit", r.status === 200 && !("canEdit" in r.body) && r.body.items.every((i) => same(Object.keys(i), ["email", "name", "team", "managerEmail", "escalations"])), r.body);
    const p = await post(OWN, { email: X1, name: "X uno" });
    check("POST answers the row without the new columns", p.status === 200 && !("departments" in p.body.item) && !("attributes" in p.body.item), p.body);
    const dept = await post(OWN, { email: X1, departments: ["north"] });
    check("a department when none is declared: 400, nothing stored", dept.status === 400 && same((await rowOf(X1)).departments, []), dept);
    const attr = await post(OWN, { email: X1, attributes: { grade: "g1" } });
    check("an attribute when none is declared: 400, nothing stored", attr.status === 400 && same((await rowOf(X1)).attributes, {}), attr);
    const d = await dossier(MEM, X1);
    check("the dossier carries no departments or attributes", d.status === 200 && d.body.found === true && !("departments" in d.body) && !("attributes" in d.body), d.body);
    const l = await tool(tools.listRosterTool, {}, MEM);
    check("list_roster: today's keys", Array.isArray(l.roster) && l.roster.every((x) => same(Object.keys(x), ["email", "name", "team", "managerEmail"])), l);
  }

  // ------------------------------------------------------------------------------------------------ declared
  if (DECLARED) {
    const set = await post(OWN, { email: X1, departments: ["south", "north"], attributes: { grade: "g1", languages: ["en"], on_call: true, desk_phone: "101" } });
    check("the owner sets departments and attributes (200), stored canonical (departments in the profile's order)", set.status === 200 && same((await rowOf(X1)).departments, ["north", "south"]) && same((await rowOf(X1)).attributes, { grade: "g1", languages: ["en"], on_call: true, desk_phone: "101" }), set);
    await admin`UPDATE people_roster SET attributes = attributes || '{"kept_by_someone": 1}'::jsonb WHERE email = ${X1}`;
    const merge = await post(ADM, { email: X1, attributes: { grade: "g2", on_call: null } });
    const merged = (await rowOf(X1)).attributes;
    check("an admin's patch merges per key: set, cleared, and a key it does not name kept", merge.status === 200 && same(Object.keys(merged).sort(), ["desk_phone", "grade", "kept_by_someone", "languages"]) && merged.grade === "g2", { merge, merged });
    const memBefore = await snapshotA();
    const mDept = await post(MEM, { email: X1, departments: ["north"] });
    const mAttr = await post(MEM, { email: MEM, attributes: { grade: "g1" } });
    check("a member setting departments or attributes (even their own): 403, nothing stored", mDept.status === 403 && mAttr.status === 403 && (await snapshotA()) === memBefore, { mDept, mAttr });
    const unknown = await post(OWN, { email: X1, departments: ["east"] });
    const wrong = await post(OWN, { email: X1, attributes: { on_call: "yes" } });
    const undeclared = await post(OWN, { email: X1, attributes: { salary: 1 } });
    check("an undeclared department, a value of the wrong type, an undeclared attribute: 400, nothing stored", unknown.status === 400 && wrong.status === 400 && undeclared.status === 400 && (await snapshotA()) === memBefore, { unknown, wrong, undeclared });
    await post(OWN, { email: MEM, attributes: { grade: "g1" } });
    const asMem = await roster(MEM);
    const x1m = asMem.body?.items?.find((i) => i.email === X1);
    const memm = asMem.body?.items?.find((i) => i.email === MEM);
    check("a member reads everyone's departments, only their own attributes, and canEdit false", asMem.status === 200 && asMem.body.canEdit === false && same(x1m?.departments, ["north", "south"]) && !("attributes" in x1m) && same(memm?.attributes, { grade: "g1" }), asMem.body);
    const asOwn = await roster(OWN);
    const x1o = asOwn.body?.items?.find((i) => i.email === X1);
    check("the owner reads every attribute (declared keys only) and canEdit true", asOwn.body?.canEdit === true && same(x1o?.attributes, { grade: "g2", languages: ["en"], desk_phone: "101" }), asOwn.body);
    const dm = await dossier(MEM, X1);
    const dO = await dossier(OWN, X1);
    check("the dossier: departments for a member, attributes for the owner only", same(dm.body?.departments, ["north", "south"]) && !("attributes" in dm.body) && same(dO.body?.attributes, { grade: "g2", languages: ["en"], desk_phone: "101" }), { dm: dm.body, dO: dO.body });
    const memSet = await post(MEM, { email: X1, team: "ops" });
    check("a member's own write answers the row without others' attributes", memSet.status === 200 && !("attributes" in memSet.body.item) && same(memSet.body.item.departments, ["north", "south"]), memSet.body);
    const l = await tool(tools.listRosterTool, {}, MEM);
    check("list_roster names each person's departments in the profile's words", same(l.roster?.find((x) => x.email === X1)?.departments, ["North desk", "South desk"]) && same(l.roster?.find((x) => x.email === X2)?.departments, []), l);
    const { identitySnapshot } = await import(root("agent/lib/people-directory.ts"));
    await asOrg(A, (tx) => tx`UPDATE people_roster SET manager_email = ${ARC} WHERE email = ${X2}`);
    const rows = await asOrg(A, (tx) => tx`SELECT org_id AS "orgId", email, name, manager_email AS "managerEmail", departments, attributes, archived_at AS "archivedAt" FROM people_roster`);
    const members = await app`SELECT org_id AS "orgId", email, role FROM org_members WHERE org_id = ${A}`;
    const snap = identitySnapshot(A, rows, members);
    const sx1 = snap.users.find((u) => u.id === X1);
    check("the identity snapshot from A's rows read under RLS: A's people only, departments, attributes, lines", rows.every((r) => r.orgId === A) && !JSON.stringify(snap).includes("people-b.test") && sx1?.department === "north" && sx1?.grade === "g2" && same(sx1?.reporting_managers, [X2]) && snap.users.find((u) => u.id === OWN)?.role === "owner", snap);
    const sArc = snap.users.find((u) => u.id === ARC);
    check("…an archived roster row is not carried (signed in, they stay with their role only), nor any line from or to them", same(sArc, { id: ARC, organization_id: A, email: ARC, role: "member", employment_status_active: true }) && snap.reporting.every((r) => r.reportee !== ARC && r.reporting_manager !== ARC) && snap.users.find((u) => u.id === X2)?.reporting_managers === undefined, { sArc, reporting: snap.reporting });
  }

  // ------------------------------------------------------------------------------------------------ isolation
  {
    const aBefore = await snapshotA();
    const bRoster = await roster(BEN);
    check("B's roster holds none of A's people", bRoster.status === 200 && bRoster.body.items.every((i) => i.email.endsWith("@people-b.test")) && !JSON.stringify(bRoster.body).includes("people-a.test"), bRoster.body);
    const bDossier = await dossier(BEN, X1);
    check("B's dossier of A's person finds nothing of A (no team, line, departments or attributes)", bDossier.status === 200 && bDossier.body.found === false && bDossier.body.managerEmail === null && bDossier.body.team === null && !(bDossier.body.departments ?? []).length && !("attributes" in bDossier.body), bDossier.body);
    const bTool = await tool(tools.listRosterTool, {}, BEN);
    check("B's list_roster holds none of A's people", Array.isArray(bTool.roster) && !JSON.stringify(bTool).includes("people-a.test"), bTool);
    const bLine = await post(BEN, { email: BOB, managerEmail: X1 });
    check("B's owner naming A's person as supervisor: 400", bLine.status === 400 && /is not in this workspace/.test(bLine.body?.error ?? ""), bLine);
    const bWrite = await post(BEN, { email: X1, ...(DECLARED ? { departments: ["north"], attributes: { grade: "g1" } } : { team: "taken" }) });
    // The roster's key is (org_id, email) (drizzle/0049): B adding an email A holds writes B's OWN row, and A's row is
    // untouched. B's answer carries only what B wrote.
    const bRow = await rowOf(X1, B);
    check("B's owner writing A's person's email: 200, B's own row, A's rows untouched", bWrite.status === 200 && bRow?.org_id === B && (DECLARED ? same(bRow.departments, ["north"]) && same(bRow.attributes, { grade: "g1" }) : bRow.team === "taken") && (await rowOf(X1)).org_id === A && (await snapshotA()) === aBefore && bWrite.body?.item?.name == null, { bWrite, bRow });
    const bAgain = await roster(BEN);
    check("…B's roster now lists that email once, as B's (B's team, not A's)", bAgain.body.items.filter((i) => i.email === X1).length === 1 && (DECLARED || bAgain.body.items.find((i) => i.email === X1)?.team === "taken"), bAgain.body);
    await admin`DELETE FROM people_roster WHERE org_id = ${B} AND email = ${X1}`;
    const seen = await asOrg(B, (tx) => tx`SELECT email, departments, attributes FROM people_roster WHERE org_id = ${A}`);
    const changed = await asOrg(B, (tx) => tx`UPDATE people_roster SET departments = '["north"]'::jsonb, attributes = '{"planted": true}'::jsonb WHERE org_id = ${A} RETURNING email`);
    const unscoped = await asOrg(B, (tx) => tx`SELECT email FROM people_roster WHERE email = ${X1}`);
    check("under RLS, app_rw in B sees and changes none of A's rows (departments and attributes included)", seen.length === 0 && changed.length === 0 && unscoped.length === 0 && (await snapshotA()) === aBefore, { seen: seen.length, changed: changed.length, unscoped: unscoped.length });
    const ownSide = await asOrg(A, (tx) => tx`SELECT email FROM people_roster WHERE email = ${X1}`);
    check("…while A's own scope reads the row (the policy is not simply empty)", ownSide.length === 1);
  }
} catch (e) {
  failures++;
  console.log(`  FAIL [${LABEL}] the probe threw — ${e?.stack ?? e}`);
} finally {
  await cleanup().catch(() => undefined);
  for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
  await app.end({ timeout: 2 }).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`people-data-db-probe [${LABEL}]: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

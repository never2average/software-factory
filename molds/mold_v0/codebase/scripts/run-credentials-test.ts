// Credentials and egress for runs (mold_v0-075; src/credentials.ts, src/egress-hosts.ts, src/run-harness.ts), offline:
// an embedded database, the HTTP API behind a fake Clerk, the runs' own egress proxy, no network.
//   npm run test:run-credentials
//
//  1. Declarations: a file credential's path variable (path_env) is checked like a variable (never one the shell sets,
//     never shared with another field); an operator credential is declared by the pack and named by the kind; a name
//     is a workspace's or an operator's, not both.
//  2. A file credential's path in a declared variable: KUBECONFIG and a pack's own locator (PROD_RO_KUBECONFIG) hold the
//     full path of the value's file (0400, the run user's, in the run's private directory); gone after the run.
//  3. Operator credentials: from the platform's key vault (pack_credentials, "<pack>.<name>"), delivered to the kinds
//     that name them (and to no other kind, nor another pack's kind of the same name); never listed to the workspace;
//     printed, in stderr or in results: redacted; written into the workspace: not written back.
//  4. Per-company egress hosts: validated (no address in any notation, no local or internal name, not the platform's
//     own, not one resolving to a private address); set by an owner only, for the workspace or one of its own assets;
//     a run of a kind with company_egress reaches its workspace's hosts and those of the asset it targets, each exactly
//     (not a subdomain), through its proxy; never another workspace's or another asset's; a kind without it, none.
//  5. Hosts reached only with a credential (mold_v0-184, credential_egress): declared with the kind's own credentials
//     only; a run whose workspace holds no value of that credential gets the kind's egress alone; one whose workspace
//     set it gets the declared hosts too (with subdomains, as egress); another workspace's value opens nothing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";
import type { Resolver } from "../src/egress-hosts.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const FIX = path.join(ROOT, "scripts", "fixtures", "run-access");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack } = await import("../src/pack-api.js");
  const harness = await import("../src/run-harness.js");
  const runs = await import("../src/runs.js");
  const creds = await import("../src/credentials.js");
  const eh = await import("../src/egress-hosts.js");
  const rec = await import("../src/record-areas.js");
  const kv = await import("../src/keyvault.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Access A ${STAMP}`)).org, B = (await createOrg(`Access B ${STAMP}`)).org;

  // ---------- 1. declarations ----------
  {
    const area = { name: "pk_apps", label: "Apps", role: "asset", scope: "workspace", fields: [{ name: "url", label: "URL" }] };
    const pack = (x: Record<string, unknown>) => definePack({ id: "pk", recordAreas: [area as never], ...x } as never);
    const file = (n: string, f: string, pe?: string) => ({ name: n, label: n, bound_to: "workspace", deliver_as: { file: f, ...(pe ? { path_env: pe } : {}) } });
    assert.doesNotThrow(() => pack({ credentials: [file("kube", "kubeconfig", "KUBECONFIG"), file("prod", "prod.yaml", "PROD_RO_KUBECONFIG")] }));
    for (const pe of ["PATH", "RUN_CREDENTIALS_DIR", "HOME", "LD_PRELOAD", "kubeconfig"]) assert.throws(() => pack({ credentials: [file("kube", "kubeconfig", pe)] }), /environment/, pe);
    assert.throws(() => pack({ credentials: [file("kube", "kubeconfig", "KUBECONFIG"), { name: "tok", label: "t", bound_to: "workspace", deliver_as: { env: "KUBECONFIG" } }] }), /both deliver to env KUBECONFIG/);
    const op = { name: "catalogue_login", label: "Catalogue login", deliver_as: { env: "CATALOGUE_LOGIN" } };
    const k = (x: Record<string, unknown> = {}) => ({ name: "kk", runner: "workspace-harness", entry: "x.mjs", ...x });
    assert.doesNotThrow(() => pack({ operatorCredentials: [op], jobKinds: [k({ operator_credentials: ["catalogue_login"] }), k({ name: "k2", company_egress: true })] }));
    // (review) an operator's credential never goes where a workspace chose: not with company_egress, either runner.
    assert.throws(() => pack({ operatorCredentials: [op], jobKinds: [k({ operator_credentials: ["catalogue_login"], company_egress: true })] }), /cannot take company_egress/);
    assert.throws(() => pack({ operatorCredentials: [op], agentJobKinds: [{ name: "ak", runner: "agent-workspace", operator_credentials: ["catalogue_login"], company_egress: true,
      agent: { repository: "https://example.com/a.git", commit: "a".repeat(40), command: ["node", "a.mjs"], validate: { command: ["node", "v.mjs"] }, write_back: ["data"] } }] }), /cannot take company_egress/);
    assert.throws(() => pack({ operatorCredentials: [op], jobKinds: [k({ operator_credentials: ["nope"] })] }), /names operator credential nope/);
    assert.throws(() => pack({ jobKinds: [k({ operator_credentials: ["catalogue_login"] })] }), /names operator credential catalogue_login/);
    assert.throws(() => pack({ operatorCredentials: [op], credentials: [{ name: "catalogue_login", label: "x", bound_to: "workspace", deliver_as: { env: "OTHER_X" } }] }), /both as a workspace's and as an operator's/);
    assert.throws(() => pack({ operatorCredentials: [op], credentials: [{ name: "tok", label: "x", bound_to: "workspace", deliver_as: { env: "CATALOGUE_LOGIN" } }] }), /both deliver to env CATALOGUE_LOGIN/);
    assert.throws(() => pack({ jobKinds: [k({ credential_egress: [{ credentials: ["nope"], hosts: ["amazonaws.com"] }] })] }), /credential_egress names a credential that is not one of the kind's credentials/);
    console.log("✓ declarations: path_env is a variable like any other (never the shell's, never shared); operator credentials declared by the pack, named by the kind; a name is one or the other");
  }

  // ---------- the fixture packs ----------
  const kind = (name: string, extra: Record<string, unknown> = {}) => ({ name, runner: "workspace-harness", entry: "access.mjs", lease_seconds: 15, max_attempts: 1, ...extra });
  const opCred = { name: "catalogue_login", label: "Compliance catalogue login", deliver_as: { env: "CATALOGUE_LOGIN" } };
  const fixture = definePack({
    id: "fixture_access",
    recordAreas: [
      { name: "access_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] },
      { name: "access_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] },
    ],
    credentials: [
      { name: "kubeconfig_ro", label: "Kubeconfig", bound_to: "workspace", deliver_as: { file: "kubeconfig", path_env: "KUBECONFIG" } },
      { name: "prod_kubeconfig", label: "Production kubeconfig", bound_to: "asset", area: "access_apps", deliver_as: { file: "prod.yaml", path_env: "PROD_RO_KUBECONFIG" } },
      { name: "cloud_key", label: "Cloud read-only key", bound_to: "workspace", deliver_as: { env: "CLOUD_RO_KEY" } },
    ],
    operatorCredentials: [opCred],
    jobKinds: [
      kind("files", { credentials: ["kubeconfig_ro", "prod_kubeconfig"] }),
      kind("catalogue", { operator_credentials: ["catalogue_login"] }),
      kind("catalogue_ws", { operator_credentials: ["catalogue_login"], workspace: true }),
      kind("plain"),
      kind("company", { egress: ["kind.agent-allowed.example"], company_egress: true }),
      kind("company_off", { egress: ["kind.agent-allowed.example"] }),
      kind("cloud", { egress: ["kind.agent-allowed.example"], credentials: ["cloud_key"], credential_egress: [{ credentials: ["cloud_key"], hosts: ["cloud-api.example"] }] }),
    ] as never,
  });
  // Another pack with an operator credential of the same name: the vault's label is per pack, so it gets none of ours.
  const other = definePack({ id: "fixture_other", operatorCredentials: [opCred], jobKinds: [kind("catalogue", { operator_credentials: ["catalogue_login"] })] as never });
  setPacksForTest([
    { manifest: { id: "fixture_access", name: "Fixture access", version: "1", entry: "index.ts", migrations: null, words: {}, dir: FIX }, definition: fixture },
    { manifest: { id: "fixture_other", name: "Fixture other", version: "1", entry: "index.ts", migrations: null, words: {}, dir: FIX }, definition: other },
  ]);
  await rec.putPlatform(null, "access_checks", "c1", { title: "A check", data: { summary: "x" } });
  for (const [o, keys] of [[A, ["app-a", "app-a2"]], [B, ["app-b"]]] as const)
    for (const k of keys) await withTenant(o.orgId, () => rec.workspaceRecords("fixture_access", o.orgId).put("access_apps", k, { title: k, data: { url: `https://${k}.example` } }));
  const V = { KUBE: `kube-${STAMP}-apiVersion: v1 clusters: []`, PROD: `prod-${STAMP}-apiVersion: v1 contexts: []`, LOGIN: `catalogue-${STAMP}-s3cr3t-0123456789` };
  await creds.setCredential(A.orgId, null, { pack: "fixture_access", name: "kubeconfig_ro", value: V.KUBE });
  await creds.setCredential(A.orgId, null, { pack: "fixture_access", name: "prod_kubeconfig", asset: "app-a", value: V.PROD });
  await kv.setCredential(creds.OPERATOR_CREDENTIAL_PROVIDER, V.LOGIN, { label: creds.operatorVaultLabel("fixture_access", "catalogue_login") });

  const http = await startHttp();
  const client = await harness.localRunnerClient("w-access");
  const asRoot = process.getuid?.() === 0;
  const iso = asRoot ? {} : { allowSameUser: true };
  const ev = async (id: string, type: string) => (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = $2 ORDER BY id", [id, type])).map((e) => e.data);
  const everything = async (id: string) => JSON.stringify(await db.query("SELECT type, data FROM run_events WHERE run_id = $1", [id])) +
    JSON.stringify(await db.query("SELECT * FROM run_results WHERE run_id = $1", [id])) + JSON.stringify(await db.query("SELECT error FROM runs WHERE id = $1", [id]));
  const runIt = async (orgId: number, pack: string, k: string, input: { scope?: Record<string, unknown>; targets?: Record<string, unknown> } = {}, opts: Record<string, unknown> = {}) => {
    const r = await runs.startRun(orgId, pack, k, input);
    const c = await client.claim([`${pack}/${k}`]);
    assert.equal(c?.run.id, r.id);
    const view = await harness.runWorkspaceHarness(client, c!, { egress: "off", packDir: () => FIX, ...iso, ...opts });
    return { id: r.id, view, claim: c! };
  };

  try {
    // ---------- 2. a file credential's path in a declared variable ----------
    {
      const r = await runIt(A.orgId, "fixture_access", "files", { targets: { asset: { area: "access_apps", key: "app-a" } } });
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      const [a] = await ev(r.id, "access");
      assert.equal(a.kube.sha, sha(V.KUBE), "KUBECONFIG names the file that holds the kubeconfig");
      assert.equal(a.prod.sha, sha(V.PROD), "a pack's own locator (PROD_RO_KUBECONFIG) names the asset's file");
      assert.ok(a.kube.in_dir && a.prod.in_dir && path.dirname(a.kube.path) === a.cred_dir, "both in the run's private directory (RUN_CREDENTIALS_DIR)");
      assert.equal(a.kube.mode, "400");
      if (asRoot) assert.equal(a.kube.uid, (await ev(r.id, "run_user"))[0].uid, "the run user's own file");
      assert.ok(!existsSync(a.kube.path) && !existsSync(a.cred_dir), "gone once the run ended");
      // An asset with no value: the variable is not set (the field is missing), never a path to nothing.
      const n = await runIt(A.orgId, "fixture_access", "files", { targets: { asset: { area: "access_apps", key: "app-a2" } } });
      const [na] = await ev(n.id, "access");
      assert.equal(na.prod, null); assert.equal(na.kube.sha, sha(V.KUBE));
      assert.deepEqual((await ev(n.id, "credentials"))[0].missing, ["prod_kubeconfig"]);
      const all = await everything(r.id);
      for (const v of [V.KUBE, V.PROD]) assert.ok(!all.includes(v));
      console.log("✓ a file credential's full path in its declared variable (KUBECONFIG, PROD_RO_KUBECONFIG): 0400, the run user's, in the run's private directory, gone after; unset when the field has no value");
    }

    // ---------- 3. operator credentials ----------
    {
      const r = await runIt(A.orgId, "fixture_access", "catalogue", { scope: { mode: "print" } });
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      assert.equal((await ev(r.id, "access"))[0].op, sha(V.LOGIN), "the kind that names it receives the operator's value");
      const all = await everything(r.id);
      assert.ok(!all.includes(V.LOGIN), "never in the run's events, stderr or error");
      assert.ok(all.includes("login is [credential catalogue_login]"), "printed: redacted");
      assert.deepEqual((await ev(r.id, "credentials"))[0], { delivered: ["catalogue_login"], missing: [] });
      const res = await runIt(A.orgId, "fixture_access", "catalogue", { scope: { mode: "print_results" } });
      assert.equal(res.view?.status, "succeeded", JSON.stringify(res.view));
      assert.ok(!(await everything(res.id)).includes(V.LOGIN), "nor in its results");
      // Written into the workspace: never written back (the store would keep it, and the workspace would read it).
      const w = await runIt(B.orgId, "fixture_access", "catalogue_ws", { scope: { mode: "leak_ws" } });
      assert.equal(w.view?.status, "failed"); assert.match(w.view!.error!, /holds the value of credential catalogue_login: it is not written back/);
      // Not to a kind that does not name it, nor to another pack's kind of the same name.
      const p = await runIt(A.orgId, "fixture_access", "plain");
      assert.equal((await ev(p.id, "access"))[0].op, null);
      const o = await runIt(A.orgId, "fixture_other", "catalogue");
      assert.equal((await ev(o.id, "access"))[0].op, null, "another pack's kind gets none of this pack's operator credential");
      assert.deepEqual((await ev(o.id, "credentials"))[0].missing, ["operator:catalogue_login"]);
      // Never listed to a workspace: the console's fields are the workspace's own.
      const listed = await creds.listCredentials(A.orgId);
      assert.ok(!JSON.stringify(listed).includes("catalogue_login"), "the console lists no operator credential");
      const ownerA = await http.signIn(A, "owner");
      const seen = await (await http.req("GET", "/api/credentials", { authorization: `Bearer ${ownerA}` })).text();
      assert.ok(!seen.includes("catalogue_login") && !seen.includes(V.LOGIN.slice(-4)), "nor does /api/credentials (no name, no last characters)");
      console.log("✓ operator credentials: from the platform's vault to the kinds that name them only (not another pack's); redacted when printed or in results; refused in the workspace; never listed to the workspace");
    }

    // ---------- 4. per-company egress hosts ----------
    {
      const pub: Resolver = async () => ["93.184.216.34"], priv: Resolver = async () => ["10.1.2.3"], meta: Resolver = async () => ["169.254.169.254"];
      assert.deepEqual(await eh.checkCompanyHost(" API.Company-A.example ", pub), { host: "api.company-a.example", resolved: true });
      for (const bad of ["10.0.0.1", "127.0.0.1", "0x7f.0.0.1", "2130706433", "[::1]", "::1", "localhost", "a.localhost", "x.local", "metadata.google.internal", "db.corp", "a.home.arpa",
        "1.0.0.10.in-addr.arpa", "host.example:443", "*.company.example", "company.example.", "https://company.example", "user@company.example", "a..b.example", "single", "-x.example", "x_y.example", ""])
        await assert.rejects(eh.checkCompanyHost(bad, pub), /host/, `refused: ${bad}`);
      await assert.rejects(eh.checkCompanyHost("rebind.company.example", priv), /resolves to a private or reserved address/);
      await assert.rejects(eh.checkCompanyHost("meta.company.example", meta), /resolves to a private or reserved address/);
      const pu = process.env.PUBLIC_URL;
      process.env.PUBLIC_URL = "https://app.platform.example";
      for (const own of ["app.platform.example", "x.app.platform.example", "platform.example"]) await assert.rejects(eh.checkCompanyHost(own, pub), /the platform's own/, own);
      if (pu === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = pu;
      const ownerA = await http.signIn(A, "owner"), memberA = await http.signIn(A), ownerB = await http.signIn(B, "owner");
      const put = async (tok: string, body: unknown) => { const r = await http.req("PUT", "/api/egress-hosts", { authorization: `Bearer ${tok}` }, body); return { status: r.status, body: await r.json() }; };
      assert.equal((await put(memberA, { pack: "fixture_access", host: "api.company-a.example" })).status, 403, "a member does not set hosts");
      assert.equal((await put(ownerA, { pack: "fixture_access", host: "10.0.0.1" })).status, 400);
      assert.equal((await put(ownerA, { pack: "fixture_access", host: "api.company-a.example" })).status, 200);
      assert.equal((await put(ownerA, { pack: "fixture_access", host: "app-a.company-a.example", asset: { area: "access_apps", key: "app-a" } })).status, 200);
      assert.equal((await put(ownerA, { pack: "fixture_access", host: "app-a2.company-a.example", asset: { area: "access_apps", key: "app-a2" } })).status, 200);
      assert.equal((await put(ownerA, { pack: "fixture_access", host: "x.company-a.example", asset: { area: "access_apps", key: "app-b" } })).status, 404, "never for another workspace's asset");
      assert.equal((await put(ownerB, { pack: "fixture_access", host: "api.company-b.example" })).status, 200);
      const listedA = await (await http.req("GET", "/api/egress-hosts", { authorization: `Bearer ${memberA}` })).json();
      assert.deepEqual(listedA.hosts.map((h: { host: string }) => h.host).sort(), ["api.company-a.example", "app-a.company-a.example", "app-a2.company-a.example"], "each workspace sees its own");

      const hosts = ["api.company-a.example", "x.api.company-a.example", "app-a.company-a.example", "app-a2.company-a.example", "api.company-b.example", "x.kind.agent-allowed.example"];
      let log = "";
      const r = await runIt(A.orgId, "fixture_access", "company", { scope: { mode: "egress", hosts }, targets: { asset: { area: "access_apps", key: "app-a" } } }, { egress: "proxy", onProxyLog: (l: string) => (log = l) });
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      assert.deepEqual(r.claim.egress.exact, ["api.company-a.example", "app-a.company-a.example"], "the workspace's hosts and the targeted asset's, no other");
      assert.ok(!r.claim.egress.hosts.some((h) => h.includes("company")), "never as a host with subdomains");
      const why = (h: string) => log.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((d) => d.deny?.startsWith(`${h}:`) || d.allow === h)?.why;
      // Offline nothing resolves: a host past the allowlist is denied for "dns"; one not on it, "host not allowed".
      assert.equal(why("api.company-a.example"), "dns", "the workspace's host passes the allowlist");
      assert.equal(why("app-a.company-a.example"), "dns", "and the targeted asset's");
      assert.equal(why("x.api.company-a.example"), "host not allowed", "exactly: not a subdomain");
      assert.equal(why("app-a2.company-a.example"), "host not allowed", "not another asset's");
      assert.equal(why("api.company-b.example"), "host not allowed", "never another workspace's");
      assert.equal(why("x.kind.agent-allowed.example"), "dns", "(the kind's own egress still allows its subdomains)");
      const off = await runIt(A.orgId, "fixture_access", "company_off", { scope: { mode: "egress", hosts: ["api.company-a.example"] }, targets: { asset: { area: "access_apps", key: "app-a" } } }, { egress: "proxy", onProxyLog: (l: string) => (log = l) });
      assert.deepEqual(off.claim.egress.exact, [], "a kind without company_egress: none");
      assert.equal(why("api.company-a.example"), "host not allowed");
      // A host stored before a rule changed (written straight to the table) is not handed out.
      await db.query("INSERT INTO workspace_egress_hosts (org_id, pack, host) VALUES ($1, 'fixture_access', '10.9.9.9'), ($1, 'fixture_access', 'x.internal')", [A.orgId]);
      const again = await runIt(A.orgId, "fixture_access", "company", { scope: { mode: "egress", hosts: [] } });
      assert.deepEqual(again.claim.egress.exact, ["api.company-a.example"], "an address or internal name in the table is dropped; no asset targeted: the workspace's only");
      console.log("✓ per-company egress: hosts validated (no address in any notation, no local or internal name, none resolving to a private address); set by owners for their own workspace and assets; a run reaches its workspace's and its asset's hosts exactly, never a subdomain, another asset's or another workspace's");
    }
    // ---------- 5. hosts reached only with a credential (mold_v0-184) ----------
    {
      let log = "";
      const hosts = ["api.cloud-api.example", "x.kind.agent-allowed.example"];
      const without = await runIt(A.orgId, "fixture_access", "cloud", { scope: { mode: "egress", hosts } }, { egress: "proxy", onProxyLog: (l: string) => (log = l) });
      const why = (h: string) => log.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((d) => d.deny?.startsWith(`${h}:`) || d.allow === h)?.why;
      assert.ok(!without.claim.egress.hosts.includes("cloud-api.example"), "no value of the credential: the kind's egress alone");
      assert.equal(why("api.cloud-api.example"), "host not allowed", "and its proxy refuses the cloud's host");
      assert.equal((await ev(without.id, "claimed"))[0].credential_hosts, undefined);
      await creds.setCredential(B.orgId, null, { pack: "fixture_access", name: "cloud_key", value: `cloud-${STAMP}-B` });
      const other = await runIt(A.orgId, "fixture_access", "cloud", { scope: { mode: "egress", hosts } });
      assert.ok(!other.claim.egress.hosts.includes("cloud-api.example"), "another workspace's value opens nothing");
      await creds.setCredential(A.orgId, null, { pack: "fixture_access", name: "cloud_key", value: `cloud-${STAMP}-A` });
      const withKey = await runIt(A.orgId, "fixture_access", "cloud", { scope: { mode: "egress", hosts } }, { egress: "proxy", onProxyLog: (l: string) => (log = l) });
      assert.ok(withKey.claim.egress.hosts.includes("cloud-api.example"), `the workspace set it: the declared host too (${withKey.claim.egress.hosts.join(", ")})`);
      assert.equal(why("api.cloud-api.example"), "dns", "its subdomain passes the allowlist (then offline, no such name)");
      assert.deepEqual((await ev(withKey.id, "claimed"))[0].credential_hosts, ["cloud-api.example"], "the claim's event names the hosts it added");
      const plain = await runIt(A.orgId, "fixture_access", "company_off", { scope: { mode: "egress", hosts: [] } });
      assert.ok(!plain.claim.egress.hosts.includes("cloud-api.example"), "a kind without credential_egress: never");
      console.log("✓ credential_egress: a kind's cloud host joins the run's allowlist only when the run's own workspace holds a value of its credential (never another workspace's), with subdomains as egress");
    }
  } finally { await http.close(); }
  await db.close();
  console.log("RUN CREDENTIALS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);

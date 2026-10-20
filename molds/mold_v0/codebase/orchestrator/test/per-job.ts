/**
 * Hermetic test of one orchestrator per job (src/autoscaler.ts per-job mode, src/fleet.ts jobFleetStatus, claim
 * filters, per-persona developer environments): real server modules on a temp PGlite + a mock boat API.
 *
 *   npx tsx orchestrator/test/per-job.ts
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "octillion-pjtest-"));
const BOAT_PORT = Number(process.env.PJTEST_BOAT_PORT ?? 3406);
let planLimit = 100;
const BOAT_KEY = `boat_mock_${randomBytes(6).toString("hex")}`;
Object.assign(process.env, {
  PGLITE_DIR: path.join(tmp, "pglite"), OCTILLION_VAULT_KEY: randomBytes(32).toString("base64"), OCTILLION_WORKER_TOKEN: `wt_${randomBytes(8).toString("hex")}`,
  PUBLIC_URL: "https://octi.example", BOAT_API_URL: `http://127.0.0.1:${BOAT_PORT}/api/v1`, OCTILLION_POD_CAPACITY: "3", OCTILLION_MAX_ORCHESTRATORS: "2",
  OCTILLION_AUTOSCALE_TICK_SECONDS: "15", OCTILLION_ORCH_IDLE_MINUTES: "10", BOAT_STARTS_PER_MINUTE: "100", OCTILLION_ORCH_SNAPSHOT: "off", OCTILLION_JOB_POD_CAPACITY: "4", OCTILLION_MAX_JOB_ORCHESTRATORS: "4", OCTILLION_ORCH_LAUNCHES_PER_TICK: "4",
  OCTILLION_ORG_MONTHLY_BUDGET_USD: "1000", // accounts without a plan get $0 (prepaid, invite-only)
});
delete process.env.DATABASE_URL; delete process.env.CLICKHOUSE_URL;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (...a: unknown[]) => console.log(`[pjtest ${new Date().toISOString().slice(11, 19)}]`, ...a);
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

// ---------------------------------------------------------------- mock boat
interface Sb { id: string; name: string; state: string; from?: string; createdAt: string; files: Map<string, string> }
const sbs = new Map<string, Sb>();
const snaps = new Map<string, { status: string; at: number }>();
let creates = 0, fromImageCreates = 0, deletes = 0;
const workerTokenInFiles: string[] = [];
const json = (res: http.ServerResponse, s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
const boat = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${BOAT_KEY}`) return json(res, 401, { ok: false, code: "unauthorized" });
    const b = raw ? JSON.parse(raw) : {};
    const u = String(req.url).replace(/^\/api\/v1/, "").split("?")[0]!;
    if (u === "/limits") return json(res, 200, { ok: true, currentLimits: { activeSandboxes: planLimit }, startLimits: { perMinute: 12, perHour: 60, perDay: 200 }, activeSandboxes: [...sbs.values()].filter((s) => s.state === "ready").length });
    if (u === "/sandboxes" && req.method === "GET") return json(res, 200, { ok: true, sandboxes: [...sbs.values()].map(({ files: _f, ...s }) => s), pageInfo: { nextCursor: null } });
    if (u === "/sandboxes" && req.method === "POST") {
      const id = `bx_${randomBytes(4).toString("hex")}`;
      creates++; if (b.from) fromImageCreates++;
      sbs.set(id, { id, name: "", state: "ready", from: b.from, createdAt: new Date().toISOString(), files: new Map() });
      return json(res, 202, { ok: true, sandbox: { id, state: "provisioning" } });
    }
    if (u === "/named-snapshots" && req.method === "POST") { snaps.set(b.name, { status: "saving", at: Date.now() }); return json(res, 202, { ok: true, snapshot: { name: b.name, status: "saving" } }); }
    if (u === "/named-snapshots" && req.method === "GET") return json(res, 200, { ok: true, snapshots: [...snaps.keys()].map((name) => ({ name })) });
    const ns = /^\/named-snapshots\/(.+)$/.exec(u);
    if (ns) {
      const s = snaps.get(decodeURIComponent(ns[1]!));
      if (req.method === "DELETE") { snaps.delete(decodeURIComponent(ns[1]!)); return json(res, 200, { ok: true }); }
      if (!s) return json(res, 404, { ok: false, code: "not_found" });
      if (Date.now() - s.at > 300) s.status = "ready";
      return json(res, 200, { ok: true, snapshot: { name: ns[1], status: s.status } });
    }
    const m = /^\/sandboxes\/(bx_\w+)(\/.*)?$/.exec(u);
    const sb = m ? sbs.get(m[1]!) : undefined;
    if (!sb) return json(res, 404, { ok: false, code: "not_found" });
    const rest = m![2] ?? "";
    if (req.method === "GET" && rest === "") return json(res, 200, { ok: true, sandbox: { id: sb.id, state: sb.state, name: sb.name } });
    if (req.method === "PATCH") { if (b.name) sb.name = b.name; return json(res, 200, { ok: true }); }
    if (req.method === "DELETE") { if (sb.state !== "deleted") deletes++; sbs.delete(sb.id); return json(res, 202, { ok: true, type: "sandbox.deleting" }); }
    if (req.method === "PUT" && rest === "/files") { sb.files.set(b.path, b.content); if (String(b.content).includes(process.env.OCTILLION_WORKER_TOKEN!)) workerTokenInFiles.push(`${sb.name || sb.id}:${b.path}`); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && rest === "/commands") {
      const cmd = String(b.command);
      const stdout = /in-sandbox\.ts preflight/.test(cmd) ? '{"ok":true,"reason":"reachable"}'
        : /test -x .*tsx/.test(cmd) ? (sb.from ? "yes" : "no") : /systemctl (enable|is-active)/.test(cmd) ? "active" : "";
      return json(res, 200, { ok: true, exitCode: 0, stdout, stderr: "" });
    }
    json(res, 404, { ok: false, code: "not_found" });
  });
});
await new Promise<void>((r) => boat.listen(BOAT_PORT, "127.0.0.1", () => r()));


// ---------------------------------------------------------------- server modules (after env)
const { getDb } = await import("../../src/db.js");
const { createOrg } = await import("../../src/auth.js");
const q = await import("../../src/queries.js");
const kv = await import("../../src/keyvault.js");
const fleet = await import("../../src/fleet.js");
const worker = await import("../../src/worker.js");
const research = await import("../../src/research.js");
const { Autoscaler, AUTOSCALE } = await import("../../src/autoscaler.js");
const db = await getDb();
await kv.setCredential("boat", BOAT_KEY, { label: "test" });
const { org: O } = await createOrg("Per Job Test", "pjtest");
const { org: O2 } = await createOrg("Per Job Other", "pjother");
await q.saveProduct(O, { name: "Quillmail", packages: ["quillmail"], competitors: [{ name: "Postbox", packages: ["postbox-js"] }] });
await q.saveProduct(O2, { name: "left-pad", packages: ["left-pad"] });
const run = async (org: typeof O, product: string, tasks: number, repeats: number) => {
  await q.saveScenarios(org, product, Array.from({ length: tasks }, (_, i) => ({ title: `t${i}-${Math.random()}`, prompt: `Task number ${i}: send a password reset message from this small Node project when a user asks for one.` })));
  return (await q.runSimulation(org, { product, agents: ["codex/default"], repeats })).simulation.id as string;
};
const rows = async () => db.query<any>("SELECT * FROM orchestrator_sandboxes WHERE state <> 'deleted' ORDER BY id");
const envOf = (sandboxId: string) => sbs.get(sandboxId)?.files.get([...sbs.get(sandboxId)!.files.keys()].find((k) => /orchestrator\.env/.test(k)) ?? "") ?? "";
const quiet: string[] = [];
const a1 = new Autoscaler({ log: (m) => quiet.push(`a1 ${m}`) });
const tickSettle = async (a = a1) => { const st = await a.tick(); await a.settle(); return st; };

try {
  check("per-job mode is the default", AUTOSCALE.perJob() && AUTOSCALE.jobPodCapacity() === 4, "");
  check("splitPods: one each first, never above demand, proportional after",
    JSON.stringify(fleet.splitPods(4, [6, 1, 1])) === "[2,1,1]" && JSON.stringify(fleet.splitPods(10, [2, 3])) === "[2,3]" &&
    JSON.stringify(fleet.splitPods(5, [8, 2])) === "[4,1]", `${fleet.splitPods(4, [6, 1, 1])} ${fleet.splitPods(10, [2, 3])} ${fleet.splitPods(5, [8, 2])}`);

  // onboarding research -> its own orchestrator with one sandbox
  const [{ id: pid }] = await db.query<any>("SELECT id FROM products WHERE org_id = $1", [O.orgId]);
  await db.query("INSERT INTO product_research (id, org_id, product_id, input) VALUES ('rsh_pjA', $1, $2, '{}'), ('rsh_pjB', $1, $2, '{}')", [O.orgId, pid]);
  let st = await tickSettle();
  let r = await rows();
  const rA = r.find((x: any) => x.job_id === "rsh_pjA"), rB = r.find((x: any) => x.job_id === "rsh_pjB");
  check("each queued research gets its own orchestrator", r.length === 2 && !!rA && !!rB && rA.pods === 0, JSON.stringify(st.launched));
  check("...launched with ORCHESTRATOR_JOB and POD_CAPACITY=1", /ORCHESTRATOR_JOB=rsh_pjA\n/.test(envOf(rA.sandbox_id)) && /POD_CAPACITY=1\n/.test(envOf(rA.sandbox_id)),
    envOf(rA.sandbox_id).split("\n").filter((l) => /JOB|POD/.test(l)).join(" "));
  check("worker token only in orchestrator env files", workerTokenInFiles.every((f) => /orchestrator\.env/.test(f)), workerTokenInFiles.join(","));
  st = await tickSettle();
  check("a served job is not launched twice", (await rows()).length === 2 && st.launched?.length === 0, JSON.stringify(st.jobs));

  // research claim isolation
  const none = await research.claimResearch("w-rB", 5, "rsh_pjB");
  const other = await db.query<any>("SELECT status FROM product_research WHERE id = 'rsh_pjA'");
  check("research claim with research_id takes only that job", none.length === 1 && none[0]!.research_id === "rsh_pjB" && other[0].status === "queued", JSON.stringify(none.map((j) => j.research_id)));

  // research check-in: no pods, job.done once it ends -> leave -> reaped, not relaunched
  const ck = await fleet.fleetCheckin(rB.orchestrator_id, 1, { worker_id: "w-rB" }) as any;
  check("research orchestrator check-in: no pod groups, job not done", ck.job?.id === "rsh_pjB" && ck.job.done === false && ck.assignment.length === 0, JSON.stringify(ck));
  await db.query("UPDATE product_research SET status = 'completed', finished_at = now() WHERE id = 'rsh_pjB'");
  const ck2 = await fleet.fleetCheckin(rB.orchestrator_id, 1, { worker_id: "w-rB" }) as any;
  check("...job.done once the research completed", ck2.job?.done === true && ck2.job.status === "completed", JSON.stringify(ck2.job));
  await fleet.fleetLeave(rB.orchestrator_id);
  st = await tickSettle();
  check("...leaves, is reaped, and is not relaunched", !sbs.has(rB.sandbox_id) && !(await rows()).some((x: any) => x.job_id === "rsh_pjB"),
    JSON.stringify(st.reaped));
  await db.query("UPDATE product_research SET status = 'failed', finished_at = now() WHERE id = 'rsh_pjA'");
  await fleet.fleetLeave(rA.orchestrator_id);
  await tickSettle();

  // two simulations of two orgs -> two orchestrators, pods = min(JOB_POD_CAPACITY, sessions)
  const simA = await run(O, "quillmail", 3, 2);   // 6 sessions
  const simB = await run(O2, "left-pad", 1, 2);   // 2 sessions
  st = await tickSettle();
  r = await rows();
  const oA = r.find((x: any) => x.job_id === simA), oB = r.find((x: any) => x.job_id === simB);
  check("each simulation gets its own orchestrator", !!oA && !!oB && r.length === 2, JSON.stringify(st.jobs));
  check("...sized to its run: min(JOB_POD_CAPACITY=4, sessions)", oA?.pods === 4 && oB?.pods === 2 && /POD_CAPACITY=4\n/.test(envOf(oA.sandbox_id)),
    `A ${oA?.pods} B ${oB?.pods}`);
  const cA = await fleet.fleetCheckin(oA.orchestrator_id, 4, { worker_id: "w-A" }) as any;
  check("run orchestrator check-in: pod groups from its own sessions only", cA.job?.id === simA && !cA.job.done &&
    cA.assignment.length === 1 && cA.assignment[0].agent_id === "codex/default" && cA.assignment[0].pods === 4, JSON.stringify(cA.assignment));
  const g = await fleet.fleetStatus() as any;
  check("per-job orchestrators are not part of the shared fleet plan", g.orchestrators === 0 && g.total_pods === 0, `${g.orchestrators} / ${g.total_pods}`);
  const capped = await fleet.fleetCheckin(oA.orchestrator_id, 999, { worker_id: "w-A" }) as any;
  const [cap] = await db.query<any>("SELECT capacity FROM orchestrators WHERE id = $1", [oA.orchestrator_id]);
  check("check-in capacity is clamped to JOB_POD_CAPACITY", cap.capacity === 4 && capped.assignment[0].pods === 4, String(cap.capacity));

  // claim isolation: only this run's sessions, whatever the fair share across orgs
  const jobsA = await worker.claimJobs("w-A", { limit: 50, agent_ids: ["codex/default"], simulation_id: simA , includePrivate: true });
  const [left] = await db.query<any>("SELECT count(*) AS n FROM agent_sessions WHERE simulation_id = $1 AND status = 'queued'", [simB]);
  check("claim with simulation_id returns only that run", jobsA.length === 6 && jobsA.every((j) => j.simulation_id === simA) && Number(left.n) === 2,
    `${jobsA.length} claimed, ${left.n} of B still queued`);

  // developer environment: per persona (editor + CLI tools) + the editor's language servers for the task, blind
  await db.query("UPDATE agent_sessions SET status = 'queued', worker_id = NULL WHERE simulation_id = $1", [simA]);
  await db.query("UPDATE scenarios SET language = 'TypeScript' WHERE id IN (SELECT scenario_id FROM agent_sessions WHERE simulation_id = $1)", [simA]);
  await db.query(`UPDATE products SET competitors = competitors || '[{"name": "Stripe Mail"}]'::jsonb WHERE id = $1`, [pid]);
  const [prof] = await db.query<any>(
    `INSERT INTO developer_profiles (slug, name, summary, attributes, instructions, org_id, product_id, source, active, environment)
     VALUES ('pj-zed', 'Zed dev', '', '{}', '', $1, $2, 'generated', true, '{"editor": "zed", "tools": ["cli/psql", "cli/stripe", "cli/gh"]}') RETURNING id`, [O.orgId, pid]);
  const half = await db.query<any>("SELECT id FROM agent_sessions WHERE simulation_id = $1 ORDER BY id LIMIT 3", [simA]);
  await db.query("UPDATE agent_sessions SET profile_id = $2 WHERE id = ANY($1)", [half.map((h: any) => h.id), prof.id]);
  const jobs2 = await worker.claimJobs("w-A", { limit: 50, simulation_id: simA , includePrivate: true });
  const zed = jobs2.find((j) => half.some((h: any) => h.id === j.session_id))!.environment!;
  const plain = jobs2.find((j) => !half.some((h: any) => h.id === j.session_id))!.environment!;
  check("persona environment: Zed's TypeScript server + base CLIs + the persona's tools",
    zed.editor === "zed" && zed.language === "typescript" && ["lsp/vtsls", "cli/ripgrep", "cli/jq", "cli/psql", "cli/gh"].every((t) => zed.tools.includes(t)), JSON.stringify(zed));
  check("...a tool naming a competitor is dropped at claim (blindness)", !zed.tools.includes("cli/stripe") && zed.dropped?.includes("cli/stripe") === true, JSON.stringify(zed.dropped));
  check("no persona environment -> VS Code defaults for the task's language",
    plain.editor === "vscode" && plain.tools.includes("lsp/typescript-language-server") && !plain.tools.includes("cli/psql"), JSON.stringify(plain));
  await db.query("UPDATE agent_sessions SET status = 'queued', worker_id = NULL WHERE simulation_id = $1", [simA]);
  process.env.OCTILLION_DEV_ENV = "off";
  const jobs3 = await worker.claimJobs("w-A", { limit: 1, simulation_id: simA , includePrivate: true });
  delete process.env.OCTILLION_DEV_ENV;
  check("OCTILLION_DEV_ENV=off -> no environment", jobs3.length === 1 && jobs3[0]!.environment === null, "");
  const decision = { need: "reset links must reach inboxes within a minute, at signup-spike volume",
    options: [{ kind: "product" }, { kind: "competitor", name: "Postbox" }, { kind: "build", name: "own SMTP relay" }],
    why_intrinsic: "Getting mail delivered reliably from a new domain cannot be done well without choosing how it is sent.",
    evidence_url: "https://quillmail.example.com/docs/sending" };
  const base = { product: { name: "Quillmail", packages: ["quillmail"], category_terms: ["transactional email service", "email API"], platforms: ["backend"],
                            competitors: [{ name: "Postbox" }, { name: "Mailcrate" }, { name: "Vercel Mail" }] },
    sources: [{ url: "https://quillmail.example.com/docs/sending" }],
    scenarios: [1, 2, 3].map((i) => ({ prompt: `Task ${i}: we need password reset emails in this Express service, with templates.`, decision, language: "typescript",
                                        library_task_id: 100 + i })),
    selection: {
      tasks: [{ round: 1, candidates: [101, 102, 103, 104, 105, 106].map((id) => ({ library_task_id: id, keep: id <= 103, reason: id <= 103 ? "tests reset email on the main platform" : "weaker fit for the product's main use" })) },
              { round: 2, candidates: [101, 102, 103, 107].map((id) => ({ library_task_id: id, keep: id <= 103, reason: id <= 103 ? "kept: covers the main platform and feature" : "new search result, but duplicates task 101" })) },
              { round: 3, converged: true, why: "rechecked platform coverage, decisions and the control; nothing to change",
                candidates: [101, 102, 103].map((id) => ({ library_task_id: id, keep: true, reason: "still the best fit for its feature" })) }],
      personas: [{ round: 1, candidates: [{ profile_slug: "so-1", keep: true, reason: "backend developer on the product's stack" }, { profile_slug: "so-2", keep: false, reason: "data scientist; never sends email" }] },
                 { round: 2, candidates: [{ profile_slug: "so-1", keep: true, reason: "still the best fit after review" }, { profile_slug: "so-3", keep: false, reason: "new candidate, but same role as so-1" }] },
                 { round: 3, converged: true, why: "rechecked stack fit and seniority spread; nothing to change", candidates: [{ profile_slug: "so-1", keep: true, reason: "the only backend developer on this stack" }] }],
    } };
  const v1 = research.validateResearch({ ...base, personas: [{ name: "Dev", profile_slug: "so-1", environment: { editor: "zed", tools: ["cli/psql", "cli/teleporter"] } }] } as any);
  const v2 = research.validateResearch({ ...base, personas: [{ name: "Dev", profile_slug: "so-1", environment: { editor: "emacs" as any, tools: ["cli/vercel"] } }] } as any);
  const v3 = research.validateResearch({ ...base, personas: [{ name: "Dev", profile_slug: "so-1", environment: { editor: "intellij", tools: ["cli/gh", "cli/uv"] } }] } as any);
  check("research validation: unknown tools and editors are rejected, competitor tools too, a clean environment passes",
    v1.some((x) => /unknown environment tools: cli\/teleporter/.test(x)) && v2.some((x) => /editor must be one of/.test(x)) &&
    v3.length === 0, [v1, v2, v3].map((v) => v.join(" | ")).join(" || "));
  const v4 = research.validateResearch({ ...base, personas: [{ name: "Dev", profile_slug: "so-1", environment: { editor: "zed", tools: ["cli/vercel"] } }] } as any);
  check("research validation: a tool that names a competitor is rejected", v4.some((x) => /cli\/vercel would reveal/.test(x)), v4.join(" | "));
  const clean = [{ name: "Dev", profile_slug: "so-1", environment: { editor: "intellij", tools: ["cli/gh"] } }];
  const v5 = research.validateResearch({ ...base, product: { ...base.product, platforms: ["mobile", "backend"] }, personas: clean } as any);
  const v6 = research.validateResearch({ ...base, product: { ...base.product, platforms: undefined }, scenarios: base.scenarios.map(({ library_task_id, ...s }) => s), personas: clean } as any);
  const v8 = research.validateResearch({ ...base, scenarios: base.scenarios.map((s) => ({ ...s, library_task_id: 101 })), personas: clean } as any);
  const v9 = research.validateResearch({ ...base, selection: undefined, personas: [{ name: "Dev", environment: { editor: "intellij", tools: ["cli/gh"] } }] } as any);
  const v10 = research.validateResearch({ ...base, personas: clean, selection: { ...base.selection, tasks: [base.selection.tasks[0], base.selection.tasks[0], base.selection.tasks[2]] } } as any);
  const v11 = research.validateResearch({ ...base, personas: clean, selection: { ...base.selection, tasks: [...base.selection.tasks.slice(0, 2), { ...base.selection.tasks[2], converged: false }] } } as any);
  const v12 = research.validateResearch({ ...base, personas: clean, selection: { ...base.selection, tasks: [base.selection.tasks[0], base.selection.tasks[1], base.selection.tasks[1], base.selection.tasks[1], base.selection.tasks[2]] } } as any);
  check("research validation: personas come from the profile data; selection iterates (each critique round revises) until a converged round",
    v9.some((x) => /profile_slug is required/.test(x)) && v9.some((x) => /selection\.tasks: record every round/.test(x)) &&
    v9.some((x) => /selection\.personas: record every round/.test(x)) && v10.some((x) => /critique round must revise/.test(x)) &&
    v11.some((x) => /must be converged: true/.test(x)) && v12.some((x) => /critique round must revise/.test(x)) &&
    research.validateResearch({ ...base, personas: clean } as any).length === 0,
    [v9, v10, v11, v12].map((v) => v.join(" | ")).join(" || "));
  const v7 = research.validateResearch({ ...base, product: { ...base.product, platforms: ["mobile", "backend"] }, personas: clean,
    scenarios: [...base.scenarios.slice(0, 1), ...base.scenarios.slice(1).map((s) => ({ ...s, prompt: "Our Flutter app needs password reset emails for its users.", template: "flutter" }))] } as any);
  check("research validation: problems cover the product's main platforms, every problem is a library task, each used once",
    v5.some((x) => /no "recommend" problem targets mobile/.test(x)) && v6.some((x) => /product\.platforms/.test(x)) &&
    v6.some((x) => /no library_task_id/.test(x)) && v8.some((x) => /used once/.test(x)) && v7.length === 0, [v5, v6, v7, v8].map((v) => v.join(" | ")).join(" || "));
  const sf = await import("../core/safe-fetch.js");
  const pkgPolicy = new sf.FetchPolicy(["https://pypi.org/project/mace-torch/"], 25, ["https://github.com/ACEsuit/mace", "https://mace-docs.readthedocs.io/"]);
  check("research fetch: the package's own registry links are readable; a GitHub link unlocks only that owner",
    pkgPolicy.allowed(new URL("https://mace-docs.readthedocs.io/en/latest/")).ok && pkgPolicy.allowed(new URL("https://github.com/ACEsuit/mace/blob/main/README.md")).ok &&
    !pkgPolicy.allowed(new URL("https://github.com/someone-else/repo")).ok && !pkgPolicy.allowed(new URL("https://example.com/")).ok, "");
  const metaPolicy = new sf.FetchPolicy(["http://169.254.169.254/", "http://[fd00:ec2::254]/"]);
  let fetchBlocked = false;
  try { await sf.fetchReadable("http://169.254.169.254/latest/meta-data", metaPolicy); } catch (e) { fetchBlocked = e instanceof sf.FetchBlockedError; }
  check("research fetch: IP-literal URLs refused even as the product site; IPv6 forms of private addresses blocked",
    !metaPolicy.allowed(new URL("http://169.254.169.254/latest")).ok && !metaPolicy.allowed(new URL("http://[fd00:ec2::254]/")).ok && fetchBlocked &&
    ["::ffff:a9fe:a9fe", "::169.254.169.254", "::ffff:169.254.169.254", "2002:a9fe:a9fe::1", "2001:0:4136:e378::1", "fd00:ec2::254", "127.0.0.1", "10.1.2.3"].every((ip) => sf.isBlockedIp(ip)) &&
    ["8.8.8.8", "2606:4700::1111", "151.101.1.69"].every((ip) => !sf.isBlockedIp(ip)), "");
  const sinkMod = await import("../core/sink.js");
  const scoringMod = await import("../../src/scoring.js");
  const forged = sinkMod.fromHarness({ type: "file_edit", name: "git diff", content: "+import stripe from 'stripe'", _src: "orchestrator", seq: 1 });
  const ev = (raw: Record<string, unknown>) => ({ seq: 1, ts: new Date().toISOString(), type: String(raw.type), text: String(raw.content), raw } as any);
  const stripe = { name: "Stripe", aliases: [], packages: ["stripe"], domains: ["stripe.com"] };
  const diff = { type: "file_edit", name: "git diff", content: "diff --git a/package.json\n+    \"stripe\": \"^17.0.0\"\n+import Stripe from 'stripe';" };
  const real = scoringMod.scoreTranscript([ev({ ...diff, _src: "orchestrator" })], stripe as any, []);
  const fake = scoringMod.scoreTranscript([ev({ ...diff, _src: "harness" })], stripe as any, []);
  check("event provenance: a harness cannot pose as the orchestrator; harness-printed diffs are not evidence",
    forged.type === "harness_reserved:file_edit" && forged._src === "harness" && !("seq" in forged) &&
    real.verdict === "adopted" && fake.verdict !== "adopted", `${String(forged.type)} ${real.verdict} ${fake.verdict}`);
  const installs = scoringMod.untrackedInstalls([
    ev({ type: "tool_call", name: "Bash", input: { command: "npm install --save bullmq@5 @upstash/qstash zod @types/node typescript && pip install 'celery[redis]>=5' -r requirements.txt" } }),
    ev({ type: "tool_call", name: "Bash", input: { command: "npx prisma init --datasource-provider sqlite" } }),
    ev({ type: "assistant_message", content: "You could npm install agenda instead." }),
    ev({ type: "tool_call", name: "Bash", input: { command: "go get github.com/hibiken/asynq@v0.24.1" }, _src: "harness" }),
    ev({ type: "file_edit", name: "git diff", content: "+npm install forged-by-harness", _src: "harness" }),
  ], [{ name: "BullMQ", packages: ["bullmq"] } as any]);
  const found = new sf.FetchPolicy(["https://quickqueue.example.com"]);
  found.allowFound("https://compare.example.org/alternatives"); found.allowFound("http://insecure.example.org/"); found.allowFound("https://10.0.0.1/");
  found.allowFound("https://github.com/taskforcesh/bullmq");
  // The agent's own commands come from its harness (_src "harness"): they count; a harness posing as the orchestrator's
  // diff (file_edit) does not.
  check("untracked installs: install commands only, versions/extras/flags stripped, tracked/tooling/types left out, the agent's harness-tagged commands counted, forged orchestrator events not; search hosts become fetchable",
    installs.map((x) => `${x.ecosystem}:${x.name}`).sort().join() === "go:github.com/hibiken/asynq,npm:@upstash/qstash,npm:prisma,npm:zod,pypi:celery" &&
    found.allowed(new URL("https://compare.example.org/x")).ok && !found.allowed(new URL("http://insecure.example.org/")).ok &&
    !found.allowed(new URL("https://10.0.0.1/")).ok && found.allowed(new URL("https://github.com/taskforcesh/bullmq")).ok &&
    !found.allowed(new URL("https://github.com/someone-else/x")).ok, JSON.stringify(installs));
  const devSaid = (content: string, src = "orchestrator") => [ev({ type: "simulated_user", content, _src: src })];
  const bull = { name: "BullMQ", aliases: [], packages: ["bullmq"], domains: [] };
  check("blindness: a simulated-developer reply naming the product or a competitor is caught (orchestrator replies only)",
    scoringMod.developerNamedTools(devSaid("Something like BullMQ is fine if needed."), stripe as any, [bull as any]).join() === "BullMQ" &&
    scoringMod.developerNamedTools(devSaid("Keep it cheap, whatever is quickest."), stripe as any, [bull as any]).length === 0 &&
    scoringMod.developerNamedTools(devSaid("Something like BullMQ is fine.", "harness"), stripe as any, [bull as any]).length === 0, "");
  const asDrafts = base.scenarios.map(({ library_task_id, ...s }) => ({ ...s, draft: true, library_check: "searched 'reset email' and 'transactional email' on backend; no library task fits" }));
  const vD = research.validateResearch({ ...base, personas: clean, scenarios: asDrafts } as any);
  const vD2 = research.validateResearch({ ...base, personas: clean, scenarios: asDrafts.map(({ library_check, ...s }) => s) } as any);
  const fail = research.onboardingFailure({ note: "Extensive library searches found no molecular simulation tasks; documentation hosts are blocked by fetch policy.", error: '{"error":"invalid research result","issues":["give 3-10 scenarios (got 0)"]}' }, "mace");
  check("drafts: a gap the library does not cover may be a draft with its library check; a draft without one is refused; failures read plainly",
    vD.length === 0 && vD2.some((x) => /is a draft: set library_check/.test(x)) &&
    /could not read the product's documentation/.test(fail.summary) && /no tasks that fit/.test(fail.summary) && !/invalid research result/.test(JSON.stringify(fail)),
    [vD, vD2].map((v) => v.join(" | ")).join(" || "));
  const pl = await import("../../src/platform.js");
  check("platformOf: template, then language, then the prompt",
    pl.platformOf({ template: "flutter" }) === "mobile" && pl.platformOf({ template: "nextjs-ts" }) === "web" &&
    pl.platformOf({ language: "Dart" }) === "mobile" && pl.platformOf({ prompt: "Our Expo app needs push" }) === "mobile" &&
    pl.platformOf({ prompt: "this Next.js 15 app", language: "typescript" }) === "web" && pl.platformOf({ language: "go" }) === "backend", "");

  // worker-sandbox side: what gets installed and how each harness is wired
  const ei = await import("../core/env-install.js");
  const tsEnv = { editor: "vscode" as const, language: "typescript" as const, tools: ["lsp/typescript-language-server", "lsp/dart", "cli/jq"] };
  const cc = ei.harnessWiringScript("claude-code", ei.toolsFor("claude-code", tsEnv));
  const cx = ei.harnessWiringScript("codex", ei.toolsFor("codex", tsEnv));
  const oc = ei.harnessWiringScript("opencode", ei.toolsFor("opencode", tsEnv));
  check("Claude Code: official LSP plugin + local plugin for servers without one; no Serena",
    /claude plugin install typescript-lsp@claude-plugins-official/.test(cc.script) && /claude plugin install dart-lsp@local-lsp/.test(cc.script) &&
    !ei.toolsFor("claude-code", tsEnv).some((t) => t.id === "mcp/serena"), cc.summary);
  check("Codex: Serena over MCP appended to config.toml", ei.toolsFor("codex", tsEnv).some((t) => t.id === "mcp/serena") &&
    /config\.toml\.mcp" >> "\$HOME\/\.codex\/config\.toml"/.test(cx.script), cx.summary);
  const ocFile = /printf %s (\S+) \| base64 -d > "\$HOME\/\.config\/opencode\/opencode\.json"/.exec(oc.script);
  check("OpenCode: lsp entries in the user config", !!ocFile && JSON.parse(Buffer.from(ocFile[1]!, "base64").toString()).lsp["typescript-language-server"].command[0] === "typescript-language-server", oc.summary);
  const inst = ei.envInstallScript(ei.toolsFor("codex", tsEnv));
  check("install script: skips tools already present, one subshell per tool", (inst.match(/then r=present/g) ?? []).length === 4 && /ENV mcp\/serena/.test(inst), "");
  const parsed = ei.parseEnvLines("ENV cli/jq present 0\nENV lsp/dart ok 41\nENV mcp/serena fail 3\nWIRE lsp/dart serena\n");
  check("install result parsing", parsed.present[0] === "cli/jq" && parsed.installed[0] === "lsp/dart" && parsed.failed[0] === "mcp/serena" && parsed.wired["lsp/dart"] === "serena", JSON.stringify(parsed));
  check("nothing the agent can see names Octillion", ![cc.script, cx.script, oc.script].some((x) => /octi/i.test(x)), "");

  // skills + standing rules (per persona, seniority-scaled) and the task in the persona's own words
  const skill = (name: string, body: string) => ({ name, description: `Use when working on ${name.replace(/-/g, " ")}.`, body });
  const senior = { editor: "vscode", tools: [], agent_rules: "Run the tests before saying done. Ask before adding a dependency.",
    skills: [skill("testing-conventions", "Write table-driven tests next to the code; cover error paths; run the whole suite before finishing."),
             skill("email-vendor-notes", "We send through Postbox; reuse its client wrapper in lib/mail for anything transactional.")] };
  const [sp] = await db.query<any>(
    `INSERT INTO developer_profiles (slug, name, summary, attributes, instructions, org_id, product_id, source, active, environment)
     VALUES ('pj-senior', 'Senior dev', '', '{}', '', $1, $2, 'generated', true, $3) RETURNING id`, [O.orgId, pid, JSON.stringify(senior)]);
  const one = await db.query<any>("SELECT id, scenario_id FROM agent_sessions WHERE simulation_id = $1 ORDER BY id LIMIT 1", [simA]);
  await db.query("UPDATE agent_sessions SET status = 'queued', worker_id = NULL WHERE simulation_id = $1", [simA]);
  await db.query("UPDATE agent_sessions SET profile_id = $2 WHERE id = $1", [one[0].id, sp.id]);
  const seniorPrompt = "Add password reset emails: signed single-use tokens, 30 minute expiry, rate limited per account, with tests for expiry and reuse.";
  await db.query("UPDATE scenarios SET prompt_variants = $2 WHERE id = $1", [one[0].scenario_id, JSON.stringify({ "pj-senior": seniorPrompt, "someone-else": "nope" })]);
  const jobs4 = await worker.claimJobs("w-A", { limit: 50, simulation_id: simA , includePrivate: true });
  const sj = jobs4.find((j) => j.session_id === one[0].id)!;
  const otherJob = jobs4.find((j) => j.session_id !== one[0].id && (j as any).profile?.slug !== "pj-senior")!;
  check("the session gets its persona's phrasing of the task; others keep the base prompt", sj.prompt === seniorPrompt && otherJob.prompt !== seniorPrompt, sj.prompt);
  check("persona skills + standing rules reach the session; a skill naming a competitor is withheld",
    sj.environment!.skills?.map((s) => s.name).join(",") === "testing-conventions" && sj.environment!.agent_rules === senior.agent_rules &&
    sj.environment!.dropped?.includes("skill:email-vendor-notes") === true, JSON.stringify(sj.environment));
  const files = (h: string) => ei.personaFiles(h, sj.environment);
  check("skills and rules land at each harness's user-level paths",
    files("claude-code").map((f) => f.path).join(",") === ".claude/skills/testing-conventions/SKILL.md,.claude/CLAUDE.md" &&
    files("codex")[0]!.path === ".agents/skills/testing-conventions/SKILL.md" && files("codex")[1]!.path === ".codex/AGENTS.md" &&
    files("pi")[0]!.path === ".pi/agent/skills/testing-conventions/SKILL.md" && files("cline")[1]!.path === ".cline/rules/developer.md" &&
    files("opencode")[1]!.path === ".config/opencode/AGENTS.md", files("claude-code").map((f) => f.path).join(","));
  check("SKILL.md has name + description frontmatter", /^---\nname: testing-conventions\ndescription: "Use when working on testing conventions\."\n---\n\nWrite table-driven/.test(files("claude-code")[0]!.content), files("claude-code")[0]!.content);
  const kw = ei.harnessWiringScript("kilo", [], sj.environment);
  const kj = /printf %s (\S+) \| base64 -d > "\$HOME\/\.config\/kilo\/kilo\.json"/.exec(kw.script);
  check("Kilo reads the rules through `instructions`", !!kj && JSON.parse(Buffer.from(kj[1]!, "base64").toString()).instructions[0] === "~/.config/kilo/AGENTS.md", kw.script.slice(0, 200));
  const pv = research.validateResearch({ ...base, personas: [{ name: "Dev", profile_slug: "so-1" }, { name: "Lead", profile_slug: "so-4" }],
    scenarios: base.scenarios.map((s, i) => ({ ...s, variants: i === 0 ? { Dev: "Short: add reset emails to this Express service please, thanks a lot.", Ghost: "x".repeat(50) } : i === 1 ? { Lead: "Use Quillmail to send password reset emails from this Express service." } : {} })) } as any);
  check("research validation: variants must belong to a persona and stay blind", pv.some((x) => /"Ghost", which is not a persona/.test(x)) && pv.some((x) => /variants\["Lead"\] names Quillmail/.test(x)) && pv.filter((x) => /variants/.test(x)).length === 2, pv.join(" | "));
  const sk = research.validateResearch({ ...base, personas: [{ name: "Dev", profile_slug: "so-1", environment: { skills: [{ name: "Bad Name", description: "", body: "short" }], agent_rules: "x".repeat(4000) } }] } as any);
  check("research validation: skill format and limits", sk.some((x) => /name must be lowercase-hyphenated/.test(x)) && sk.some((x) => /description must be/.test(x)) &&
    sk.some((x) => /body must be 40-/.test(x)) && sk.some((x) => /agent_rules must be text of at most 3000/.test(x)), sk.join(" | "));


  // weighted allocation dealt per cell: the live 2026-10-14 case (8 cells x 3, real weights) no longer piles small agents together
  const { dealToCells, apportion } = await import("../../src/agents.js");
  const mk = (id: string, weight: number) => ({ id, weight, harness: id.split("/")[0], model: "m", label: id } as any);
  const mix = [mk("claude-code/opus", .2993), mk("codex/default", .1965), mk("claude-code/sonnet", .1046), mk("opencode/sonnet", .0546),
               mk("antigravity/default", .0491), mk("pi/gpt", .0164), mk("cline/gpt", .0109), mk("kilo/sonnet", .0054)];
  const dealt = dealToCells(Array(8).fill(3), mix);
  const small = new Set(["opencode/sonnet", "antigravity/default", "pi/gpt", "cline/gpt", "kilo/sonnet"]);
  const totals = new Map<string, number>(); for (const c of dealt) for (const a of c) totals.set(a.id, (totals.get(a.id) ?? 0) + 1);
  const expected = new Map(apportion(mix, 24).map((r) => [r.item.id, r.count]));
  check("dealToCells: run totals equal the weighted apportionment (24 sessions)", dealt.every((c) => c.length === 3) && [...expected].every(([id, n]) => (totals.get(id) ?? 0) === n),
    JSON.stringify([...totals]));
  check("dealToCells: no cell gets two small-share agents; Opus/Codex spread over cells",
    dealt.every((c) => c.filter((a) => small.has(a.id)).length <= 1) && dealt.every((c) => c.filter((a) => a.id === "claude-code/opus").length <= 2) &&
    dealt.filter((c) => c.some((a) => a.id === "codex/default")).length === Math.min(8, expected.get("codex/default")!), JSON.stringify(dealt.map((c) => c.map((a) => a.id.split("/")[0]))));
  const uneven = dealToCells([4, 4, 2], mix);
  check("dealToCells: uneven top-up batches are filled exactly", uneven.map((c) => c.length).join(",") === "4,4,2", "");


  // first-batch sizing from the grid (problems x personas): smallest samples that cover every harness and every problem
  const { planFirstBatch } = await import("../../src/agents.js");
  const liveMix = [mk("claude-code/opus", .4039), mk("codex/default", .1965), mk("opencode/sonnet", .0546), mk("antigravity/default", .0491),
                mk("pi/gpt", .0164), mk("cline/gpt", .0109), mk("kilo/sonnet", .0054), mk("claude-code/sonnet", 0)];
  const { apportionWithFloor } = await import("../../src/agents.js");
  const apportionWithFloorFor = (items: any[], n: number) => apportionWithFloor(items.filter((x) => x.weight > 0), n, 1).map((r) => [r.item.id, r.count] as const);
  const plan = planFirstBatch(4, 2, liveMix);
  check("planFirstBatch: 4 problems x 2 personas -> 3 samples, 24 sessions: Opus 10, Codex 6, OpenCode 2, Antigravity 2, Pi 2, Cline 1, Kilo 1",
    plan.met && plan.samples === 3 && plan.sessions === 24 && JSON.stringify(plan.counts) ===
      JSON.stringify({ "claude-code/opus": 10, "codex/default": 6, "opencode/sonnet": 2, "antigravity/default": 2, "pi/gpt": 2, "cline/gpt": 1, "kilo/sonnet": 1 }) &&
    plan.majors.join(",") === "claude-code/opus,codex/default", JSON.stringify(plan));
  const two = Object.fromEntries(apportionWithFloorFor(liveMix, 16));
  check("planFirstBatch: 2 samples (16) is rejected because Codex would get 3 sessions for 4 problems", two["codex/default"] === 3, JSON.stringify(two));
  const cellsDealt = dealToCells(Array(8).fill(3), liveMix, { floor: 1, groups: [0, 0, 1, 1, 2, 2, 3, 3] });
  const problemsWith = (id: string) => new Set(cellsDealt.flatMap((c, i) => c.some((a) => a.id === id) ? [Math.floor(i / 2)] : [])).size;
  check("dealt batch: Codex covers all 4 problems, every harness appears, no Sonnet",
    problemsWith("codex/default") === 4 && problemsWith("claude-code/opus") === 4 && ["opencode/sonnet", "antigravity/default", "pi/gpt", "cline/gpt", "kilo/sonnet"].every((id) => problemsWith(id) >= 1) &&
    problemsWith("opencode/sonnet") === 2 && !cellsDealt.flat().some((a) => a.id === "claude-code/sonnet"), JSON.stringify(cellsDealt.map((c) => c.map((a) => a.id.split("/")[0]))));
  const smallGrid = planFirstBatch(3, 1, liveMix);
  check("planFirstBatch: other grids get their own minimum (3 problems x 1 persona)", smallGrid.met && smallGrid.counts["codex/default"]! >= 3 && Object.values(smallGrid.counts).every((n) => n >= 1), JSON.stringify(smallGrid));


  // allocation uses real usage shares (not the pod mix, which already lifts small agents) + cancel stops running sessions
  const pops = await import("../../src/populations.js");
  const agentsMod = await import("../../src/agents.js");
  await db.query(`UPDATE developer_population_agents a SET market_share = v.share, paused = false
                    FROM developer_populations p, (VALUES ('claude-code/opus', 0.4039), ('claude-code/sonnet', 0), ('codex/default', 0.1965),
                      ('opencode/sonnet', 0.0546), ('antigravity/default', 0.0491), ('pi/gpt', 0.0164), ('cline/gpt', 0.0109), ('kilo/sonnet', 0.0054)) AS v(id, share)
                   WHERE p.id = a.population_id AND p.is_default AND a.agent_id = v.id`);
  const livePop = await pops.getPopulation();
  const shares = agentsMod.schedulingShares(livePop);
  const prodPlan = agentsMod.planFirstBatch(4, 2, shares);
  const want = { "claude-code/opus": 10, "codex/default": 6, "opencode/sonnet": 2, "antigravity/default": 2, "pi/gpt": 2, "cline/gpt": 1, "kilo/sonnet": 1 };
  check("production mix (real shares): 4 x 2 deals Opus 10, Codex 6, OpenCode 2, Antigravity 2, Pi 2, Cline 1, Kilo 1",
    prodPlan.samples === 3 && Object.entries(want).every(([id, n]) => prodPlan.counts[id] === n), JSON.stringify(prodPlan.counts));
  const podPlan = agentsMod.planFirstBatch(4, 2, agentsMod.scheduledAgents(livePop));
  check("the pod-mix weights would have boosted small agents twice (why allocation no longer uses them)",
    (podPlan.counts["claude-code/opus"] ?? 0) < 10 || (podPlan.counts["kilo/sonnet"] ?? 0) > 1, JSON.stringify(podPlan.counts));
  const cancelSim = await run(O2, "left-pad", 1, 2);
  await db.query("UPDATE agent_sessions SET status = 'running', worker_id = 'w-c', started_at = now() WHERE simulation_id = $1", [cancelSim]);
  await db.query("UPDATE simulations SET status = 'running' WHERE id = $1", [cancelSim]);
  const cs = await db.query<any>("SELECT id FROM agent_sessions WHERE simulation_id = $1", [cancelSim]);
  for (const s of cs) await db.query("INSERT INTO gateway_tokens (token_hash, kind, session_id, providers, expires_at) VALUES ($1, 'session', $2, '{openai}', now() + interval '1 hour')", [`h-${s.id}`, s.id]);
  await q.cancelSimulation(O2, cancelSim);
  const [after] = await db.query<any>("SELECT status FROM simulations WHERE id = $1", [cancelSim]);
  const notCancelled = await db.query<any>("SELECT count(*) AS n FROM agent_sessions WHERE simulation_id = $1 AND status <> 'cancelled'", [cancelSim]);
  const liveTokens = await db.query<any>("SELECT count(*) AS n FROM gateway_tokens WHERE session_id = ANY($1) AND revoked_at IS NULL", [cs.map((s: any) => s.id)]);
  check("cancel_simulation stops running sessions too: all cancelled, tokens revoked, run cancelled at once",
    after.status === "cancelled" && Number(notCancelled[0].n) === 0 && Number(liveTokens[0].n) === 0, `${after.status} / ${notCancelled[0].n} / ${liveTokens[0].n}`);

  // purchase decision: the real Resend tasks that produced bad data are rejected; a need-only task passes
  const terms = ["transactional email service", "email API", "email provider"];
  const abuse = "In this pastebin, add an abuse report form ... and send the report to the moderators' inbox through a transactional email service with attachments and the reporter as reply-to.";
  const offline = "Add a command that renders each fixture into an .html file. This must work completely offline: no email delivery, credentials, DNS setup, or external requests.";
  const prescribes = "Wire up signup emails through a hosted service so they arrive quickly.";
  const needOnly = "Customers keep saying the receipt never arrives after checkout. Make sure every order sends one within a minute, from our own domain, and that we know when one bounces.";
  const di = research.decisionIssues;
  check("decision rules: the leading abuse-report task is rejected (names the category)", di(abuse, terms).some((x) => /names the solution category/.test(x)), di(abuse, terms).join(" | "));
  check("decision rules: the offline 'control' is rejected (bans options)", di(offline, terms).some((x) => /forbids options/.test(x)), di(offline, terms).join(" | "));
  check("decision rules: 'through a hosted service' is rejected (prescribes)", di(prescribes, terms).some((x) => /tells the agent to use an outside service/.test(x)), di(prescribes, terms).join(" | "));
  check("decision rules: a task that states only the need passes", di(needOnly, terms).length === 0, di(needOnly, terms).join(" | "));
  const noDec = research.validateResearch({ ...base, personas: [{ name: "Dev" }], scenarios: base.scenarios.map((s, i) => i === 0 ? { prompt: s.prompt } :
    i === 1 ? { ...s, decision: { ...decision, options: [{ kind: "product" }, { kind: "competitor" }] } } : { ...s, decision: { ...decision, evidence_url: "https://elsewhere.example.com/x" } }) } as any);
  check("decision field: required; options need an alternative and build/none; evidence must be a fetched source",
    noDec.some((x) => /scenarios\[0\]\.decision is required/.test(x)) && noDec.some((x) => /scenarios\[1\]\.decision\.options must include/.test(x)) &&
    noDec.some((x) => /scenarios\[2\]\.decision\.evidence_url must be one of your sources/.test(x)), noDec.join(" | "));
  const critic = await import("../pi-octillion/critic.js");
  const verdicts = critic.parseCritic('Here you go:\n[{"index":0,"intrinsic_decision":true,"decided_by_wording":false,"vendor_vocabulary":null,"problem":""},' +
    '{"index":1,"intrinsic_decision":true,"decided_by_wording":false,"vendor_vocabulary":"Postbox","problem":"Drop the reply-hash wording."},' +
    '{"index":2,"intrinsic_decision":false,"decided_by_wording":true,"vendor_vocabulary":null,"problem":""}]');
  const ci = critic.criticIssues(verdicts ?? []);
  check("task critic: parses its answer; rejects vendor vocabulary and tasks with no intrinsic decision", ci.length === 2 && /scenarios\[1\].*Postbox's own feature vocabulary/.test(ci[0]!) &&
    /scenarios\[2\].*does not itself force.*wording decides it/.test(ci[1]!) && critic.parseCritic("no json here") === null, ci.join(" | "));

  // run over -> job.done -> leave -> reaped; the other run's orchestrator is untouched
  await db.query("UPDATE agent_sessions SET status = 'completed' WHERE simulation_id = $1", [simA]);
  await db.query("UPDATE simulations SET status = 'completed', finished_at = now() WHERE id = $1", [simA]);
  const dA = await fleet.fleetCheckin(oA.orchestrator_id, 4, { worker_id: "w-A" }) as any;
  check("run orchestrator: job.done when the run completed, empty assignment", dA.job?.done === true && dA.assignment.length === 0, JSON.stringify(dA.job));
  await fleet.fleetLeave(oA.orchestrator_id);
  st = await tickSettle();
  check("...leaves and is reaped; the other run keeps its orchestrator", !sbs.has(oA.sandbox_id) && sbs.has(oB.sandbox_id) && (await rows()).length === 1, JSON.stringify(st.reaped));

  // backstop: a run that ended 3+ min ago whose orchestrator never left is deleted when idle
  await fleet.fleetCheckin(oB.orchestrator_id, 2, { worker_id: "w-B" });
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE simulation_id = $1", [simB]);
  await db.query("UPDATE simulations SET status = 'cancelled', finished_at = now() - interval '4 minutes' WHERE id = $1", [simB]);
  st = await tickSettle();
  check("backstop: an orchestrator whose job ended > 3 min ago is reaped", !sbs.has(oB.sandbox_id) && st.reaped?.some((x) => /is cancelled/.test(x.reason)) === true, JSON.stringify(st.reaped));

  // boat plan: launches fit what is free (1 + pods each); the rest wait
  planLimit = 8;
  await a1.release();
  const a2 = new Autoscaler({ log: (m) => quiet.push(`a2 ${m}`) });
  const s1 = await run(O, "quillmail", 3, 2), s2 = await run(O2, "left-pad", 3, 2), s3 = await run(O2, "left-pad", 1, 1);
  st = await tickSettle(a2);
  r = await rows();
  const pods = Object.fromEntries(r.map((x: any) => [x.job_id, x.pods]));
  check("boat plan: first run gets 4 pods, second the 2 left (1 + 4 + 1 + 2 = 8), third waits",
    pods[s1] === 4 && pods[s2] === 2 && !(s3 in pods) && /waits for boat plan capacity/.test(st.note ?? ""), `${JSON.stringify(pods)} note ${st.note}`);
  planLimit = 100;
  await a2.release();
  const a3 = new Autoscaler({ log: (m) => quiet.push(`a3 ${m}`) });
  st = await tickSettle(a3);
  check("...and launches once capacity frees up", (await rows()).some((x: any) => x.job_id === s3), JSON.stringify(st.jobs));

  // cooldown: a run's orchestrator idled out with sessions it could not claim -> no relaunch loop; fresh work relaunches
  const o3 = (await rows()).find((x: any) => x.job_id === s3);
  await fleet.fleetCheckin(o3.orchestrator_id, 1, { worker_id: "w-3" });
  await db.query("UPDATE agent_sessions SET queued_at = now() - interval '15 minutes' WHERE simulation_id = $1", [s3]);
  await fleet.fleetLeave(o3.orchestrator_id);
  await tickSettle(a3); st = await tickSettle(a3);
  check("cooldown: idled-out run with stuck sessions is not relaunched in a loop", !(await rows()).some((x: any) => x.job_id === s3) && /cooldown/.test(st.note ?? ""), st.note ?? "");

  // retiring (old code) per-job orchestrator: no pods, and a fresh one is launched for its job
  const o1 = (await rows()).find((x: any) => x.job_id === s1);
  await db.query("UPDATE orchestrator_sandboxes SET code_hash = 'old' WHERE id = $1", [o1.id]);
  const old = await fleet.fleetCheckin(o1.orchestrator_id, 4, { worker_id: "w-1" }) as any;
  st = await tickSettle(a3);
  check("old-code per-job orchestrator gets no pods; a fresh one takes its job", old.assignment.length === 0 &&
    (await rows()).filter((x: any) => x.job_id === s1).length === 2, `${JSON.stringify(old.assignment)} ${JSON.stringify(st.launched)}`);

  // max per-job orchestrators
  for (let i = 0; i < 4; i++) await run(O2, "left-pad", 1, 1);
  st = await tickSettle(a3); st = await tickSettle(a3);
  const live = (await rows()).filter((x: any) => !(x.code_hash === "old"));
  check("at most OCTILLION_MAX_JOB_ORCHESTRATORS (4) live", live.length === 4 && /MAX_JOB_ORCHESTRATORS/.test(st.note ?? ""), `${live.length} live, ${st.note}`);

  // shared mode still works when per-job is off
  process.env.OCTILLION_ORCH_PER_JOB = "off";
  check("OCTILLION_ORCH_PER_JOB=off -> shared fleet", !AUTOSCALE.perJob(), "");
  delete process.env.OCTILLION_ORCH_PER_JOB;

  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status IN ('queued', 'running')");
  await db.query("UPDATE simulations SET status = 'cancelled', finished_at = now() - interval '10 minutes' WHERE status IN ('queued', 'running')");
  for (const x of await rows()) await fleet.fleetLeave(x.orchestrator_id).catch(() => {});
  await tickSettle(a3);
  check("nothing of ours left on boat", ![...sbs.values()].some((s) => s.name.startsWith("octi-orch-")), [...sbs.values()].map((s) => s.name).join(","));
} catch (e) {
  check("no exception", false, String((e as Error).stack ?? e));
}
if (results.some((r) => !r.ok)) console.log(quiet.slice(-30).join("\n"));
boat.close();
await db.close();
rmSync(tmp, { recursive: true, force: true });
const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "PER-JOB TEST PASS" : "PER-JOB TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);

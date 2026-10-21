/**
 * Hermetic test for "run until done or 100 turns" (no network, no LLM, no boat):
 *   - starter-workspace template selection (deterministic mapping) and seeding (git commit; diff is vs the seed)
 *   - the deterministic done check (empty / docs-only / lockfile-only diff = not done; code / deps / config = done)
 *   - the nudge loop (core/session.ts driveToDone) stops at done, at the agent-turn cap, or when the agent gives up
 *   - finish_session is refused while the agent is resumable and not done
 *   - completed_reason + agent_turns reach /complete
 * The coding agent is test/fixtures/fake-codex.mjs on the local runner; the Octillion worker API is a tiny mock.
 *
 *   npx tsx orchestrator/test/run-until-done.ts
 */
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (...a: unknown[]) => console.log(`[rud ${new Date().toISOString().slice(11, 19)}]`, ...a);
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

// ---- mock worker API
const events = new Map<string, any[]>();
const completes = new Map<string, any>();
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const m = /^\/api\/worker\/sessions\/([^/]+)\/(events|heartbeat|complete)$/.exec(req.url ?? "");
    if (!m) { res.writeHead(404).end("{}"); return; }
    const [, id, what] = m;
    if (what === "events") events.set(id!, [...(events.get(id!) ?? []), ...body.split("\n").filter(Boolean).map((l) => JSON.parse(l))]);
    if (what === "complete") completes.set(id!, JSON.parse(body || "{}"));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, appended: 0, last_seq: 0 }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as any).port;

Object.assign(process.env, {
  OCTILLION_URL: `http://127.0.0.1:${port}`, OCTILLION_WORKER_TOKEN: "wt_test", RUNNER: "local", OCTILLION_DEV_ALLOW_LOCAL: "1",
  CREDENTIALS_MODE: "env", OPENAI_API_KEY: "sk-fake-test", TRANSCRIPT_SINK: "api", FLUSH_INTERVAL_MS: "200",
  CODEX_BIN: path.join(HERE, "fixtures", "fake-codex.mjs"), MAX_AGENT_TURNS: "50", GIVE_UP_RUNS: "3", MAX_SESSION_MINUTES: "5",
});
const { selectTemplate, seedScript, seedBase, TEMPLATES } = await import("../core/workspaces.js");
const { assessDiff } = await import("../core/progress.js");
const { WorkerSession, driveToDone, defaultNudge } = await import("../core/session.js");
const { localRunner } = await import("../core/runners.js");
const { newStepCounter } = await import("../core/turns.js");

try {
  // 1. template selection
  const cases: [Parameters<typeof selectTemplate>[0], string][] = [
    [{ prompt: "In this TypeScript service, the POST /orders endpoint accepts any JSON body. Add validation." }, "express-ts"],
    [{ language: "typescript", prompt: "Add a settings page to this Next.js app router project." }, "nextjs-ts"],
    [{ language: "TypeScript", prompt: "Write a function that parses CSV lines." }, "node-ts"],
    [{ language: "python", prompt: "Add rate limiting to the API." }, "fastapi"],
    [{ language: "python", tags: ["django"], prompt: "Send an email when a booking is created." }, "django"],
    [{ language: "go", prompt: "Add structured logging to the HTTP handlers." }, "go-http"],
    [{ prompt: "Add caching to this FastAPI app." }, "fastapi"],
    [{ prompt: "Our golang service needs retries." }, "go-http"],
    [{ prompt: "Go ahead and refactor the helper." }, "node-ts"], // "go ahead" is not Go
    [{ prompt: "Something vague." }, "node-ts"],
    [{ template: "django", language: "go", prompt: "x" }, "django"], // explicit wins
    [{ template: "nonsense", language: "go", prompt: "x" }, "go-http"], // unknown explicit ignored
  ];
  const bad = cases.filter(([i, want]) => selectTemplate(i) !== want).map(([i, want]) => `${JSON.stringify(i).slice(0, 60)} -> ${selectTemplate(i)} (want ${want})`);
  check("template selection is deterministic and matches language / tags / keywords", bad.length === 0, bad.join("; "));

  // 2. seeding: every template seeds and commits; neutral (no SDK deps)
  const seeded: string[] = [];
  for (const t of TEMPLATES) {
    const W = mkdtempSync(path.join(tmpdir(), "rud-seed-"));
    const r = spawnSync("bash", ["-c", seedScript(t)], { env: { ...process.env, W, HOME: W }, encoding: "utf8" });
    const files = spawnSync("git", ["-C", W, "ls-files"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    const manifest = files.find((f) => /^(package\.json|requirements\.txt|go\.mod|pubspec\.yaml|pom\.xml|Cargo\.toml|CMakeLists\.txt)$/.test(f));
    if (r.status === 0 && seedBase(r.stdout).length === 40 && manifest && files.some((f) => f === "README.md") && files.length >= 5) seeded.push(t);
  }
  check("every template seeds a committed project (manifest, README, sources)", seeded.length === TEMPLATES.length, seeded.join(","));
  const deps = TEMPLATES.flatMap((t) => { try { return Object.keys({ ...JSON.parse(readFileSync(path.join(HERE, "..", "workspaces", t, "package.json"), "utf8")).dependencies }); } catch { return []; } });
  check("templates stay neutral (framework deps only)", deps.every((d) => ["express", "next", "react", "react-dom", "expo", "expo-status-bar", "react-native"].includes(d)), deps.join(","));

  // 3. done check
  const diff = (...files: string[]) => files.map((f) => `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+x\n`).join("");
  const dc = [
    ["", false], [diff("README.md"), false], [diff("NOTES.md", "docs/plan.md"), false], [diff("package-lock.json"), false],
    [diff("src/store.test.ts"), false], [diff("src/validate.ts"), true], [diff("package.json"), true], [diff(".env.example"), true],
    [diff("app/main.py", "README.md"), true], [diff("next.config.mjs"), true],
  ] as const;
  const dcBad = dc.filter(([d, want]) => assessDiff(d).done !== want).map(([d, want]) => `${(d.match(/b\/(\S+)\n/g) ?? ["(empty)"]).join(" ")} want ${want}`);
  check("done check: empty/docs/lockfile/tests-only not done; code/deps/config done", dcBad.length === 0, dcBad.join("; "));

  // 4. turn counting (codex items; claude message ids)
  const cc = newStepCounter("codex");
  [{ type: "item.completed", item: { type: "agent_message" } }, { type: "item.completed", item: { type: "command_execution" } }, { type: "item.completed", item: { type: "reasoning" } }, { type: "turn.completed" }].forEach((e) => cc.observe(e));
  const cl = newStepCounter("claude-code");
  [{ type: "assistant", message: { id: "m1" } }, { type: "assistant", message: { id: "m1" } }, { type: "assistant", message: { id: "m2" } }, { type: "user" }].forEach((e) => cl.observe(e));
  check("turn counting: codex step items, claude distinct responses", cc.total === 2 && cl.total === 2, `codex ${cc.total}, claude ${cl.total}`);
  check("neutral nudges never name tools", [0, 1, 2, 3].every((n) => !/[A-Z][a-z]+[A-Z]|npm|pip|zod|joi|yup/.test(defaultNudge({ last_assistant_text: "Should I?" }, n) + defaultNudge({ last_assistant_text: "ok." }, n))));

  // 4b. the diff (vs the seed commit) keeps lockfile content out of the scored transcript
  const { getAdapter } = await import("../harnesses/adapters.js");
  const sbx = await localRunner.open({ adapter: getAdapter("codex"), repoUrl: null, template: "express-ts" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(sbx.workdir, "package-lock.json"), '{"packages":{"node_modules/some-transitive-dep":{}}}\n');
  writeFileSync(path.join(sbx.workdir, "src", "validate.ts"), "export const v = 1;\n");
  const lockDiff = (await sbx.diff()) ?? "";
  await sbx.cleanup();
  check("diff vs the seed: code in full, lockfiles by name only", /b\/src\/validate\.ts/.test(lockDiff) && !/some-transitive-dep/.test(lockDiff)
    && /# lockfile changed \(content omitted\): package-lock\.json/.test(lockDiff) && !/b\/src\/server\.ts/.test(lockDiff) && assessDiff(lockDiff).done,
    lockDiff.split("\n").filter((l) => /^diff|^#/.test(l)).join(" | "));

  // 5. sessions with the fake agent
  const job = (id: string, mode: string) => ({
    session_id: id, simulation_id: "sim_t", org_id: 1, product_id: 1, model: "gpt-test", harness: "codex", agent_id: "codex/default", attempt: 1,
    prompt: `MODE=${mode} In this TypeScript service, the POST /orders endpoint accepts any JSON body. Add proper validation.`,
    repo_url: null, language: null, template: null, tags: [], title: "Validate orders", max_user_turns: 5, profile: null,
  });

  // 5a. plan first -> not done -> finish refused -> nudge -> done
  const a = await WorkerSession.start(job("ses_plan", "plan_then_code") as any, localRunner);
  const r1 = await a.waitForTurn();
  const refusal = a.finishRefusal();
  check("planning-only first run: not done, must_continue, finish_session refused", !r1.workspace?.done && r1.must_continue && !!refusal && a.template === "express-ts",
    `${r1.workspace?.reason}; template ${a.template}; refusal: ${refusal?.slice(0, 60)}`);
  const ra = await driveToDone(a);
  await a.finish({ orchestrator: { orchestrator: "test" } });
  const ca = completes.get("ses_plan");
  check("nudged until done: completed_reason=done, diff vs the seed has only the new file",
    ca?.completed_reason === "done" && ca?.status === "completed" && JSON.stringify(a.progress?.changed_files) === JSON.stringify(["src/validate.ts"]) && a.nudges === 1,
    `reason ${ca?.completed_reason}, files ${a.progress?.changed_files.join(",")}, nudges ${a.nudges}, turns ${ca?.metadata?.agent_turns}, report.done ${ra.workspace?.done}`);
  const evA = events.get("ses_plan") ?? [];
  const nudge = evA.find((e) => e.type === "simulated_user");
  check("the nudge is a simulated_user event and the session_end event records the reason",
    !!nudge && evA.some((e) => e.type === "session_end" && e.completed_reason === "done") && evA.some((e) => e.type === "file_edit" && /src\/validate\.ts/.test(e.content ?? "")),
    nudge?.content ?? "(none)");

  // 5a2. plan-then-execute (exec_mode "plan"): codex has no headless plan mode, so the plan is asked for in the task;
  // the first report is the plan phase, the developer's go-ahead is the approval, then it implements.
  const { PLAN_FIRST } = await import("../harnesses/adapters.js");
  const pj = await WorkerSession.start({ ...job("ses_planmode", "plan_then_code"), exec_mode: "plan" } as any, localRunner);
  const p1 = await pj.waitForTurn();
  check("plan mode: first run is the plan phase, asked for in the task (prompted), must_continue",
    p1.phase === "plan" && p1.must_continue && pj.planMode === "prompted" && /Plan:/.test(p1.last_assistant_text), `phase ${p1.phase}, mode ${pj.planMode}`);
  check("plan mode: the fallback developer approves the plan", /go ahead/i.test(defaultNudge(p1, 0)) && /looks good|makes sense|sounds good/i.test(defaultNudge(p1, 0)), defaultNudge(p1, 0));
  const p2 = await driveToDone(pj);
  await pj.finish({});
  const cp = completes.get("ses_planmode");
  const evP = events.get("ses_planmode") ?? [];
  check("plan mode: approved, implemented, execute phase after the go-ahead",
    p2.phase === "execute" && cp?.completed_reason === "done" && evP.some((e) => e.type === "exec_mode" && e.plan === "prompted")
    && evP.some((e) => e.type === "simulated_user" && e.phase === "plan_approval"), `phase ${p2.phase}, reason ${cp?.completed_reason}`);
  check("plan mode: metadata records the mode, that it waited, and the plan",
    cp?.metadata?.exec_mode === "plan" && cp?.metadata?.plan_mode === "prompted" && cp?.metadata?.plan_waited === true && /Plan:/.test(cp?.metadata?.plan_text ?? ""),
    JSON.stringify({ m: cp?.metadata?.exec_mode, w: cp?.metadata?.plan_waited }));
  check("direct mode: metadata says direct", ca?.metadata?.exec_mode === "direct" && !("plan_text" in (ca?.metadata ?? {})));
  check("plan mode (prompted): the task carries the plan-first line", /waiting for your go-ahead/.test(p1.last_assistant_text) && PLAN_FIRST.includes("go-ahead"), p1.last_assistant_text.slice(-60));
  const o = { model: "m", workdir: "/w" };
  const dg = getAdapter("claude-code").newDigest();
  dg.observe({ type: "assistant", message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: "1. Add a validation module.\n2. Wire it in." } }] } });
  dg.observe({ type: "result", subtype: "success", result: "I've written up the plan above." });
  check("claude plan mode: the digest carries the ExitPlanMode plan", /Add a validation module/.test(dg.result().lastText) && /written up the plan/.test(dg.result().lastText));
  const cpa = getAdapter("claude-code").planArgv!(o), cua = getAdapter("cursor").planArgv!(o);
  check("native plan modes: claude --permission-mode plan (no bypass), cursor --mode plan; codex has none",
    cpa.join(" ").includes("--permission-mode plan") && !cpa.includes("--dangerously-skip-permissions") && cua.join(" ").includes("--mode plan")
    && !getAdapter("codex").planArgv, cpa.join(" "));

  // 5b. docs-only first run is not done
  const b = await WorkerSession.start(job("ses_docs", "docs_then_code") as any, localRunner);
  const rb1 = await b.waitForTurn();
  await driveToDone(b);
  await b.finish({});
  check("docs-only run is not done; the code change after a nudge is", !rb1.workspace?.done && completes.get("ses_docs")?.completed_reason === "done", rb1.workspace?.reason ?? "");

  // 5c. turn cap: 32 steps per run, cap 50 -> stops in run 2
  const c = await WorkerSession.start(job("ses_cap", "busy_never_done") as any, localRunner);
  await driveToDone(c);
  await c.finish({});
  const cc2 = completes.get("ses_cap");
  check("turn cap: the loop stops at MAX_AGENT_TURNS and records turn_cap", cc2?.completed_reason === "turn_cap" && cc2?.status === "completed" && cc2?.metadata?.agent_turns >= 50 && c.runs === 2,
    `reason ${cc2?.completed_reason}, turns ${cc2?.metadata?.agent_turns}, runs ${c.runs}`);

  // 5d. gives up: no change after GIVE_UP_RUNS nudged runs
  const d = await WorkerSession.start(job("ses_quit", "gives_up") as any, localRunner);
  await driveToDone(d);
  await d.finish({});
  const cd = completes.get("ses_quit");
  check("agent that never changes anything ends as agent_gave_up after GIVE_UP_RUNS nudges", cd?.completed_reason === "agent_gave_up" && d.nudges === 3 && d.runs === 4,
    `reason ${cd?.completed_reason}, nudges ${d.nudges}, runs ${d.runs}`);
} catch (e) {
  check("no exception", false, String((e as Error).stack ?? e));
} finally {
  server.close();
}

const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "RUN-UNTIL-DONE TEST PASS" : "RUN-UNTIL-DONE TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);

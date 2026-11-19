// A log drain's analytics, A/B comparisons and health (mold_v0-325; src/log-drain.ts, src/developer-inbound.ts,
// src/log-drain-health.ts), offline: an embedded database, the embedded fixture with deployments (each naming the one
// it replaced), hourly reports and comparisons, and a sample of Vercel's documented log-drain format
// (scripts/lib/log-drain-sample.ts) signed with a secret made at run time and sent through the real HTTP route.
//   npx tsx scripts/log-drain-analytics-test.ts
//
//  1. Pure: Vercel's -1 statuses (a crashed function is a server error; a background revalidation is no request); the
//     verdict rules on hand-computed sides (insufficient data, an error-rate rise, a p95 rise, a rise too small to be
//     sure of, never "improved"); the matching periods; the compare options read defensively; the build's checks.
//  2. Health before anything: not connected (no source); a source and nothing yet: waiting.
//  3. The sample through POST /v1/inbound/<source>: every report window's requests, server errors and p95 equal the
//     sample's own requests counted independently; preview lines, build lines and revalidations not counted; the
//     comparisons: release 2 regressed against release 1 (errors and latency), release 3 no change detected against
//     release 2 (never called better), release 4 insufficient data; each comparison's numbers equal the sides counted
//     independently. The metrics a page charts (requests by day and by deployment, errors by deployment, comparisons
//     by verdict, a comparison table) equal the same counts.
//  4. Health after: receiving; /api/log-drains/status to a member; silent after the receiver's silent hours, marked
//     once by the scheduled check however often it runs; a delivery clears it.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";
import { EMBEDDED_DIR, embeddedJson } from "./lib/embedded-fixture.js";
import { deliveries, vercelSample, type TruthRequest } from "./lib/log-drain-sample.js";

const HOUR = 3_600_000;
const RECEIVER = {
  name: "hosting_logs", description: "The hosting provider's request logs, as hourly reports.", area: "deployment_reports", signature: "vercel",
  log_drain: {
    secret_env: "TEST_LOG_DRAIN_SECRET", window_minutes: 60, silent_hours: 6,
    deployments: { area: "deployments", field: "provider_id", match: "deployment_id" },
    environments: ["production"],
    compare: { area: "deployment_comparisons", previous_field: "previous" },
  },
};
const VERDICT = { name: "verdict", label: "Verdict", type: "enum", options: [
  { value: "insufficient_data", label: "Not enough traffic yet" }, { value: "no_change_detected", label: "No change detected" }, { value: "regressed", label: "Worse" }] };

try {
  const ld = await import("../src/log-drain.js");

  // ---------- 1. pure ----------
  {
    const reqs = ld.requestsOf([
      { requestId: "a", deploymentId: "d", statusCode: -1, source: "lambda", timestamp: 10 },
      { requestId: "b", deploymentId: "d", source: "lambda", proxy: { statusCode: -1, host: "x.example.com" }, timestamp: 10 },
      { deploymentId: "d", source: "lambda", proxy: { statusCode: -1 }, timestamp: 10 },
    ], { sources: null, environments: null });
    assert.deepEqual(reqs.map((r) => r.status), [500], "a crashed function is a server error; a revalidation is not a request");

    const side = (requests: number, errors: number, p95: number | null, timed = requests) => ({ requests, errors, timed, p95_ms: p95, from: null, to: null });
    let v = ld.compareSides(side(999, 0, 100), side(5000, 0, 100));
    assert.equal(v.verdict, "insufficient_data"); assert.match(v.reason, /999 on the one it replaced; each needs 1,000/);
    // 1% -> 2% on 5,000 a side: p = 0.015, se = sqrt(.015 * .985 * 2/5000) = 0.0024311, z = 0.01 / se = 4.113
    v = ld.compareSides(side(5000, 50, 100), side(5000, 100, 100));
    assert.equal(v.verdict, "regressed"); assert.equal(v.z, 4.113); assert.equal(v.error_rate_change, 1);
    assert.match(v.reason, /server errors rose from 1% to 2% of requests/);
    // 1% -> 1.4%: 0.4 points is under 0.5 (z 1.85): no change detected, never better
    v = ld.compareSides(side(5000, 50, 100), side(5000, 70, 100));
    assert.equal(v.verdict, "no_change_detected"); assert.ok(!/improv|better|faster|passed/i.test(v.reason), v.reason);
    // 0.6 points but too few to be sure: 1,000 a side, 1% -> 1.6%: z = 0.006 / sqrt(.013 * .987 * 2/1000) = 1.184
    v = ld.compareSides(side(1000, 10, 100), side(1000, 16, 100));
    assert.equal(v.verdict, "no_change_detected"); assert.equal(v.z, 1.184);
    // p95 up 25% with enough timed requests: regressed; the same rise on 999 timed: not judged
    v = ld.compareSides(side(5000, 0, 200), side(5000, 0, 250));
    assert.equal(v.verdict, "regressed"); assert.equal(v.p95_change, 0.25); assert.match(v.reason, /slowest 5% of responses took 250 ms or more, up from 200 ms/);
    assert.equal(ld.compareSides(side(5000, 0, 200, 999), side(5000, 0, 250)).verdict, "no_change_detected");
    // fewer errors and faster: no change detected, never called better
    v = ld.compareSides(side(5000, 100, 300), side(5000, 10, 100));
    assert.equal(v.verdict, "no_change_detected"); assert.ok(!/improv|better|faster|passed/i.test(v.reason), v.reason);
    // thresholds from the options
    assert.equal(ld.compareSides(side(500, 0, 100), side(500, 50, 100), { min_requests: 100, min_error_points: 0.5, min_z: 1.96, p95_rise: 0.2 }).verdict, "regressed");
    assert.deepEqual(ld.comparePeriods(10 * HOUR, 40 * HOUR, 24), { candidate: [10 * HOUR, 34 * HOUR], baseline: [-14 * HOUR, 10 * HOUR] });
    assert.deepEqual(ld.comparePeriods(10 * HOUR, 12 * HOUR, 168), { candidate: [10 * HOUR, 12 * HOUR], baseline: [8 * HOUR, 10 * HOUR] });
    const o = ld.logDrainOptions({ log_drain: { compare: { area: "cmp", min_requests: -4, p95_rise: "x", fields: { verdict: "BAD" } }, silent_hours: 0 } })!;
    assert.deepEqual({ ...o.compare, fields: o.compare!.fields }, { area: "cmp", previous_field: "previous", hours: 168, min_requests: 1000, min_error_points: 0.5, min_z: 1.96, p95_rise: 0.2, fields: {} });
    assert.equal(o.silent_hours, 6, "defaults for values out of range");
    assert.equal(ld.logDrainOptions({ log_drain: {} })!.compare, null, "no compare: none kept");
    const probs = ld.logDrainProblems(0, { area: "reports", log_drain: { deployments: { area: "deps", field: "pid" }, compare: { area: "cmp", previous_field: "prev", fields: { reason: "why" } } } }, [
      { name: "reports", scope: "workspace", fields: ["requests"] }, { name: "deps", scope: "workspace", fields: ["pid", "prev"], refs: { prev: "other" } },
      { name: "cmp", scope: "workspace", fields: ["verdict"], enums: { verdict: ["regressed"] } }]);
    for (const want of [/compare.previous_field: prev refers to other/, /compare.fields.reason: why is not a field of cmp/, /cmp.verdict has no option insufficient_data/])
      assert.ok(probs.some((p) => want.test(p)), `${want}: ${probs.join(" | ")}`);
    assert.ok(ld.logDrainProblems(0, { area: "reports", log_drain: { deployments: { area: "deps", field: "pid" }, compare: { area: "nope" } } }, [
      { name: "reports", scope: "workspace", fields: [] }, { name: "deps", scope: "workspace", fields: ["pid", "previous"] }]).some((p) => /compare.area: nope/.test(p)));
  }
  console.log("✓ pure: Vercel's -1 statuses; verdicts on hand-computed sides (insufficient, errors, p95, too small to be sure, never better); matching periods; options and build checks");

  // ---------- the world ----------
  await import("../src/hosts.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { setPackConfigsForTest } = await import("../src/host.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const json = embeddedJson();
  json.record_areas.push(
    { name: "deployments", label: "Deployments", role: "source", scope: "workspace", fields: [
      { name: "provider_id", label: "Provider id", type: "text" }, { name: "previous", label: "Replaced", type: "reference", to: "deployments" }] },
    { name: "deployment_reports", label: "Deployment reports", role: "source", scope: "workspace", fields: [
      { name: "deployment", label: "Deployment", type: "reference", to: "deployments" },
      { name: "window_start", label: "From", type: "date" }, { name: "window_end", label: "To", type: "date" },
      { name: "requests", label: "Requests", type: "number" }, { name: "errors", label: "Errors", type: "number" },
      { name: "error_rate", label: "Error rate", type: "number" }, { name: "p95_ms", label: "p95 (ms)", type: "number" },
      { name: "mean_ms", label: "Mean (ms)", type: "number" }, { name: "source", label: "Source", type: "text" },
      { name: "buckets", label: "Latency histogram", type: "json" }] },
    { name: "deployment_comparisons", label: "Comparisons", role: "source", scope: "workspace", fields: [
      { name: "candidate", label: "Deployment", type: "reference", to: "deployments" }, { name: "baseline", label: "Compared with", type: "reference", to: "deployments" },
      VERDICT, { name: "reason", label: "Why", type: "text" },
      ...["candidate_requests", "baseline_requests", "candidate_errors", "baseline_errors", "candidate_error_rate", "baseline_error_rate", "error_rate_change",
        "candidate_p95_ms", "baseline_p95_ms", "p95_change", "z_score"].map((n) => ({ name: n, label: n, type: "number" })),
      ...["candidate_from", "candidate_to", "baseline_from", "baseline_to", "compared_at"].map((n) => ({ name: n, label: n, type: "date" }))] });
  json.metrics = [...(json.metrics ?? []),
    { name: "drain_requests_daily", label: "Requests per day", over: "deployment_reports", measure: "sum", field: "requests", unit: "count", by_time: { at: "window_start", every: "day", last: 7 } },
    { name: "drain_requests_by_deployment", label: "Requests", over: "deployment_reports", measure: "sum", field: "requests", unit: "count", group_by: "deployment" },
    { name: "drain_errors_by_deployment", label: "Server errors", over: "deployment_reports", measure: "sum", field: "errors", unit: "count", group_by: "deployment" },
    { name: "drain_p95_daily", label: "Slowest 5% (hourly average)", over: "deployment_reports", measure: "average", field: "p95_ms", unit: "ms", by_time: { at: "window_start", every: "day", last: 7 } },
    { name: "cmp_by_verdict", label: "Comparisons", over: "deployment_comparisons", group_by: "verdict" },
    { name: "cmp_p95_change", label: "p95 change", over: "deployment_comparisons", measure: "average", field: "p95_change", unit: "percent", group_by: "candidate" },
  ];
  json.charts = [...(json.charts ?? []), { name: "drain_requests_chart", title: "Requests per day", type: "line", metrics: ["drain_requests_daily"] },
    { name: "drain_p95_chart", title: "Slowest responses", type: "line", metrics: ["drain_p95_daily"] }];
  setPacksForTest([{ manifest: { id: json.id, name: json.name, version: json.version, entry: null, migrations: null, words: {}, dir: EMBEDDED_DIR }, declared: compileDeclarations(json), definition: null } as never]);
  const { $comment: _c, ...cfg } = json.developer_surface;
  setPackConfigsForTest([{ pack: json.id, developer_surface: { ...cfg, client_sessions: { ttl_seconds: 3600, ...cfg.client_sessions }, webhooks_in: [...cfg.webhooks_in, RECEIVER] } }]);
  const { developerSurfaceProblems } = await import("../src/developer-config.js");
  const { recordAreas } = await import("../src/record-areas.js");
  const facts = recordAreas().map((a) => ({ name: a.name, scope: a.scope, fields: a.fields.map((f) => f.name),
    enums: Object.fromEntries(a.fields.filter((f) => f.type === "enum").map((f) => [f.name, (f.options ?? []).map((x: any) => (typeof x === "string" ? x : x.value))])),
    refs: Object.fromEntries(a.fields.filter((f) => f.type === "reference").map((f) => [f.name, (f as { to?: string }).to ?? ""])) }));
  assert.deepEqual(developerSurfaceProblems({ ...cfg, client_sessions: { ttl_seconds: 3600, ...cfg.client_sessions }, webhooks_in: [RECEIVER as never] }, facts), [], "the receiver is sound for the build");

  const { createOrg } = await import("../src/auth.js");
  const { workspaceRecords } = await import("../src/record-areas.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const { computeMetrics } = await import("../src/metrics.js");
  const health = await import("../src/log-drain-health.js");
  const inbound = await import("../src/developer-inbound.js");
  const { getDb } = await import("../src/db.js");
  const org = (await createOrg(`Drain analytics ${STAMP}`)).org;
  const other = (await createOrg(`Drain other ${STAMP}`)).org;
  const recs = () => workspaceRecords(json.id, org.orgId);
  const now = Date.now();
  const start = Math.floor(now / HOUR) * HOUR - 74 * HOUR;
  const sample = vercelSample(start);
  await withTenant(org.orgId, async () => {
    for (const d of sample.deployments)
      await recs().create("deployments", d.key, { title: d.title, data: { provider_id: d.provider_id, ...(d.previous ? { previous: d.previous } : {}) } });
  });

  // ---------- 2. health before anything ----------
  assert.deepEqual((await health.drainStatus(org.orgId)).map((d) => [d.receiver, d.state, d.areas]), [["hosting_logs", "not_connected", ["deployment_reports", "deployment_comparisons"]]]);
  const src = await inbound.createSource(org.orgId, { receiver: "hosting_logs", description: "hosting logs" }, null);
  assert.equal((await health.drainStatus(org.orgId))[0]!.state, "waiting");
  assert.equal((await health.drainStatus(other.orgId))[0]!.state, "not_connected", "another workspace's source is not this one's");
  console.log("✓ health before: not connected without a source, waiting with one and nothing received, per workspace");

  // ---------- 3. the sample through the HTTP route ----------
  const http = await startHttp();
  try {
    const SECRET = randomBytes(24).toString("hex");
    process.env.TEST_LOG_DRAIN_SECRET = SECRET;
    const bodies = deliveries(sample.groups);
    assert.ok(bodies.length >= 30, `${bodies.length} deliveries`);
    let unknown = 0, requests = 0;
    for (const body of bodies) {
      const r = await http.req("POST", `/v1/inbound/${src.id}`, { "content-type": body.startsWith("[") ? "application/json" : "application/x-ndjson",
        "x-vercel-signature": ld.vercelSignature(SECRET, body), "user-agent": "VercelDrain/1.0 (+https://vercel.com/docs/drains)" }, body);
      const out = await r.json() as any;
      assert.equal(r.status, 200, JSON.stringify(out));
      unknown += out.unknown; requests += out.requests;
    }
    const bad = await http.req("POST", `/v1/inbound/${src.id}`, { "x-vercel-signature": ld.vercelSignature("not-the-secret", bodies[0]!) }, bodies[0]!);
    assert.equal(bad.status, 400, "a delivery signed with another secret is refused");
    assert.equal(unknown, 0);
    assert.equal(requests, sample.truth.length, "every production request counted once: preview, build and revalidation lines are not requests");

    // Every report window against the truth, counted here without the receiver's code.
    const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR;
    const byWindow = new Map<string, TruthRequest[]>();
    for (const t of sample.truth) { const k = `${t.deployment}|${hourOf(t.at)}`; byWindow.set(k, [...(byWindow.get(k) ?? []), t]); }
    const all: any[] = [];
    await withTenant(org.orgId, async () => { let after: string | undefined; do { const p = await recs().list("deployment_reports", { limit: 200, ...(after ? { after } : {}) }); all.push(...p.records); after = p.next ?? undefined; } while (after); });
    assert.equal(all.length, byWindow.size, "one report a deployment and hour");
    const nearest = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.ceil(q * s.length) - 1]!; };
    for (const r of all) {
      const t = byWindow.get(`${r.data.deployment}|${Date.parse(r.data.window_start)}`)!;
      assert.ok(t, r.key);
      assert.equal(r.data.requests, t.length, `${r.key} requests`);
      assert.equal(r.data.errors, t.filter((x) => x.status >= 500).length, `${r.key} errors`);
      const timed = t.map((x) => x.duration_ms).filter((x): x is number => x !== null);
      assert.equal(r.data.p95_ms, timed.length ? ld.bucketOf(nearest(timed, 0.95)) : undefined, `${r.key} p95 (the exact nearest rank, to the histogram's 2 significant digits)`);
      const json = JSON.stringify(r.data);
      for (const leak of ["203.0.113", "Mozilla", "/api/items", "req_"]) assert.ok(!json.includes(leak), `nothing of a line kept: ${leak}`);
    }
    console.log(`✓ ${bodies.length} signed deliveries (NDJSON and JSON arrays) through POST /v1/inbound: ${all.length} hourly reports, each window's requests, server errors and p95 equal to the sample's own`);

    // The comparisons, against sides counted here.
    const sideOfTruth = (key: string, from: number, to: number) => {
      const t = sample.truth.filter((x) => x.deployment === key && hourOf(x.at) >= from && hourOf(x.at) < to);
      const timed = t.map((x) => x.duration_ms).filter((x): x is number => x !== null);
      return { requests: t.length, errors: t.filter((x) => x.status >= 500).length, timed: timed.length, p95_ms: timed.length ? ld.bucketOf(nearest(timed, 0.95)) : null, from, to };
    };
    const cmp = (k: string) => withTenant(org.orgId, () => recs().get("deployment_comparisons", k));
    assert.equal(await cmp("release-1"), null, "the first deployment replaced none: no comparison");
    const want: Record<string, string> = { "release-2": "regressed", "release-3": "no_change_detected", "release-4": "insufficient_data" };
    for (const d of sample.deployments.slice(1)) {
      const c = (await cmp(d.key))!;
      assert.ok(c, d.key);
      const span = Math.min(d.hours, 168) * HOUR;
      const expect = ld.compareSides(sideOfTruth(d.previous!, d.from - span, d.from), sideOfTruth(d.key, d.from, d.from + span));
      assert.equal(c.data.verdict, want[d.key], `${d.key}: ${c.data.reason}`);
      assert.equal(c.data.verdict, expect.verdict);
      assert.equal(c.data.candidate, d.key); assert.equal(c.data.baseline, d.previous);
      for (const f of ["candidate_requests", "baseline_requests", "candidate_errors", "baseline_errors", "candidate_p95_ms", "baseline_p95_ms", "p95_change", "z", "error_rate_change"] as const)
        assert.equal(c.data[f === "z" ? "z_score" : f] ?? null, expect[f], `${d.key} ${f}`);
      assert.equal(c.data.candidate_from, new Date(d.from).toISOString()); assert.equal(c.data.baseline_to, new Date(d.from).toISOString());
      assert.equal(c.title, `${d.title} compared with ${sample.deployments.find((x) => x.key === d.previous)!.title}`);
      assert.ok(!/improv|better|faster|passed/i.test(String(c.data.reason)), String(c.data.reason));
    }
    const r2 = (await cmp("release-2"))!.data;
    assert.match(String(r2.reason), /server errors rose from .* to .* of requests; and the slowest 5% of responses took/);
    console.log(`✓ comparisons: release 2 regressed (${r2.reason}); release 3 no change detected; release 4 not enough traffic; every number equal to the sides counted independently`);

    // The metrics a page charts.
    const m = Object.fromEntries((await computeMetrics(org.orgId, ["drain_requests_daily", "drain_requests_by_deployment", "drain_errors_by_deployment", "drain_p95_daily", "cmp_by_verdict", "cmp_p95_change"],
      { role: "viewer", userId: null })).map((x: any) => [x.name, x])) as Record<string, any>;
    for (const x of Object.values(m)) assert.ok(!("error" in x), JSON.stringify(x));
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    const perDay = new Map<string, number>();
    for (const t of sample.truth) perDay.set(day(hourOf(t.at)), (perDay.get(day(hourOf(t.at))) ?? 0) + 1);
    const series = m.drain_requests_daily.series[0].values as (number | null)[], buckets = m.drain_requests_daily.buckets as string[];
    for (const [d, n] of perDay) if (buckets.includes(d)) assert.equal(series[buckets.indexOf(d)], n, `requests on ${d}`);
    assert.equal(series.reduce<number>((a, b) => a + (b ?? 0), 0), sample.truth.length, "the week's requests add up to the sample's");
    for (const d of sample.deployments) {
      const g = (name: string) => m[name].groups.find((x: any) => x.key === d.key)?.value;
      assert.equal(g("drain_requests_by_deployment"), sample.truth.filter((x) => x.deployment === d.key).length, `${d.key} requests`);
      assert.equal(g("drain_errors_by_deployment") ?? 0, sample.truth.filter((x) => x.deployment === d.key && x.status >= 500).length, `${d.key} errors`);
    }
    assert.equal(m.drain_requests_by_deployment.groups.find((x: any) => x.key === "release-2").label, "Release 2", "a deployment is named by its title");
    const verdicts = Object.fromEntries(m.cmp_by_verdict.groups.map((x: any) => [x.key, x.value]));
    assert.deepEqual({ r: verdicts.regressed, n: verdicts.no_change_detected, i: verdicts.insufficient_data }, { r: 1, n: 1, i: 1 });
    assert.equal(m.cmp_p95_change.groups.find((x: any) => x.key === "release-2").value, (await cmp("release-2"))!.data.p95_change);
    assert.equal(m.drain_p95_daily.unit, "ms", "a response time reads in ms");
    console.log("✓ the charted metrics: requests by day and by deployment, server errors by deployment, comparisons by verdict, p95 change by deployment, equal to the sample's counts");

    // ---------- 4. health after ----------
    assert.equal((await health.drainStatus(org.orgId))[0]!.state, "receiving");
    const tok = await http.signIn(org, "viewer");
    const st = await http.req("GET", "/api/log-drains/status", { authorization: `Bearer ${tok}` });
    const sb = await st.json() as any;
    assert.equal(st.status, 200, JSON.stringify(sb));
    assert.equal(sb.drains[0].state, "receiving"); assert.equal(sb.drains[0].hours_since, 0);
    assert.equal((await http.req("GET", "/api/log-drains/status")).status, 401, "signed out");
    const db = await getDb();
    await db.query("UPDATE webhook_sources SET last_received_at = now() - interval '7 hours' WHERE id = $1", [src.id]);
    const s1 = (await health.drainStatus(org.orgId))[0]!;
    assert.deepEqual([s1.state, s1.hours_since], ["silent", 7]);
    const c1 = await health.logDrainCheck(), c2 = await health.logDrainCheck();
    assert.ok(c1.marked >= 1, JSON.stringify(c1));
    const row = async () => (await db.query<{ silent_since: Date | null }>("SELECT silent_since FROM webhook_sources WHERE id = $1", [src.id]))[0]!.silent_since;
    const since = await row();
    assert.ok(since, "marked silent");
    assert.equal(c2.marked, 0, "a silence is marked once, however often the check runs");
    await health.logDrainCheck(new Date(Date.now() + 5 * HOUR));
    assert.equal((await row())!.getTime(), since!.getTime(), "never marked again while it lasts");
    assert.equal((await health.drainStatus(org.orgId))[0]!.silent_since, since!.toISOString());
    // A source that never received: marked once it is silent_hours old.
    const fresh = await inbound.createSource(other.orgId, { receiver: "hosting_logs" }, null);
    assert.equal((await health.logDrainCheck()).marked, 0, "a new source is not silent yet");
    await db.query("UPDATE webhook_sources SET created_at = now() - interval '6 hours' WHERE id = $1", [fresh.id]);
    assert.equal((await health.logDrainCheck()).marked, 1, "set up six hours ago and nothing came: marked");
    // A delivery ends the silence.
    const body = sample.groups.slice(0, 3).flat().map((l) => JSON.stringify(l)).join("\n");
    const again = await http.req("POST", `/v1/inbound/${src.id}`, { "x-vercel-signature": ld.vercelSignature(SECRET, body) }, body);
    assert.equal(again.status, 200);
    assert.equal(await row(), null, "a delivery clears the mark");
    assert.equal((await health.drainStatus(org.orgId))[0]!.state, "receiving");
    console.log("✓ health after: receiving, read on /api/log-drains/status; silent after its hours, marked once by the check however often it runs; a delivery clears it");
  } finally {
    await http.close();
  }
} finally {
  cleanup();
}
process.exit(0);

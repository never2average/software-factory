export const meta = {
  name: 'clone-replica',
  description: 'Clone the live fde-agent into a stamped app with parallel agents: preflight, deploy with a diagnosis panel on failure, data, configure, adversarially verified checks, report',
  whenToUse: 'When an app stamped with clone_of must become a running, verified replica of live. args: {app_id, date}',
  phases: [
    { title: 'Preflight', detail: 'live access, state, mold, deploy lock — in parallel' },
    { title: 'Deploy', detail: 'provision --deploy; on failure a 3-hypothesis diagnosis panel, a judge, one fix, retry' },
    { title: 'Data', detail: 'pg_dump/restore + blob copy from live' },
    { title: 'Configure', detail: 'apply the surface to the clone database' },
    { title: 'Verify', detail: 'regress + one analyst per dimension, each pass adversarially refuted' },
    { title: 'Report', detail: 'clone report, state, commit and push' },
  ],
}
const ROOT = '/root/software-factory'
const MOLD = ROOT + '/molds/mold_v1/codebase'
const APP = args.app_id
const DATE = args.date
const SCRATCH = args.scratch || '/tmp/claude-0/-root-software-factory/ad83db9f-e0de-4d9e-901e-6d3c41b1fe3e/scratchpad'
const STEP = { type: 'object', properties: { ok: { type: 'boolean' }, exit_code: { type: 'integer' }, tail: { type: 'string' } }, required: ['ok', 'tail'] }
const GATE = { type: 'object', properties: { finished: { type: 'boolean' }, ok: { type: 'boolean' }, tail: { type: 'string' } }, required: ['finished', 'ok', 'tail'] }
const DIAG = { type: 'object', properties: { hypothesis: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' } }, required: ['hypothesis', 'evidence', 'fix', 'confidence'] }
const JUDGE = { type: 'object', properties: { chosen: { type: 'integer' }, reason: { type: 'string' } }, required: ['chosen', 'reason'] }
const VERIFY = { type: 'object', properties: { dimension: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail', 'skipped'] }, evidence: { type: 'string' } }, required: ['dimension', 'status', 'evidence'] }
const REFUTE = { type: 'object', properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } }, required: ['refuted', 'reason'] }
const RULES = `Rules: never touch the live Vercel projects fde-agent, fde-agent-api, fde-task-workflow except to read; never edit files under ${MOLD}; never print secret values; state lives under ${ROOT}/state/application/${APP}/. Scripts: ${ROOT}/.claude/scripts/clone.py, provision.py, factory.py; docs ${ROOT}/docs/HOW_IT_WORKS.md and ${ROOT}/.claude/skills/clone/SKILL.md.`

// ---------------- Preflight (parallel, read-only) ----------------
phase('Preflight')
const pre = await parallel([
  () => agent(`Preflight: live access. cd ${ROOT}; run: python3 .claude/scripts/clone.py ${APP} plan; then python3 .claude/scripts/clone.py ${APP} blobls dataroom/ (lists the live data room top level; needs no input). Report ok=true only if both ran and the blob listing printed folder counts. ${RULES}`, { label: 'pre:live', schema: STEP, effort: 'low' }),
  () => agent(`Preflight: state. cd ${ROOT}; run python3 .claude/scripts/factory.py validate, then print with python3 -c the app's clone_of, workspace.org, infrastructure.vercel and datastores.postgres.scope from the four JSON files. ok=true only if validate printed ok and clone_of exists and scope is fresh. ${RULES}`, { label: 'pre:state', schema: STEP, effort: 'low' }),
  () => agent(`Preflight: mold. cd ${MOLD}; check node -v is 24.x, node_modules exists, npx eve --version prints, and the three files vercel.json vercel.api.json vercel.eve.json exist. ok=true only if all hold. Read-only. ${RULES}`, { label: 'pre:mold', schema: STEP, effort: 'low' }),
  () => agent(`Deploy lock. A provision deploy may be running in the background writing ${SCRATCH}/deploy3.log (it appends a final line "exit=<code>" when done). Poll every 20s for up to 25 minutes with an until-loop (no single sleep over 30s) until that line exists or no process matches "provision.py ${APP} --deploy" in pgrep -af. Report finished=true when done, ok=true only if the exit line is exit=0, and the last 30 log lines as tail (if the log is empty because output was buffered, read ${ROOT}/state/application/${APP}/infrastructure.json vercel.production_url/api_url/workflow_url and cd ${MOLD} && vercel ls claudecode-web-api and claudecode-web-workflow to judge ok: ok=true only if their newest deployment shows Ready). ${RULES}`, { label: 'pre:deploy-lock', schema: GATE }),
])
const [live, state, mold, gate] = pre
log(`preflight: live=${live?.ok} state=${state?.ok} mold=${mold?.ok} deploy finished=${gate?.finished} ok=${gate?.ok}`)
if (!live?.ok || !state?.ok || !mold?.ok) return { stopped: 'preflight', live, state, mold }

// ---------------- Deploy with diagnosis panel ----------------
phase('Deploy')
let deployOk = !!gate?.ok, deployTail = gate?.tail ?? '', attempts = 0, fixes = []
while (!deployOk && attempts < 2) {
  attempts++
  log(`deploy failed; diagnosis panel round ${attempts}`)
  const LENSES = [
    'build configuration: how eve output is built and shipped (vercel.*.json, --prebuilt, framework preset, .vercel/output, patch-eve-routes, the mold\'s scripts/deploy.mjs which is the canonical reference)',
    'environment and tokens: env names on the target projects, VERCEL_OIDC_TOKEN scoping to the right project, values that are wrong (e.g. a "}" URL), the order provision.py sets them',
    'Vercel project settings and platform: framework preset, output directory, node version, sandbox templates already existing, deployment logs via vercel inspect <url> --logs',
  ]
  const diags = (await parallel(LENSES.map((lens, i) => () => agent(
    `Diagnose the failed deploy of ${APP} through ONE lens: ${lens}. Failure output:\n${deployTail.slice(-3000)}\n` +
    `Read ${ROOT}/.claude/scripts/provision.py, ${MOLD}/scripts/deploy.mjs, ${MOLD}/vercel.api.json, ${MOLD}/vercel.eve.json; run read-only checks (cd ${MOLD}; vercel ls <project>, vercel inspect <deployment-url> --logs, vercel project inspect <project>). ` +
    `Return one hypothesis with concrete evidence, a precise fix expressed as an edit to provision.py or a command sequence (never an edit under molds/), the files to change, and confidence 0-1. ${RULES}`,
    { label: `diag:${i}`, schema: DIAG })))).filter(Boolean)
  const judge = await agent(`Judge these diagnoses of a failed Vercel deploy and choose the one to apply (index into the list, 0-based). Prefer the fix with the strongest concrete evidence and the smallest blast radius. Diagnoses: ${JSON.stringify(diags)}`, { label: 'judge', schema: JUDGE })
  const chosen = diags[judge?.chosen ?? 0] ?? diags[0]
  fixes.push({ round: attempts, chosen, judge })
  const applied = await agent(
    `Apply this fix and redeploy. Fix: ${chosen.fix}. Evidence: ${chosen.evidence}. Files: ${JSON.stringify(chosen.files ?? [])}. ` +
    `Edit only under ${ROOT}/.claude/scripts (then run bash ${ROOT}/.agents/scripts/sync.sh), keep python3 -m py_compile passing, then run: cd ${ROOT} && python3 .claude/scripts/provision.py ${APP} --deploy 2>&1 | tail -40 (timeout 25 minutes; it builds eve locally twice and deploys three projects). ` +
    `ok=true only if it printed "deployed:" with a URL and cd ${MOLD} && vercel ls claudecode-web-api / claudecode-web-workflow / claudecode-web show Ready for the newest deployment. Return the last 40 lines as tail. ${RULES}`,
    { label: `fix:${attempts}`, schema: STEP })
  deployOk = !!applied?.ok; deployTail = applied?.tail ?? ''
}
if (!deployOk) return { stopped: 'deploy', attempts, fixes, tail: deployTail }

// ---------------- Data, Configure (sequential, mechanical) ----------------
phase('Data')
const data = await agent(`cd ${ROOT} && python3 .claude/scripts/clone.py ${APP} snapshot --apply 2>&1 | tail -30 (timeout 20 minutes). ok=true only if it printed "datastores.json updated". ${RULES}`, { label: 'snapshot', schema: STEP, effort: 'low' })
if (!data?.ok) return { stopped: 'data', data }
phase('Configure')
const conf = await agent(`cd ${ROOT} && python3 .claude/scripts/clone.py ${APP} configure 2>&1 | tail -20. ok=true only if exit code 0 and no label reported ERR. ${RULES}`, { label: 'configure', schema: STEP, effort: 'low' })
if (!conf?.ok) return { stopped: 'configure', conf }

// ---------------- Verify: regress + analysts + refuters ----------------
phase('Verify')
const regress = await agent(`cd ${ROOT} && python3 .claude/scripts/clone.py ${APP} regress 2>&1 | tail -20. Then print the report it names (cat). ok reflects the exit code (0 = pass). Return the full report text as tail. ${RULES}`, { label: 'regress', schema: STEP })
const DIMS = [
  ['tables', 'every non-volatile table has equal row counts in clone and live (read the report; DIFF rows are failures)'],
  ['surface-rows', 'the keyed surface tables (orgs, members, roster, customers, workflows, definitions, memories, ...) show no only_clone/only_live/changed entries'],
  ['blob', 'the blob tree section shows the same per-folder counts, or explains a skip'],
  ['web', `GET the production_url from ${ROOT}/state/application/${APP}/infrastructure.json and /onboard with curl -sS -o /dev/null -w "%{http_code}" (10s timeout); 200 or a redirect to a sign-in page passes`],
  ['api', `GET api_url + /eve/v1/health from infrastructure.json (the mold's Makefile verify-production check); pass only on HTTP 200`],
  ['workflow-service', `GET workflow_url + /api/health from infrastructure.json; pass only on HTTP 200 with a JSON body whose service is task-workflow (the mold's Makefile check); an eve landing page or 404 is a fail`],
  ['inference', `GET production_url + /api/ops/health; pass only if the JSON has ok true and inference.ok true (GLM 5.2 on Cloudflare Workers AI) and taskWorkflow.ok true; quote the detail strings`],
]
const verified = await pipeline(DIMS,
  ([dim, how]) => agent(`Verify dimension "${dim}" for the clone ${APP}: ${how}. Regression report:\n${(regress?.tail ?? '').slice(0, 6000)}\nReturn status pass/fail/skipped with concrete evidence (status codes, counts, quoted lines). ${RULES}`, { label: `verify:${dim}`, schema: VERIFY }),
  (v, [dim]) => v?.status !== 'pass' ? v : parallel([0, 1].map(i => () => agent(
    `Try to REFUTE this pass verdict for dimension "${dim}" of clone ${APP}: ${v.evidence}. Lens ${i === 0 ? 'repeat the probe yourself and look for a different result' : 'find a condition the probe did not cover (auth redirect hiding a 500, cached response, wrong URL, volatile table masking a real diff)'}. Default refuted=true if uncertain. Read-only. ${RULES}`,
    { label: `refute:${dim}:${i}`, schema: REFUTE }))).then(rs => ({ ...v, status: rs.filter(Boolean).some(r => r.refuted) ? 'fail' : 'pass', refutations: rs.filter(Boolean).map(r => r.reason) })))
const results = verified.filter(Boolean)
log(`verify: ${results.filter(r => r.status === 'pass').length} pass, ${results.filter(r => r.status === 'fail').length} fail, ${results.filter(r => r.status === 'skipped').length} skipped`)

// ---------------- Report ----------------
phase('Report')
const report = await agent(
  `Write ${ROOT}/molds/mold_v1/testing/context/reports/${APP}-clone-${DATE}.md: a clone report with sections Preflight, Deploy (attempts, fixes applied: ${JSON.stringify(fixes).slice(0, 3000)}), Data, Configure, Verification (table: dimension, status, evidence, refutations), and Gaps (anything failed or skipped, one line each with the next action). ` +
  `Data: ${JSON.stringify({ live, state, mold, data, conf, regress: { ok: regress?.ok }, results }).slice(0, 12000)}. ` +
  `Then: cd ${ROOT}; python3 .claude/scripts/factory.py validate; git add -A; git commit -m "Clone ${APP}: workflow run ${DATE}" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"; git push origin main. Return a 6-line summary ending with the commit hash. ${RULES}`,
  { label: 'report', schema: { type: 'object', properties: { summary: { type: 'string' }, commit: { type: 'string' } }, required: ['summary'] }, effort: 'low' })
return { deployOk, attempts, fixes, data, conf, regress: regress?.ok, results, report }

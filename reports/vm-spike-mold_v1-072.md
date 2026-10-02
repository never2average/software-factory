# VM spike mold_v1-072: can the agent API run off Vercel with a rootless sandbox?

Date: 2026-10-02. Source: `github.com/never2average/fde-agent` main at `b82944f`, eve 0.25.1, Node 24.20.0.
Host: the factory VM (DigitalOcean "DO-Regular", 4 vCPU, 7.9 GB, Ubuntu 24.04, kernel 6.8, nested KVM).
Model: **stubbed.** No provider key exists by name in this VM's environment, so a local OpenAI-compatible stub
(the repo's own `scripts/fake-model-server.mjs` plus one extra script) answered the model calls. Everything else
was real: eve runtime, workflow world, HTTP channel and its auth, Postgres, the sandbox.

## Verdict: GO-WITH-CONDITIONS

The eve API, the web app and the task-workflow service all build and run off Vercel on plain Node, and talk to
each other. A real agent turn ran end to end, with `python3` executing inside a microVM sandbox started by a
non-root user, with no Docker socket anywhere. Tickets 073-078 are worth building, with the rewording below.

The conditions, in order of weight:

1. **The target server must expose `/dev/kvm`.** The only rootless backend that works without system changes is
   eve's `microsandbox()` (a KVM microVM). No KVM means no rootless python sandbox without installing packages.
   Check the real target before any other ticket starts.
2. **Sandboxes need 2 virtual CPUs and at least 1024 MiB.** With eve's default of 1 vCPU the microVM froze in
   5 of 12 runs longer than about 10 seconds on this host. With 2 vCPUs, 0 of 6 froze, but one VM boot in about 14
   still timed out. This is a small sample on nested KVM; it needs a soak test on the real target.
3. **eve's default sandbox network policy must be replaced.** Under eve's default ("allow-all") the sandbox
   reached the cloud metadata address `169.254.169.254` and the host's Docker bridge. A subnet-deny policy closed
   both (tested at the microsandbox layer, not yet through eve's own option).
4. **Build on the server, at its final path.** The build output embeds absolute paths and is not relocatable.
5. **Templates must be prewarmed before serving, one at a time.** `eve start` builds all nine at once, failed
   here, and leaves stale locks that make the next start hang silently.
6. Tickets 073 (file storage) and 074 (service identity) are both genuinely required; nothing else in the
   Vercel list blocks.

## What was run

Throwaway resources only: `postgres:16` container on `127.0.0.1` (512 MB cap), temp directory
`/tmp/vm-spike-072`, generated dummy secrets, shallow clone at `/root/.claude/jobs/9129ce07/tmp/vm-spike/repo`.
Everything bound to `127.0.0.1`. The live app, its env, database, blob store and projects were not read or
touched. `/root/software-factory/molds` was only read (its `node_modules` was copied, lockfiles identical).
All of it is stopped and removed; scripts and logs are kept in `/root/.claude/jobs/9129ce07/tmp/vm-spike/run/`.

Two load excursions happened and were stopped: load 17 for about a minute (an `eve start` thrashing against my
1 GB heap cap) and load 6.5 (`eve start` booting nine microVMs at once). Other engineers' containers were not
touched.

### 1. Build and start without Vercel

```
$ env | grep -c '^VERCEL'            -> 0
$ npm run build:eve                  -> exit 0, 57-64 s, peak RSS 2.9 GB
$ cat .output/nitro.json             -> "preset": "node-server"; no .vercel/ directory written
$ eve start --host 127.0.0.1 --port 18210      (uid 65534 "nobody", only group kvm, env -i)
eve: initialized 9 sandbox templates (9 reused, 0 built).
[world-local] Re-enqueued 1 active run(s) on startup
[START] server listening at http://127.0.0.1:18210/
$ curl http://127.0.0.1:18210/eve/v1/health
{"ok":true,"status":"ready","workflowId":"workflow//eve//workflowEntry"}
$ ps: 3419945 nobody kvm  /usr/bin/node /tmp/vm-spike-072/app/.output/server/index.mjs
```

What broke or surprised on the way, each reproduced:

| Finding | Evidence |
|---|---|
| Build is not relocatable | Built in the clone, copied to `/tmp`: `Failed to resolve the authored package root for "/root/.../repo/agent/agent.ts"`. 33 absolute paths in `.output/`. |
| `.output/` is not self-contained | `.output/server/node_modules` holds only `playwright-core`; `microsandbox` is resolved from the app root at run time and is a **devDependency** in `package.json`. |
| microsandbox runtime "not installed" | `isInstalled()` is false until `msb` and `libkrunfw` sit in `~/.microsandbox/{bin,lib}`. Symlinking the files already in `node_modules/@superradcompany/microsandbox-linux-x64-gnu` fixed it; `MSB_PATH` alone did not. No download, no system package. |
| `eve start` prewarm is all-or-nothing and parallel | Nine VMs booted at once; one timed out (`timed out waiting for agent relay`) and `eve start` exited 1. No concurrency setting exists (`Promise.all` in `execution/sandbox/prewarm.js`). |
| Stale template locks hang the next start | After a killed start, the next sat at `initializing 9 sandbox templates...` for 9 minutes at load 0.3. `rm -rf .eve/sandbox-cache/template-locks` fixed it. |
| No lazy template build in production | Starting `node .output/server/index.mjs` without prewarm: `Sandbox template ... is not provisioned for backend "microsandbox". Run eve build or invoke prewarmAppSandboxes() before serving traffic.` |
| `eve start` is memory-heavy | Its parent process loads the agent from source: 2.3-2.5 GB RSS, held for the life of the service. A 1 GB heap cap makes it die with `JavaScript heap out of memory`. |
| Build-time flags must match | Setting `ENABLE_WEB_SEARCH=false` only at run time: `Failed to attach the tool execute function from "tools/read_image.ts"`. My mistake, not a Vercel issue, but a deploy trap. |
| Research sandbox assumes root | `agent/subagents/research/sandbox.ts` writes `/root/fmt_xlsx.py`; the microVM user is `vercel-sandbox` (uid 1001): bootstrap exit 1. |
| Production migrations need TLS | `DATABASE_URL=postgres://...@127.0.0.1/... node scripts/migrate-production.mjs` -> `Client network socket disconnected before secure TLS connection was established` (`ssl: "require"` hard-coded; same in `.migrate-task-workflow-service.mjs`, which also only reads `.env.supabase` / `.env.local`). |

The working path used for the rest of the spike: a 14-line script that calls eve's `prewarmBuiltAppSandboxes`
with a serialising `dispatch` (one template at a time; 4.5 min cold, 68 s when all are cached, 2.5 GB peak),
then `node .output/server/index.mjs` (listening in 2 s, 274 MB).

### 2. The sandbox

eve 0.25.1 offers five choices (`node_modules/eve/docs/sandbox.mdx`): `vercel()`, `docker()` (drives the
`docker` CLI, so a daemon socket), `microsandbox()` (KVM microVM, no daemon), `justbash()` (a simulated shell,
**no real binaries, so no python3**), and a custom `SandboxBackend`. `defaultBackend()` picks Vercel on Vercel,
then Docker if a daemon answers, then microsandbox, then just-bash. The build-log line
"eve-hosted-sandbox-backend-prune" is the plugin that strips the three local backends out of **Vercel**
bundles; in a non-Vercel build they are present.

On this VM today `defaultBackend()` would pick Docker through the root socket (there are 60+ old
`eve-sbx-ses-docker-*` containers from earlier `eve dev` runs). The spike pinned microsandbox and set
`EVE_DOCKER_PATH=/nonexistent/docker` so Docker could not be used.

Other rootless options on this host, checked:

```
podman, bwrap, nsjail, newuidmap: not installed
$ setpriv --reuid=65534 unshare -Ur id
unshare: write failed /proc/self/uid_map: Operation not permitted     (kernel.apparmor_restrict_unprivileged_userns=1)
```

So bubblewrap, nsjail, rootless Podman and rootless Docker would each need a system package (`uidmap`, the tool
itself) and an AppArmor or sysctl change. Per the constraints I stopped there and did not install anything.

Proof, as uid 65534 with only group `kvm` (`setpriv --reuid=65534 --regid=993 --clear-groups --no-new-privs`),
through a real agent turn (tool call `bash` -> `python3 probe.py`):

```
python 3.14.4 uid 1001 cwd /workspace kernel 6.12.68            (host kernel is 6.8: a separate VM)
compute 6*7 = 42
write+read inside workspace: ok
read host file /tmp/vm-spike-072/outside/host-secret.txt: BLOCKED FileNotFoundError
read host app /tmp/vm-spike-072/app/package.json: BLOCKED FileNotFoundError
read host /root/software-factory/AGENTS.md: BLOCKED PermissionError
host env DATABASE_URL: BLOCKED KeyError          (same for CRON_SECRET, AUTH_JWT_PUBLIC_KEY,
host env CLOUDFLARE_API_TOKEN: BLOCKED KeyError   OPS_SECRETS_KEY, HOST_SECRET_ENV)
env keys: ['HOME','KRUN_*','LANG','LC_ALL','MSB_*','NPM_CONFIG_PREFIX','PATH','PNPM_HOME','PWD','SHLVL','TERM','_']
pid1: /init.krun
host loopback postgres 127.0.0.1:32771: BLOCKED ConnectionRefusedError
host loopback eve api 127.0.0.1:18210: BLOCKED ConnectionRefusedError
cloud metadata 169.254.169.254:80: CONNECTED          <-- not acceptable, see below
public internet pypi.org:443: CONNECTED
```

Network reach by policy (same probe, standalone microVM):

| Destination | microsandbox default | eve default ("allow-all") | allow `*` + subnet deny list |
|---|---|---|---|
| host loopback `127.0.0.1` | blocked | blocked | blocked |
| metadata `169.254.169.254` | blocked | **connected** | blocked |
| Docker bridge `172.17.0.1:22` | blocked | **connected** | blocked |
| host public IP `:22` | **connected** | **connected** | blocked |
| `pypi.org:443` | connected | connected | connected |

Deny list used: `169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, <host public IP>/32`,
written as the JSON eve produces for `networkPolicy: { allow: ["*"], subnets: { deny: [...] } }`.

The freeze, measured (each run a fresh microVM, a 15 s CPU loop or the app's pip bootstrap):

```
1 vCPU:  hung 5 of 12 runs (VMM at 98% CPU, guest unresponsive, guest metrics 0% CPU, 86 MiB used)
2 vCPU:  hung 0 of 6;  then 2 pip bootstraps and 5 session VMs through eve all fine;
         1 boot timeout in roughly 14 template/session boots
512 MiB + pip bootstrap: hung (one run; cannot separate from the 1-vCPU freeze)
1024 MiB + pip bootstrap of the 7 document libraries: 30 s, all import
```

### 3. One real agent turn

Token: an ES256 email-session token minted with the web app's own `mintSessionToken`, key pair generated for
the spike. Database: schema by `drizzle-kit push`, tenancy by `scripts/bootstrap-test-db.mjs` (the CI path),
running as `app_rw`.

```
no token -> 401
create session -> 202 {"sessionId":"wrun_01M3YBZ72VC7JCPF8X33NMY5Y8", ...}
+4.6s  action.result   bash exitCode 0 (the probe output above)
+13.7s message.completed "SPIKE-ANSWER: python3 ran in the sandbox. ..."
+13.7s turn.completed / session.waiting
```

Also run: a delegation to the `research` subagent (`subagent.called` -> `subagent.completed` ->
"PARENT-DONE", 11.7 s, no Vercel identity needed for the internal call); and a restart of the API followed by a
second message into an existing session with its continuation token (`200`, two turns completed, the earlier
tool result still in history; `[world-local] Re-enqueued 5 active run(s) on startup`). Session state lives in
`.eve/.workflow-data` on disk.

About 9 s of each turn passes between the tool result and the final message with an instant stub model. I did
not find out why.

### 4. Web app and task-workflow service

```
web:   npm run build (NEXT_PUBLIC_EVE_API_URL=http://127.0.0.1:18210)  exit 0, 128 s, peak 2.26 GB
       next start -H 127.0.0.1 -p 18310        Ready in 344ms
       GET /                                   200, 19 kB
       GET /eve/v1/health (proxied to agent)   {"ok":true,"status":"ready",...}
       agent turn through the web proxy        202, python probe ran, finished in 12.8 s
       GET /api/ops/health   db ok (role app_rw, RLS enforced) | inference ok | taskWorkflow ok
                             blob FAIL "no BLOB_READ_WRITE_TOKEN"            -> overall 503
       six cron routes with CRON_SECRET        all 200; resume-workflows says
                             "No VERCEL_OIDC_TOKEN (OIDC federation off) - enable it to auto-resume"

task-workflow: npm ci + npm run build   exit 0, 55 s, peak 1.13 GB
       next start -H 127.0.0.1 -p 18410        Ready in 311ms; /api/health ok (role app_rw); no token -> 401
       POST workflow definition, POST task     201, automationRunId wrun_...; workflow ran:
       "[Workflow] deploymentId: 'latest' has no effect in this world and was ignored"
       task afterwards: assignee spike@example.test, automationState completed
```

Both ran as root from the clone (they are plain Node; only the API and sandbox were run rootless). One
`failed to pipe response ... UND_ERR_BODY_TIMEOUT` appeared in the web log from the rewrite proxy on an idle
stream. The task-workflow service keeps its run state in `.next/workflow-data`, inside the build directory.

## Every Vercel-only dependency, and the smallest change

Each change is additive and behind a setting; unset means today's Vercel behaviour, so the live app is unaffected.

| # | Dependency | Where | Off Vercel today | Smallest additive change |
|---|---|---|---|---|
| 1 | Vercel Sandbox | `agent/sandbox.ts`, `agent/subagents/research/sandbox.ts` (no `backend`, so `defaultBackend()`); `scripts/operator/sandbox-prewarm.mjs`; `scripts/deploy.mjs:47` | Falls to Docker socket, or microsandbox with 1 vCPU and open egress | `SANDBOX_BACKEND=microsandbox` selects `microsandbox({ cpus, memoryMiB, networkPolicy })` in both files (10 lines each, applied in the spike; diff at `run/spike.diff`). Move `microsandbox` to `dependencies`. Importing `eve/sandbox/microsandbox` is harmless on Vercel: the prune plugin stubs it. |
| 2 | Sandbox user is root | `agent/subagents/research/sandbox.ts:107` writes `/root/fmt_xlsx.py`; `agent/subagents/research/prompt.md:145` reads it | Bootstrap exit 1 | Write it where the sandbox user can (`if [ -w /root ] ... else sudo tee`, applied in the spike; the template built, I did not then run the formatter), or move it to `/workspace` and update the prompt. |
| 3 | Vercel OIDC as the web app's service identity | Agent: `agent/channels/eve.ts:109-113,130` (`vercelOidc`, `vercelSubject` with a hard-coded team and project), `agent/lib/service-scope.ts`. Web: `app/api/cron/resume-workflows/route.ts:54`, `app/api/cron/run-cron-workflows/route.ts:45`, `app/api/cron/refresh-apps/route.ts:28`, `app/api/ops/run/route.ts:41`, `app/api/ops/workflow-runs/[runId]/cancel/route.ts:54` | Auto-resume, cron workflows, app refresh and the run trigger have no token and do nothing | `SERVICE_AUTH=session-key`: the web app mints a two-minute ES256 token of a new kind `service` with the `AUTH_JWT_PRIVATE_KEY` it already holds (it already mints queue-delivery and step-grant kinds); the agent adds one `jwtEcdsa` door for that kind and `service-scope.ts` accepts it as the front-end. The agent keeps only the public key, so it still cannot forge one. |
| 4 | `@vercel/blob` | Seven importers: `agent/lib/artifact.ts`, `agent/lib/dataroom-store.ts`, `lib/dataroom-blob.ts`, `lib/blob-read.ts`, `app/api/dataroom/route.ts`, `app/api/ops/inbox/promote/route.ts`, `app/api/ops/health/route.ts`. Host allow-lists naming `vercel-storage.com`: `lib/blob-read.ts`, `lib/safe-fetch.ts`, `lib/pdf-preview.ts`, `app/api/artifact-proxy/route.ts`, `app/_components/artifact-view.tsx` | Agent data room already falls back to local files (`DATAROOM_DIR`, `dataroom-store.ts:331`). Web data room reads return empty, `publish_artifact` refuses, health is 503 | `STORAGE_DRIVER=fs` (or `s3`): one module behind the seven importers; a signed-URL route on the web app to replace `presignUrl`; the allow-lists take the configured host. |
| 5 | Vercel Cron | `vercel.json`: six entries (`resume-workflows` */5, `run-cron-workflows` 1 min, `refresh-apps` 1 min, `sync-inbox` */10, `close-abandoned-runs` */15, `deliver-queued` 1 min) | Nothing calls them. All six answered 200 to `curl -H "authorization: Bearer $CRON_SECRET"` | Six systemd timers (or one) doing that curl. No code change. The agent's own two schedules (`agent/schedules/`) ran inside eve's Nitro runner without help. |
| 6 | Vercel Workflow (eve) | eve's workflow world | Works: local world, state in `.eve/.workflow-data`, survived a restart | None. Put that directory on persistent disk. Proxy must forward `/eve/` and `/.well-known/workflow/`. |
| 7 | Vercel Workflow (task-workflow) | `services/task-workflow/lib/automation.ts:8` (`deploymentId: "latest"`), `next.config.ts` (`withWorkflow`) | Works; `latest` is ignored with a warning; state in `.next/workflow-data` | Set `WORKFLOW_LOCAL_DATA_DIR` outside the build directory, or a rebuild deletes run state. |
| 8 | AI Gateway | `agent/lib/model.ts` only when `MODEL_PROVIDER=gateway` | Not used: the default provider is an OpenAI-compatible endpoint (`CLOUDFLARE_BASE_URL`) | None. |
| 9 | `@vercel/connect` | `agent/lib/connections.ts:18,105`, `agent/channels/slack.ts:1,21` | Not exercised. Slack and GitHub connector credentials come from Vercel Connect | Token-based auth behind a setting (`slack.ts` already has a bot-token override). Not needed for a first deployment without those connectors. |
| 10 | Vercel URLs as defaults | `lib/agent-url.ts` `DEFAULT_AGENT_URL = "https://fde-agent-api.vercel.app"`; `agent/channels/eve.ts` `WEB_ORIGIN ?? "https://fde-agent.vercel.app"`; `lib/mcp-server.ts:171` | A web build without `EVE_API_URL` silently proxies chat to that Vercel deployment | Deployment must set `EVE_API_URL` at **build** time and `WEB_ORIGIN`; provision should refuse to build without them. |
| 11 | Managed-Postgres assumptions | `scripts/migrate-production.mjs`, `.migrate-task-workflow-service.mjs` (`ssl: "require"`, `.env.supabase`) | Fail against a local Postgres without TLS | Turn TLS on in the server's Postgres (the driver's `require` does not verify the certificate), or add an `sslmode` switch. |
| 12 | Build output, prewarm, deploy script | `vercel.eve.json`, `vercel.api.json`, `scripts/patch-eve-routes.mjs`, `scripts/deploy.mjs`, `Makefile` | Not needed: plain `eve build` writes `.output/` | A VM deploy path: build in place, prewarm serially, clear template locks, start. |

Not Vercel, noted for completeness: Browserbase (browser), Exa (search), Resend (mail), Google sign-in.

## Tickets 073-078

| Ticket | Verdict | Change |
|---|---|---|
| 073 storage driver behind the seven `@vercel/blob` importers | Right; widen | Seven is correct. Add: the signed-URL route, the five host allow-lists, and the health check. The agent side already has a filesystem backend to build on. |
| 074 resume accepts a minted `RESUME_TOKEN` | Right in substance; reword | It is the web app's **service identity**, used by five routes, not only resume. Prefer a short-lived token signed with the existing session key over a shared static secret. |
| 075 infrastructure target `vm_remote` | Right; add fields | Add a KVM check to `health` (`/dev/kvm` present, service user in group `kvm`), the fixed install path, and the sandbox settings (backend, vCPUs, memory, deny list). |
| 076 `provision.py --deploy-remote` | Needs rewording | (a) "rsync build" cannot work: build on the server at the final path, with source and `node_modules`, and 3 GB free for the build. (b) "four cron timers" is six. (c) The API unit runs as a non-root user in group `kvm`, clears stale template locks before start, prewarms serially, then runs `node .output/server/index.mjs`; `eve start` instead costs 2.3 GB resident. (d) Postgres needs TLS on, or the migration scripts need a switch. (e) Caddy forwards `/eve/` and `/.well-known/workflow/`; task-workflow stays loopback-only. (f) `EVE_API_URL` at web build time. (g) Build-time flags (`ENABLE_*`) must be identical at build and run. |
| 077 firewall | Needs rewording | The conntrack `ctorigdstport` rule exists for Docker-published ports; with no Docker on the server it is not needed. Add: every service binds `127.0.0.1`; the sandbox deny list; optionally an owner-match egress rule for the service user blocking `169.254.169.254` and private ranges as a second layer. |
| 078 lanes grade `vm_remote.production_url` | Right; add | A lane check that runs a python tool call, and a host sized at 8 GB / 4 vCPU with KVM in the cost line. |

Missing, as new tickets:

1. **Qualify the target host first:** `/dev/kvm`, then a soak test of 2-vCPU microVMs (boots and long commands). If
   it fails, the fallback is rootless Docker or Podman through `EVE_DOCKER_PATH`, which needs `uidmap` and an
   AppArmor allowance on Ubuntu 24.04. That fallback was not tested.
2. **Upstream sandbox change** (rows 1 and 2 above), with the network deny list verified through eve's own option.
3. **Serial prewarm and lock cleanup** as a script in the repo; report upstream to eve that production prewarm has
   no concurrency limit, is all-or-nothing, and does not recover stale locks.
4. **Sandbox disk retention.** Stopped session sandboxes stay on disk: 0.76 GB with nine templates, 2.3 GB after
   five sessions. Needs a prune job and a disk alarm.
5. **A new-database path.** The migration journal alone does not build the schema the app reads (the repo's own
   `scripts/test-migrations-db.mjs` lists the drift: `inbox_items`, `login_codes`, `org_id NOT NULL`, and 39
   `.migrate-*.mjs` scripts). The spike used the CI path, which sets a test password.
6. **Connectors without Vercel Connect** (row 9), when Slack or GitHub is wanted.

## Memory and CPU

| Process | Memory | CPU / time |
|---|---|---|
| `eve build` | peak 2.9 GB (a 2 GB Node heap cap does not bound it) | 57-64 s |
| Prewarm (serial script) | peak 2.5 GB | 4.5 min cold, 68 s when cached |
| `eve start` parent, if used | 2.3-2.5 GB, held while the service runs | 58 s to listening with warm templates |
| eve API (`node .output/server/index.mjs`) | 274 MB at rest, 327 MB high-water | 26 s CPU over 16 min including five turns |
| Web app (`next start`) | 236-242 MB, 300 MB high-water; build peak 2.26 GB | build 128 s; ready in 0.34 s |
| Task-workflow (`next start`) | 156-178 MB, 187 MB high-water; build peak 1.13 GB | build 55 s; ready in 0.31 s |
| One sandbox microVM (`msb`) | 118 MB for the probe, capped at 1024 MiB each | one host core while busy; first tool result 3.6-4.6 s after the request; stopped at end of turn |
| Postgres 16 container | 69 MiB | idle |

Steady state for the three services is about 0.7 GB plus Postgres. The builds and the prewarm are the peaks:
never run two together on an 8 GB machine. Each concurrent session, and each subagent in it, can add a sandbox of
up to 1 GiB and 2 vCPUs.

## Risks

- **KVM dependency.** Many small VPS plans have no nested virtualisation. Without it this design has no sandbox.
- **MicroVM stability on nested KVM.** The freeze is unexplained (empty guest kernel log). Two vCPUs made it go
  away in a small sample; a frozen VM burns one host core until killed and eve does not time it out. One boot
  timeout remained.
- **Open egress by default.** Until the deny list is in the sandbox definition, agent-run code can read cloud
  metadata and reach anything the host can reach on a private network. The host's own public address is
  reachable even under microsandbox's stricter default, so services must bind loopback.
- **Only sandbox tools are isolated.** Authored tools run inside the API process with every secret in its
  environment (eve's documented model); the service user and unit need their own hardening.
- **Startup fragility.** Stale locks, all-at-once prewarm and the hard failure when a template is missing can each
  keep the API down after a crash or an out-of-memory kill.
- **Disk growth** from stopped session sandboxes and 4 GiB sparse template snapshots.
- **Silent wrong target.** A web build without `EVE_API_URL` talks to `fde-agent-api.vercel.app`.
- **eve is beta software** (Nitro 3 beta, Workflow 5 beta, microsandbox 0.5): an upgrade can move any of this.

## Not tested

A real model; the browser UI in a real browser; data-room and artifact features that need storage; Slack and
GitHub connectors; the browser subagent; more than one sandbox at a time; the web and task-workflow services as
a non-root user; TLS, Caddy, systemd; Postgres 17; rootless Docker or Podman; the deny list through eve's own
`networkPolicy` option; whether `/root/fmt_xlsx.py` is usable after the row 2 change.

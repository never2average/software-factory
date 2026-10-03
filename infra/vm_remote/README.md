# infra/vm_remote

A server of the customer's own that **serves** a stamped application: `infrastructure.target: vm_remote` (mold_v1-075 to -078,
after the spike in `reports/vm-spike-mold_v1-072.md`). `infra/vm` is a different thing: this box, verifying a database, serving nobody.

**Status: built and tested offline; not yet run against a real server.** Nothing in this directory is generated ahead of time.
Everything the server receives is rendered from the application's state by `.claude/scripts/lib/vm_remote.py` at deploy time, and
`--dry-run` prints all of it.

    python3 .claude/scripts/provision.py <app_id>                              # check: offline, read-only
    python3 .claude/scripts/provision.py <app_id> --set-remote host=<address> domain=<name>
    python3 .claude/scripts/provision.py <app_id> --remote-key                 # make the SSH key pair, print the public half
    python3 .claude/scripts/provision.py <app_id> --qualify-remote             # connect, read-only: is the server fit?
    python3 .claude/scripts/provision.py <app_id> --deploy-remote --dry-run [--out DIR]
    python3 .claude/scripts/provision.py <app_id> --deploy-remote              # the operator's, at a terminal
    python3 .claude/scripts/provision.py <app_id> --verify-rls
    python3 .claude/scripts/lib/vm_remote.py --self-test                       # offline; also provision.py --self-test-remote

The operator's click-by-click steps are `docs/RUNBOOK.md` §9. The state fields are `docs/STATE.md`, "infrastructure.vm_remote".

## What ends up on the server

| Path | What | Owner, mode |
|---|---|---|
| `/opt/software-factory/<app_id>/app` | the source, then the build made in place (it embeds absolute paths) | `sfapp` |
| `/opt/software-factory/<app_id>/factory` | the generated scripts, unit files, Caddyfile, and a copy of `provision.py` + `lib/` for the database chain | root |
| `/etc/software-factory/<app_id>/env` | the master env file: settings from state, secrets minted on the server, the operator's values. No service reads it | root, 600 |
| `/etc/software-factory/<app_id>/{web,api,workflow,cron}.env` | each service's own file, split from the master by `env-split` (`factory/env-services.json` says which names): the web app gets the sign-in private key; the agent gets the public key, `SERVICE_AUTH=session-key` and its own settings, never the private key; the task-workflow service gets `DATABASE_URL`, `TASK_WORKFLOW_SERVICE_TOKEN` and its own `WORKFLOW_LOCAL_DATA_DIR`; the cron calls get `CRON_SECRET` | root, 600 |
| `/var/lib/software-factory/<app_id>/` | `home/` (the sandbox runtime links), `workflow-data/` (the agent's), `task-workflow-data/`, `storage/` (`STORAGE_FS_ROOT`), `build-stamps/`: everything a redeploy must keep | `sfapp` |
| `/etc/systemd/system/sf-<app>-{workflow,api,web}.service` | the three services, all on 127.0.0.1 | |
| `/etc/systemd/system/sf-<app>-cron-<route>.{service,timer}` | six timers, one per `vercel.json` cron, each a loopback `curl` with `CRON_SECRET` on stdin | |
| `/etc/systemd/system/sf-<app>-egress.service` | loads the nftables rule that keeps `sfapp` off the metadata address and private ranges | |
| `/etc/caddy/Caddyfile` | TLS for the domain; everything to the web app on loopback; `/api/cron/*` answered 404 from outside | |
| `/etc/postgresql/<v>/main/conf.d/software-factory.conf` | `listen_addresses = '127.0.0.1'`, `ssl = on` | |

The API runs as `sfapp` (no login shell, no sudo) with `SupplementaryGroups=kvm`. Before it starts, `api-prestart.sh` checks
`/dev/kvm` and runs the mold's own `npm run sandbox:prewarm -- --link-runtime --retries 2` (fde-agent #100): it clears template locks
whose owner is gone, links the microsandbox runtime from `node_modules`, refuses to finish if the data room's file-link origin resolves
into the sandbox deny list, and prewarms the templates one at a time with three tries each. Then `node .output/server/index.mjs`, not
`eve start`. (The factory used to ship its own `prewarm-serial.mjs` for this; the mold's script does the same job and more.)

## Decisions worth knowing

- **Source, not a build, is copied.** The build happens at the final path, one build at a time. A redeploy stops the three services
  for the length of the build and the prewarm (about ten minutes in the spike): there is nowhere else to build a non-relocatable app.
- **No secret value crosses a command line.** Internal secrets and the database admin password are minted on the server. The operator's
  values are typed at a hidden prompt here (or read from a named environment value) and sent on the stdin of one SSH command. State
  holds names only.
- **The database chain is the Vercel path's.** `vm_remote.host_chain` calls `provision._run_chain` with `provision.SCHEMA_CHAIN` and the
  same step functions, on the server, with the URLs read from the server's env file. `DATABASE_URL` is written after the isolation proof.
- **Caddy proxies everything to the web app**, not `/eve/` straight to the API. The spike report suggested forwarding `/eve/` and
  `/.well-known/workflow/`; the web app already forwards both to the API on loopback and keeps its session-ownership gate
  (`app/eve/v1/session/[...segments]/route.ts`) in front of them, which a direct route would skip.
- **No Docker on the server.** A server that has it is refused at qualification and again by the firewall script, so there is no
  conntrack rule for Docker-published ports.
- **Caddy is the one reverse proxy and TLS terminator; there is no nginx.** A server that already has nginx, Apache, HAProxy,
  Traefik or lighttpd installed is refused at qualification (they would hold ports 80 and 443). One site, one upstream (the web app on loopback),
  automatic certificates and renewal, streaming with `flush_interval -1`. Nothing in this design needs a second proxy. What would
  change that: a certificate the customer must supply themselves, or a network that blocks ports 80 and 443 from Let's Encrypt
  (Caddy can do both, with a `tls <cert> <key>` line or a DNS challenge plugin, so even then the answer is a Caddyfile change).
- **Room for a private administration tunnel (mold_v1-156, not built).** `vm_remote.ssh_host` is the address SSH connects to when it
  is not the public `host`, and `vm_remote.ssh_allow_from` is the only source the firewall lets reach the SSH port; `ufw_rules()`
  takes it as a parameter. Absent, the rule is `ufw allow <ssh_port>/tcp`. Closing public SSH is then two state fields, not a rewrite.
- **A real deploy refuses until the mold carries three switches and one script**: `SANDBOX_BACKEND` (fde-agent #100), `STORAGE_DRIVER`
  (#103), `SERVICE_AUTH` (#99), and the `sandbox:prewarm` npm script (#100). All four are in snapshot `da581f2`. Every name
  `config_pairs` writes is one that snapshot reads; the self-test checks it name by name against the snapshot in the checkout.
- **Each service holds only what it reads.** The agent verifies the web app's service token with the public key and cannot mint one
  (docs/self-hosting/SERVICE_IDENTITY.md in the mold). `health.sh` reads the running agent's environment for the private key's NAME
  and fails the deploy if it is there. The files are root's, not `sfapp`'s: systemd reads them as root, and a file `sfapp` could open
  would let the agent read the web app's. All three services still run as the one user `sfapp`, so a process that takes over the agent
  could read the web process's environment under `/proc`; a user per service is the next step if that matters.
- **The sandbox may reach the server's public address, and nothing listens there but Caddy and SSH.** With filesystem storage a
  sandbox downloads data-room files from `https://<domain>`, so that address is not in `SANDBOX_DENY_SUBNETS`; every service binds
  127.0.0.1 and `health.sh` fails the deploy on any other public listener. validate, `--qualify-remote` and the deploy refuse `fs` storage
  with a deny list that holds the address (`s3` storage is the other way out).

## What only a real server can prove

Listed in full in the pull request that added this target, and as task mold_v1-150. In short: every generated script has been parsed
and none has been run; the unit files, the Caddyfile and the nftables rule have never been loaded; no microVM has been started by
`sfapp` under systemd; and the deploy has never been timed.

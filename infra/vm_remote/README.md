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
    python3 .claude/scripts/provision.py <app_id> --prune-sandboxes [--apply]             # what the nightly prune would remove; --apply removes it now
    python3 .claude/scripts/provision.py <app_id> --tunnel-remote --dry-run               # the private tunnel: every local and remote command, nothing run
    python3 .claude/scripts/provision.py <app_id> --tunnel-remote [--factory-apply]       # turn it on, behind the lockout guard
    python3 .claude/scripts/provision.py <app_id> --tunnel-remote --off [--factory-apply] # back to SSH on the public address
    python3 .claude/scripts/provision.py <app_id> --tunnel-factory [--apply]              # what the tunnel changes on the factory machine
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
| `/etc/systemd/system/sf-<app>-sandbox-prune.{service,timer}` | nightly (03:17): removes stopped session sandboxes and their state snapshots untouched for `sandbox.retention_days` (7), as `sfapp`, with `msb`'s own commands | |
| `/opt/software-factory/<app_id>/tunnel/` | only with the tunnel: `tunnel.sh` and the server's WireGuard conf (public keys only) | root, 700 |
| `/etc/wireguard/<interface>.{conf,key}` | only with the tunnel: the conf above, and the server's own key, made there and never read out | root, 600 |
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
- **Desktop notifications: the pair is minted on the server, and only the sender holds the private half.** When the mold carries
  `agent/lib/web-push.ts` and state names an operator email, `env-mint` mints `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` once (kept
  afterwards: a new pair orphans every subscribed browser) and writes `VAPID_SUBJECT=mailto:<operator>`. In snapshot `4ad0c2c` the web
  app reads only the public key (`app/api/ops/push/route.ts`: it serves it and answers the subscribe route) and the agent reads all
  three (`agent/lib/web-push.ts`: it signs and sends). So `web.env` gets the public key, `api.env` all three, `workflow.env` and
  `cron.env` none; `env-split` refuses a spec that would give the private key to anything but the agent, and `health.sh` reads the
  NAMES in both running processes and fails the deploy if the web app holds the private key or either side lacks what it reads.
- **The private administration tunnel (mold_v1-156, `.claude/scripts/lib/vm_tunnel.py`).** WireGuard between the factory machine and
  the server on a private /30 of their own. Each machine makes its own key in `/etc/wireguard/<interface>.key` and it never leaves:
  the generated confs hold no private key (`PostUp = wg set %i private-key ...` loads it), and state holds names, addresses and the two
  PUBLIC keys (`vm_remote.tunnel`). On the server ufw then admits SSH `in on <interface>` only and the WireGuard UDP port from the
  factory's public address only (read from the SSH login, not typed). sshd is not reconfigured, so one `ufw allow 22/tcp` typed at
  the provider's out-of-band console re-opens SSH (docs/RUNBOOK.md §9). At DigitalOcean that is the Recovery Console, which needs a
  root password (Reset Root Password restarts the droplet); the Droplet Console is itself an SSH login on port 22 from addresses
  DigitalOcean does not publish, so it does NOT work while public SSH is closed. fail2ban is not touched. While `tunnel.enabled`, `ssh_host` is the server's tunnel
  address (validate requires the two to agree), every SSH and rsync goes there and must meet the host key already known for the public
  address (`HostKeyAlias`), `ufw_rules()` has no public SSH rule so a deploy keeps it closed, and `firewall.sh` refuses to apply those
  rules to a server without the interface. The lanes and the outside health read keep using the domain.
- **The tunnel's lockout guard, in order** (`vm_tunnel.turn_on`; the self-test runs the real `tunnel.sh` against stand-in commands):
  the server arms a ten-minute `systemd-run` timer whose whole job is `ufw allow 22/tcp`; it brings WireGuard up and ADDS the two
  rules; the factory brings its side up; the factory logs in over the tunnel, and if that fails the run stops with public SSH exactly
  as it was; the close is sent over the tunnel, and `tunnel.sh close` itself refuses unless sshd's own `SSH_CONNECTION` says the
  command came from the factory's tunnel address to the server's and the timer is running; a fresh login over the tunnel then cancels
  the timer; state is switched last. A confirmation that does not arrive leaves the timer armed, so public SSH comes back by itself.
  Not covered: a reboot of the server inside those ten minutes loses the timer (a transient unit), though WireGuard comes back at boot.
- **Sandbox disk (mold_v1-153).** Measured on the first server: about 490 MB left per session (a `eve-sbx-ses-*` sandbox in
  `~sfapp/.microsandbox/sandboxes`, a `eve-sbx-state-*` snapshot in `snapshots`), and nothing reclaims it; neither eve 0.25.1 nor msb
  0.5.10 has a retention or a prune for sandboxes. eve resumes a chat from its stopped sandbox, else from its state snapshot, else
  (both gone) starts a clean sandbox from the template (`execution/sandbox/bindings/microsandbox-lifecycle.js`), so removing an old
  pair costs that chat the files in its sandbox workspace and nothing else: the conversation, its artifacts and the data room are in
  Postgres and the storage directory. A nightly timer runs `vm_remote.py sandbox-prune` as `sfapp`: `msb list --format json`, then
  `msb remove` for session sandboxes that are stopped, named by no running process and untouched for `sandbox.retention_days`, and
  `msb snapshot remove` (never `--force`) for state snapshots that old. Never a running one, never a template (`eve-sbx-tpl-<hash>`),
  nothing whose status or age it cannot read, and nothing at all if msb cannot list. `eve-sbx-tpl-tmp-*` leftovers of a killed prewarm
  go after an hour when no prewarm is running; one of those that msb has no record of is the only directory it deletes itself.
  `health.sh` reports the disk and the store: a warning from `sandbox.disk_alarm_percent` (80), a failure at 95.
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

**The three additions of 2026-10-04 (notification keys, the tunnel, the sandbox prune) have not been run on a server.** Offline, the
tunnel's server script was executed against stand-in `ufw` / `systemctl` / `systemd-run` / `wg` commands and the prune against a
fixture tree and a stand-in `msb`. Still to see on the real one: that `ufw show added` prints the two tunnel rules in the words
`tunnel_rules()` expects (if not, the deploy's firewall step resets to the same rules every time, which is harmless, and the health
step's tunnel-rule read fails and says so); that `wg-quick` accepts a conf whose key arrives by `PostUp`; that the `systemd-run`
timer fires; the field names of `msb list --format json` (the prune needs `name` and `status`, takes ages from the directories, and
removes nothing it cannot read); and that `msb remove` frees the space the soak test measured.

Listed in full in the pull request that added this target, and as task mold_v1-150. In short: every generated script has been parsed
and none has been run; the unit files, the Caddyfile and the nftables rule have never been loaded; no microVM has been started by
`sfapp` under systemd; and the deploy has never been timed.

# On-premises runner: runs that reach a customer's private network

Some runs must reach systems that are not on the internet: a customer's internal APIs, a cluster's control plane, a
database or a vault on their own network. A hosted run sandbox cannot reach them, and must not. For those runs a
customer installs a small **on-premises runner** inside their own network. This page is what to send them, and what
it does (the code: `src/onprem-runner.ts`, `src/onprem-runners.ts`, `src/onprem-runner-routes.ts`; the tables:
`sql/migrations/0027_on_premises_runners.sql`).

It exists only in a build where some job kind declares `private_network: true`. With none (and with
`APP_ONPREM_RUNNERS=off`) nothing of it is mounted, every run is hosted, and nothing changes.

## How it works

- **Outbound only.** The runner opens HTTPS connections to the app and nothing else connects to it: no inbound port,
  no VPN, no firewall rule but outbound 443 to the app's address. It asks for work (`POST /api/runner/poll`, a long poll
  of up to 20 seconds) and the run sandboxes it starts talk to the app's worker API the same way.
- **One workspace.** An owner of the workspace adds a runner on **Credentials**, which shows a one-time enrollment token
  (`ore_...`, stored hashed, valid 24 hours, `APP_RUNNER_ENROLL_HOURS`). At its first start the runner sends it once and
  gets its own credential (`orr_...`, stored hashed by the app, kept on the customer's machine in
  `/var/lib/app-runner/credential.json`, 0600). That credential is bound to the runner's row and so to its one
  workspace: the app hands it that workspace's runs and nothing else.
- **Routing.** On **Credentials** an owner chooses where the workspace's runs that need its private network go:
  **hosted** (the default) or **on premises**, which needs one of its runners enrolled and online. A run of such a kind
  is routed when it is queued (`runs.runner_location`); switching moves the workspace's queued runs. A run routed on
  premises is never carried out hosted (it waits, with a `waiting` event, while no runner is online), and a hosted run is
  never given to a runner. Every other kind always runs hosted.
- **The same sandbox.** For each run the runner starts a container of the app's own image, exactly as a hosted server
  does (`src/run-container.ts`: no Docker socket, no mount, every capability dropped but the runner's, no new privileges,
  memory, CPU and process limits, a hard deadline). Inside it the run's runner (`src/run-sandbox-runner.ts`) claims the
  run with a token bound to that run and that sandbox, locks the run's own user down (firewall and egress proxy, the
  start-up probe), carries it out and streams its events and results back.
- **The customer's allow list.** The runner's owner lists what runs may reach on their network in `APP_RUNNER_ALLOW`.
  Only runs of kinds with `private_network` get it, added to the run's usual allowlist (the gateway and the kind's own
  hosts). The app never sends one: it is read from the runner's own environment.
- **Health.** The runner reports its version, host name, capacity, isolation and allow list at every poll; the console
  shows **Online** (polled within 90 seconds, `APP_RUNNER_ONLINE_SECONDS`), when it was last seen and how many runs it is
  carrying out. Staff see every workspace's runners at `GET /api/admin/onboarding/runners`.
- **Revoking.** **Revoke** (an owner on **Credentials**, or staff with `DELETE /api/admin/onboarding/runners/<id>`)
  works at once: the runner's credential and enrollment token stop working, so do its sandboxes' worker tokens; the
  runs it was carrying out stop spending (their gateway tokens are revoked) and go back to the queue, or fail when no
  attempt is left. At its next poll the runner removes its run sandboxes, deletes its credential and exits (code 3). A
  runner silent for 15 minutes (`APP_RUNNER_OFFLINE_REAP_MINUTES`) loses its sandboxes' tokens the same way.

## Install (send this to the customer)

What they need: a Linux machine inside their network with Docker, that can open HTTPS connections to the app's address
and reach the hosts its runs must audit. The machine keeps the runner's credential; treat it as you would a server
that holds a deploy key.

1. On **Credentials**, under **On-premises runner**, type a name and press **Add a runner**. Copy the command shown:
   the token in it works once, for 24 hours.
2. On the machine, run it, with `APP_RUNNER_ALLOW` set to what runs may reach:

   ```
   docker run -d --name app-runner --restart unless-stopped --user 0 \
     -v /var/run/docker.sock:/var/run/docker.sock -v app-runner:/var/lib/app-runner \
     -e APP_RUNNER_URL=https://app.example.com \
     -e APP_RUNNER_TOKEN=ore_... \
     -e APP_RUNNER_ALLOW='*.corp.example vault.corp.example 10.20.0.0/16:443|6443' \
     <the app's image> node --import tsx src/onprem-runner.ts
   ```

3. Within a minute the runner shows **Online** on **Credentials**. Press **Run them on premises**.

`docker logs app-runner` says what it does; `docker run --rm ... <image> node --import tsx src/onprem-runner.ts --check`
(the same settings) checks the app's address, Docker and the allow list without starting anything.

### The allow list

Entries separated by spaces or commas, each with `:port` when it is not 443 (`:443|6443` for two):

| Entry | Means |
|---|---|
| `vault.corp.example` | that host, by name, at whatever private address it has on the customer's network |
| `*.corp.example` | every host under that domain |
| `10.20.0.0/16`, `10.20.3.4` | a network or one address, by address (through the run's HTTPS proxy) |

Never reached, whatever is listed: loopback, link-local (the cloud metadata address), multicast and reserved
addresses; networks wider than a /8 and IPv6 are refused. A listed name is answered by the run's own DNS responder
and checked again at every connection; a network is reached by address only, so the run never asks the customer's DNS
about a name nobody listed.

### Settings

| Variable | What it is |
|---|---|
| `APP_RUNNER_URL` | the app's address (`https://`) |
| `APP_RUNNER_TOKEN` | the one-time enrollment token; needed at the first start only |
| `APP_RUNNER_ALLOW` | the private hosts and networks runs may reach (above); empty: none |
| `APP_RUNNER_CAPACITY` | runs at once (2; at most 8) |
| `APP_RUNNER_NAME` | the name the console shows for the machine (its host name) |
| `APP_RUNNER_IMAGE`, `APP_RUNNER_NETWORK` | the run containers' image (the runner's own) and Docker network (`bridge`) |
| `APP_RUNNER_STATE_DIR` | where the credential is kept (`/var/lib/app-runner`: keep it on a volume) |

The runner needs the Docker socket to start and remove its run containers; it starts nothing else and reads nothing
of the host. The run containers get neither the socket nor any mount.

## For the operator

- The image is the app's own (the root `Dockerfile`), built from the same commit as the deployed app, so the runner
  has the same packs and run tools. `deploy/runner.Dockerfile` wraps it with the runner as its command
  (`docker build -f deploy/runner.Dockerfile --build-arg BASE_IMAGE=<app image> -t <runner image> .`); publish it where
  customers can pull it and set `APP_RUNNER_IMAGE_REF` to that name, so the console's install command names it.
- A runner reports the job kinds its image has, and is given only runs of those: an older image waits for a newer one
  for a kind it lacks rather than failing it.
- Turn the whole feature off with `APP_ONPREM_RUNNERS=off` (every run is hosted; enrolled runners get 404).

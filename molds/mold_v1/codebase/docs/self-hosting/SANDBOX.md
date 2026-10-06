# The sandbox off Vercel (`SANDBOX_BACKEND`)

Every agent's bash tools run in a sandbox. On Vercel that is Vercel Sandbox. This page is for a deployment that is
not on Vercel. On Vercel, set none of this: with `SANDBOX_BACKEND` unset the sandbox definitions add no backend, the
build hands eve the sources as they are committed, eve chooses Vercel Sandbox as it always has, the formatter is written to `/root/fmt_xlsx.py` and the research prompt
names that path.

## Settings

Set them in the environment of the **build** (`npm run build:eve`) and of the running server. Use the same values in
both: the research prompt is rendered at build time and names the formatter's path.

| Setting | Default | Meaning |
|---|---|---|
| `SANDBOX_BACKEND` | `vercel` | `vercel` (or unset, or empty): eve's own choice, which is Vercel Sandbox on Vercel. `microsandbox`: a KVM microVM on this host, started by the server's own user. No daemon and no root. |
| `SANDBOX_CPUS` | `2` | Virtual CPUs per sandbox. `microsandbox` only. |
| `SANDBOX_MEMORY_MIB` | `1024` | Memory per sandbox, in MiB. `microsandbox` only. |
| `SANDBOX_DENY_SUBNETS` | none | Extra addresses or CIDR blocks to block, separated by commas or spaces. Added to the built-in list. |
| `SANDBOX_MAX_RUNNING` | from the host | Sandboxes running at the same time. Unset (or `auto`): the smaller of host CPUs / `SANDBOX_CPUS` and (host memory - 2 GiB) / (`SANDBOX_MEMORY_MIB` + 256 MiB), at least 1: **2** on a 4-CPU, 8 GB server at the defaults. Further sandboxes wait for one to come free. `microsandbox` only. |
| `SANDBOX_WAIT_S` | `180` | The longest a sandbox waits for a free one, in seconds. Past it the call is answered `Waiting for a free sandbox: …` and nothing runs. `microsandbox` only. |
| `SANDBOX_QUEUE_MAX` | `32` | The most sandboxes waiting at once. One more is answered the same way at once. `microsandbox` only. |
| `SANDBOX_STALL_S` | `60` | A command whose sandbox answers nothing for this many seconds is stopped with a plain error, and the sandbox is restarted for the next command. `0` turns this off. `microsandbox` only. |

A value that is set and wrong (an unknown backend, `SANDBOX_CPUS=0`, a deny entry that is not a CIDR) stops the
build with a message naming the setting. It never falls back to another backend.

Why 2 CPUs and 1024 MiB: on a 4-vCPU host with nested KVM, a 1-vCPU sandbox froze in 5 of 12 runs longer than about
ten seconds and a 2-vCPU one in 0 of 6; the document libraries installed in 1024 MiB and did not finish in 512.

## The network deny list

eve's default network policy for a local backend is "allow-all". Measured under that default, a sandbox reached the
cloud metadata address `169.254.169.254` and the host's Docker bridge.

With `SANDBOX_BACKEND=microsandbox` the backend is created with eve's own `networkPolicy` option: everything is
allowed (pip and the public internet keep working) except

| Range | What it is |
|---|---|
| `169.254.0.0/16` | link-local, which holds the cloud metadata service |
| `10.0.0.0/8` | private |
| `172.16.0.0/12` | private; Docker's default bridge `172.17.0.0/16` and its user networks are inside it |
| `192.168.0.0/16` | private |
| `127.0.0.0/8` | loopback |

No private range covers the host's own public address, and a sandbox can reach it. Have every service on the host
listen on `127.0.0.1` only, behind the one public reverse proxy (80/443): then that address offers a sandbox nothing
the internet does not already see. If the data room's files are NOT on the filesystem storage driver (below), you can
also deny it:

```
SANDBOX_DENY_SUBNETS=203.0.113.7
```

### The data room's files on the filesystem storage driver

With `STORAGE_DRIVER=filesystem` (docs/STORAGE.md) a data-room file reaches a sandbox as a signed link to the web app
itself, `STORAGE_PUBLIC_URL` (else `WEB_ORIGIN`), which the sandbox downloads (`dataroom_fetch_to_sandbox`). So the
sandbox must reach that origin:

- point it at the web app's **public** address (its public name, served by the reverse proxy on 443);
- do **not** put that address in `SANDBOX_DENY_SUBNETS`; the protection for it is the loopback-only services above;
- or use the `s3` storage driver, whose links point at the bucket's host.

No exception is carved out of the deny list for that origin: eve hands microsandbox the subnet denies before any
allow, and the ordering of overlapping rules is not something to lean on. A conflict is refused instead, plainly:

- at build, when the origin is an IP address inside the deny list (a private or loopback address, or one added to
  `SANDBOX_DENY_SUBNETS`);
- by `npm run sandbox:prewarm` on the server, which resolves the origin's name and refuses to finish if any address
  it resolves to is denied (or if it does not resolve), so the server is not started with a data room it cannot
  fetch.

## Every sandbox takes these settings

eve gives each specialist its own sandbox and inherits nothing from the root's: a specialist with no sandbox
definition, or with one that only defines a `bootstrap` (which is what a pack ships), gets eve's framework default.
Off Vercel that is Docker when a daemon answers, and otherwise a microsandbox with 1 vCPU and allow-all egress. eve
has no agent-wide or configuration-wide default backend to set instead. On the first self-hosted server the root's
template built and the next specialist's ran its bootstrap on 1 vCPU with no network policy until it was killed,
1h50m later.

So the build does it, in one place (`scripts/lib/sandbox-overlay.mjs`, called by `scripts/eve-build.mjs`, which is
what `npm run build:eve` runs). With `SANDBOX_BACKEND=microsandbox`, for the duration of the build, the sandbox slot of
**every agent node** (the root, every specialist, every specialist a pack added) holds a generated wrapper: the
authored definition, untouched (its `bootstrap`, `onSession`, seed files), with
`backend: microsandbox(<the SANDBOX_* settings>)`. A node that authors no definition gets a wrapper with nothing
else in it. The template VM and every session VM of each node therefore start with `SANDBOX_CPUS`,
`SANDBOX_MEMORY_MIB` and the deny list. When the build ends the wrappers are removed and the tree is as it was.

| | |
|---|---|
| A pack, or a new specialist | adds nothing. Its `sandbox/sandbox.ts` names no backend and imports nothing from here. |
| With `SANDBOX_BACKEND` unset (Vercel) | no file is written or moved; eve is handed the committed sources; every sandbox template key is what it was. |
| The settings' values | are read when the server (and the prewarm) starts, not frozen at build: change `SANDBOX_CPUS` and restart. Whether the wrappers exist is decided at build. |
| The build's output | carries `.output/sandbox-overlay.json`, the nodes it was built for. `npm run sandbox:prewarm` refuses an output without it. |

Three things follow:

- **Build with the setting set.** A build made without it has no wrappers, and no server setting can add them later.
  `npm run sandbox:prewarm` refuses such a build, naming each specialist that would start on eve's defaults.
- **Start the server with `node .output/server/index.mjs` after `npm run sandbox:prewarm`, never with `eve start`.**
  `eve start` prewarms from the sources in `agent/`, where the wrappers no longer are.
- **A sandbox definition that must work off Vercel does not write under `/root`.** The microsandbox user is
  `vercel-sandbox`. Write to `"$HOME/..."` (next section) or under `/workspace`.

While `npm run dev:eve` runs with the setting set, the wrappers stay in the tree (an authored definition is beside
its slot as `sandbox.authored.ts`); they are removed when it exits. A build that was killed outright leaves them
behind, and the next build, the next prewarm or `node scripts/eve-build.mjs --restore` removes them.

`EVE_DOCKER_PATH=/nonexistent/docker` and a host firewall rule for `169.254.169.254` and the private ranges remain
sensible second layers; they are no longer what the isolation rests on.

## The formatter's path

The research sandbox ships a small workbook formatter. Vercel Sandbox runs bootstrap as root and the file is at
`/root/fmt_xlsx.py`. The microsandbox user is `vercel-sandbox`, which cannot write under `/root`, so there the file
is written to that user's home and the prompt tells the model to run `python3 "$HOME/fmt_xlsx.py"`.

## Prewarm before serving

A production eve server cannot build a sandbox template on demand, so the templates must exist before it starts.
`eve start` builds them all at once; on a 4-vCPU host one of nine timed out and the start failed, and a killed start
leaves lock directories that make the next one wait in silence.

```
npm ci
npm run build:eve          # on the server, at its final path: the build output is not relocatable
npm run sandbox:prewarm    # one template at a time; clears locks nobody holds
node .output/server/index.mjs
```

`npm run sandbox:prewarm` (`scripts/sandbox-prewarm-serial.mjs`):

| Option | Meaning |
|---|---|
| (none) | Remove template locks whose owner process is gone; under microsandbox, refuse unless every agent node of the built agent carries the `SANDBOX_*` settings (below) and, with filesystem storage, the sandbox can reach the file-link origin (above); then build or reuse each template in turn. A failed template is retried once and the rest still run. Exit 1 if any is missing at the end. |
| `--template-timeout <s>` | Seconds one template may take per attempt (default 600; or `SANDBOX_PREWARM_TIMEOUT_S`). A template that takes longer is not retried: its VM is killed, the report names the template, its node and the CPUs, memory and deny list it was started with, the templates after it are not tried, and the exit code is 1. |
| `--plan` | Start nothing. Print, as JSON, every agent node's sandbox in the built agent: its definition, backend, template key, the settings its backend carries, and why it would be refused. Exit 1 if any would be. |
| `--retries <n>` | Extra attempts per template (default 1, at most 5). |
| `--link-runtime` | If the microsandbox runtime is not installed for this user, link the copy `npm ci` already put in `node_modules/@superradcompany/microsandbox-*` into `~/.microsandbox/{bin,lib}`. No download and no system package. |
| `--locks-only` | Only clear stale locks. |
| `--force-locks` | Remove every template lock, held or not. Only when nothing else is prewarming. |
| `--self-test` | The script's own checks. No eve, no sandbox, no network. |

Run it as the user the server runs as, with the server's environment. A lock held by a running process is never
removed without `--force-locks`; the script stops and names the process.

**What it refuses under microsandbox, before any VM is started.** It reads the built agent's graph the way eve's own
prewarm does and checks every node, not only those with a template:

- the output was not built with `SANDBOX_BACKEND=microsandbox`, or a sandbox definition changed since the build;
- a node has no sandbox definition in the build, or one that names no backend (eve's default: 1 vCPU, allow-all);
- a node's backend is not microsandbox, or does not carry the settings it was created from;
- a node would start with fewer CPUs than `SANDBOX_CPUS`, or without an entry of the deny list.

Each is named (`REFUSED subagents/<name>: ...`) and the answer is the same: rebuild on the server with the setting
set. While it runs it holds the build's lock and puts the wrappers back in `agent/` (eve bundles the definitions from
there again when it prewarms); it removes them when it exits.

The host needs `/dev/kvm`, and the server's user must be in the `kvm` group.

## Sessions, steps and the guard

eve commits a session's sandbox at the end of every model step. Outside `eve dev` that commit **stops the VM and
snapshots it**, and the next step reattaches: the stopped sandbox is restored from that snapshot. eve 0.25.1's
microsandbox binding keeps an open handle per session in its process, and the commit does not clear it. So the next
step was handed the stopped VM, and every bash, glob or file call in it failed:

```
runtime error: no agent socket found for sandbox "eve-sbx-ses-…"
```

Measured on the first self-hosted server (2026-10-05): every specialist that ran bash in two model steps failed on
the second (9 of 9 in three parallel delegated turns). Sessions that share one sandbox (the built-in `agent` tool's
children run in their parent's) were worse off: each concurrent open booted its own VM, and the first to finish a step
stopped the one the others were handed next. Separately, when several 2-vCPU VMs booted at once on the 4-vCPU host, a
guest kernel stalled and never reported ready (`BUG: scheduling while atomic` in the sandbox's `logs/kernel.log`).
microsandbox waits 180 s for it before giving up, and one specialist started 3 minutes after it was called.

The build's wrapper puts `guardSandboxBackend` (`agent/lib/sandbox-guard.ts`) in front of the microsandbox backend:

| | |
|---|---|
| after a commit | the last session using a VM lets eve snapshot and stop it as before, then evicts eve's cached handle, so the next step reattaches instead of reusing a stopped VM |
| a shared sandbox | one VM per sandbox key, however many sessions open it at once. A commit leaves it running while another session still uses it; the last one out stops it. A step that failed without committing is superseded by its session's next step, so it never pins the VM |
| booting | at most `floor(host CPUs / SANDBOX_CPUS)` VMs boot at the same time (2 on a 4-vCPU host at the default 2). The rest queue in order, and the server log says `[sandbox] waiting for a sandbox (…): 2 already starting, at most 2 at once on this host (4 CPUs, 2 per sandbox); 1 waiting` |
| a boot that hangs | abandoned after 60 s and started once more (`[sandbox] a sandbox did not start within 60 s …; starting another`). After two, the step is told `No sandbox started within 60 s, 2 times in a row …` |
| memory | a VM is not booted while the host's available memory is below one sandbox plus 512 MiB, for at most 60 s; after that it is booted anyway, with a log line. It never refuses, so a main agent waiting on its specialists cannot deadlock on it |
| running (mold_v1-190) | at most `SANDBOX_MAX_RUNNING` VMs run at the same time, counted from the start of a boot until the VM is stopped. One more waits in line (`[sandbox] waiting for a free sandbox (…): 2 of 2 running on this host (4 CPUs, 2 per sandbox); 3 waiting`) for at most `SANDBOX_WAIT_S`, with at most `SANDBOX_QUEUE_MAX` waiting. Past either bound the call is answered `Waiting for a free sandbox: all 2 sandboxes this server runs at once are in use, and none came free within 180 s. Nothing was run. Try again in a minute or two.` That is the step's result, so the chat shows it under the specialist's bash call, and the model reads it too |
| an idle VM (mold_v1-190) | while something waits, a VM with no command for 10 s (a main agent waiting on its specialists, a step that will never commit) is snapshotted and stopped to free its place, exactly as a commit would (`[sandbox] stopping an idle sandbox …`); its session's next command restores it with its files. A VM with no command for 10 minutes is stopped the same way even when nothing waits |
| a command that never comes back (mold_v1-190) | after 20 s of a command, the guard asks its VM a trivial question (`true`) and keeps asking while the command runs. A VM that answers nothing for `SANDBOX_STALL_S` is hung: the command is answered at once with `The sandbox stopped responding (nothing came back from it for 60 s), so this command was stopped and the sandbox is being restarted. Run the command again. Files from earlier steps are kept.`, and the VM is snapshotted and stopped (eve's own stop, which force-kills after 10 s; if that does not end it within 30 s, microsandbox's kill by the labels eve gave the VM). The session's next command, in the same step or the next, gets a fresh VM. A long command on a VM that still answers is left alone |

It changes nothing about the VMs themselves: the same CPUs, memory, network policy, templates, snapshots and names.
Under `eve dev` (`EVE_DEV=1`, where eve leaves VMs running between steps) it evicts nothing and does not cap running
VMs (they all stay up there by design); the watchdog still applies. With `SANDBOX_BACKEND`
unset there is no wrapper and the guard is never loaded. Handed any backend that is not microsandbox (eve's `vercel()`
included), it returns that backend untouched.

### The host: nested KVM on a shared-CPU droplet (mold_v1-190)

Measured on the first self-hosted server (DigitalOcean Basic, 4 shared vCPUs, 8 GB, nested KVM; 2 vCPUs and 1024 MiB
per sandbox; eve 0.25.1; before the running cap), with `provision.py <app> --sandbox-load` (this rig) at rising
concurrency. Up to 6 specialists at once (6 VMs) every sandbox worked. At 9 (3 x 3) and 12 (4 x 3), 3 to 4 guests hung
each time: booted, ran eve's bootstrap, took the bash request and never ran it, for 5 to 14+ minutes. Steal time
stayed low (mean 1 to 2 %) and more than 5.6 GB stayed free; the hangs began 10 to 20 s after nine VMs booted within
10 s, with the host only 50 to 70 % busy, and each hung VM then spun one host CPU (the guest's vCPU 1, `fc_vcpu 1`,
never halting; vCPU 0 idle). Every guest kernel warning on record (19) is on CPU 1 (`BUG: scheduling while atomic:
kworker/1` or `swapper/1`; once `NETDEV WATCHDOG: CPU: 1: transmit queue 0 timed out`).

So it is the host: a guest vCPU on nested KVM stops making progress when more vCPU threads contend than the host has
CPUs. The cap keeps the vCPUs of running sandboxes within the host's CPUs; the watchdog bounds what is left. A host
where KVM is not nested (bare metal) removes the layer the hang lives in; that was not measured here. A dedicated-CPU
droplet removes the neighbours' share of the CPU (steal peaked at 40 % here) but is still nested. With `SANDBOX_CPUS=1` the default cap doubles, but the
mold_v1-072 spike saw a 1-vCPU guest freeze the same way (5 of 12 runs), so 2 stays the default.

### Checking a running server

```
RIG_BASE=https://app.example.com RIG_TOKEN=<a signed-in session token> RIG_ORG=<workspace id> \
  node scripts/rig-sandbox-load.mjs --turns 3 --per-turn 3 --specialists <a>,<b>,<c>
```

The rig starts `--turns` delegated turns at once. Each delegates to `--per-turn` specialists in one step (default: the
built-in `agent` tool), and every specialist runs bash in `--steps` (default 2) separate model steps. For each
specialist it reports the start delay (from `subagent.called` to the specialist's own `session.started`, on eve's
server clock) and each bash call. It passes when no specialist hit a sandbox failure (an error, a call that never
returned, an `echo` slower than `--max-bash-s`, default 60) or a start slower than `--max-start-s` (default 60). A specialist whose model did not do as asked is reported as inconclusive, not as a
failure. It starts test chats and real model calls, so run it where those are welcome. `--self-test` checks its
verdicts on recorded event shapes, offline.

## Tests

`npm run test:sandbox-backend` loads the real sandbox definitions and the research prompt under each setting, checks
eve's own translation of the network policy, runs the prewarm script's self-test (stale locks, one template at a
time, the refusals, the timeout and which processes it kills) and the wrapper step's, and checks what an eve build is
handed under each setting with a stand-in for eve. `npm run test:sandbox-coverage` adds the real `eve build` (its own
CI job): a copy of the checkout with the pack-like fixture profile, a fixture specialist with no sandbox file and a
pack-shaped one, built with and without the setting and read back with `--plan`. Neither creates a sandbox: CI has
no KVM.

`scripts/test-sandbox-guard.mjs` (part of `npm run test:sandbox-backend`) runs eve's real microsandbox binding with the
`microsandbox` package replaced by a stand-in (`scripts/fixtures/microsandbox-standin.mjs`). In the stand-in a
stopped VM has no agent socket and a snapshot is a copy of the disk, and a guest can be made to stall when it boots
beside others. It drives the backend as eve does for each model step: open, run, commit. Without the guard it
reproduces the server (a second step fails with `no agent socket found`, three VMs for one shared key, a stall when
six boot at once). With the guard it checks every case in the table above, and that eve's `vercel()` backend comes
back untouched. The stand-in can also hang a guest after it has booted (`control.hangNext`: the command is taken and
never answered, and the VM answers nothing after it, as eve-sbx-ses-5256b07f did): without the watchdog the command
never returns; with it the command is answered within the bound and the same step's next command works on a fresh VM.
Twelve sessions at once never have more than `SANDBOX_MAX_RUNNING` VMs up, and without the cap they do.

Not covered by a test, and to be checked on the real host:

- that a specialist's template VM and its session VMs really start with `SANDBOX_CPUS` virtual CPUs (the tests prove
  the backend each node is built with carries the settings, through eve's own graph; not what the VM is given);
- that a template which exceeds `--template-timeout` has its VM killed (the process match is by this script's
  descendants and by eve's `eve-sbx-tpl-tmp` VM name; check with `ps` that nothing is left);

- that the deny list blocks `169.254.169.254`, the Docker bridge and the private ranges from inside a sandbox created
  through eve (measured so far at the microsandbox layer, with the same policy JSON eve produces);
- that it still holds for a session sandbox reattached after a server restart;
- that `$HOME/fmt_xlsx.py` written at bootstrap is present in a later session and formats a workbook;
- `npm run sandbox:prewarm` against real templates, including `--link-runtime`;
- `dataroom_fetch_to_sandbox` from a microsandbox sandbox to the web app's public address (filesystem storage);
- a soak test of 2-vCPU sandboxes on the target's KVM;
- the guard against real VMs: `node scripts/rig-sandbox-load.mjs` on the server after a deploy (above). The stand-in's
  stall is a model of what was seen (a guest booted beside others never reports ready); that the boot limit is
  enough on a given host is what the rig measures.

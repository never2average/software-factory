# The sandbox off Vercel (`SANDBOX_BACKEND`)

Every agent's bash tools run in a sandbox. On Vercel that is Vercel Sandbox. This page is for a deployment that is
not on Vercel. On Vercel, set none of this: with `SANDBOX_BACKEND` unset the sandbox definitions add no backend, eve
chooses Vercel Sandbox as it always has, the formatter is written to `/root/fmt_xlsx.py` and the research prompt
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

## What this setting does not reach

`SANDBOX_BACKEND` is read by two sandbox definitions: the root agent's (`agent/sandbox.ts`) and the research
specialist's (`agent/subagents/research/sandbox.ts`). A specialist with no sandbox definition of its own gets eve's
framework default instead, which off Vercel is Docker when a Docker daemon answers on the host, and otherwise a
microsandbox with eve's defaults: 1 vCPU and allow-all egress. `npm run sandbox:prewarm` lists those specialists
every time it runs.

Until each of them has a sandbox definition that reads the same setting, a self-hosted deployment should also:

- set `EVE_DOCKER_PATH=/nonexistent/docker` so eve's default cannot pick up a Docker socket;
- block `169.254.169.254` and the private ranges for the server's user in the host firewall, as a second layer.

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
| (none) | Remove template locks whose owner process is gone; under microsandbox with filesystem storage, check the sandbox can reach the file-link origin (above); then build or reuse each template in turn. A failed template is retried once and the rest still run. Exit 1 if any is missing at the end. |
| `--retries <n>` | Extra attempts per template (default 1, at most 5). |
| `--link-runtime` | If the microsandbox runtime is not installed for this user, link the copy `npm ci` already put in `node_modules/@superradcompany/microsandbox-*` into `~/.microsandbox/{bin,lib}`. No download and no system package. |
| `--locks-only` | Only clear stale locks. |
| `--force-locks` | Remove every template lock, held or not. Only when nothing else is prewarming. |
| `--self-test` | The script's own checks. No eve, no sandbox, no network. |

Run it as the user the server runs as, with the server's environment. A lock held by a running process is never
removed without `--force-locks`; the script stops and names the process.

The host needs `/dev/kvm`, and the server's user must be in the `kvm` group.

## Tests

`npm run test:sandbox-backend` loads the real sandbox definitions and the research prompt under each setting, checks
eve's own translation of the network policy, and runs the prewarm script's self-test. It creates no sandbox: CI has
no KVM.

Not covered by a test, and to be checked on the real host:

- that the deny list blocks `169.254.169.254`, the Docker bridge and the private ranges from inside a sandbox created
  through eve (measured so far at the microsandbox layer, with the same policy JSON eve produces);
- that it still holds for a session sandbox reattached after a server restart;
- that `$HOME/fmt_xlsx.py` written at bootstrap is present in a later session and formats a workbook;
- `npm run sandbox:prewarm` against real templates, including `--link-runtime`;
- `dataroom_fetch_to_sandbox` from a microsandbox sandbox to the web app's public address (filesystem storage);
- a soak test of 2-vCPU sandboxes on the target's KVM.

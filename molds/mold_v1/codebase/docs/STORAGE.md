# The file store and its drivers

Everything the platform keeps as a file is an object under a key in one private store: the data room
(`dataroom/orgs/<workspace>/<dm.md path>`), its version snapshots (`dataroom/orgs/<workspace>/_versions/...`),
published artifacts (`artifacts/orgs/<workspace>/<file>`) and the health probe. The application reaches that store
through one interface, `lib/storage`, and a deployment setting picks what answers it.

| `STORAGE_DRIVER` | Store | Use it when |
|---|---|---|
| unset, or `vercel-blob` | A private Vercel Blob store | The deployment runs on Vercel. This is the default and the live app's configuration. |
| `filesystem` (or `fs`) | A directory on the server's own disk | The deployment runs on one server and its disk is backed up. |
| `s3` | A private bucket on any S3-compatible service | DigitalOcean Spaces, MinIO, AWS. More than one server, or the agent's sandbox cannot reach the web app. |

**Unset changes nothing.** With no `STORAGE_DRIVER` the application makes the same Vercel Blob calls, with the same
keys and options, as it did before the driver existed. `npm run test:storage-default` holds it to a recording made
on the code before the change (`scripts/fixtures/storage/default-driver.golden.json`).

## Settings

By name only; values live in the deployment's environment. The web app and the agent API are separate processes
and both read these, so give both the same values.

| Setting | Driver | What it is |
|---|---|---|
| `STORAGE_DRIVER` | all | `vercel-blob` (default), `filesystem` (or `fs`), `s3`. Anything else is a misconfiguration: 503, see below. |
| `BLOB_READ_WRITE_TOKEN` | vercel-blob | The store's token. Without it storage is "not configured", as before. |
| `STORAGE_FS_ROOT` | filesystem | Absolute directory for the files. Not under any web root. |
| `STORAGE_SIGNING_SECRET` | filesystem | Signs the app's own expiring file links. 32+ characters. |
| `STORAGE_PUBLIC_URL` | filesystem | The web app's public `https://` address. Falls back to `WEB_ORIGIN`. |
| `STORAGE_FS_GROUP_SHARED` | filesystem | `1` when the web app and the agent API run as two different users. Folders 2770, files 0660, one group. Unset: 0700 and 0600, one user. See "Two service users sharing the directory". |
| `STORAGE_S3_ENDPOINT` | s3 | `https://<region>.digitaloceanspaces.com`, or a MinIO address. |
| `STORAGE_S3_BUCKET` | s3 | The bucket. It must be private. |
| `STORAGE_S3_REGION` | s3 | Defaults to `us-east-1`. |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | s3 | A key pair that can read and write the bucket. |
| `STORAGE_S3_ADDRESSING` | s3 | `path` (default, `<endpoint>/<bucket>/<key>`) or `virtual` (`<bucket>.<endpoint>/<key>`). |
| `NEXT_PUBLIC_STORAGE_HOST` | s3, build time | The host signed links are served from, for the browser. |

### Not configured, and misconfigured, are two different answers

**Not configured** means exactly one thing: the default driver (`STORAGE_DRIVER` unset, empty or `vercel-blob`)
with no `BLOB_READ_WRITE_TOKEN`. The app degrades as it always has: `GET /api/dataroom` lists nothing, the write
routes say "Data room storage is not configured.", and the agent uses its local scratch tree.

**Misconfigured** is `STORAGE_DRIVER` set to something that is not a driver (a typing mistake such as `filesytem`),
or a selected driver missing a required setting. It never degrades, and never looks like an empty data room:

- every storage route answers **503** with `code: "storage_misconfigured"` and a sentence naming the setting
  (`lib/storage-http.ts`). The two routes that take no sign-in (`/api/artifact-proxy`, `/api/storage/object/…`)
  answer the same 503 without the setting's name;
- the data room shows that sentence instead of an empty tree;
- the agent's store and `publish_artifact` throw the same error: no fall-back to the local scratch tree, and
  nothing is written to another store;
- `GET /api/ops/health` reports it under `blob` as MISCONFIGURED, with the setting's name;
- the server log has one line, `[storage] MISCONFIGURED: …`, written when the storage module is first loaded (the
  agent at startup, the web app on the first request that reaches a storage route, or during `next build`), and
  not repeated per request.

`npm run test:storage-misconfigured` holds every one of those, and that the not-configured answers are unchanged.

### Server only

Everything under `lib/storage/` except `hosts.ts` holds or reads the store's credentials. A client component may
import `lib/storage/hosts.ts` and nothing else there. `import "server-only"` cannot be used in these modules (the
agent and every plain `node` script load them, and outside Next's server bundles that package throws), so the guard
is `lib/storage/server-guard.ts` (throws in a browser) plus `npm run check:storage-server-only` (fails when a
`"use client"` file can reach any other module under `lib/storage/`, through any chain of imports).

`DATAROOM_DIR` is not the filesystem driver. It is the agent's developer fallback, used only when no store is
configured at all, in a layout the web app does not read.

## Qualifying a store before a deployment uses it

```
STORAGE_DRIVER=s3 STORAGE_S3_ENDPOINT=... STORAGE_S3_BUCKET=... \
STORAGE_S3_ACCESS_KEY_ID=... STORAGE_S3_SECRET_ACCESS_KEY=... npm run storage:probe
```

`scripts/storage-probe.mjs` runs the contract below against the store the environment selects, over the real
network: write and read back, sizes, a refused overwrite, an ordered and paged listing, a signed link that opens, a
tampered one that does not, and (on S3) that the bucket refuses an unsigned read. It writes only under
`dataroom/orgs/storage-probe-<random>/`, removes what it wrote, and prints no values.

## What every driver guarantees

- **The same keys.** A driver never builds or rewrites a key. Workspace scoping is decided by the code that
  builds the key from the verified caller's workspace (`lib/dataroom-keyspace.ts`), as it was before.
- **Private.** Nothing is readable without a credential: the store token, the app's signature, or an S3 signature.
- **Plain-prefix listing, ascending, paged.** `list({ prefix })` matches keys by string prefix (the data room relies
  on `file.jsonl.appends/` and on a full key as a prefix), in ascending order, with an opaque cursor.
- **No overwrite unless asked.** A write to an existing key without `allowOverwrite` fails. Append parts depend on it.

## The filesystem driver

Layout under `STORAGE_FS_ROOT`: `objects/<key>` holds the bytes, `meta/<key>.json` the content type, `tmp/`
in-flight writes. Files are created readable by the service user only (folders 0700, files 0600), unless
`STORAGE_FS_GROUP_SHARED=1` (below).

- A key cannot leave the root: `..`, `.`, empty segments, backslashes, control characters and absolute paths are
  refused before a path is built. Symbolic links are never followed.
- Writes are atomic: staged under `tmp/`, flushed, then moved onto the key in one step. Without `allowOverwrite`
  the move is a hard link, so two writers of one key cannot both succeed.
- A key cannot be both a file and a folder (`a/b` and `a/b/c`). The data room's path grammar never produces that
  pair; a write that would need it fails.
- Listing walks the directory on each call. A workspace with tens of thousands of files lists more slowly than on
  an object store.

### Two service users sharing the directory

One user for everything needs nothing here. This section is for a server that runs the web app as one user and
the agent API as another, so that the agent, which runs work a model directs, cannot read the web app's secrets.
Both processes read and write the same `STORAGE_FS_ROOT`. With the default modes (0700 and 0600) each can open
only what it wrote itself, whatever the root's own group and mode are.

Set `STORAGE_FS_GROUP_SHARED=1` in the environment of **both** services. The driver then makes every folder
`2770` and every file `0660`: the owner and one group may read and write, and nobody else may do anything. The `2`
is the setgid bit: whatever is created inside a folder takes that folder's group, so neither service ever has to
change a file's group. The modes are set explicitly, so the services' umask does not matter. They apply to new
files, to overwrites and to append parts alike.

What the server must have before the services start (once, as root; the names are examples):

```
groupadd filestore                                   # 1. one group, made for these files and nothing else
usermod -aG filestore web                            # 2. both service users are in it,
usermod -aG filestore agent                          #    as an ADDITIONAL group, not their main one
install -d -m 2770 -o web -g filestore /srv/files    # 3. the root: owner one of the two (or root), group filestore, mode 2770
systemctl restart web agent                          # 4. a running service does not see a new group until it restarts
```

Then `STORAGE_FS_ROOT=/srv/files` and `STORAGE_FS_GROUP_SHARED=1` for both. If a service is started by systemd with
a fixed list of groups, `filestore` has to be in it (`SupplementaryGroups=filestore`).

With the setting on, the app examines the root when it starts and **refuses to use it** (503, and one
`[storage] MISCONFIGURED` line in the log, as for any other storage misconfiguration) when:

| The root | Why it is refused |
|---|---|
| does not exist | It is not created for you: its group and mode decide who can read every file. |
| has any permission for "other" (`2775`, `2777`, ...) | Every user on the server could list or read the files. |
| is not exactly `2770` (`0770`, `2750`, `0700`, a sticky bit) | The group could not write, or new files would not take the group, or one user could not delete the other's files. |
| belongs to a general-purpose group (`root`, `users`, `staff`, `sudo`, `adm`, `www-data`, `docker`, ...) | Other users are in those groups for other reasons, and would get the files. |
| belongs to a group that is some user's main group (for example the web user's own group `web`) | To share by it the other service would have to join it, and would then also get everything else that user owns by group: its home folder, its environment file. |
| belongs to a group this service's user is not in | It could not share anything. (Added to the group but not restarted is the same.) |
| already holds `objects/`, `meta/` or `tmp/` that are not `2770` in that group | They were made with the setting off; see below. |

Each refusal is one sentence that names the setting and says what to run. With the setting unset the root is not
examined at all, as before.

**Turning it on for a directory that already holds files.** Files written with the setting off are 0700 and
0600 and owned by one user; the driver does not go back over them. Convert them once, as root, with both services
stopped:

```
chgrp -R filestore /srv/files
find /srv/files -type d -exec chmod 2770 {} +
find /srv/files -type f -exec chmod 0660 {} +
```

**What it does not do.** It never gives anything to "other", it does not change who owns a file, and it does not
make the directory safe to share with a third user: every member of the group can read and change every
workspace's files, exactly as each service user already can. Keep the group to the two service users.

`npm run test:storage-fs-group-shared` holds all of it: with the setting unset every folder and file has the mode
it had before the setting existed (a recording made on the code before it); with it on, two real user ids in one
group read, overwrite, add to and delete each other's files through the driver, a third user outside the group
reads nothing, and each refusal above is checked. The two-user part needs root or passwordless `sudo`; where it
has neither it says so and is skipped.

### File links on this driver

Vercel Blob hands out presigned GET URLs. The agent gives one to its sandbox to download a workbook, and the
console gets a fresh one for an artifact after the caller's workspace has been checked. A directory has no such
thing, so the app signs its own:

```
<STORAGE_PUBLIC_URL>/api/storage/object/<key>?exp=<epoch ms>&sig=<HMAC-SHA256>
```

Same properties as a presigned URL: one key, GET only, an expiry, unforgeable without `STORAGE_SIGNING_SECRET`,
and whoever holds it can read that one object until it expires. `app/api/storage/object/[...key]/route.ts` is the
only thing that honours one, and only for keys under `dataroom/orgs/<workspace>/` or `artifacts/orgs/<workspace>/`.
There is no listing and no unsigned read.

Who gets a link is decided before one is signed, where it always was: `/api/ops/artifact-link` signs only an
artifact of the caller's own workspace, and the agent's store signs only keys under its own workspace's prefix.
The data room itself is never read by link from the browser: `/api/dataroom` verifies the caller and reads the
file on the server.

On this driver a published artifact is served from the app's own address, where on Vercel Blob it is on another
host. An artifact can be HTML the model wrote, so the route answers with `Content-Security-Policy: sandbox
allow-scripts` and `X-Content-Type-Options: nosniff`: the document gets an origin of its own and cannot read the
signed-in user's token or call the API as them. Every type is sandboxed except `application/pdf`, which a browser
will not draw inside a sandbox. `proxy.ts` leaves that path's policy to the route.

**The sandbox must be able to reach `STORAGE_PUBLIC_URL`.** `dataroom_fetch_to_sandbox` hands the sandbox a link
to download with `curl`. If the sandbox's network policy blocks the server's own public address (the VM spike's
deny list does), that tool fails on this driver. Allow that one address and port, or use the `s3` driver, whose
links point at the bucket's host.

## The S3 driver

No SDK: six requests signed with AWS Signature Version 4 over `fetch`. File links are presigned GETs (S3 allows at
most seven days, the lifetime of a published artifact's link). `allowOverwrite: false` is sent as
`If-None-Match: *`; a service that ignores it is still safe because those keys are unique by construction.

Set `NEXT_PUBLIC_STORAGE_HOST` at build time, or links to published artifacts in a chat are treated as links to
another site and do not open in the viewer.

## Moving between drivers

There is no migration tool yet. The keys are identical on every driver, so a copy is a copy of every object under
`dataroom/` and `artifacts/` to the same key. Version rows in Postgres store keys, not URLs, and stay valid.
Links already handed out belong to the old store and stop working.

## Adding code that touches files

Use `storageDriver()` from `lib/storage/index.ts` (relative `.ts` import from the agent, `@/lib/storage/index` from
the web app). `npm run check:storage-driver` fails on a second file importing `@vercel/blob`, and on application
code that names the Vercel Blob host: ask `storageUrlRules()` on the server or `isStorageHostForBrowser()` in a
client component.

## Not covered by the drivers

- The local MCP server's direct-store mode (`setup/workspace-mcp.mjs`) turns on only when `BLOB_READ_WRITE_TOKEN`
  is set. On another driver it works through the Ops API, which is driver-agnostic. `scripts/operator/onboard-self.mjs`
  prints that token's presence as an advisory line whatever the driver.
- `scripts/seed-dataroom-blob.mjs` and `scripts/migrate-dataroom-root.mjs` are about a Vercel Blob store and stay
  Vercel-only.

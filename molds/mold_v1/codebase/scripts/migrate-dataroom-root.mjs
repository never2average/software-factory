/**
 * ONE-TIME: move objects from the data room's ROOT into the workspace they PROVABLY belong to — and nothing else.
 *
 * Every workspace's data room is `dataroom/orgs/<org_id>/…` now, and nothing reads the root (lib/dataroom-keyspace.ts).
 * What is still at the root was written by callers that named NO workspace — from any workspace — plus seed, sample and
 * probe files. On the live deployment neither workspace lived at the root (desk-a's prefix is
 * orgs/desk-a), so "move the root to the primary workspace" would hand one workspace's files to another. So:
 *
 *   orgs/…                         already in a workspace: left alone.
 *   _versions/<org>/…              a version snapshot, filed by its workspace in its own key → orgs/<org>/_versions/<org>/…
 *   a COMPANY path                 {folder:accounts}/<id>/…, {folder:deliveries}/<id>/…, {folder:projects}/<id>/…, {folder:tickets}/<folder>/<id>/…:
 *                                  moves to the ONE workspace whose customers table holds <id> (read-only, each
 *                                  workspace in its own scope). Held by two workspaces, or by none: AMBIGUOUS — it
 *                                  stays, and is reported.
 *   everything else                stays, unless NAMED: `--only <prefix>` (repeatable) or `--move-file <list>` (one
 *                                  path per line). `--to <org_id>` applies to named objects only, never to the rest.
 *                                  A named company path still moves only where its attribution agrees.
 *   --delete-unowned <prefix>      deletes objects under the prefix that nothing attributes and nobody named
 *                                  (sample and probe data). Listed on the dry run; deleted only with --apply.
 *
 * NOTHING IS LOST BY A COINCIDENCE. A destination that already exists is `done` only when its BYTES are the source's
 * (sha-256 of both); anything else is a CONFLICT — both are kept and listed, for a person to decide. Every copy is
 * verified (size and sha-256 of the destination against the source) BEFORE the source is deleted; a copy that does not
 * verify keeps its source and is reported as failed. Idempotent: re-run it after an interruption.
 *
 * DRY RUN BY DEFAULT: every root object is listed with what would happen to it and why (`--json` for the full list).
 *
 *   DATABASE_URL=…app_rw… node scripts/migrate-dataroom-root.mjs                    # blob store, dry run
 *   … --only {folder:uploads}/ --to desk-a                                             # name a prefix for a workspace
 *   … --move-file moves.txt --to customer-b                                          # name exact objects
 *   … --delete-unowned {folder:accounts}/surface-probe-co                                   # probe/sample data
 *   … --apply    … --json    … --driver local --dir .dataroom    … --self-test
 *
 * Run by the factory after the deploy that ships lib/dataroom-keyspace.ts, dry run first, a person reading the list.
 */
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { DATAROOM_ROOT, VERSIONS_DIR, WORKSPACES_DIR, requireWorkspace } from "../lib/dataroom-keyspace.ts";
import { FOLDER } from "../agent/lib/dataroom-folders.ts";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/* ---- drivers: list the root, hash / copy one object, delete some ----------------------------------------------- */

/** The Vercel Blob store (the deployed data room). Keys are listed and moved under `dataroom/`. */
export function blobDriver({ token = process.env.BLOB_READ_WRITE_TOKEN } = {}) {
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not set (or pass --driver local --dir <path>).");
  const root = `${DATAROOM_ROOT}/`;
  let blobApi;
  const api = async () => (blobApi ??= await import("@vercel/blob"));
  return {
    kind: "blob",
    async list() {
      const { list } = await api();
      const out = [];
      let cursor;
      do {
        const page = await list({ token, prefix: root, cursor, limit: 1000 });
        for (const b of page.blobs) out.push({ pathname: b.pathname.slice(root.length), size: b.size });
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    /** sha-256 of the object's bytes (downloaded over a short-lived presigned GET), or null when absent. */
    async hash(path) {
      const { issueSignedToken, presignUrl } = await api();
      const pathname = `${root}${path}`;
      const validUntil = Date.now() + 5 * 60_000;
      const signed = await issueSignedToken({ token, pathname, operations: ["get"], validUntil });
      const { presignedUrl } = await presignUrl(
        { clientSigningToken: signed.clientSigningToken, delegationToken: signed.delegationToken },
        { operation: "get", pathname, access: "private", validUntil: signed.validUntil },
      );
      const res = await fetch(presignedUrl);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`could not read ${pathname}: HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      return { sha256: sha256(bytes), size: bytes.length };
    },
    async copy(from, to) {
      const { copy } = await api();
      // allowOverwrite:false — a destination that appeared since the plan is never clobbered.
      await copy(`${root}${from}`, `${root}${to}`, { access: "private", token, addRandomSuffix: false, allowOverwrite: false });
    },
    async remove(paths) {
      const { del } = await api();
      for (let i = 0; i < paths.length; i += 100) await del(paths.slice(i, i + 100).map((p) => `${root}${p}`), { token });
    },
  };
}

/** A local data room directory (`$DATAROOM_DIR`, default `.dataroom`): the same layout on disk. */
export function localDriver(dir = process.env.DATAROOM_DIR ?? nodePath.join(process.cwd(), ".dataroom")) {
  const base = nodePath.resolve(dir);
  const abs = (rel) => {
    const out = nodePath.resolve(base, ...rel.split("/"));
    if (!out.startsWith(base + nodePath.sep)) throw new Error(`"${rel}" escapes ${base}`);
    return out;
  };
  return {
    kind: "local",
    async list() {
      let entries;
      try {
        entries = await fs.readdir(base, { recursive: true, withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      const out = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        const full = nodePath.join(e.parentPath, e.name);
        out.push({ pathname: nodePath.relative(base, full).split(nodePath.sep).join("/"), size: (await fs.stat(full)).size });
      }
      return out;
    },
    async hash(path) {
      try {
        const bytes = await fs.readFile(abs(path));
        return { sha256: sha256(bytes), size: bytes.length };
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async copy(from, to) {
      const target = abs(to);
      await fs.mkdir(nodePath.dirname(target), { recursive: true });
      await fs.copyFile(abs(from), target, fs.constants?.COPYFILE_EXCL ?? 1);
    },
    async remove(paths) {
      for (const p of paths) {
        await fs.rm(abs(p), { force: true });
        let parent = nodePath.dirname(abs(p));
        while (parent.startsWith(base + nodePath.sep)) {
          try {
            await fs.rmdir(parent);
          } catch {
            break;
          }
          parent = nodePath.dirname(parent);
        }
      }
    },
  };
}

/* ---- attribution ------------------------------------------------------------------------------------------------ */

/**
 * The company id a data-room path belongs to, or null when the path is not company-scoped. From the dm.md templates
 * (agent/lib/dataroom-store.ts DATAROOM_PATH_TEMPLATES): {folder:accounts}/{customer_id}/…, {folder:deliveries}/{customer_id}/…,
 * {folder:projects}/{customer_id}/…, {folder:tickets}/{ticket_folder}/{customer_id}/…. `Master.xlsx` and `syncs/` are not.
 */
export function companyOf(rel) {
  const seg = rel.split("/");
  const at = { [FOLDER.accounts]: 1, [FOLDER.deliveries]: 1, [FOLDER.projects]: 1, [FOLDER.tickets]: 2 }[seg[0]];
  if (at === undefined || seg.length <= at + 1) return null;
  const id = seg[at];
  return !id || id === "syncs" ? null : id;
}

/**
 * Which workspaces hold each company id: every workspace's customers table, each read inside its own RLS scope
 * (read-only). A system job reading every workspace — this script, never a request.
 */
export async function loadCompanyOwners() {
  const { acrossOrgDbs, getDb } = await import("../agent/lib/db/index.ts");
  const owners = new Map();
  if (!getDb()) return owners;
  const { customers } = await import("../agent/lib/db/schema.ts");
  const { eq } = await import("drizzle-orm");
  const rows = await acrossOrgDbs((tx, orgId) =>
    tx.select({ id: customers.customerId, orgId: customers.orgId }).from(customers).where(eq(customers.orgId, orgId)),
  );
  for (const r of rows) {
    if (!owners.has(r.id)) owners.set(r.id, new Set());
    owners.get(r.id).add(r.orgId);
  }
  return owners;
}

const underPrefix = (rel, prefix) => {
  const p = prefix.replace(/^\/+/, "");
  if (!p) return false;
  return p.endsWith("/") ? rel.startsWith(p) : rel === p || rel.startsWith(`${p}/`);
};

/**
 * The plan for every object in the store, without touching it: `{ pathname, size, action, to?, reason }` where
 * action is in-workspace | move | ambiguous | stay | delete | unplaceable. Pure: attribution is passed in.
 */
export function planRootObjects(objects, opts = {}) {
  const { to = null, only = [], moveFiles = [], deleteUnowned = [], companyOwners = new Map() } = opts;
  const named = new Set(moveFiles.map((p) => p.trim()).filter(Boolean));
  const isNamed = (rel) => named.has(rel) || only.some((p) => underPrefix(rel, p));
  const isDisposable = (rel) => deleteUnowned.some((p) => underPrefix(rel, p));
  const out = [];
  for (const o of [...objects].sort((a, b) => (a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0))) {
    const rel = o.pathname;
    const item = (action, extra) => out.push({ pathname: rel, size: o.size, action, ...extra });
    const top = rel.split("/", 1)[0];
    if (top === WORKSPACES_DIR) {
      item("in-workspace", { reason: "already in a workspace" });
      continue;
    }
    if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\") || rel.includes("//") || rel.includes("%")) {
      item("unplaceable", { reason: "not a safe key" });
      continue;
    }
    if (top === VERSIONS_DIR) {
      try {
        const org = requireWorkspace(rel.split("/")[1] ?? "");
        item("move", { to: `${WORKSPACES_DIR}/${org}/${rel}`, reason: `a snapshot filed by ${org}` });
      } catch {
        item("unplaceable", { reason: "a snapshot whose key names no workspace" });
      }
      continue;
    }
    const company = companyOf(rel);
    if (company) {
      const holders = [...(companyOwners.get(company) ?? [])].sort();
      if (holders.length > 1) {
        item("ambiguous", { reason: `company ${company} is held by ${holders.join(" and ")}` });
      } else if (holders.length === 1) {
        if (isNamed(rel) && to && to !== holders[0]) {
          item("ambiguous", { reason: `named for ${to}, but company ${company} is ${holders[0]}'s` });
        } else item("move", { to: `${WORKSPACES_DIR}/${holders[0]}/${rel}`, reason: `company ${company} is ${holders[0]}'s` });
      } else if (isNamed(rel)) {
        item("move", { to: `${WORKSPACES_DIR}/${to}/${rel}`, reason: `named for ${to} (company ${company} is held by no workspace)` });
      } else if (isDisposable(rel)) {
        item("delete", { reason: `unowned (company ${company} is held by no workspace), under --delete-unowned` });
      } else {
        item("ambiguous", { reason: `company ${company} is held by no workspace` });
      }
      continue;
    }
    if (isNamed(rel)) item("move", { to: `${WORKSPACES_DIR}/${to}/${rel}`, reason: `named for ${to}` });
    else if (isDisposable(rel)) item("delete", { reason: "unowned, under --delete-unowned" });
    else item("stay", { reason: "not attributable to one workspace: name it with --only or --move-file" });
  }
  return out;
}

/* ---- the migration ---------------------------------------------------------------------------------------------- */

/**
 * Plan (and with `apply`, perform) the move. Throws before touching anything when objects are named without a valid
 * `to`. Returns counts, every object with its action and outcome, the conflicts, and — when applied — what was done.
 */
export async function migrateDataroomRoot({
  driver,
  to = null,
  only = [],
  moveFiles = [],
  deleteUnowned = [],
  companyOwners = new Map(),
  apply = false,
  log = console.log,
}) {
  if (only.length || moveFiles.length) requireWorkspace(to);
  else if (to) requireWorkspace(to);
  const listing = await driver.list();
  const byPath = new Map(listing.map((o) => [o.pathname, o]));
  const objects = planRootObjects(listing, { to, only, moveFiles, deleteUnowned, companyOwners });

  // Resolve every planned move against its destination BY CONTENT: absent → move; same bytes → done; else conflict.
  for (const o of objects.filter((x) => x.action === "move")) {
    if (!byPath.has(o.to)) {
      o.outcome = "move";
      continue;
    }
    const [src, dst] = await Promise.all([driver.hash(o.pathname), driver.hash(o.to)]);
    o.outcome = src && dst && src.sha256 === dst.sha256 && src.size === dst.size ? "done" : "conflict";
    if (o.outcome === "conflict") o.reason = `${o.reason}; the destination holds different bytes`;
  }
  const count = (fn) => objects.filter(fn).length;
  const counts = {
    total: objects.length,
    inWorkspaces: count((o) => o.action === "in-workspace"),
    move: count((o) => o.outcome === "move"),
    done: count((o) => o.outcome === "done"),
    conflict: count((o) => o.outcome === "conflict"),
    ambiguous: count((o) => o.action === "ambiguous"),
    stay: count((o) => o.action === "stay"),
    delete: count((o) => o.action === "delete"),
    unplaceable: count((o) => o.action === "unplaceable"),
    bytesToCopy: objects.filter((o) => o.outcome === "move").reduce((n, o) => n + o.size, 0),
  };
  const conflicts = objects.filter((o) => o.outcome === "conflict").map((o) => ({ from: o.pathname, to: o.to }));

  log(
    `[migrate-dataroom-root] ${driver.kind}: ${counts.total} object(s) — ${counts.inWorkspaces} already in a workspace, ` +
      `${counts.move} to move (${counts.bytesToCopy} bytes), ${counts.done} already copied, ${counts.conflict} conflict(s), ` +
      `${counts.ambiguous} ambiguous, ${counts.stay} left (unnamed), ${counts.delete} to delete, ${counts.unplaceable} unplaceable.`,
  );
  for (const o of objects) {
    if (o.action === "in-workspace") continue;
    const verb = o.action === "move" ? (o.outcome === "move" ? "MOVE" : o.outcome === "done" ? "DONE" : "CONFLICT") : o.action.toUpperCase();
    log(`  ${verb.padEnd(11)} ${o.pathname}${o.to ? ` → ${o.to}` : ""}  (${o.reason})`);
  }

  if (!apply) {
    log("[migrate-dataroom-root] dry run — nothing changed. Re-run with --apply to perform the MOVE, DONE and DELETE lines.");
    return { counts, objects, conflicts, applied: null };
  }

  const applied = { moved: 0, completed: 0, deleted: 0, failed: 0, errors: [] };
  const fail = (o, why) => {
    applied.failed++;
    applied.errors.push({ from: o.pathname, to: o.to ?? null, error: String(why).slice(0, 200) });
  };
  for (const o of objects) {
    try {
      if (o.action === "delete") {
        await driver.remove([o.pathname]);
        applied.deleted++;
      } else if (o.outcome === "done") {
        await driver.remove([o.pathname]);
        applied.completed++;
      } else if (o.outcome === "move") {
        const src = await driver.hash(o.pathname);
        if (!src) throw new Error("the source vanished before the copy");
        await driver.copy(o.pathname, o.to);
        // Verified BEFORE the source goes: a copy that is not byte-for-byte the source keeps the source.
        const dst = await driver.hash(o.to);
        if (!dst || dst.sha256 !== src.sha256 || dst.size !== src.size) {
          fail(o, "the copy does not match the source (size or sha-256); the source is kept");
          continue;
        }
        await driver.remove([o.pathname]);
        applied.moved++;
      }
    } catch (error) {
      fail(o, error?.message ?? error);
    }
  }
  log(
    `[migrate-dataroom-root] applied: ${applied.moved} moved, ${applied.completed} completed from an earlier run, ` +
      `${applied.deleted} deleted, ${applied.failed} failed, ${conflicts.length} conflict(s) and ` +
      `${counts.ambiguous + counts.stay} unmoved object(s) left for a person.`,
  );
  for (const e of applied.errors.slice(0, 50)) log(`[migrate-dataroom-root] FAILED ${e.from} → ${e.to}: ${e.error}`);
  return { counts, objects, conflicts, applied };
}

/* ---- --self-test: the executor's guarantees against an in-memory store ------------------------------------------- */

function memoryDriver(seed, { corruptCopies = false } = {}) {
  const objects = new Map(seed.map((o) => [o.pathname, { ...o }]));
  return {
    kind: "memory",
    objects,
    async list() {
      return [...objects.values()].map(({ pathname, body }) => ({ pathname, size: body.length }));
    },
    async hash(p) {
      const o = objects.get(p);
      return o ? { sha256: sha256(o.body), size: o.body.length } : null;
    },
    async copy(from, to) {
      if (objects.has(to)) throw new Error("exists");
      const body = objects.get(from).body;
      objects.set(to, { pathname: to, body: corruptCopies ? body.split("").reverse().join("") : body });
    },
    async remove(paths) {
      for (const p of paths) objects.delete(p);
    },
  };
}

async function selfTest() {
  const failures = [];
  const ok = (label, cond, detail) => {
    console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    if (!cond) failures.push(label);
  };
  const quiet = () => {};
  const owners = new Map([["acme", new Set(["org-a"])], ["both", new Set(["org-a", "org-b"])]]);
  const seed = () => [
    { pathname: `${FOLDER.accounts}/acme/context.md`, body: "acme" },
    { pathname: `${FOLDER.accounts}/both/context.md`, body: "both" },
    { pathname: `${FOLDER.accounts}/Master.xlsx`, body: "sheet" },
    { pathname: `${FOLDER.uploads}/p/deck.pdf`, body: "ROOT-A\n" },
    { pathname: `orgs/org-b/${FOLDER.uploads}/p/deck.pdf`, body: "LIVE-B\n" },
    { pathname: `_versions/org-a/1-${FOLDER.accounts}/acme/context.md`, body: "old" },
    { pathname: "_versions/%2e%2e/evil", body: "x" },
  ];
  const d = memoryDriver(seed());
  const dry = await migrateDataroomRoot({ driver: d, companyOwners: owners, log: quiet });
  ok("dry run: nothing changes", d.objects.size === 7);
  ok("dry run: 2 moves (acme, its snapshot), 1 ambiguous, 2 left, 1 unplaceable", dry.counts.move === 2 && dry.counts.ambiguous === 1 && dry.counts.stay === 2 && dry.counts.unplaceable === 1, dry.counts);
  const named = await migrateDataroomRoot({ driver: d, companyOwners: owners, only: [`${FOLDER.uploads}/`], to: "org-b", apply: true, log: quiet });
  ok("same size, different bytes at the destination: a conflict, both kept", named.counts.conflict === 1 && d.objects.get(`${FOLDER.uploads}/p/deck.pdf`)?.body === "ROOT-A\n" && d.objects.get(`orgs/org-b/${FOLDER.uploads}/p/deck.pdf`)?.body === "LIVE-B\n", named.counts);
  ok("the attributed company moved to its workspace", d.objects.has(`orgs/org-a/${FOLDER.accounts}/acme/context.md`) && !d.objects.has(`${FOLDER.accounts}/acme/context.md`));
  const bad = memoryDriver([{ pathname: `${FOLDER.accounts}/acme/context.md`, body: "acme" }], { corruptCopies: true });
  const r = await migrateDataroomRoot({ driver: bad, companyOwners: owners, apply: true, log: quiet });
  ok("a copy that does not verify keeps its source, and is reported", r.applied.failed === 1 && r.applied.moved === 0 && bad.objects.has(`${FOLDER.accounts}/acme/context.md`), r.applied);
  let refused = false;
  try {
    await migrateDataroomRoot({ driver: d, only: [`${FOLDER.uploads}/`], log: quiet });
  } catch {
    refused = true;
  }
  ok("naming objects without --to is refused", refused);
  console.log(failures.length ? `\n${failures.length} failed` : "\nself-test passed");
  return failures.length === 0;
}

/* ---- CLI -------------------------------------------------------------------------------------------------------- */

if (process.argv[1] && fileURLToPath(import.meta.url) === nodePath.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const values = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] && !args[i + 1].startsWith("--") ? [args[i + 1]] : []));
  if (args.includes("--self-test")) process.exit((await selfTest()) ? 0 : 1);
  const to = values("to")[0] ?? null;
  const moveFiles = values("move-file").flatMap((f) => readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
  const driver = (values("driver")[0] ?? "blob") === "local" ? localDriver(values("dir")[0] ?? undefined) : blobDriver();
  const companyOwners = await loadCompanyOwners();
  if (!companyOwners.size) console.warn("[migrate-dataroom-root] no DATABASE_URL (or no customers): no company path can be attributed, so none moves.");
  const json = args.includes("--json");
  const result = await migrateDataroomRoot({
    driver,
    to,
    only: values("only"),
    moveFiles,
    deleteUnowned: values("delete-unowned"),
    companyOwners,
    apply: args.includes("--apply"),
    log: json ? () => {} : console.log,
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  try {
    const { closeDb } = await import("../agent/lib/db/index.ts");
    await closeDb?.();
  } catch {
    /* no database was opened */
  }
  process.exit(result.applied && result.applied.failed > 0 ? 1 : 0);
}

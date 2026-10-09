import { and, eq, isNull } from "drizzle-orm";
import { apps } from "@/agent/lib/db/schema";
import { driveAppRefresh, refreshBackgroundMs, startAppRefresh, type OpsDb, type StartOutcome } from "./app-refresh";
import { inBackground } from "./background";
import { withOrgRls } from "./ops-db";
import type { ServiceBearer } from "./service-identity";

/**
 * THE FIRST DOCUMENT of an app that was created without one.
 *
 * A starter app (an app the deployment's library gives every new workspace: agent/lib/provision-workspace.ts) is
 * created as a definition only, so that creating a workspace never runs a model by itself. Its document is written
 * the first time somebody wants it:
 *
 *   - a person opens it in the Apps tab: the panel asks POST /api/ops/apps/:id/refresh?first=1;
 *   - its schedule comes due (the refresh-apps cron, which needs nothing from here);
 *   - the library said `first_content: "on_create"`: POST /api/ops/orgs asks, as the person creating the workspace.
 *
 * "First" is decided by the DATABASE, in one statement: the app has no document, has never been attempted, and no
 * attempt is under way. Two people opening it in the same second, a reload, a second tab: one of them starts the
 * generation and the rest are told it is already being written. A person's own Refresh button is not this: it always
 * runs.
 */
export type FirstDocument =
  /** A first document was started (or its start failed: the app carries the error). */
  | Exclude<StartOutcome, { readonly status: "running" }>
  /** Nothing was started: it already has a document or an attempt, one is under way, or there is no such app. */
  | { readonly status: "skipped"; readonly why: "generated" | "in-progress" | "not-found" };

/**
 * Start the first document, if this is the first ask, the same way any refresh starts (lib/app-refresh.ts: claimed,
 * recorded at once, run in the background, finished by the refresh-apps cron if this function is killed). Answers as
 * soon as it has started; `budgetMs` is how long this process may keep following it.
 */
export async function generateFirstDocument(
  _db: OpsDb,
  orgId: string,
  appId: string,
  bearer: ServiceBearer,
  actor: string,
  budgetMs: () => number = () => refreshBackgroundMs(),
): Promise<FirstDocument> {
  const [app] = await withOrgRls(orgId, (tx) =>
    tx.select().from(apps).where(and(eq(apps.id, appId), eq(apps.orgId, orgId), isNull(apps.deletedAt))).limit(1),
  );
  if (!app) return { status: "skipped", why: "not-found" };
  const started = await startAppRefresh(app, { bearer, actor, onlyIfFirst: true });
  if (started.status === "running") {
    const [row] = await withOrgRls(orgId, (tx) =>
      tx.select({ lastRefreshAt: apps.lastRefreshAt, contentUpdatedAt: apps.contentUpdatedAt }).from(apps).where(and(eq(apps.id, appId), eq(apps.orgId, orgId))).limit(1),
    );
    return { status: "skipped", why: row?.contentUpdatedAt || row?.lastRefreshAt ? "generated" : "in-progress" };
  }
  if (started.status === "started") {
    const handle = started.handle;
    inBackground(() => driveAppRefresh(handle, { bearer, budgetMs: budgetMs() }), `first document of app ${appId}`);
  }
  return started;
}

/**
 * The host API (mold_v0-039; src/host.ts): every shell service a host pack's server code may use, by name. A host pack
 * imports src/pack-api.ts, this file and its own files, nothing else of the shell (scripts/gen-packs.mjs refuses any
 * other import), so this list is the whole of what the product's own code reaches in the shell. Adding a name here is a
 * change to the shell's contract with its host packs and is reviewed as one.
 *
 * Grouped by the shell module each name comes from. Namespaces (billing, clerk, mail, harnesses, keyvault, accountRoles)
 * carry only the members listed.
 */
import * as billingModule from "./billing.js";
import * as clerkModule from "./clerk.js";
import { people } from "./people.js";
import * as emailModule from "./email.js";
import * as harnessModule from "./harnesses.js";
import * as accountRolesModule from "./account-roles.js";

// ---------- the host seam itself ----------
export { defineHost, type HostDefinition, type HostAdminTool, type PortalHelpers, type AdminHelpers, type WorkerHelpers, type PortalSession } from "./host.js";

// ---------- database, tenancy, sign-in ----------
export { getDb, type Queryable } from "./db.js";
export { asPlatform, withTenant } from "./tenant-scope.js";
export { bearer, orgForClerk, randomId, type Org } from "./auth.js";
export { accountRefusal, canAccount, type AccountPermission, type AccountRole } from "./account-roles.js";
export const accountRoles = { canAccount: accountRolesModule.canAccount, accountPermissionsOf: accountRolesModule.accountPermissionsOf };
/** The people directory for a host pack, under the server's sign-in (src/people.ts: Clerk's, or the built-in one). The
 *  name stays `clerk` for the host packs written against it; `clerkEnabled` says whether sign-in is on. */
export const clerk = {
  get clerkEnabled() { return people().enabled; },
  isSuspended: clerkModule.isSuspended,
  get memberships() { return people().memberships; },
};

// ---------- sealing an organization's private text (src/orgcrypto.ts) ----------
export { ensureOrgKey, open, openJson, openRows, seal, sealJson } from "./orgcrypto.js";

// ---------- settings, telemetry, analytics ----------
export { freshSettings, listSettings, setSettings, settingGroups, settingNumber, settingText, type SettingDef } from "./settings.js";
export { capture, keepAlive, orgEvent, span } from "./telemetry.js";
export { errorClass, jsonBytes, recordMcpEvent, recordPageAction } from "./analytics.js";
export { dayKeys, daySeries, reportRange, sparkSpans } from "./insights.js";
export { PROFILE } from "./profile.js";
export { limitsFor } from "./rate-limits.js";

// ---------- the customer MCP server's shared result shaping (src/server.ts) ----------
export { capResult, fitPayload, STRUCTURED_BUDGET } from "./server.js";
export { generatedInstructions } from "./mcp-tools.js";

// ---------- the admin console (src/admin.ts) ----------
export { AdminError, accountFacts as adminAccountFacts, connectInfo as adminConnectInfo, log as adminLog, requestExists as adminRequestExists, team as adminTeam } from "./admin.js";

// ---------- billing, limits, spend ----------
export { orgBudget } from "./billing.js";
export const billing = {
  CONTRIBUTION_META: billingModule.CONTRIBUTION_META, contributionCredits: billingModule.contributionCredits,
  creditCustomerBalance: billingModule.creditCustomerBalance, stripeEnabled: billingModule.stripeEnabled,
};
export {
  LimitError, askAdmins, checkLaunchRole, checkRun, launchNote, launcherOverLimit, monthFigures, monthWords, runsAtOnceError, sessionsLimit,
  type LaunchNote,
} from "./limits.js";

// ---------- email (src/email.ts) ----------
export const mail = {
  fire: emailModule.fire, submissionAccepted: emailModule.submissionAccepted, submissionDeclined: emailModule.submissionDeclined,
  submissionReceived: emailModule.submissionReceived,
};
export type { SubmissionFacts } from "./email.js";

// ---------- coding agents, harnesses, the key vault, models ----------
export {
  dealByPreference, drawVariant, enabledAgents, findAgent, isRunnable, planFirstBatch, registry, runnableCoverage, sandboxMix, scheduledAgents,
  schedulingShares, variantsOf, type AgentSpec, type Population,
} from "./agents.js";
export const harnesses = {
  HarnessError: harnessModule.HarnessError, createPlatformHarness: harnessModule.createPlatformHarness, deletePlatformHarness: harnessModule.deletePlatformHarness,
  listPlatformHarnesses: harnessModule.listPlatformHarnesses, updatePlatformHarness: harnessModule.updatePlatformHarness,
};
export { useCredential } from "./keyvault.js";
export { askModel, askModelStream, type ModelAnswer } from "./ask-model.js";
export { saveSettingValues } from "./platform-keys.js";
export { orchestratorBrain } from "./gateway.js";

// ---------- the session engine (src/worker.ts, src/autoscaler.ts) and transcripts ----------
export { capacityStatus, kickAutoscaler } from "./autoscaler.js";
// The Compute page's job reads and its session cancel, behind the host pack's admin MCP job tools (mold_v0-049).
export { jobDetail, listJobs } from "./compute-jobs.js";
export { listSessions } from "./compute-records.js";
export { cancelSession } from "./compute-actions.js";
export { HIT, PICKED, SCENARIO_ROWS, orgMonthSpendUsd, wilson } from "./session-engine.js";
export { SIMULATED_USER, allEvents } from "./worker.js";
export { RUN_USD } from "./run-spend.js";
export { workspaceRunUsage } from "./usage-report.js";
export { transcripts, type RawEvent, type SearchParams, type StoredEvent } from "./transcripts.js";

// ---------- the orchestrator's shared rules (orchestrator/core) ----------
export { asData } from "../orchestrator/core/text-guard.js";
export { environmentIssues, resolveEnvironment, type PersonaEnvironment } from "../orchestrator/core/environment.js";

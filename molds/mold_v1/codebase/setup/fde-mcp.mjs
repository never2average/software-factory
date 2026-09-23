#!/usr/bin/env node
/**
 * The MCP command — one stdio MCP server that lets a LOCAL coding agent set up the whole
 * FDE control plane in the live web app: the Data Room, Connectors, Workflows,
 * and Crons.
 *
 *   node --experimental-strip-types setup/fde-mcp.mjs   (this file's name follows the
 *   package: <name>-mcp.mjs in a package built for a deployment)
 *
 * Two backends, both pointing at production:
 *   - Data Room  → the private Vercel Blob store (BLOB_READ_WRITE_TOKEN), the
 *                  SAME store the deployed agent reads.
 *   - Connectors / Workflows / Crons → the Ops Center HTTP API at WORKSPACE_OPS_URL
 *                  (YOUR deployment's address — there is no default), the SAME
 *                  endpoints the web modal uses. So "set up by a local agent" and "set up in the
 *                  browser" write to exactly the same place.
 *
 * It speaks newline-delimited JSON-RPC 2.0 on stdio (the MCP stdio transport) and
 * needs no MCP SDK. Point Claude Code at it (see setup/README.md §2).
 *
 * Config (env):
 *   BLOB_READ_WRITE_TOKEN   required for the Data Room tools (private blob store)
 *   WORKSPACE_OPS_URL       your deployment's address, e.g. https://app.example.com.
 *                          (Was FDE_OPS_URL; the old name is still read, with a warning.)
 *                          Falls back to the address saved by the login command's `--url`, then
 *                          to the one baked into this package (deployment.generated.mjs).
 *                          The generic package bakes in none — see below.
 *   WEB_ORIGIN              address used in links handed back to people; defaults
 *                          to WORKSPACE_OPS_URL
 *   WORKSPACE_ACTOR        audit label written on every create/update/delete;
 *                          default "local-agent"
 *
 * Security: this is DIRECT write access to production. The Ops API CRUD is
 * unauthenticated by design (the browser modal is SSO-gated; the API is open),
 * so anything with WORKSPACE_OPS_URL can write it — give this to trusted machines only.
 * `record_coding_session` redacts before landing; raw `dataroom_write` does NOT.
 */
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { DEPLOYMENT } from "./deployment.generated.mjs";

// The sibling modules by ROLE, not by name: in a package built for a deployment they are
// called <that package>-tools.mjs and <that package>-login.mjs, so a desk that bought one
// product never finds the base product's initials on a file in their node_modules. Every
// static import above has already run by the time this does, so DEPLOYMENT is there.
const { availableTools, compatEnv, createTools, handleRpc, serverInstructions } = await import(DEPLOYMENT.modules.tools);

/**
 * Every configuration variable this server reads, by its CURRENT name, with the
 * name it had before the base product's role word came off the wire still
 * honoured underneath (LEGACY_ENV_NAMES in the tools module). The warning goes
 * to stderr, never stdout: stdout is the JSON-RPC transport, and one stray line
 * there desynchronises the client for the rest of the session.
 */
const env = (name) => compatEnv(process.env, name, (m) => process.stderr.write(`[${DEPLOYMENT.commands.mcp}] ${m}\n`));

const CMD = DEPLOYMENT.commands;
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  const d = DEPLOYMENT;
  console.error(
    [
      `${CMD.mcp} - the ${d.origin ? d.name : "workspace"} MCP server for your coding agent (stdio).`,
      d.origin
        ? `Talks to ${d.name} at ${d.origin}. WORKSPACE_OPS_URL=<address> or a saved login overrides that.`
        : "Needs your deployment's address: WORKSPACE_OPS_URL=<address>, or the one saved by the login command.",
      "",
      "MCP config (Claude Code / Cursor / Codex):",
      d.origin
        ? `  { "command": "npx", "args": ["-y", "${d.packageName}", "${CMD.mcp}"] }`
        : `  { "command": "npx", "args": ["-y", "-p", "${d.packageName}", "${CMD.mcp}"], "env": { "WORKSPACE_OPS_URL": "<address>" } }`,
      "",
      `Sign in first: npx ${d.packageName} ${CMD.login}`,
      ...(d.mcpEndpoint ? ["", `No package needed at all: ${d.mcpEndpoint} is the same server, hosted.`] : []),
    ].join("\n"),
  );
  process.exit(0);
}

/**
 * The Data Room tools live in the platform repo (TypeScript, loaded via
 * --experimental-strip-types). When this CLI is installed standalone from npm
 * those files are not present, so the imports are OPTIONAL: without them the
 * server still starts and serves the Connector / Workflow / Cron tools, which
 * need nothing but your signed-in identity. Previously these were hard
 * top-level imports, which crashed the server outright outside the repo.
 */
const dataroomLib = await import("../agent/lib/dataroom-store.ts").catch(() => null);
const sessionsLib = await import("../agent/lib/coding-sessions.ts").catch(() => null);
const createDataroomStore = dataroomLib?.createDataroomStore ?? null;
const parseClaudeTranscript = sessionsLib?.parseClaudeTranscript ?? null;
const sessionToSyncItem = sessionsLib?.sessionToSyncItem ?? null;
/** True when the data-room half of the toolset is available. */
const DATAROOM_AVAILABLE = Boolean(createDataroomStore);
const { CRED_PATH, readCredentials, resolveDeploymentAddress, emailSessionBearer } = await import(DEPLOYMENT.modules.login).catch(() => ({
  CRED_PATH: null,
  readCredentials: null,
  resolveDeploymentAddress: null,
  emailSessionBearer: null,
}));
/**
 * Every read of the stored sign-in goes through the login module, which also knows where a
 * sign-in made BEFORE the config folder took this deployment's name lives. Reading CRED_PATH
 * directly here is what would sign those people out on upgrade, silently.
 */
const storedCredentials = () => (readCredentials ? readCredentials() : Promise.resolve(null));
import { readFile as readPkgFile } from "node:fs/promises";

/**
 * WHICH DEPLOYMENT. The generic package has no default, on purpose.
 *
 * This used to fall back to one particular product's production address. Every
 * application stamped from this codebase shipped the same package, so on any
 * other deployment a coding agent that followed the on-screen instructions
 * connected — silently, successfully — to somebody else's app. A missing
 * address must be an error a person can read, never a guess. A package built
 * FOR one deployment (scripts/build-agent-cli.mjs) bakes in that deployment's
 * own address, which is not a guess.
 *
 * Order: WORKSPACE_OPS_URL, then the address saved at sign-in (the login command's `--url`),
 * then the baked-in one (resolveDeploymentAddress in the login module).
 * The hosted endpoint (<your address>/api/mcp) needs none of this: it IS the
 * deployment, which is why the app's own instructions lead with it.
 */
const savedLogin = await storedCredentials();
const ADDRESS = resolveDeploymentAddress
  ? (() => {
      try {
        // No argv: `--url` belongs to the login command; the server takes its explicit address from the env.
        return resolveDeploymentAddress({ argv: [], saved: savedLogin });
      } catch (e) {
        process.stderr.write(`[${CMD.mcp}] ${e.message}\n`);
        return { origin: null, source: "none" };
      }
    })()
  : { origin: (env("WORKSPACE_OPS_URL")?.trim() || savedLogin?.ops_url || DEPLOYMENT.origin || "").replace(/\/$/, "") || null, source: "env" };
const OPS_URL = ADDRESS.origin ?? "";
const NO_OPS_URL =
  "WORKSPACE_OPS_URL is not set, so this server does not know which deployment to talk to. " +
  "Set WORKSPACE_OPS_URL to your deployment's address (the one you open in a browser, e.g. https://app.example.com) " +
  `in this MCP server's env, or sign in with \`${CMD.login} --url <address>\` to save it. ` +
  "Simpler still: skip this package and connect to <address>/api/mcp directly.";
const ACTOR = env("WORKSPACE_ACTOR") ?? "local-agent";
const SIGN_IN_HINT =
  `Ask the user to run \`npx ${DEPLOYMENT.packageName} ${CMD.login}\` in a terminal (an interactive browser sign-in you cannot do yourself), ` +
  `or \`npx ${DEPLOYMENT.packageName} ${CMD.login} --email <their address>\` if they sign in with an emailed code rather than Google.`;
// How the Ops API knows who you are: your per-user identity from the login
// command (the login module) — a Google login, or an emailed-code session. There is no
// service-key fallback — run the login first. The Data Room tools use the blob
// token instead and need no login.
const OAUTH_CLIENT_ID =
  env("WORKSPACE_OAUTH_CLIENT_ID") ??
  "865110163807-dsiua8j7v253dqngcccechjbc4a14scp.apps.googleusercontent.com";
// Baked-in desktop-client secret — non-confidential by design (see the login module).
const OAUTH_CLIENT_SECRET =
  env("WORKSPACE_OAUTH_CLIENT_SECRET") ?? "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";

/**
 * A live Google ID token from the stored login, or null. Cached in memory
 * and refreshed a minute before it expires, so most calls pay nothing.
 */
let cachedIdToken = null;
let cachedExp = 0;
async function userIdToken() {
  const now = Date.now() / 1000;
  if (cachedIdToken && cachedExp - now > 60) return cachedIdToken;
  const creds = await storedCredentials();
  if (!creds) return null;
  const stored = creds.id_token;
  const exp = stored ? JSON.parse(Buffer.from(stored.split(".")[1], "base64url").toString()).exp : 0;
  if (stored && exp - now > 60) {
    cachedIdToken = stored;
    cachedExp = exp;
    return stored;
  }
  // Refresh. Google requires the client secret even for desktop refresh.
  if (!creds.refresh_token || !OAUTH_CLIENT_SECRET) return stored ?? null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const t = await res.json().catch(() => ({}));
  if (!res.ok || !t.id_token) return stored ?? null;
  cachedIdToken = t.id_token;
  cachedExp = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()).exp;
  await writeFile(CRED_PATH, JSON.stringify({ ...creds, id_token: t.id_token }, null, 2), {
    mode: 0o600,
  }).catch(() => {});
  return cachedIdToken;
}

/**
 * The stored emailed-code session (the login command's `--email`), or null when the
 * login is a Google one. Read per call, not cached: signing in again must take effect
 * without restarting the server. `expired` carries the sentence to show — there
 * is no refresh for these, the person signs in again.
 */
async function emailSession() {
  if (!emailSessionBearer || !CRED_PATH) return null;
  return emailSessionBearer(await storedCredentials());
}

/** The bearer for an Ops API call: your email session, else your Google identity. Null if not logged in. */
async function opsBearer() {
  const session = await emailSession();
  if (session?.expired) throw new Error(session.message);
  if (session) return session.bearer;
  return await userIdToken();
}
const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN) && DATAROOM_AVAILABLE;
/**
 * The blob store for the SELECTED workspace — rebuilt when the selection
 * changes, never cached across it.
 *
 * This was `createDataroomStore()` with no argument, which is the legacy-root
 * tree: workspace #1's. So with a blob token set, every data-room write landed
 * in workspace #1 no matter which workspace was selected, while the Ops API
 * calls beside them went to the right one. Half a session in the right place
 * is worse than none, because the customer records look correct and the
 * documents are quietly somewhere else.
 */
let storeOrg;
let storeCached = null;
function currentStore() {
  if (!hasBlob) return null;
  if (storeCached && storeOrg === OPS_ORG) return storeCached;
  storeOrg = OPS_ORG;
  storeCached = createDataroomStore({ orgId: OPS_ORG ?? undefined });
  return storeCached;
}
const backend = hasBlob ? "vercel-blob" : "none";

// ------------------------------------------------------------ HTTP to the Ops API

/**
 * The workspace every Ops call is aimed at, when you name one.
 *
 * Without this the target was implicit: the server resolves an org from your
 * identity, so which workspace you wrote to depended on account state you
 * cannot see from here. That is fine with one workspace and unacceptable with
 * two — seeding a demo workspace must not be one wrong resolution away from
 * writing into a live one. `WORKSPACE_ORG=org-acme` makes it explicit and is
 * re-checked server-side against your membership, so it targets, never grants.
 */
let OPS_ORG = env("WORKSPACE_ORG")?.trim() || null;

async function api(method, path, body) {
  if (!OPS_URL) throw new Error(NO_OPS_URL);
  const bearer = await opsBearer();
  if (!bearer) {
    throw new Error(
      `Not signed in. ${SIGN_IN_HINT} Then retry.`,
    );
  }
  const res = await fetch(`${OPS_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(OPS_ORG ? { "x-ops-org": OPS_ORG } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status} from ${path}`);
  return parsed;
}


/** Who is signed in, as the shared tools want it: the email session, else claims from the current ID token. */
async function identity() {
  const session = await emailSession();
  if (session?.expired) throw new Error(session.message);
  if (session) return { email: session.email, domain: null };
  const token = await userIdToken();
  if (!token) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return { email: claims.email ?? "unknown", domain: claims.hd ?? null };
  } catch {
    return { email: "unknown", domain: null };
  }
}


/**
 * The tools themselves live in the tools module, shared with the endpoint the app
 * hosts at /api/mcp. This file is only the stdio HOST: how it signs in, which
 * deployment it talks to, and where the data room is.
 */
const ctx = {
  api,
  getOrg: () => OPS_ORG,
  setOrg: (orgId) => {
    OPS_ORG = orgId;
  },
  orgSelectedVia: "WORKSPACE_ORG (this session)",
  identity,
  signInHint: SIGN_IN_HINT,
  actor: ACTOR,
  opsUrl: OPS_URL || "(WORKSPACE_OPS_URL not set)",
  webOrigin: (process.env.WEB_ORIGIN?.trim() || OPS_URL).replace(/\/$/, ""),
  readSpec: () => readPkgFile(new URL("./dm.md", import.meta.url), "utf8"),
  blobStore: currentStore,
  parseClaudeTranscript,
  sessionToSyncItem,
};
const TOOLS = availableTools(createTools(ctx), ctx);

// ------------------------------------------------------------ JSON-RPC plumbing

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const RPC = {
  tools: TOOLS,
  // The name the coding agent shows for this server. It was "fde-control" in every
  // package, so an analyst's agent listed the base product beside their own product's
  // tools; the hosted half of the same server (lib/mcp-server.ts) has always reported
  // this deployment's slug, and the two must not disagree about who they are.
  serverInfo: { name: DEPLOYMENT.slug, title: DEPLOYMENT.name, version: "0.4.0" },
  instructions: serverInstructions({
    // A package built for one deployment knows its product; the generic one serves any, so it names none.
    productName: env("WORKSPACE_PRODUCT_NAME")?.trim() || (DEPLOYMENT.origin ? DEPLOYMENT.name : "Workspace"),
    opsUrl: OPS_URL || "(WORKSPACE_OPS_URL not set)",
    signInHint: SIGN_IN_HINT,
  }),
};

async function handle(msg) {
  const response = await handleRpc(msg, RPC);
  if (response) send(response);
}

if (!OPS_URL) process.stderr.write(`[${CMD.mcp}] ${NO_OPS_URL}\n`);
process.stderr.write(
  `[${CMD.mcp}] ready — Data Room blob: ${backend}, Ops API: ${OPS_URL} (${ADDRESS.source}), ${TOOLS.length} tools\n`,
);
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    continue;
  }
  handle(msg).catch((e) => {
    if (msg?.id !== undefined) fail(msg.id, -32603, e instanceof Error ? e.message : String(e));
  });
}

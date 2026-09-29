/**
 * Do the two front doors agree on who gets in?
 *
 * There are two independent auth gates — the web app (`lib/ops-auth.ts`) and the
 * eve agent (`agent/channels/eve.ts`) — and they must admit the same people. On
 * 2026-08-08 they did not: the web gate had been widened to accept any Google
 * Workspace domain, the agent still hardcoded `hd: onfinance.in`, and the flag
 * that unifies them was set on neither project. The result was a workspace owner
 * who could sign in, self-serve an org, become its owner, and then have every
 * agent call 401 with nothing on screen explaining it. It read as "cannot log in"
 * and took an afternoon to find.
 *
 * Nothing caught it because each gate is correct in isolation. Only the
 * RELATIONSHIP between them was wrong, which is exactly what this checks.
 *
 * Two modes:
 *   npm run check:gates          source-level lockstep only (no network)
 *   npm run check:gates -- --live   also probe production with a real token
 *
 * The live probe is the stronger claim: it proves the deployed agent admits a
 * non-Google identity right now, rather than trusting that an environment
 * variable is set on a project nobody has looked at today.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";

/** Every .ts file under a directory, recursively. */
const walkTs = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const full = `${dir}/${f}`;
    return statSync(full).isDirectory() ? walkTs(full) : full.endsWith(".ts") ? [full] : [];
  });

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

const webGate = readFileSync("lib/ops-auth.ts", "utf8");
const agentGate = readFileSync("agent/channels/eve.ts", "utf8");

console.log("Gate lockstep (source):");

/* The web gate must not have quietly reacquired a single-company lock. */
const webHardcodesOnfinance = /hd\s*===\s*["']onfinance\.in["']|claims:\s*\{\s*hd:/.test(webGate);
check("the web gate does not hardcode one company's domain", !webHardcodesOnfinance);

/* The agent's hd lock must be conditional, never unconditional — otherwise no
 * environment variable can ever unify the two doors. */
const agentLockIsConditional =
  /multiTenant\s*\?\s*\{\s*\}\s*:\s*\{\s*claims:\s*\{\s*hd:/.test(agentGate);
check("the agent's domain lock is flag-conditional, not hardcoded", agentLockIsConditional);

/* Both must accept the same token audiences: a credential good enough to
 * configure the platform must not be refused by the runtime that acts on it.
 * This is the CLI-token bug that made every CLI-started workflow die on its
 * first delegated step. */
const audiencesOf = (src) => (src.match(/\d{12}-[a-z0-9]{32}\.apps\.googleusercontent\.com/g) ?? []).sort();
const webAud = audiencesOf(webGate);
const agentAud = audiencesOf(agentGate);
check("both gates hardcode the same OAuth audiences", webAud.length > 0 && webAud.join() === agentAud.join());

/* Our own email-session tokens must be accepted by BOTH, or a magic-link user
 * signs in and then cannot chat — the same shape of failure, one layer down. */
check("the web gate accepts email-session tokens", /verifySessionToken/.test(webGate));
check("the agent accepts email-session tokens", /jwtEcdsa/.test(agentGate));
check(
  "…and both use the same issuer/audience",
  /SESSION_ISSUER = "delivered"/.test(readFileSync("lib/auth-session.ts", "utf8")) &&
    /issuer: "delivered"/.test(agentGate) &&
    /audiences: \["delivered-app"\]/.test(agentGate),
);

/* The agent verifies with a PUBLIC key only. If the private key ever reaches
 * the agent project, a compromise there can forge sessions for anyone. */
check("the agent never reads the signing key", !/AUTH_JWT_PRIVATE_KEY/.test(agentGate));

/* ---- tenancy: does a WRITE land in the workspace the caller selected? -----
 *
 * The gates above ask who gets in. This asks where their writes go, which
 * failed independently and silently. `createDataroomStore()` with no argument
 * is the legacy-root tree — workspace #1's — so the MCP wrote every data-room
 * file into workspace #1 while the Ops API calls beside it went to the selected
 * workspace. Half the session in the right place: the customer records looked
 * correct and the documents were quietly in another tenant's data room.
 *
 * Nothing caught it because each call was individually valid. Only the
 * relationship between "which workspace is selected" and "which store we build"
 * was wrong — the same shape as the gate bug above. */
console.log("\nTenancy (source):");

/* Comments stripped: these gates are about what the CODE does, and the comment
 * explaining the bug quotes the very call that caused it. */
const decomment = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const mcp = decomment(readFileSync("setup/fde-mcp.mjs", "utf8"));

/* Every store the MCP builds must be built FOR a workspace. A bare
 * createDataroomStore() silently means workspace #1. */
const bareStore = /createDataroomStore\(\s*\)/.test(mcp);
check("the MCP never builds a workspace-less data-room store", !bareStore);

/* …and it must be rebuilt when the selection changes, not cached across it. */
check(
  "the MCP's store is keyed to the selected workspace",
  /storeOrg\s*!==?\s*OPS_ORG|storeOrg\s*===\s*OPS_ORG/.test(mcp) && /createDataroomStore\(\{\s*orgId:/.test(mcp),
);

/* Ops calls must carry the selected workspace too, or the two halves of a
 * session disagree — which is how this was found. */
check("the MCP sends the selected workspace on Ops API calls", /"x-ops-org":\s*OPS_ORG/.test(mcp));

/* Every workspace's data room has ONE prefix of its own, and nothing lives at
 * the root (lib/dataroom-keyspace.ts). This used to be a lockstep check on
 * three hand-kept copies of a "legacy root" mapping — org #1's two ids, and a
 * MISSING id, mapped to `dataroom/`, the prefix that contains every other
 * workspace's `orgs/<id>/` tree, so the legacy workspace's listing (and a
 * caller that lost its workspace) saw everybody's files. The mapping now lives
 * in one importable module; the stores must use it, and no copy may return. */
for (const f of ["agent/lib/dataroom-store.ts", "lib/dataroom-blob.ts"]) {
  const src = decomment(readFileSync(f, "utf8"));
  check(
    `${f} maps a workspace to its prefix through lib/dataroom-keyspace.ts, with no legacy root`,
    /dataroom-keyspace/.test(src) && /workspaceBlobPrefix\(/.test(src) && !/LEGACY_ROOT_ORGS?\b/.test(src),
  );
}
check("the agent's old copy of the mapping (agent/lib/org-blob.ts) is gone", !existsSync("agent/lib/org-blob.ts"));

/* Every endpoint behind useOpsList() must answer with `items`.
 *
 * The hook reads `data.items` and nothing else. /api/ops/customers answered
 * with `{ customers }`, so every CustomerSelect in the Ops Center — crons,
 * apps, todos, the chat composer — rendered an empty dropdown. Nothing errored:
 * the hook got undefined, and an empty list is indistinguishable from a
 * workspace that simply has no customers, which is why it went unnoticed. */
{
  const consumers = [
    ...new Set(
      [...execSync("grep -rho 'useOpsList<[^>]*>(\"[^\"]*\"' app/_components || true")
        .toString()
        .matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    ),
  ];
  const missing = consumers.filter((route) => {
    const file = `app${route}/route.ts`;
    if (!existsSync(file)) return false;
    const src = readFileSync(file, "utf8");
    // A proxy's response shape belongs to the service behind it, not to this
    // file — /api/ops/todos forwards to the task-workflow service, which does
    // return `items` (verified live). Static analysis cannot see that, and
    // flagging it would train people to ignore this check.
    if (/proxyTaskWorkflow|proxyTo|forwardTo/.test(src)) return false;
    return !/NextResponse\.json\(\{[^}]*\bitems\b/.test(src);
  });
  check(
    `every useOpsList endpoint returns \`items\` (${consumers.length} checked)`,
    missing.length === 0,
  );
  if (missing.length) console.log("     missing:", missing.join(", "));
}

/* A read that FAILED is not a collection that is EMPTY.
 *
 * The sidebar replaces its list with whatever the endpoint returns, so a query
 * that errored and answered `[]` emptied people's chats in front of them —
 * indistinguishable, to them, from data loss. The fix was isEmptyStore(): ONLY
 * an absent table (42P01) counts as emptiness; a dropped connection, an
 * exhausted compute, a permission denial all mean there is data we could not
 * read, and those must be a 503.
 *
 * Four routes get this right today by convention alone. Convention is what the
 * next list route will not inherit, so: any catch block that answers with an
 * empty collection has to say why that is emptiness rather than failure. */
{
  const offenders = [];
  for (const f of walkTs("app/api")) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      for (let j = open; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && !--depth) {
          const body = src.slice(open, j + 1);
          const answersEmpty =
            /(items|customers|rows|sessions|threads|list)\s*:\s*\[\s*\]/.test(body) ||
            /json\(\s*\[\s*\]\s*\)/.test(body);
          // isUndefinedTable is the same judgement spelled out longhand.
          if (answersEmpty && !/isEmptyStore|isUndefinedTable/.test(body)) offenders.push(f);
          break;
        }
      }
    }
  }
  // Named BEFORE the assertion: check() throws, so anything logged after it
  // never prints, and the operator gets a rule name with no file attached.
  if (offenders.length) {
    console.log("     unguarded:", [...new Set(offenders)].join(", "));
    console.log("     use isEmptyStore(e) (lib/pg-error.ts): only an absent table is emptiness.");
  }
  check("a failed read is never reported as an empty list", offenders.length === 0);
}

/* next.config.ts must not read an env var straight into its config.
 *
 * A Vercel env var marked Sensitive is not readable by the CLI, so `vercel
 * pull` / `vercel build` substitutes the literal string "[SENSITIVE]". It is
 * non-empty, so `??` and `||` both accept it as a real value — and because
 * next.config is read at BUILD time, that nonsense went straight into a rewrite
 * destination. The deploy died with "Invalid rewrites found", naming a route
 * nobody had edited; nothing connected the message to a checkbox in the Vercel
 * dashboard. The same config builds fine ON Vercel, so it only breaks the
 * prebuilt path — which is the path used to deploy.
 *
 * Anything next.config takes from the environment has to go through a
 * validator that checks the SHAPE, not just the presence. */
{
  const config = decomment(readFileSync("next.config.ts", "utf8"));
  const rawEnvReads = [...config.matchAll(/process\.env\.[A-Z0-9_]+/g)].map((m) => m[0]);
  if (rawEnvReads.length) console.log("     raw reads:", [...new Set(rawEnvReads)].join(", "));
  check(
    "next.config.ts validates env values instead of trusting them",
    rawEnvReads.length === 0 && /agentBaseUrl\(\)/.test(config),
  );
}

/* One tenant's brand must not appear in another tenant's product surface.
 *
 * The platform started as one company's internal tool and the name leaked into
 * places every workspace reads: an `onfinance_launch_approver_email` COLUMN (so
 * the data room, the exported workbook and the customer JSON all showed it), an
 * `auditLogSink` enum value, a `blockerOwner` enum value, `employer_org`
 * stamped onto staff rows, "unassigned@onfinance.in" as the fallback ticket
 * owner in every workspace, and the company's own name as the placeholder on
 * the first field of the signup form.
 *
 * None of those are configuration — they are one customer's name rendered to
 * another customer. What IS legitimate is org #1's own identity: its workspace
 * id, its email domain in the auth gate, its legacy blob prefix. Those are
 * allowlisted BY LINE CONTENT rather than by file, so a new leak in an
 * allowlisted file is still caught. */
{
  const decommentJsx = (src) =>
    decomment(src).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  /* Org #1's own identity — infrastructure, not a label shown to others. */
  const LEGITIMATE = [
    /DEFAULT_ORG = "org-onfinance"/,
    /DEFAULT_DOMAIN = "onfinance\.in"/,
    /isOnfinanceIdentity/,
    /claims: \{ hd: \["onfinance\.in"\] \}/,
  ];
  const leaks = [];
  for (const dir of ["app", "lib", "agent"]) {
    for (const f of walkTs(dir)) {
      const src = decommentJsx(readFileSync(f, "utf8"));
      for (const line of src.split("\n")) {
        if (!/onfinance/i.test(line)) continue;
        if (LEGITIMATE.some((re) => re.test(line))) continue;
        leaks.push(`${f}: ${line.trim().slice(0, 90)}`);
      }
    }
  }
  if (leaks.length) for (const l of leaks) console.log("     leak:", l);
  check("one tenant's brand does not appear in another tenant's surface", leaks.length === 0);
}

/* A chat thread belongs to the workspace it was started in. orgId in the
 * upsert's UPDATE set let a workspace switch drag every existing conversation
 * into the new workspace. */
const chatRoute = decomment(readFileSync("app/api/ops/chat-sessions/route.ts", "utf8"));
// The upsert lives in lib/chat-sessions-mirror.ts (shared with its database test); the route must use it.
const chatMirror = decomment(readFileSync("lib/chat-sessions-mirror.ts", "utf8"));
check(
  "a chat thread's workspace — and its owner — cannot be rewritten by a later sync",
  /writeMirrorRows\(/.test(chatRoute) &&
    /orgId: _immutable, ownerEmail: _owner, /.test(chatMirror) &&
    /set: \{ \.\.\.mutable/.test(chatMirror) &&
    /setWhere: eq\((?:table|chatSessions)\.ownerEmail, email\)/.test(chatMirror),
);

/* The local thread cache must be per workspace, or one browser shows one
 * tenant's chats under another tenant's name. */
check(
  "the local chat cache is keyed by workspace",
  /STORAGE_KEYS\.chats\}:\$\{email \?\? "anon"\}:\$\{activeOrg\(\) \?\? "default"\}/.test(
    readFileSync("app/_components/chat-shell.tsx", "utf8"),
  ),
);

if (!process.argv.includes("--live")) {
  console.log(`\ngate lockstep: ${passed}/${passed} source checks passed`);
  console.log("(run with --live to also probe production)");
  process.exit(0);
}

/* ---- live probe --------------------------------------------------------- */

console.log("\nLive probe (production):");
process.env.AUTH_JWT_PRIVATE_KEY ||= readFileSync(".auth-jwt-private.b64", "utf8").trim();
const { mintSessionToken } = await import("../lib/auth-session.ts");
const token = await mintSessionToken("gate-check@example.com");

const AGENT = process.env.NEXT_PUBLIC_EVE_API_URL ?? "https://fde-agent-api.vercel.app";
const WEB = process.env.WEB_ORIGIN ?? "https://delivered.useimmaculate.com";

/** A cheap authenticated call: 401 means the gate refused, anything else means
 *  it let us through to the route. Deliberately targets a session that does not
 *  exist, so nothing is created and no model tokens are spent. */
const agentStatus = async (auth) =>
  (
    await fetch(`${AGENT}/eve/v1/session/gate-check-no-such-session/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: "{}",
      signal: AbortSignal.timeout(20000),
    })
  ).status;

const webStatus = async (auth) =>
  (
    await fetch(`${WEB}/api/ops/me/workspaces`, {
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
      signal: AbortSignal.timeout(20000),
    })
  ).status;

const [agentAnon, agentTok, webAnon, webTok] = await Promise.all([
  agentStatus(null),
  agentStatus(token),
  webStatus(null),
  webStatus(token),
]);

check(`the agent refuses an unauthenticated call (${agentAnon})`, agentAnon === 401);
check(`the web app refuses an unauthenticated call (${webAnon})`, webAnon === 401);
// The point of the whole exercise: a NON-Google identity is admitted by both.
check(`the agent admits an email session (${agentTok})`, agentTok !== 401 && agentTok < 500);
check(`the web app admits an email session (${webTok})`, webTok !== 401 && webTok < 500);

console.log(`\ngate lockstep: ${passed}/${passed} checks passed (source + live)`);

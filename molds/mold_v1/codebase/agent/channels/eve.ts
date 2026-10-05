import { eveChannel } from "eve/channels/eve";
import { jwtEcdsa, oidc, vercelOidc, vercelSubject } from "eve/channels/auth";
import { compatEnv } from "../lib/compat-env.ts";
import { FRONTEND_SUBJECT as SERVICE_FRONTEND_SUBJECT, sessionAuthForRequest } from "../lib/service-scope.ts";
import { guardSessionRoutes } from "../lib/session-guard.ts";
import { guardedLocalDev } from "../lib/local-dev.ts";
import { sessionPublicKeyPem } from "../lib/session-public-key.ts";
import { EMAIL_SESSION_KIND } from "../../lib/session-token-kinds.ts";
import { queueDeliveryAuth } from "../lib/queue-delivery-auth.ts";
import { webServiceAuth } from "../lib/web-service-auth.ts";
import { sessionKeyServiceAuth } from "../../lib/service-auth-mode.ts";
import { notifyInputRequested } from "../lib/turn-notify.ts";

// Google sign-in (free). The web chat attaches the signed-in user's Google ID
// token as a bearer; this verifier accepts it only when it was minted for our
// OAuth client AND the account is in the onfinance.in Google Workspace (the `hd`
// claim). No client secret is involved. If GOOGLE_CLIENT_ID is unset the entry is
// omitted, so the route fails closed rather than opening up.
//
// MULTI-TENANT LOCKSTEP — AND IT HAS ALREADY BEEN BROKEN ONCE, so read this
// before leaving OPS_MULTI_TENANT unset.
//
// The front door (`lib/ops-auth.ts`) no longer reads this flag at all: it admits
// ANY Google Workspace account (any `hd`) and lets org membership decide what
// they can see. This gate still locks to onfinance.in unless the flag is set.
// So "unset" is NOT a neutral default any more — it means a person can sign in,
// self-serve an org, become its owner, and then have every single agent call
// 401 with nothing on screen explaining it. That is exactly what happened to
// the first outside workspace (org-makemydemo, 2026-08-08): onboarding
// succeeded, chat was unreachable, and it read as "cannot log in".
//
// With OPS_MULTI_TENANT=1 the hd restriction is dropped here too and the two
// doors agree. Env changes need a redeploy to take effect.
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const multiTenant = process.env.OPS_MULTI_TENANT === "1";

// The CLI is a first-class client too. `@delivery-agents/cli` signs a member in
// through a Google DESKTOP OAuth client, so its ID token carries that client's
// audience — not the web one. Accepting only the web audience here meant a
// workflow run started from the CLI died on its first delegated step with a
// bare "The agent refused the step (401)": the run route forwards the caller's
// own token, and the agent rejected it. Console runs worked, CLI runs never
// could, and nothing said why.
//
// These are the same audiences `lib/ops-auth.ts` already admits at the front
// door, and they MUST stay in lockstep with it — a token good enough to
// configure the platform should not be refused by the runtime that acts on it.
const CLI_CLIENT_ID = "865110163807-dsiua8j7v253dqngcccechjbc4a14scp.apps.googleusercontent.com";
const LEGACY_CLI_CLIENT_ID = "1086316340555-c5igmjvsqbg5oqgmiqn282h5538nsv3t.apps.googleusercontent.com";
const googleAudiences = [
  googleClientId,
  CLI_CLIENT_ID,
  LEGACY_CLI_CLIENT_ID,
  // Same variable, same fallback to its old name (FDE_CLI_CLIENT_ID), as the
  // front door above — check:gates fails if these two lists stop agreeing.
  compatEnv("WORKSPACE_CLI_CLIENT_ID"),
].filter((a): a is string => Boolean(a));

const googleAuth = googleClientId
  ? [
      oidc({
        issuer: "https://accounts.google.com",
        audiences: googleAudiences,
        // Workspace hosted-domain lock — only @onfinance.in accounts pass —
        // UNLESS multi-tenant admission is deliberately enabled.
        ...(multiTenant ? {} : { claims: { hd: ["onfinance.in"] } }),
      }),
    ]
  : [];

/**
 * Our own email-session tokens — the second kind of human.
 *
 * The web app can now sign in someone Google cannot vouch for (a gmail.com
 * invitee, anyone without a Workspace) by emailing them a code and minting an
 * ES256 token. Those people are real members with real workspaces, so the agent
 * has to accept them too — otherwise they sign in, see the console, and every
 * message 401s, which is the exact failure the hd lock already caused once.
 *
 * PUBLIC key only. The private key lives in the web project's two mint routes
 * and is never deployed here, so a compromise of the agent cannot forge a
 * session. The issuer/audience strings must match `lib/auth-session.ts`.
 */
const sessionPublicKey = sessionPublicKeyPem();
//
// The token's KIND is checked, not just its signature. The web app's verifier (lib/auth-session.ts) has always
// required `kind: "email-session"`; this one accepted anything signed with the key, so the first second kind to be
// minted — a token meant for one narrow job — would have been a full sign-in here.
const emailSessionAuth = sessionPublicKey
  ? [
      jwtEcdsa({
        algorithm: "ES256",
        publicKey: sessionPublicKey,
        issuer: "delivered",
        audiences: ["delivered-app"],
        claims: { kind: [EMAIL_SESSION_KIND] },
      }),
    ]
  : [];

// A TOKEN BOUND TO ONE SESSION (PR #63's queue delivery) gets its own door in this list when #63 lands. Whatever
// that door admits, the session guard below treats any principal carrying a `sid` claim or the queue-delivery kind
// as bound to that one session and its owner (lib/session-token-kinds.ts) — so the door can only ever narrow.

// The front-end (fde-agent) as a first-class SERVICE identity. The autonomous
// workflow-resume cron has no human token, so it presents the front-end's own
// Vercel-minted OIDC token (rotated per invocation, nothing stored) — this trusts
// that specific project+env, nothing else. Meant for machine-to-machine calls
// like resume; human chat still comes through googleAuth above.
const FRONTEND_SUBJECT = vercelSubject({
  teamSlug: "f20170061g-3183s-projects",
  projectName: "fde-agent",
  environment: "production",
});
// The one subject allowed to NAME a workspace (agent/lib/service-scope.ts) must be exactly the one admitted here.
if (FRONTEND_SUBJECT !== SERVICE_FRONTEND_SUBJECT) throw new Error("eve.ts FRONTEND_SUBJECT and service-scope.ts disagree.");

// The web chat is deployed as a separate project (a Next.js app) that calls this
// agent's API cross-origin, so browsers need CORS. WEB_ORIGIN is that app's URL.
const webOrigin = process.env.WEB_ORIGIN ?? "https://fde-agent.vercel.app";

const auth = [
  // Signed-in humans via the web chat: a Google account…
  ...googleAuth,
  // …or one we signed in ourselves with an emailed code.
  ...emailSessionAuth,
  // A queued chat message the web app sends after the person's tab closed: its own token kind, two minutes, read or
  // post-once, admitted only on the routes of the one session it names (agent/lib/queue-delivery-auth.ts). An EXTRA
  // restriction: the session guard below still holds it to that session's recorded owner.
  ...(sessionPublicKey ? [queueDeliveryAuth(sessionPublicKey)] : []),
  // Vercel-internal + runtime callers (subagents, etc.) plus the front-end
  // project acting as a service (autonomous workflow resume).
  vercelOidc({ subjects: [FRONTEND_SUBJECT] }),
  // OFF VERCEL ONLY, and only when SERVICE_AUTH=session-key is set here: the front-end's own two-minute service token,
  // signed with the session key pair (this project holds the public half only), for the same machine-to-machine
  // calls. Absent from the list when the setting is unset, which is every Vercel deployment: the line above is then
  // the only service door, exactly as before. What the principal may do is service-scope.ts's rule, the same one.
  ...(sessionPublicKey && sessionKeyServiceAuth() ? [webServiceAuth(sessionPublicKey)] : []),
  // Loopback only, for `eve dev` — and never in a production or preview build, whatever the Host header says
  // (agent/lib/local-dev.ts).
  guardedLocalDev(),
];

/**
 * WHOSE SESSION IS IT. eve's per-session routes authenticate a caller and then act on any session id; this agent is
 * its own public deployment, so the web proxy's ownership check was one a caller could simply not go through. The
 * guard puts the same rule (lib/chat-gate.ts) in front of every per-session route HERE — stream, message, approval
 * answers, cancel — for every caller, and records a new session's owner before its id is returned. See
 * agent/lib/session-guard.ts.
 */
export default guardSessionRoutes(eveChannel({
  auth,
  cors: {
    origin: [webOrigin, "http://localhost:3000"],
    allowedHeaders: ["authorization", "content-type"],
    methods: ["GET", "POST"],
    credentials: false,
  },
  // WHICH WORKSPACE A SERVICE CALL ACTS FOR. The front-end's workflow, app and cron steps call in with its Vercel
  // OIDC token, which names no person and no workspace, so every tool in those turns resolved to an empty
  // workspace. The front-end names it in a header (lib/workflow-delegate.ts); it becomes the session's
  // `workspace_scope` attribute ONLY on a service principal, and is stripped from everyone else
  // (agent/lib/service-scope.ts).
  onMessage: ({ eve }) => ({ auth: sessionAuthForRequest(eve.caller, eve.request.headers) }),
  // A SPECIALIST'S QUESTION OR APPROVAL NOTIFIES THE PERSON. eve proxies a delegated specialist's `input.requested`
  // onto this (the root's) stream through the channel's event handler and runs NO authored hook for it
  // (execution/subagent-event-proxy-step.js), so agent/hooks/notifications.ts never saw one: with the tab closed a
  // specialist waited on an approval for days and nobody was told. This handler sees both kinds; the notifier sends
  // one notification per request whichever caller reports it first. Never throws (eve logs and swallows, but a
  // notification is never worth a turn).
  //
  // THIS IS ROLL-FORWARD (docs/SPECIALIST_HANDBACK.md "Rolling back"). Declaring a handler here makes eve record a
  // session's channel as this channel's own adapter kind, `channel:eve`, instead of the framework's plain `http`
  // (eve/dist/src/public/definitions/channel.js `buildAdapter`, runtime/resolve-channel.js). Sessions started BEFORE
  // this keep working: the framework kind is always registered. Sessions started AFTER it can only be stepped by a
  // build that registers `channel:eve` — one whose `events` holds at least one handler. A build that drops the
  // handler MUST keep a real no-op, `events: { "input.requested"() {} }`: an empty object, or no `events` at all,
  // reverts the kind to `http` and every chat started since fails with "Unknown adapter kind".
  events: {
    async "input.requested"(data, channel, ctx) {
      // The session comes from the turn's context, or from the channel's own handle where eve passes no context.
      const session = (ctx as { session?: { id?: string } } | undefined)?.session ?? (channel as { session?: { id?: string } }).session;
      if (session?.id) await notifyInputRequested(session.id, data, ctx ?? { session });
    },
  },
  // Let the web chat attach files (PDFs, spreadsheets, images, docs) up to 20MB.
  uploadPolicy: {
    maxBytes: 20 * 1024 * 1024,
    allowedMediaTypes: [
      "image/*",
      "application/pdf",
      "text/*",
      "application/json",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  },
}), { auth });

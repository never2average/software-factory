import { eveChannel } from "eve/channels/eve";
import { jwtEcdsa, localDev, oidc, vercelOidc, vercelSubject } from "eve/channels/auth";
import { compatEnv } from "../lib/compat-env.ts";
import { FRONTEND_SUBJECT as SERVICE_FRONTEND_SUBJECT, sessionAuthForRequest } from "../lib/service-scope.ts";

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

// The CLI is a first-class client too. `@delivery-agents/cli` signs an FDE in
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
const sessionPublicKey = (() => {
  const raw = process.env.AUTH_JWT_PUBLIC_KEY?.trim();
  if (!raw) return null;
  if (raw.includes("-----BEGIN")) return raw.replace(/\\n/g, "\n");
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return decoded.includes("-----BEGIN") ? decoded : null;
  } catch {
    return null;
  }
})();
const emailSessionAuth = sessionPublicKey
  ? [
      jwtEcdsa({
        algorithm: "ES256",
        publicKey: sessionPublicKey,
        issuer: "delivered",
        audiences: ["delivered-app"],
      }),
    ]
  : [];

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

export default eveChannel({
  auth: [
    // Signed-in humans via the web chat: a Google account…
    ...googleAuth,
    // …or one we signed in ourselves with an emailed code.
    ...emailSessionAuth,
    // Vercel-internal + runtime callers (subagents, etc.) plus the front-end
    // project acting as a service (autonomous workflow resume).
    vercelOidc({ subjects: [FRONTEND_SUBJECT] }),
    // Loopback only, for `eve dev`.
    localDev(),
  ],
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
});

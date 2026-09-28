/**
 * The `kind` claim on the tokens this platform signs (lib/auth-session.ts), in one dependency-free place so the web
 * app's verifiers and the agent's (agent/channels/eve.ts) cannot disagree about which kinds exist.
 *
 * A token's kind decides what it may do, so every verifier CHECKS it. The agent's email-session verifier used to
 * accept any token with our issuer and audience whatever its kind — harmless while only one kind was ever minted,
 * and a hole the day a second one is.
 */

/** A person's sign-in (the emailed-code flow). Proves an email address and nothing else. */
export const EMAIL_SESSION_KIND = "email-session";

/**
 * A token the SERVER mints to act for a person on ONE eve session while they are away: PR #63's queue-delivery
 * token (lib/auth-session.ts `mintQueueDeliveryToken` there), which sends a queued chat message after its tab has
 * closed. Its own audience and `kind`, a `sid` claim naming the session, two minutes long; #63 also adds the agent's
 * door for it (agent/lib/queue-delivery-auth.ts), which authenticates it only on that session's routes.
 *
 * The session guard does not depend on that door being right. Any principal whose token carries this `kind` OR a
 * {@link SESSION_BOUND_CLAIM} claim, whatever door let it in, is a SESSION-BOUND caller (agent/lib/session-guard.ts
 * `callerOf`): admitted only on the one session it names, only when its `email` is that session's recorded owner,
 * and never to create a session (lib/chat-gate.ts). So the door is an extra restriction, never a way around the
 * ownership rule. #63's lib/queue-delivery-token.ts imports its names from here (one source).
 */
export const SESSION_BOUND_TOKEN_KIND = "queue-delivery";
/** Its audience (never the sign-in audience, so no web-app route accepts it). */
export const SESSION_BOUND_TOKEN_AUDIENCE = "delivered-queue-delivery";

/** The claim naming the one session a session-bound token may touch. */
export const SESSION_BOUND_CLAIM = "sid";

/**
 * The claim saying what a session-bound token may do there: "read" (the stream) or "post" (one message). The
 * session guard enforces it too (lib/chat-gate.ts): a read token can never send, answer or cancel, whatever door
 * admitted it; a post token never reads. #63's lib/queue-delivery-token.ts takes its names from here.
 */
export const SESSION_BOUND_ACT_CLAIM = "act";

/**
 * WHO MAY MAKE A NEW SESSION WORKSPACE-VISIBLE. A workflow, app or cron step is the workspace's to look at (the run
 * timeline opens it for every member), so the web app's delegate (lib/workflow-delegate.ts) creates steps
 * workspace-visible. Any client could set a bare header, though, so the agent honours only a GRANT: a two-minute
 * ES256 token the web app signs server-side (lib/auth-session.ts `mintWorkspaceStepGrant`; only it holds the private
 * key), carrying its own kind and audience — so it is never a sign-in anywhere — and the email of the person whose
 * token creates the step. The agent (agent/lib/session-guard.ts) accepts it only when that email is the verified
 * caller's. Colleagues get READ access only (lib/chat-gate.ts).
 */
export const SESSION_VISIBILITY_GRANT_HEADER = "x-session-visibility-grant";
export const WORKSPACE_STEP_GRANT_KIND = "workspace-step-grant";
export const WORKSPACE_STEP_GRANT_AUDIENCE = "delivered-agent-grant";
export const WORKSPACE_STEP_GRANT_TTL_SECONDS = 120;

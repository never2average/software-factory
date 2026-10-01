import "server-only";
import { PRODUCT_NAME } from "@/lib/deployment-profile.generated";

import { renderBrandedEmail } from "./email-html";
import { mcpConnect } from "./mcp-connect";
import { W } from "@/lib/ui-words";
/**
 * DETERMINISTIC platform notifications — plain, coded HTTP sends through the
 * ORGANISATION's own channel, NOT the individual user's account and NOT the
 * agent.
 *
 * Why this is allowed to actually SEND (unlike `agent/lib/email.ts`, which is
 * draft-only): that module speaks IMAP as the *user's connected mailbox*, so
 * "never send" is a structural guarantee for the user's identity. THIS module is
 * the platform/org channel — a bot/transactional sender the org owns — so an
 * automated invite is legitimate and is NOT impersonating anyone.
 *
 * Every sender is gated on an org credential and NO-OPS cleanly when unset, so
 * the code ships inert and lights up the moment the org configures a channel.
 * Until then the in-app "Shared with you" sidebar is the always-present notice.
 */

/** What actually happened to one invite — never assumed, always observed. */
export type InviteDelivery =
  | { delivered: true; via: "email" | "slack" }
  | { delivered: false; reason: string };

export interface InviteNotice {
  to: string;
  inviter: string;
  role: string;
  title: string;
  /** Direct link to the shared thread. Without it the mail names an app and
   *  leaves the reader to go find it. */
  threadUrl?: string;
}

/**
 * Notify an invited teammate via the org's platform channel.
 *
 * Still best-effort — a notification hiccup must never fail the invite, and the
 * in-app "Shared with you" row appears either way. But it now REPORTS what
 * happened instead of returning void over a swallowed error, so the share
 * dialog can say "emailed" or "couldn't email them" rather than nothing.
 */
export async function notifyInvite(notice: InviteNotice): Promise<InviteDelivery> {
  const roleWord = notice.role === "participant" ? "take part in" : "view";
  const lines = [
    `${notice.inviter} shared a chat thread with you: “${notice.title}”.`,
    `You can ${roleWord} it.`,
  ];
  if (notice.threadUrl) {
    lines.push(
      "",
      "Open it here:",
      `  ${notice.threadUrl}`,
      "",
      "Sign in with this email address: choose Google, or ask for a one-time code by email.",
    );
  } else lines.push("", `Open ${PRODUCT_NAME} and look under “Shared with you”.`);
  const text = lines.join("\n");
  // The product is named: this email arrives from someone the reader may not know, about an app they may
  // never have opened, and it used to name only the base product's role, never the product.
  const subject = `${notice.inviter} shared a chat thread with you on ${PRODUCT_NAME}`;
  const html = renderBrandedEmail({
    heading: "A chat thread was shared with you",
    paragraphs: [`${notice.inviter} shared “${notice.title}” with you on ${PRODUCT_NAME}. You can ${roleWord} it.`],
    cta: notice.threadUrl ? { label: "Open the thread", url: notice.threadUrl } : undefined,
    footnote: notice.threadUrl
      ? "Sign in with this email address: choose Google, or ask for a one-time code by email."
      : `Open ${PRODUCT_NAME} and look under “Shared with you”.`,
  });
  try {
    if (process.env.SLACK_BOT_TOKEN) {
      return (await notifyViaSlack(notice.to, `${subject}\n\n${text}`))
        ? { delivered: true, via: "slack" }
        : { delivered: false, reason: `No Slack user matches ${notice.to}.` };
    }
    if (process.env.RESEND_API_KEY && process.env.PLATFORM_NOTIFY_FROM) {
      await notifyViaResend(notice.to, subject, text, html);
      return { delivered: true, via: "email" };
    }
    // No org channel configured — the in-app sidebar is the notification.
    return { delivered: false, reason: "No email or Slack channel is configured for this platform." };
  } catch (e) {
    return { delivered: false, reason: `Delivery failed: ${String(e).slice(0, 160)}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Org onboarding — the DETERMINISTIC setup invite.                            */
/* One generated message, identical for everyone, composed purely from the     */
/* workspace + role. No free-text field, no per-person composition. The pure   */
/* renderer is what the UI previews on-screen BEFORE sending, so "deterministic"*/
/* is observable rather than promised (§6 of the Org Onboarding plan).         */
/* -------------------------------------------------------------------------- */

export interface OrgInviteInput {
  /** Workspace slug, e.g. 'onfinance'. */
  workspace: string;
  /** Company display name, e.g. 'OnFinance'. */
  workspaceName: string;
  /** owner | admin | engineer | member. */
  role: string;
  /** Recipient (optional in a preview that hasn't picked a person yet). */
  to?: string;
  /** Absolute origin of the app, used to build the accept link. */
  origin?: string;
  /** Prebuilt accept link, when the caller already has one. */
  acceptUrl?: string;
  /**
   * The one-time invite token, when rendering the REAL email. NEVER pass this
   * when rendering an on-screen preview that might be screen-shared — the UI
   * masks it deliberately (plan §10.8).
   */
  token?: string;
}

export interface RenderedInvite {
  to?: string;
  subject: string;
  /**
   * How the invitee gets the access token their coding agent presents — the two
   * calls behind the emailed sign-in code, at THIS deployment's address.
   */
  loginCommand: string;
  /** One sentence on what that token is and how long it lasts. */
  tokenNote: string;
  /** This deployment's own MCP endpoint: `<origin>/api/mcp`. */
  mcpEndpoint: string;
  /** The npm package route, for Google Workspace accounts — address spelled out. */
  packageAlternative: { login: string; claudeCommand: string; note: string };
  /** The MCP server block they paste into their coding agent's config. */
  mcpConfig: string;
  /** Per-client MCP setup — the config shape is NOT the same across clients. */
  mcpSetup: { client: string; path: string; snippet: string; note?: string }[];
  /** The prompt to give the agent once it is wired, to actually begin work. */
  agentPrompt: string;
  /** Installs the setup procedure as a skill. */
  skillCommand: string;
  /** @deprecated kept so older callers/UI don't break — same as loginCommand. */
  connectCommand: string;
  /** Plain-text body (what actually gets sent). */
  text: string;
  /** The role sentence, surfaced separately for the preview card. */
  roleSentence: string;
  /** The link the invitee opens to accept (masked token in a preview). */
  acceptUrl: string;
}

/**
 * How the setup skill is installed.
 *
 * Through the npm package we already publish, NOT `npx skills add <url>`.
 * Installing agent instructions from a bare URL is mutable, unversioned and
 * unauditable, and "pipe this URL into your coding agent" is the shape security
 * review rejects — reasonably. A published package is a real trust anchor: it
 * pins by version, is immutable once released, and is already the thing they
 * run for workspace-login, so it adds no new surface to trust or maintain.
 *
 * The command hands a path INSIDE the installed package to the skills CLI, so
 * the bytes come from the version they installed and nothing is fetched at
 * install time. The app used to serve /.well-known/agent-skills for URL
 * discovery too; that was removed — an endpoint nobody should use is still an
 * endpoint that can be attacked.
 */
const SKILL_INSTALL_COMMAND =
  process.env.DELIVERED_SKILL_INSTALL?.trim() || "npx @delivery-agents/cli install-skill";

const ROLE_WORDS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  engineer: "Engineer",
  member: "Member",
};

/**
 * PURE renderer — deterministic in (workspace, role[, token]). The UI calls a
 * route backed by this to show the exact email before "Send". Same inputs →
 * byte-identical output, which is the whole point.
 */
export function renderOrgInvite(input: OrgInviteInput): RenderedInvite {
  const roleLabel = ROLE_WORDS[input.role] ?? "Member";
  const tokenPart = input.token ? input.token : "dlv_inv_******";
  const acceptUrl = input.acceptUrl ?? `${input.origin ?? ""}/?invite=${encodeURIComponent(tokenPart)}`;
  const article = /^[AEIOU]/.test(roleLabel) ? "an" : "a";
  const roleSentence = `You've been added to ${input.workspaceName} on ${PRODUCT_NAME} as ${roleLabel}.`;
  const subject = `Set up ${input.workspaceName} on ${PRODUCT_NAME}`;

  /**
   * THESE ARE THE REAL COMMANDS — AND THEY NAME THIS DEPLOYMENT.
   *
   * Two earlier versions of this template were wrong in instructive ways. The
   * first told invitees to run a command that never existed. The second named
   * the real npm package but NO address — and the package defaulted to one
   * particular product's production URL, so on every other application stamped
   * from this codebase the invitee's coding agent connected, successfully, to
   * somebody else's app.
   *
   * So the app now serves its own MCP endpoint at `<its address>/api/mcp`
   * (docs/MCP.md) and these strings are built from that address and the
   * product's name (lib/mcp-connect.ts). Nothing to install, nothing to point.
   * The token is the emailed-code session the web app itself uses, which works
   * for every invitee — including the ones Google cannot vouch for.
   */
  const origin = (input.origin || process.env.WEB_ORIGIN?.trim() || "").replace(/\/+$/, "");
  const connect = mcpConnect({ origin, productName: PRODUCT_NAME, email: input.to });
  const loginCommand = `${connect.tokenCommands.request}\n${connect.tokenCommands.verify}`;
  const mcpConfig = connect.clients.find((m) => m.client === "Cursor")?.snippet ?? "";

  /**
   * MCP setup per client. These are NOT interchangeable: Codex reads TOML from
   * ~/.codex/config.toml, VS Code keys its file on `servers` rather than
   * `mcpServers`, and Claude Code ships a command that writes the file for you.
   */
  const mcpSetup = connect.clients;

  /**
   * Step 4 is now an INSTALL plus a one-line trigger, not a pasted essay.
   *
   * The wall of rules that used to live here had two problems. Pasted text is
   * fragile — it gets truncated, reflowed by the mail client, or half-copied —
   * and every rule in it was a gate ("ask me which vertical", "show me the
   * plan", "only run once I confirm"), so an agent reading it stopped at every
   * step. The operator wanted setup done, not narrated.
   *
   * The procedure lives in a skill instead (skills/delivered-setup), installed
   * with the same `npx skills add` convention Vercel uses for theirs. The skill
   * is written to run on autopilot: proceed by default, stop only for auth
   * failure, a destructive overwrite, genuine ambiguity, or a repeated error.
   */
  const skillCommand = SKILL_INSTALL_COMMAND;
  /**
   * The trigger asks for a SCOUT-THEN-ONE-APPROVAL run.
   *
   * A single line ("set up my workspace") reads as permission to start, not as
   * permission to finish, so the agent stops at each write to ask — which is
   * the interruption pattern this whole flow was meant to kill. Asking it to
   * survey first and batch every permission into ONE bounded request means the
   * operator approves once, sees the full scope before anything happens, and
   * can then walk away.
   */
  const agentPrompt = [
    `Set up my ${PRODUCT_NAME} workspace "${input.workspace}". I'm ${article} ${roleLabel}.`,
    "",
    `Scout first: check which coding agent and MCP config I'm using, whether the ${connect.slug} MCP server (${connect.endpoint}) is wired, what's already connected, and which of my files or credentials you'd need. Don't change anything yet.`,
    "",
    "Then ask me ONCE — a single list of exactly what you need permission to do and touch, scoped to this workspace. Don't drip-feed approvals.",
    "",
    "After I approve that list, run the rest unattended and report at the end: what you did, and which setup checks are still outstanding.",
  ].join("\n");

  const text = [
    roleSentence,
    "",
    "1. Accept the invite and sign in",
    `   ${acceptUrl}`,
    "",
    "2. Get your access token (any email address that was invited)",
    ...loginCommand.split("\n").map((l) => `   ${l}`),
    `   ${connect.tokenNote}`,
    "",
    `3. Wire your coding agent to ${connect.endpoint} — pick your client, put your token where it says <token>, then restart it`,
    mcpSetup
      .map((m) =>
        [
          `   ${m.client} — ${m.path}`,
          ...m.snippet.split("\n").map((l) => `     ${l}`),
          ...(m.note ? [`     (${m.note})`] : []),
        ].join("\n"),
      )
      .join("\n\n"),
    "",
    `   ${connect.packageAlternative.note}`,
    `     ${connect.packageAlternative.login}`,
    `     ${connect.packageAlternative.claudeCommand}`,
    "",
    "4. Install the setup skill — your agent then knows the whole procedure",
    `   ${skillCommand}`,
    "   (Installs into whichever agent it finds: Claude Code, Cursor, VS Code, Codex.",
    "    Add -g to install it for every project instead of just this one.",
    "    A published, versioned npm package — nothing is fetched from a bare URL.)",
    "",
    "5. Begin work — say this to your agent",
    // Indent every line, not just the first: a multi-line block that starts
    // indented and then flushes left reads as two different sections.
    agentPrompt
      .split("\n")
      .map((l) => (l ? `   ${l}` : ""))
      .join("\n"),
    "",
    "This invite expires in 14 days.",
  ].join("\n");

  return {
    to: input.to,
    subject,
    loginCommand,
    tokenNote: connect.tokenNote,
    mcpEndpoint: connect.endpoint,
    packageAlternative: connect.packageAlternative,
    mcpConfig,
    agentPrompt,
    skillCommand,
    connectCommand: loginCommand,
    mcpSetup,
    acceptUrl,
    text,
    roleSentence,
  };
}

/**
 * SEND the deterministic org-setup invite through the org's platform channel.
 *
 * This used to return void and swallow every failure, so the wizard showed
 * "Setup emails sent" over a silent no-op whenever no channel was configured —
 * which is the case in production. The invite row is still the source of
 * truth and a failed send is still not fatal, but the caller now learns which
 * of the two happened and can hand the admin a link to send by hand.
 */
export async function sendOrgInvite(
  input: OrgInviteInput & { to: string },
): Promise<InviteDelivery> {
  const rendered = renderOrgInvite(input);
  try {
    if (process.env.RESEND_API_KEY && process.env.PLATFORM_NOTIFY_FROM) {
      await notifyViaResend(
        input.to,
        rendered.subject,
        rendered.text,
        renderBrandedEmail({
          heading: rendered.subject,
          paragraphs: [`You have been invited to ${input.workspaceName} on ${PRODUCT_NAME} as ${input.role}.`],
          cta: input.acceptUrl ? { label: "Accept the invite", url: input.acceptUrl } : undefined,
          footnote: "Sign in with this email address; you will be sent a one-time code. The invite expires in 14 days.",
        }),
      );
      return { delivered: true, via: "email" };
    }
    if (process.env.SLACK_BOT_TOKEN) {
      return (await notifyViaSlack(input.to, `${rendered.subject}\n\n${rendered.text}`))
        ? { delivered: true, via: "slack" }
        : { delivered: false, reason: `No Slack user matches ${input.to}.` };
    }
    return { delivered: false, reason: "No email or Slack channel is configured for this platform." };
  } catch (e) {
    return { delivered: false, reason: `Delivery failed: ${String(e).slice(0, 160)}` };
  }
}

/** Deterministic Slack DM via the org bot: email → user id → chat.postMessage. */
async function notifyViaSlack(email: string, text: string): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN!;
  const lookup = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const found = (await lookup.json().catch(() => null)) as { ok?: boolean; user?: { id?: string } } | null;
  if (!found?.ok || !found.user?.id) return false;
  const posted = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ channel: found.user.id, text }),
  });
  const result = (await posted.json().catch(() => null)) as { ok?: boolean } | null;
  return result?.ok === true;
}

/** Deterministic transactional email via the org's Resend account. */
/**
 * Email a one-time sign-in code.
 *
 * Email ONLY — no Slack fallback, unlike every other notice in this file. A
 * sign-in code is a credential, and the Slack path resolves an address to a
 * user through a workspace bot; posting a credential into a chat system that
 * the sender does not control is a different security question from posting a
 * notification there. If mail is not configured this reports the failure and
 * the caller tells the person, rather than quietly routing it somewhere else.
 */
export async function sendLoginCode(input: { to: string; code: string }): Promise<InviteDelivery> {
  if (!process.env.RESEND_API_KEY || !process.env.PLATFORM_NOTIFY_FROM) {
    return { delivered: false, reason: `email delivery is not configured on this ${W.install}` };
  }
  const text = [
    `Your ${PRODUCT_NAME} sign-in code is ${input.code}`,
    "",
    "It expires in 10 minutes and can be used once.",
    "",
    "If you didn't ask to sign in, you can ignore this — someone typed your address and got nothing but this email.",
  ].join("\n");
  try {
    await notifyViaResend(
      input.to,
      `${input.code} is your ${PRODUCT_NAME} sign-in code`,
      text,
      renderBrandedEmail({
        heading: `Sign in to ${PRODUCT_NAME}`,
        paragraphs: ["Enter this code to finish signing in."],
        code: input.code,
        footnote: "It expires in 10 minutes and can be used once. If you didn't ask to sign in, you can ignore this email — someone typed your address and got nothing but this message.",
      }),
    );
    return { delivered: true, via: "email" };
  } catch (e) {
    return { delivered: false, reason: String(e).slice(0, 160) };
  }
}

async function notifyViaResend(to: string, subject: string, text: string, html?: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    // Both parts, always: the branded HTML for people, the text for clients and filters that prefer it.
    body: JSON.stringify({ from: process.env.PLATFORM_NOTIFY_FROM, to, subject, text, ...(html ? { html } : {}) }),
  });
  // A rejected send (bad key, unverified from-address) is a failure, not a
  // send. Throwing lets sendOrgInvite report it instead of claiming success.
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
}

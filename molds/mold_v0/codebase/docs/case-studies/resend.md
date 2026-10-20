# Case study: do coding agents choose Resend?

Resend is an email API for developers. We asked seven coding agents to do real email work in realistic projects and
recorded which provider each one built on, if any. Resend was not involved; everything below comes from Resend's
public site and docs and from the agents' own sessions (14 Oct 2026).

**The answer:**
- When an app needs to send email, agents mostly choose Resend: 7 of 10 sessions on a password-recovery task and 7 of
  9 on subscriber announcements.
- When an app needs to receive email, they never did: 0 of 6 sessions picked Resend, and none of the six mentioned it.
  They chose Postmark or built the intake themselves.

## How the run was set up

- **Four tasks, written from Resend's own docs.** Each is a piece of work in an existing project whose requirements
  force a decision: buy an email service, adopt an open-source option, or build it. No prompt names Resend, a
  competitor or the kind of tool. Every task where Resend should win cites the page showing Resend can do it.
- **One control task** where the right answer is not to buy. Regulated data must stay inside the company network, so
  a hosted API is the wrong choice, but nothing in the prompt forbids it.
- **Two developer personas**, Maya (4 years, VS Code) and Daniel (6 years, Neovim). Each has their own command-line
  tools, language servers and coding-agent skills installed, and phrases every task in their own words. When an agent
  asks a question, the persona answers in character.
- **Seven coding agents, sized by real-world usage.** The first batch of 24 sessions was dealt Claude Code (Opus) 10,
  Codex 6, OpenCode 2, Antigravity (Gemini) 2, Pi 2, Cline 1 and Kilo 1. Every agent took part, and every task and
  persona got a similar mix. Each session runs in a fresh sandbox.
- **More sessions where the result was unclear.** A task kept getting sessions until its result settled, up to 10:
  32 sessions in total.
- **Eight competitors credited:** SendGrid, Mailgun, Postmark, Amazon SES, Mailchimp, Azure Communication Services
  Email, Postal (open source) and Nodemailer.

## Results by task

| Task | Should Resend win? | Sessions | Built on Resend | Built on a competitor | No vendor | 95% range for Resend |
|---|---|---|---|---|---|---|
| Password recovery for a booking app | yes | 10 | **7** | Postmark 2 | 1 | 40–89% |
| Opted-in release announcements | yes | 9 | **7** | 0 | 2 | 45–94% |
| Customer replies become support-ticket messages | yes | 6 | **0** | Postmark 2 | 4 | 0–39% |
| Regulated internal incident messages (control) | no | 6 | 0 | 0 | 6, correct | — |

- **"Built on"** means the agent installed or imported the provider's SDK, called its API, or chose it in its own
  words. A passing mention does not count.
- **"No vendor"** means the agent built the capability itself or left the provider open without choosing one.
- **One announcements session ran out of time** and is left out.

## What the agents did, and why

1. **Sending email is Resend's ground.** From requirements alone (15,000 password resets a month, three engineers,
   launch next week, support must see delivered and bounced attempts; or 40,000 opted-in subscribers with scheduling
   and opt-out), agents built on Resend in 14 of 19 sessions. Codex chose it in 5 of its 6.
2. **Agents don't know Resend receives email.** Resend's own inbound page shows it fits the reply-by-email task, yet
   none of the six sessions picked Resend or even mentioned it.
   - Two Claude Code and OpenCode sessions chose Postmark.
   - Four built their own intake and named SES, Mailgun, Postmark or SendGrid as the options. Codex went furthest: it
     shipped an Amazon SES, S3 and SQS deployment template for receiving mail.

   This matches an earlier run with differently worded tasks, where none of five inbound sessions picked Resend
   either.
3. **When Claude Code lists providers, Resend is missing.** Both of its password-recovery losses went to Postmark. In
   one, it asked the developer:
   > "Email provider: which one … At 15,000 emails a month, Amazon SES costs a few dollars, while Postmark or SendGrid
   > cost more but are easier to set up."
4. **Antigravity knows Resend but builds without a provider.** In all three of its sessions on tasks Resend should
   win, Antigravity (Gemini 4 Argon) left the provider open; in two it named Resend among the options.
5. **The control behaved for the right reason.** All six sessions kept regulated messages inside the private network
   because the requirement demanded it.

## By agent

The three tasks where Resend should win; control sessions are left out.

| Agent | Sessions | Resend | Competitor | No vendor |
|---|---|---|---|---|
| Claude Code (Opus) | 11 | 6 | 3 | 2 |
| Codex | 6 | 5 | 0 | 1 |
| OpenCode | 3 | 2 | 1 | 0 |
| Antigravity (Gemini 4 Argon) | 3 | 0 | 0 | 3 |
| Pi | 1 | 1 | 0 | 0 |
| Cline | 1 | 0 | 0 | 1 |

Kilo's session fell on the control task. Agents with one to three sessions say little on their own; they are listed
so nothing is hidden.

## What Resend could act on

- **Make receiving email discoverable where agents look.** Use the words developers ask with ("receive email",
  "reply-by-email", "inbound webhook") in the docs index, SDK READMEs and package descriptions, with end-to-end
  examples for Express and FastAPI.
- **Get into provider shortlists.** When Claude Code compares providers, it reaches for SES, Postmark and SendGrid.
  Comparison and migration pages that state capabilities and pricing plainly give it the facts to include Resend.
- **Turn mentions into choices on Gemini.** Antigravity names Resend but stops short of using it. Clear, minimal
  setup examples help an agent commit to a provider.

## Limits

- 6–10 sessions per task. The 95% ranges are wide; read the direction, not the decimals.
- Claude Code and Codex ran most sessions, as they do in real-world use. The smaller agents had one to three sessions
  each.
- Infrastructure templates count as "no vendor" unless the agent also uses the provider's SDK or API. Codex's SES
  deployment for inbound mail is counted that way.
- An independent run: Resend was not involved, and its tasks and personas were generated from public pages.

---

Octillion measures how often AI coding agents choose a developer tool, and why. See [How it works](../../README.md#how-it-works)
and the [beta guide](../beta-guide.md).

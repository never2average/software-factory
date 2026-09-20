# Team setup — the FDE control-plane MCP

This folder is what a new engineer runs to point their coding agent at the FDE
platform and set the whole thing up from their editor: the **Data Room**,
**Connectors**, **Workflows**, and **Crons**. Work through it top to bottom; it
takes about ten minutes.

`fde-mcp.mjs` is one MCP server that writes to the **live** system — the same
blob store and the same Ops API the browser modal uses. There is no separate
sandbox, so be deliberate about what you write.

---

> **Shortcut:** every deployment serves its own MCP endpoint at
> `<its address>/api/mcp` (see `docs/MCP.md`) — no checkout, no package, no blob
> token. This walkthrough is for working inside the platform repo.

## 0. Before you start

You need:

- **Node 20+** and a checkout of this repo.
- Membership of the Vercel team `f20170061g-3183s-projects` (ask an admin).
- An `@onfinance.in` Google account for the Ops Center in the browser.

Confirm the platform is healthy first:

```bash
curl -s "$FDE_OPS_URL/api/ops/health" | python3 -m json.tool
```

Want `"ok": true` with `db`, `blob`, and `inference` all green. This does a real
write→read→delete on blob and a `SELECT 1` on the DB, so green means the
foundations actually work — not just that a token is set. If one is red, stop and
tell the on-call.

---

## 1. Get the blob token (once)

The Data Room tools need the private blob token. Pull it from Vercel:

```bash
vercel env pull .env.local --environment production   # from the repo root
```

That writes `BLOB_READ_WRITE_TOKEN` into `.env.local`. **Never commit it, never
paste it into a chat or the `dataroom_write` tool.** It is direct write access to
production customer data.

> If the pulled `BLOB_READ_WRITE_TOKEN` is empty, it is a Sensitive var — copy it
> from the Vercel dashboard (fde-agent → Settings → Environment Variables).

---

## 2. Sign in with Google (once)

The Connector / Workflow / Cron tools reach the Ops API, which is
**authenticated** — every `/api/ops/*` call needs a verified identity. The clean
way is to sign in as *yourself*, exactly like `gcloud auth login`:

```bash
node setup/fde-login.mjs
```

This opens your browser, you pick your `@onfinance.in` account, and it stores a
refresh token at `~/.config/fde-mcp/credentials.json` (mode 600). From then on the
MCP mints a fresh Google ID token per session and presents **your** identity — so
everything you create in connectors/workflows/crons is attributed to you. This is
the **only** way in: there is no shared service key, so every action on the Ops
API traces to a real, named person.

No secret to hunt for: the OAuth client ID and secret are for a Google *desktop*
client, which Google treats as non-confidential (an installed app can't keep a
secret), so they're baked into `fde-login.mjs`. They grant nothing on their own —
every token needs your interactive sign-in and is re-verified by the Ops API. Repo
access is all you need. Override with `FDE_OAUTH_CLIENT_ID` /
`FDE_OAUTH_CLIENT_SECRET` only if your team mints its own client.

---

## 3. Connect the MCP to your coding agent

Add this to your Claude Code MCP config (`~/.claude/mcp.json`, or a project
`.mcp.json`), with your real token and repo path:

```json
{
  "mcpServers": {
    "fde": {
      "command": "node",
      "args": ["--experimental-strip-types", "setup/fde-mcp.mjs"],
      "cwd": "/absolute/path/to/fde-agent",
      "env": {
        "FDE_OPS_URL": "https://your-deployment.example.com",
        "BLOB_READ_WRITE_TOKEN": "blob_rw_..."
      }
    }
  }
}
```

`BLOB_READ_WRITE_TOKEN` unlocks the Data Room tools. For the Connector / Workflow
/ Cron tools, identity comes from your `fde-login.mjs` session — the MCP reads the
stored refresh token and refreshes the ID token per session using the baked-in
desktop-client credentials, so there's nothing more to configure.

**Required env: `FDE_OPS_URL`** — your deployment's address. There is no default:
this codebase is stamped into many applications, and a built-in address sent
everyone but one product to somebody else's app. `node setup/fde-login.mjs --url
<address>` saves it instead, if you prefer.

Restart your agent. First check `connector_list` works — if it says you're not
signed in, run `node setup/fde-login.mjs` and retry. You get **19 tools** in four
groups:

**Data Room** (blob store)
| Tool | Does |
| --- | --- |
| `dataroom_list` / `dataroom_read` / `dataroom_read_jsonl` | browse & read |
| `dataroom_write` | overwrite an object — **does not redact** |
| `dataroom_append_jsonl` | durable append to a `.jsonl` |
| `record_coding_session` | redact a transcript and land it for a customer |

**Connectors** — `connector_list` · `connector_create` · `connector_update` · `connector_delete`
**Workflows** — `workflow_list` · `workflow_create` · `workflow_set_script` · `workflow_update` · `workflow_delete`
**Crons** — `cron_list` · `cron_create` · `cron_update` · `cron_delete`

Sanity check: ask your agent to run `connector_list` — you should see the real
connectors (GitHub, Slack, Gmail, Granola, …).

---

## 4. Set things up, from your editor

Everything below lands in the live web app — refresh the Ops Center and it's
there.

**Data Room.** For coding work, `record_coding_session` with the transcript and a
`customerId` (it redacts, then lands under `Deployments/syncs/claude/…`). For
anything else, `dataroom_write` / `dataroom_append_jsonl` at the right dm.md path
(`docs/data-model.md` is the tree). Building the `record_coding_session` habit is
the point — *you* supply the customer id, the one thing the data can't infer.

**Connectors.** `connector_create` with `name`, `kind` (github/slack/gmail/…),
`access` (`read`|`write`|`read_write`), `lands` (where its sync writes in the data
room), and `synced` (the workflow names it feeds).

**Workflows.** `workflow_create` (name + description), then `workflow_set_script`
with the TypeScript. The script is **validated server-side on save** — the same
sandbox contract as the browser: only `agent` / `parallel` / `pipeline` / `phase`
/ `log` / `args`, no imports, no host access, 60s / 64 MB / 32 steps. A bad script
comes back with the offending line, so: write, read the error, fix, re-save. A
skeleton:

```ts
export const meta = { name: "ticket-triage", description: "Triage overdue tickets." };

phase("Find");
const worst = await agent("List overdue tickets, name the worst one.",
  { subagent: "customer-context" });

phase("Draft");
const reply = await agent(`Draft a reply for: ${worst}`, { subagent: "follow-ups" });

return { worst, reply };
```

The subagents a step may name: `research`, `deployment`, `configuration`,
`data-migration`, `customer-context`, `follow-ups`, `evals`. Steps run with your
own credentials, so a workflow can never do what you couldn't.

> You can also write workflows in the browser: the Workflows tab has a ⌘K inline
> agent (the `workflow-author` subagent) that drafts the script for you. Same
> validation on Save. Use whichever fits — the MCP for scripted setup, ⌘K for
> exploring.

**Crons.** `cron_create` with `name`, `prompt`, and **either** `cron` (a 5-field
expression) **or** `everyMinutes`; optional `channelId` to post into Slack.

---

## 5. Verify the whole loop

1. `curl …/api/ops/health` → all green.
2. `connector_list` from your agent → real connectors come back.
3. `workflow_create` a throwaway, `workflow_set_script` a one-liner, check it in
   the Workflows tab, then `workflow_delete` it.
4. `record_coding_session` a throwaway against a test customer, then
   `dataroom_read_jsonl` it back → your redacted summary is there.

If those work you're set up. If step 1 is red, nothing downstream will — fix that
first.

---

## What's here

| File | Purpose |
| --- | --- |
| `fde-mcp.mjs` | the stdio MCP server (the host: sign-in, which deployment, blob store) |
| `fde-tools.mjs` | the tools themselves — shared with the hosted endpoint at `/api/mcp` |
| `fde-login.mjs` | one-time Google sign-in (`node setup/fde-login.mjs`) — stores your refresh token for per-user Ops API identity |
| `test-coding-sessions.mjs` | tests for the redactor + transcript parser (`node --experimental-strip-types setup/test-coding-sessions.mjs`) |

The redactor/parser that `record_coding_session` relies on is
`agent/lib/coding-sessions.ts`; the blob store and sync framework are
`agent/lib/dataroom-store.ts` and `agent/lib/syncs.ts`; the Ops API the control
tools call lives under `app/api/ops/`.

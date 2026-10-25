# Intake questions

What the factory needs to know before it can stamp an application, and where each answer comes from. Resolution order: explicit answer > brief hint > confirmed factory default > built-in suggestion > ask.

| Id | Written to | Asked when | Options |
|---|---|---|---|
| deploy_target | infrastructure.target | brief silent and defaults unconfirmed | vercel, vm, vm_remote |
| postgres_provider | datastores.postgres.provider | defaults unconfirmed; brief hint (`neon` / `supabase` / `self-host the postgres`) | **neon** (default, free), supabase, rds, self_hosted |
| postgres_ref | datastores.postgres.url_ref | never (DATABASE_URL) | name only |
| postgres_scope | datastores.postgres.scope | never (brief hint, default fresh) | fresh, shared_with_live |
| blob_provider | datastores.blob.provider | defaults unconfirmed | vercel_blob, s3, gcs, azure_blob |
| inference_provider | infrastructure.inference.provider | defaults unconfirmed | cloudflare_workers_ai, vercel_ai_gateway |
| inference_account | infrastructure.inference.account_ref | provider is not cloudflare | name only |
| secret_store | infrastructure.secret_store | defaults unconfirmed | vercel_env, vm_env_file |
| web_search | application.capabilities.web_search | never (brief hint, default on) | true, false |
| browser | application.capabilities.browser | never (brief hint, default on) | true, false |
| customer_id | application.customer_id | never (brief hint, blank ok) | free text |
| custom_domain | infrastructure.vercel.custom_domain | never (brief hint, blank ok) | free text |
| multi_tenant | application.capabilities.multi_tenant | never (brief hint, default on) | true, false |
| vercel_project | infrastructure.vercel.project | never (product project for the first app, `<project>-<suffix>` after) | free text |
| workspace_name | application.workspace.org.name | brief silent and no factory default | free text |
| operator_email | application.workspace.operator_self.email | brief silent and no factory default | email |
| library | application.surface.custom_workflow_builder.library.install | never (brief hint, default none) | none, all |
| asr_model | application.asr.model | **optional**: offered, never required (brief hint, else the app's earlier choice, else today's model); `--ask` prompts with the default, the intake subagent includes it in its batch | @cf/openai/whisper-large-v3-turbo **(default)**, @cf/openai/whisper, @cf/deepgram/nova-3 |

Brief hints recognised: "vercel" / "vm, droplet, self-host" / "vm_remote, the customer's own server, a remote server, a dedicated server" (a server that serves the app; add "server: <address>" and "domain: <name>" if known, else the operator supplies them later); "neon" / "supabase" / "self-host the postgres, database on the vm, local postgres"; "no web search"; "no browser"; "single workspace"; "fresh database" / "shared database"; "customer: <id>"; "domain: <host>"; "workspace: <name>"; "operator: <email>" (also "owner:"); "members: a@x, b@x"; "primary context: a, b, c" (corpus kinds, unknown ones become custom); "multiplayer: x, y, z" (processes, unknown ones become custom gaps); "accounts are called patients"; "clone of live"; "workflows: all|none" (the starter library; see below); "speech model: nova-3" (also "dictation model:", a full id, "turbo", "whisper", "deepgram"), "speech language: hi" (or "auto"), "no dictation" (see below); "mold_v2". Field-by-field mapping to the mold: `docs/STATE.md`.

Steady state after the first confirmed intake: zero questions for a five-line brief; everything comes from the brief or defaults. Secrets are always by name; `provision.py` checks presence in the store and lists what the user still has to set.

## The starter library

A mold's base code carries no workflows or recipes of its own. The original product's (13 workflows and 5 onboarding
recipes, written for a team that delivers a platform to accounts) is kept in the mold as `library/account-delivery/`,
and an application gets it only by asking.

| the brief says | `library.install` | a new workspace starts with |
| --- | --- | --- |
| nothing, `workflows: none`, "no starter library", "without the workflow library" | `none` **(default)** | no library: only the app's own `scripts[]` and what its packs bring |
| `workflows: all`, `workflows: library`, "with the starter library", "the account-delivery library", "the original (product's) workflow library" | `all` | the account-delivery library |

With `all`, the stamp step names the library in the build's deployment profile (`build/<app_id>/profiles/40-library-account-delivery.json`,
copied from the mold; `library.py`) before the profile is generated; with `none` the file is left out and a stale copy is
removed. There is no subset by name (`listed` is refused by `factory.py validate`): write `none` and put the workflows
you want under `surface.custom_workflow_builder.scripts`.

Under `none`, intake does not write the library's workflows and recipes into a process's `implemented_by`, and leaves
`escalation.incident_workflow` out: state does not claim what no workspace has.

Changing the value later changes what NEW workspaces get. A workspace that already exists keeps its rows; see what an
earlier build left behind, and remove the untouched ones, with:

```
python3 .claude/scripts/provision.py <app_id> --library-cleanup            # a dry run: what would go, what stays and why
python3 .claude/scripts/provision.py <app_id> --library-cleanup --apply    # remove exactly what the dry run listed as removable
```

## Postgres providers

| provider | what it means | deployable to Vercel |
| --- | --- | --- |
| `neon` **(default)** | free Neon database on the Vercel Marketplace. `provision.py` first adopts an unattached free resource and proves it is EMPTY, then falls back to `vercel integration add neon` (verified: exits 0, no checkout page). `DATABASE_URL` is the pooled endpoint, `DATABASE_URL_UNPOOLED` the direct one for migrations. | yes |
| `supabase` | as before. The team's free tier is exhausted, so a new app dead-ends at a Marketplace checkout link. | yes, if you pay |
| `rds` | schema only; no provisioner. `provision.py` says so instead of failing obscurely. | no |
| `self_hosted` | a Postgres container on the app's own private docker network, **no host port ever**. Local verification only — `provision.py` exits if you pair it with `target: vercel`, because reaching it from a Vercel function would mean `hostssl ... 0.0.0.0/0`. See `infra/vm/README.md`. | no, by design |

The secret NAMES an app declares now follow its provider (`infrastructure.secrets_derived`):
`neon` adds `DATABASE_URL_UNPOOLED`, `supabase` adds `SUPABASE_URL` + `SUPABASE_POSTGRES_URL_NON_POOLING`,
`self_hosted` adds `POSTGRES_ADMIN_URL`. Before this, every app declared `SUPABASE_URL` — a name that
exists nowhere in the mold codebase, which `provision.py` then required before it would deploy, so a
non-Supabase app could never pass the gate.
`infrastructure.secrets_user` follows the inference provider the same way (next section). A name is only worth
requiring if the deploy delivers it: on `target: vercel` the process running `model.ts` is the `<project>-api`
deployment and the only list `provision.py` syncs onto it is `API_ENV`, so intake reads that list and refuses a
provider whose secret is not in it, instead of writing state that passes `--check` and runs without its key.
Both providers' names are in `API_ENV` today, so nothing is refused; the check stays in place for the next
provider. `target: vm` starts no process, so nothing is forwarded there.

## Speech model (the microphone button)

The chat composer has a microphone button: a person speaks, a speech-to-text model on Cloudflare Workers AI turns it
into text, and the text lands in the message box to edit and send (the mold's dictation; no audio is kept). The
application developer picks the model per app, as they pick the chat's models; it is never a setting for the app's
users or workspace admins. `application.asr` (`.claude/scripts/lib/asr.py` holds the list, the prices and the rules):

| `asr.model` | Price per audio minute | Language | Source (read 2026-10-12) |
| --- | --- | --- | --- |
| `@cf/openai/whisper-large-v3-turbo` **(default, today's model)** | $0.000513 | any ISO 639-1 code, or detected | developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/ |
| `@cf/openai/whisper` | $0.000453 | none (always detected) | developers.cloudflare.com/workers-ai/models/whisper/ |
| `@cf/deepgram/nova-3` | $0.0052 (HTTP; the WebSocket price, $0.0092, is not used) | en, es, fr, de, hi, ru, pt, ja, it, nl, or detected | developers.cloudflare.com/workers-ai/models/nova-3/ |

`asr.language` is a two-letter code or `null` (the model detects it); `asr.enabled: false` removes the button. Absent,
each key is the mold's own default (its deployment profile's `asr`, with the app's packs' profiles). Intake writes the
block explicitly, so the choice is visible in state.

How it reaches the app: the same way as `model.roles` (`CLOUDFLARE_MODEL_<ROLE>`). Every deploy writes
`ASR_MODEL`, `ASR_LANGUAGE` (`auto` for detected) and `ASR_ENABLED` to the Vercel projects (`provision.py`) or the
server's env file (`lib/vm_remote.py`), and the mold's dictation route takes them over its profile. **Fail closed:** a
model off the list or a language the model cannot take is refused by `factory.py validate`; a choice other than the
mold's own on a mold that does not read `ASR_MODEL` yet is refused by validate and by the deploy itself, before
anything is written (refresh the mold, or set `asr` back to its values); and the mold turns dictation off rather than
call a model it cannot call or price. The usage report (`app_usage.py`) counts dictations apart from chat turns and
prices them per audio minute at the model each clip recorded.

## Inference providers

| `inference_provider` | `application.model` | `MODEL_PROVIDER` | `secrets_user` | forwarded to `<project>-api` (`API_ENV`) |
| --- | --- | --- | --- | --- |
| `cloudflare_workers_ai` **(default)** | `provider: cloudflare`, `model: @cf/zai-org/glm-5.2`, `context_window: 262144` (`factory.defaults.inference_model` overrides the id, for this provider only) | `cloudflare` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `RESEND_API_KEY`, `PLATFORM_NOTIFY_FROM` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |
| `vercel_ai_gateway` | `provider: gateway`, `model: anthropic/claude-sonnet-5`, no `context_window` (`model.ts` returns undefined in gateway mode and eve looks it up) | `gateway` | `AI_GATEWAY_API_KEY`, `RESEND_API_KEY`, `PLATFORM_NOTIFY_FROM` | `AI_GATEWAY_API_KEY`, plus the optional `GATEWAY_MODEL_ORCHESTRATOR`, `GATEWAY_MODEL_SPECIALIST`, `GATEWAY_REASONING_EFFORT` |

Plus `EXA_API_KEY` / `BROWSERBASE_API_KEY` in `secrets_user` when web search / the browser are on, for either
provider. `anthropic/claude-sonnet-5` is `agent/lib/model.ts`'s own default (lines 113-114): free-tier-safe, since the
gateway's free tier refuses Opus. The gateway branch reads no Cloudflare name, so a gateway app declares none. The
three `GATEWAY_*` names are optional and never asked for: set them on `<project>` by hand only to change the model
or the reasoning effort; absent, the mold defaults apply. Brief hints: `ai gateway` / `vercel's gateway` select the
gateway; `cloudflare workers ai` the default.

## mold_v0: platform administrators (`platform_admins`)

Who may open a mold_v0 app's admin console besides a company account's members (the shell's
`APP_PLATFORM_ADMINS`; the old `OCTILLION_PLATFORM_ADMINS` is still read). Without one nobody can reach `/admin`
and the operator is told the app is invite-only. Resolved from a brief line `Admins: you@example.com, *@example.com`,
else the app's own state, else asked (the operator's address, `defaults.operator_email`, is suggested). Each entry is
an address or `*@domain`, lowercased; anything else is refused. An app deployed before this question existed is not
asked here: `provision.py <app_id>` checks whether its target already holds the variable (by name) and asks only if
not. Written to `application.json` `platform_admins`; `provision.py` writes it at every deploy (`molds/mold_v0/mold.json`
`{platform_admins}`).

## mold_v0: the app's own profile settings (`## Profile`, `## Budgets`)

A mold_v0 app may set some of its build's profile fields from its own state (mold_v0-090): `limits`, the
platform's ceilings (`src/rate-limits.ts`: `mcp`, `endpoints`, `runs`, and `plans.<plan>` for one plan's own);
`member_keys` (mold_v0-099: `false` turns per-member API keys off, so clients connect by sign-in only); and
`source_offer.upstreams` (mold_v0-099: one of the app's packs whose pinned upstream is the app licensor's own project,
which the build then does not offer as source; `source_offer.app` stays the factory's `defaults.source_offer`). The
mold names what an app may set (`molds/mold_v0/branding/rules.json` `profile.app_settable`); the factory checks each
value as the build checks it (`.claude/scripts/lib/app_profile.py`, against the names in the shell's
`scripts/gen-packs.mjs` `LIMIT_KEYS`).

Write them in the brief, one setting per `limits.` path, in a section headed `## Profile` or `## Budgets`:

```
## Budgets (operator, 2026-10-22)
Per audit: US$40; per kind per company per month: US$500.
limits.runs.budget_usd_max = 40
limits.runs.kind_month_budget_usd = 500
limits.plans.pro.mcp.per_key_per_minute: 600
```

and, in a `## Profile` section (mold_v0-099), one per line:

```
member_keys = false
source_offer.upstreams.<pack id> = licensor_owned
```

`member_keys` is `true` or `false`; an upstream setting names one of the app's own packs (`Packs:`) and the word
`licensor_owned`, nothing else; the shell's generator refuses a pack that pins no upstream.

- The heading is exactly `## Profile` or `## Budgets` (a note in brackets after it is fine: `## Budgets (operator,
  2026-10-22)`); `## Budget history` or a `###` heading is not one.
- `=` or `:`; a value is a positive number (`40`, `12.5`; a `$` before it is allowed) that ends the clause: the end
  of the line, `,` `;` or `.` before a space, or ` (`. Anything else after it (`4 0`, `4e9`, `40k`, `40%`,
  `400 but we chose 40`, `1,000`) makes the setting unreadable, and it is refused. Settings in an HTML comment, struck
  through (`~~ ~~`) or in a code block are never applied. Other prose in the section is fine.
- Limits that count things (requests, runs) are whole numbers. Each spending and run limit has a ceiling the factory
  sets (`molds/mold_v0/branding/rules.json` `profile.app_limits_max`: today runs.budget_usd_max 200,
  runs.kind_month_budget_usd 2000, runs.concurrency_per_workspace 32, runs.live_per_workspace 200, a plan's own
  too); a value above it is refused, and raising a ceiling is a reviewed change to that file, never a brief edit.
- The brief is where they are set: intake writes `application.json` `profile` exactly from these lines on every run
  (`{"limits": {"runs": {"budget_usd_max": 40, "kind_month_budget_usd": 500}}}`), so a line taken out of the brief is
  taken out of state, and a value raised by hand in state goes back to the brief's at the next intake run
  (until then `factory.py validate` refuses state that is not what the brief says). A
  `limits.` setting outside those sections is ignored, and intake says so.

**The emails' sender and notifications** (mold_v0-101) are profile settings too, in the same sections:

```
## Profile
email_from_address = hello@yourcompany.com
email.notifications = access_requests, due_dates
email.pitch = {product} audits your applications against your regulators' controls.
```

- `email_from_address`: one address, on a domain the email provider (Resend) has verified. `email.notifications`: the
  groups the shell sends besides sign-in codes and invitations (`access_requests`, `library`, `usage`, `due_dates`,
  `billing`), or `none`. `email.provider = resend | none` is accepted too. `email.pitch`: the welcome email's sentence
  about the product (one line, up to 400 characters, `{product}` and the other words allowed); absent, the landing
  block's hero subheadline, else the tagline.
- Most briefs need neither line. An app that sets neither, and whose host pack's own profile sets neither, gets the
  factory's defaults in its build (`molds/mold_v0/branding/rules.json` `profile.email_defaults`): the sender
  `<app_id>@<notify_domain>` (this machine's `defaults.notify_domain` in `state/factory.local.json`) and
  `access_requests`, plus `due_dates` when one of its packs declares a record area with due dates. `packs.py apply`
  names them.
- On a machine with no `notify_domain`, a brief with no `email_from_address` gets one question, `email_from_address`
  (answer an address, or `later` to leave it unset: the app then sends from the shell's placeholder, which the provider
  refuses). The answer is kept in `application.json` `profile` and in `answers.json`, which `factory.py validate` reads
  beside the brief.
**The legal pages** (mold_v0-109): the company behind the app, which turns on its Terms of use (`/terms`) and Privacy
notice (`/privacy`) and the links to them on the landing page's footer, the sign-in pages and the install pages:

```
## Profile
legal.company_name = Acme Ltd
legal.contact_email = legal@acme.com
legal.jurisdiction = England and Wales
legal.effective_date = 2026-10-23
legal.terms_url = https://acme.com/terms
legal.privacy_url = https://acme.com/privacy
```

- `company_name` (the legal name) and `contact_email` (where people write about the terms and their data) are needed;
  `jurisdiction` (whose law governs the terms; absent, the pages do not say), `effective_date` (YYYY-MM-DD; absent,
  intake records the date it first saw this company and address, and keeps it) and the company's own pages
  (`terms_url`, `privacy_url`, https:// only: then that link wins and the shell's page redirects there) are optional.
  Plain text on one line, no brackets.
- A new app whose brief has no `legal.` lines gets one question, `legal`: answer the legal name and the address
  (`Acme Ltd, legal@acme.com`), or `later` to leave the app without legal pages. The answer is kept in
  `application.json` `profile.legal` and in `answers.json`, which `factory.py validate` reads beside the brief. An app
  already deployed is not stopped for it: add the lines to its brief and re-run intake to turn its pages on.
- The pages are the shell's neutral template in the app's own words (`molds/mold_v0/codebase/web/src/features/site/legal-text.ts`):
  a reasonable start, not legal advice. A company with its own reviewed terms sets `terms_url` and `privacy_url`.
- Refused, with nothing written: an unknown section or limit name, a value that is not a positive number, the same
  setting twice with two values, and any field the app may not set: the brand's words (`name`, `console_title`, …;
  `Brand:` lines and `branding.py` set them), `host_packs` (from `Packs:` and the mold's host-pack list), `source_offer.app`
  (the factory's `defaults.source_offer`), `billing`, `entitlements`, or anything else. A profile setting is never a
  secret: every value is a number, true or false, the word `licensor_owned`, an address or a line of the legal pages.
- A host pack that brings its own value for the same field (`host.profile.limits`) is refused at the build: the shell
  merges a host pack's profile at the top level, so the app's would replace it whole.
- Where it takes effect: `branding.py prepare` and `packs.py apply` write it into `build/<app_id>/profile.json` over the
  mold's own (a field the app does not set goes back to the mold's), the shell's generator checks it again and
  compiles it, and `packs.py verify` checks the copy carries it. A deploy makes the copy afresh, so a change applies
  at the app's next deploy (which, as always, needs the operator's yes). The lane copies keep the mold's defaults.
  The server's environment (`OCTILLION_LIMIT_<SECTION>_<NAME>`) still wins over the profile; a pack's job kinds are
  clamped to these ceilings, never above them.
- mold_v1 takes no profile settings: a brief with them for a mold_v1 app is refused.

## mold_v0: the brief's pack sections

A new mold_v0 app is **a brief + a generated pack.json + a brand** (mold_v0-062). Besides the lines every mold_v0 brief
has (`Mold: mold_v0`, where it runs, `Domain:`, `Product name:`, `Brand:`, `Brand colour:`), a brief may declare the
app's own pack in the `## ` sections below. `intake.py` turns them, deterministically and with no model call
(`.claude/scripts/lib/brief_pack.py`), into:

- `packs/<pack_id>/files/packs/<pack_id>/pack.json`: the shell's declarative pack, checked against
  `molds/mold_v0/codebase/packs/pack.schema.json` (a Python check of the subset of JSON Schema it uses), the
  cross-checks the shell's build makes (areas, references, lifecycles, permissions, metrics against their areas,
  charts against their metrics' shapes, tabs, schedules, credentials, onboarding), and the codebase's own zod check
  when its `node_modules` are installed; then `packs.py check <pack_id> --mold mold_v0`;
- `packs/<pack_id>/pack.json`: the factory's manifest, with an `intake` record (the brief and its hash, the hash of
  the pack.json intake wrote, the answers, the defaults it applied);
- `application.json` `packs: [<pack_id>]`.

`Pack: <id>` names the pack (the whole value must be `^[a-z][a-z0-9_]{1,30}$`, also its table prefix; anything else is refused, never shortened); without it the app id is the pack id. A `packs/<id>/` that already holds files intake did not write (no manifest, or a manifest without an `intake` record, or one made for another app) is refused.
Only those section names are read (any other `## ` heading is prose), and their text is never read for the prose
hints above: a field labelled "Vercel project" does not move the app to Vercel. Inside a section, only `### ` entries
and `- ` bullets; anything else is an error with its line number. `|` separates the parts of a line (`\|` for a
literal one). Names are lowercase letters, digits and `_` (2 to 63); tab ids use `-`.

| Section | Each entry |
|---|---|
| `## Records` | `### <area>: <Label>`, then bullets: `role: source\|check\|asset`, `scope: workspace\|platform`, `description: …`, `field <name>: <Label> \| <type> \| required \| multiple \| help <text>`, `columns: a, b`, `lifecycle: <enum field>`, `initial: <state>`, `transition: <from>, <from> -> <to> \| <Label> \| roles owner` (from may be `*`), `due: <date field> within 7 days \| notify owner`, `sealed: yes\|no`, `who can read\|create\|update\|move\|delete: member, owner` |
| `## Metrics` | `- <name>: <Label> \| count <area>` (or `sum <area>.<field>`, `average <area>.<field>`, `rate <area>`, `duration <area>`; `<area>` may be `run_results` or `runs`), then any of `\| where <field> in a, b and <field> < today`, `\| matching <conditions>` (a rate's numerator), `\| group by <field>`, `\| group by due <date field> soon 7`, `\| per week of created last 8` (day, week or month; `created`, `updated`, a date field or `state:<state>`), `\| from created to state:fixed as median in days`, `\| limit 10`, `\| unit usd`, `\| roles owner` |
| `## Charts` | `- <name>: <Title> \| number\|bar\|stacked_bar\|line\|area\|table \| <metric>, <metric> \| ordinal` |
| `## Tabs` | `- <id>: <Label> \| <kind> [<area or page>] \| icon shield \| group Audit \| views table, board, timeline, detail \| board by <field> \| timeline by <field> \| charts a, b \| roles owner, billing` (kinds: overview, area, runs, reports, credentials, usage, schedules, notices, setup, billing, profile, page) |
| `## Jobs` (or `## Audits`) | `### <kind>: <Label>`, then: `repository: https://…`, `commit: <full 40-character id>`, `command: node audit.mjs --app {app}` (an argument list, never a shell line), `arg <name>: <Label> \| <type> \| required \| from scope.app \| pattern … \| default …`, `validate: node validate.mjs`, `setup: npm ci`, `write back: findings`, `results: out/results.json`, `record: sessions/*.json`, `strip: .claude/settings.local.json`, `env NAME: {gateway.token}`, `credentials: a, b`, `egress: api.example.com`, `providers: anthropic`, `timeout: 20 minutes`, `token lifetime: 1 hour`, `budget: 2`, `month budget: 50`, `concurrency: 2`, `attempts: 3`, `on unresolved: reject\|drop\|downgrade`. Jobs run on the built-in agent-workspace runner; a program of the pack's own (workspace-harness) is code, written by hand. |
| `## Credentials` | `- <name>: <Label> \| workspace` (or `asset <area>`, `environment <asset area> [prod, staging]`) `\| env NAME` (or `file <name>`) `\| help …` |
| `## Schedules` | `- <name>: <Label> \| <job> \| 0 3 * * * \| over <asset area> [keys a, b] \| environment prod \| off` (cron in UTC, at most every 5 minutes) |
| `## Onboarding` | `- <id>: <Label> \| record <area>` (or `run <job>`, `credential <name>`, `tool <name>`, `connected`, `first call`, `workspace`) `\| help …` |
| `## Words` | `- run: audit` (the shell's word on the left) |
| `## MCP` | pack.json `mcp` (mold_v0-060): `- prefix: vd`, `- include: <tool>, <tool>`, `- exclude: <tool>`, `- admin only: <tool>` (moved to the staff MCP), `- rename <tool>: <new name>`, `- describe <tool>: <one paragraph>`. Tools are the generated ones (`<prefix>_list_<area>`, `_get_`, `_export_` (mold_v0-108: the area as CSV), `_create_`, `_update_`, `_move_`, `_get_metrics`, `_start_<job>`, the run tools named by `## Words`' run, and staff `_admin_*` tools for shared areas); a name may be written without the prefix. Without the section every generated tool is served under the pack id's prefix, and the server is named by the brand. |

Field types: `text [max 500]`, `number [0..10]`, `date`, `boolean`, `json`, `link`, `person`, `file`,
`enum low, high` or `enum open=Open, wont_fix=Won't fix` (values: letters, digits, spaces and `_ . : / ( ) & -`),
`reference <area>`.

**Asked, never guessed** (questions.json, with options and a suggested answer; the intake subagent asks them):
a missing `## Records`, `## Jobs`, `## Credentials` or `## Schedules` (confirm none), `## Tabs`, `## Charts` (with
no `## Metrics` either) or `## Onboarding` (generated from the declarations, or none); an area's `role` and `scope`
(an asset is always a workspace's own: the platform has no shared asset area); a field's or a job argument's type; a lifecycle with no
transitions (free, or none); a job's repository, commit, command, validate command and write back (no default: a pin
is never guessed, and a commit given for one repository is asked again when the brief names another); what a credential belongs to; the brand name when the brief, the product and the app have none.
Answers are recorded with the pack, so a re-run asks nothing again.

**Defaults that change no permission** follow these rules and are printed (`default: …`) and recorded
(`intake.defaults`): a label from its name; a lifecycle starts in its field's first option; a job argument comes from
the run's `scope.<name>`; a credential reaches a run as the variable of its name in capitals; an area's permissions
are the platform's defaults (read: every role; write: the roles with edit) unless the brief narrows them; `## Metrics`
without `## Charts` draws each metric by its shape; a job's results name the pack's check areas (`run_results`);
version 0.1.0; a job runs on the built-in agent-workspace runner. An answer is one plain line: it sets the one thing asked, never anything else.

**MCP checks** (src/mcp-catalog.ts's, ported): every tool named must be one the pack generates; a final name is at most 64 lowercase letters, digits and `_`; two tools may not end up with one name on the same MCP server; `admin only` cannot name a tool already on the staff MCP; a description is plain text (no `<` `>`, no control, zero-width or direction characters, at most 1000 characters); a job argument may not be named `target_asset` or `target_environment` where the start tool uses them. Not ported: clashes with the shell's own tool names and with other packs' (the build checks them).

**Refused, with the brief's line:** a viewer that writes or moves; a shared (platform) area anyone but staff writes;
an unknown role; a branch, tag or short id as a commit; a repository that is not `https://`; the shell's own run
variables (`PATH`, `HOME`, `RUN_*`, proxies, `NODE_OPTIONS`, `LD_*`), as a job's `env` or a credential's variable (its default name included); a control or text-direction character; a
second copy of a section.

**Re-runs and edits.** The same brief gives the same bytes, and an unchanged file is not rewritten. intake rewrites
only the pack.json it wrote itself: when the file's sha256 is not the one it recorded, it asks `pack.overwrite.<hash>`
(keep, the default: the brief's version goes to `packs/<pack_id>/pack.draft.json`, outside what is applied; or
replace). The answer holds for that edit only. A pack intake did not make (no `intake` record, such as a pack with
code) is never touched.

A short example, the shape of a vulnerability desk (the full one is in `.claude/scripts/lib/brief_pack_selftest.py`):

```
Mold: mold_v0
It runs on its own server.
Domain: vulns.example.org
Brand: Vuln Desk
Pack: vuln_desk

## Records
### audit_apps: Applications
- role: asset
- field url: Address | text | required

### audit_findings: Vulnerabilities
- role: check
- scope: workspace
- field severity: Severity | enum low, medium, high, critical | required
- field state: State | enum open, fixed, accepted
- field app: Application | reference audit_apps | required
- lifecycle: state
- transition: open -> fixed | Mark fixed
- transition: open -> accepted | Accept the risk | roles owner

## Metrics
- open_by_severity: Open by severity | count audit_findings | where state = open | group by severity

## Charts
- severity: Open by severity | bar | open_by_severity

## Jobs
### audit_scan: Audit an application
- repository: https://git.example.com/agents/audit-agent.git
- commit: 0123456789abcdef0123456789abcdef01234567
- arg app: Application | reference audit_apps | required
- command: node audit.mjs --app {app}
- validate: node validate.mjs
- write back: findings
- credentials: audit_token

## Credentials
- audit_token: Application token | asset audit_apps | env AUDIT_TOKEN
```

Without `## Tabs`, `## Schedules` or `## Onboarding` this asks three questions (generated tabs, no schedules,
generated onboarding are the suggested answers).

## What intake decides without asking

| Field | Rule |
| --- | --- |
| `datastores.postgres.rls` | follows tenancy, it is not a constant: `fail_closed` for a multi-workspace app, `on` for a single-workspace one. It used to be the literal `fail_closed` in every app — a claim nothing measured, beside a deployment that ran as a BYPASSRLS superuser. `provision.py` now has to prove it before the deploy finishes, and the proof is recorded in `datastores.postgres.rls_verified`. |
| `datastores.postgres.admin_url_ref` | the provider's own DDL endpoint name (`DATABASE_URL_UNPOOLED`, `SUPABASE_POSTGRES_URL_NON_POOLING`, `POSTGRES_ADMIN_URL`). Never `DATABASE_URL`: after the bootstrap that is `app_rw`, which owns nothing. |
| `datastores.postgres.pooling` | `transaction` for neon (the pooled endpoint at runtime, the direct one for migrations). |
| `network` / `host` / `port` / `database` / `exposure` | filled for `self_hosted` only: the app's own `sf-<app_id>` docker network, alias `db`, port 6543 inside the container, `private_docker_network`. |

## After intake

```
python3 .claude/scripts/provision.py <app>                  # read-only check: what exists, what a deploy will create, secrets by name (vm: regenerates the local artifact)
python3 .claude/scripts/provision.py <app> --set-secret NAME  # one credential at a hidden prompt; creates the three empty projects if absent, and says so first
python3 .claude/scripts/provision.py <app> --deploy         # vercel; prints "about to create:", refuses if a secret is missing, else creates the datastores and proves app_rw + RLS before DATABASE_URL is written
python3 .claude/scripts/provision.py <app> --verify-db      # vercel: creates projects + datastores and bootstraps the database (a writer); self_hosted / vm: bring the private Postgres up and run the whole chain
python3 .claude/scripts/provision.py <app> --verify-rls     # re-prove isolation on whatever is running now
python3 .claude/scripts/lanes.py <app>                      # the five lanes; a failure reverts the app and files a task
```

`--verify-db` is the local path for `self_hosted`: `.claude/scripts/lib/localpg.py` runs `postgres:17` on the
app's own docker network with TLS and **no published host port**, so nothing this factory builds ever opens
Postgres to the internet. It is a verification target, not a deploy target — pairing `self_hosted` with
`target: vercel` is refused with one sentence naming `postgres_provider=neon` as the fix.

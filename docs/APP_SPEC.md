# App specs: one JSON file per app, checked in your editor

An **app spec** describes one application completely, as a single JSON file: the product (name, colour, logo, domain),
where it runs, who runs it, its budgets and profile settings, its packs (for mold_v0, a pack inline or by path), the keys
its runs need (names only), its `kind` and its audit trails. Each mold has its own schema, so the editor tells you what
that mold needs and what it does not support:

| Mold | Schema (use as `$schema`) |
|---|---|
| mold_v0 | `https://raw.githubusercontent.com/never2average/software-factory/main/schemas/mold_v0.app.schema.json` |
| mold_v1 | `https://raw.githubusercontent.com/never2average/software-factory/main/schemas/mold_v1.app.schema.json` |

Examples that pass: [`schemas/examples/`](../schemas/examples/) (every address is at example.com).

## In VS Code

Put the schema's address on the first line of the file, as `$schema`:

```json
{
  "$schema": "https://raw.githubusercontent.com/never2average/software-factory/main/schemas/mold_v0.app.schema.json",
  "app_id": "acme_desk",
  "mold_id": "mold_v0"
}
```

VS Code downloads it (Settings: `json.schemaDownload.enable` must be on, the default) and then underlines what is
missing or not supported, completes field names and values, and explains each field when you hover over it. To work
offline, or to try a schema before it is on `main`, map files to the copy in your checkout instead
(`.vscode/settings.json`):

```json
{
  "json.schemas": [
    { "fileMatch": ["*.mold_v0.app.json"], "url": "./schemas/mold_v0.app.schema.json" },
    { "fileMatch": ["*.mold_v1.app.json"], "url": "./schemas/mold_v1.app.schema.json" }
  ]
}
```

What the editor cannot see, the factory checks: a pack named by id or path is loaded and checked like an inline one, the
logo file must be on this machine, each job kind's own budget must fit under the app's budgets, and the profile goes
through the same check `factory.py validate` and the build use.

## Completeness rules (beyond required fields)

- `kind` is `tool` (default) or `embedded`. **embedded** needs `developer_surface` (events it emits, SDK languages, client
  sessions, optional inbound receivers `webhooks_in` and `api_version`) and `audit.platform: true`. mold_v0 builds it
  (mold_v0-193: the REST API at `/v1`, `/openapi.json`, scoped keys, client sessions, Standard Webhooks out and in, the
  generated SDKs; molds/mold_v0/MOLD.md "Developer surface"): the spec check refuses an event or SDK language the mold
  does not have, and `mint.py new --spec` writes the block into the app's first inline pack (so an embedded mold_v0 app
  gives at least one pack inline). mold_v1 records it only.
- `audit.data` and `audit.platform` are separate toggles, both default `false` (mold_v0-197: mold_v0 writes them to the app's `profile.audit`; usage metering
  stays on regardless).
- `audit.sign` (default `false`; mold_v0-195): signed checkpoints of the hash-chained trail entries (Ed25519 over Merkle roots, hourly
  when there are new entries), written to `profile.audit.sign` (brief line `audit.sign = true`); the app needs `APP_LEDGER_SIGNING_KEY` in its
  environment (`provision.py <app> --set-secret APP_LEDGER_SIGNING_KEY`; `npm run ledger:keygen -- --out <file>` makes one).
- `profile.onprem_runners` (mold_v0-205; default `false`): `true` lets the app's workspaces install an on-premises runner
  for its kinds with `private_network: true` (molds/mold_v0/MOLD.md "On-premises runners"); off, no runner route, page,
  tab or enrolment exists and every run is hosted. Brief line `onprem_runners = true` in `## Profile`.
- `features` (mold_v0-219): one on/off flag per optional mold_v0 capability, `{"<flag>": true|false}`, each with its
  default and documentation in `molds/mold_v0/codebase/src/features.json` (the editor shows them on hover). A capability
  is **on** when something asks for it (a pack's declaration; the audit toggles always) **and** its flag is not `false`:

  | Flag | Default | Asked for by | Board name |
  |---|---|---|---|
  | `customer_key_vault` | true | a pack's credential fields | vault |
  | `company_email` | true | a pack's `email` block | email |
  | `scheduled_alerts` | true | a due-date area, or clocks | alerts |
  | `record_clocks` | true | a workspace area's `clocks` | clocks |
  | `audit.data` | false | always (legacy `audit.data`) | audit.data |
  | `audit.platform` | false | always (legacy `audit.platform`) | audit.platform |
  | `audit.sign` | false | always (legacy `audit.sign`); needs `audit.data` or `audit.platform` | audit.sign |
  | `onprem_runners` | false | a kind with `private_network: true` (legacy `profile.onprem_runners`) | runners |
  | `developer_surface` | true | `kind: embedded` with its `developer_surface` block; needs `audit.platform` | developer |
  | `declarative_checks` | true | a pack's `checks` | checks |
  | `encrypted_fields` | true | an `encrypted: true` field (false while one is declared is refused) | encrypted |
  | `health_history` | true | a build without the session engine | health |
  | `document_preview` | true | a `file` field, or `preview: "document"` | documents |

  Written to the app's `profile.features`; in a brief, `features.<flag> = true|false` lines in `## Profile`. A legacy key
  (the spec's `audit` block, `profile.onprem_runners`) still works and must agree with its flag. **`kind` stays the
  developer surface's switch**: `kind: embedded` with a `developer_surface` block asks for it, and the flag may only
  repeat what `kind` says (true with `tool`, or false with `embedded`, is refused). `customer_key_vault: false` is refused
  while a job kind needs a credential that is not optional. `factory.py spec check` prints the effective flags
  (`flags: vault, email, alerts, clocks, audit.data, runners, health`), `factory.py spec apps` each app's, and the factory
  board shows them on each mold_v0 app's line.
- A record area's field may be `encrypted: true` (mold_v0-194: workspace areas stored in the shell's tables; text, number,
  date, boolean, json or enum), with `reveal_roles` (who may reveal it; default the roles that may update the area) and
  `searchable: "equality"` (a keyed blind index for equality filters only); brief line `field <name>: <Label> | text |
  encrypted | searchable | reveal owner`. The pack schema refuses it elsewhere; molds/mold_v0/MOLD.md "Encrypted fields".
- **Records** (mold_v0-222; [RECORDS.md](RECORDS.md)): every record area of every mold_v0 pack has a contract (its
  provenance, who may read, create, update, move, delete, reveal, export and import, its list's primary action or why it
  has none). A pack may declare it (`record_areas[].contract`); `spec check` holds a declared one to what the build does
  and derives it for an area that declares none, which is then incomplete only when nothing writes its rows or its list
  tab has no primary action and no reason. `spec check <file> --records` prints each area's contract.
- mold_v0: a pack with job kinds needs `budgets.runs` and `run_keys`; agent job kinds (runner `agent-workspace`) need an
  agent source (repository + commit), `run_keys.model` (`anthropic` or `vertex`) and `run_keys.object_storage`; on
  Vercel, `run_keys.sandbox` (`boat`). `compose_remote` needs `product.domain`. At least one platform administrator.
- mold_v1: `vm_remote` needs `deploy.server` and `product.domain`; budgets, profile and run keys are not supported.

## Commands

```
python3 .claude/scripts/factory.py spec check <file> [--json] [--records]   # complete? exit 0 yes, 1 no (each problem in plain words), 2 could not check
python3 .claude/scripts/mint.py new <app_id> --spec <file>      # mint from it (the same state the brief path writes)
python3 .claude/scripts/factory.py spec apps [--json]           # every app's state read as a spec: what each still lacks (read-only)
python3 .claude/scripts/factory.py spec generate [--check]      # regenerate the schemas
```

`mint.py new --spec` writes `briefs/<app_id>.md` from the spec (kept beside it as `briefs/<app_id>.spec.json`), reads it
back with intake's own parser to prove the brief says exactly what the spec says, writes an inline mold_v0 pack to
`packs/<id>/`, then follows the brief path unchanged. The brief path (`--brief`) keeps working as before.

## The schemas are generated, never edited

`.claude/scripts/app_spec.py generate` builds them from what the molds and the factory already hold: mold_v0's
`mold.json` (targets, pack id, what it does not need), `branding/rules.json` (profile fields an app may set, budget
ceilings), `codebase/packs/pack.schema.json` (embedded whole, so an inline pack is checked against the mold's own pack
schema), the shell's limit names and notification groups; mold_v1's branding rules, `packs.py`'s pack id and intake's
inference providers; and the shared `state/application/app_id/*.schema.json`. `factory.py validate` fails when a
committed schema is not what generation gives now, so a mold change and its schema land together.

# software-factory (rehearsal copy)

Turn a one-page description into a tested, deployed, multi-workspace AI agent app. Ask in plain words:

- "Mint an app called `my_app` from `briefs/my_app.md`."
- "Where does `my_app` stand?"
- "Run the tests on `my_app`."
- "What's next on the backlog?"

Stations, in order: brief, state, packs, brand, keys, deploy, workspaces, tests, package, address. The line stops
only when it needs the operator: a credential (typed at a hidden prompt), a one-time sign-in code, or a DNS record.

| Folder | What's in it |
|---|---|
| `molds/mold_v1/` | the mold (a tiny stand-in here) and its five test lanes |
| `state/` | `factory.json`, `products.json`, `tasks/` (the backlog), `application/<app_id>/` (each app's four state files) |
| `briefs/` | one page per app |
| `.claude/scripts/` | `mint.py`, `intake.py`, `provision.py`, `lanes.py`, `factory.py` |
| `.claude/skills/` | how each job is done |

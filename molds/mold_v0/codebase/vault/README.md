# Vault format

Octillion pulls **developer profiles** and **tasks** from the vault with `npm run vault:sync`.

- `VAULT_URL` (+ `VAULT_TOKEN`): `GET {VAULT_URL}/profiles` and `GET {VAULT_URL}/tasks` return a JSON array, or `{items|data|results: [...]}`.
- `VAULT_DIR`: `profiles.json` / `tasks.json` (arrays), or the same names with `.jsonl`.

`example/` is a format example only; it is not the curated library.

**Profile:** `{id, slug?, name, summary?, instructions?, attributes?: {role, experience_years, company_size, stack[], constraints[], tone, ...}}`.
The orchestrator role-plays the profile when a sub-agent asks a question. `instructions` tells it how this developer answers.
A profile must never mention a customer's product.

**Task:** `{id, slug?, title, prompt, repo_url?, language?, category?, tags?[], attributes?}`. Customers turn tasks
into scenarios for their product (`save_scenarios` with `library_task_id`).

Unknown fields are kept in `attributes`. Records that disappear from the vault are deactivated, not deleted.

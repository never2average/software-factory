// Pull developer profiles and the task library from the vault into Postgres.
//   VAULT_URL=https://vault.internal VAULT_TOKEN=... npm run vault:sync
//   VAULT_DIR=vault/example npm run vault:sync
import { getDb } from "../src/db.js";
import { syncVault } from "../src/vault.js";

const r = await syncVault();
console.log(`Vault synced: ${r.profiles} profiles, ${r.tasks} tasks (retired ${r.retired_profiles} profiles, ${r.retired_tasks} tasks no longer in the vault;`
  + ` kept ${r.kept_profiles} profiles, ${r.kept_tasks} tasks edited on /admin or private).`);
await (await getDb()).close();

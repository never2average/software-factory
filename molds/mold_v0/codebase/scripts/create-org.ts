// Create an organization and print its API key and connector URL. The key is shown once.
//   npm run org:create -- "Acme Inc" [slug]
//   npm run org:create -- --key <slug> [label]     (add another key to an existing org)
import { createApiKey, createOrg } from "../src/auth.js";
import { getDb } from "../src/db.js";

const args = process.argv.slice(2);
const base = (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");
const db = await getDb();
let name: string, key: string;
if (args[0] === "--key") {
  const [org] = await db.query<{ id: number; name: string }>("SELECT id, name FROM organizations WHERE slug = $1", [args[1]]);
  if (!org) throw new Error(`No organization ${args[1]}`);
  name = org.name;
  key = await createApiKey(org.id, args[2] ?? "extra");
} else {
  if (!args[0]) throw new Error('Usage: npm run org:create -- "Company name" [slug]');
  const created = await createOrg(args[0], args[1]);
  name = created.org.name;
  key = created.key;
}
console.log(`Organization: ${name}
API key (shown once): ${key}

Connector URL for Claude (Settings > Connectors > Add custom connector) and ChatGPT (developer mode):
  ${base}/mcp/${key}
Or: POST ${base}/mcp with header  Authorization: Bearer ${key}`);
await db.close();

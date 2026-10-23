import "./hosts.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { resolveKey } from "./auth.js";
import { getDb } from "./db.js";
import { PROFILE } from "./profile.js";
import { ENV } from "./env-names.js";

// Local hosts (Claude Code, Cursor, ...) run this over stdio; the org comes from APP_API_KEY.
const db = await getDb();
const org = await resolveKey(ENV.APP_API_KEY);
if (!org) {
  console.error('Set APP_API_KEY to an organization\'s API key (create one with `npm run org:create -- "Acme"`).');
  process.exit(1);
}
await createServer(org).connect(new StdioServerTransport());
console.error(`${PROFILE.mcp_server_name} ready on stdio for ${org.name} (${db.kind})`);

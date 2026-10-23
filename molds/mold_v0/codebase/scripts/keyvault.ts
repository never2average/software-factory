// Key vault admin CLI. Secrets are read from stdin (or --from-env / --from-file), never from argv, so they stay
// out of shell history and process listings.
//   npm run keyvault -- gen-master-key
//   npm run keyvault -- providers
//   printf %s "$ANTHROPIC_KEY" | npm run keyvault -- set anthropic [--label main] [--priority 10]
//   npm run keyvault -- set boat --from-file /secure/boat.env      (KEY=value files: the value is used)
//   npm run keyvault -- list | disable <id> | enable <id> | delete <id> | rekey | usage
//   npm run keyvault -- provider <slug> --mode gateway --upstream https://... --header x-api-key --prefix "" --env FOO_API_KEY
//   npm run keyvault -- provider anthropic --backend vertex --vertex-project my-gcp-project [--vertex-region global]
//   npm run keyvault -- set anthropic --label vertex < service-account.json     (the Vertex credential)
//   npm run keyvault -- provider anthropic --backend direct                     (back to api.anthropic.com)
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getDb } from "../src/db.js";
import * as kv from "../src/keyvault.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const readStdin = async () => { let s = ""; for await (const c of process.stdin) s += c; return s; };

async function secretInput(): Promise<string> {
  const env = flag("from-env");
  if (env) return process.env[env] ?? (() => { throw new Error(`${env} is not set`); })();
  const file = flag("from-file");
  if (file) {
    const text = readFileSync(file, "utf8").trim();
    const kvLine = text.split("\n").find((l) => /^[A-Z0-9_]+=/.test(l));
    return kvLine ? kvLine.slice(kvLine.indexOf("=") + 1).trim() : text;
  }
  if (process.stdin.isTTY) throw new Error("Pipe the secret on stdin, or use --from-env VAR / --from-file PATH");
  const text = (await readStdin()).trim();
  const kvLine = text.split("\n").find((l) => /^[A-Z0-9_]+=/.test(l));
  return kvLine ? kvLine.slice(kvLine.indexOf("=") + 1).trim() : text;
}

async function main() {
  switch (cmd) {
    case "gen-master-key":
      console.log(randomBytes(32).toString("base64"));
      console.error("Store this as APP_VAULT_KEY in your secret manager. Losing it makes the vault unreadable.");
      return;
    case "providers":
      console.table((await kv.listProviders()).map((p) => ({ ...p, env_vars: p.env_vars.join(",") })));
      return;
    case "provider": {
      const env = flag("env");
      console.log(await kv.upsertProvider({
        slug: rest[0], mode: flag("mode") as "gateway" | "direct" | undefined, upstream_url: flag("upstream"),
        auth_header: flag("header"), auth_prefix: flag("prefix"), env_vars: env ? env.split(",") : undefined,
        backend: flag("backend") as "direct" | "vertex" | undefined,
        enabled: rest.includes("--enable") ? true : rest.includes("--disable") ? false : undefined,
        backend_config: flag("vertex-project") ? { project_id: flag("vertex-project"), region: flag("vertex-region") ?? "global" } : undefined,
      }));
      return;
    }
    case "set": {
      if (!rest[0]) throw new Error("Usage: keyvault set <provider> [--label L] [--priority N] < secret");
      const r = await kv.setCredential(rest[0], await secretInput(), { label: flag("label"), priority: flag("priority") ? Number(flag("priority")) : undefined });
      console.log(`Stored ${r.provider}/${r.label} (${r.hint}) as credential #${r.id}.`);
      return;
    }
    case "list":
      console.table(await kv.listCredentials());
      return;
    case "disable": case "enable":
      await kv.setCredentialEnabled(Number(rest[0]), cmd === "enable");
      console.log(`Credential #${rest[0]} ${cmd}d.`);
      return;
    case "delete":
      await kv.deleteCredential(Number(rest[0]));
      console.log(`Credential #${rest[0]} deleted.`);
      return;
    case "rekey":
      console.log(`Re-encrypted ${await kv.rekey()} credentials with the current master key.`);
      return;
    case "usage":
      console.table(await (await getDb()).query(
        `SELECT provider, coalesce(session_id, orchestrator_id) AS consumer, requests, errors, input_tokens, output_tokens, last_at
           FROM gateway_usage ORDER BY last_at DESC LIMIT 50`));
      return;
    default:
      throw new Error("Commands: gen-master-key, providers, provider, set, list, enable, disable, delete, rekey, usage");
  }
}

try { await main(); }
finally { await (await getDb()).close(); }

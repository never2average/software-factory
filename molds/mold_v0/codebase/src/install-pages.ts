/**
 * Install pages (mold_v0-060): how to connect each MCP client to this product, generated from the profile (the product's
 * name, the MCP server's name) and the deployed address, for every client src/connect-catalog.ts lists (Claude,
 * ChatGPT, Claude Code, Cursor, VS Code, Codex, Gemini CLI and the rest). Public and static: no session, no account.
 *
 *   GET /install              every client, by group
 *   GET /install/:client      one client: sign in (OAuth) first; then, for clients that can send a header, the same
 *                             with an API key in an Authorization header. A key never goes in a URL, and these pages
 *                             never hold one: the header shows a placeholder the person replaces with their own key.
 *   GET /install.json         the same, as data
 *   GET /install/tools        the tool reference (mold_v0-010): every tool the packs add to the customer MCP, per
 *   GET /install/tools.json   pack, with its description, its input schema and the roles that may call it, generated
 *                             from the pack registry (src/mcp-tools.ts) in the packs' and the profile's words. Never a
 *                             tool a pack excluded or moved to the admin MCP, nor a staff tool. With no pack tool these
 *                             two are not mounted and the pages above are byte for byte what they were.
 *
 * The profile's `install_clients` (optional) narrows the clients to those it names. A signed-in member's own setup,
 * with their new key in each client's header (never a URL), is memberSetup below (the console's API keys page,
 * src/member-keys.ts).
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { ACCOUNT_ROLE_LABELS, ACCOUNT_ROLES, canAccount, type AccountRole } from "./account-roles.js";
import { clerkEnabled, frontendApi } from "./clerk.js";
import { clientCatalog, type ClientEntry } from "./connect-catalog.js";
import { plain } from "./mcp-catalog.js";
import { generatedTools, permitted } from "./mcp-tools.js";
import { packs } from "./packs.js";
import { PROFILE, type Profile } from "./profile.js";

/** What the key placeholder reads as in a header: never a key, never in a URL. */
export const KEY_PLACEHOLDER = "<your API key>";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const GROUPS: Record<ClientEntry["group"], string> = { chat: "Chat apps", agent: "Coding agents", editor: "Editors" };

/** The clients this build offers: the profile's install_clients, else every client (the "header" entry always). */
const offered = (p: Pick<Profile, "install_clients">) => (c: { id: string }) => !p.install_clients || c.id === "header" || p.install_clients.includes(c.id);

/** The install guide for one deployed address: every client, with sign-in and (where a client takes one) a header key. */
export function installGuide(publicUrl: string, profile: Pick<Profile, "install_clients"> = PROFILE) {
  const url = `${publicUrl.replace(/\/$/, "")}/mcp`;
  const signInAvailable = Boolean(clerkEnabled() && frontendApi());
  const withKey = new Map(clientCatalog(url, KEY_PLACEHOLDER, { signInAvailable }).map((c) => [c.id, c]));
  const clients = clientCatalog(url, undefined, { signInAvailable }).filter(offered(profile)).map((c) => {
    const k = withKey.get(c.id);
    // The key variant only where the client sends it as a header (its own command or config), never as a URL.
    const header = k && (k.command || k.snippet) && !(k.install_url) ? { steps: k.steps, command: k.command ?? null, file: k.file ?? null, snippet: k.snippet ?? null } : null;
    return { id: c.id, client: c.client, group: c.group, verified: c.verified,
      sign_in: signInAvailable ? { steps: c.steps, command: c.command ?? null, file: c.file ?? null, snippet: c.snippet ?? null, install_url: c.install_url ?? null } : null,
      api_key: header };
  });
  return { name: PROFILE.name, server: PROFILE.mcp_server_name, url, sign_in: signInAvailable, clients,
    // Only when the packs add tools (mold_v0-010): absent, the guide is exactly what it was.
    ...(toolReference().packs.length ? { tool_reference: "/install/tools" } : {}) };
}

/**
 * A signed-in member's own setup with the key they just made (mold_v0-007, 010): for each client the profile offers,
 * how it authenticates (`token`: the key in a header, the exact command or config with the key in it; `oauth`: the
 * client cannot send a header and signs in instead) and what to paste. The key is never put in a URL, a one-click
 * link or anything a client sends as an address; this is answered once, to that member, with the key.
 */
export function memberSetup(publicUrl: string, key: string, profile: Pick<Profile, "install_clients"> = PROFILE) {
  const url = `${publicUrl.replace(/\/$/, "")}/mcp`;
  const signInAvailable = Boolean(clerkEnabled() && frontendApi());
  const plainEntries = new Map(clientCatalog(url, undefined, { signInAvailable }).map((c) => [c.id, c]));
  const clients = clientCatalog(url, key, { signInAvailable }).filter(offered(profile)).map((c) => {
    const header = Boolean((c.command || c.snippet) && !c.install_url);
    const signIn = plainEntries.get(c.id);
    return header
      ? { id: c.id, client: c.client, group: c.group, auth: "token" as const, steps: c.steps, command: c.command ?? null, file: c.file ?? null, snippet: c.snippet ?? null, verified: c.verified }
      : { id: c.id, client: c.client, group: c.group, auth: "oauth" as const, steps: signInAvailable && signIn ? signIn.steps : c.steps, command: null, file: null, snippet: null, verified: c.verified };
  });
  return { name: PROFILE.name, server: PROFILE.mcp_server_name, url, sign_in: signInAvailable, clients };
}

// ---------- the tool reference (mold_v0-010) ----------

/** One tool as the reference shows it. */
export interface ToolDoc { name: string; title: string | null; description: string; read_only: boolean; roles: AccountRole[]; role_labels: string[]; input_schema: unknown }

const schemaOf = (shape: z.ZodRawShape | undefined) => {
  try { return z.toJSONSchema(z.object(shape ?? {}), { unrepresentable: "any" }); } catch { return { type: "object" }; }
};

/**
 * Every tool the build's packs add to the customer MCP, per pack, generated from the pack registry: the tools generated
 * from their declarations that stay on the customer MCP (src/mcp-catalog.ts: never an excluded, admin_only or staff
 * tool) and their own hand-written tools; each with the roles that may call it (the same check the server makes when
 * it offers and runs it). Deterministic; empty with zero packs.
 */
export function toolReference() {
  const out: { id: string; name: string; tools: ToolDoc[] }[] = [];
  const generated = generatedTools().filter((t) => t.door === "workspace" && !t.admin_only);
  for (const p of packs()) {
    const tools: ToolDoc[] = [];
    for (const t of p.definition.tools ?? []) {
      const needs = t.needs ?? (t.annotations?.readOnlyHint ? undefined : "edit");
      const roles = ACCOUNT_ROLES.filter((r) => !needs || canAccount(r, needs));
      tools.push({ name: t.name, title: t.title ? plain(t.title, 120) : null, description: plain(t.description, 2000), read_only: t.annotations?.readOnlyHint === true,
        roles: [...roles], role_labels: roles.map((r) => ACCOUNT_ROLE_LABELS[r]), input_schema: schemaOf(t.inputSchema as z.ZodRawShape | undefined) });
    }
    for (const t of generated.filter((x) => x.pack === p.id)) {
      const roles = ACCOUNT_ROLES.filter((r) => permitted(t, r));
      tools.push({ name: t.name, title: t.title, description: t.description, read_only: t.annotations.readOnlyHint, roles: [...roles],
        role_labels: roles.map((r) => ACCOUNT_ROLE_LABELS[r]), input_schema: schemaOf(t.input) });
    }
    if (tools.length) out.push({ id: p.id, name: plain(p.manifest.name, 80) || p.id, tools });
  }
  return { name: PROFILE.name, server: PROFILE.mcp_server_name, packs: out };
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#5f6368;--bg:#fff;--card:#f5f5f7;--line:#d2d2d7}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--bg:#111;--card:#1c1c1e;--line:#3a3a3c}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}
a{color:inherit}h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.1rem;margin:28px 0 8px}.muted{color:var(--muted)}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
ul{padding-left:20px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
</style></head><body><main>${body}</main></body></html>`;

const block = (v: { steps: string; command?: string | null; file?: string | null; snippet?: string | null; install_url?: string | null }) =>
  `<p>${esc(v.steps)}</p>` +
  (v.install_url && /^cursor:\/\//.test(v.install_url) ? `<p><a href="${esc(v.install_url)}">Add to Cursor</a></p>` : "") +
  (v.command ? `<pre>${esc(v.command)}</pre>` : "") +
  (v.snippet ? `${v.file ? `<p class="muted">${esc(v.file)}</p>` : ""}<pre>${esc(v.snippet)}</pre>` : "");

export function mountInstallPages(app: Express, publicUrl: string) {
  const send = (res: Response, status: number, html: string) => {
    res.status(status).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" }).send(html);
  };
  app.get("/install.json", (_req, res) => void res.set("Cache-Control", "public, max-age=300").json(installGuide(publicUrl)));
  // The tool reference, before /install/:client (mold_v0-010): only when the packs add tools, so a build with none
  // answers /install/tools as before (no such client).
  if (toolReference().packs.length) {
    app.get("/install/tools.json", (_req, res) => void res.set("Cache-Control", "public, max-age=300").json(toolReference()));
    app.get("/install/tools", (_req, res) => {
      const r = toolReference();
      const roleLine = (d: ToolDoc) => d.roles.length === ACCOUNT_ROLES.length ? "Every role" : d.roles.length ? d.role_labels.join(", ") : "No role";
      const body = r.packs.map((p) => `<h2 id="${esc(p.id)}">${esc(p.name)}</h2>` + p.tools.map((d) => `<div class="card"><h3 id="${esc(d.name)}"><code>${esc(d.name)}</code>${d.title ? ` <span class="muted">${esc(d.title)}</span>` : ""}</h3>
<p>${esc(d.description)}</p><p class="muted">${d.read_only ? "Reads only" : "Changes something"}. Who may call it: ${esc(roleLine(d))}.</p>
<details><summary>Input</summary><pre>${esc(JSON.stringify(d.input_schema, null, 2))}</pre></details></div>`).join("")).join("");
      send(res, 200, page(`${r.name} tools`, `<p><a href="/install">Connect a client</a></p><h1>${esc(r.name)} tools</h1>
<p class="muted">What your AI client can do once it is connected to ${esc(r.name)}, and which role in your account may do it. A tool your role may not use is not offered to you.</p>
<ul>${r.packs.map((p) => `<li><a href="#${esc(p.id)}">${esc(p.name)}</a> (${p.tools.length})</li>`).join("")}</ul>${body}`));
    });
  }
  app.get("/install", (_req, res) => {
    const g = installGuide(publicUrl);
    const groups = (Object.keys(GROUPS) as ClientEntry["group"][]).map((grp) => {
      const list = g.clients.filter((c) => c.group === grp);
      return list.length ? `<h2>${esc(GROUPS[grp])}</h2><ul>${list.map((c) => `<li><a href="/install/${esc(c.id)}">${esc(c.client)}</a></li>`).join("")}</ul>` : "";
    }).join("");
    send(res, 200, page(`Connect ${g.name}`, `<h1>Connect ${esc(g.name)} to your AI client</h1>
<p class="muted">${esc(g.name)} is an MCP server at</p><pre>${esc(g.url)}</pre>
<p>${g.sign_in ? "Every client signs in with your account (OAuth). Clients that can send a header may use an API key instead, always in a header, never in the address." : "Connect with an API key from your account, sent in a header (never in the address)."}</p>${groups}${"tool_reference" in g ? `<h2>Tools</h2><p><a href="/install/tools">What ${esc(g.name)} can do, and who may</a></p>` : ""}`));
  });
  app.get("/install/:client", (req: Request, res: Response) => {
    const g = installGuide(publicUrl);
    const c = g.clients.find((x) => x.id === req.params.client);
    if (!c) return send(res, 404, page("Not found", `<h1>No such client</h1><p><a href="/install">Every client</a></p>`));
    send(res, 200, page(`${g.name} in ${c.client}`, `<p><a href="/install">All clients</a></p><h1>${esc(g.name)} in ${esc(c.client)}</h1>
<p class="muted">Server address</p><pre>${esc(g.url)}</pre>
${c.sign_in ? `<div class="card"><h2>Sign in (recommended)</h2>${block(c.sign_in)}</div>` : ""}
${c.api_key ? `<div class="card"><h2>With an API key</h2><p class="muted">Replace ${esc(KEY_PLACEHOLDER)} with a key from your account. It goes in a header: never put it in the address.</p>${block(c.api_key)}</div>` : ""}
${!c.sign_in && !c.api_key ? `<p>This client cannot connect to ${esc(g.name)} yet: use another client from the list.</p>` : ""}
${c.verified ? "" : `<p class="muted">Checked against the client's documented MCP settings; if your version differs, follow its own docs with the address above.</p>`}`));
  });
}

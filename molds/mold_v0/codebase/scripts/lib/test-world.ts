// A throwaway world for the shell's offline tests (record areas, the run engine, the workspace store): an embedded
// database in a temporary directory, an unlocked vault, the fixture registry, and helpers to connect an MCP client as a
// workspace, start the HTTP server behind a fake Clerk, and sign people in. Import it before any src/ module: it sets
// the environment those modules read when they load.
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export const TMP = mkdtempSync(path.join(tmpdir(), "shell-test-"));
delete process.env.DATABASE_URL; // always the throwaway embedded database
process.env.PGLITE_DIR = path.join(TMP, "pglite");
process.env.OCTILLION_VAULT_KEY = randomBytes(32).toString("base64");
process.env.OCTILLION_REGISTRY = "scripts/fixtures/registry.json";
process.env.OCTILLION_WORKER_TOKEN ??= `test-worker-${randomBytes(8).toString("hex")}`;
process.env.REASONS_ENABLED = "off";
process.env.OCTILLION_AUTOSCALE ??= "off";
export const STAMP = Date.now().toString(36);

export const cleanup = () => rmSync(TMP, { recursive: true, force: true });

type Org = import("../../src/auth.js").Org;
export type ToolResult = { isError?: boolean; structuredContent?: any; content: { type: string; text: string }[] };

/** An MCP client connected to a fresh createServer(org), over an in-memory transport. */
export async function connect(org: Org) {
  const { createServer } = await import("../../src/server.js");
  const server = createServer(org);
  const client = new Client({ name: "shell-test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, close: () => client.close() };
}

/** The HTTP server (src/http.ts createApp) behind a fake Clerk, with helpers to sign a person into a workspace. */
export async function startHttp() {
  const { startMockProviders } = await import("./mock-providers.js");
  const mock = await startMockProviders();
  const { pem } = await (await fetch(`${mock.url}/_mock/public-key`)).json();
  Object.assign(process.env, { CLERK_SECRET_KEY: "sk_test_mock", CLERK_API_URL: mock.url, CLERK_FRONTEND_API_URL: mock.url, CLERK_JWT_KEY: pem });
  const { createApp } = await import("../../src/http.js");
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { getDb } = await import("../../src/db.js");
  const db = await getDb();
  const clerk = async (p: string, body: unknown) => (await fetch(`${mock.url}${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk_test_mock" }, body: JSON.stringify(body) })).json();
  const mockPost = async (p: string, body: unknown) => (await fetch(`${mock.url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  /** A signed-in member of `org` (a Clerk organization linked to it on first use): a session token. */
  const linked = new Map<number, string>();
  const signIn = async (org: Org, role: "member" | "viewer" | "owner" = "member") => {
    let corg = linked.get(org.orgId);
    if (!corg) {
      corg = (await clerk("/v1/organizations", { name: org.name })).id as string;
      await db.query("UPDATE organizations SET clerk_org_id = $1 WHERE id = $2", [corg, org.orgId]);
      linked.set(org.orgId, corg);
    }
    const user = await mockPost("/_mock/clerk/users", { email: `${role}+${org.orgId}-${randomBytes(3).toString("hex")}@example.org` });
    await mockPost("/_mock/clerk/memberships", { org_id: corg, user_id: user.id, role: role === "owner" ? "org:admin" : "org:member", ...(role === "viewer" ? { public_metadata: { octillion_role: "viewer" } } : {}) });
    return (await mockPost("/_mock/session", { user_id: user.id, org_id: corg })).token as string;
  };
  const { createAdminToken } = await import("../../src/admin-tokens.js");
  const adminToken = async (role: "viewer" | "support" | "operator" | "owner") =>
    (await createAdminToken({ label: `test-${role}-${randomBytes(3).toString("hex")}`, role, days: 1, createdBy: "shell-test" })).token;
  const req = (method: string, p: string, h: Record<string, string> = {}, body?: unknown) =>
    fetch(`${base}${p}`, { method, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? body as BodyInit : JSON.stringify(body) });
  const close = async () => { server.close(); await mock.close(); };
  return { base, signIn, adminToken, req, close };
}

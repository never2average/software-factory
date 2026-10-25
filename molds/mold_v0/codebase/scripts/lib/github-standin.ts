// A stand-in for GitHub's API and web endpoints a GitHub App uses (mold_v0-014; src/github-app.ts), on 127.0.0.1, for
// scripts/github-app-test.ts. Nothing here reaches GitHub. It checks what GitHub checks (the app's JWT signed by its
// private key, a user-to-server code issued for the app's client, a token's own scope and expiry) and records every call
// so the test can say what was asked for and what was revoked.
//
//   POST   /login/oauth/access_token                  {client_id, client_secret, code} -> a user token (codes: users)
//   GET    /user/installations                        the user's installations of the app
//   DELETE /applications/:client_id/token             (Basic client_id:client_secret) {access_token}: revokes a user token
//   GET    /app/installations/:id                     (the app's JWT) the installation
//   DELETE /app/installations/:id                     (the app's JWT) uninstall
//   POST   /app/installations/:id/access_tokens       (the app's JWT) {repository_ids?, permissions} -> an installation token
//   GET    /installation/repositories                 (a token) the repositories it reaches
//   DELETE /installation/token                        (a token) revokes it
//   GET    /repos/:owner/:name/contents               (a token) 200 when the token is live and reaches that repository
import { createPublicKey, verify, randomBytes, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface StandinRepo { id: number; full_name: string }
export interface StandinInstallation { id: number; app_id: number; account: { login: string; type: string }; repository_selection: "all" | "selected"; repositories: StandinRepo[]; suspended_at?: string | null; uninstalled?: boolean }
export interface MintedRecord { token: string; installation: number; repository_ids: number[] | null; permissions: Record<string, string>; expires_at: number; revoked: boolean }

export async function startGithubStandin(opts: { appId: number; clientId: string; clientSecret: string; publicKeyPem: string }) {
  const pub: KeyObject = createPublicKey(opts.publicKeyPem);
  const installations = new Map<number, StandinInstallation>();
  /** code -> the installation ids that person can reach. */
  const codes = new Map<string, number[]>();
  const userTokens = new Map<string, { installations: number[]; revoked: boolean }>();
  const minted: MintedRecord[] = [];
  const calls: { method: string; path: string; auth: string; body: string }[] = [];
  const state = { ttlMs: 60 * 60_000, overgrant: false as false | Record<string, string> };

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  /** The app's JWT: RS256 over header.payload with the app's key, iss the app id, at most ten minutes. */
  const jwtOk = (auth: string) => {
    const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(auth);
    if (!m) return false;
    const ok = verify("RSA-SHA256", Buffer.from(`${m[1]}.${m[2]}`), pub, Buffer.from(m[3]!, "base64url"));
    if (!ok) return false;
    const p = JSON.parse(Buffer.from(m[2]!, "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    return String(p.iss) === String(opts.appId) && p.exp > now && p.iat <= now + 60 && p.exp - p.iat <= 600;
  };
  const tokenOf = (auth: string) => {
    const m = /^(?:token|Bearer) (\S+)$/.exec(auth);
    const t = m ? minted.find((x) => x.token === m[1]) : undefined;
    return t && !t.revoked && t.expires_at > Date.now() && !installations.get(t.installation)?.uninstalled ? t : null;
  };
  const reposOf = (t: MintedRecord) => {
    const i = installations.get(t.installation)!;
    return t.repository_ids ? i.repositories.filter((r) => t.repository_ids!.includes(r.id)) : i.repositories;
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    const auth = String(req.headers.authorization ?? "");
    calls.push({ method: req.method ?? "", path: url.pathname, auth, body: raw });
    const body = (() => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } })();
    const p = url.pathname;
    let m: RegExpExecArray | null;
    if (req.method === "POST" && p === "/login/oauth/access_token") {
      if (body.client_id !== opts.clientId || body.client_secret !== opts.clientSecret) return send(res, 200, { error: "incorrect_client_credentials" });
      const reach = codes.get(String(body.code));
      if (!reach) return send(res, 200, { error: "bad_verification_code" });
      codes.delete(String(body.code)); // a code is used once
      const t = `ghu_${randomBytes(16).toString("hex")}`;
      userTokens.set(t, { installations: reach, revoked: false });
      return send(res, 200, { access_token: t, token_type: "bearer" });
    }
    if (req.method === "GET" && p === "/user/installations") {
      const u = userTokens.get(auth.replace(/^Bearer /, ""));
      if (!u || u.revoked) return send(res, 401, { message: "Bad credentials" });
      return send(res, 200, { total_count: u.installations.length, installations: u.installations.map((id) => ({ id })) });
    }
    if (req.method === "DELETE" && (m = /^\/applications\/([^/]+)\/token$/.exec(p))) {
      if (auth !== `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64")}` || m[1] !== opts.clientId) return send(res, 401, {});
      const u = userTokens.get(String(body.access_token));
      if (u) u.revoked = true;
      return send(res, 204);
    }
    if ((m = /^\/app\/installations\/([0-9]+)$/.exec(p))) {
      if (!jwtOk(auth)) return send(res, 401, { message: "A JSON web token could not be decoded" });
      const i = installations.get(Number(m[1]));
      if (!i || i.uninstalled) return send(res, 404, { message: "Not Found" });
      if (req.method === "DELETE") { i.uninstalled = true; return send(res, 204); }
      return send(res, 200, { id: i.id, app_id: i.app_id, account: i.account, repository_selection: i.repository_selection, suspended_at: i.suspended_at ?? null });
    }
    if (req.method === "POST" && (m = /^\/app\/installations\/([0-9]+)\/access_tokens$/.exec(p))) {
      if (!jwtOk(auth)) return send(res, 401, { message: "A JSON web token could not be decoded" });
      const i = installations.get(Number(m[1]));
      if (!i || i.uninstalled || i.app_id !== opts.appId) return send(res, 404, { message: "Not Found" });
      if (i.suspended_at) return send(res, 403, { message: "This installation has been suspended" });
      const ids: number[] | null = Array.isArray(body.repository_ids) ? body.repository_ids : null;
      if (ids && ids.some((x) => !i.repositories.some((r) => r.id === x))) return send(res, 422, { message: "There is at least one repository that does not exist or is not accessible" });
      const asked: Record<string, string> = body.permissions ?? { contents: "write", metadata: "read", issues: "write" };
      const t: MintedRecord = { token: `ghs_${randomBytes(18).toString("hex")}`, installation: i.id, repository_ids: ids, permissions: { ...asked, metadata: "read" },
        expires_at: Date.now() + state.ttlMs, revoked: false };
      minted.push(t);
      const perms = state.overgrant ? { ...t.permissions, ...state.overgrant } : t.permissions;
      return send(res, 201, { token: t.token, expires_at: new Date(t.expires_at).toISOString(), permissions: perms,
        repository_selection: ids ? "selected" : i.repository_selection, ...(ids ? { repositories: reposOf(t) } : {}) });
    }
    if (req.method === "GET" && p === "/installation/repositories") {
      const t = tokenOf(auth);
      if (!t) return send(res, 401, { message: "Bad credentials" });
      const list = reposOf(t), page = Number(url.searchParams.get("page") ?? 1), per = Number(url.searchParams.get("per_page") ?? 30);
      return send(res, 200, { total_count: list.length, repositories: list.slice((page - 1) * per, page * per) });
    }
    if (req.method === "DELETE" && p === "/installation/token") {
      const t = tokenOf(auth);
      if (!t) return send(res, 401, { message: "Bad credentials" });
      t.revoked = true;
      return send(res, 204);
    }
    if (req.method === "GET" && (m = /^\/repos\/([^/]+)\/([^/]+)\/contents$/.exec(p))) {
      const t = tokenOf(auth);
      if (!t) return send(res, 401, { message: "Bad credentials" });
      if (!t.permissions.contents) return send(res, 403, { message: "Resource not accessible by integration" });
      if (!reposOf(t).some((r) => r.full_name === `${m![1]}/${m![2]}`)) return send(res, 404, { message: "Not Found" });
      return send(res, 200, [{ name: "README.md" }]);
    }
    send(res, 404, { message: "Not Found" });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** A read of a repository's contents with a token, as a program holding it would: the status GitHub would answer. */
  const read = async (token: string, repo: string) => (await fetch(`${url}/repos/${repo}/contents`, { headers: { authorization: `token ${token}` } })).status;
  return { url, installations, codes, userTokens, minted, calls, state, read, close: () => new Promise<void>((r) => server.close(() => r())) };
}

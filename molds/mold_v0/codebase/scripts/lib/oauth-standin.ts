// A stand-in OAuth 2.0 provider (mold_v0-014; src/oauth-connections.ts), on 127.0.0.1, for scripts/oauth-providers-test.ts.
// Nothing here reaches a real provider. It checks what a provider checks: the client (in the body or Basic), a code used
// once, for its own redirect address and PKCE verifier (S256); refresh tokens rotate (a used one is refused, invalid_grant);
// tokens expire on the test's clock; revocation (RFC 7009) ends a token at once.
//   GET  /authorize   auto-approves (or denies, when `deny` is set): a redirect to redirect_uri with code and state
//   POST /token       authorization_code and refresh_token grants
//   POST /revoke      token (access or refresh)
//   GET  /api/me      200 for a live access token, else 401 (what a program holding the token would see)
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export async function startOAuthStandin(opts: { clientId: string; clientSecret: string; now?: () => number }) {
  const clock = opts.now ?? Date.now;
  const codes = new Map<string, { redirect_uri: string; challenge: string | null; scope: string; used: boolean }>();
  const access = new Map<string, { expires_at: number; revoked: boolean; scope: string }>();
  const refresh = new Map<string, { revoked: boolean; scope: string }>();
  const calls: { method: string; path: string; auth: string; body: string }[] = [];
  const state = { ttlSeconds: 3600, deny: false, grants: { authorization_code: 0, refresh_token: 0 } };
  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const issue = (scope: string) => {
    const a = `acc_${randomBytes(16).toString("hex")}`, r = `ref_${randomBytes(16).toString("hex")}`;
    access.set(a, { expires_at: clock() + state.ttlSeconds * 1000, revoked: false, scope });
    refresh.set(r, { revoked: false, scope });
    return { access_token: a, refresh_token: r, token_type: "Bearer", expires_in: state.ttlSeconds, scope };
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    const auth = String(req.headers.authorization ?? "");
    calls.push({ method: req.method ?? "", path: url.pathname, auth, body: raw });
    const form = Object.fromEntries(new URLSearchParams(raw));
    const clientOk = () => {
      const basic = /^Basic (.+)$/.exec(auth);
      const [id, secret] = basic ? Buffer.from(basic[1]!, "base64").toString().split(":").map(decodeURIComponent) : [form.client_id, form.client_secret];
      return id === opts.clientId && secret === opts.clientSecret;
    };
    if (req.method === "GET" && url.pathname === "/authorize") {
      const q = url.searchParams, ru = q.get("redirect_uri") ?? "";
      if (q.get("client_id") !== opts.clientId || q.get("response_type") !== "code") return send(res, 400, { error: "invalid_request" });
      const back = new URL(ru);
      if (state.deny) back.searchParams.set("error", "access_denied");
      else {
        const code = `code_${randomBytes(12).toString("hex")}`;
        codes.set(code, { redirect_uri: ru, challenge: q.get("code_challenge_method") === "S256" ? q.get("code_challenge") : null, scope: q.get("scope") ?? "", used: false });
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", q.get("state") ?? "");
      return send(res, 302, undefined, { location: back.toString() });
    }
    if (req.method === "POST" && url.pathname === "/token") {
      if (!clientOk()) return send(res, 401, { error: "invalid_client" });
      if (form.grant_type === "authorization_code") {
        const c = codes.get(form.code ?? "");
        if (!c || c.used || c.redirect_uri !== form.redirect_uri) return send(res, 400, { error: "invalid_grant" });
        c.used = true;
        if (c.challenge && createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== c.challenge) return send(res, 400, { error: "invalid_grant" });
        state.grants.authorization_code++;
        return send(res, 200, issue(c.scope));
      }
      if (form.grant_type === "refresh_token") {
        const r = refresh.get(form.refresh_token ?? "");
        if (!r || r.revoked) return send(res, 400, { error: "invalid_grant" });
        r.revoked = true; // rotation: a refresh token is used once
        state.grants.refresh_token++;
        return send(res, 200, issue(r.scope));
      }
      return send(res, 400, { error: "unsupported_grant_type" });
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      if (!clientOk()) return send(res, 401, { error: "invalid_client" });
      const t = form.token ?? "";
      const a = access.get(t), r = refresh.get(t);
      if (a) a.revoked = true;
      if (r) r.revoked = true;
      return send(res, 200, {});
    }
    if (req.method === "GET" && url.pathname === "/api/me") {
      const a = access.get(auth.replace(/^Bearer /, ""));
      return a && !a.revoked && a.expires_at > clock() ? send(res, 200, { ok: true }) : send(res, 401, { error: "invalid_token" });
    }
    send(res, 404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** As the provider's sign-in page would: follow the authorize address (on this stand-in) to the redirect it gives. */
  const authorize = async (authorizeUrl: string) => {
    const u = new URL(authorizeUrl);
    const r = await fetch(`${url}/authorize${u.search}`, { redirect: "manual" });
    return new URL(r.headers.get("location")!);
  };
  const me = async (token: string) => (await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status;
  return { url, codes, access, refresh, calls, state, authorize, me, close: () => new Promise<void>((r) => server.close(() => r())) };
}

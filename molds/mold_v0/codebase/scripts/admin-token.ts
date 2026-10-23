// Admin API tokens (src/admin-tokens.ts), on the server: the replacement for the old static APP_ADMIN_TOKEN.
//   npm run admin:token -- create --label "ci deploy" --role operator [--days 30]   prints the token once
//   npm run admin:token -- list
//   npm run admin:token -- revoke <id>
// Roles: viewer, support, operator, owner (src/admin-roles.ts); give a script the least one it needs. Tokens expire
// after --days (default 30, at most 90). Send one as `Authorization: Bearer adm_...` to /api/admin/* or /admin/mcp.
import { ADMIN_TOKEN_MAX_DAYS, createAdminToken, listAdminTokens, revokeAdminToken } from "../src/admin-tokens.js";
import { getDb } from "../src/db.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const usage = `Usage: npm run admin:token -- create --label <purpose> --role viewer|support|operator|owner [--days 1-${ADMIN_TOKEN_MAX_DAYS}] | list | revoke <id>`;
try {
  if (cmd === "create") {
    const t = await createAdminToken({ label: flag("label") ?? "", role: flag("role") ?? "", days: flag("days") ? Number(flag("days")) : undefined, createdBy: `cli:${process.env.SUDO_USER || (await import("node:os")).userInfo().username}` });
    if (rest.includes("--json")) console.log(JSON.stringify({ id: t.id, token: t.token, role: t.role, expires_at: t.expires_at }));
    else console.log(`Admin token #${t.id} "${t.label}", role ${t.role}, expires ${new Date(t.expires_at).toISOString()} (shown once):\n${t.token}`);
  } else if (cmd === "list") {
    for (const t of await listAdminTokens())
      console.log(`#${t.id}\t${t.token_prefix}…\t${t.role}\t${t.revoked_at ? "revoked" : new Date(t.expires_at) < new Date() ? "expired" : `expires ${new Date(t.expires_at).toISOString().slice(0, 10)}`}\t${t.label}\t(by ${t.created_by}${t.last_used_at ? `, last used ${new Date(t.last_used_at).toISOString()}` : ", never used"})`);
  } else if (cmd === "revoke" && rest[0]) {
    console.log((await revokeAdminToken(Number(rest[0]))) ? `revoked #${rest[0]}` : `no active token #${rest[0]}`);
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await (await getDb()).close();
}

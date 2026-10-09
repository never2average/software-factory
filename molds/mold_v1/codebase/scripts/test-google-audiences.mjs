/**
 * WHICH GOOGLE CLIENTS A DEPLOYMENT ADMITS ARE ITS SETTINGS, NOT CONSTANTS IN THE CODE.
 *
 * The front door (lib/ops-auth.ts) and the agent (agent/channels/eve.ts) used to admit two desktop clients written
 * into both files, so every deployment of this code trusted one project's clients. They read
 * agent/lib/google-audiences.ts now: WORKSPACE_OAUTH_CLIENT_ID (the client the deployment's package is built with)
 * and WORKSPACE_CLI_CLIENT_ID (further clients, comma separated). check:gates holds
 * the two doors to that one helper; this proves the front door's behaviour with real signed tokens, verified
 * against keys this test made (the __setGoogleKeysForTest seam), offline.
 *
 *   npm run test:google-audiences
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) {
            try { return await n(s + ".ts", c); } catch { return await n(s + ".js", c); }
          }
          throw e;
        }
      }`),
  import.meta.url,
);

for (const k of ["NEXT_PUBLIC_GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_ID", "WORKSPACE_OAUTH_CLIENT_ID", "WORKSPACE_CLI_CLIENT_ID"]) delete process.env[k];

const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = await import("jose");
const { verifyOpsAuthResult, verifiedGoogleAddress, __setGoogleKeysForTest } = await import("../lib/ops-auth.ts");
const { cliClientIds, splitClientIds } = await import("../agent/lib/google-audiences.ts");

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
__setGoogleKeysForTest(createLocalJWKSet({ keys: [jwk] }));
const token = (aud) =>
  new SignJWT({ email: "person@desk.example.com", email_verified: true, hd: "desk.example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://accounts.google.com")
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);

// Placeholders: no project number, so nothing here is shaped like a real client (check:google-client).
const WEB = "web-client.apps.googleusercontent.com";
const BUILT = "package-client.apps.googleusercontent.com";
const PREVIOUS = "previous-client.apps.googleusercontent.com";
const TEAM = "team-client.apps.googleusercontent.com";

let passed = 0;
async function check(what, fn) {
  try { await fn(); passed++; console.log(`  ok  ${what}`); } catch (e) { console.error(`FAIL  ${what}\n${e.stack ?? e}`); process.exitCode = 1; }
}
const admits = async (aud) => (await verifyOpsAuthResult(`Bearer ${await token(aud)}`)).ok;

await check("splitClientIds: commas and spaces, trimmed, no empties or repeats", () => {
  assert.deepEqual(splitClientIds(` ${BUILT}, ${PREVIOUS} ,,${BUILT}\n${TEAM}`), [BUILT, PREVIOUS, TEAM]);
  assert.deepEqual(splitClientIds(undefined), []); assert.deepEqual(splitClientIds(""), []);
});
await check("nothing set: no Google token is admitted, and the reason names the missing setting", async () => {
  assert.deepEqual(cliClientIds(), []);
  const r = await verifyOpsAuthResult(`Bearer ${await token(BUILT)}`);
  assert.equal(r.ok, false); assert.equal(r.reason, "no-audience-configured");
});
await check("the web client alone admits web tokens and no package token", async () => {
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = WEB;
  assert.equal(await admits(WEB), true); assert.equal(await admits(BUILT), false);
});
await check("WORKSPACE_OAUTH_CLIENT_ID admits the package's tokens (the same name the package build reads)", async () => {
  process.env.WORKSPACE_OAUTH_CLIENT_ID = BUILT;
  assert.deepEqual(cliClientIds(), [BUILT]);
  assert.equal(await admits(BUILT), true); assert.equal(await admits(PREVIOUS), false);
  assert.ok(await verifiedGoogleAddress(await token(BUILT)), "the guest door uses the same list");
});
await check("WORKSPACE_CLI_CLIENT_ID admits further clients, comma separated", async () => {
  process.env.WORKSPACE_CLI_CLIENT_ID = `${PREVIOUS}, ${TEAM}`;
  assert.deepEqual(cliClientIds(), [BUILT, PREVIOUS, TEAM]);
  assert.equal(await admits(PREVIOUS), true); assert.equal(await admits(TEAM), true);
  assert.equal(await admits("someone-else.apps.googleusercontent.com"), false);
});
await check("with WORKSPACE_CLI_CLIENT_ID unset, a previous client is no longer admitted", async () => {
  delete process.env.WORKSPACE_CLI_CLIENT_ID;
  assert.equal(await admits(PREVIOUS), false);
});

console.log(`\ntest-google-audiences: ${passed} checks passed`);

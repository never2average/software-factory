/**
 * WHICH GOOGLE WORKSPACE DOMAINS MAY SIGN IN TO THE AGENT IS A SETTING, AND UNSET IS CLOSED.
 *
 * agent/channels/eve.ts locked single-tenant Google sign-in to one company's domain written into the code. It reads
 * WORKSPACE_LOGIN_DOMAINS now (agent/lib/login-domains.ts). This proves the three outcomes — multi-tenant: no lock;
 * single-tenant with domains: exactly those; single-tenant with none: no Google sign-in at all, never "any domain" —
 * and that the agent wires the result in so a null lock leaves no Google verifier. Offline.
 *
 *   npm run test:login-domains
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

delete process.env.WORKSPACE_LOGIN_DOMAINS; delete process.env.OPS_MULTI_TENANT;
const { loginDomains, hostedDomainLock } = await import("../agent/lib/login-domains.ts");

let passed = 0;
function check(what, fn) {
  try { fn(); passed++; console.log(`  ok  ${what}`); } catch (e) { console.error(`FAIL  ${what}\n${e.stack ?? e}`); process.exitCode = 1; }
}
const warns = []; const warn = console.warn; console.warn = (m) => warns.push(String(m));

check("the list: commas and spaces, lower case, a leading @ dropped, repeats and malformed entries dropped", () => {
  assert.deepEqual(loginDomains(" Desk.Example.com, @example.co.uk ,,desk.example.com not_a_domain localhost"), ["desk.example.com", "example.co.uk"]);
  assert.deepEqual(loginDomains(""), []); assert.deepEqual(loginDomains(undefined), []);
});
check("multi-tenant: no domain lock, whatever the list says", () => {
  assert.deepEqual(hostedDomainLock({ multiTenant: true, domains: [] }), {});
  assert.deepEqual(hostedDomainLock({ multiTenant: true, domains: ["desk.example.com"] }), {});
});
check("single-tenant with domains: exactly those", () => {
  assert.deepEqual(hostedDomainLock({ multiTenant: false, domains: ["desk.example.com", "example.co.uk"] }), { claims: { hd: ["desk.example.com", "example.co.uk"] } });
});
check("single-tenant with none: closed (null), never open ({}), and a warning names the setting once", () => {
  assert.equal(hostedDomainLock({ multiTenant: false, domains: [] }), null);
  assert.equal(hostedDomainLock({ multiTenant: false, domains: [] }), null);
  assert.equal(warns.length, 1); assert.match(warns[0], /WORKSPACE_LOGIN_DOMAINS/);
});
check("read from the environment by default", () => {
  process.env.WORKSPACE_LOGIN_DOMAINS = "desk.example.com";
  assert.deepEqual(hostedDomainLock(), { claims: { hd: ["desk.example.com"] } });
  process.env.OPS_MULTI_TENANT = "1";
  assert.deepEqual(hostedDomainLock(), {});
});
check("the agent's door: a null lock leaves no Google verifier, and no domain is written in it", () => {
  const eve = readFileSync("agent/channels/eve.ts", "utf8");
  assert.match(eve, /const domainLock = hostedDomainLock\(\{ multiTenant \}\);/);
  assert.match(eve, /const googleAuth = googleClientId && domainLock\s*\?/);
  assert.match(eve, /\.\.\.domainLock,/);
  assert.ok(!/hd\s*:\s*\[\s*["']/.test(eve), "a literal hd list");
});
console.warn = warn;
console.log(`\ntest-login-domains: ${passed} checks passed`);

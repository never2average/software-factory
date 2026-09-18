import assert from "node:assert/strict";

// Deterministic 32-byte test key. Never used outside this process.
process.env.OPS_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

const { openBrowserCapability, sealBrowserCapability } = await import(
  "../agent/lib/browser-capability-crypto.ts"
);
const { browserAuditUrl, browserContextScopeKey, redactBrowserError } = await import("../agent/lib/browser.ts");

const orgA = "org-browser-security-a";
const orgB = "org-browser-security-b";
const capability = "wss://connect.example.test/session?id=abc&token=super-secret";
const sealed = sealBrowserCapability(capability, orgA);

assert.notEqual(sealed.ciphertext, capability, "capability must be encrypted at rest");
assert.equal(openBrowserCapability(sealed, orgA), capability, "owning workspace can decrypt");
assert.throws(
  () => openBrowserCapability(sealed, orgB),
  /auth|authenticate|Unsupported state/i,
  "another workspace cannot decrypt the capability",
);

const alice = { orgId: orgA, principalId: "user:alice" };
const bob = { orgId: orgA, principalId: "user:bob" };
assert.notEqual(
  browserContextScopeKey(alice, "principal"),
  browserContextScopeKey(bob, "principal"),
  "principal contexts must not share cookies",
);
assert.equal(browserContextScopeKey(alice, "team"), browserContextScopeKey(bob, "team"));

const redacted = redactBrowserError(
  new Error("connect wss://connect.example.test/session?token=secret failed; https://watch.example.test/x?key=secret"),
);
assert.doesNotMatch(redacted, /connect\.example|watch\.example|token=secret|key=secret/);
assert.equal(
  browserAuditUrl("https://app.example.test/path?token=secret#private"),
  "https://app.example.test/path",
);

console.log("browser security tests passed");

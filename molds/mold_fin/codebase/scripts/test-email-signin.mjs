/**
 * Email sign-in: the properties that make a six-digit code safe.
 *
 * A one-time code is only as good as the things around it, and every one of
 * those is easy to weaken by accident later. These assert the ones that would
 * fail silently — a code that still verifies after being used, a hash a leaked
 * database row could reverse, a token minted by the wrong key being accepted.
 *
 * Behavioural where it can be (real crypto, real round-trips) and source-level
 * only where a route's guard cannot be exercised without a database.
 *
 * Run:  npm run test:email-signin
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
};

/* ---- session tokens ----------------------------------------------------- */

const pem = (kp, kind) =>
  kind === "private"
    ? kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    : kp.publicKey.export({ type: "spki", format: "pem" }).toString();

const real = generateKeyPairSync("ec", { namedCurve: "P-256" });
const other = generateKeyPairSync("ec", { namedCurve: "P-256" });

process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pem(real, "private")).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pem(real, "public")).toString("base64");
process.env.OPS_SECRETS_KEY = "test-secrets-key-not-a-real-one";

const session = await import("../lib/auth-session.ts");

const token = await session.mintSessionToken("Invited.Person@Gmail.com");
check("a minted token verifies", (await session.verifySessionToken(token)) === "invited.person@gmail.com");
check("the email is normalised to lower case", !token.includes("Invited.Person"));
check("a tampered token is refused", (await session.verifySessionToken(`${token.slice(0, -3)}aaa`)) === null);
check("garbage is refused", (await session.verifySessionToken("not.a.token")) === null);
check("no token is refused", (await session.verifySessionToken(null)) === null);

// The whole point of ES256 here: the verifier's key cannot mint.
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pem(other, "private")).toString("base64");
const forged = await session.mintSessionToken("attacker@example.com");
check("a token signed by another key is refused", (await session.verifySessionToken(forged)) === null);
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pem(real, "private")).toString("base64");

// Raw PEM must work as well as base64 — both reach a dashboard by different routes.
process.env.AUTH_JWT_PUBLIC_KEY = pem(real, "public");
check("a raw PEM public key is accepted too", (await session.verifySessionToken(token)) === "invited.person@gmail.com");

process.env.AUTH_JWT_PUBLIC_KEY = "";
check("no public key means nothing verifies", (await session.verifySessionToken(token)) === null);
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pem(real, "public")).toString("base64");

/* ---- the code itself ---------------------------------------------------- */

const codes = await import("../lib/login-code.ts");

const code = codes.mintLoginCode();
check("the code is six digits", /^\d{6}$/.test(code));
const hash = codes.hashLoginCode("a@b.com", code);
check("the right code matches", codes.loginCodeMatches("a@b.com", code, hash));
check("a wrong code does not", !codes.loginCodeMatches("a@b.com", code === "000000" ? "111111" : "000000", hash));
// Same code, different person → different hash. Without the email in the HMAC,
// one leaked row would identify everyone else holding the same code.
check("the hash is bound to the address", codes.hashLoginCode("c@d.com", code) !== hash);
// And the pepper is what stops a leaked row being reversed: six digits is a
// table you can build in a second against a bare SHA-256.
process.env.OPS_SECRETS_KEY = "a-different-key";
check("the hash is keyed, not a bare digest", codes.hashLoginCode("a@b.com", code) !== hash);
process.env.OPS_SECRETS_KEY = "test-secrets-key-not-a-real-one";

/* ---- guards that need a database, asserted at the source ---------------- */

const requestRoute = readFileSync("app/api/auth/email/request/route.ts", "utf8");
const verifyRoute = readFileSync("app/api/auth/email/verify/route.ts", "utf8");
const proxy = readFileSync("proxy.ts", "utf8");

check(
  "a code is only sent to an invited or existing member",
  /if \(!member && !invite\) return NextResponse\.json\(SAME_ANSWER\)/.test(requestRoute),
);
check(
  "the reply is identical either way (no membership oracle)",
  requestRoute.includes("const SAME_ANSWER"),
);
check("code requests are rate limited", /CODES_PER_HOUR/.test(requestRoute));
check("codes expire", /10 \* 60 \* 1000/.test(requestRoute));
check("wrong guesses are counted before returning", /attempts: row\.attempts \+ 1/.test(verifyRoute));
check("guesses are capped", /row\.attempts >= MAX_ATTEMPTS/.test(verifyRoute));
check("a used code is consumed", /consumedAt: new Date\(\)/.test(verifyRoute));
check(
  "only unconsumed codes are considered",
  /isNull\(loginCodes\.consumedAt\)/.test(verifyRoute),
);
check("the sign-in routes are exempt from the auth gate", proxy.includes('pathname.startsWith("/api/auth/")'));
check(
  "…and still get a CSP, like every other response",
  /api\/auth\/[\s\S]{0,600}content-security-policy/.test(proxy),
);

/* ---- leaving is self-service, but not at the cost of an ownerless org --- */

const leaveRoute = readFileSync("app/api/ops/me/workspaces/[id]/route.ts", "utf8");
// Match the IMPORT, not the word: the route's comment explains the admin-only
// route it replaces, and a bare substring test scores that as a failure.
const importLines = leaveRoute.split("\n").filter((l) => l.startsWith("import "));
check("leaving needs no admin role", !importLines.some((l) => l.includes("isOrgAdmin")));
check("the last owner cannot strand the workspace", leaveRoute.includes('reason: "last-owner"'));

const meRoute = readFileSync("app/api/ops/me/workspaces/route.ts", "utf8");
check("the workspace list is ordered deterministically", /orderBy\(asc\(orgMembers\.createdAt\)/.test(meRoute));
const orgContext = readFileSync("lib/org-context.ts", "utf8");
check(
  "…and so is the default-workspace pick",
  // Superseded, deliberately: the pick is now "most recently CHOSEN, then
  // oldest, then by id". The switcher stamps lastSelectedAt so the console and
  // the agent land in the same workspace. Still fully deterministic — the
  // tie-breakers below are what this check actually exists to protect.
  /lastSelectedAt\} DESC NULLS LAST/.test(orgContext) &&
    /asc\(orgMembers\.createdAt\)/.test(orgContext) &&
    /asc\(orgMembers\.orgId\)/.test(orgContext),
);

console.log(`email sign-in + membership: ${passed}/${passed} checks passed`);

// Clerk sessions are made on the console. On the two-project shape the console (OCTILLION_CONSOLE_URL) and the API
// (PUBLIC_URL) are different origins, so both must be authorized parties, or every signed-in request is a 401.
import assert from "node:assert/strict";

const set = (env: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
const { authorizedPartiesForTest: parties } = await import("../src/clerk.js");

set({ CLERK_AUTHORIZED_PARTIES: undefined, PUBLIC_URL: "https://app-api.example.org", OCTILLION_CONSOLE_URL: "https://app.example.org" });
assert.deepEqual(parties().sort(), ["https://app-api.example.org", "https://app.example.org"], "two-project shape: the console and the API are both authorized");

set({ OCTILLION_CONSOLE_URL: undefined });
assert.deepEqual(parties(), ["https://app-api.example.org"], "one origin when the console is the API's own address");

set({ PUBLIC_URL: "https://same.example.org", OCTILLION_CONSOLE_URL: "https://same.example.org/" });
assert.deepEqual(parties(), ["https://same.example.org"], "the same origin is listed once");

set({ CLERK_AUTHORIZED_PARTIES: "https://only.example.org", OCTILLION_CONSOLE_URL: "https://app.example.org" });
assert.deepEqual(parties(), ["https://only.example.org"], "an explicit CLERK_AUTHORIZED_PARTIES wins");

set({ CLERK_AUTHORIZED_PARTIES: undefined, PUBLIC_URL: "https://app-api.example.org", OCTILLION_CONSOLE_URL: "not a url" });
assert.deepEqual(parties(), ["https://app-api.example.org"], "an unusable console address is ignored, never trusted");
console.log("clerk-azp: 5 checks passed");

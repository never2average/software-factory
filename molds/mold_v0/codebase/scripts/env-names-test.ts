// The shell's environment names (mold_v0-045; src/env-names.ts): APP_ for every name, the old spelling read as a fallback.
//   npm run test:env-names
// 1. readEnv / appEnv / ENV: the new name wins, the old one is the fallback, one log line per old name, a differing
//    old value beside a new one is reported as ignored, the view is live, writes and keys are the real object's.
// 2. exposeLegacyNames (a build with a host pack): the old spellings get the new values, the new one winning.
// 3. Everything the shell reads goes through it: a platform setting stored under its old key reads APP_ first, the
//    proxy hops, the image env a coding agent's sandbox may see (both spellings filtered).
// 4. A server process holding ONLY the old names (an app deployed before mold_v0-045, as on Vercel today) serves: its
//    vault opens with the old key and decrypts what was sealed under it, the fleet token is the old one, the console
//    address and proxy hops are the old ones, and it says once that each old name is deprecated. The same with only
//    the new names, and with both (the new ones win; a wrong old value is ignored).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appEnv, ENV, envLog, exposeLegacyNames, isShellEnvName, LEGACY_ENV_PREFIX, legacyEnvName, readEnv } from "../src/env-names.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OLD = (name: string) => legacyEnvName(name)!;

// ---------------------------------------------------------------- the child: a server with the given env
if (process.argv[2] === "--child") {
  const lines: string[] = [];
  envLog.warn = (l) => { lines.push(l); };
  const { getDb } = await import("../src/db.js");
  await getDb();
  const kv = await import("../src/keyvault.js");
  const sealed = process.env.SEALED ? JSON.parse(process.env.SEALED) : null;
  let opened: string | null = null;
  try { opened = sealed ? kv.decrypt(sealed) : null; } catch (e) { opened = `refused: ${(e as Error).message.slice(0, 80)}`; }
  const seal = kv.vaultUnlocked() ? kv.encrypt("sealed-under-this-key") : null;
  const { createApp } = await import("../src/http.js");
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const claim = async (token: string) => (await fetch(`${base}/api/worker/claim`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ worker_id: "w-env", limit: 1 }) })).status;
  const { consoleUrl } = await import("../src/console-url.js");
  const { proxyHops } = await import("../src/proxy-trust.js");
  const out = {
    healthz: (await fetch(`${base}/healthz`)).status, unlocked: kv.vaultUnlocked(), opened, seal,
    fleet: await claim(process.env.TRY_TOKEN ?? ""), wrong: await claim("not-the-token"), console: consoleUrl(), hops: proxyHops(), log: lines,
  };
  server.close();
  console.log(`RESULT ${JSON.stringify(out)}`);
  process.exit(0);
}

let passed = 0;
const ok = (what: string) => { passed++; console.log(`✓ ${what}`); };
const logged: string[] = [];
envLog.warn = (l) => { logged.push(l); };

// ---------------------------------------------------------------- 1. the reads
{
  assert.ok(LEGACY_ENV_PREFIX.endsWith("_") && (LEGACY_ENV_PREFIX as string) !== "APP_");
  const src: NodeJS.ProcessEnv = { [OLD("APP_ONE")]: "old-one", APP_TWO: "new-two", [OLD("APP_THREE")]: "old-three", APP_THREE: "new-three", OTHER: "x" };
  assert.equal(readEnv("APP_ONE", src), "old-one", "the old name is the fallback");
  assert.equal(readEnv("APP_TWO", src), "new-two", "the new name alone");
  assert.equal(readEnv("APP_THREE", src), "new-three", "both set: the new one wins");
  assert.equal(readEnv("APP_NONE", src), undefined, "neither: undefined (the caller's default)");
  assert.equal(readEnv("OTHER", src), "x", "a name that is not the shell's is read as it is");
  readEnv("APP_ONE", src); readEnv("APP_THREE", src);
  assert.deepEqual(logged, [
    `[env] ${OLD("APP_ONE")} is a deprecated name, read as a fallback for APP_ONE: rename it to APP_ONE (mold_v0-045).`,
    `[env] ${OLD("APP_THREE")} is set but ignored: APP_THREE is set too, and the new name wins. Remove ${OLD("APP_THREE")}.`,
  ], "one line per old name, however often it is read; an old value beside a new one is reported as ignored");
  ok("readEnv: new name wins, old name is the fallback, undefined when neither; one deprecation line per old name; a shadowed old value is reported");

  const v = appEnv(src);
  assert.equal(v.APP_ONE, "old-one");
  src[OLD("APP_LATER")] = "set-later";
  assert.equal(v.APP_LATER, "set-later", "a live view: a value set after the view was made is seen");
  src.APP_LATER = "new-later";
  assert.equal(v.APP_LATER, "new-later");
  delete src.APP_LATER;
  assert.equal(v.APP_LATER, "set-later", "a deleted new name falls back again");
  v.APP_WRITTEN = "w";
  assert.equal(src.APP_WRITTEN, "w", "writes go to the real object, under the name written");
  assert.equal(src[OLD("APP_WRITTEN")], undefined, "and never under the old one");
  assert.equal("APP_ONE" in v, false, "`in` and keys are the real object's (no name is invented)");
  assert.ok(!Object.keys(v).includes("APP_ONE"));
  assert.equal(appEnv(src), v, "one view per object");
  const before = process.env[OLD("APP_ENV_TEST")];
  process.env[OLD("APP_ENV_TEST")] = "via-process";
  assert.equal(ENV.APP_ENV_TEST, "via-process", "ENV is process.env's view");
  delete process.env[OLD("APP_ENV_TEST")];
  if (before !== undefined) process.env[OLD("APP_ENV_TEST")] = before;
  ok("appEnv / ENV: a live view of the real object; only reads fall back; writes, keys and `in` are untouched");
}

// ---------------------------------------------------------------- 2. host packs
{
  const src: NodeJS.ProcessEnv = { APP_A: "a", APP_B: "new-b", [OLD("APP_B")]: "old-b", [OLD("APP_C")]: "old-c", PATH: "/bin" };
  const set = exposeLegacyNames(src);
  assert.deepEqual(set, [OLD("APP_A"), OLD("APP_B")].sort());
  assert.deepEqual([src[OLD("APP_A")], src[OLD("APP_B")], src[OLD("APP_C")], src.APP_C], ["a", "new-b", "old-c", undefined], "the new value everywhere; an old name with no new one is left as it is");
  assert.deepEqual(exposeLegacyNames(src), [], "idempotent");
  const gen = readFileSync(path.join(ROOT, "scripts", "gen-packs.mjs"), "utf8");
  assert.match(gen, /hostPacks\.length \? `import "\.\/host-env\.js";\\n` : ""/, "the generated host list imports src/host-env.ts first when there is a host pack");
  ok("exposeLegacyNames: a host pack reading an old spelling gets the new value (the new one wins); run before any host pack's module");
}

// ---------------------------------------------------------------- 3. what the shell reads
{
  const saved = { ...process.env };
  const { ENGINE_SETTINGS, settingNumber } = await import("../src/settings.js");
  const key = ENGINE_SETTINGS.maxOrchestrators;
  assert.ok(key.startsWith(LEGACY_ENV_PREFIX), "the stored key keeps its spelling (rows on live databases, host packs read it)");
  delete process.env.APP_MAX_ORCHESTRATORS; delete process.env[key];
  assert.equal(settingNumber(key), 4, "neither: the default");
  process.env[key] = "7";
  assert.equal(settingNumber(key), 7, "the environment under the stored (old) spelling");
  process.env.APP_MAX_ORCHESTRATORS = "9";
  assert.equal(settingNumber(key), 9, "the new name wins");
  delete process.env[key];
  assert.equal(settingNumber(key), 9, "the new name alone");
  const { proxyHops } = await import("../src/proxy-trust.js");
  assert.equal(proxyHops({ [OLD("APP_PROXY_HOPS")]: "2" }), 2, "an explicit environment's old name");
  assert.equal(proxyHops({ [OLD("APP_PROXY_HOPS")]: "2", APP_PROXY_HOPS: "1" }), 1, "its new name wins");
  assert.throws(() => proxyHops({ [OLD("APP_PROXY_HOPS")]: "nine" }), /APP_PROXY_HOPS must be a whole number/, "an old value is checked like a new one");
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  assert.deepEqual([isShellEnvName("APP_WORKER_TOKEN"), isShellEnvName(OLD("APP_WORKER_TOKEN")), isShellEnvName("PATH"), isShellEnvName("NEXT_PUBLIC_APP_URL")], [true, true, false, false]);
  const runners = readFileSync(path.join(ROOT, "orchestrator", "core", "runners.ts"), "utf8");
  assert.match(runners, /list\.filter\(\(kv\) => !isShellEnvName\(/, "the image env a sandbox gets drops the shell's names under both spellings");
  ok("settings stored under their old key read APP_ first, then the old name; proxy hops; the sandbox's image env filter covers both spellings");
}

// ---------------------------------------------------------------- 3b. no production code reads a shell name around the view
{
  const { listFiles } = await import("./lib/vocabulary.js");
  const prod = listFiles(ROOT).filter((f) => /^(src|api|orchestrator)\/.*\.(ts|mts|mjs)$/.test(f) && !/(^|\/)(test|fixtures|packs|workspaces)\//.test(f) && !f.endsWith("env-names.ts"));
  const direct = prod.flatMap((f) => readFileSync(path.join(ROOT, f), "utf8").split("\n").map((l, i) => [f, i + 1, l] as const))
    .filter(([, , l]) => /process\.env\.APP_[A-Z0-9_]+(?!\s*(=(?!=)|\?\?=|\|\|=))/.test(l) && !/^\s*(\*|\/\/)/.test(l) && !/delete\s+process\.env\.APP_/.test(l))
    .map(([f, n]) => `${f}:${n}`);
  assert.deepEqual(direct, [], "every read of a shell name goes through ENV / appEnv / readEnv (its old spelling as the fallback)");
  const whole = prod.filter((f) => /=\s*process\.env\s*;/.test(readFileSync(path.join(ROOT, f), "utf8")));
  assert.deepEqual(whole, [], "no module aliases process.env itself (its dynamic reads would miss the old names): use ENV");
  ok(`${prod.length} production modules: no direct read of a shell name, no alias of process.env`);
}

// ---------------------------------------------------------------- 3c. keys a build wrote into Stripe and Clerk before mold_v0-045
{
  const { NS, NS_KEYS, LEGACY_NS, nsGet, isPlanKey, isNsKey, KEY_PREFIX } = await import("../src/namespace.js");
  const L = `${LEGACY_NS}_`;
  assert.notEqual(NS, LEGACY_NS, "this check runs on the neutral shell (namespace workspace)");
  assert.equal(nsGet({ [NS_KEYS.role]: "viewer", [`${L}role`]: "owner" }, "role"), "viewer", "the build's own key wins");
  assert.equal(nsGet({ [`${L}slug`]: "acme" }, "slug"), "acme", "a key written before mold_v0-045 is still read");
  assert.equal(nsGet(undefined, "slug"), undefined);
  assert.deepEqual([isPlanKey(`${KEY_PREFIX}starter`), isPlanKey(`${L}starter`), isPlanKey("other_starter"), isPlanKey(null)], [true, true, false, false], "plans under either prefix");
  assert.deepEqual([isNsKey(`${NS}_x`), isNsKey(`${L}x`), isNsKey("owner")], [true, true, false]);
  const { accountRoleOf } = await import("../src/account-roles.js");
  assert.equal(accountRoleOf({ role: "org:member", public_metadata: { [`${L}role`]: "viewer" } } as never), "viewer", "a Clerk membership's role written before mold_v0-045 still refines Clerk's");
  ok("Stripe and Clerk keys written under the old namespace are still read (the build's own win); plans under either prefix");
}

// ---------------------------------------------------------------- 4. a server with only the old names, only the new, both
{
  const TMP = mkdtempSync(path.join(tmpdir(), "env-names-"));
  try {
    const key = randomBytes(32).toString("base64"), key2 = randomBytes(32).toString("base64");
    const run = (env: Record<string, string>, extra: Record<string, string> = {}) => {
      const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !isShellEnvName(k) && !/^(DATABASE_URL|PGLITE_DIR|CLERK_|PUBLIC_URL)/.test(k)));
      const r = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "scripts", "env-names-test.ts"), "--child"], {
        cwd: ROOT, encoding: "utf8", timeout: 240_000,
        env: { ...clean, PGLITE_DIR: mkdtempSync(path.join(TMP, "db-")), PUBLIC_URL: "https://api.example.test", APP_AUTOSCALE: "off", REASONS_ENABLED: "off", ...env, ...extra },
      });
      const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
      assert.ok(line, `the child server ran (exit ${r.status}): ${(r.stderr ?? "").slice(-600)}`);
      return JSON.parse(line!.slice(7));
    };
    const shellOld = { [OLD("APP_VAULT_KEY")]: key, [OLD("APP_WORKER_TOKEN")]: "old-fleet-token", [OLD("APP_CONSOLE_URL")]: "https://console.old.test", [OLD("APP_PROXY_HOPS")]: "1" };
    const a = run({ ...shellOld, TRY_TOKEN: "old-fleet-token" });
    assert.deepEqual([a.healthz, a.unlocked, a.fleet, a.wrong, a.console, a.hops], [200, true, 200, 401, "https://console.old.test", 1], "old names only: the server serves on them");
    for (const n of ["APP_VAULT_KEY", "APP_WORKER_TOKEN", "APP_CONSOLE_URL", "APP_PROXY_HOPS"])
      assert.equal(a.log.filter((l: string) => l.startsWith(`[env] ${OLD(n)} is a deprecated name`)).length, 1, `${OLD(n)}: one deprecation line`);
    const b = run({ APP_VAULT_KEY: key, APP_WORKER_TOKEN: "new-fleet-token", APP_CONSOLE_URL: "https://console.new.test", APP_PROXY_HOPS: "2", TRY_TOKEN: "new-fleet-token", SEALED: JSON.stringify(a.seal) });
    assert.deepEqual([b.healthz, b.opened, b.fleet, b.wrong, b.console, b.hops, b.log], [200, "sealed-under-this-key", 200, 401, "https://console.new.test", 2, []],
      "new names only: the same key under its new name opens what was sealed under the old one; nothing is logged");
    const c = run({ ...shellOld, APP_VAULT_KEY: key, APP_WORKER_TOKEN: "new-fleet-token", APP_CONSOLE_URL: "https://console.new.test", TRY_TOKEN: "old-fleet-token", SEALED: JSON.stringify(a.seal) });
    assert.deepEqual([c.opened, c.fleet, c.console, c.hops], ["sealed-under-this-key", 401, "https://console.new.test", 1], "both: the new names win (the old fleet token no longer works), an old name with no new one still applies");
    assert.ok(c.log.some((l: string) => l.startsWith(`[env] ${OLD("APP_WORKER_TOKEN")} is set but ignored`)), "and the ignored old value is reported");
    const d = run({ [OLD("APP_VAULT_KEY")]: key, APP_VAULT_KEY: key2, SEALED: JSON.stringify(a.seal) });
    assert.match(d.opened, /^refused: Credential was encrypted with master key/, "a different key minted under the new name would shadow the old one: why the factory never mints a new name an old one holds");
    ok("a server with only the old names serves (vault, fleet token, console address, proxy hops) and logs each once; only the new names too; both: the new ones win");
  } finally { rmSync(TMP, { recursive: true, force: true }); }
}
console.log(`\nenv names: ${passed} checks passed`);
process.exit(0);

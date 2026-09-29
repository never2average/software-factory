/**
 * A LINK TO A CHAT CARRIES ITS WORKSPACE, AND EACH TAB KEEPS ITS OWN.
 *
 * Sessions are gated in the ONE workspace a request names (lib/session-gate.ts). A person in two workspaces then got a
 * 404 for:
 *   · a deep link or a desktop notification for a chat in the workspace they were NOT currently in — the URL named
 *     the session, never its workspace, and the page opened it in whichever workspace was selected;
 *   · a second tab on another workspace — the chosen workspace lived in localStorage (shared by every tab), and the
 *     agent ignored the tab's `x-ops-org` and used whichever workspace was selected last.
 *
 * Driven here without a browser: the <head> script (lib/startup-fetch.ts startupScript) in a VM with its own
 * localStorage / sessionStorage / location; the per-tab workspace helpers; the notification payload; the invite
 * link; and the wiring of the proxy, the page and the notification bridge. The agent side (a header naming a
 * workspace the caller belongs to is the request's workspace; one they do not belong to is ignored) is driven through
 * the real guarded channel in scripts/test-session-guard.mjs.
 *
 *   npm run test:workspace-deep-link
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
};
const attempt = async (fn) => {
  try {
    return { threw: false, value: await fn() };
  } catch (error) {
    return { threw: true, message: String(error?.message ?? error) };
  }
};
const src = (p) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

class MemoryStorage {
  constructor(init = {}) {
    this.m = new Map(Object.entries(init));
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    this.m.set(k, String(v));
  }
  removeItem(k) {
    this.m.delete(k);
  }
}

const { STORAGE_KEYS } = await import("../lib/browser-storage.ts");
const exp = Math.floor(Date.now() / 1000) + 3600;
const token = `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;

/** Run the real <head> script in a tab: returns the headers of its early reads, and the tab's storage after. */
async function headScript({ search = "", local = {}, session = {} }) {
  const { startupScript } = await import("../lib/startup-fetch.ts");
  const localStorage = new MemoryStorage({ [STORAGE_KEYS.token]: token, ...local });
  const sessionStorage = new MemoryStorage(session);
  const sent = [];
  const ctx = {
    localStorage,
    sessionStorage,
    location: { pathname: "/", search, href: `http://app.test/${search}` },
    document: { documentElement: { setAttribute() {} } },
    window: {},
    atob: (b) => Buffer.from(b, "base64").toString("binary"),
    URLSearchParams,
    Date,
    JSON,
    fetch: (u, init) => {
      sent.push({ url: u, headers: init?.headers ?? {} });
      return Promise.resolve({ status: 200, text: () => Promise.resolve("{}") });
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(startupScript(), ctx);
  return { sent, localStorage, sessionStorage };
}

console.log("\n1. A deep link opens its chat in the workspace it names");
{
  const tab = await headScript({ search: "?chatSession=wrun_x&org=org-b", local: { [STORAGE_KEYS.activeOrg]: "org-a" } });
  check("the first-screen reads of a `?org=` link carry that workspace", tab.sent.length > 0 && tab.sent.every((r) => r.headers["x-ops-org"] === "org-b"), tab.sent.map((r) => r.headers["x-ops-org"]));
  check("…and the tab adopts it (per-tab storage)", tab.sessionStorage.getItem(STORAGE_KEYS.activeOrg) === "org-b");
  check("…without changing the default for new tabs (a guest's link must not move their own workspace)", tab.localStorage.getItem(STORAGE_KEYS.activeOrg) === "org-a");
  const opsLibSrc = src("app/_components/ops/lib.ts");
  check("the page's switch makes a workspace the default only once the server accepts the person as a member", /writeStored\(ACTIVE_ORG_KEY, orgId, "session"\)/.test(opsLibSrc) && /if \(accepted\) setActiveOrg\(orgId\)/.test(opsLibSrc));
  const junk = await headScript({ search: "?chatSession=wrun_x&org=%3Cscript%3E", local: { [STORAGE_KEYS.activeOrg]: "org-a" } });
  check("a malformed `org` is ignored (the stored workspace stands)", junk.sent.every((r) => r.headers["x-ops-org"] === "org-a"), junk.sent.map((r) => r.headers["x-ops-org"]));

  const shell = src("app/_components/chat-shell.tsx");
  check("the page adopts the link's workspace (the switcher's server call) before it opens the chat", /adoptLinkedWorkspace\(/.test(shell) && shell.indexOf("adoptLinkedWorkspace(") < shell.indexOf("mountEveSession(id)"), null);

  const { notificationFor } = await import("../agent/lib/notification-text.ts");
  const n = notificationFor({ kind: "reply", sessionId: "wrun_n", text: "done" }, "Chat", true, "org-b");
  check("a desktop notification's URL names the chat's workspace", new URL(n.url, "http://x").searchParams.get("org") === "org-b" && new URL(n.url, "http://x").searchParams.get("chatSession") === "wrun_n", n.url);
  const push = src("agent/lib/push-notify.ts");
  check("…and the sender passes the session's workspace", /notificationFor\(ev, t\.title, t\.preview, owner\.orgId\)/.test(push));
  const notify = src("app/_components/desktop-notify.ts");
  const sw = readFileSync("public/sw.js", "utf8");
  check("a click on it in an open tab of ANOTHER workspace opens the linked URL (which switches), not the bare session", /onOpenChat\(m\.sessionId, m\.url/.test(notify) && /postMessage\(\{ type: "open-chat", sessionId: [^}]*url/.test(sw) && /workspaceOfLink\(|searchParams\.get\("org"\)/.test(shell), null);
  const invite = src("app/api/ops/threads/[id]/members/route.ts");
  check("a shared-thread invite link names the thread's workspace", /chatSession=\$\{encodeURIComponent\(access\.thread\.eveSessionId\)\}&org=\$\{encodeURIComponent\(access\.thread\.orgId\)\}/.test(invite));
}

console.log("\n2. Two tabs, two workspaces: each tab keeps its own");
{
  const tabA = await headScript({ search: "", local: { [STORAGE_KEYS.activeOrg]: "org-b" }, session: { [STORAGE_KEYS.activeOrg]: "org-a" } });
  check("a tab's own workspace wins over the one another tab chose last", tabA.sent.every((r) => r.headers["x-ops-org"] === "org-a"), tabA.sent.map((r) => r.headers["x-ops-org"]));
  const storage = await import("../lib/browser-storage.ts");
  const r = await attempt(() => {
    const saved = { l: globalThis.localStorage, s: globalThis.sessionStorage, w: globalThis.window };
    globalThis.localStorage = new MemoryStorage({ [STORAGE_KEYS.activeOrg]: "org-b" });
    globalThis.sessionStorage = new MemoryStorage({ [STORAGE_KEYS.activeOrg]: "org-a" });
    globalThis.window = globalThis; // a browser tab: `window.localStorage` / `window.sessionStorage`
    try {
      const inThisTab = storage.readActiveOrg();
      storage.writeActiveOrg("org-c");
      return { inThisTab, session: globalThis.sessionStorage.getItem(STORAGE_KEYS.activeOrg), local: globalThis.localStorage.getItem(STORAGE_KEYS.activeOrg) };
    } finally {
      globalThis.localStorage = saved.l;
      globalThis.sessionStorage = saved.s;
      globalThis.window = saved.w;
    }
  });
  check("readActiveOrg() is the tab's own choice first", !r.threw && r.value.inThisTab === "org-a", r);
  check("writeActiveOrg() sets this tab's choice and the default for new tabs", !r.threw && r.value.session === "org-c" && r.value.local === "org-c", r);
  const gate = src("app/_components/auth-gate.tsx");
  const opsLib = src("app/_components/ops/lib.ts");
  check("every request header comes from the tab's workspace (auth gate and ops fetch)", /readActiveOrg\(\)/.test(gate) && /readActiveOrg\(\)/.test(opsLib) && !/readStored\(STORAGE_KEYS\.activeOrg\)/.test(gate));
  const signOut = gate.slice(gate.indexOf("const signOut"), gate.indexOf("const signOut") + 1500);
  check("signing out forgets the chosen workspace (this tab's, and the default for new tabs)", /writeActiveOrg\(null\)/.test(signOut), null);
  const proxy = src("app/eve/v1/session/[...segments]/route.ts");
  check("the /eve proxy passes the tab's workspace to the agent", /\["authorization", "content-type", "accept", ORG_HEADER\]/.test(proxy));
  const scope = src("agent/lib/service-scope.ts");
  check("the agent takes a person's workspace from that header (membership is checked by orgForSession)", /WORKSPACE_PIN_HEADER/.test(scope) && /sessionAuthForRequest/.test(scope));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}

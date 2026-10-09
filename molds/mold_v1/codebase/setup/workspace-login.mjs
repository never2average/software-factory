#!/usr/bin/env node
/**
 * The login command — sign this package's MCP server in as YOU, once. Two ways in:
 *
 *   npx <this package> login                           with Google (a work account)
 *   npx <this package> login --email you@company.com   with a six-digit code sent to your inbox
 *
 * (In the generic package in setup/ the command and this file are called
 * `workspace-login`, and the name they had before still works; a package built for
 * a deployment names both after itself. The name lives in deployment.generated.mjs,
 * never in this file.)
 *
 * GOOGLE (the default, unchanged):
 *
 * Runs the OAuth 2.0 installed-app loopback flow (the same shape as `gcloud auth
 * login` / `gh auth login`): opens your browser for consent, catches the code on
 * 127.0.0.1, exchanges it with PKCE, and stores the refresh token at CRED_PATH
 * below (mode 600). After that, the MCP server mints a fresh Google ID token for
 * each session and presents THAT to the Ops API — so connectors/workflows/crons
 * carry your real identity, not a shared key.
 *
 *   npx <this package> login --url https://app.example.com
 *
 * `--url` (or WORKSPACE_OPS_URL) is YOUR deployment's address. It is saved beside the
 * credentials so the MCP server knows which deployment to talk to without any env.
 *
 * WHICH ADDRESS, in order: `--url` / WORKSPACE_OPS_URL, then the address saved at
 * sign-in, then the one BAKED INTO this package (deployment.generated.mjs). The
 * generic package bakes in none: a default there would point everyone but one
 * product at somebody else's app. A package built FOR a deployment
 * (scripts/build-agent-cli.mjs, docs/AGENT_CLI.md) bakes in that deployment's,
 * so `npx <package> login` needs no configuration.
 *
 * EMAILED CODE (`--email <address>`), for people Google cannot vouch for: asks the
 * deployment to email a code (POST /api/auth/email/request), reads the code from
 * the terminal, trades it for a session token (POST /api/auth/email/verify) and
 * stores that token with its expiry in the same credentials file. The MCP server
 * presents it as the bearer until it expires; there is no refresh, so after that
 * you sign in again. The token is never printed.
 *   --code <digits>   you already have a code: verify it, send no new one (a new
 *                     code cancels the one before it). With stdin not a terminal
 *                     the code is read from stdin instead of prompted for.
 *
 * Config (env, both optional):
 *   WORKSPACE_OAUTH_CLIENT_ID      use this Google installed-app client instead of the built-in one
 *   WORKSPACE_OAUTH_CLIENT_SECRET  ...and its secret
 *
 * The built-in client is the one the package was BUILT with: its id and secret
 * live in deployment.generated.mjs, written by scripts/build-agent-cli.mjs from
 * the deployment's own settings, and never in this file. It is a Google *desktop
 * (installed-app)* client; Google's own docs say such a secret "is not treated as
 * a secret" — an installed app cannot keep one — so it ships inside the built
 * package. It grants nothing on its own: every token still needs an interactive
 * work-account sign-in, and the deployment re-verifies each one. A package built
 * without one (the generic package in setup/, or a build with
 * --email-sign-in-only) signs in by emailed code.
 */
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEPLOYMENT } from "./deployment.generated.mjs";

/**
 * Configuration variables. Loaded by ROLE like every other sibling here, so a package built for a deployment finds
 * its own file.
 */
const tools = await import(DEPLOYMENT.modules.tools);
const envValue = (name, env = process.env) => tools.envValue(env, name);

/**
 * The Google installed-app client: the environment first (a team that mints its
 * own), then the one this package was BUILT with (deployment.generated.mjs,
 * filled by scripts/build-agent-cli.mjs from the deployment's settings). Never a
 * value in this file: the source is public and the same for every deployment.
 * A package built without one signs in by emailed code only.
 */
const CLIENT_ID = envValue("WORKSPACE_OAUTH_CLIENT_ID") ?? DEPLOYMENT.googleSignIn?.clientId ?? null;
const CLIENT_SECRET = envValue("WORKSPACE_OAUTH_CLIENT_SECRET") ?? DEPLOYMENT.googleSignIn?.clientSecret ?? null;
const SCOPE = "openid email profile";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Where the login is kept: ~/.config/<this package's own folder>/<the deployment's
 * host>/credentials.json. The host segment means signing in to a second product
 * never repoints the first (the saved address outranks the baked-in one, and a
 * shared file would let the last login win for every package). The PARENT is this
 * package's own name, from deployment.generated.mjs — it used to be the base
 * product's initials in every package, so a desk that bought one product found
 * another company's name in a folder on their laptop.
 */
const BAKED_HOST = DEPLOYMENT.origin ? new URL(DEPLOYMENT.origin).host.replace(/[^a-z0-9.-]/gi, "_") : null;
const CONFIG_DIR = DEPLOYMENT.configDir;
const under = (parent) => (BAKED_HOST ? join(homedir(), ".config", parent, BAKED_HOST) : join(homedir(), ".config", parent));
export const CRED_DIR = under(CONFIG_DIR);
export const CRED_PATH = join(CRED_DIR, "credentials.json");

/** The stored sign-in, or null. */
export async function readCredentials({ path = CRED_PATH } = {}) {
  return readFile(path, "utf8").then(JSON.parse).catch(() => null);
}

/** "app.example.com/x" -> "https://app.example.com". Null when it is not an address. */
export function toOrigin(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).origin;
  } catch {
    return null;
  }
}

/**
 * Which deployment, and how we know. ONE rule for login and the MCP server:
 *   1. explicit: `--url <address>`, else WORKSPACE_OPS_URL
 *   2. the address saved at sign-in
 *   3. the address baked into this package (none in the generic package)
 * Returns { origin, source } with origin null when nothing says.
 */
export function resolveDeploymentAddress({ argv = process.argv, env = process.env, saved = null } = {}) {
  const i = argv.indexOf("--url");
  const fromEnv = envValue("WORKSPACE_OPS_URL", env);
  const explicit = (i > -1 ? argv[i + 1] : fromEnv)?.trim();
  if (explicit) {
    const origin = toOrigin(explicit);
    if (!origin) throw new Error(`"${explicit}" is not an address. Example: --url https://app.example.com`);
    return { origin, source: i > -1 ? "--url" : "WORKSPACE_OPS_URL" };
  }
  const savedOrigin = toOrigin(saved?.ops_url);
  if (savedOrigin) return { origin: savedOrigin, source: "saved login" };
  if (DEPLOYMENT.origin) return { origin: DEPLOYMENT.origin, source: "built into this package" };
  return { origin: null, source: "none" };
}

/** The deployment this login is for. A NEW login is not steered by an old one: explicit, else baked in, else null. */
function deploymentAddress() {
  try {
    return resolveDeploymentAddress().origin;
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Copy `text` to the system clipboard. Resolves false when there is no
 * clipboard tool rather than throwing — a missing xclip is not a login failure.
 */
function copyToClipboard(text) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["pbcopy", []]
      : process.platform === "win32"
        ? ["clip", []]
        : // Wayland first: on a Wayland session xclip exists but silently
          // writes to an X clipboard nothing is reading.
          [process.env.WAYLAND_DISPLAY ? "wl-copy" : "xclip", process.env.WAYLAND_DISPLAY ? [] : ["-selection", "clipboard"]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Press `c` to copy the sign-in URL while we wait for the callback.
 *
 * The URL is ~400 characters of query string; selecting it out of a terminal
 * by hand is exactly where people mangle it and then see an opaque OAuth error.
 * This matters most when the browser did NOT open — SSH, headless, or a default
 * browser that is not the one you are signed into.
 *
 * Returns a cleanup function. Raw mode is required to catch a single keypress
 * without Enter, and raw mode STOPS Ctrl-C from raising SIGINT, so \x03 is
 * handled explicitly — otherwise this would make the login unquittable.
 */
function enableCopyShortcut(url) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};

  const onKey = async (buf) => {
    const key = buf.toString();
    if (key === "\u0003") {
      cleanup();
      process.exit(130); // 128 + SIGINT, what a shell expects from Ctrl-C
    }
    if (key.toLowerCase() === "c") {
      const ok = await copyToClipboard(url);
      console.error(ok ? "Copied the sign-in URL to your clipboard." : "Couldn't reach a clipboard tool — copy the URL above by hand.");
    }
  };

  const cleanup = () => {
    stdin.off("data", onKey);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onKey);
  return cleanup;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}

// ------------------------------------------------------------ sign-in by emailed code

/** What marks a stored credential as an emailed-code session (vs. a Google login). */
export const EMAIL_SESSION_KIND = "email-session";

/** The value after `flag` in argv, or null. A following flag is not a value. */
function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? "" : v.trim();
}

/**
 * POST JSON to one of the deployment's sign-in routes. Resolves the parsed body;
 * rejects with a sentence a person can read: the server's own (`error`) when it
 * sent one, else one for the status. Never includes the response body otherwise,
 * so a token can't end up in an error message.
 */
async function postAuth(origin, path, body, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`Could not reach ${origin}. Check the address and your connection. (${e?.cause?.code ?? e?.name ?? "network error"})`);
  }
  const parsed = await res.json().catch(() => null);
  if (res.ok && parsed && typeof parsed === "object") return parsed;
  if (typeof parsed?.error === "string" && parsed.error.trim()) throw new Error(parsed.error.trim());
  if (res.status === 429) throw new Error("Too many attempts. Wait a while, then try again.");
  if (res.status === 503) throw new Error("Email sign-in is not set up on this deployment.");
  if (res.status === 404) throw new Error(`${origin} has no email sign-in. Check the address.`);
  throw new Error(`${origin} could not do that right now (HTTP ${res.status}).`);
}

/** Ask the deployment to email a code. Resolves the sentence it answers with. */
export async function requestEmailCode({ origin, email, fetchImpl }) {
  const out = await postAuth(origin, "/api/auth/email/request", { email }, fetchImpl);
  return typeof out.message === "string" ? out.message : "If that address can sign in, a code is on its way.";
}

/**
 * Trade the code for a session, shaped as it is stored:
 *   { kind: "email-session", session_token, email, expires_at (epoch seconds), ops_url }
 * `expires_at` is the server's `expiresIn`, else the token's own `exp` claim.
 */
export async function verifyEmailCode({ origin, email, code, fetchImpl, now = Date.now() }) {
  const out = await postAuth(origin, "/api/auth/email/verify", { email, code }, fetchImpl);
  if (typeof out.token !== "string" || !out.token) throw new Error("The deployment accepted the code but sent no session. Try again.");
  let expiresAt = Number.isFinite(out.expiresIn) && out.expiresIn > 0 ? Math.floor(now / 1000) + Math.floor(out.expiresIn) : 0;
  if (!expiresAt) {
    try {
      expiresAt = Number(JSON.parse(Buffer.from(out.token.split(".")[1], "base64url").toString()).exp) || 0;
    } catch {
      /* not a token we can read */
    }
  }
  if (!expiresAt) throw new Error("The deployment sent a session without an expiry. Try again.");
  return {
    kind: EMAIL_SESSION_KIND,
    session_token: out.token,
    email: typeof out.email === "string" ? out.email : email,
    expires_at: expiresAt,
    ops_url: origin,
  };
}

/**
 * How the MCP server reads a stored credential. Null when it is not an email session
 * (a Google login: the caller refreshes that as before). Otherwise the bearer,
 * or `expired` with the sentence to show — these sessions cannot be refreshed.
 */
export function emailSessionBearer(creds, { now = Date.now() } = {}) {
  if (creds?.kind !== EMAIL_SESSION_KIND) return null;
  const email = typeof creds.email === "string" ? creds.email : "unknown";
  if (typeof creds.session_token === "string" && creds.session_token && Number(creds.expires_at) - now / 1000 > 60) {
    return { bearer: creds.session_token, email, expired: false };
  }
  return {
    bearer: null,
    email,
    expired: true,
    message: `Your email sign-in has expired. Run \`npx ${DEPLOYMENT.packageName} ${DEPLOYMENT.commands.login} --email ${email}\` in a terminal to sign in again.`,
  };
}

/** Six digits out of whatever was typed or piped ("123 456", a trailing newline). Null otherwise. */
export function parseCode(raw) {
  const digits = String(raw ?? "").replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** The code from a person (a prompt on the terminal) or from a pipe (all of stdin). */
async function readCodeFromStdin(stdin = process.stdin) {
  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: process.stderr });
    try {
      return await new Promise((resolve) => rl.question("Six-digit code: ", resolve));
    } finally {
      rl.close();
    }
  }
  let text = "";
  for await (const chunk of stdin) text += chunk;
  return text;
}

/**
 * The whole emailed-code sign-in. Throws plain sentences; writes the credential
 * (mode 600) and resolves what was stored. `--code` verifies without requesting:
 * each new code cancels the last, so asking again would void the one in hand.
 */
export async function emailLogin({ argv = process.argv, env = process.env, stdin = process.stdin, fetchImpl, credDir = CRED_DIR, log = (line) => console.error(line) } = {}) {
  const email = flagValue(argv, "--email")?.toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--email needs an email address. Example: --email you@company.com");
  const { origin } = resolveDeploymentAddress({ argv, env });
  if (!origin) throw new Error("Signing in by email needs your deployment's address. Add --url <address> (the one you open in a browser).");

  const given = flagValue(argv, "--code");
  let code;
  if (given !== null) {
    code = parseCode(given);
    if (!code) throw new Error("--code needs the six digits from the email.");
  } else {
    log(await requestEmailCode({ origin, email, fetchImpl }));
    code = parseCode(await readCodeFromStdin(stdin));
    if (!code) throw new Error("That is not a six-digit code. When you have it, run this again with --code <digits> (no new code is sent).");
  }

  const creds = await verifyEmailCode({ origin, email, code, fetchImpl });
  const path = join(credDir, "credentials.json");
  await mkdir(credDir, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
  // writeFile's mode only applies to a NEW file; a Google login may already be there.
  await chmod(path, 0o600);
  const until = new Date(creds.expires_at * 1000).toISOString().slice(0, 10);
  log(`\nSigned in as ${creds.email} until ${until}. Credentials stored at ${path}.`);
  log(`The MCP will now act as you on ${origin}.\n`);
  return creds;
}

async function main() {
  if (process.argv.includes("--email")) {
    await emailLogin();
    return;
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error(
      "Google sign-in is not set up in this package (it was built without a Google client).\n" +
        `Sign in with a code emailed to you instead: ${DEPLOYMENT.commands.login} --email <your work address>\n` +
        "(Or set WORKSPACE_OAUTH_CLIENT_ID and WORKSPACE_OAUTH_CLIENT_SECRET to your team's own Google desktop client.)",
    );
    process.exit(1);
  }
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  // Set once the URL is printed; always released before we return, so the
  // terminal is never left in raw mode.
  let stopCopyShortcut = () => {};

  // The loopback listener on an ephemeral port. Google auto-allows 127.0.0.1
  // redirects for desktop clients, so no port needs registering.
  // Captured when the listener binds. It must NOT be read off the server after
  // `close()` — Node then returns null from address() and the callback threw
  // "Cannot read properties of null (reading 'port')" right after a successful
  // sign-in, losing the code we had just received.
  let redirectUri = "";

  const { code } = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      res.writeHead(200, { "content-type": "text/html" });
      if (err || !got || gotState !== state) {
        res.end("<h2>Sign-in failed.</h2><p>You can close this tab and try again.</p>");
        server.close();
        reject(new Error(err ?? (gotState !== state ? "state mismatch" : "no code")));
        return;
      }
      res.end("<h2>Signed in.</h2><p>You can close this tab and return to your terminal.</p>");
      server.close();
      resolve({ code: got });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const auth = new URL(AUTH_URL);
      auth.search = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();
      console.error(`\nOpening your browser to sign in…\nIf it doesn't open, visit:\n${auth}\n`);
      if (process.stdin.isTTY) console.error("Press c to copy the URL, Ctrl-C to cancel.\n");
      stopCopyShortcut = enableCopyShortcut(auth.toString());
      openBrowser(auth.toString());
    });
    // .finally, not a statement after the await: a rejected callback (consent
    // denied, state mismatch) would skip the release and leave stdin in raw
    // mode with Ctrl-C dead for the rest of the session.
  }).finally(() => stopCopyShortcut());

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || !tokens.refresh_token) {
    console.error(`Token exchange failed: ${tokens.error_description ?? tokens.error ?? tokenRes.status}`);
    if (!tokens.refresh_token && tokens.id_token) {
      console.error("Got an ID token but no refresh token — re-run; the consent must include offline access.");
    }
    process.exit(1);
  }

  // Who did we just sign in as? (Read the id_token claims, don't verify here —
  // the Ops API verifies on every call.)
  let who = "unknown";
  try {
    const claims = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
    who = claims.email ?? "unknown";
    if (!claims.hd) {
      console.error(
        `\nWarning: ${who} is a personal Google account. Google sign-in here only admits WORK accounts (a Google Workspace domain).`,
      );
    }
  } catch {
    /* ignore */
  }

  const opsUrl = deploymentAddress();
  await mkdir(CRED_DIR, { recursive: true, mode: 0o700 });
  await writeFile(
    CRED_PATH,
    JSON.stringify(
      { refresh_token: tokens.refresh_token, id_token: tokens.id_token, email: who, ...(opsUrl ? { ops_url: opsUrl } : {}) },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.error(`\nSigned in as ${who}. Credentials stored at ${CRED_PATH}.`);
  if (opsUrl) {
    console.error(`The MCP will now act as you on ${opsUrl}.\n`);
  } else {
    console.error(
      "No deployment address was saved. Set WORKSPACE_OPS_URL=<your deployment's address> in the MCP server's env,\n" +
        `or re-run with: ${DEPLOYMENT.commands.login} --url <your deployment's address>\n`,
    );
  }
}

/**
 * Only sign in when RUN as a command. The MCP server imports this module just to
 * reuse CRED_PATH and readCredentials, and without a guard that import kicked off an interactive
 * browser login every time the MCP server started.
 *
 * Compare REAL paths, not URLs: npm installs bins as symlinks
 * (node_modules/.bin/<name>-login -> ../<package>/<name>-login.mjs), and on
 * macOS /tmp is itself a symlink — so a naive `import.meta.url === argv[1]`
 * check never matched and the command silently did nothing. Fail OPEN: if we
 * can't tell, run the login (an extra prompt beats a no-op).
 *
 * Exported, with the command below, for the file kept at this module's old name.
 */
export function isEntrypointFile(fileUrl) {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(fileUrl));
  } catch {
    return true;
  }
}

/**
 * The command itself: `--help`, or the sign-in. Exported so the file kept at this
 * module's pre-rename name (a one-line re-export, for a `node setup/<old name>` in an
 * engineer's notes or MCP config) runs the same command when IT is what node was
 * asked to run; the guard above only recognises this file.
 */
let commandStarted = false;
export function runLoginCommand() {
  if (commandStarted) return;
  commandStarted = true;
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    const d = DEPLOYMENT;
    console.error(
      [
        `${d.commands.login} - sign in to ${d.origin ? `${d.name} at ${d.origin}` : "your deployment"}: with your work Google account, or with a code emailed to you.`,
        "",
        d.origin
          ? `  npx ${d.packageName} ${d.commands.login}                  Google; the address is built in`
          : `  npx ${d.packageName} ${d.commands.login} --url <address>  Google; your deployment's address (or WORKSPACE_OPS_URL)`,
        `  npx ${d.packageName} ${d.commands.login} --email <address>${d.origin ? "" : " --url <address>"}  a six-digit code is emailed to you; type it here`,
        ...(d.origin ? [`  npx ${d.packageName} ${d.commands.login} --url <address>  another address (or WORKSPACE_OPS_URL)`] : []),
        "",
        "  --code <digits>  with --email: verify a code you already have (no new one is sent).",
        "                   When stdin is not a terminal the code is read from stdin.",
        "",
        `Google opens your browser, then stores a refresh token at ${CRED_PATH} (mode 600).`,
        "An emailed code stores a session there instead; it lasts about a week, then you sign in again.",
        "Nothing is sent anywhere except Google and the deployment you sign in to.",
      ].join("\n"),
    );
    process.exit(0);
  }
  main().catch((e) => {
    console.error(`login failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

if (isEntrypointFile(import.meta.url)) runLoginCommand();

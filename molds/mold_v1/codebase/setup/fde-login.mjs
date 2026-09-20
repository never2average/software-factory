#!/usr/bin/env node
/**
 * fde-login — sign the setup MCP in as YOU, with Google, once.
 *
 *   node setup/fde-login.mjs
 *
 * Runs the OAuth 2.0 installed-app loopback flow (the same shape as `gcloud auth
 * login` / `gh auth login`): opens your browser for consent, catches the code on
 * 127.0.0.1, exchanges it with PKCE, and stores the refresh token at
 * ~/.config/fde-mcp/credentials.json (mode 600). After that, `fde-mcp.mjs` mints
 * a fresh @onfinance.in ID token for each session and presents THAT to the Ops
 * API — so connectors/workflows/crons carry your real identity, not a shared key.
 *
 *   node setup/fde-login.mjs --url https://app.example.com
 *
 * `--url` (or FDE_OPS_URL) is YOUR deployment's address. It is saved beside the
 * credentials so `fde-mcp` knows which deployment to talk to without any env.
 * There is no built-in address: every application stamped from this codebase
 * ships this same package, so a default would point everyone but one product at
 * somebody else's app.
 *
 * Config (env, both optional — sensible defaults are baked in):
 *   FDE_OAUTH_CLIENT_ID       override the shared onfinance.in CLI client
 *   FDE_OAUTH_CLIENT_SECRET   override the baked-in desktop-client secret
 *
 * The client ID and secret below are for a Google *desktop (installed-app)*
 * OAuth client. Google's own docs say such a secret "is not treated as a secret"
 * — an installed app can't keep one, so it's meant to ship in the source. It
 * grants nothing on its own: every token still requires an interactive
 * @onfinance.in sign-in, and the Ops API re-verifies each one. So it lives here,
 * in the repo, available to anyone with repo access — no per-dev setup.
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const CLIENT_ID =
  process.env.FDE_OAUTH_CLIENT_ID ??
  "865110163807-dsiua8j7v253dqngcccechjbc4a14scp.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.FDE_OAUTH_CLIENT_SECRET ?? "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";
const SCOPE = "openid email profile";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const CRED_DIR = join(homedir(), ".config", "fde-mcp");
export const CRED_PATH = join(CRED_DIR, "credentials.json");

/** The deployment this login is for: `--url <address>`, else FDE_OPS_URL, else null. Origin only. */
function deploymentAddress() {
  const i = process.argv.indexOf("--url");
  const raw = (i > -1 ? process.argv[i + 1] : process.env.FDE_OPS_URL)?.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.origin;
  } catch {
    console.error(`"${raw}" is not an address. Example: --url https://app.example.com`);
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

async function main() {
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
      "No deployment address was saved. Set FDE_OPS_URL=<your deployment's address> in the MCP server's env,\n" +
        "or re-run with: fde-login --url <your deployment's address>\n",
    );
  }
}

/**
 * Only sign in when RUN as a command. `fde-mcp` imports this module just to
 * reuse CRED_PATH, and without a guard that import kicked off an interactive
 * browser login every time the MCP server started.
 *
 * Compare REAL paths, not URLs: npm installs bins as symlinks
 * (node_modules/.bin/fde-login -> ../@delivery-agents/cli/fde-login.mjs), and on
 * macOS /tmp is itself a symlink — so a naive `import.meta.url === argv[1]`
 * check never matched and the command silently did nothing. Fail OPEN: if we
 * can't tell, run the login (an extra prompt beats a no-op).
 */
const isEntrypoint = (() => {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
})();

if (isEntrypoint) {
  main().catch((e) => {
    console.error(`login failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

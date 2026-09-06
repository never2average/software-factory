// fde:sandbox — check (and repair) the Vercel Sandbox TEMPLATES the deployed
// agent needs. Every eve agent node (root + each subagent) runs its bash tools
// in a sandbox created from a named template snapshot in the Vercel project.
// The template key is derived from the sandbox source + eve version, and a
// deployed function CANNOT build one on demand — its compiled artifacts are
// bundled, not on disk, so eve rethrows:
//
//   Sandbox template "eve-sbx-tpl-vercel-…" is not provisioned for backend
//   "vercel". Run `eve build` or invoke `prewarmAppSandboxes()` before serving
//   traffic.
//
// which surfaces to the user as "the sandbox won't spin up" on every bash call.
// Templates are normally built by `eve build` inside the Vercel builder; a
// prebuilt deploy, a skipped prewarm (`eve build --skip-sandbox-prewarm`) or a
// half-failed prewarm leaves prod with a missing template and no way back.
// This script closes that gap from a laptop.
//
//   npm run fde:sandbox -- --check     # report which templates are missing (exit 1 if any)
//   npm run fde:sandbox                # build the missing ones (idempotent; existing are reused)
//
// Credentials: run against the AGENT API project, not the front-end one.
//   mkdir -p /tmp/eve-link && cd /tmp/eve-link
//   npx vercel link --yes --project fde-agent-api && npx vercel env pull
// then run this script with `--env-file` pointing at that .env.local, or export
// VERCEL_OIDC_TOKEN + VERCEL_PROJECT_ID yourself.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { glyph, hasFlag, flag } from "./lib/fde.mjs";

// The eve agent's Vercel project (fde-agent-api). The template key is scoped by
// project id, so pointing at the front-end project computes keys nobody uses.
const DEFAULT_PROJECT_ID = "prj_TtcQ62CjN1tn8cG5Vg1IaRm4S7tX";
const APP_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

function resolveEveModule(relativePath) {
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  return pathToFileURL(join(eveRoot, relativePath)).href;
}

/** Ask the Sandbox API whether a named template exists and has a snapshot. */
async function lookupTemplate(name, token) {
  const url =
    `https://vercel.com/api/v2/sandboxes?limit=1&sortBy=name` +
    `&namePrefix=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sandbox API ${res.status}: ${body.slice(0, 300)}`);
  }
  const { sandboxes = [] } = await res.json();
  const match = sandboxes.find((s) => s.name === name);
  return match?.currentSnapshotId ? { snapshotId: match.currentSnapshotId } : null;
}

async function main() {
  const check = hasFlag("check");
  const projectId = (flag("project") || process.env.VERCEL_PROJECT_ID || DEFAULT_PROJECT_ID).trim();
  /**
   * `--env-file` as OUR flag, not node's.
   *
   * The message below tells you to re-run "with --env-file pointing at it", but
   * that is a node flag: `npm run fde:sandbox -- --env-file x` hands it to this
   * script, node never sees it, and you get the same error again. Reading it
   * here makes the instruction true.
   */
  const envFile = flag("env-file");
  if (envFile) {
    try {
      for (const line of readFileSync(envFile, "utf8").split("\n")) {
        const i = line.indexOf("=");
        if (i < 1 || line.trimStart().startsWith("#")) continue;
        const key = line.slice(0, i).trim();
        // Never override something the caller exported deliberately.
        if (!process.env[key]) {
          process.env[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
        }
      }
    } catch (e) {
      console.error(`${glyph.bad} Could not read ${envFile}: ${e.message}`);
      process.exit(1);
    }
  }

  const token = (process.env.VERCEL_OIDC_TOKEN ?? process.env.VERCEL_TOKEN ?? "").trim();
  if (!token) {
    console.error(
      `${glyph.bad} No VERCEL_OIDC_TOKEN (or VERCEL_TOKEN) in the environment.\n` +
        `  The token must come from the AGENT project (fde-agent-api) — this\n` +
        `  repo's .env.local belongs to the front-end and has no OIDC token.\n` +
        `  Link a scratch dir, pull one, and point this at it:\n` +
        `    mkdir -p /tmp/eve-link && (cd /tmp/eve-link && \\\n` +
        `      npx vercel link --yes --project fde-agent-api && npx vercel env pull)\n` +
        `    npm run fde:sandbox -- --check --env-file /tmp/eve-link/.env.local`,
    );
    process.exit(1);
  }

  // Keys must come from the BUILT output, not from the authored source: the
  // app-root `.eve/compile` cache can lag behind the tree, and a key computed
  // from stale artifacts checks a template nothing will ask for.
  if (!existsSync(join(APP_ROOT, ".output"))) {
    console.error(`${glyph.bad} No .output/ — run \`npm run build:eve\` first, then re-run this.`);
    process.exit(1);
  }

  // eve picks the sandbox backend from the environment: VERCEL marks "deployed
  // on Vercel" (→ Vercel Sandbox rather than the local Docker/microsandbox
  // backend), and VERCEL_PROJECT_ID scopes the template key to the project the
  // deployed agent will look it up in.
  process.env.VERCEL = "1";
  process.env.VERCEL_PROJECT_ID = projectId;

  const { prewarmBuiltAppSandboxes } = await import(
    resolveEveModule("dist/src/execution/sandbox/prewarm.js")
  );

  console.log(`Sandbox templates — project ${projectId}${check ? " (check only)" : ""}\n`);
  const rows = [];
  const labels = new Map();
  let missing = 0;
  let failed = 0;

  await prewarmBuiltAppSandboxes({
    appRoot: APP_ROOT,
    // eve only exposes the node name ("root", "subagents/research") through the
    // per-template logger, and knowing WHICH agent is unprovisioned is the whole
    // point of the report — so echo the key through it and read the name back.
    log: (message) => {
      const match = /sandbox template "([^"]+)".*__node__ (\S+)/.exec(message);
      if (match) labels.set(match[2], match[1]);
    },
    dispatch: async ({ backend, input }) => {
      input.log?.(`__node__ ${input.templateKey}`);
      const existing = await lookupTemplate(input.templateKey, token);
      if (existing) {
        rows.push([glyph.ok, input.templateKey, "present"]);
        return { reused: true };
      }
      missing += 1;
      if (check) {
        rows.push([glyph.bad, input.templateKey, "MISSING"]);
        return { reused: true };
      }
      try {
        const started = Date.now();
        const result = await backend.prewarm(input);
        rows.push([
          glyph.ok,
          input.templateKey,
          `built in ${Math.round((Date.now() - started) / 1000)}s`,
        ]);
        return result;
      } catch (error) {
        failed += 1;
        rows.push([glyph.bad, input.templateKey, `FAILED: ${describe(error)}`]);
        // Rethrowing would abandon the remaining templates for no reason; the
        // summary below decides the exit code.
        return { reused: true };
      }
    },
  });

  for (const [mark, key, state] of rows) {
    console.log(`${mark} ${(labels.get(key) ?? "?").padEnd(24)} ${key}  ${state}`);
  }
  console.log("");

  if (failed > 0) {
    console.error(
      `${glyph.bad} ${failed} template(s) failed to build — the message above is the sandbox's own output.`,
    );
    process.exit(1);
  }
  if (check && missing > 0) {
    console.error(
      `${glyph.bad} ${missing} template(s) missing. The deployed agent's bash tools will fail with\n` +
        `  "Sandbox template … is not provisioned". Run: npm run fde:sandbox`,
    );
    process.exit(1);
  }
  console.log(
    missing === 0
      ? `${glyph.ok} All sandbox templates are provisioned.`
      : `${glyph.ok} Built ${missing} missing template(s); all are provisioned now.`,
  );
}

function describe(error) {
  const parts = [];
  let current = error;
  while (current && parts.length < 4) {
    parts.push(current.message ?? String(current));
    current = current.cause;
  }
  return parts.join(" ← ");
}

try {
  await main();
} catch (error) {
  const detail = describe(error);
  console.error(`${glyph.bad} ${detail}`);
  // An expired OIDC token is the overwhelmingly common cause and the raw 401
  // says nothing useful about how to fix it.
  if (/\b401\b|\b403\b|unauthor|forbidden|token/i.test(detail)) {
    console.error(
      `  The token is probably expired. Re-pull it:\n` +
        `    cd /tmp/eve-link && npx vercel env pull --yes`,
    );
  }
  process.exit(1);
}

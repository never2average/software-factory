#!/usr/bin/env node
/**
 * Deploy a target to production and TAG the commit that went out.
 *
 * Why a script instead of running `vercel --prod` by hand: nothing recorded
 * what was deployed. Answering "is this fix live?" meant comparing a Vercel
 * timestamp against `git log` by eye, and the agent silently sat four days
 * behind the front-end without anything surfacing it.
 *
 * The tag is only worth having if it is TRUE, so this refuses to deploy when
 * the working tree is dirty or the commit is not on the remote. A tag pointing
 * at a commit nobody else can fetch is worse than no tag: it reads as a
 * guarantee and is not one.
 *
 *   npm run deploy:web      front-end  → tags deploy/web/<date>.<n>
 *   npm run deploy:agent    eve agent  → tags deploy/agent/<date>.<n>
 *
 * The agent build runs the FULL `eve build` (sandbox prewarm included) with an
 * OIDC token pulled FOR THE AGENT PROJECT — that token, not the link and not
 * VERCEL_PROJECT_ID, decides where sandbox templates are provisioned. It never
 * falls back to --skip-sandbox-prewarm: that ships an agent whose sandboxes do
 * not exist and reports success.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const TARGETS = {
  web: {
    label: "front-end (agent-workspace)",
    // Remote build. A local prebuilt front-end ships the WRONG output: the
    // .vercel/output directory is shared with the agent, and `vercel pull`
    // returns empty strings for Sensitive vars, which get inlined into the
    // client bundle at build time.
    deploy: () => sh("vercel", ["--prod", "--yes"]),
  },
  agent: {
    label: "eve agent (agent-workspace-api)",
    // The agent project's Vercel ids are the deployment's, never the code's: AGENT_VERCEL_ORG_ID (team_…) and
    // AGENT_VERCEL_PROJECT_ID (prj_…), from the agent project's Settings → General.
    env: {
      VERCEL_ORG_ID: process.env.AGENT_VERCEL_ORG_ID?.trim() ?? "",
      VERCEL_PROJECT_ID: process.env.AGENT_VERCEL_PROJECT_ID?.trim() ?? "",
    },
    deploy() {
      if (!this.env.VERCEL_ORG_ID || !this.env.VERCEL_PROJECT_ID) {
        console.error("\n✗ Set AGENT_VERCEL_ORG_ID and AGENT_VERCEL_PROJECT_ID to the eve agent's Vercel team and project ids.\n");
        process.exit(1);
      }
      // Prewarm takes a filesystem lock per sandbox template. A stale lock from
      // a killed build makes the next one wait out a 15-minute timeout, so
      // clear them first — and never run two builds at once.
      sh("rm", ["-rf", ".eve/sandbox-cache/template-locks/vercel"], { allowFail: true });
      /**
       * The OIDC TOKEN decides the project. Nothing else does.
       *
       * This is the real root cause of a day of sandbox failures, and it defeats
       * every obvious fix. eve's sandbox SDK authenticates with
       * VERCEL_OIDC_TOKEN, and that token is scoped to ONE project. `.env.local`
       * holds a token for the WEB project, so `eve build` cheerfully reported
       * "initialized 9 sandbox templates" while putting all nine in agent-workspace —
       * and the agent runtime, looking in agent-workspace-api, found none and failed
       * every sandbox tool with "template … is not provisioned".
       *
       * Setting VERCEL_PROJECT_ID does not help. Rewriting .vercel/project.json
       * does not help — I tried both, and the build still provisioned into the
       * web project. It also makes the state unreadable: creating a template
       * says "already exists" (true, in web) while deleting it says 404 (also
       * true, in agent).
       *
       * So pull a token FOR THE AGENT and build with that.
       */
      const agentEnv = ".vercel/.agent-oidc.env";
      sh("npx", ["vercel", "env", "pull", agentEnv, "--environment=development", "--yes"], {
        env: this.env,
        allowFail: true,
      });
      const oidc = /^VERCEL_OIDC_TOKEN="?([^"\n]+)"?/m.exec(
        readFileSync(agentEnv, "utf8").toString(),
      )?.[1];
      if (!oidc) {
        console.error(
          "\n✗ Could not obtain a VERCEL_OIDC_TOKEN for the agent project.\n" +
            "  eve provisions sandbox templates into whichever project that token names,\n" +
            "  so building without it (or with the web project's token) ships an agent\n" +
            "  whose sandboxes live somewhere it will never look.\n",
        );
        process.exit(1);
      }
      // Fail loudly if the token names the wrong project rather than repeating
      // the outage quietly.
      const claims = JSON.parse(Buffer.from(oidc.split(".")[1], "base64").toString());
      if (claims.project_id !== this.env.VERCEL_PROJECT_ID) {
        console.error(
          `\n✗ OIDC token is scoped to ${claims.project} (${claims.project_id}), not the agent.\n` +
            "  Building with it would provision the sandboxes into the wrong project.\n",
        );
        process.exit(1);
      }
      this.env.VERCEL_OIDC_TOKEN = oidc;

      // Belt and braces. The token above is what actually decides the project;
      // the link is aligned too so anything reading it agrees with reality.
      const linkPath = ".vercel/project.json";
      const originalLink = readFileSync(linkPath, "utf8");
      writeFileSync(
        linkPath,
        JSON.stringify({
          projectId: this.env.VERCEL_PROJECT_ID,
          orgId: this.env.VERCEL_ORG_ID,
          projectName: "agent-workspace-api",
        }),
      );
      try {
        // Through the wrapper, never bare `eve build`: it leaves out the specialists the profile excludes
        // (scripts/eve-build.mjs), which a bare build would put back in the model's roster.
        sh("node", ["scripts/eve-build.mjs", "build"], { env: { ...this.env, VERCEL: "1" } });
        raiseStreamFunctionLimit();
        return sh("vercel", ["deploy", "--prebuilt", "--prod"], { env: this.env });
      } catch (error) {
        /**
         * NO silent --skip-sandbox-prewarm fallback.
         *
         * That is exactly what shipped the outage. Skipping prewarm produces a
         * deployment whose sandboxes were never provisioned, so a BUILD failure
         * becomes a RUNTIME failure for real users — and the deploy prints
         * success on its way past. Refusing to deploy is the honest outcome.
         */
        console.error(
          "\n✗ Agent deploy aborted at sandbox prewarm — nothing was deployed.\n" +
            "  Skipping prewarm would look fine and then fail for users with\n" +
            '  "sandbox template … is not provisioned".\n\n' +
            "  If the log says a name already exists, free EVERY reported name in BOTH\n" +
            "  projects before rebuilding — a failed build leaves behind the templates it\n" +
            "  already made, so freeing them one at a time never converges:\n" +
            "    npx vercel sandbox remove <name> --project <the web project's id>\n" +
            `    npx vercel sandbox remove <name> --project ${this.env.VERCEL_PROJECT_ID}\n`,
        );
        throw error;
      } finally {
        // Always restore the web link: deploy:web needs it, and a repo left
        // pointing at the agent is a trap for whoever runs the next deploy.
        writeFileSync(linkPath, originalLink);
      }
    },
  },
};

/**
 * Give the function that SERVES the session stream the same ceiling as the one
 * that runs the work.
 *
 * eve's build emits `maxDuration: "max"` for `.well-known/workflow/v1/flow`
 * (the turn's steps) and leaves `__server.func` — which serves
 * `/eve/v1/session/:id/stream` — unset. Measured against production, that
 * unset default cuts the stream at a hard 120 seconds: first at 121s, again at
 * 241s, no error and no terminal event, while the turn carries on underneath.
 * The answer completes and the reader never hears it.
 *
 * Patched at deploy time rather than in the repo because the file is build
 * output. Best-effort: if eve's layout changes this logs and moves on rather
 * than blocking a deploy — the client-side resume is what actually guarantees
 * delivery, and this only widens the window before it is needed.
 */
function raiseStreamFunctionLimit() {
  const path = ".vercel/output/functions/__server.func/.vc-config.json";
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    if (config.maxDuration === "max") return;
    config.maxDuration = "max";
    writeFileSync(path, JSON.stringify(config, null, 2));
    console.log("  · raised __server.func maxDuration to 'max' (session streams)");
  } catch (error) {
    console.warn(`  ! could not raise the stream function's limit (${error.message}) — continuing`);
  }
}

function sh(cmd, args, { env, allowFail, capture } = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return out ?? "";
  } catch (e) {
    if (allowFail) return "";
    throw e;
  }
}

const git = (...args) => sh("git", args, { capture: true }).trim();

const target = process.argv[2];
if (!TARGETS[target]) {
  console.error(`Usage: node scripts/deploy.mjs <${Object.keys(TARGETS).join("|")}>`);
  process.exit(1);
}

/* The tag must not be able to lie. ---------------------------------------- */
if (git("status", "--porcelain")) {
  console.error("✗ Working tree is dirty. Commit or stash first — the tag records a COMMIT,");
  console.error("  and uncommitted changes would be deployed but not recorded.");
  process.exit(1);
}
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const sha = git("rev-parse", "HEAD");
sh("git", ["fetch", "origin", "--quiet"], { allowFail: true });
const unpushed = git("rev-list", `origin/${branch}..HEAD`).split("\n").filter(Boolean);
if (unpushed.length) {
  console.error(`✗ ${unpushed.length} commit(s) not pushed to origin/${branch}.`);
  console.error("  Push first: a tag pointing at a commit nobody can fetch is not a record.");
  process.exit(1);
}

/* Next tag in today's sequence. ------------------------------------------- */
const day = new Date().toISOString().slice(0, 10);
const prefix = `deploy/${target}/${day}`;
const existing = git("tag", "--list", `${prefix}.*`).split("\n").filter(Boolean);
const seq = existing.reduce((max, t) => Math.max(max, Number(t.split(".").pop()) || 0), 0) + 1;
const tag = `${prefix}.${seq}`;

console.log(`\n▸ Deploying ${TARGETS[target].label}`);
console.log(`  commit ${sha.slice(0, 7)} on ${branch} → will tag ${tag}\n`);

const output = TARGETS[target].deploy();
const url = /https:\/\/[^\s]*\.vercel\.app/.exec(output ?? "")?.[0] ?? "(see output above)";

/* Tag AFTER a successful deploy, never before. ---------------------------- */
sh("git", [
  "tag", "-a", tag,
  "-m", `Deployed ${TARGETS[target].label}\n\ncommit: ${sha}\nurl:    ${url}\nat:     ${new Date().toISOString()}`,
]);
sh("git", ["push", "origin", tag]);

console.log(`\n✓ Deployed and tagged ${tag}`);
console.log(`  ${url}`);
console.log(`\n  What is live vs main:  git log ${tag}..main --oneline`);

// fde:onboard-self — record the running engineer as an FDE and report readiness.
//
//   npm run fde:onboard-self -- --name "Priyesh" --title "Forward-Deployed Engineer" \
//     --focus "onboarding, migrations" [--email you@onfinance.in] [--timezone Asia/Kolkata]
//
// Idempotent. Writes ONE team-scoped memory (`fde-profile:<email>`) so every agent
// and teammate knows who the FDEs are — there is no internal-people table, and the
// People/ data-room tree is external-only (see docs/FDE_WORKFLOW.md). Also prints a
// readiness checklist: identity, platform health, and the local env the MCP needs.
//
// Run with DATABASE_URL in the environment (it's in .env.local):
//   node --experimental-strip-types --env-file=.env.local scripts/fde/onboard-self.mjs -- ...
import { getDb, closeDb } from "../../agent/lib/db/index.ts";
import { memories } from "../../agent/lib/db/schema.ts";
import { and, eq } from "drizzle-orm";
import { createDataroomStore } from "../../agent/lib/dataroom-store.ts";
import { glyph, flag, resolveIdentity, isOnfinance, checkHealth, envReady } from "./lib/fde.mjs";

/** person_id slug for People/ — email-derived, collision-free. */
function personSlug(email) {
  return email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

async function main() {
  const { email, source } = resolveIdentity();
  const name = flag("name").trim();
  const title = flag("title").trim() || "Forward-Deployed Engineer";
  const focus = flag("focus").trim();
  const timezone = flag("timezone").trim();

  console.log("FDE self-onboarding\n");

  // 1. Identity — required, and it must be an @onfinance.in account.
  if (!email) {
    console.error(
      `${glyph.bad} No identity. Sign in first (\`node setup/fde-login.mjs\`), or pass --email you@onfinance.in.`,
    );
    process.exit(1);
  }
  if (!isOnfinance(email)) {
    console.error(
      `${glyph.bad} ${email} is not an @onfinance.in account — the Ops API only accepts onfinance identities.`,
    );
    process.exit(1);
  }
  console.log(`${glyph.ok} Identity: ${email}  (from ${source})`);

  // 2. Platform health (advisory — you can still record your profile).
  const health = await checkHealth();
  console.log(`${health.ok ? glyph.ok : glyph.warn} Platform health: ${health.detail}`);

  // 3. Local env the fde MCP needs (values never printed).
  const blob = envReady("BLOB_READ_WRITE_TOKEN");
  const cf = envReady("CLOUDFLARE_ACCOUNT_ID") && envReady("CLOUDFLARE_API_TOKEN");
  console.log(`${blob ? glyph.ok : glyph.warn} BLOB_READ_WRITE_TOKEN ${blob ? "set" : "missing — Data Room tools disabled"}`);
  console.log(`${cf ? glyph.ok : glyph.warn} CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN ${cf ? "set" : "missing — model calls will fail (Cloudflare Workers AI is the only provider)"}`);

  // 4. Record the FDE profile as a team memory (idempotent upsert by key).
  const db = getDb();
  if (!db) {
    console.error(`\n${glyph.bad} No DATABASE_URL — cannot record your FDE profile. Re-run with --env-file=.env.local.`);
    process.exit(1);
  }
  const key = `fde-profile:${email.toLowerCase()}`;
  const profile = {
    email,
    name: name || null,
    title,
    focus: focus || null,
    timezone: timezone || null,
    onboardedAt: new Date().toISOString(),
  };
  const value = JSON.stringify(profile);

  const existing = await db
    .select({ id: memories.id, version: memories.version })
    .from(memories)
    .where(and(eq(memories.scope, "team"), eq(memories.key, key)))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(memories)
      .set({ value, authorEmail: email, updatedAt: new Date(), version: (existing[0].version ?? 1) + 1 })
      .where(eq(memories.id, existing[0].id));
    console.log(`${glyph.ok} Updated your FDE profile (team memory \`${key}\`, v${(existing[0].version ?? 1) + 1}).`);
  } else {
    await db.insert(memories).values({
      scope: "team",
      entityId: null,
      key,
      value,
      authorEmail: email,
      sensitivity: "internal",
    });
    console.log(`${glyph.ok} Recorded you as an FDE (team memory \`${key}\`).`);
  }

  // 5. Register the FDE as a first-class People/ roster entry (internal-fde).
  //    Reverses the old "People is external-only" rule FOR INTERNAL FDEs: the
  //    kind:"internal-fde" tag keeps them distinct, and list_fdes reads these.
  //    In ONE workspace's data room (`--org <id>` or FDE_ORG): every workspace has its own tree and there is no
  //    default one to fall back to (lib/dataroom-keyspace.ts).
  const rosterOrg = (flag("org") || process.env.FDE_ORG || "").trim();
  const store = rosterOrg ? createDataroomStore({ orgId: rosterOrg }) : null;
  if (!store) {
    console.log(`${glyph.warn} Not added to a workspace's People/ roster: pass --org <workspace id> (or set FDE_ORG).`);
  } else if (store.backend?.kind === "vercel-blob") {
    const slug = personSlug(email);
    const skills = flag("skills").trim() ? flag("skills").split(",").map((s) => s.trim()).filter(Boolean) : [];
    const pod = flag("pod").trim() || null;
    const capacity = Number(flag("capacity")) || 8;
    const identity = {
      kind: "internal-fde",
      email,
      name: name || null,
      title,
      pod,
      timezone: timezone || null,
      skills,
      capacityTargetAccounts: capacity,
      status: "active",
      startedAt: new Date().toISOString(),
      pagerdutyUserId: null,
    };
    await store.write(`People/${slug}/identity.json`, JSON.stringify(identity, null, 2) + "\n");
    const existingContext = await store.read(`People/${slug}/context.md`).catch(() => null);
    if (!existingContext) {
      await store.write(
        `People/${slug}/context.md`,
        `# ${name || email} — FDE\n\n- **Email:** ${email}\n- **Title:** ${title}\n${pod ? `- **Pod:** ${pod}\n` : ""}${timezone ? `- **Timezone:** ${timezone}\n` : ""}${skills.length ? `- **Skills:** ${skills.join(", ")}\n` : ""}- **Capacity target:** ${capacity} accounts\n\n_Onboarded ${new Date().toISOString().slice(0, 10)} via fde:onboard-self._\n`,
      );
      await store.write(
        `People/${slug}/roles_and_responsibilities.md`,
        `# Roles & responsibilities — ${name || email}\n\nForward-Deployed Engineer. Owns assigned customer accounts end to end (onboarding, configuration, deployment, migration, evals, follow-ups) and takes on-call rotations for incidents.\n`,
      );
    }
    console.log(`${glyph.ok} Registered you in the FDE roster (People/${slug}/, kind internal-fde).`);
  } else {
    console.log(`${glyph.warn} No blob data room (BLOB_READ_WRITE_TOKEN) — skipped the People/ roster entry.`);
  }

  await closeDb();

  console.log(`\n${glyph.info} Next: read docs/FDE_WORKFLOW.md, then use the \`onboard-customer\` skill for your first account.`);
}

main().catch(async (e) => {
  console.error(`${glyph.bad} onboard-self failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});

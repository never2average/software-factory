// operator:onboard-self (also `fde:onboard-self`) — record the running engineer as a team member and report readiness.
//
//   npm run operator:onboard-self -- --name "Priyesh" --title "Solutions Engineer" \
//     --focus "onboarding, migrations" [--email you@onfinance.in] [--timezone Asia/Kolkata]
//
// Idempotent. Writes ONE team-scoped memory (`member-profile:<email>`; a profile
// recorded under the old `fde-profile:<email>` key is found and moved to the new one)
// so every agent and teammate knows who the team is — there is no internal-people table, and the
// People/ data-room tree is external-only (see docs/OPERATOR_WORKFLOW.md). Also prints a
// readiness checklist: identity, platform health, and the local env the MCP needs.
//
// Run with DATABASE_URL in the environment (it's in .env.local):
//   node --experimental-strip-types --env-file=.env.local scripts/operator/onboard-self.mjs -- ...
import { getDb, closeDb } from "../../agent/lib/db/index.ts";
import { memories } from "../../agent/lib/db/schema.ts";
import { MEMBER_KIND } from "../../agent/lib/member-kind.ts";
import { and, eq, inArray } from "drizzle-orm";
import { createDataroomStore } from "../../agent/lib/dataroom-store.ts";
import { DEPLOYMENT_PROFILE } from "../../lib/deployment-profile.generated.ts";
import { glyph, flag, resolveIdentity, isOnfinance, checkHealth, envReady, operatorEnv, memberProfileKeys, pickMemberProfile } from "./lib/operator.mjs";
import { W } from "./lib/words.mjs";

/** The deployment's own word for a team member (the default profile's is the base product's role word). */
const MEMBER = DEPLOYMENT_PROFILE.vocabulary.member.singular;
/** The member word as a title or the start of a line ("Member", "Analyst"). */
const Member = MEMBER.charAt(0).toUpperCase() + MEMBER.slice(1);

/** person_id slug for People/ — email-derived, collision-free. */
function personSlug(email) {
  return email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

async function main() {
  const { email, source } = resolveIdentity();
  const name = flag("name").trim();
  const title = flag("title").trim() || Member;
  const focus = flag("focus").trim();
  const timezone = flag("timezone").trim();

  console.log("Team member self-onboarding\n");

  // 1. Identity — required, and it must be an @onfinance.in account.
  if (!email) {
    console.error(
      `${glyph.bad} No identity. Sign in first (\`node setup/workspace-login.mjs\`), or pass --email you@onfinance.in.`,
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

  // 3. Local env the MCP server needs (values never printed).
  const blob = envReady("BLOB_READ_WRITE_TOKEN");
  const cf = envReady("CLOUDFLARE_ACCOUNT_ID") && envReady("CLOUDFLARE_API_TOKEN");
  console.log(`${blob ? glyph.ok : glyph.warn} BLOB_READ_WRITE_TOKEN ${blob ? "set" : "missing — Data Room tools disabled"}`);
  console.log(`${cf ? glyph.ok : glyph.warn} CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN ${cf ? "set" : "missing — model calls will fail (Cloudflare Workers AI is the only provider)"}`);

  // 4. Record the member profile as a team memory (idempotent upsert by key; the old key is read too).
  const db = getDb();
  if (!db) {
    console.error(`\n${glyph.bad} No DATABASE_URL — cannot record your member profile. Re-run with --env-file=.env.local.`);
    process.exit(1);
  }
  const { key, legacyKey } = memberProfileKeys(email);
  const profile = {
    email,
    name: name || null,
    title,
    focus: focus || null,
    timezone: timezone || null,
    onboardedAt: new Date().toISOString(),
  };
  const value = JSON.stringify(profile);

  const found = await db
    .select({ id: memories.id, key: memories.key, version: memories.version })
    .from(memories)
    .where(and(eq(memories.scope, "team"), inArray(memories.key, [key, legacyKey])));
  const existing = pickMemberProfile(found, email);

  if (existing) {
    // Written under the neutral key: a profile found under the old key is moved, not duplicated.
    await db
      .update(memories)
      .set({ key, value, authorEmail: email, updatedAt: new Date(), version: (existing.version ?? 1) + 1 })
      .where(eq(memories.id, existing.id));
    const moved = existing.key === key ? "" : `, moved from \`${existing.key}\``;
    console.log(`${glyph.ok} Updated your member profile (team memory \`${key}\`, v${(existing.version ?? 1) + 1}${moved}).`);
  } else {
    await db.insert(memories).values({
      scope: "team",
      entityId: null,
      key,
      value,
      authorEmail: email,
      sensitivity: "internal",
    });
    console.log(`${glyph.ok} Recorded you as a team member (team memory \`${key}\`).`);
  }

  // 5. Register the member as a first-class People/ roster entry (kind MEMBER_KIND, a stored value).
  //    Reverses the old "People is external-only" rule FOR INTERNAL members: the
  //    kind tag keeps them distinct, and list_members reads these (entries written with the
  //    earlier "internal-fde" value too; agent/lib/member-kind.ts).
  //    In ONE workspace's data room (`--org <id>` or WORKSPACE_ORG): every workspace has its own tree and there is no
  //    default one to fall back to (lib/dataroom-keyspace.ts).
  const rosterOrg = (flag("org") || operatorEnv("WORKSPACE_ORG")).trim();
  const store = rosterOrg ? createDataroomStore({ orgId: rosterOrg }) : null;
  if (!store) {
    console.log(`${glyph.warn} Not added to a workspace's People/ roster: pass --org <workspace id> (or set WORKSPACE_ORG).`);
  } else if (store.backend?.kind === "vercel-blob") {
    const slug = personSlug(email);
    const skills = flag("skills").trim() ? flag("skills").split(",").map((s) => s.trim()).filter(Boolean) : [];
    const pod = flag("pod").trim() || null;
    const capacity = Number(flag("capacity")) || 8;
    const identity = {
      kind: MEMBER_KIND,
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
        `# ${name || email} — ${MEMBER}\n\n- **Email:** ${email}\n- **Title:** ${title}\n${pod ? `- **Pod:** ${pod}\n` : ""}${timezone ? `- **Timezone:** ${timezone}\n` : ""}${skills.length ? `- **Skills:** ${skills.join(", ")}\n` : ""}- **Capacity target:** ${capacity} accounts\n\n_Onboarded ${new Date().toISOString().slice(0, 10)} via operator:onboard-self._\n`,
      );
      await store.write(
        `People/${slug}/roles_and_responsibilities.md`,
        `# Roles & responsibilities — ${name || email}\n\n${Member}. Owns assigned ${W.accounts} end to end (onboarding, configuration, deploys, migration, evals, follow-ups) and takes on-call rotations for incidents.\n`,
      );
    }
    console.log(`${glyph.ok} Registered you in the ${MEMBER} roster (People/${slug}/, kind ${MEMBER_KIND}).`);
  } else {
    console.log(`${glyph.warn} No blob data room (BLOB_READ_WRITE_TOKEN) — skipped the People/ roster entry.`);
  }

  await closeDb();

  console.log(`\n${glyph.info} Next: read docs/OPERATOR_WORKFLOW.md, then use the \`onboard-customer\` skill for your first account.`);
}

main().catch(async (e) => {
  console.error(`${glyph.bad} onboard-self failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});

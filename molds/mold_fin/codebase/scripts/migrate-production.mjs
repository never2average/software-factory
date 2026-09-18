import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

function readEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
        .map((line) => {
          const separator = line.indexOf("=");
          return [
            line.slice(0, separator).trim(),
            line.slice(separator + 1).trim().replace(/^["']|["']$/g, ""),
          ];
        }),
    );
  } catch {
    return {};
  }
}

const local = readEnv(".env.local");
const provider = readEnv(".env.supabase");
const databaseUrl =
  provider.SUPABASE_POSTGRES_URL_NON_POOLING ||
  local.DATABASE_URL_UNPOOLED ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "Production migration requires SUPABASE_POSTGRES_URL_NON_POOLING, DATABASE_URL_UNPOOLED, or DATABASE_URL.",
  );
}

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
const migrations = journal.entries.map((entry) => {
  const sqlText = readFileSync(`drizzle/${entry.tag}.sql`, "utf8");
  return {
    ...entry,
    hash: createHash("sha256").update(sqlText).digest("hex"),
    statements: sqlText.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean),
  };
});

const client = postgres(databaseUrl, {
  ssl: "require",
  prepare: false,
  max: 1,
  onnotice: () => {},
});

const [{ current_user: role }] = await client`select current_user`;
if (role === "app_rw") {
  await client.end();
  throw new Error("Refusing DDL through the restricted app_rw database role.");
}

await client.begin(async (tx) => {
  await tx.unsafe("create schema if not exists drizzle");
  await tx.unsafe(`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )`);

  let [latest] = await tx`
    select id, hash, created_at
      from drizzle.__drizzle_migrations
     order by created_at desc
     limit 1`;

  if (!latest) {
    const [legacy] = await tx`
      select
        to_regclass('public.workflow_runs') is not null as has_runs,
        to_regclass('public.workflow_run_journal') is not null as has_journal,
        to_regclass('public.connector_secrets') is not null as has_connector_secrets`;
    const baseline = migrations.find((migration) => migration.idx === 13);
    if (legacy.has_runs && legacy.has_journal && legacy.has_connector_secrets && baseline) {
      await tx`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${baseline.hash}, ${baseline.when})`;
      latest = { hash: baseline.hash, created_at: baseline.when };
      console.log(`baselined verified legacy schema at ${baseline.tag}`);
    }
  }

  const lastApplied = Number(latest?.created_at ?? 0);
  const pending = migrations.filter((migration) => Number(migration.when) > lastApplied);
  for (const migration of pending) {
    for (const statement of migration.statements) await tx.unsafe(statement);
    await tx`
      insert into drizzle.__drizzle_migrations (hash, created_at)
      values (${migration.hash}, ${migration.when})`;
    console.log(`applied ${migration.tag}`);
  }

  if (pending.length === 0) console.log("database schema is current");
});

await client.end();

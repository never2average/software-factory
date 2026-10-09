// Migration: multiplayer chat presence. One additive table:
//   - chat_presence (thread_id, email, last_seen_at, typing_until) PK (thread,email)
// Additive + idempotent.
//
// RUN THIS BEFORE deploying — the presence routes select this table.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const sql = postgres(env.DATABASE_URL, { ssl: "require" });

await sql`
  CREATE TABLE IF NOT EXISTS chat_presence (
    thread_id uuid NOT NULL,
    email text NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    typing_until timestamptz,
    PRIMARY KEY (thread_id, email)
  )
`;

const [row] = await sql`SELECT to_regclass('public.chat_presence') AS reg`;
console.log("chat_presence:", row.reg ? "OK" : "MISSING");

await sql.end();

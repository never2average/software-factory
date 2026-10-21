// The pack-seam fixture (mold_v0-038): what a real pack looks like, small. In a build copy it lives at
// packs/fixture_notes/ (scripts/packs-test.ts puts it there), so it imports the shell's pack API from ../../src.
import { definePack, defineTool, PackError, z } from "../../src/pack-api.js";

type Note = { id: number; body: string; created_at: string };

export default definePack({
  id: "fixture_notes",
  tools: [
    defineTool({
      name: "add_note",
      title: "Add a note",
      description: "Save a short note for this workspace.",
      inputSchema: { body: z.string().min(1).max(500).describe("The note") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (ws, { body }, { db }) => {
        const [note] = await db.query<Note>("INSERT INTO fixture_notes_notes (org_id, body) VALUES ($1, $2) RETURNING id, body, created_at", [ws.id, body]);
        return { note };
      },
    }),
    defineTool({
      name: "list_notes",
      title: "List notes",
      description: "This workspace's notes, newest first.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (ws, _args, { db }) => ({
        notes: await db.query<Note>("SELECT id, body, created_at FROM fixture_notes_notes WHERE org_id = $1 ORDER BY created_at DESC, id DESC", [ws.id]),
      }),
    }),
    // Forgets its workspace filter on purpose: row-level security must still keep it to the caller's own rows.
    defineTool({
      name: "count_every_note",
      description: "Counts notes without a workspace filter (a test of row-level security).",
      annotations: { readOnlyHint: true },
      handler: async (_ws, _args, { db }) => (await db.query<{ n: number }>("/* tenant: on purpose, row-level security alone scopes it */ SELECT count(*)::int AS n FROM fixture_notes_notes"))[0],
    }),
  ],
  routes: [
    { scope: "workspace", method: "get", path: "/notes", handler: async ({ workspace, db }) => ({
      rows: await db.query("SELECT id, body, created_at FROM fixture_notes_notes WHERE org_id = $1 ORDER BY id", [workspace.id]) }) },
    { scope: "workspace", method: "post", path: "/notes", handler: async ({ workspace, db, body }) => {
      const text = (body as { body?: unknown })?.body;
      if (typeof text !== "string" || !text.trim()) throw new PackError("body is required", 400);
      return (await db.query("INSERT INTO fixture_notes_notes (org_id, body) VALUES ($1, $2) RETURNING id, body", [workspace.id, text]))[0];
    } },
    { scope: "admin", method: "get", path: "/notes", handler: async ({ db }) => ({
      rows: await db.query("/* tenant: admin-only, across workspaces by design */ SELECT org_id, count(*)::int AS notes FROM fixture_notes_notes GROUP BY org_id ORDER BY org_id") }) },
    { scope: "admin", method: "delete", path: "/notes/:id", needs: "delete", handler: async ({ db, params }) => {
      const gone = await db.query("/* tenant: admin-only */ DELETE FROM fixture_notes_notes WHERE id = $1 RETURNING id", [Number(params.id)]);
      if (!gone.length) throw new PackError("no such note", 404);
    } },
  ],
  // recordAreas (mold_v0-047) and jobKinds (mold_v0-041) are wired: this area gets list_records/get_record and the
  // console's Records pages; this kind runs in the workspace harness. Credentials, schedules and onboarding are declared
  // and validated today; the credential vault, scheduler and checklist wire them.
  jobKinds: [{ name: "fixture_summary", runner: "workspace-harness", entry: "runner/summary.mjs", token_lifetime_seconds: 3600, budget_usd: 1, egress: ["api.example.com"] }],
  recordAreas: [{ name: "fixture_notes", label: "Notes", role: "asset", scope: "workspace", fields: [{ name: "body", label: "Note", type: "text" }] }],
  credentials: [{ name: "fixture_token", label: "Fixture token", bound_to: "workspace", deliver_as: { env: "FIXTURE_TOKEN" } }],
  schedules: [{ name: "nightly_summary", job_kind: "fixture_summary", cron: "0 2 * * *" }],
  onboarding: [{ id: "first_note", label: "Add a first note", done_when: "tool:add_note" }],
  migrations: "migrations",
});

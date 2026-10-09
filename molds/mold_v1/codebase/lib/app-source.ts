/**
 * What can generate an APP's document, and whether a given app's source can run: one decision, asked everywhere.
 *
 * An app is regenerated from a SOURCE. Three kinds work:
 *
 *   script      a workflow row that has a script: the script runs durably and its return value is the document;
 *   specialist  the scriptless "on delegation" row of a specialist THIS deployment has (a base one, or a pack's):
 *               the app's brief is delegated to that specialist and its reply is the document. The product already
 *               treats such a row as something that runs: a cron is routed to one by name, and a prompt app runs as
 *               one (`apps.subagent`). The picker has always listed them;
 *   prompt      one delegation of the app's prompt to `apps.subagent`, or to the document author when none is set.
 *
 * Anything else cannot produce a document: a row with no script that is not a specialist of this deployment, a
 * script that delegates to a specialist the profile excludes (lib/workflow-availability.ts), a workflow that does
 * not exist, a prompt app pinned to a specialist this deployment does not have.
 *
 * The apps panel offered every workflow row as a source and the create route stored whichever was picked, while the
 * refresh ran scripts only. So an app made from a specialist's row was saved and could only ever fail ("has no
 * script"), and nobody was told until the first refresh. This module is asked by:
 *
 *   - the create and edit routes and the agent's create_app / update_app, which REFUSE a source that cannot run,
 *     with the reason and what to do, before anything is saved;
 *   - GET /api/ops/workflows, so the picker marks what is a specialist and what cannot be picked, and why;
 *   - GET /api/ops/apps, so an app saved before this (or whose source has since changed under it) says so;
 *   - the refresh itself (lib/app-refresh.ts), which runs the three kinds and fails with the same sentence.
 *
 * Derived on every ask from the workspace's rows and the deployment profile; never stored.
 *
 * Relative `.ts` specifiers and no `server-only`: the agent's tools load this under plain node.
 */
import { VOCABULARY, fillWith, type Vocabulary } from "../agent/lib/agent-vocabulary.ts";
import { workflowAvailability } from "./workflow-availability.ts";

/** The specialist a prompt app runs as when it names none (lib/app-refresh.ts). */
export const DEFAULT_PROMPT_SPECIALIST = "app-author";

export type AppSource =
  | { ok: true; kind: "script" | "specialist" | "prompt"; specialist?: string }
  | { ok: false; kind: "script" | "specialist" | "prompt" | "none"; reason: string; fix: string };

/** The columns of a workflow row this decision reads. */
export interface SourceRow {
  name: string;
  script?: string | null;
  trigger?: string | null;
}

/** The columns of an app this decision reads. */
export interface SourceOfApp {
  sourceKind: string;
  workflow?: string | null;
  prompt?: string | null;
  subagent?: string | null;
}

const FIX_PICK = "Pick a workflow that has a script, or one of this workspace's specialists.";

/** Can this workflow row generate a document? `row` undefined: no row of that name in the workspace. */
export function workflowAppSource(row: SourceRow | undefined, name: string, v: Vocabulary = VOCABULARY): AppSource {
  if (!row) {
    return { ok: false, kind: "none", reason: `There is no workflow named "${name}" in this workspace.`, fix: FIX_PICK };
  }
  if (row.script?.trim()) {
    const availability = workflowAvailability(row, v);
    if (!availability.available) {
      return { ok: false, kind: "script", reason: availability.reason, fix: "Edit the workflow to use this workspace's specialists, or pick another." };
    }
    return { ok: true, kind: "script" };
  }
  if (v.specialists.includes(row.name)) return { ok: true, kind: "specialist", specialist: row.name };
  return {
    ok: false,
    kind: "none",
    reason: `"${row.name}" has no script and is not one of this workspace's specialists, so there is nothing to run.`,
    fix: "Give it a script under Workflows, or pick a workflow that has one.",
  };
}

/** Can a prompt app run as the specialist it names (or as the document author, when it names none)? */
export function promptAppSource(subagent: string | null | undefined, v: Vocabulary = VOCABULARY): AppSource {
  const key = subagent?.trim() || DEFAULT_PROMPT_SPECIALIST;
  if (v.specialists.includes(key)) return { ok: true, kind: "prompt", specialist: key };
  return subagent?.trim()
    ? { ok: false, kind: "prompt", reason: `"${key}" is not one of this workspace's specialists, so the prompt has nobody to run it.`, fix: "Leave the specialist empty, or name one this workspace has." }
    : { ok: false, kind: "prompt", reason: "This workspace does not have the specialist that writes a prompt app's document.", fix: "Generate the app from a workflow or from one of this workspace's specialists instead." };
}

/**
 * An app's source as it stands. `find` looks a workflow up by name in the app's workspace.
 * An app with nothing set is not runnable either, and says which field is missing.
 */
export async function appSource(
  app: SourceOfApp,
  find: (name: string) => Promise<SourceRow | undefined> | SourceRow | undefined,
  v: Vocabulary = VOCABULARY,
): Promise<AppSource> {
  if (app.sourceKind === "workflow") {
    const name = app.workflow?.trim();
    if (!name) return { ok: false, kind: "none", reason: "No workflow is set for this app.", fix: FIX_PICK };
    return workflowAppSource(await find(name), name, v);
  }
  if (!app.prompt?.trim()) return { ok: false, kind: "prompt", reason: "No prompt is set for this app.", fix: "Say what this app should generate." };
  return promptAppSource(app.subagent, v);
}

/** The same, against rows already read (a list annotating many apps from one query). */
export function appSourceAmong(app: SourceOfApp, rows: readonly SourceRow[], v: Vocabulary = VOCABULARY): AppSource {
  if (app.sourceKind === "workflow") {
    const name = app.workflow?.trim();
    if (!name) return { ok: false, kind: "none", reason: "No workflow is set for this app.", fix: FIX_PICK };
    return workflowAppSource(rows.find((r) => r.name === name), name, v);
  }
  if (!app.prompt?.trim()) return { ok: false, kind: "prompt", reason: "No prompt is set for this app.", fix: "Say what this app should generate." };
  return promptAppSource(app.subagent, v);
}

/** One sentence a person can act on: the reason and what to do. What a refused create, edit or refresh answers. */
export function sourceProblem(source: AppSource): string | null {
  return source.ok ? null : `${source.reason} ${source.fix}`;
}

/** Thrown by the refresh when the source cannot run: its message is {@link sourceProblem}. */
export class AppSourceError extends Error {}

/**
 * What a specialist is asked for when it generates an app's document.
 *
 * The app's own brief when it has one (`prompt`: the form asks "What should it produce?"). An app without one (made
 * before the form asked, or by a tool call that gave none) is described by its name and description, which is what
 * the person typed when they made it: enough for a specialist to produce the document or say what it needs.
 */
export function specialistBrief(
  app: { name: string; description?: string | null; prompt?: string | null; customerId?: string | null },
  v: Vocabulary = VOCABULARY,
): string {
  const brief = app.prompt?.trim();
  const lines = brief
    ? [brief]
    : [`Produce the document for the app "${app.name}".`, ...(app.description?.trim() ? [`What it is for: ${app.description.trim()}`] : [])];
  if (app.customerId) lines.push(fillWith(v, `It is about one {account}: ${app.customerId}.`));
  return [...lines, "", DOCUMENT_CONTRACT].join("\n");
}

/** A specialist does not know the dashboard schema the document author does: it is asked for the document itself. */
export const DOCUMENT_CONTRACT =
  "Reply with the finished document itself and nothing else: Markdown, with tables where they help. No preamble, no questions, no closing remarks. " +
  "It is stored as it is and shown read-only, and regenerated on a schedule, so it must stand on its own. " +
  "If you cannot produce it, reply with one sentence saying what is missing.";

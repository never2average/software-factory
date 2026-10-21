/**
 * THE AGENT'S TOOLS FOR A RECORD'S WORKFLOW (phase 7 of the workflow engine, docs/WORKFLOW_ENGINE.md "Surfaces"):
 *
 *   get_record_workflow   who holds the next step and when it is due, every step, the step timeline;
 *   reassign_step         who holds a step (only a supervisor: an owner or an admin, the step rules' own);
 *   extend_step           a step's one-time due-date extension (forward, near the date, within the cap).
 *
 * Registered only when some record area's lifecycle runs a workflow (agent/tools/*.ts export disableTool() otherwise),
 * so a deployment without one shows the model exactly what it did. The model acts for the person in the chat: it reads
 * people as they may (names on the roster; emails only for an owner or an admin) and changes only what they may. The
 * areas are named by the profile's own plural nouns. Moves themselves stay the record's own tools (upsert_<area>,
 * upsert_todo, upsert_cycle), which take a move's `reason` and `evidence` when its lifecycle runs a workflow.
 *
 * Same doors as the screens (lib/record-workflow-doors.ts), in the caller's workspace (withOrgDb).
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";
import { getDb, withOrgDb } from "./db/index.ts";
import { orgForSession } from "./org-context.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";
import { fill } from "./agent-vocabulary.ts";
import { areaView } from "./record-areas.ts";
import type { RecordAreaId } from "./record-areas.generated.ts";
import { memberRole } from "./record-area-store.ts";
import { recordWorkflowBound, workflowRefusal, type StepActionRunner } from "../../lib/record-workflow-moves.ts";
import { changeStepDoor, readWorkflowDoor, type DoorAnswer } from "../../lib/record-workflow-doors.ts";

const AREAS: RecordAreaId[] = ["deployments", "implementations", "tasks", "periods"];
/** The areas whose lifecycle runs a workflow here, by the profile's plural noun (what the model names them by). */
const BOUND = AREAS.filter((a) => recordWorkflowBound(a));
const BY_NOUN = new Map(BOUND.map((a) => [areaView(a).nouns, a] as const));
const NOUNS = [...BY_NOUN.keys()];

function callerEmail(ctx: { session?: { auth?: { current?: { principalId?: string; attributes?: Readonly<Record<string, string | readonly string[]>> } | null } } }): string {
  const current = ctx.session?.auth?.current;
  const email = current?.attributes?.email;
  if (typeof email === "string" && email.length > 0) return email.toLowerCase();
  return current?.principalId ?? "agent";
}

const deliver: StepActionRunner = (org, fn) => withOrgDb(org, fn as never);

const recordParams = () => ({
  area: z.enum(NOUNS as [string, ...string[]]).describe(`Which kind of record: ${NOUNS.join(" | ")}.`),
  id: z.string().min(1).describe("The record's id, as its list tool gives it."),
  customerId: z.string().optional().describe(fill("The {account} id, for a record that is named by its {account} and its own id.")),
});

/** The answer as the model reads it: the body, or the refusal's sentence thrown. */
function answer<T>(a: DoorAnswer<T>): T {
  if (a.status !== 200) throw new Error((a.body as { error: string }).error);
  return a.body as T;
}

async function run<T>(ctx: Parameters<typeof callerEmail>[0], area: string, fn: (org: string, actor: string, role: string, id: RecordAreaId) => Promise<DoorAnswer<T>>): Promise<T> {
  if (!getDb()) throw new Error("Reading a workflow needs the database, and none is configured.");
  const id = BY_NOUN.get(area);
  if (!id) throw new Error(`No workflow runs on ${area} here (${NOUNS.join(", ")} do).`);
  const org = await orgForSession(ctx as never);
  const actor = callerEmail(ctx);
  const role = await withOrgDb(org, (tx) => memberRole(tx, org, actor));
  try {
    return answer(await fn(org, actor, role, id));
  } catch (e) {
    const stopped = workflowRefusal(e, areaView(id).noun);
    throw stopped ? new Error(stopped.body.error) : e;
  }
}

export const getRecordWorkflowTool = BOUND.length
  ? modelFacing("get_record_workflow", defineTool({
      description: `A record's workflow: the step it waits on, who holds it and when it is due, every step with its holders and due date, and the step timeline (who did what, when). For ${NOUNS.join(", ")}. People are named as you may see them.`,
      inputSchema: z.object(recordParams()),
      async execute(input, ctx) {
        const { area, id, customerId } = input as { area: string; id: string; customerId?: string };
        return run(ctx, area, (org, actor, role, a) => withOrgDb(org, (tx) => readWorkflowDoor(tx as never, org, a, { id, customerId }, { email: actor, role }, { deliver })));
      },
    }))
  : null;

export const reassignStepTool = BOUND.length
  ? modelFacing("reassign_step", defineTool({
      description: `Change who holds one step of a record's workflow (the step's id from get_record_workflow; the whole new list of holders, by email). Only someone who supervises the work (an owner or an admin) may, and someone newly put on the step must be someone its rule could pick; a refusal says why. The holders named stay on the step until someone changes them again.`,
      approval: once(),
      inputSchema: z.object({ ...recordParams(), step: z.string().min(1).describe("The step's id."), holders: z.array(z.string().min(3)).min(1).describe("Everyone who should hold the step, by email.") }),
      async execute(input, ctx) {
        const { area, id, customerId, step, holders } = input as { area: string; id: string; customerId?: string; step: string; holders: string[] };
        return run(ctx, area, (org, actor, role, a) => withOrgDb(org, (tx) => changeStepDoor(tx as never, org, a, { id, customerId }, { email: actor, role }, { kind: "holders", stepId: step, holders }, { deliver })));
      },
    }))
  : null;

export const extendStepTool = BOUND.length
  ? modelFacing("extend_step", defineTool({
      description: `Extend the due date of one step of a record's workflow, once (the step's id from get_record_workflow). Only on a step whose workflow allows it, only later, only near its due date and within its limit; an owner or an admin may correct a date freely. A refusal says why.`,
      approval: once(),
      inputSchema: z.object({ ...recordParams(), step: z.string().min(1).describe("The step's id."), due_on: z.string().min(10).describe("The new due date: a date (yyyy-mm-dd) or an ISO-8601 date-time.") }),
      async execute(input, ctx) {
        const { area, id, customerId, step, due_on } = input as { area: string; id: string; customerId?: string; step: string; due_on: string };
        const dueOn = /^\d{4}-\d{2}-\d{2}$/.test(due_on) ? `${due_on}T00:00:00.000Z` : due_on;
        return run(ctx, area, (org, actor, role, a) => withOrgDb(org, (tx) => changeStepDoor(tx as never, org, a, { id, customerId }, { email: actor, role }, { kind: "due_on", stepId: step, dueOn }, { deliver })));
      },
    }))
  : null;

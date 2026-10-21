/**
 * `stop_specialist` — the main agent stops one of its own running or waiting specialists, with a short reason the
 * person reads on its card (mold_v1-294). What it does and why it is scoped the way it is: agent/lib/specialist-stop.ts.
 * Re-exported from agent/tools/stop_specialist.ts, so only the root agent has it.
 *
 * tenancy-ok: the ledger and the owner records are read and written inside the workspace's own scope (`inOrg`), the
 * workspace the calling session resolves to; the specialists it can name are the calling session's own.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { CURATED_LABELS } from "../../lib/specialist-names.ts";
import { readOwnerRecordIn } from "../../lib/session-gate.ts";
import { speak } from "./agent-vocabulary.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";
import { orgForSession, type SessionCtxLike } from "./org-context.ts";
import { agentGateDb } from "./session-owners.ts";
import { stopAnswer, stopSpecialist, STOP_REASON_MAX, type StopWorld } from "./specialist-stop.ts";
import { specialistSweepSettings } from "./specialist-sweep-settings.ts";
import { runtimeWorld, wholeHistory, type SweepRuntime } from "./specialist-sweep-world.ts";
import { SUBAGENT_GIVEN_NAMES, SUBAGENT_LABELS } from "./subagent-registry.generated.ts";
import { sweepLedger } from "./sweep-ledger.ts";

/** What the main agent and the person call a specialist of this kind: the same base name the chat uses. */
export function agentBaseName(key: string): string {
  const label = SUBAGENT_GIVEN_NAMES[key] ?? CURATED_LABELS[key] ?? SUBAGENT_LABELS[key];
  if (label) return speak(label);
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** eve's runtime for the sweep and the stop (the eve patch's `delegationSweep`), loaded on first use. */
async function runtime(): Promise<SweepRuntime> {
  const channels = (await import("eve/channels")) as unknown as { delegationSweep: SweepRuntime };
  return channels.delegationSweep;
}

/** The real world: eve's runtime, and — with a database — the sweep's ledger and the owner records, in one workspace. */
async function realWorld(ctx: SessionCtxLike): Promise<StopWorld> {
  const rt = await runtime();
  const db = agentGateDb();
  if (!db) {
    const history = wholeHistory(rt);
    return {
      history,
      deliver: (parent, token, result) => rt.deliverLateResult({ sessionId: parent, continuationTokens: [token, `eve:${token}`], result }),
      cancel: async (child) => String((await rt.cancel(child))?.status ?? ""),
    };
  }
  const orgId = await orgForSession(ctx);
  const ledger = sweepLedger(db, orgId);
  const base = runtimeWorld(rt, ledger, specialistSweepSettings());
  return {
    history: base.history,
    deliver: base.deliver,
    cancel: base.cancel,
    ledger,
    owners: {
      // No record (a session started before owner records were kept) leaves the decision to the stream, which only
      // ever names this session's own delegations. A record that says otherwise is refused.
      async isMainThread(sessionId) {
        const owner = await readOwnerRecordIn(db, orgId, sessionId);
        return !owner || !owner.rootSessionId;
      },
      async isOwnSpecialist(parentSessionId, childSessionId) {
        const owner = await readOwnerRecordIn(db, orgId, childSessionId);
        return !owner || owner.rootSessionId === parentSessionId;
      },
    },
  };
}

export const stopSpecialistTool = modelFacing(
  "stop_specialist",
  defineTool({
    description:
      "Stop one of the specialists you called in this chat that is still working or waiting on the person, when its work is no longer needed or it has gone the wrong way. Give a short reason: the person reads it on the specialist's card. Its result then comes back as stopped; call it again only if the work is still needed. Name it as the chat does: its name, with a number after it for the second and later of the same kind (\"<name> 2\"). When the name matches none, the answer lists this chat's specialists by name.",
    inputSchema: z.object({
      specialist: z.string().min(1).max(120).describe("The specialist to stop, by the name this chat gives it (\"<name> 2\" for the second of a kind), or its kind when only one of that kind is still working."),
      reason: z.string().min(1).max(STOP_REASON_MAX).describe("Why it is stopped, in one short sentence for the person."),
    }),
    async execute({ specialist, reason }, ctx) {
      const session = (ctx as SessionCtxLike | undefined)?.session;
      const outcome = await stopSpecialist(await realWorld(ctx as SessionCtxLike), {
        sessionId: session?.id ?? "",
        delegated: Boolean(session?.parent),
        target: specialist,
        reason,
        baseName: agentBaseName,
      });
      return stopAnswer(outcome);
    },
  }),
);

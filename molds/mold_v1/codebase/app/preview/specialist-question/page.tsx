import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultMessageReducer } from "eve/client";
import type { EveMessage } from "eve/react";
import { type TurnEvent, withSessionEpochs } from "@/lib/chat-turn-state";
import { SpecialistQuestionPreview } from "./preview";

/**
 * A delegated specialist asks the person a question (mold_v1-234) — dev only (see ../layout.tsx), no auth, no
 * network. Checked by tests/specialist-question.spec.ts.
 *
 * The stream is RECORDED from the real eve runtime with the patch (scripts/test-specialist-detach.mjs "asks":
 * scripts/fixtures/specialist-question/asks-attributed.ndjson): two specialists, one finishes, `beta` asks "Which fiscal
 * year should I use?" and works on after the answer. Two points of it are folded here, by the chat's own reducer:
 * "live" (beta's question open, the main agent at rest) and "done" (beta handed back). The page keeps the person's
 * reply as the chat persists it (the `client.input.responded` marker) in this browser, so a reload reads it back
 * through the same code a reopened chat does. `?fallback=1`: nothing says who asked (a stream recorded before the patch
 * with two delegations live), so the chat renders as it did before mold_v1-234.
 */
export default async function SpecialistQuestionPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ fallback?: string }>;
}) {
  const { fallback } = await searchParams;
  const events = readFileSync(join(process.cwd(), "scripts/fixtures/specialist-question/asks-attributed.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TurnEvent & { data?: { turnId?: string } });
  const handBack = events.findIndex((e) => e.type === "turn.started" && e.data?.turnId === "turn_2");
  const fold = (upto: number) => {
    const reducer = withSessionEpochs(defaultMessageReducer());
    let data = reducer.initial();
    for (const event of events.slice(0, upto)) data = reducer.reduce(data, event as never);
    return JSON.parse(JSON.stringify(data.messages)) as EveMessage[];
  };
  return (
    <SpecialistQuestionPreview
      fallback={fallback === "1"}
      live={{ events: events.slice(0, handBack), messages: fold(handBack) }}
      done={{ events, messages: fold(events.length) }}
    />
  );
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultMessageReducer } from "eve/client";
import type { EveMessage } from "eve/react";
import { type TurnEvent, withSessionEpochs } from "@/lib/chat-turn-state";
import { EventOrderPreview } from "./preview";

/**
 * A RECORDED eve stream, folded by the chat's own reducer
 * (`withSessionEpochs(defaultMessageReducer())`, what agent-chat.tsx mounts) and
 * rendered by the real AgentMessage — dev only (see ../layout.tsx), no auth, no
 * network. Checked by tests/event-order.spec.ts: after a delegation, the
 * orchestrator's later thinking must render BELOW the specialist's card.
 *
 *   ?fixture=reasoning-around-subagent | text-before-subagent
 *   ?upto=<n>   fold only the first n events: a live turn, frozen mid-stream
 *
 * The fold runs HERE, on the server, so the page adds no client code beyond the
 * AgentMessage the other previews already load (the first-load budget counts
 * shared chunks, and a client fold would regroup them). Folding event by event
 * onto the previous projection is what the store does live; that a fold resumed
 * at any event equals this one is checked in scripts/test-chat-event-order.mjs.
 *
 * The fixtures live in scripts/fixtures/event-order (README there).
 */
const FIXTURES = new Set(["reasoning-around-subagent", "text-before-subagent"]);

export default async function EventOrderPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ fixture?: string; upto?: string }>;
}) {
  const params = await searchParams;
  const fixture = FIXTURES.has(params.fixture ?? "") ? (params.fixture as string) : "reasoning-around-subagent";
  const events = readFileSync(join(process.cwd(), "scripts/fixtures/event-order", `${fixture}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TurnEvent);
  const n = Number(params.upto);
  const upto = Number.isInteger(n) && n > 0 && n < events.length ? n : events.length;
  const reducer = withSessionEpochs(defaultMessageReducer());
  let data = reducer.initial();
  for (const event of events.slice(0, upto)) data = reducer.reduce(data, event as never);
  return (
    <EventOrderPreview
      applied={upto}
      messages={JSON.parse(JSON.stringify(data.messages)) as EveMessage[]}
      streaming={upto < events.length}
    />
  );
}

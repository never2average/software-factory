"use client";

import { summarizeHandback } from "@/lib/handback-text";
import { specialistDisplayName } from "@/lib/chat-turn-state";

const WORDS = { finished: "finished — its result was handed to the main thread", stopped: "stopped before finishing — no result", failed: "failed — no result" } as const;

/**
 * A stopped specialist's hand-back, drawn as what it is: a note from the system. It travels as a user-role message
 * (eve has no other way in), so without this it appeared as a bubble from the person, quoting a specialist at
 * length. Only the system's own status list is shown; the specialists' quoted output stays in the model's context
 * and in each specialist's own session.
 */
export function HandbackNote({ text }: { readonly text: string }) {
  const summary = summarizeHandback(text);
  if (!summary) return null;
  return (
    <div
      role="note"
      data-testid="handback-note"
      className="mx-auto w-fit max-w-[90%] rounded-lg border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-xs"
    >
      <p>
        <span className="font-medium text-foreground">{specialistDisplayName(summary.stopped)}</span> was stopped. The
        main thread was told automatically and continues below.
      </p>
      {summary.entries.length > 1 ? (
        <ul className="mt-1 list-disc pl-4">
          {summary.entries.map((e) => (
            <li key={e.name}>
              {specialistDisplayName(e.name)}: {WORDS[e.state]}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

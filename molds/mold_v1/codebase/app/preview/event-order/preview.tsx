"use client";

import type { EveMessage } from "eve/react";
import { AgentMessage } from "@/app/_components/agent-message";

/** The projected transcript, rendered as the chat renders it (see ./page.tsx). */
export function EventOrderPreview({
  applied,
  messages,
  streaming,
}: {
  readonly applied: number;
  readonly messages: readonly EveMessage[];
  readonly streaming: boolean;
}) {
  return (
    <main
      data-testid="event-order"
      data-applied={String(applied)}
      className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 bg-background p-6 text-foreground"
    >
      {messages.map((message, i) => (
        <div key={message.id} data-testid={`msg-${message.role}`}>
          <AgentMessage
            canRespond={false}
            isLast={i === messages.length - 1}
            isStreaming={streaming && i === messages.length - 1}
            message={message}
            onInputResponses={() => {}}
            turnActive={streaming}
          />
        </div>
      ))}
    </main>
  );
}

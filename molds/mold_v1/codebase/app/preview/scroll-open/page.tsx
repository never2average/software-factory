"use client";

/**
 * A long conversation mounted at once, for the initial-scroll check in tests/chat-open.spec.ts — dev only (see
 * ../layout.tsx), no auth, no network.
 *
 * Mounts the SAME <Conversation> wrapper (use-stick-to-bottom) and the same <MessageResponse> renderer the chat uses,
 * with a transcript far taller than the screen present on the first render, as a reopened chat's is. The spec samples
 * the scroll position on every animation frame from the first one: a reopened chat should land at the bottom at once,
 * not scroll there through its whole history.
 *
 * Mounted on the client, after the first effect, as the chat's transcript is (chat-shell mounts AgentChat when an open
 * lands). Server-rendered, the transcript would be on screen before hydration attached the scroll library at all, and
 * the frames before that would measure hydration, not the scroll.
 */
import { useEffect, useState } from "react";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { MessageResponse } from "@/components/ai-elements/message";

const PARAGRAPH =
  "This is an earlier answer in a long conversation, long enough to wrap over several lines on a wide screen, so that the whole transcript is many screens tall when it is reopened.";

export default function ScrollOpenPreview() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl px-6 py-6">
          {Array.from({ length: 320 }, (_, i) => (
            <div key={i} data-turn={i}>
              <MessageResponse>{`**Turn ${i}.** ${PARAGRAPH} ${PARAGRAPH}`}</MessageResponse>
            </div>
          ))}
          <div data-testid="last-turn">The newest answer, at the bottom.</div>
        </ConversationContent>
      </Conversation>
    </div>
  );
}

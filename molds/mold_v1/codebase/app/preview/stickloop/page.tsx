"use client";

/**
 * Isolated reproduction for the streaming "Maximum update depth exceeded"
 * (React #185) crash seen when a deployment RECORD streams into the chat.
 * Mounts the SAME <Conversation> (use-stick-to-bottom) wrapper AND the same
 * <MessageResponse> (Streamdown) renderer the chat uses, then streams markdown
 * — growing prose plus a Field/Value table — character by character to mimic a
 * live turn. Auth-free.
 */
import { useEffect, useMemo, useState } from "react";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { MessageResponse } from "@/components/ai-elements/message";

// The full markdown a "record" turn produces — prose, then a table, then a tail.
const FULL = `The deployment is now part of Example Housing Finance's system-of-record and will show up in account reports. Here is the record:

| Field | Value |
| --- | --- |
| Deployment ID | \`DEP-EXAMPLE-HF-PROD\` |
| Environment | prod |
| Region / Cloud | ap-south-1 / AWS |
| Runtime / Strategy | Vercel / blue-green |
| Version | 2.4.1 |
| Model routing | Fallback (primary: claude-sonnet-4) |
| Release status | Deployed |
| Health | Healthy — 99.97% uptime, p95 620 ms (SLO 800 ms), 41% util, 184k req/30d |
| Live URL | https://example-hf.example.com |

The deployment is healthy and serving traffic. Fallback model routing is configured and CI/CD is under discussion with the SRE team.`;

export default function StickLoopPreview() {
  const [len, setLen] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setLen((x) => Math.min(x + 3, FULL.length));
      if (raf !== -1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const streamed = useMemo(() => FULL.slice(0, len), [len]);
  const streaming = len < FULL.length;

  return (
    <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl px-6 py-6">
          {/* Repeat a few message blocks so the transcript is tall and the
              stick-to-bottom lock is engaged, like a real multi-turn thread. */}
          {Array.from({ length: 6 }, (_, i) => (
            <div key={`pad-${i}`}>
              <MessageResponse>{`Earlier assistant turn ${i}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`}</MessageResponse>
            </div>
          ))}
          <MessageResponse isAnimating={streaming}>{streamed}</MessageResponse>
        </ConversationContent>
      </Conversation>
    </div>
  );
}

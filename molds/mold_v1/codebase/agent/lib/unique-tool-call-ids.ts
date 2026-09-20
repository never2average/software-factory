/**
 * Every tool call gets an id that is unique for the life of the conversation.
 *
 * Some models do not mint random tool-call ids; they COUNT. Kimi K2.6 on Workers AI answers
 * `functions.<tool>:0`, `functions.<tool>:1`, … and the counter is derived from the tool calls the model can
 * still see — so it restarts at 0 after the context is compacted and in every new session. Everything downstream
 * treats the id as an identity: eve pairs a delegation with its child session by it, and the chat keys the
 * Control Panel's subagent runs, their live activity, "focus this subagent" and stuck-handoff tracking on it.
 * A repeated id therefore REPLACES the earlier run: subagents invoked in a thread silently dropped out of the
 * list (operator report, 2026-09-20), and a later delegation could be shown with an earlier one's child session.
 *
 * So ids that are not already unique-looking are rewritten at the model boundary, before anything sees them:
 * `call_<24 hex>`, the shape OpenAI-compatible providers use. The model receives the rewritten ids back in its
 * history (assistant tool_calls + the matching tool results), which is all an opaque id has to satisfy — checked
 * against Kimi K2.6: it keeps calling tools correctly with rewritten ids in its history. Random provider ids
 * (GLM's `call_<hex>`, Anthropic's `toolu_…`) pass through untouched, so nothing changes for those models.
 */
import { randomBytes } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";

/** Ids that carry enough randomness to be unique on their own: a run of 16+ id characters. */
const LOOKS_UNIQUE = /[A-Za-z0-9_-]{16,}/;
/** Counter-style ids: `functions.name:3`, `call_0`, `tool-2`, `0`. */
const COUNTER = /(^|[:._-])\d{1,4}$/;

export function needsRewrite(id: string | undefined | null): boolean {
  if (!id) return true;
  if (COUNTER.test(id)) return true;
  return !LOOKS_UNIQUE.test(id);
}

export function mintToolCallId(): string {
  return `call_${randomBytes(12).toString("hex")}`;
}

/** One mapping per model call, so a streamed call's start / delta / end / final parts all agree. */
function remapper() {
  const seen = new Map<string, string>();
  return (id: string): string => {
    if (!needsRewrite(id)) return id;
    let next = seen.get(id);
    if (!next) {
      next = mintToolCallId();
      seen.set(id, next);
    }
    return next;
  };
}

export const uniqueToolCallIds: LanguageModelMiddleware = {
  specificationVersion: "v4",
  async wrapGenerate({ doGenerate }) {
    const result = await doGenerate();
    const remap = remapper();
    return {
      ...result,
      content: result.content.map((part) =>
        part.type === "tool-call" ? { ...part, toolCallId: remap(part.toolCallId) } : part,
      ),
    };
  },
  async wrapStream({ doStream }) {
    const result = await doStream();
    const remap = remapper();
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === "tool-call") controller.enqueue({ ...part, toolCallId: remap(part.toolCallId) });
            else if (part.type === "tool-input-start" || part.type === "tool-input-delta" || part.type === "tool-input-end") {
              controller.enqueue({ ...part, id: remap(part.id) });
            } else controller.enqueue(part);
          },
        }),
      ),
    };
  },
};

/**
 * Agent-turn counting, in each harness's own terms: one model response or one agent step.
 * The session sums these across launch + resumes and caps the total at MAX_AGENT_TURNS (100).
 *
 *  - Claude Code / Qwen / Amp (stream-json): one per distinct assistant message id (an API response).
 *  - Codex (`exec --json`): one per completed step item (agent_message, command_execution, file_change, MCP/web).
 *  - OpenCode / Kilo: one per `step_finish`.
 *  - Pi: one per assistant `message_end`.
 *  - Others: one per tool call, plus one for the final answer of the run.
 */
import { normalizeHarnessId } from "../harnesses/adapters.js";

export interface StepCounter {
  /** Feed one JSONL event; returns how many turns it added (0 or more). */
  observe(ev: Record<string, any>): number;
  /** Called once when the run ends; returns turns to add (e.g. a final answer not counted yet). */
  end(): number;
  readonly total: number;
}

const CODEX_STEPS = new Set(["agent_message", "assistant_message", "command_execution", "file_change", "mcp_tool_call", "web_search"]);
const TOOLISH = /tool_use|tool_call|toolcall|tool_execution_start|function_call/i;

export function newStepCounter(harness: string): StepCounter {
  const id = normalizeHarnessId(harness);
  let total = 0;
  const seen = new Set<string>();
  let sawText = false;
  const add = (n: number) => { total += n; return n; };
  const observe = (ev: Record<string, any>): number => {
    // ACP runs (a Zed persona): one step per completed tool call or agent message, whatever the harness.
    if (typeof ev.type === "string" && ev.type.startsWith("acp.")) return ev.type === "acp.tool_call" || ev.type === "acp.message" ? add(1) : 0;
    switch (id) {
      case "claude-code": case "qwen-code": case "amp": {
        if (ev.type !== "assistant") return 0;
        const mid = ev.message?.id ?? ev.uuid ?? `n${total + 1}`;
        if (seen.has(mid)) return 0;
        seen.add(mid);
        return add(1);
      }
      case "codex":
        return ev.type === "item.completed" && CODEX_STEPS.has(ev.item?.type) ? add(1) : 0;
      case "opencode": case "kilo":
        return ev.type === "step_finish" ? add(1) : 0;
      case "pi":
        return ev.type === "message_end" && ev.message?.role === "assistant" ? add(1) : 0;
      default: {
        const t = String(ev.type ?? ev.event ?? "");
        if (TOOLISH.test(t) || (ev.type === "agent_event" && ev.agent_event?.contentType === "tool" && ev.agent_event?.type === "content_start")) return add(1);
        if (/message|assistant|text|completion|result/i.test(t)) sawText = true;
        return 0;
      }
    }
  };
  return {
    observe,
    end: () => (["claude-code", "qwen-code", "amp", "codex", "opencode", "kilo", "pi"].includes(id) ? 0 : sawText ? add(1) : 0),
    get total() { return total; },
  };
}

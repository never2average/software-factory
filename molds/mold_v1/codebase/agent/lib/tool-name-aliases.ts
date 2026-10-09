/**
 * A tool's OLD name, called by the model, runs the tool it names now.
 *
 * A tool renamed to a neutral name (TOOL_ALIASES in agent/lib/agent-vocabulary.ts: `list_fdes` is `list_members`)
 * is advertised under its new name only. But a model can still ISSUE the old one: it reads it in a session's
 * history from before the rename, or in a stored workflow, app or memory that says "call list_fdes". eve has no
 * hidden-but-callable tool (a tool is named by its file, and every tool it has is advertised), and the SDK answers
 * a call to a name it was not given with an "unavailable tool" error. So the call is renamed here, at the model
 * boundary, before the SDK parses it: a tool call whose name was not offered on this call, and is the old name of
 * one that was, becomes a call to that one. A name that WAS offered is never touched, and neither is any other
 * name: an unknown tool still fails the way it always did.
 *
 * Installed with the other model middleware in agent/lib/model.ts. In gateway mode there is no middleware (the
 * SDK is handed a plain model id), and an old name gets the SDK's error, which lists the tools the model has.
 */
import type { LanguageModelMiddleware } from "ai";
import { TOOL_ALIASES, speakIdentifier } from "./agent-vocabulary.ts";

/** The names offered on one model call. */
function offeredNames(params: unknown): Set<string> {
  const tools = (params as { tools?: Array<{ name?: unknown }> } | undefined)?.tools ?? [];
  return new Set(tools.map((t) => t?.name).filter((n): n is string => typeof n === "string"));
}

/**
 * The offered name an old one now stands for, or the name unchanged. Exported for the tests. `speak` is how this
 * deployment's model is told a base name (`list_members`, or `list_analysts` under a relabelling profile).
 */
export function renameCall(name: string, offered: ReadonlySet<string>, speak: (base: string) => string = speakIdentifier): string {
  if (offered.has(name) || !Object.prototype.hasOwnProperty.call(TOOL_ALIASES, name)) return name;
  const base = TOOL_ALIASES[name];
  for (const candidate of [speak(base), base]) if (offered.has(candidate)) return candidate;
  return name;
}

export const toolNameAliases: LanguageModelMiddleware = {
  specificationVersion: "v4",
  async wrapGenerate({ doGenerate, params }) {
    const result = await doGenerate();
    const offered = offeredNames(params);
    return {
      ...result,
      content: result.content.map((part) => (part.type === "tool-call" ? { ...part, toolName: renameCall(part.toolName, offered) } : part)),
    };
  },
  async wrapStream({ doStream, params }) {
    const result = await doStream();
    const offered = offeredNames(params);
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === "tool-call" || part.type === "tool-input-start") controller.enqueue({ ...part, toolName: renameCall(part.toolName, offered) });
            else controller.enqueue(part);
          },
        }),
      ),
    };
  },
};

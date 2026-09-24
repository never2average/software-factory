/**
 * A tool as the MODEL meets it, in the deployment's words.
 *
 * Every tool this codebase defines is exported through `modelFacing(baseName, defineTool({...}))`. Under the
 * default profile that returns the tool itself, untouched: same object, same name, same description, same
 * schema — the default deployment's model sees exactly what it saw before.
 *
 * Under a profile that relabels the domains (agent/lib/agent-vocabulary.ts), the model gets a translated tool:
 *
 *   - its NAME in the profile's words (`list_customers` -> `list_companies`), the base name hidden from it;
 *   - its description, parameter names, parameter descriptions and enum values spoken the same way;
 *   - its input translated BACK before the base tool runs (parameter names, enum values, a data-room path's
 *     display folder), then validated by the base zod schema, so the base tool and storage never change;
 *   - its result translated out (keys, stored enum values, data-room paths, memory scopes, its own messages).
 *
 * A renamed tool has to be a dynamic tool: eve names a static tool after its file (`agent/tools/
 * list_customers.ts` is `list_customers`, in the root and in every subagent and pack that re-exports it), and
 * only a `defineDynamic` map chooses its own names. The base name stays callable by everything that is not
 * the model: the CLI, the API and the MCP server call the system of record directly, never these objects.
 *
 * WHY THIS FILE IS UNDER A `tools/` DIRECTORY. eve rebuilds a dynamic tool's `execute` after a restart from a
 * step function its bundler hoists out of the resolver — and it only runs that transform on modules whose path
 * contains `/tools/` (eve's `addDynamicToolTransformPlugin`). The transform also needs `execute` written inline
 * inside a `defineDynamic({ events: { ... } })` handler, and captures only variables declared in that handler.
 * Hence the shape below: the handler declares `toolKey`, and `execute` calls a module-level function with it.
 * (`turn.started` rather than `session.started`: see the comment at the resolver.)
 * A pre-built tool returned from a resolver (what agent/subagents/browser/tools/browser.ts does) works until
 * the process restarts, then eve logs "has no registered step function — skipping" and the tool vanishes.
 */
import { defineDynamic, defineTool } from "eve/tools";
import {
  VOCABULARY_RELABELLED,
  inputFromModel,
  outputForModel,
  registerModelToolName,
  schemaForModel,
  speak,
  speakFieldValue,
  speakIdentifier,
  speakMessage,
  type SchemaMap,
} from "../../agent-vocabulary.ts";

export interface ModelFacingOptions {
  /** Input keys whose value is passed through untouched, however deep (a remote tool's arguments). */
  opaqueInput?: string[];
  /**
   * Input keys holding a DATA-ROOM path: the display folder at the head goes back to the stored one. Only these
   * are paths; a sandbox path (publish_artifact's `path`, read_image's `sandboxPath`) and free text never are.
   */
  pathInput?: string[];
  /** Input keys holding a free-form object whose KEYS the model was taught in its words (trigger_workflow `args`). */
  argsInput?: string[];
  /**
   * Result keys whose value is stored file content or an external page: left exactly as stored. `"*"` leaves the
   * whole result alone except a top-level `error` message (a web page or a remote tool's answer is not ours).
   */
  opaqueOutput?: string[] | "*";
  /** Result keys whose string values are names the tool generates (sheet names, column headers): spoken as code. */
  spokenOutput?: string[];
}

interface BaseTool {
  description?: string;
  inputSchema?: unknown;
  approval?: unknown;
  execute: (input: never, ctx: never) => unknown;
}

interface Entry {
  tool: BaseTool;
  map: SchemaMap;
  opaqueIn: Set<string>;
  pathIn: Set<string>;
  argsIn: Set<string>;
  opaqueOut: Set<string> | "*";
  spokenOut: Set<string>;
}

const BASES = new Map<string, Entry>();

/** The JSON Schema eve would advertise for a tool input (its own conversion: draft-07, no `$schema`). */
function jsonSchemaOf(schema: unknown): unknown {
  const std = (schema as { "~standard"?: { jsonSchema?: { input?: (o: { target: string }) => unknown } } })?.["~standard"];
  const convert = std?.jsonSchema?.input;
  if (typeof convert !== "function") return schema;
  const { $schema: _drop, ...rest } = convert({ target: "draft-07" }) as Record<string, unknown>;
  return rest;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run a base tool for the model: input back to base words, validated, executed, result out in the model's. */
async function runModelFacing(baseName: string, input: unknown, ctx: unknown): Promise<unknown> {
  const entry = BASES.get(baseName);
  if (!entry) throw new Error(`no tool registered as ${baseName}`);
  let baseInput = inputFromModel(input, entry.map, { opaque: entry.opaqueIn, paths: entry.pathIn, argsKeys: entry.argsIn });
  const schema = entry.tool.inputSchema as { safeParse?: (x: unknown) => { success: boolean; data?: unknown; error?: { issues?: { path: PropertyKey[]; message: string }[] } } } | undefined;
  if (schema && typeof schema.safeParse === "function") {
    const parsed = schema.safeParse(baseInput);
    if (!parsed.success) {
      // Paths and the values an issue lists, in the words the model's schema used: `portfolioEntry.blockerOwner:
      // expected one of "Provider"|"Company"…`, not the base key and the stored value.
      const issues = (parsed.error?.issues ?? []).map((i) => {
        const field = [...i.path].reverse().find((s): s is string => typeof s === "string") ?? "";
        const path = i.path.map((s) => (typeof s === "string" ? speakIdentifier(s) : String(s))).join(".") || "input";
        const message = i.message.replace(/"([^"\n]*)"/g, (q, value: string) => `"${speakFieldValue(field, value)}"`);
        return `${path}: ${message}`;
      }).join("; ");
      throw new Error(speakMessage(`invalid input: ${issues || "does not match the schema"}`));
    }
    baseInput = parsed.data;
  }
  let result: unknown;
  try {
    result = await entry.tool.execute(baseInput as never, ctx as never);
  } catch (error) {
    // The tool's own words, spoken WITHOUT the ids, names and keys they embed (agent-vocabulary: speakMessage).
    throw new Error(speakMessage(messageOf(error)));
  }
  if (entry.opaqueOut === "*") {
    if (result && typeof result === "object" && !Array.isArray(result) && typeof (result as { error?: unknown }).error === "string") {
      return { ...(result as Record<string, unknown>), error: speakMessage((result as { error: string }).error) };
    }
    return result;
  }
  return outputForModel(result, entry.opaqueOut, entry.spokenOut);
}

/**
 * The tool the model is given for `baseName` (the file slug that re-exports it). Identity under the default
 * profile. The return type is the base tool's so every re-export and every direct caller type-checks as before;
 * under a relabelling profile the value may be a dynamic definition, which eve accepts wherever a tool goes.
 */
export function modelFacing<T>(baseName: string, tool: T, options: ModelFacingOptions = {}): T {
  if (!VOCABULARY_RELABELLED) return tool;
  const base = tool as unknown as BaseTool;
  const { schema, map } = schemaForModel(jsonSchemaOf(base.inputSchema));
  BASES.set(baseName, {
    tool: base,
    map,
    opaqueIn: new Set(options.opaqueInput ?? []),
    pathIn: new Set(options.pathInput ?? []),
    argsIn: new Set(options.argsInput ?? []),
    opaqueOut: options.opaqueOutput === "*" ? "*" : new Set(options.opaqueOutput ?? []),
    spokenOut: new Set(options.spokenOutput ?? []),
  });
  const name = registerModelToolName(baseName);
  const description = speak(base.description ?? "");
  // `as never`: a translated JSON Schema object and the base tool's own approval policy, whose types eve cannot
  // relate to each other. Casts stay on the property VALUES: eve's transform needs the arguments of
  // `defineDynamic(...)` and `defineTool(...)` to be plain object literals.
  const inputSchema = schema as never;
  const approval = base.approval === undefined ? {} : { approval: base.approval as never };

  if (name === baseName) {
    // Same name: a static tool, named by its file like any other.
    const same = defineTool({
      description,
      inputSchema,
      ...approval,
      execute: async (input, ctx) => runModelFacing(baseName, input, ctx),
    });
    return same as unknown as T;
  }

  // A new name: a dynamic tool, the only kind whose name is not its file's. Resolved on EVERY turn, not once per
  // session: a session that began before this deployment was relabelled holds no session.started result for
  // this file (it had the static base tool then), and would otherwise have neither name for the rest of its life.
  const renamed = defineDynamic({
    events: {
      "turn.started": async () => {
        const toolKey = baseName;
        return {
          [name]: defineTool({
            description,
            inputSchema,
            ...approval,
            execute: async (input, ctx) => runModelFacing(toolKey, input, ctx),
          }),
        };
      },
    },
  });
  return renamed as unknown as T;
}

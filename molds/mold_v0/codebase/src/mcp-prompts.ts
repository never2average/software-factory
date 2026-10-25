/**
 * Declared slash commands (mold_v0-137; MOLD.md "MCP words as config"): a pack's pack.json `mcp.prompts[]`
 * (src/pack-api.ts McpPromptSchema) as MCP prompts on the customer MCP server, after every tool and the host packs' own
 * prompts, in pack order. Each lists its title, description and arguments (a string the person may or must give); its
 * answer is one user message, the prompt's text (a template, src/text-template.ts) filled with the arguments given. An
 * `integer` argument counts as given only when it is a positive number, and is filled in rounded. Nothing else: a
 * prompt reads no record and calls no tool, so it needs no role (the tools its text asks for check their own).
 * Zero packs, or packs that declare none: no prompt is registered, and the server has no prompts capability.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { promptText, type McpPrompt } from "./pack-api.js";
import { packs, type InstalledPack } from "./packs.js";
import { fillTemplate, type TemplateValue } from "./text-template.js";

/** The message a prompt answers with. */
const say = (text: string): GetPromptResult => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

/** The values a prompt's text is filled with: the arguments given, an integer one as a whole number or not given. */
export function promptValues(p: McpPrompt, args: Readonly<Record<string, string | undefined>>): Record<string, TemplateValue> {
  const out: Record<string, TemplateValue> = {};
  for (const a of p.arguments ?? []) {
    const v = args[a.name];
    if (a.type === "integer") out[a.name] = v && Number(v) > 0 ? Math.round(Number(v)) : undefined;
    else out[a.name] = v;
  }
  return out;
}

/** A declared prompt's text, filled with these arguments. */
export const renderPrompt = (p: McpPrompt, args: Readonly<Record<string, string | undefined>> = {}): string =>
  fillTemplate(promptText(p), promptValues(p, args));

/** The packs' declared prompts, in pack order and each pack's order. */
export const declaredPrompts = (list: readonly InstalledPack[] = packs()): { pack: string; prompt: McpPrompt }[] =>
  list.flatMap((p) => (p.definition.mcp?.prompts ?? []).map((prompt) => ({ pack: p.id, prompt: prompt as McpPrompt })));

/** Register the packs' declared prompts on a customer MCP server (src/server.ts createServer). */
export function registerPackPrompts(server: McpServer, list: readonly InstalledPack[] = packs()) {
  for (const { prompt: p } of declaredPrompts(list)) {
    const meta = { title: p.title, description: p.description };
    if (!p.arguments?.length) { server.registerPrompt(p.name, meta, () => say(renderPrompt(p))); continue; }
    // Every argument is text on the wire; a required one must be given (the SDK refuses the call without it).
    const argsSchema: Record<string, z.ZodType<string> | z.ZodOptional<z.ZodString>> = {};
    for (const a of p.arguments) {
      const field = a.required ? z.string() : z.string().optional();
      argsSchema[a.name] = (a.description ? field.describe(a.description) : field) as z.ZodOptional<z.ZodString>;
    }
    server.registerPrompt(p.name, { ...meta, argsSchema }, (args: Record<string, string | undefined>) => say(renderPrompt(p, args)));
  }
}

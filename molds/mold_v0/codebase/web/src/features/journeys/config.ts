import * as facts from '../../config/build-facts.generated';

/**
 * The journeys and in-chat tips components (mold_v0-143; src/journeys.ts and src/tips.ts on the server): pack.json
 * `journeys` and `tips`, as scripts/gen-packs.mjs writes them into the build facts (JOURNEYS, TIPS). Each null when the
 * build has it off: then /app/journeys is not found, and /admin/journeys only where the other is on. Plain TS with
 * relative imports: web/src/lib/console-routes.ts reads it.
 */
export interface JourneyFacts {
  pack: string;
  /** The built-in templates' ids (pack.json journeys.templates): the admin page tells them from ones written by hand. */
  built_in: string[];
  /** The tools and Setup workflow groups that start work: a viewer sees the Setup page's viewer note instead of their prompt. */
  launch: { tools: string[]; groups: string[] };
  /** The placeholders the built-in templates' stages use ({product}, ...), which the editor offers to insert. */
  tokens: string[];
  words: Record<'export_prefix' | 'use_case_name_placeholder' | 'stage_prompt_placeholder' | 'stage_expect_placeholder', string>;
}
export interface TipFacts { pack: string; words: Record<'prompt_placeholder', string> }
export const journeyFacts = (): JourneyFacts | null => (facts as { JOURNEYS?: JourneyFacts }).JOURNEYS ?? null;
export const tipFacts = (): TipFacts | null => (facts as { TIPS?: TipFacts }).TIPS ?? null;
export const journeysOn = (): boolean => journeyFacts() !== null;
export const tipsOn = (): boolean => tipFacts() !== null;
/** A tool (or Setup workflow group) that starts work, whose prompt a viewer does not get. */
export const launchesWork = (tool: string): boolean => journeyFacts()?.launch.tools.includes(tool) ?? false;
export const launchGroup = (group: string): boolean => journeyFacts()?.launch.groups.includes(group) ?? false;

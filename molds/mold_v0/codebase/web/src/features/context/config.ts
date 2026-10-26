import * as facts from '@/config/build-facts.generated';

/**
 * The account context and memory component's pages (mold_v0-142; src/account-context.ts on the server): pack.json
 * `memory`, as scripts/gen-packs.mjs writes it into the build facts (CONTEXT_MEMORY). Null when the build has it off:
 * then /app/context is not found.
 */
export type ContextSection = 'company' | 'users' | 'products';
export interface ContextMemoryFacts {
  pack: string;
  sections: { scope: 'company' | 'user' | 'product'; section: ContextSection; path: string; title: string; icon: string }[];
  /** Old page names under /app/context and the page each now is. */
  aliases: Record<string, ContextSection>;
  /** The words its pages show (src/account-context-words.ts WEB_WORDS, the pack's or the default). */
  words: Record<'hint_fact' | 'hint_decision' | 'hint_preference' | 'hint_note' | 'subject_label' | 'subject_placeholder' | 'export_prefix' | 'you_label', string>;
}
export const contextMemory = (): ContextMemoryFacts | null => (facts as { CONTEXT_MEMORY?: ContextMemoryFacts }).CONTEXT_MEMORY ?? null;

/**
 * Where an address under /app/context leads: a page of the build, a page by an old name (redirect), or for /app/context
 * itself the page its `?tab=` names (a page, an old name, a scope, or `me`: the users page), else the first page.
 */
export function resolveContext(path: string[] | undefined, tab?: string): { page: ContextMemoryFacts['sections'][number] } | { redirect: string } | null {
  const c = contextMemory();
  if (!c || !c.sections.length) return null;
  const byName = (n: string | undefined) => n === undefined ? undefined
    : c.sections.find((s) => s.section === n) ?? c.sections.find((s) => s.section === c.aliases[n])
      ?? c.sections.find((s) => s.scope === n || (n === 'me' && s.scope === 'user'));
  if (!path?.length) return { redirect: (byName(tab) ?? c.sections[0]!).path };
  if (path.length !== 1) return null;
  const page = c.sections.find((s) => s.section === path[0]);
  if (page) return { page };
  const alias = c.aliases[path[0]!];
  const to = alias && c.sections.find((s) => s.section === alias);
  return to ? { redirect: to.path } : null;
}

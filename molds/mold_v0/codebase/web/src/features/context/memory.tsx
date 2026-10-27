'use client';
// The account context pages' pieces (mold_v0-142; context-page.tsx): the memory item kinds, each with its example from
// the build's words (pack.json memory.words), and the docked compose window where items are saved and changed.
import { contextMemory } from './config';

export type MemoryScope = 'company' | 'user' | 'product';
export type Kind = 'fact' | 'decision' | 'preference' | 'note';
export interface MemoryItem { id: number; kind: Kind; body: string; created_by: string | null; created_at: string; can_delete: boolean; subject?: string; subject_name?: string }

const LABELS: Record<Kind, string> = { fact: 'Fact', decision: 'Decision', preference: 'Preference', note: 'Note' };
/** The kinds, each with its label and its example (the build's words). */
export const kinds = (): { id: Kind; label: string; hint: string }[] => {
  const w = contextMemory()?.words;
  return (['fact', 'decision', 'preference', 'note'] as const).map((id) => ({ id, label: LABELS[id], hint: w?.[`hint_${id}`] ?? '' }));
};
export const TYPE_STYLE: Record<string, string> = {
  fact: 'bg-primary/10 text-primary ring-primary/25',
  decision: 'bg-amber-500/10 text-amber-800 ring-amber-600/25 dark:text-amber-300 dark:ring-amber-400/25',
  preference: 'bg-sky-500/10 text-sky-700 ring-sky-600/25 dark:text-sky-300 dark:ring-sky-400/25',
  note: 'bg-muted/60 text-muted-foreground ring-border'
};

/** The shell's docked compose window (web/src/components/layout/dock.tsx). */
export { Dock } from '@/components/layout/dock';

import { profile } from '@/config/profile.generated';
import { text } from '@/lib/texts';
import { capWord } from '@/lib/words.generated';

/**
 * The journeys and tips pages' texts (mold_v0-143): each written with the build's words for a journey ({guide},
 * {guides}, {Guide}, {Guides}: the shell texts journeys.one and journeys.many) and its product's name ({product}).
 */
export function jw(t: string): string {
  const one = text('journeys.one'), many = text('journeys.many');
  const v: Record<string, string> = { guide: one, guides: many, Guide: capWord(one), Guides: capWord(many), product: profile.name };
  return t.replace(/\{([A-Za-z]+)\}/g, (m, n: string) => v[n] ?? m);
}

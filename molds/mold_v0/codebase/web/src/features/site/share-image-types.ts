/**
 * The share image (mold_v0-093): what a link to this build shows when it is shared (Open Graph and X). scripts/gen-packs.mjs
 * writes it to web/src/config/share-image.generated.ts from the profile and the landing block; share-image.tsx draws it.
 */
export interface ShareImageSpec {
  /** The image's alternative text: the drawn image's own words, or the profile's description for the brand's picture. */
  alt: string;
  /** The profile's name, beside the mark. */
  name: string;
  /** The landing page's headline (the block's, else the profile's tagline), the image's largest words. */
  headline: string;
  /** The landing page's sub-headline, unless it only repeats the headline. */
  subheadline: string | null;
  /**
   * The brand's own picture (the factory's branding step: brand/share-image.png in the build copy, a 1200x630 PNG),
   * served byte for byte instead of the drawn image; null: the image is drawn.
   */
  brand: { png: string; sha256: string } | null;
}

/** Every share image is 1200x630 (the size Open Graph and X show in full), a PNG. */
export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 } as const;
export const SHARE_IMAGE_TYPE = 'image/png';

/** A text cut to at most `max` characters, at a word where it can be, with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
}

/** The headline's size: as large as fits in three lines across the image. */
export function headlineSize(text: string): number {
  const n = text.length;
  return n <= 34 ? 76 : n <= 60 ? 64 : n <= 90 ? 54 : 46;
}

/** A brand colour the image may use (#rgb or #rrggbb), else the shell's own accent. */
export function accentOf(color: unknown, fallback = '#3ecf8e'): string {
  return typeof color === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : fallback;
}

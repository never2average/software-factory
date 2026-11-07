/**
 * The console's own avatars (mold_v0-275). A person or an organisation without an uploaded picture is drawn here, never
 * with the sign-in provider's generated picture (Clerk returns one in `imageUrl` when `hasImage` is false): a soft
 * gradient of two colours of the app's palette, with their initials in white. Everything is chosen from the id, so the
 * same person looks the same on every page and every visit.
 *
 * The palette is the brand's (the factory's branding step derives it from the brand colour, or the brand pins its own:
 * profile.generated.ts `avatar_palette`); without one, the theme's --avatar-1 to --avatar-5, shades of its primary
 * colour (web/src/styles/themes/supabase.css). Every colour carries white initials at 4.5:1 or more.
 */
import { profile } from '@/config/profile.generated';

/** The theme's default palette (shades of its primary colour), as CSS colours. */
export const THEME_AVATAR_COLORS = ['var(--avatar-1)', 'var(--avatar-2)', 'var(--avatar-3)', 'var(--avatar-4)', 'var(--avatar-5)'] as const;

/** The app's avatar colours: the brand's, else the theme's. */
export function avatarPalette(): readonly string[] {
  const own = (profile as { avatar_palette?: readonly string[] }).avatar_palette;
  return own && own.length >= 2 ? own : THEME_AVATAR_COLORS;
}

/** FNV-1a, 32 bits: the same number for the same text, everywhere (no randomness, no clock). */
export function avatarHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface AvatarLook {
  /** The two colours of the gradient (different whenever the palette has two). */
  from: string;
  to: string;
  /** The gradient's direction in degrees, and where its soft highlight sits (percent of the width and height). */
  angle: number;
  x: number;
  y: number;
}

/** The look of one person's or organisation's avatar, from its id (or, without one, its email or name). */
export function avatarLook(key: string, palette: readonly string[] = avatarPalette()): AvatarLook {
  const h = avatarHash(key || '?');
  const n = palette.length;
  const i = h % n;
  const j = n > 1 ? (i + 1 + ((h >>> 8) % (n - 1))) % n : i;
  return { from: palette[i]!, to: palette[j]!, angle: (h >>> 12) % 360, x: 20 + ((h >>> 20) % 60), y: 15 + ((h >>> 26) % 50) };
}

/**
 * The background a drawn avatar is painted with: a soft "marble", one colour's glow over a gradient of both. Only the
 * palette's two colours and their blends are painted (no white), so white initials read as well as on either colour.
 */
export function avatarBackground(look: AvatarLook): string {
  return `radial-gradient(circle at ${look.x}% ${look.y}%, ${look.to} 0%, transparent 65%), linear-gradient(${look.angle}deg, ${look.from}, color-mix(in oklch, ${look.from} 45%, ${look.to}))`;
}

/**
 * Up to two initials: the first and last word's of a name (a person's, an organisation's), the first two letters of a
 * one-word name, else the first two letters of the email's name. Letters and digits only; '?' when there is nothing to take them from.
 */
export function avatarInitials(name?: string | null, email?: string | null): string {
  const words = (name ?? '').trim().split(/[\s._-]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (words.length >= 2) return (words[0]!.charAt(0) + words[words.length - 1]!.charAt(0)).toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  const local = (email ?? '').split('@')[0]!.replace(/[^\p{L}\p{N}]/gu, '');
  return local ? local.slice(0, 2).toUpperCase() : '?';
}

/**
 * Whether to show the uploaded picture: only one the person or organisation uploaded. Clerk's `hasImage` is false for
 * its generated pictures (their `imageUrl` still answers); the built-in sign-in has no pictures.
 */
export function uploadedPicture(imageUrl?: string | null, hasImage?: boolean | null): string | null {
  return hasImage && imageUrl ? imageUrl : null;
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import manifest from '@/app/manifest';
import { shareImage } from '@/config/share-image.generated';
import { accentOf, clip, headlineSize, SHARE_IMAGE_SIZE, SHARE_IMAGE_TYPE, type ShareImageSpec } from './share-image-types';

/**
 * The share image (mold_v0-093; app/opengraph-image.tsx and app/twitter-image.tsx): what a link to this build shows
 * when it is shared. Drawn from the build's own words (the profile's name, the landing page's headline and
 * sub-headline: share-image.generated.ts) and its brand (the mark in app/icon.svg, else the manifest's PNG icon; the
 * manifest's theme colour, which the brand step sets), so no build ever shows another product's picture. The font is
 * the one next/og carries (Geist): nothing is fetched to draw it. A brand that has its own picture (the factory's
 * branding step, brand/share-image.png) gets that picture, byte for byte.
 */

/** The web project's own files: `next build` and `next start` run in web/ (a check run from the codebase root reads web/). */
async function webFile(rel: string): Promise<Buffer | null> {
  for (const base of [process.cwd(), path.join(process.cwd(), 'web')]) {
    try {
      return await readFile(path.join(base, rel));
    } catch {
      /* the next place */
    }
  }
  return null;
}

/** The build's mark as a data: URL: its vector icon, else the largest PNG icon the brand step wrote, else the touch icon. */
async function markUrl(): Promise<string | null> {
  const svg = await webFile('src/app/icon.svg');
  if (svg) return `data:image/svg+xml;base64,${svg.toString('base64')}`;
  for (const png of ['public/icon-512.png', 'public/icon-192.png', 'src/app/apple-icon.png']) {
    const b = await webFile(png);
    if (b) return `data:image/png;base64,${b.toString('base64')}`;
  }
  return null;
}

// As next/og's own: the image's address does not change when the build's words do, so a cache asks again.
const HEADERS = { 'Content-Type': SHARE_IMAGE_TYPE, 'Cache-Control': 'public, max-age=0, must-revalidate' };

/** The share image as a response: the brand's own picture as it is, else the image drawn from the build's words. */
export async function renderShareImage(spec: ShareImageSpec = shareImage): Promise<Response> {
  if (spec.brand) return new Response(new Uint8Array(Buffer.from(spec.brand.png, 'base64')), { headers: HEADERS });
  const m = manifest();
  const accent = accentOf(m.theme_color);
  const background = accentOf(m.background_color, '#121212');
  const mark = await markUrl();
  const headline = clip(spec.headline, 110);
  const sub = spec.subheadline ? clip(spec.subheadline, 150) : null;
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background, color: '#f5f5f5', padding: '72px 96px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {mark ? (
            // eslint-disable-next-line @next/next/no-img-element -- drawn by next/og, not a page
            <img src={mark} width={88} height={88} alt='' style={{ borderRadius: 18 }} />
          ) : (
            <div style={{ display: 'flex', width: 88, height: 88, borderRadius: 18, background: accent }} />
          )}
          <div style={{ display: 'flex', marginLeft: 28, fontSize: 40, color: '#e5e5e5' }}>{clip(spec.name, 40)}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center', paddingBottom: 24 }}>
          <div style={{ display: 'flex', fontSize: headlineSize(headline), lineHeight: 1.15, letterSpacing: '-0.02em', color: '#fafafa' }}>{headline}</div>
          {sub ? <div style={{ display: 'flex', marginTop: 28, fontSize: 30, lineHeight: 1.35, color: '#a3a3a3' }}>{sub}</div> : null}
        </div>
        <div style={{ display: 'flex', height: 10, marginLeft: -96, marginRight: -96, background: accent }} />
      </div>
    ),
    { ...SHARE_IMAGE_SIZE }
  );
}

/** The image's alternative text, size and type (the route's `alt`, `size` and `contentType`). */
export const shareImageAlt = shareImage.alt;

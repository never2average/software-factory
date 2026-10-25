// The share image on a page's own link preview (mold_v0-148). Next.js adds app/opengraph-image and app/twitter-image to
// every page's metadata only while no page sets `openGraph` or `twitter` itself: a page that does (the landing page, the
// legal pages: their own title, description and address) replaces the whole object, image and all. So such a page names
// the image too, with these. The image itself is the build's (mold_v0-093; share-image.tsx).
import type { Metadata } from 'next';
import { shareImage } from '@/config/share-image.generated';
import { SHARE_IMAGE_SIZE, SHARE_IMAGE_TYPE } from './share-image-types';

/** The images entry of a page's openGraph: the build's share image at its route (app/opengraph-image). */
export const ogImages = () => [{ url: '/opengraph-image', ...SHARE_IMAGE_SIZE, type: SHARE_IMAGE_TYPE, alt: shareImage.alt }];

/** A page's X card with the build's share image (app/twitter-image): the large image card unless the landing block's seo.card says summary. */
export const twitterCard = (title: string, description: string, card: 'summary' | 'summary_large_image' = 'summary_large_image'): NonNullable<Metadata['twitter']> =>
  ({ card, title, description, images: [{ url: '/twitter-image', alt: shareImage.alt, ...SHARE_IMAGE_SIZE }] });

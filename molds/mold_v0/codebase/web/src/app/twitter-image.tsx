import { renderShareImage, shareImageAlt } from '@/features/site/share-image';
import { SHARE_IMAGE_SIZE, SHARE_IMAGE_TYPE } from '@/features/site/share-image-types';

// The share image (mold_v0-093; features/site/share-image.tsx): drawn from the build's profile, landing words and brand,
// or the brand's own picture. Made once, when the console is built.
export const alt = shareImageAlt;
export const size = SHARE_IMAGE_SIZE;
export const contentType = SHARE_IMAGE_TYPE;

export default function Image() {
  return renderShareImage();
}

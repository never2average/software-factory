import type { MetadataRoute } from 'next';
import { profile } from '@/config/profile.generated';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: profile.console_title,
    short_name: profile.console_title,
    description: profile.short_description,
    start_url: '/app',
    display: 'standalone',
    background_color: '#121212',
    theme_color: '#3ecf8e',
    icons: [
      { src: '/icon.svg', type: 'image/svg+xml', sizes: 'any' },
      { src: '/apple-icon.png', type: 'image/png', sizes: '180x180' }
    ]
  };
}

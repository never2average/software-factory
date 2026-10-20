import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Octillion',
    short_name: 'Octillion',
    description: 'Agentic Preference Optimization: see how often coding agents pick your developer tool, and what to change.',
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

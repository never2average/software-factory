import { FilesPage } from '@/features/files/files-page';

// The workspace store's file viewer (mold_v0-056; src/workspace-files.ts): the versions a pack's runs wrote, their
// files, a text file's contents and a diff between two versions. mold_v0-298: the list and its side panel live in
// features/files/files-page.tsx (each version named by when it was saved and what saved it). With no workspace store
// the sidebar has no entry and the API answers 404, so the page says there is nothing to show.
export const metadata = { title: 'Files' };

export default async function Page({ searchParams }: { searchParams: Promise<{ store?: string | string[] }> }) {
  const { store } = await searchParams;
  return <FilesPage initialStore={typeof store === 'string' ? store : null} />;
}

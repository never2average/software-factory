'use client';
// A run or a workspace agent session that made or changed a record (mold_v0-310; the server's src/record-runs.ts): its
// kind in words, then its title linked to its page (a run's own page, or the agent's page with the session open). The
// record header's "Made by", a history line's writer and a runs section's `wrote` list draw it.
import Link from 'next/link';
import { runLinkKind, type RunLink } from './detail-layout';

export function RunLinkText({ link, capital = false }: { link: RunLink; capital?: boolean }) {
  const kind = runLinkKind(link);
  return (
    <span data-record-run-link={link.kind}>
      {capital ? kind.charAt(0).toUpperCase() + kind.slice(1) : kind}{' '}
      <Link href={link.href} className='text-foreground font-medium underline-offset-4 hover:underline' data-run-link-id={link.id}>{link.title}</Link>
    </span>
  );
}

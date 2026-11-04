'use client';
// A record's documents (mold_v0-220): the files its file fields hold and the documents its URL fields point at
// (`preview: "document"`), each a card in the record's details card with its name, type and size, Download and an inline
// preview: a PDF in the browser's own viewer, an image, plain text, an email's HTML (sanitised on the server, in a
// sandboxed frame, remote images blocked until "Load images"). Any other type is download only, said so. The cards and
// every link come from /api/records/<area>/<key>/files (src/record-files.ts): signed, short-lived, same-origin links,
// served only to people who may read the area; this page never holds a file's bytes.
import { useEffect, useState } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import type { RecordAreaSpec, RecordFieldSpec } from '@/config/pack-nav.generated';
import { cn } from '@/lib/utils';
import { recordsApi } from './registry';

export type FileCard = {
  id: string; field: string; label: string; n: number; source: 'file' | 'document';
  name: string; size: number | null; content_type: string | null; preview: 'pdf' | 'image' | 'text' | 'html' | null;
  url?: string; fetched_at?: string; error?: string; preview_url: string | null; download_url: string | null;
};

/** Whether an area's records may have documents: a file field, or a field that previews its URL's document. */
export const hasDocuments = (area: RecordAreaSpec) => area.fields.some((f) => f.type === 'file' || f.preview === 'document');
/** A stored file's reference (never a workspace store path): the cards show it, the details list need not. */
export const isStoredFile = (f: RecordFieldSpec | undefined, v: unknown) =>
  f?.type === 'file' && (Array.isArray(v) ? v : [v]).some((x) => !!x && typeof x === 'object' && 'object' in (x as object));

const size = (n: number | null) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const TYPE_WORDS: Record<string, string> = {
  'application/pdf': 'PDF', 'image/png': 'PNG image', 'image/jpeg': 'JPEG image', 'image/gif': 'GIF image', 'image/webp': 'WebP image',
  'text/plain': 'Text', 'text/html': 'Web page', 'text/csv': 'CSV', 'application/json': 'JSON', 'message/rfc822': 'Email message',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document', 'application/msword': 'Word document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel workbook', 'application/vnd.ms-excel': 'Excel workbook'
};
const typeWords = (c: FileCard) => (!c.content_type ? 'Document' : c.content_type === 'text/html' && c.source === 'file' ? 'Email (HTML)' : TYPE_WORDS[c.content_type] ?? c.content_type);

function TypeIcon({ c }: { c: FileCard }) {
  const cls = 'size-5 shrink-0';
  if (c.preview === 'pdf') return <Icons.fileTypePdf className={cn(cls, 'text-red-600 dark:text-red-400')} />;
  if (c.preview === 'image') return <Icons.media className={cn(cls, 'text-emerald-600 dark:text-emerald-400')} />;
  if (c.preview === 'html' && c.source === 'file') return <Icons.mail className={cn(cls, 'text-sky-600 dark:text-sky-400')} />;
  if (c.content_type?.includes('spreadsheet') || c.content_type?.includes('excel')) return <Icons.fileTypeXls className={cn(cls, 'text-green-700 dark:text-green-400')} />;
  if (c.content_type?.includes('word')) return <Icons.fileTypeDoc className={cn(cls, 'text-blue-600 dark:text-blue-400')} />;
  return <Icons.page className={cn(cls, 'text-muted-foreground')} />;
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(url, { credentials: 'same-origin' }).then(async (r) => { if (!r.ok) throw new Error(String(r.status)); const t = await r.text(); if (live) setText(t); }).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [url]);
  if (failed) return <p className='text-muted-foreground p-3 text-sm'>This text could not be shown. Download it instead.</p>;
  if (text === null) return <p className='text-muted-foreground p-3 text-sm'>Loading…</p>;
  return <pre className='max-h-96 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words'>{text}</pre>;
}

function Preview({ c }: { c: FileCard }) {
  const [images, setImages] = useState(false);
  if (c.error) return (
    <div className='text-muted-foreground flex flex-col gap-1 p-3 text-sm'>
      <span>This document could not be fetched: {c.error}</span>
    </div>
  );
  if (!c.preview || !c.preview_url) return <p className='text-muted-foreground p-3 text-sm'>No preview for this type. Download it to open it.</p>;
  if (c.preview === 'pdf') return <iframe src={c.preview_url} title={`${c.name} (preview)`} className='h-[32rem] w-full rounded-b-lg border-0 bg-white' />;
  if (c.preview === 'image') return (
    <div className='bg-muted/40 flex justify-center p-3'>
      {/* eslint-disable-next-line @next/next/no-img-element -- a signed, same-origin link to the file itself, not an asset Next can optimise */}
      <img src={c.preview_url} alt={c.name} className='max-h-[28rem] max-w-full rounded object-contain' />
    </div>
  );
  if (c.preview === 'text') return <TextPreview url={c.preview_url} />;
  return (
    <div className='flex flex-col'>
      <div className='text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5 text-xs'>
        <span>{images ? 'Images in this message are shown.' : 'Images from the web are blocked until you load them.'}</span>
        <Button variant='ghost' size='sm' className='h-7' onClick={() => setImages((x) => !x)} aria-pressed={images}>
          <Icons.media className='size-3.5' />{images ? 'Block images' : 'Load images'}
        </Button>
      </div>
      {/* No script, no same-origin: the server's policy runs nothing and its links open in a new tab. */}
      {/* Mail is written for a light page (its own inline colours): in dark mode it sits as a light sheet on a framed, muted background. */}
      <div className='dark:bg-muted/50 rounded-b-lg dark:p-3'>
        <iframe key={images ? 'on' : 'off'} src={`${c.preview_url}${images ? '&images=1' : ''}`} title={`${c.name} (preview)`}
          sandbox='allow-popups allow-popups-to-escape-sandbox' referrerPolicy='no-referrer'
          className='block h-[28rem] w-full rounded-b-lg border-0 bg-white dark:rounded-md dark:shadow-sm dark:ring-1 dark:ring-border' />
      </div>
    </div>
  );
}

function DocumentCard({ c }: { c: FileCard }) {
  const meta = [typeWords(c), size(c.size), c.label].filter(Boolean).join(' · ');
  return (
    <li className='bg-card overflow-hidden rounded-lg border' data-document-card={c.preview ?? 'none'}>
      <div className='flex flex-wrap items-center gap-3 px-3 py-2'>
        <TypeIcon c={c} />
        <div className='flex min-w-0 flex-1 flex-col'>
          <span className='truncate text-sm font-medium' title={c.name}>{c.name}</span>
          <span className='text-muted-foreground truncate text-xs'>{meta}</span>
        </div>
        <div className='flex items-center gap-1'>
          {c.url && (
            <Button variant='ghost' size='sm' render={<a href={c.url} target='_blank' rel='noopener noreferrer' />}>
              <Icons.externalLink />Source
            </Button>
          )}
          {c.download_url && (
            <Button variant='outline' size='sm' render={<a href={c.download_url} download={c.name} />}>
              <Icons.download />Download
            </Button>
          )}
        </div>
      </div>
      <div className='border-t'><Preview c={c} /></div>
    </li>
  );
}

/** The record's documents, under its fields in the details card; nothing when it has none. */
export function RecordDocuments({ area, base, recordKey }: { area: RecordAreaSpec; base: 'app' | 'admin'; recordKey: string }) {
  const [cards, setCards] = useState<FileCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `${recordsApi(base)}/${area.name}/${encodeURIComponent(recordKey)}/files`;
  const wanted = hasDocuments(area);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    setCards(null); setError(null);
    fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as { files?: FileCard[]; error?: string };
        if (!live) return;
        if (!r.ok) setError(body.error ?? 'The documents could not be loaded.');
        else setCards(body.files ?? []);
      })
      .catch(() => live && setError('The documents could not be loaded.'));
    return () => { live = false; };
  }, [url, wanted]);
  if (!wanted) return null;
  if (error) return <p className='text-muted-foreground text-sm'>{error}</p>;
  if (!cards) return <p className='text-muted-foreground text-sm' aria-busy='true'>Loading documents…</p>;
  if (!cards.length) return null;
  return (
    <section className='flex flex-col gap-2' aria-label='Documents'>
      <h2 className='text-sm font-medium'>Documents <span className='text-muted-foreground font-normal'>· {cards.length}</span></h2>
      <ul className='flex flex-col gap-3'>{cards.map((c) => <DocumentCard key={c.id} c={c} />)}</ul>
    </section>
  );
}

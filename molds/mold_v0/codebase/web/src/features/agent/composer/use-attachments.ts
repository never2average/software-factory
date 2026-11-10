'use client';
// The files of one message being written (mold_v0-290): each sent to /api/agent/files as it is added (several at once, with
// progress), kept as a draft of this person until the message carries it, removed on the server when its chip is removed.
import { useCallback, useEffect, useRef, useState } from 'react';

export interface FilesOffer { available: boolean; why: string | null; max_per_message: number; max_file_bytes: number }
export interface AttachmentItem { key: string; name: string; size: number; status: 'uploading' | 'ready' | 'error'; progress: number; id?: string; error?: string }

/** A size for people: 340 KB, 2.4 MB. */
export const sizeWords = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);
const PROGRAM = /\.(exe|dll|so|dylib|msi|dmg|pkg|deb|rpm|apk|bat|cmd|com|scr|jar|app)$/i;
/** What the limits are, in the words the composer shows. */
export const limitWords = (o: FilesOffer) => `Up to ${o.max_per_message} files with a message, ${Math.round(o.max_file_bytes / 1048576)} MB each. Documents, images, data, text and code; no programs.`;
const QUEUE = 3;

export function useAttachments(session: string | null, offer: FilesOffer | null) {
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const xhrs = useRef(new Map<string, XMLHttpRequest>());
  const queue = useRef<{ key: string; file: File }[]>([]);
  const running = useRef(0);
  const countRef = useRef(0);
  countRef.current = items.length;
  const patch = useCallback((key: string, p: Partial<AttachmentItem>) => setItems((x) => x.map((i) => (i.key === key ? { ...i, ...p } : i))), []);

  const pump = useCallback(() => {
    while (running.current < QUEUE && queue.current.length) {
      const { key, file } = queue.current.shift()!;
      running.current += 1;
      const xhr = new XMLHttpRequest();
      xhrs.current.set(key, xhr);
      xhr.open('POST', `/api/agent/files${session ? `?session=${encodeURIComponent(session)}` : ''}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.setRequestHeader('x-pack-request', '1');
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
      xhr.setRequestHeader('x-file-type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) patch(key, { progress: Math.round((e.loaded / e.total) * 100) }); };
      const done = (p: Partial<AttachmentItem>) => { running.current -= 1; xhrs.current.delete(key); patch(key, p); pump(); };
      xhr.onerror = () => done({ status: 'error', error: 'The upload failed: check your connection and try again.' });
      xhr.onabort = () => { running.current -= 1; xhrs.current.delete(key); pump(); };
      xhr.onload = () => {
        let body: { file?: { id: string }; error?: string } = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && body.file) done({ status: 'ready', progress: 100, id: body.file.id });
        else done({ status: 'error', error: body.error ?? 'The upload failed: try again.' });
      };
      xhr.send(file);
    }
  }, [patch, session]);

  /** Add files (button, drop or paste). Each past a limit becomes a chip that says why, never a silent drop. */
  const add = useCallback((files: readonly File[]) => {
    if (!offer?.available) return;
    const added: AttachmentItem[] = [];
    let room = offer.max_per_message - countRef.current;
    for (const file of files) {
      const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`;
      const base = { key, name: file.name, size: file.size, progress: 0 };
      const why = room <= 0 ? `At most ${offer.max_per_message} files with a message.` : !file.size ? 'This file is empty.'
        : file.size > offer.max_file_bytes ? `Too large: a file may be at most ${Math.round(offer.max_file_bytes / 1048576)} MB.` : PROGRAM.test(file.name) ? 'Programs cannot be attached.' : null;
      if (why) { added.push({ ...base, status: 'error', error: why }); continue; }
      room -= 1;
      added.push({ ...base, status: 'uploading' });
      queue.current.push({ key, file });
    }
    setItems((x) => [...x, ...added]);
    pump();
  }, [offer, pump]);

  const remove = useCallback((key: string) => {
    queue.current = queue.current.filter((q) => q.key !== key);
    xhrs.current.get(key)?.abort();
    setItems((x) => {
      const item = x.find((i) => i.key === key);
      if (item?.id) void fetch(`/api/agent/files/${encodeURIComponent(item.id)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-pack-request': '1' } }).catch(() => {});
      return x.filter((i) => i.key !== key);
    });
  }, []);

  /** After a send: the chips go, the drafts stay on the server (the message took them). */
  const clear = useCallback(() => { queue.current = []; setItems([]); }, []);
  useEffect(() => { const live = xhrs.current; return () => { queue.current = []; live.forEach((x) => x.abort()); }; }, []);

  return { items, add, remove, clear, uploading: items.some((i) => i.status === 'uploading'), ready: items.filter((i) => i.status === 'ready') };
}

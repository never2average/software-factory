'use client';
// The message box of the workspace agent (mold_v0-290): one rounded card, an auto-growing text box on top and a toolbar
// beneath, used by a session's chat bar and by Start a session. Behaviour ported from the reference product's composer:
// Enter sends and Shift+Enter is a new line; attach files by button, drop or paste; choose repositories of the workspace's
// own GitHub connection; dictate with the browser's speech service; a round send button, filled when there is something to
// send. Nothing it does ever sends a message on its own.
import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { settingsTabUrl } from '@/config/settings';
import { limitWords, sizeWords, useAttachments, type AttachmentItem, type FilesOffer } from './use-attachments';
import { useAutosizeTextarea } from './use-autosize-textarea';
import { useVoiceInput } from './use-voice-input';
import { composeVoiceInput, spokenSince } from './voice-transcript';

export interface RepositoriesOffer { state: 'ready' | 'no_app' | 'not_connected' | 'suspended' | 'no_repositories'; account: string | null; repositories: string[]; granted: string[]; max_per_message: number; refused: string | null; can_connect: boolean }
export interface ComposerOffer { files: FilesOffer; repositories: RepositoriesOffer }
export interface ComposerSend { message: string; files: string[]; repositories: string[] }

const MAX_HEIGHT = 200;
const round = 'size-8 rounded-full max-sm:size-11';

async function readOffer(session: string | null): Promise<ComposerOffer | null> {
  const res = await fetch(`/api/agent/composer${session ? `?session=${encodeURIComponent(session)}` : ''}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  return ((await res.json()) as { offer: ComposerOffer }).offer;
}

function Hint({ text, children }: { text: string; children: ReactNode }) {
  return <Tooltip><TooltipTrigger render={<span className='inline-flex' />}>{children}</TooltipTrigger><TooltipContent>{text}</TooltipContent></Tooltip>;
}

function FileChip({ item, onRemove }: { item: AttachmentItem; onRemove: () => void }) {
  return (
    <div className={cn('bg-background relative flex max-w-[16rem] min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border py-1 pr-1 pl-2 text-xs', item.status === 'error' && 'border-destructive/60')} data-composer-file={item.status} data-outline='group' title={item.error ?? item.name}>
      {item.status === 'uploading' ? <Icons.spinner className='size-3.5 shrink-0 motion-safe:animate-spin' aria-hidden /> : item.status === 'error' ? <Icons.alertCircle className='text-destructive size-3.5 shrink-0' aria-hidden /> : <Icons.paperclip className='text-muted-foreground size-3.5 shrink-0' aria-hidden />}
      <span className='min-w-0 flex-1'>
        <span className='block truncate font-medium'>{item.name}</span>
        <span className={cn('block truncate text-[11px]', item.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{item.error ?? (item.status === 'uploading' ? `${item.progress}% of ${sizeWords(item.size)}` : sizeWords(item.size))}</span>
      </span>
      <button type='button' aria-label={`Remove ${item.name}`} onClick={onRemove} className='text-muted-foreground hover:text-foreground hover:bg-muted max-sm:size-11 flex size-6 shrink-0 items-center justify-center rounded-md'><Icons.close className='size-3.5' aria-hidden /></button>
      {item.status === 'uploading' && <Progress value={item.progress} className='absolute inset-x-0 bottom-0 h-0.5' aria-label={`Uploading ${item.name}`} />}
    </div>
  );
}

/** The picker's label: Repositories, the one chosen, or the first and how many more (the operator's own chat UI's). */
const repoLabel = (chosen: string[]) => (!chosen.length ? 'Repositories' : chosen.length === 1 ? chosen[0]!.split('/').pop()! : `${chosen[0]!.split('/').pop()} +${chosen.length - 1}`);

function RepoPicker({ offer, chosen, onChange, disabled }: { offer: RepositoriesOffer | null; chosen: string[]; onChange: (next: string[]) => void; disabled: boolean }) {
  const [q, setQ] = useState('');
  const listId = useId();
  const connect = settingsTabUrl('credentials') ?? '/app/settings';
  const words = offer?.refused ?? (offer?.state === 'no_app' ? "The platform's GitHub App is not set up yet, so repositories cannot be connected here. Platform staff set it up in Admin, Key vault."
    : offer?.state === 'suspended' ? `This workspace's GitHub connection (${offer.account}) is suspended on GitHub. An owner of the GitHub account can turn it back on.`
      : offer?.state === 'no_repositories' ? `The GitHub connection (${offer.account}) has no repositories it may read yet. Give it some on GitHub, then come back.`
        : offer?.state === 'not_connected' ? 'This workspace has not connected GitHub yet. Connecting it lets you choose repositories here, read only, for one session at a time.' : null);
  const list = (offer?.repositories ?? []).filter((r) => r.toLowerCase().includes(q.trim().toLowerCase()));
  const granted = new Set(offer?.granted ?? []);
  const toggle = (r: string) => onChange(chosen.includes(r) ? chosen.filter((x) => x !== r) : [...chosen, r]);
  const full = chosen.length >= (offer?.max_per_message ?? 10);
  const row = 'hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs disabled:opacity-50';
  return (
    <Popover>
      <PopoverTrigger render={<Button type='button' variant='outline' size='sm' disabled={disabled} className='group h-8 gap-1.5 rounded-full px-2.5 text-xs max-sm:h-11' data-composer-repositories='' aria-label={chosen.length ? `Repositories: ${chosen.join(', ')}` : 'Repositories'} />}>
        <Icons.folderCode className='size-3.5 opacity-70' aria-hidden /><span className='max-w-[160px] truncate max-[360px]:sr-only'>{repoLabel(chosen)}</span><Icons.chevronDown className='size-3 opacity-50 transition-transform group-data-[popup-open]:rotate-180' aria-hidden />
      </PopoverTrigger>
      <PopoverContent side='top' align='start' className='w-72 max-w-[calc(100vw-2rem)] gap-1 p-1' data-composer-repository-menu=''>
        {words ? (
          <div className='flex flex-col gap-2 p-1.5 text-sm' data-composer-repository-empty={offer?.state ?? 'none'}>
            <p className='text-xs'>{words}</p>
            {!offer?.refused && offer?.state === 'not_connected' && (offer.can_connect
              ? <Link href={connect} className='hover:border-primary/40 flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors' data-composer-connect=''>
                <span className='border-primary/40 bg-primary/10 text-primary grid size-9 shrink-0 place-items-center rounded-lg border'><Icons.github className='size-4' aria-hidden /></span>
                <span className='flex min-w-0 flex-1 flex-col gap-0.5'><span className='text-[13px] font-medium'>GitHub</span><span className='text-muted-foreground text-xs leading-snug'>Repositories the agent can read.</span></span>
                <span className='text-primary flex shrink-0 items-center gap-1 text-xs'>Connect GitHub<Icons.arrowRight className='size-3' aria-hidden /></span>
              </Link>
              : <p className='text-muted-foreground text-xs'>An owner of this workspace connects it, in Settings under Credentials.</p>)}
          </div>
        ) : !offer ? <p className='text-muted-foreground p-1.5 text-xs'>Reading the workspace&apos;s repositories…</p> : (
          <div className='flex flex-col gap-0.5'>
            <div className='relative px-1 pt-1 pb-1.5'>
              <Icons.search className='text-muted-foreground/60 pointer-events-none absolute top-[13px] left-3 size-3' aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search repositories…' aria-label='Search repositories' aria-controls={listId} className='h-7 pl-7 text-xs' />
            </div>
            <button type='button' role='checkbox' aria-checked={!chosen.length} className={row} onClick={() => onChange([])}><Icons.check className={cn('text-primary size-3.5 shrink-0', chosen.length ? 'opacity-0' : 'opacity-100')} aria-hidden /><span className='text-muted-foreground'>No repository selected</span></button>
            <div id={listId} className='flex max-h-60 flex-col overflow-y-auto' data-composer-repository-list=''>
              {list.length === 0 && <p className='text-muted-foreground p-2 text-xs'>No repository matches that.</p>}
              {list.map((r) => {
                const has = granted.has(r), on = has || chosen.includes(r);
                return (
                  <button key={r} type='button' role='checkbox' aria-checked={on} disabled={has || (!on && full)} className={row} onClick={() => toggle(r)}>
                    <Icons.check className={cn('text-primary size-3.5 shrink-0', on ? 'opacity-100' : 'opacity-0')} aria-hidden />
                    <span className='min-w-0 flex-1 truncate font-mono'>{r}</span>
                    {has && <span className='text-muted-foreground shrink-0'>Already readable</span>}
                  </button>
                );
              })}
            </div>
            <p className='text-muted-foreground px-2 py-1 text-xs'>A read-only copy for this session. The agent can never change a repository.</p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function AgentComposer({ id, label, value, onChange, placeholder, sendLabel, disabledReason, busy, session, autoFocus, onSend, above }: {
  id: string; label: string; value: string; onChange: (v: string) => void; placeholder: string; sendLabel: string;
  /** Someone who may not send: the box stays visible and disabled, this as its placeholder. */
  disabledReason: string | null;
  busy: boolean; session: string | null; autoFocus?: boolean;
  /** Sends the message; true when it was taken (the composer then empties). */
  onSend: (c: ComposerSend) => Promise<boolean>;
  above?: ReactNode;
}) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [offer, setOffer] = useState<ComposerOffer | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const disabled = !!disabledReason;
  const refresh = useCallback(() => { if (!disabled) void readOffer(session).then(setOffer, () => setOffer(null)); }, [disabled, session]);
  useEffect(refresh, [refresh]);
  const files = useAttachments(session, offer?.files ?? null);
  useAutosizeTextarea(box, value, MAX_HEIGHT);

  // Speaking: what was typed before (or while) listening is kept aside, so the words are appended to it, never written over it.
  const baseRef = useRef('');
  const finalRef = useRef('');
  const interimRef = useRef('');
  const fromRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;
  const voice = useVoiceInput({ onTranscript: ({ final, interim }) => {
    finalRef.current = final; interimRef.current = interim;
    onChange(composeVoiceInput(baseRef.current, spokenSince(final, fromRef.current), interim));
  } });
  const settled = () => composeVoiceInput(baseRef.current, spokenSince(finalRef.current, fromRef.current), interimRef.current);
  const stopListening = () => { if (!voice.listening) return value; voice.stop(); const v = settled(); onChange(v); return v; };
  const toggleVoice = () => {
    if (voice.listening) { stopListening(); return; }
    if (voice.state === 'requesting') { voice.stop(); return; }
    baseRef.current = value; finalRef.current = ''; interimRef.current = ''; fromRef.current = 0;
    voice.start();
    box.current?.focus();
  };

  const ready = files.ready;
  const hasSomething = !!value.trim() || ready.length > 0 || repos.length > 0;
  const canSend = !disabled && !busy && !files.uploading && hasSomething;

  const send = async () => {
    if (disabled || busy || files.uploading) return;
    const typed = stopListening();
    if (!typed.trim() && !ready.length && !repos.length) return;
    const message = typed.trim() ? typed : ready.length ? `Use the attached ${ready.length === 1 ? 'file' : 'files'}.` : 'Use the chosen repositories.';
    const taken = await onSend({ message, files: ready.map((f) => f.id!), repositories: repos });
    if (taken) { onChange(''); files.clear(); setRepos([]); refresh(); }
  };

  const takeFiles = (list: File[]) => { if (list.length && !disabled && offer?.files.available) files.add(list); };
  const onDrop = (e: DragEvent) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragging(false); takeFiles([...e.dataTransfer.files]); };
  const onDragOver = (e: DragEvent) => { if (e.dataTransfer.types.includes('Files') && offer?.files.available && !disabled) { e.preventDefault(); setDragging(true); } };
  const onPaste = (e: ClipboardEvent) => { const list = [...e.clipboardData.files]; if (list.length) { e.preventDefault(); takeFiles(list); } };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } };
  // Dictation ends when the focus leaves the composer (a click on its own buttons stays inside).
  const onBlur = (e: FocusEvent<HTMLFormElement>) => { if (voice.listening && !e.currentTarget.contains(e.relatedTarget as Node | null)) stopListening(); };

  const filesOffer = offer?.files;
  const attachHint = filesOffer ? limitWords(filesOffer) : 'Attach files';
  const voiceWords = voice.error ?? (voice.listening ? 'Listening. Your words appear as you speak; nothing is sent until you press send.' : voice.state === 'requesting' ? 'Waiting for the microphone.' : null);
  const voiceTip = voice.state === 'denied' ? 'Microphone access is blocked: allow it from the address bar.'
    : voice.listening ? 'Stop listening' : "Speak your message. Your browser's speech service does the transcription.";

  return (
    <TooltipProvider>
      <form className='flex flex-col gap-1.5' onSubmit={(e) => { e.preventDefault(); void send(); }} onBlur={onBlur} aria-label={label} data-agent-composer=''>
        <label htmlFor={id} className='sr-only'>{label}</label>
        {above}
        <div className={cn('bg-background focus-within:ring-ring/40 relative flex flex-col rounded-2xl border shadow-sm focus-within:ring-2', dragging && 'ring-ring ring-2')} onDrop={onDrop} onDragOver={onDragOver} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }} data-composer-card='' data-slot='input-group'>
          {(files.items.length > 0 || repos.length > 0) && (
            <div className='flex flex-wrap gap-1.5 px-2 pt-2' data-composer-chips=''>
              {files.items.map((item) => <FileChip key={item.key} item={item} onRemove={() => files.remove(item.key)} />)}
              {repos.map((r) => (
                <div key={r} className='bg-background flex max-w-[16rem] min-w-0 items-center gap-1.5 rounded-lg border py-1 pr-1 pl-2 text-xs' data-composer-repository={r} data-outline='group'>
                  <Icons.github className='text-muted-foreground size-3.5 shrink-0' aria-hidden />
                  <span className='min-w-0 flex-1 truncate font-mono'>{r}</span>
                  <button type='button' aria-label={`Remove ${r}`} onClick={() => setRepos((x) => x.filter((y) => y !== r))} className='text-muted-foreground hover:text-foreground hover:bg-muted max-sm:size-11 flex size-6 shrink-0 items-center justify-center rounded-md'><Icons.close className='size-3.5' aria-hidden /></button>
                </div>
              ))}
            </div>
          )}
          <textarea ref={box} id={id} rows={1} value={value} disabled={disabled || busy} autoFocus={autoFocus} placeholder={disabledReason ?? placeholder}
            onChange={(e) => { if (voice.listening) { baseRef.current = e.target.value; fromRef.current = finalRef.current.length; interimRef.current = ''; } onChange(e.target.value); }}
            onKeyDown={onKeyDown} onPaste={onPaste}
            className='placeholder:text-muted-foreground block w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60' data-agent-composer-text='' />
          <div className='flex items-center gap-1.5 p-2' data-composer-toolbar=''>
            {(!filesOffer || filesOffer.available) ? (<>
              <Hint text={disabledReason ?? attachHint}><Button type='button' variant='outline' size='icon' className={round} disabled={disabled || !filesOffer} aria-label='Attach files' onClick={() => fileInput.current?.click()} data-composer-attach=''><Icons.paperclip className='size-4' aria-hidden /></Button></Hint>
              <input ref={fileInput} type='file' multiple hidden aria-hidden tabIndex={-1} onChange={(e) => { takeFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </>) : <span className='sr-only' data-composer-no-files=''>{filesOffer.why}</span>}
            <RepoPicker offer={offer?.repositories ?? null} chosen={repos} onChange={setRepos} disabled={disabled} />
            <span className='flex-1' />
            {voice.supported && <Hint text={voiceTip}>
              <Button type='button' variant='outline' size='icon' className={cn(round, voice.listening && 'border-destructive text-destructive', voice.state === 'denied' && 'text-destructive')} disabled={disabled || busy} aria-label={voice.listening ? 'Stop listening' : 'Speak your message'} aria-pressed={voice.listening} onClick={toggleVoice} data-composer-mic={voice.state}>
                <span className='relative inline-flex'>{voice.listening && <span aria-hidden className='bg-destructive/30 absolute inset-0 -m-1 rounded-full motion-safe:animate-ping' />}<Icons.microphone className='relative size-4' aria-hidden /></span>
              </Button>
            </Hint>}
            <Button type='submit' size='icon' className={round} disabled={!canSend} aria-label={sendLabel} data-composer-send=''><Icons.arrowUp className='size-4' aria-hidden /></Button>
          </div>
          {dragging && <div className='bg-background/90 pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-dashed px-4 text-center text-sm' data-composer-drop=''>{filesOffer ? `Drop to attach. ${limitWords(filesOffer)}` : 'Drop to attach'}</div>}
        </div>
        {voiceWords && <p className={cn('px-2 text-xs', voice.error ? 'text-destructive' : 'text-muted-foreground')} role='status' data-composer-voice=''>{voiceWords}</p>}
      </form>
    </TooltipProvider>
  );
}

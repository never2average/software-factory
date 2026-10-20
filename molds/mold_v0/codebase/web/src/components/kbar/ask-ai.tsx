'use client';
// "Ask AI" in the Cmd+K bar: with a question of a few words typed, the first result asks the API for a short answer
// from the docs (src/docs-answers.ts: the customer guide in /app, the internal docs too in /admin). The answer opens in
// a dialog and streams in as the model writes it (POST …/docs/answer/stream, server-sent events): markdown with
// numbered citations that open the cited sections, the sources under it, and what to do when there is no AI summary
// (a limit, or no model answered): the matching sections still show.
import { useKBar, useRegisterActions } from 'kbar';
import Link from 'next/link';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { IconSparkles } from '@tabler/icons-react';
import { useNav } from '@/components/layout/nav-context';
import { Markdown } from '@/components/markdown';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

interface DocsSource { n: number; title: string; heading: string | null; href: string }
interface DocsAnswer {
  answer: string | null; covered: boolean | null; sources: DocsSource[]; model: string | null;
  reason: 'no_match' | 'daily_cap' | 'rate_limited' | 'unavailable' | null;
}

type StreamEvent =
  | { type: 'sources'; sources: DocsSource[] }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; answer: string | null; covered: boolean | null; model: string | null; reason: DocsAnswer['reason'] };
interface AnswerState { sources: DocsSource[]; text: string; done: DocsAnswer | null; error: string | null }

/** Answers already read this visit, by area and question: asking again shows them without a second model call. */
const answered = new Map<string, DocsAnswer>();

/**
 * Ask, and follow the answer as it streams: sources first, then the text as it is written, then the cleaned answer.
 * A server that answers in one piece (JSON) is read the same way.
 */
function useStreamedAnswer(area: string, question: string | null): AnswerState & { streaming: boolean } {
  const [state, setState] = useState<AnswerState>({ sources: [], text: '', done: null, error: null });
  useEffect(() => {
    if (!question) return;
    const key = `${area}\u0000${question}`;
    const cached = answered.get(key);
    if (cached) { setState({ sources: cached.sources, text: cached.answer ?? '', done: cached, error: null }); return; }
    setState({ sources: [], text: '', done: null, error: null });
    const ctl = new AbortController();
    const url = area === 'admin' ? '/api/admin/onboarding/docs/answer/stream' : '/api/app/docs/answer/stream';
    (async () => {
      const res = await fetch(url, { method: 'POST', credentials: 'same-origin', signal: ctl.signal, body: JSON.stringify({ question }),
        headers: { 'Content-Type': 'application/json', accept: 'text/event-stream', ...(area === 'admin' ? { 'X-Octillion-Admin': '1' } : {}) } });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Request failed (${res.status})`);
      }
      if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
        const d = (await res.json()) as DocsAnswer;
        answered.set(key, d);
        return setState({ sources: d.sources, text: d.answer ?? '', done: d, error: null });
      }
      const reader = res.body!.getReader(), decoder = new TextDecoder();
      let buf = '', sources: DocsSource[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, cut).split('\n').find((l) => l.startsWith('data:'));
          buf = buf.slice(cut + 2);
          if (!line) continue;
          const e = JSON.parse(line.slice(5)) as StreamEvent;
          if (e.type === 'sources') { sources = e.sources; setState((s) => ({ ...s, sources })); }
          else if (e.type === 'delta') setState((s) => ({ ...s, text: s.text + e.text }));
          else if (e.type === 'reset') setState((s) => ({ ...s, text: '' }));
          else {
            const d: DocsAnswer = { answer: e.answer, covered: e.covered, sources, model: e.model, reason: e.reason };
            answered.set(key, d);
            setState({ sources, text: e.answer ?? '', done: d, error: null });
          }
        }
      }
    })().catch((e: Error) => { if (e.name !== 'AbortError') setState((s) => ({ ...s, error: e.message })); });
    return () => ctl.abort();
  }, [area, question]);
  return { ...state, streaming: !!question && !state.done && !state.error };
}

/** A question worth asking: two words or more (or one ending in "?"), at least 6 characters. */
const askable = (q: string) => q.trim().length >= 6 && (q.trim().split(/\s+/).length >= 2 || q.trim().endsWith('?'));

const AskCtx = createContext<(question: string) => void>(() => {});
export const useAskAi = () => useContext(AskCtx);

/** Holds the dialog; children (the Cmd+K bar) open it with useAskAi(). */
export function AskAiProvider({ children }: { children: ReactNode }) {
  const [question, setQuestion] = useState<string | null>(null);
  return (
    <AskCtx.Provider value={setQuestion}>
      {children}
      <AskAiDialog question={question} onQuestion={setQuestion} />
    </AskCtx.Provider>
  );
}

/** Registers the "Ask AI: <query>" action for whatever is typed, above every other section. */
export function AskAiAction() {
  const { search } = useKBar((s) => ({ search: s.searchQuery }));
  const ask = useAskAi();
  const q = search.trim();
  const actions = useMemo(() => (askable(q) ? [{
    id: 'ask-ai', name: `Ask AI: ${q}`, keywords: q, priority: 10,
    section: { name: 'Ask AI', priority: 10 }, subtitle: 'A short answer from the docs, with its sources',
    icon: <IconSparkles className='text-primary size-4' />, perform: () => ask(q)
  }] : []), [q, ask]);
  useRegisterActions(actions, [actions]);
  return null;
}

const UNAVAILABLE: Record<Exclude<DocsAnswer['reason'], null | 'no_match'>, string> = {
  unavailable: 'AI summary unavailable. These are the sections that match best.',
  daily_cap: "AI summary unavailable: today's limit for AI answers is reached. These are the sections that match best.",
  rate_limited: 'AI summary unavailable: that was a lot of questions in a minute, try again shortly. These are the sections that match best.'
};

/** The answer's [n] citations as links to the cited sections. */
const linked = (md: string, sources: DocsSource[]) =>
  md.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => {
    const s = sources.find((x) => x.n === Number(n));
    return s ? `[\\[${n}\\]](${s.href})` : m;
  });

function AskAiDialog({ question, onQuestion }: { question: string | null; onQuestion: (q: string | null) => void }) {
  const { area } = useNav();
  const q = question ?? '';
  const { sources, text, done, error, streaming } = useStreamedAnswer(area, question);
  const close = () => onQuestion(null);
  // A link in the answer or the sources opens the page: the dialog goes away.
  const onLinkClick = (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest('a')) close(); };

  return (
    <Dialog open={!!question} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className='max-h-[85svh] gap-0 overflow-y-auto p-0 sm:max-w-xl'>
        <DialogHeader className='border-b p-4 pr-12'>
          <DialogTitle className='flex items-center gap-2'><IconSparkles className='text-primary size-4' /> Ask AI</DialogTitle>
          <form className='mt-2' onSubmit={(e) => {
            e.preventDefault();
            const next = String(new FormData(e.currentTarget).get('question') ?? '').trim();
            if (next.length >= 3) onQuestion(next);
          }}>
            <Input key={q} name='question' defaultValue={q} aria-label='Your question' maxLength={400} placeholder='Ask a question about Octillion' />
          </form>
        </DialogHeader>

        <div className='flex flex-col gap-4 p-4' onClick={onLinkClick}>
          {error ? (
            <p className='text-destructive text-sm'>{error}</p>
          ) : text ? (
            <div className='flex flex-col gap-2' aria-live='polite' aria-busy={streaming}>
              <Markdown className='max-w-none text-sm [&_a]:no-underline [&_p]:my-2 [&_p]:leading-6 [&_ul]:my-2'>{linked(text, sources)}</Markdown>
              {streaming ? <span className='bg-primary inline-block h-4 w-1.5 animate-pulse rounded-sm' aria-hidden />
                : <p className='text-muted-foreground text-xs'>AI summary from the docs — may be imperfect{done?.model ? ` (${done.model})` : ''}.</p>}
            </div>
          ) : streaming ? (
            <div className='text-muted-foreground flex items-center gap-2 py-6 text-sm' role='status'><Spinner className='size-4' /> Reading the docs…</div>
          ) : done?.reason === 'no_match' ? (
            <p className='text-muted-foreground text-sm'>Nothing in the docs matches this question. Try other words, or browse the Docs section of the search bar.</p>
          ) : done ? (
            <p className='text-muted-foreground text-sm'>{UNAVAILABLE[(done.reason ?? 'unavailable') as keyof typeof UNAVAILABLE]}</p>
          ) : null}
          {sources.length > 0 && (
            <div className='flex flex-col gap-2 border-t pt-3'>
              <span className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>Sources</span>
              <ol className='flex flex-col gap-1'>
                {sources.map((s) => (
                  <li key={s.n} className='flex gap-2 text-sm'>
                    <span className='text-muted-foreground w-5 shrink-0 text-right tabular-nums'>{s.n}.</span>
                    <Link href={s.href} className='hover:text-primary min-w-0 transition-colors'>
                      {s.title}{s.heading && <span className='text-muted-foreground'> › {s.heading}</span>}
                    </Link>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

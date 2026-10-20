'use client';
import { useState } from 'react';
import { IconArrowRight, IconChevronDown, IconCircleCheck } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeUrl = (v: string) => (!v ? '' : /^https?:\/\//i.test(v) ? v : `https://${v}`);
const AGENTS = ['Claude Code', 'Codex', 'Cursor', 'GitHub Copilot', 'Gemini CLI', 'Windsurf', 'Cline'];
const TEAM = ['1-10', '11-50', '51-200', '201-1000', '1000+'];
const GOALS = [['baseline', 'See where agents pick us today'], ['competitor', 'Find out why agents pick a competitor'], ['docs', 'Fix our docs and SDKs for agents'],
  ['monitor', 'Track agent preference every release'], ['other', 'Something else']] as const;
const SUBINDUSTRIES = ['Database', 'Auth & identity', 'Payments & billing', 'Email & messaging', 'Queues & background jobs', 'Observability & logging', 'Hosting & deployment',
  'AI & LLM infrastructure', 'Search', 'Storage & CDN', 'Analytics', 'Feature flags & experimentation', 'CMS & content', 'Testing & CI', 'Security', 'Other'];
const HEARD = ['Search', 'X / Twitter', 'LinkedIn', 'Hacker News', 'A friend or colleague', 'An AI assistant', 'Other'];
/** Where the visitor came from: the referrer, utm_* tags and the page they landed on (first page of the visit). */
function visitSource() {
  try {
    const p = new URLSearchParams(window.location.search), out: Record<string, string> = { landing: sessionStorage.getItem('oc:landing') ?? window.location.pathname, referrer: document.referrer };
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) { const v = p.get(k) ?? sessionStorage.getItem(`oc:${k}`); if (v) out[k] = v; }
    return out;
  } catch { return {}; }
}

/** Landing-page access request: POST /api/access-requests (the API server, through the web app's proxy). */
export function AccessForm() {
  const [v, setV] = useState({ email: '', company: '', product_url: '', message: '', name: '', role: '', team_size: '', competitors: '', goal: '', heard_from: '', subindustry: '' });
  const [agents, setAgents] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState('');
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setV({ ...v, [k]: e.target.value });
    if (errs[k]) setErrs({ ...errs, [k]: '' });
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.email.trim()) e.email = 'Enter your email.';
    else if (!EMAIL.test(v.email.trim())) e.email = 'Enter a valid email address.';
    if (!v.company.trim()) e.company = 'Enter your company name.';
    if (v.product_url.trim()) {
      let ok = false;
      try { ok = /\./.test(new URL(normalizeUrl(v.product_url.trim())).hostname); } catch { /* invalid */ }
      if (!ok) e.product_url = 'Enter a valid URL, e.g. https://yourproduct.dev';
    }
    setErrs(e);
    const first = Object.keys(e)[0];
    if (first) document.getElementById(`f-${first}`)?.focus();
    return !first;
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError('');
    if (!validate()) return;
    setStatus('sending');
    try {
      const res = await fetch('/api/access-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: v.email.trim(), company: v.company.trim(), product_url: normalizeUrl(v.product_url.trim()), message: v.message.trim(),
          name: v.name.trim(), role: v.role.trim(), team_size: v.team_size, agents, source: visitSource(),
          competitors: v.competitors.trim(), goal: v.goal, heard_from: v.heard_from, subindustry: v.subindustry })
      });
      const data = await res.json().catch(() => null);
      if (res.ok) return setStatus('done');
      setError((data && typeof data.error === 'string' && data.error) || (res.status === 429 ? 'Too many requests. Please try again in a minute.' : `Something went wrong (HTTP ${res.status}). Please try again.`));
    } catch {
      setError('Network error. Check your connection and try again.');
    }
    setStatus('idle');
  };

  if (status === 'done') {
    return (
      <div className='flex flex-col items-start gap-3 py-6' role='status' tabIndex={-1}>
          <IconCircleCheck className='text-primary size-10' />
          <h3 className='text-lg font-semibold'>You&apos;re on the list</h3>
          <ol className='text-muted-foreground mt-1 space-y-2 text-sm'>
            <li><span className='text-foreground font-medium'>1.</span> We research {v.company.trim() || 'your company'} and the tools agents pick in your category.</li>
            <li><span className='text-foreground font-medium'>2.</span> We email {v.email.trim() || 'you'} to set up your account.</li>
            <li><span className='text-foreground font-medium'>3.</span> You run your first baseline across the coding agents.</li>
          </ol>
      </div>
    );
  }

  const field = (k: 'email' | 'company' | 'product_url' | 'name' | 'role' | 'competitors', label: string, props: React.ComponentProps<'input'>) => (
    <div className='space-y-1.5'>
      <Label htmlFor={`f-${k}`}>{label}</Label>
      <Input id={`f-${k}`} name={k} value={v[k]} onChange={set(k)} aria-invalid={Boolean(errs[k]) || undefined} aria-describedby={`e-${k}`} {...props} />
      <p id={`e-${k}`} className='text-destructive min-h-4 text-xs'>{errs[k]}</p>
    </div>
  );

  return (
        <form onSubmit={submit} noValidate className='space-y-2'>
          {/* What we need first; everything else is optional and folded away. */}
          <div className='grid'>
            {field('email', 'Work email', { type: 'email', autoComplete: 'email', placeholder: 'you@company.com', maxLength: 254, required: true, autoFocus: true })}
            {field('company', 'Company', { autoComplete: 'organization', placeholder: 'Acme', maxLength: 200, required: true })}
          </div>
          {field('product_url', 'Product URL', { type: 'url', inputMode: 'url', autoComplete: 'url', placeholder: 'https://yourproduct.dev', maxLength: 500 })}

          <details className='group border-y py-3 [&_summary::-webkit-details-marker]:hidden' open={more} onToggle={(e) => setMore((e.target as HTMLDetailsElement).open)}>
            <summary className='text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center justify-between text-sm'>
              <span>Add details</span>
              <IconChevronDown className='size-4 transition-transform group-open:rotate-180' />
            </summary>
            <div className='space-y-2 pt-4'>
              <div className='grid'>
                {field('name', 'Your name', { autoComplete: 'name', maxLength: 120 })}
                {field('role', 'Role', { autoComplete: 'organization-title', placeholder: 'Head of DevRel', maxLength: 120 })}
                <div className='space-y-1.5 pb-5'>
                  <Label htmlFor='f-team_size'>Team size</Label>
                  <NativeSelect id='f-team_size' name='team_size' value={v.team_size} onChange={(e) => setV({ ...v, team_size: e.target.value })} className='w-full'>
                    <NativeSelectOption value=''>Choose</NativeSelectOption>
                    {TEAM.map((t) => <NativeSelectOption key={t} value={t}>{t}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
              </div>
              <div className='grid'>
                <div className='space-y-1.5 pb-5'>
                  <Label htmlFor='f-subindustry'>Sub-industry</Label>
                  <NativeSelect id='f-subindustry' name='subindustry' value={v.subindustry} onChange={(e) => setV({ ...v, subindustry: e.target.value })} className='w-full'>
                    <NativeSelectOption value=''>Choose</NativeSelectOption>
                    {SUBINDUSTRIES.map((x) => <NativeSelectOption key={x} value={x}>{x}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
                {field('competitors', 'Main competitors', { maxLength: 500 })}
              </div>
              <div className='grid'>
                <div className='space-y-1.5 pb-5'>
                  <Label htmlFor='f-goal'>What do you want first?</Label>
                  <NativeSelect id='f-goal' name='goal' value={v.goal} onChange={(e) => setV({ ...v, goal: e.target.value })} className='w-full'>
                    <NativeSelectOption value=''>Choose</NativeSelectOption>
                    {GOALS.map(([k, l]) => <NativeSelectOption key={k} value={k}>{l}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
              </div>
              <fieldset className='space-y-2 pb-4'>
                <legend className='text-sm font-medium'>Coding agents you care about</legend>
                <div className='flex flex-wrap gap-1.5 pt-1.5'>
                  {AGENTS.map((a) => {
                    const on = agents.includes(a);
                    return (
                      <button key={a} type='button' aria-pressed={on} onClick={() => setAgents(on ? agents.filter((x) => x !== a) : [...agents, a])}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${on ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>{a}</button>
                    );
                  })}
                </div>
              </fieldset>
              <div className='space-y-1.5 pb-5'>
                <Label htmlFor='f-heard'>Where did you hear about us?</Label>
                <NativeSelect id='f-heard' name='heard_from' value={v.heard_from} onChange={(e) => setV({ ...v, heard_from: e.target.value })} className='w-full'>
                  <NativeSelectOption value=''>Choose</NativeSelectOption>
                  {HEARD.map((h) => <NativeSelectOption key={h} value={h}>{h}</NativeSelectOption>)}
                </NativeSelect>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='f-message'>Anything else we should know?</Label>
                <Textarea id='f-message' name='message' rows={3} maxLength={4000} value={v.message} onChange={set('message')}
                  />
              </div>
            </div>
          </details>

          {error && <p className='text-destructive text-sm' role='alert'>{error}</p>}
          <div className='pt-3'>
            <Button type='submit' size='lg' disabled={status === 'sending'} aria-busy={status === 'sending'}>
              {status === 'sending' ? 'Sending…' : <>Get your APO baseline <IconArrowRight /></>}
            </Button>
          </div>
        </form>
  );
}

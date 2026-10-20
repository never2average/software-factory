'use client';
// /admin/connect: connect an AI client (Claude Code, Cursor, Claude Desktop) to the admin MCP server (src/admin-mcp.ts,
// /admin/mcp). Clients sign in with Clerk like the customer connector; only platform admins get in, and each tool
// needs the role its panel button needs. The URL, skills and tools come from GET /mcp, so they match the server.
import { useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { AgentLogo } from '@/features/site/agent-logos';
import { useAdmin } from './lib';
import { useAdminRole, ROLE_LABEL, type AdminRole } from './role';
import { DataList, ErrorBox, LoadingCards, Section, copyText } from './ui';

interface Tool { name: string; title: string; needs: AdminRole; needs_label: string; changes: boolean; destructive: boolean }
/** A skill: a playbook shipped as an MCP prompt, a slash command in the client (src/admin-mcp.ts ADMIN_SKILLS). */
interface Skill { name: string; title: string; description: string; args: string[] }
const ORDER: AdminRole[] = ['viewer', 'support', 'operator', 'owner'];

/** Each client's way in: one thing to paste. */
function clients(url: string) {
  return [
    { id: 'claude-code', logo: 'claude-code', label: 'Claude Code', steps: 'Run this, then /mcp in Claude Code to sign in.', text: `claude mcp add --transport http octillion-admin ${url}` },
    { id: 'cursor', logo: 'cursor', label: 'Cursor', steps: 'Add this to ~/.cursor/mcp.json. Cursor asks you to sign in when it connects.',
      text: JSON.stringify({ mcpServers: { 'octillion-admin': { url } } }, null, 2) },
    { id: 'claude-desktop', logo: 'claude-code', label: 'Claude Desktop', steps: 'Settings › Connectors › Add custom connector, and paste this URL.', text: url }
  ];
}

export function AdminConnect() {
  const { data, error, isLoading } = useAdmin<{ url: string; tools: Tool[]; skills?: Skill[] }>('/mcp');
  const { role, label } = useAdminRole();
  const [pick, setPick] = useState('claude-code');
  const list = clients(data?.url ?? '');
  const c = list.find((x) => x.id === pick) ?? list[0];
  const mine = (t: Tool) => role == null || ORDER.indexOf(role) >= ORDER.indexOf(t.needs);
  return (
    <PageContainer>
      <ErrorBox error={error} />
      {isLoading || !data ? <LoadingCards count={2} /> : (
        <div className='flex max-w-3xl flex-col gap-8'>
          <Section title='Connect' action={
            <div className='flex gap-1' role='tablist' aria-label='Your AI client'>
              {list.map((x) => (
                <Button key={x.id} size='xs' role='tab' aria-selected={x.id === c.id} variant={x.id === c.id ? 'secondary' : 'ghost'} onClick={() => setPick(x.id)}><AgentLogo id={x.logo} size={12} aria-hidden='true' />{x.label}</Button>
              ))}
            </div>}>
            <div className='flex flex-col gap-1.5'>
              <Snippet text={c.text} />
              <p className='text-muted-foreground text-xs'>{c.steps}{label ? ` Calls are logged under your name as ${label}.` : ''}</p>
            </div>
          </Section>
          {!!data.skills?.length && (
            <Section title='Skills'>
              <DataList<Skill> rows={data.skills} noun='skills' empty='No skills.' minWidth={520} cols={[
                { label: 'Skill', className: 'w-56', render: (k) => <span className='flex flex-col gap-1'><span className='font-medium'>{k.title}</span><code className='text-muted-foreground font-mono text-xs'>/{k.name}</code></span> },
                { label: 'What it does', render: (k) => <span className='text-sm'>{k.description}{k.args.length ? <span className='text-muted-foreground block text-xs'>Asks for: {k.args.join(', ')}</span> : null}</span> }
              ]} />
            </Section>
          )}
          <details className='text-sm'>
            <summary className='text-muted-foreground hover:text-foreground cursor-pointer select-none'>
              {data.tools.length} tools{role ? `, ${data.tools.filter(mine).length} available to you as ${ROLE_LABEL[role]}` : ''}
            </summary>
            <ul className='mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2'>
              {data.tools.filter(mine).map((t) => (
                <li key={t.name} title={t.title}><code className='font-mono text-xs'>{t.name}</code></li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </PageContainer>
  );
}

function Snippet({ text }: { text: string }) {
  return (
    <div className='relative'>
      <pre className='bg-background overflow-x-auto rounded-md border p-2.5 pr-20 font-mono text-xs whitespace-pre-wrap break-all'>{text}</pre>
      <div className='absolute top-1 right-1'>
        <Button variant='ghost' size='sm' onClick={() => copyText(text)}><Icons.page className='size-3.5' /> Copy</Button>
      </div>
    </div>
  );
}

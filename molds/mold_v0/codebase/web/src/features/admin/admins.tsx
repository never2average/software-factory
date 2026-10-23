'use client';
// /admin/admins: the platform's staff and their roles (src/admin-roles.ts). Roles are Clerk user metadata; admins listed in
// the server environment (APP_PLATFORM_ADMINS) are owners and are changed there. Owners add, change and remove
// admins; everyone else reads. Adding an address nobody has used creates the Clerk user, who is an admin on first sign-in.
import { useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { post, useAdmin, useAdminAction } from './lib';
import { Gate, useAdminRole, type AdminRole } from './role';
import { ErrorBox, FormRow, StatusBadge, When } from './ui';

interface Admin { id: string | null; email: string | null; name: string | null; role: AdminRole; role_label: string; source: 'environment' | 'clerk';
  last_sign_in_at: string | null; added_by: string | null; added_at: string | null; editable: boolean }
interface RoleInfo { id: AdminRole; label: string; help: string }

const NA = <span className='text-muted-foreground'>—</span>;

export function AdminAdmins() {
  const { data, error, isLoading } = useAdmin<{ admins: Admin[]; roles: RoleInfo[]; me: string | null }>('/admins');
  const { can, lock } = useAdminRole();
  const [adding, setAdding] = useState(false);
  const roles = data?.roles ?? [];
  const setRole = useAdminAction((v: { id: string; role: AdminRole }) => post(`/admins/${encodeURIComponent(v.id)}/role`, { role: v.role }), { success: 'Role changed' });
  const remove = useAdminAction((id: string) => adminApi('DELETE', `/admins/${encodeURIComponent(id)}`), { success: 'Admin removed' });
  const edit = can('admins');

  const cols: RecordCol<Admin>[] = [
    { key: 'email', label: 'Admin', className: 'min-w-64', title: true, keep: true, peek: false, type: 'text', value: (a) => a.email, render: (a) => (
      <span className='flex flex-col gap-1.5'><span className='leading-none font-medium'>{a.email ?? a.id}{a.id && a.id === data?.me && <span className='text-muted-foreground font-normal'> (you)</span>}</span>
        {a.name && <span className='text-muted-foreground text-xs leading-none'>{a.name}</span>}</span>
    ) },
    { key: 'role', label: 'Role', className: 'w-40', keep: true, type: 'select', value: (a) => a.role_label, options: roles.map((r) => ({ value: r.label })), render: (a) => {
      const role = edit && a.editable && a.id ? (
        <NativeSelect size='sm' value={a.role} disabled={setRole.isPending} aria-label={`Role for ${a.email}`}
          onClick={(e) => e.stopPropagation()} onChange={(e) => setRole.mutate({ id: a.id!, role: e.target.value as AdminRole })}>
          {roles.map((r) => <NativeSelectOption key={r.id} value={r.id}>{r.label}</NativeSelectOption>)}
        </NativeSelect>
      ) : <span className='leading-none' title={roles.find((r) => r.id === a.role)?.help}>{a.role_label}</span>;
      return a.source === 'environment' ? (
        <span className='flex flex-col gap-1.5'>{role}<span className='text-muted-foreground text-xs leading-none' title='APP_PLATFORM_ADMINS on the server: change it there'>set in env</span></span>
      ) : role;
    } },
    { key: 'source', label: 'Set in', className: 'w-32', hidden: true, type: 'select', value: (a) => (a.source === 'environment' ? 'Environment' : 'Clerk'),
      options: [{ value: 'Clerk' }, { value: 'Environment' }],
      render: (a) => (a.source === 'environment' ? <StatusBadge tone='info' title='APP_PLATFORM_ADMINS on the server: change it there'>environment</StatusBadge> : <span className='text-muted-foreground text-sm'>Clerk</span>) },
    { key: 'last_sign_in_at', label: 'Last sign-in', className: 'w-32', type: 'date', value: (a) => a.last_sign_in_at,
      render: (a) => (a.last_sign_in_at ? <When d={a.last_sign_in_at} className='text-muted-foreground text-xs' /> : <span className='text-muted-foreground text-xs'>never</span>) },
    { key: 'added_at', label: 'Added', className: 'w-36', type: 'date', value: (a) => a.added_at, render: (a) => (a.added_at || a.added_by ? (
      <span className='flex flex-col gap-1.5'>{a.added_at ? <When d={a.added_at} className='text-sm leading-none' /> : NA}
        {a.added_by && <span className='text-muted-foreground truncate text-xs leading-none' title={a.added_by}>by {a.added_by}</span>}</span>
    ) : NA) }
  ];

  const actions = (a: Admin): RowAction[] => (!a.editable || !a.id ? [] : [
    ...roles.filter((r) => r.id !== a.role).map((r) => lock({ label: `Make ${r.label.toLowerCase()}`, icon: <Icons.teams />, onSelect: () => setRole.mutate({ id: a.id!, role: r.id }) }, 'admins')),
    lock({ label: 'Remove admin', icon: <Icons.trash />, destructive: true, separator: true, onSelect: () => remove.mutate(a.id!) }, 'admins')
  ]);

  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView<Admin>
        id='admin-admins' noun='admins' exportName='admins'
        rows={data?.admins ?? []} rowKey={(a) => a.id ?? `env:${a.email}`} cols={cols} actions={actions} loading={isLoading}
        searchText={(a) => `${a.email ?? ''} ${a.name ?? ''} ${a.role_label} ${a.added_by ?? ''}`}
        searchPlaceholder='Search admins by email, name or role'
        primary={<Gate need='admins'><Button onClick={() => setAdding(true)}><Icons.add /> Add admin</Button></Gate>}
        empty='No admins yet.'
        detailTitle={(a) => a.email ?? 'Admin'}
        detail={(a) => (
          <div className='flex flex-col gap-3 text-sm'>
            <p><span className='font-medium'>{a.role_label}.</span> {roles.find((r) => r.id === a.role)?.help}</p>
            {a.source === 'environment' && <p className='text-muted-foreground'>Listed in APP_PLATFORM_ADMINS on the server, so always an owner. Change it there.</p>}
          </div>
        )}
      />
      {adding && <AddAdmin roles={roles} onClose={() => setAdding(false)} />}
    </PageContainer>
  );
}

function AddAdmin({ roles, onClose }: { roles: RoleInfo[]; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AdminRole>('viewer');
  const [err, setErr] = useState('');
  const add = useAdminAction(() => post<{ created: boolean }>('/admins', { email: email.trim(), role }),
    { success: (r) => (r.created ? `${email.trim()} is an admin from their first sign-in` : `${email.trim()} is now an admin`) });
  const submit = (e: React.FormEvent) => { e.preventDefault(); setErr(''); add.mutate(undefined, { onSuccess: onClose, onError: (x) => setErr(x.message) }); };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>Add admin</DialogTitle>
            <DialogDescription>If nobody has signed in with this address yet, they become an admin the first time they sign in with Google.</DialogDescription>
          </DialogHeader>
          <FormRow id='aa-email' label='Email'><Input id='aa-email' type='email' required value={email} onChange={(e) => setEmail(e.target.value)} /></FormRow>
          <FormRow id='aa-role' label='Role' hint={roles.find((r) => r.id === role)?.help}>
            <NativeSelect id='aa-role' value={role} onChange={(e) => setRole(e.target.value as AdminRole)}>
              {roles.map((r) => <NativeSelectOption key={r.id} value={r.id}>{r.label}</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={add.isPending}>Add admin</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

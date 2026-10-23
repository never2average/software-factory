import { Metadata } from 'next';
import { AuthShell } from '@/features/auth/components/auth-shell';
import { BuiltinConsent } from '@/features/auth/components/builtin-consent';
import { CLERK } from '@/lib/auth/provider';

export const metadata: Metadata = {
  title: 'Authentication | Allow an app',
  description: 'Allow an app to use your workspace.'
};

/** The consent screen of the built-in MCP authorization server (mold_v0-013, src/mcp-oauth.ts). Under Clerk, Clerk asks. */
export default function Page() {
  return (
    <AuthShell>
      {CLERK ? <p className='text-sm'>This server signs apps in with Clerk.</p> : <BuiltinConsent />}
    </AuthShell>
  );
}

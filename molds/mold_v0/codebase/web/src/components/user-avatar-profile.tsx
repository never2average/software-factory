import { IdentityAvatar } from '@/components/identity-avatar';

interface UserAvatarProfileProps {
  className?: string;
  showInfo?: boolean;
  user: {
    id?: string;
    imageUrl?: string;
    /** Clerk: false while the picture is Clerk's generated one (mold_v0-275: the console draws its own then). */
    hasImage?: boolean;
    fullName?: string | null;
    emailAddresses: Array<{ emailAddress: string }>;
  } | null;
}

/** `compact`: smaller name and email, for the sidebar footer. */
export function UserAvatarProfile({ className, showInfo = false, compact = false, user }: UserAvatarProfileProps & { compact?: boolean }) {
  const email = user?.emailAddresses[0]?.emailAddress || '';
  return (
    <div className='flex items-center gap-2'>
      <IdentityAvatar className={className} id={user?.id} name={user?.fullName} email={email} imageUrl={user?.imageUrl} hasImage={user?.hasImage} />

      {showInfo && (
        <div className={`grid flex-1 text-left leading-tight ${compact ? 'text-xs' : 'text-sm'}`}>
          <span className='truncate font-semibold'>{user?.fullName || ''}</span>
          <span className={`text-muted-foreground truncate ${compact ? 'text-[0.6875rem]' : 'text-xs'}`}>{email}</span>
        </div>
      )}
    </div>
  );
}

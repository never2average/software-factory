import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

interface UserAvatarProfileProps {
  className?: string;
  showInfo?: boolean;
  user: {
    imageUrl?: string;
    fullName?: string | null;
    emailAddresses: Array<{ emailAddress: string }>;
  } | null;
}

/** `compact`: smaller name and email, for the sidebar footer. */
export function UserAvatarProfile({ className, showInfo = false, compact = false, user }: UserAvatarProfileProps & { compact?: boolean }) {
  return (
    <div className='flex items-center gap-2'>
      <Avatar className={className}>
        <AvatarImage src={user?.imageUrl || ''} alt={user?.fullName || ''} />
        <AvatarFallback className='rounded-lg'>
          {user?.fullName?.slice(0, 2)?.toUpperCase() || 'CN'}
        </AvatarFallback>
      </Avatar>

      {showInfo && (
        <div className={`grid flex-1 text-left leading-tight ${compact ? 'text-xs' : 'text-sm'}`}>
          <span className='truncate font-semibold'>{user?.fullName || ''}</span>
          <span className={`text-muted-foreground truncate ${compact ? 'text-[0.6875rem]' : 'text-xs'}`}>{user?.emailAddresses[0].emailAddress || ''}</span>
        </div>
      )}
    </div>
  );
}

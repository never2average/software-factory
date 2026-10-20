import { redirect } from 'next/navigation';

// "You" became the Users tab.
export default function Page() {
  redirect('/app/context/users');
}

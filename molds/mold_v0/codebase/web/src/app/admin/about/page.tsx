import { AboutPage } from '@/features/about/about-page';

// About (mold_v0-050): the source offer and the data-flow and residency statement, for platform staff.
export const metadata = { title: 'About' };

export default function Page() {
  return <AboutPage endpoint='/api/admin/about' />;
}

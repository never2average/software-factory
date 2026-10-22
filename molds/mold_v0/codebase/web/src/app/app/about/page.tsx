import { AboutPage } from '@/features/about/about-page';

// About (mold_v0-050): the source offer and the data-flow and residency statement, linked from the sidebar's footer.
export const metadata = { title: 'About' };

export default function Page() {
  return <AboutPage endpoint='/api/about' />;
}

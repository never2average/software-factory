import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Team dashboard</h1>
      <p>Welcome back.</p>
      <Link href="/projects">Projects</Link>
    </main>
  );
}

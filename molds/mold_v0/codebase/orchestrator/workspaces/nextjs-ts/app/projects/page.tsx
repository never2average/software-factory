import { listProjects } from "@/lib/projects";

export default function ProjectsPage() {
  const projects = listProjects();
  return (
    <main>
      <h1>Projects</h1>
      <ul>
        {projects.map((p) => (
          <li key={p.id}>
            {p.name} ({p.status})
          </li>
        ))}
      </ul>
    </main>
  );
}

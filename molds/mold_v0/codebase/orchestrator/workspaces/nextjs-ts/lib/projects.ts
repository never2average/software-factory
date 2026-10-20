export interface Project {
  id: number;
  name: string;
  status: "active" | "archived";
}

const projects: Project[] = [
  { id: 1, name: "Website refresh", status: "active" },
  { id: 2, name: "Mobile app", status: "active" },
];

export function listProjects(): Project[] {
  return projects;
}

export function addProject(name: string): Project {
  const p: Project = { id: projects.length + 1, name, status: "active" };
  projects.push(p);
  return p;
}

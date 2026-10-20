import { NextResponse } from "next/server";
import { addProject, listProjects } from "@/lib/projects";

export async function GET() {
  return NextResponse.json(listProjects());
}

export async function POST(req: Request) {
  const body = await req.json();
  return NextResponse.json(addProject(body.name), { status: 201 });
}

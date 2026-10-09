import type { ZodError } from "zod";

export function issueMessage(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}

export function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    message.startsWith("Not found:") ? 404 :
    message.startsWith("Conflict:") ? 409 :
    message.startsWith("Invalid:") ? 400 : 500;
  if (status === 500) console.error("Task workflow service error", error);
  return Response.json({ error: message.replace(/^(Not found|Conflict|Invalid):\s*/, "") }, { status });
}

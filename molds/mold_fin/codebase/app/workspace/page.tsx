"use client";

/**
 * Full-page Workspace (control plane). The Workspace is no longer a section in
 * the Ops Center modal — it opens as its own page from the gear icon in the
 * sidebar footer. Renders the same `WorkspacePanel` (Members / Settings / Usage
 * / Audit), scoped to the signed-in operator's workspaces.
 */

import { useEffect, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { WorkspacePanel } from "@/app/_components/ops/workspace-panel";

/** The signed-in email, decoded from the Google ID token in localStorage. */
function emailFromToken(): string | undefined {
  try {
    const token = localStorage.getItem("fde-google-token");
    const payload = token?.split(".")[1];
    if (!payload) return undefined;
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { email?: unknown };
    return typeof json.email === "string" ? json.email : undefined;
  } catch {
    return undefined;
  }
}

export default function WorkspacePage() {
  const [email, setEmail] = useState<string | undefined>(undefined);
  useEffect(() => setEmail(emailFromToken()), []);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <a
          href="/"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          Back to chat
        </a>
        <span className="ml-1 text-sm font-semibold">Workspace</span>
      </header>
      <div className="min-h-0 flex-1">
        <WorkspacePanel authorEmail={email} />
      </div>
    </div>
  );
}

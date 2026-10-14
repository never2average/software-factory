"use client";

import { useEffect, useState } from "react";
import { ChatShell } from "@/app/_components/chat-shell";

/**
 * The REAL chat shell, for tests/chat-open.spec.ts — dev only (see ../layout.tsx), no auth, no database.
 *
 * Reopening a chat is decided in `openChat` (app/_components/chat-shell.tsx): which cache it mounts, when it paints,
 * what it does with the seam read, and whether a slower, earlier click can land on top of a later one. Those are
 * properties of the shell itself, so this page mounts the shell itself rather than a copy of its logic. The spec seeds
 * this browser's chat list in localStorage before the page loads and answers every request the shell makes (the saved
 * copy, the seam read, the full replay) with its own timing, so a slow seam read or a slow saved copy is a fact of the
 * test rather than of the network.
 *
 * Mounted after the first effect so `bootFromCache` reads the seeded list in the browser, never on the server.
 */
export default function ChatOpenPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return null;
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <ChatShell
        getAuthHeaders={() => ({})}
        email="preview@example.test"
        name="Preview"
        picture={null}
        onSignOut={() => {}}
      />
    </div>
  );
}

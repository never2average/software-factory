/**
 * "YOU ARE NOT A MEMBER OF THIS WORKSPACE" — the one refusal, and how the console learns of it.
 *
 * A request names the workspace it is about (`x-ops-org` / `?org=`; the console sends its tab's workspace on every
 * call). When the caller is not a member of it, or there is no such workspace, the server REFUSES the request instead
 * of serving it from the caller's own workspace (lib/org-context.ts, agent/lib/org-context.ts): HTTP 403 with
 * `code: "workspace_refused"`. Unknown and not-a-member are the same answer.
 *
 * This module is the words and the code both sides use, and the browser's memory of having been refused: every
 * shared fetch helper (ops/lib.ts opsFetch, lib/startup-fetch.ts sharedGet) notes a refusal here, and the page shows
 * a plain message with the person's own workspaces (app/_components/workspace-refused.tsx) instead of an empty or
 * half-loaded console. Nothing here retries: a refusal is noted once and the person chooses where to go.
 *
 * Pure and dependency-free (relative imports only): the web app, the agent and plain-node tests all load it.
 */

export const WORKSPACE_REFUSED_CODE = "workspace_refused";
export const WORKSPACE_REFUSED_MESSAGE = "You are not a member of this workspace.";
/** The lookup itself failed (503): membership could be neither confirmed nor denied. Not a refusal to act on. */
export const WORKSPACE_UNAVAILABLE_CODE = "workspace_unavailable";

/** Is this response body (parsed, or its text) the workspace refusal? */
export function isWorkspaceRefusalBody(status: number, body: unknown): boolean {
  if (status !== 403) return false;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return false;
    }
  }
  return Boolean(body) && typeof body === "object" && (body as { code?: unknown }).code === WORKSPACE_REFUSED_CODE;
}

/* ---- the browser's note of it --------------------------------------------------------------------------------- */

const EVENT = "workspace-refused";

interface RefusalState {
  /** The workspace the tab named when it was refused ("" when the request named none we know of). */
  readonly workspace: string | null;
  /** A chat this page tried to open (its link, a notification) was refused too. */
  readonly chatRefused: boolean;
}

let state: RefusalState = { workspace: null, chatRefused: false };
const listeners = new Set<() => void>();

function publish(next: RefusalState): void {
  if (next.workspace === state.workspace && next.chatRefused === state.chatRefused) return;
  state = next;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a listener must not stop the others */
    }
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (a test, the server) */
  }
}

/** A request naming `workspace` was refused. Kept for the life of the page: the first refusal is the one shown. */
export function noteWorkspaceRefused(workspace: string | null | undefined): void {
  if (state.workspace !== null) return;
  publish({ ...state, workspace: workspace ?? "" });
}

/** A chat the page was asked to open (a link, a notification) could not be opened. */
export function noteChatRefused(): void {
  publish({ ...state, chatRefused: true });
}

export function workspaceRefusalState(): RefusalState {
  return state;
}

/** Call `fn` whenever the note changes; returns the unsubscribe. */
export function onWorkspaceRefusal(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Should the page show the refusal instead of the console?
 *
 * Yes when the tab's workspace was refused — unless the page is a GUEST's: someone following the link of one chat
 * shared with them names that chat's workspace on every request without being a member of it, and reads that chat
 * and nothing else (lib/chat-threads.ts accessFor, lib/session-gate.ts guestSessionDecision). For them the lists are
 * refused and the chat opens. If the linked chat is refused as well, they are not its guest either, and the refusal
 * is shown.
 */
export function showWorkspaceRefusal(s: RefusalState, guestLinkWorkspace: string | null): boolean {
  if (s.workspace === null) return false;
  if (guestLinkWorkspace && guestLinkWorkspace === s.workspace && !s.chatRefused) return false;
  return true;
}

/** Forget the note: the person signed out (the next one to sign in on this page starts clean), or a test. */
export function clearWorkspaceRefusal(): void {
  publish({ workspace: null, chatRefused: false });
}

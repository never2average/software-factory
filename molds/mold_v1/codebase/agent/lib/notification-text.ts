/**
 * WHAT A NOTIFICATION SAYS — shared by the server's push (agent/lib/push-notify.ts) and a hidden tab's own notifier
 * (app/_components/desktop-notify.ts), so the two can never word or tag one event differently. Pure: no network,
 * no node built-ins, safe in the client bundle.
 *
 * Only the chat title and a short preview — never a tool's input or anything read from the data room. With
 * `preview` off, NOTHING from the chat at all: a chat's title is usually its first message, so the title becomes a
 * generic line in the product's own name ("New reply in <product>") and the service worker shows a fixed body for
 * the kind of event.
 */
import { displayText, displayTitle } from "../../lib/chat-attachments.ts";
import { speak } from "./agent-vocabulary.ts";
import { PRODUCT_NAME } from "./deployment-profile.generated.ts";

export type NotifyKind = "reply" | "input" | "failed";

export interface NotifyEvent {
  readonly kind: NotifyKind;
  readonly sessionId: string;
  readonly turnId?: string;
  /** The answer (reply) or the question's prompt (input). */
  readonly text?: string;
  /** input: an approval of this tool (its raw name), rather than a question. */
  readonly tool?: string;
}

/** How much of a reply or question a preview carries. */
export const PREVIEW_CHARS = 120;

export interface NotificationPayload {
  readonly v: 1;
  readonly kind: NotifyKind;
  readonly title: string;
  /** Absent when the person asked for titles only. */
  readonly body?: string;
  readonly tag: string;
  readonly url: string;
  readonly sessionId: string;
}

/** One event, one tag — the page's notifier computes the same (app/_components/desktop-notify.ts). */
export function notificationTag(ev: Pick<NotifyEvent, "sessionId" | "turnId" | "kind">): string {
  return `${ev.sessionId}:${ev.turnId ?? "-"}:${ev.kind}`;
}

/** Text as a notification line: no directives or attachment blocks, no markdown marks, one line, clipped. */
export function previewLine(text: string | undefined, max = PREVIEW_CHARS): string {
  const plain = displayText(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** A tool's name as a person reads it: `update_customer` → "Update customer" (in the profile's words). */
export function plainToolName(name: string): string {
  const bare = name.replace(/^eve:subagent:/, "").replace(/[_-]+/g, " ").trim();
  const sentence = bare ? bare[0].toUpperCase() + bare.slice(1) : "a step";
  return speak(sentence);
}

/** The title of a notification with previews off: the product's name, nothing from the chat. */
export function genericTitle(kind: NotifyKind, product: string = PRODUCT_NAME): string {
  const name = product.trim() || "your workspace";
  return kind === "reply" ? `New reply in ${name}` : kind === "input" ? `${name} needs your answer` : `A reply failed in ${name}`;
}

/** The notification a person gets for an event. `preview` false: a generic title in the product's name, no body. */
export function notificationFor(ev: NotifyEvent, title: string | null, preview: boolean): NotificationPayload {
  const base = {
    v: 1 as const,
    kind: ev.kind,
    title: preview ? displayTitle(title, "Your chat") : genericTitle(ev.kind),
    tag: notificationTag(ev),
    url: `/?chatSession=${encodeURIComponent(ev.sessionId)}`,
    sessionId: ev.sessionId,
  };
  if (!preview) return base;
  let body: string;
  if (ev.kind === "reply") body = previewLine(ev.text) || "Your reply is ready.";
  else if (ev.kind === "input") {
    body = ev.tool
      ? `Needs your approval: ${plainToolName(ev.tool)}`
      : previewLine(ev.text)
        ? `Needs your answer: ${previewLine(ev.text, PREVIEW_CHARS - 19)}`
        : "Needs your answer.";
  } else body = "This reply failed. Open the chat to try again.";
  return { ...base, body };
}

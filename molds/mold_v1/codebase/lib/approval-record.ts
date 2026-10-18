/**
 * AN ANSWERED APPROVAL IS A ONE-LINE RECORD (mold_v1-289): who answered, what it was for, the outcome and the time.
 *
 * An approval, once allowed or denied, used to stay in the conversation at full size: a specialist's as a "Your
 * answer: Approve" bubble in the main thread, one asked on a delegation card as a yellow "Responded: Approve" box
 * under it for the rest of the chat. The chat now folds every answered approval — the main agent's and a specialist's
 * — to one line that opens on click (app/_components/agent-message.tsx `AnsweredApprovalRow`). A typed answer to a
 * QUESTION is the person's own words and stays as it is.
 *
 * Pure: reads a part and the event stream.
 */

/** Only what is read of a tool part. */
export interface ApprovalPart {
  readonly type?: string;
  readonly toolName?: string;
  readonly state?: string;
  readonly toolMetadata?: {
    readonly eve?: {
      readonly inputRequest?: unknown;
      readonly inputResponse?: unknown;
    };
  };
}

interface RequestShape {
  readonly requestId?: string;
  readonly display?: string;
  readonly prompt?: string;
  readonly options?: readonly { readonly id?: string; readonly label?: string }[];
  readonly action?: { readonly callId?: string; readonly toolName?: string } | null;
}

const requestOf = (part: ApprovalPart): RequestShape | undefined =>
  part.toolMetadata?.eve?.inputRequest as RequestShape | undefined;

/**
 * Is this request an APPROVAL (allow / deny a tool call), not a question? eve marks approvals `display:
 * "confirmation"` with the options `approve` / `deny`; a part in an `approval-*` state is one too.
 */
export function isApproval(part: ApprovalPart): boolean {
  if (part.type !== "dynamic-tool" || part.toolName === "ask_question") return false;
  if (part.state === "approval-requested" || part.state === "approval-responded" || part.state === "output-denied") return true;
  const req = requestOf(part);
  if (!req) return false;
  if (req.display === "confirmation") return true;
  const ids = (req.options ?? []).map((o) => o.id);
  return ids.length === 2 && ids.includes("approve") && ids.includes("deny");
}

export type ApprovalOutcome = "allowed" | "denied" | "answered";

/** How an answered approval came out, or null while it is still open. */
export function approvalOutcome(part: ApprovalPart): ApprovalOutcome | null {
  const response = part.toolMetadata?.eve?.inputResponse as { optionId?: string; text?: string } | undefined;
  if (part.state === "output-denied") return "denied";
  if (response?.optionId === "deny") return "denied";
  if (response?.optionId === "approve") return "allowed";
  if (response) {
    const label = requestOf(part)?.options?.find((o) => o.id === response.optionId)?.label ?? response.text ?? "";
    if (/^(deny|denied|reject|no)\b/i.test(label)) return "denied";
    if (/^(approve|approved|allow|yes)\b/i.test(label)) return "allowed";
    return "answered";
  }
  // Ran without a response recorded on this part (answered through a specialist's proxy): it was allowed.
  if (part.state === "output-available" || part.state === "output-error") return requestOf(part) ? "allowed" : null;
  return null;
}

/** The request's id, when it has one. */
export function approvalRequestId(part: ApprovalPart): string | undefined {
  return requestOf(part)?.requestId;
}

/**
 * WHEN each approval was settled, by request id, from the stream: the time (`meta.at`) of the `action.result` for the
 * call it approved, or of the `client.input.responded` marker that recorded the answer when that carries one.
 */
export function approvalTimes(events: readonly unknown[]): ReadonlyMap<string, number> {
  const callOf = new Map<string, string>();
  const at = new Map<string, number>();
  for (const raw of events) {
    const e = raw as {
      type?: string;
      meta?: { at?: string };
      data?: {
        requests?: readonly RequestShape[];
        responses?: readonly { requestId?: string }[];
        result?: { callId?: string };
        at?: unknown;
      };
    };
    const t = Date.parse(e?.meta?.at ?? (typeof e?.data?.at === "string" ? e.data.at : ""));
    if (e?.type === "input.requested") {
      for (const r of e.data?.requests ?? []) {
        if (r?.requestId && r.action?.callId) callOf.set(r.action.callId, r.requestId);
      }
    } else if (e?.type === "action.result" && Number.isFinite(t)) {
      const rid = e.data?.result?.callId ? callOf.get(e.data.result.callId) : undefined;
      if (rid && !at.has(rid)) at.set(rid, t);
    } else if ((e?.type === "client.input.responded" || e?.type === "input.responded") && Number.isFinite(t)) {
      for (const r of e.data?.responses ?? []) if (r?.requestId && !at.has(r.requestId)) at.set(r.requestId, t);
    }
  }
  return at;
}

/** "14:05" — the time of day an approval was settled, in the person's locale. */
export function approvalClock(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return null;
  }
}

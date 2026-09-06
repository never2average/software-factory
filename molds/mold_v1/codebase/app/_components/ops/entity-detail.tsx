"use client";

/**
 * Two detail-panel sections shared by every workspace entity (task / cycle /
 * deployment / implementation): a read-only ActivityFeed and a CommentThread
 * with @mention support. Both key off (entityType, entityId).
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { CustomerMark } from "../customer-mark";
import { errMessage, opsFetch, type OpsSection } from "./lib";
import { OpsButton, OpsTextarea } from "./primitives";
import { SURFACE, TYPE } from "./tokens";

export type EntityKind = "task" | "cycle" | "deployment" | "implementation";

function relTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* -------------------------------- activity -------------------------------- */

type ActivityRow = { id: string; actor: string; event: string; at: string };

export function ActivityFeed({ entity, id, refreshKey }: { readonly entity: EntityKind; readonly id: string; readonly refreshKey?: unknown }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    opsFetch<{ items: ActivityRow[] }>(`/api/ops/activity?entity=${entity}&id=${encodeURIComponent(id)}`)
      .then((d) => alive && setRows(d.items))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [entity, id, refreshKey]);

  return (
    <div className="flex flex-col gap-2">
      <span className={cn("font-medium text-muted-foreground/60 uppercase tracking-wide", TYPE.micro)}>Activity</span>
      {rows === null ? (
        <p className={cn("text-muted-foreground/50", TYPE.micro)}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className={cn("text-muted-foreground/50 italic", TYPE.micro)}>No activity yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start gap-2">
              <span className="mt-1 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
              <span className={cn("flex-1", TYPE.micro)}>
                <span className="text-foreground/80">{r.event}</span>
                <span className="text-muted-foreground/60">
                  {" · "}
                  {r.actor.split("@")[0]} · {relTime(r.at)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------- comments -------------------------------- */

type CommentRow = { id: string; author: string; body: string; mentions: string[]; at: string };

/** Renders text with @email tokens highlighted. */
function withMentions(body: string): React.ReactNode {
  const parts = body.split(/(@[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi);
  return parts.map((p, i) =>
    p.startsWith("@") ? (
      <span key={i} className="rounded bg-indigo-500/15 px-0.5 text-indigo-300">
        {p}
      </span>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

export function CommentThread({
  entity,
  id,
  label,
  authorEmail,
}: {
  readonly entity: EntityKind;
  readonly id: string;
  readonly label?: string;
  readonly authorEmail?: string;
}) {
  const [rows, setRows] = useState<CommentRow[] | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    opsFetch<{ items: CommentRow[] }>(`/api/ops/comments?entity=${entity}&id=${encodeURIComponent(id)}`)
      .then((d) => setRows(d.items))
      .catch(() => setRows([]));
  }, [entity, id]);
  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  const post = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setErr(null);
    try {
      await opsFetch("/api/ops/comments", {
        method: "POST",
        body: JSON.stringify({ entityType: entity, entityId: id, author: authorEmail ?? "web", body: text, label }),
      });
      setBody("");
      load();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span className={cn("font-medium text-muted-foreground/60 uppercase tracking-wide", TYPE.micro)}>
        Comments{rows ? ` · ${rows.length}` : ""}
      </span>
      {rows && rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((c) => (
            <li key={c.id} className={cn(SURFACE.inset, "flex gap-2 p-2.5")}>
              <CustomerMark name={c.author} size="xs" />
              <div className="min-w-0 flex-1">
                <p className={cn("flex items-center gap-1.5", TYPE.micro)}>
                  <span className="font-medium text-foreground/80">{c.author.split("@")[0]}</span>
                  <span className="text-muted-foreground/50">{relTime(c.at)}</span>
                </p>
                <p className={cn("mt-0.5 whitespace-pre-wrap break-words text-foreground/90", TYPE.meta)}>
                  {withMentions(c.body)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <OpsTextarea
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Comment… @email to notify"
      />
      {err ? <p className={cn("text-red-400", TYPE.micro)}>{err}</p> : null}
      <OpsButton intent="primary" size="sm" className="self-end" disabled={busy || !body.trim()} onClick={post}>
        Comment
      </OpsButton>
    </div>
  );
}

/** Deep-link helper shared by detail actions. */
export function opsHref(section: OpsSection, id: string): string {
  return `/?ops=${section}&id=${encodeURIComponent(id)}`;
}

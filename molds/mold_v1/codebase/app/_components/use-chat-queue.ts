"use client";

/**
 * A CHAT'S QUEUE, as a tab sees it — held on the SERVER (app/api/ops/chat-queue, lib/chat-queue-server.ts).
 *
 * Messages typed while the agent is still working are queued, never delivered mid-turn (eve would buffer them where
 * nobody reads them — #59). They used to live in the tab's sessionStorage, so closing the tab lost them. Now:
 *
 *   - QUEUE: the item goes to the server at once, with the settings it was typed under and the wire text they
 *     compose (`compose`), so what is sent is what the person queued, whatever the composer shows later.
 *   - ATTACHMENTS go to the data room right away (they did anyway, at send time) and the item stores their paths;
 *     until they land, the server holds the item. An upload the closed tab never finished stays on the item as
 *     "was still uploading", and the person chooses "Send without it" or ×.
 *   - SENT BY THE SERVER, exactly once: when the session comes to rest (the agent's hook, or this tab's `drain`
 *     when it sees rest first). This tab only learns what went (`onDelivered`) so it can read the reply.
 *   - EVERY TAB SEES THE SAME QUEUE — it is one list on the server — so × and "Send without it" work from any of
 *     them, and nothing a tab does can send an item twice.
 *
 * WHEN THE SERVER CANNOT HOLD IT (no database, the migration not applied, a thread that is not the person's own,
 * no session yet): the item stays in this tab (`where: "local"`) and the tab sends it itself, exactly as before.
 * A chat's FIRST message is never the server's: the tab creates the session with it (a queue-delivery token can
 * never create one — the agent's session guard and its door both refuse), and anything typed before its session
 * id is known stays in the tab. The server queue covers follow-ups only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueSettings } from "@/lib/chat-queue";

export type QueueState = "queued" | "sending" | "sent" | "expired" | "failed";

export interface QueueEntry {
  readonly id: string;
  readonly text: string;
  readonly settings: QueueSettings;
  readonly createdAt: number;
  /** Files attached when it was queued. */
  readonly files: number;
  readonly state: QueueState;
  /** Uploads not finished (server). */
  readonly filesPending: number;
  readonly fileNames: readonly string[];
  readonly attachments: ReadonlyArray<{ name: string; path?: string }>;
  readonly message: string;
  readonly goal: boolean;
  readonly sentAt: number | null;
  /** "server": the server sends it. "local": this tab does (the server cannot hold it). */
  readonly where: "server" | "local";
  /** This tab is still saving it or uploading its files. */
  readonly busy?: "saving" | "uploading";
  /** A note to show under it (e.g. "already sent" after a late ×). */
  readonly note?: string;
}

interface ServerItem {
  id: string;
  sessionId: string;
  text: string;
  message: string;
  settings: QueueSettings;
  goal: boolean;
  attachments: Array<{ name: string; path?: string }>;
  filesPending: number;
  fileNames: string[];
  state: QueueState;
  createdAt: number;
  sentAt: number | null;
}

const fromServer = (s: ServerItem, prev?: QueueEntry): QueueEntry => ({
  id: s.id,
  text: s.text,
  settings: s.settings,
  createdAt: s.createdAt,
  files: Math.max(s.fileNames?.length ?? 0, s.attachments?.length ?? 0, prev?.files ?? 0),
  state: s.state,
  filesPending: s.filesPending,
  fileNames: s.fileNames ?? [],
  attachments: s.attachments ?? [],
  message: s.message,
  goal: s.goal,
  sentAt: s.sentAt,
  where: "server",
  busy: prev?.busy === "uploading" && s.filesPending > 0 ? "uploading" : undefined,
  note: prev?.note,
});

/** Last known queue per chat: a remount (a hand-back, a resync) must not blank it while it reloads. */
const cache = new Map<string, QueueEntry[]>();
/** Items this page already handed to `onDelivered` (so a reply is read once, not on every refresh). */
const delivered = new Set<string>();
/** Is the server queue usable here? Learned once per page: a deployment without it stays local. */
let serverUsable: boolean | null = null;

const newId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export interface UseChatQueueInput {
  readonly chatKey: string;
  /** The eve session the queue is for; null until the first message has one. */
  readonly sessionId: string | null;
  /** False for a thread that is not the person's own (shared / relay / read-only): local only, never stored. */
  readonly serverAllowed: boolean;
  readonly getAuthHeaders: () => Record<string, string>;
  /** The wire text for an item: directives for its settings, then the text, then the attachment block. */
  readonly compose: (
    text: string,
    settings: QueueSettings,
    stored: ReadonlyArray<{ name: string; path: string }>,
    failed: readonly string[],
  ) => { message: string; goal: boolean };
  /** Store one file in the data room; its path, or null when it failed. */
  readonly upload: (file: File, name: string) => Promise<string | null>;
  /** An item left the queue and was delivered — read its reply. */
  readonly onDelivered: (entry: { id: string; message: string; goal: boolean; text: string }) => void;
}

export function useChatQueue(input: UseChatQueueInput) {
  const { chatKey, sessionId, serverAllowed } = input;
  const [entries, setEntriesState] = useState<QueueEntry[]>(() => cache.get(chatKey) ?? []);
  const entriesRef = useRef(entries);
  const setEntries = useCallback(
    (fn: (prev: QueueEntry[]) => QueueEntry[]) => {
      setEntriesState((prev) => {
        const next = fn(prev);
        entriesRef.current = next;
        if (next.length) cache.set(chatKey, next);
        else cache.delete(chatKey);
        return next;
      });
    },
    [chatKey],
  );
  const ref = useRef(input);
  ref.current = input;
  const useServer = serverAllowed && serverUsable !== false;
  const [background, setBackground] = useState<boolean | null>(null);

  const api = useCallback(async (method: string, url: string, body?: unknown): Promise<Response | null> => {
    try {
      return await fetch(url, {
        method,
        headers: { ...ref.current.getAuthHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch {
      return null;
    }
  }, []);

  /** Hand every newly sent item to the reader, once. */
  const announce = useCallback((list: readonly QueueEntry[]) => {
    for (const e of list) {
      if (e.state !== "sent" || delivered.has(e.id)) continue;
      delivered.add(e.id);
      ref.current.onDelivered({ id: e.id, message: e.message, goal: e.goal, text: e.text });
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const sid = ref.current.sessionId;
    if (!sid || !ref.current.serverAllowed || serverUsable === false) return;
    const res = await api("GET", `/api/ops/chat-queue?session=${encodeURIComponent(sid)}`);
    if (!res) return;
    if (res.status === 503 || res.status === 404) {
      const body = (await res.json().catch(() => null)) as { unavailable?: boolean } | null;
      if (res.status === 404 || body?.unavailable) serverUsable = false;
      return;
    }
    if (!res.ok) return;
    const body = (await res.json().catch(() => null)) as { items?: ServerItem[]; background?: boolean; unavailable?: boolean } | null;
    if (!body) return;
    if (body.unavailable) {
      serverUsable = false;
      return;
    }
    serverUsable = true;
    setBackground(body.background === true);
    const items = body.items ?? [];
    setEntries((prev) => {
      const byId = new Map(prev.map((e) => [e.id, e]));
      const serverIds = new Set(items.map((i) => i.id));
      const merged = items
        // A sent item's reply is read through the transcript; the row itself leaves the queue.
        .filter((i) => i.state !== "sent")
        .map((i) => fromServer(i, byId.get(i.id)));
      // What this tab still holds that the server does not know yet (saving, or local-only).
      const mine = prev.filter((e) => !serverIds.has(e.id) && (e.where === "local" || e.busy === "saving"));
      return [...merged, ...mine];
    });
    announce(items.map((i) => fromServer(i)));
  }, [api, announce, setEntries]);

  // Load on open and whenever the chat gets its session; keep it current while anything is waiting.
  useEffect(() => {
    void refresh();
  }, [sessionId, refresh]);
  const waiting = entries.some((e) => e.state === "queued" || e.state === "sending" || e.busy);
  useEffect(() => {
    if (!waiting || !useServer) return;
    const t = setInterval(() => void refresh(), 4_000);
    return () => clearInterval(t);
  }, [waiting, useServer, refresh]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    document.addEventListener("resume", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
      document.removeEventListener("resume", onVisible);
    };
  }, [refresh]);

  /** Queue a message. Files: kept in this tab until they are stored, then only their paths travel. */
  const add = useCallback(
    async (text: string, files: ReadonlyArray<{ file: File; name: string }>, settings: QueueSettings): Promise<QueueEntry> => {
      const id = newId();
      const { message, goal } = ref.current.compose(text, settings, [], []);
      const draft: QueueEntry = {
        id,
        text,
        settings,
        createdAt: Date.now(),
        files: files.length,
        state: "queued",
        filesPending: files.length,
        fileNames: files.map((f) => f.name),
        attachments: [],
        message,
        goal,
        sentAt: null,
        where: "server",
        busy: "saving",
      };
      const sid = ref.current.sessionId;
      const serverOk = sid && ref.current.serverAllowed && serverUsable !== false;
      if (!serverOk) {
        const local: QueueEntry = { ...draft, where: "local", busy: undefined };
        setEntries((prev) => [...prev, local]);
        return local;
      }
      setEntries((prev) => [...prev, draft]);
      const res = await api("POST", "/api/ops/chat-queue", {
        item: {
          id,
          eveSessionId: sid,
          chatId: ref.current.chatKey,
          text,
          message,
          settings,
          goal,
          filesPending: files.length,
          fileNames: files.map((f) => f.name),
        },
      });
      if (!res || !res.ok) {
        if (res && res.status === 503) serverUsable = serverUsable ?? null;
        // The server could not take it: this tab keeps it and sends it itself.
        const local: QueueEntry = { ...draft, where: "local", busy: undefined };
        setEntries((prev) => prev.map((e) => (e.id === id ? local : e)));
        return local;
      }
      serverUsable = true;
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, busy: files.length ? "uploading" : undefined } : e)));
      if (files.length > 0) {
        const stored = await Promise.all(files.map(async (f) => ({ name: f.name, path: await ref.current.upload(f.file, f.name) })));
        const ok = stored.filter((s): s is { name: string; path: string } => Boolean(s.path));
        const failed = stored.filter((s) => !s.path).map((s) => s.name);
        const cur = entriesRef.current.find((e) => e.id === id);
        const composed = ref.current.compose(cur?.text ?? text, settings, ok, failed);
        await api("PATCH", "/api/ops/chat-queue", {
          id,
          patch: { message: composed.message, attachments: ok, filesPending: 0 },
        });
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, busy: undefined, filesPending: 0, attachments: ok } : e)));
      }
      void refresh();
      return draft;
    },
    [api, refresh, setEntries],
  );

  const patch = useCallback(
    async (id: string, p: Record<string, unknown>) => {
      const res = await api("PATCH", "/api/ops/chat-queue", { id, patch: p });
      if (res && res.status === 409) {
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, note: "Already sent — it can no longer be changed." } : e)));
      }
      void refresh();
    },
    [api, refresh, setEntries],
  );

  /** ×: only while it has not gone. A late × says so instead of pretending. */
  const remove = useCallback(
    async (id: string) => {
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry) return;
      if (entry.where === "local") {
        setEntries((prev) => prev.filter((e) => e.id !== id));
        return;
      }
      setEntries((prev) => prev.filter((e) => e.id !== id));
      const res = await api("DELETE", `/api/ops/chat-queue?id=${encodeURIComponent(id)}`);
      if (res && res.status === 409) {
        // It was already on its way: it stays gone from the queue, and its reply is read.
        void refresh();
      } else if (!res || (!res.ok && res.status !== 404)) {
        // Not removed (offline): put it back rather than pretend.
        setEntries((prev) => (prev.some((e) => e.id === id) ? prev : [...prev, entry]));
      }
    },
    [api, refresh, setEntries],
  );

  const editTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const edit = useCallback(
    (id: string, text: string) => {
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, text } : e)));
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry || entry.where === "local") return;
      const timers = editTimers.current;
      const pending = timers.get(id);
      if (pending) clearTimeout(pending);
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          const cur = entriesRef.current.find((e) => e.id === id);
          if (!cur) return;
          const stored = cur.attachments.filter((a): a is { name: string; path: string } => typeof a.path === "string");
          const composed = ref.current.compose(cur.text, cur.settings, stored, []);
          void patch(id, { text: cur.text, message: composed.message });
        }, 600),
      );
    },
    [patch, setEntries],
  );

  const move = useCallback(
    (id: string, dir: -1 | 1) => {
      setEntries((prev) => {
        const i = prev.findIndex((e) => e.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= prev.length) return prev;
        const next = [...prev];
        [next[i], next[j]] = [next[j], next[i]];
        return next;
      });
      const entry = entriesRef.current.find((e) => e.id === id);
      if (entry && entry.where === "server") void patch(id, { move: dir });
    },
    [patch, setEntries],
  );

  /** "Send without it": an upload that never finished is dropped, and the model is told it is missing. */
  const sendWithout = useCallback(
    (id: string) => {
      const cur = entriesRef.current.find((e) => e.id === id);
      if (!cur) return;
      if (cur.where === "local") {
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, files: 0, filesPending: 0 } : e)));
        return;
      }
      const stored = cur.attachments.filter((a): a is { name: string; path: string } => typeof a.path === "string");
      const missing = cur.fileNames.filter((n) => !stored.some((s) => s.name === n));
      const composed = ref.current.compose(cur.text, cur.settings, stored, missing);
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, filesPending: 0 } : e)));
      void patch(id, { message: composed.message, filesPending: 0 });
    },
    [patch, setEntries],
  );

  /** An expired or failed item the person wants sent after all ("Send now" / "Send again"): back in line, as new. */
  const requeue = useCallback((id: string) => void patch(id, { requeue: true }), [patch]);

  /** Ask the server to send the next item if the session is at rest. Resolves with what went, if anything. */
  const drain = useCallback(async (): Promise<string | null> => {
    const sid = ref.current.sessionId;
    if (!sid) return null;
    const res = await api("POST", "/api/ops/chat-queue/drain", { sessionId: sid });
    const body = res && res.ok ? ((await res.json().catch(() => null)) as { reason?: string; delivered?: { id: string; message: string; goal: boolean; text: string } | null } | null) : null;
    if (body?.delivered && !delivered.has(body.delivered.id)) {
      delivered.add(body.delivered.id);
      setEntries((prev) => prev.filter((e) => e.id !== body.delivered?.id));
      ref.current.onDelivered(body.delivered);
    }
    void refresh();
    return body?.reason ?? null;
  }, [api, refresh, setEntries]);

  /** A local item this tab sent itself. */
  const takeLocal = useCallback(
    (id: string) => setEntries((prev) => prev.filter((e) => e.id !== id)),
    [setEntries],
  );

  const pending = entries.filter((e) => e.state === "queued" || e.state === "sending");
  return {
    entries,
    /** Items not yet gone (what holds new messages behind them). */
    pending,
    /** Server items the server will send. */
    serverQueued: pending.some((e) => e.where === "server" && e.state === "queued" && e.filesPending === 0 && !e.busy),
    /** Can the server send without a tab (it signs the owner's sign-in)? null until known. */
    background,
    add,
    remove,
    edit,
    move,
    sendWithout,
    requeue,
    drain,
    refresh,
    takeLocal,
  };
}

/** For tests and sign-out: forget this page's cached queues. */
export function forgetQueueCache(): void {
  cache.clear();
  delivered.clear();
  serverUsable = null;
}

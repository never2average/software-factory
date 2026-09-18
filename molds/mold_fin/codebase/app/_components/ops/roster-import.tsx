"use client";

/**
 * Roster import: upload the workbook, read what it will change, apply.
 *
 * All spreadsheet work happens on the server in one call — this component sends
 * bytes and renders a decision. It deliberately holds no parsed state: the apply
 * re-uploads the same file, so what gets written is always what was just read,
 * never a server-side cache of a workbook the reviewer may not have seen.
 *
 * The review step is the point. A bulk write to the reporting chain that lands
 * without showing its work is how one mistyped cell silently re-parents half the
 * org.
 */

import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangleIcon, RotateCcwIcon, UploadIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { authToken, errMessage, opsFetch } from "./lib";
import { SURFACE, TYPE } from "./tokens";

interface Change {
  email: string;
  isNew: boolean;
  fields: { field: string; from: string; to: string }[];
}
interface Snapshot {
  email: string;
  name: string | null;
  team: string | null;
  managerEmail: string | null;
  escalations: { email: string; reason: string }[];
  existed: boolean;
}
interface ImportResult {
  applied: boolean;
  problems?: string[];
  changes: Change[];
  rows?: number;
  updated?: number;
  created?: number;
  snapshot?: Snapshot[];
}

/** POST the workbook. `apply` false previews, true writes. */
async function postWorkbook(file: File, apply: boolean): Promise<ImportResult> {
  const body = new FormData();
  body.set("file", file);
  if (apply) body.set("apply", "1");
  const token = authToken();
  const res = await fetch("/api/ops/roster/import", {
    method: "POST",
    // No content-type: the browser must set the multipart boundary itself.
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    body,
  });
  const data = (await res.json().catch(() => null)) as (ImportResult & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
  return data as ImportResult;
}

export function RosterImportDialog({
  onClose,
  onApplied,
}: {
  readonly onClose: () => void;
  readonly onApplied: () => Promise<void> | void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  /** Kept only so Apply can re-send the exact bytes that were previewed. */
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(false);

  const take = useCallback(async (next: File) => {
    setError(null);
    setResult(null);
    setPreview(null);
    setUndone(false);
    setFile(next);
    setBusy(true);
    try {
      setPreview(await postWorkbook(next, false));
    } catch (e) {
      setFile(null);
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  async function apply() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const d = await postWorkbook(file, true);
      setResult(d);
      await onApplied();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /** Replay the pre-image through the JSON endpoint — an undo is just an import. */
  async function undo() {
    if (!result?.snapshot) return;
    setBusy(true);
    setError(null);
    try {
      await opsFetch("/api/ops/roster/bulk", {
        method: "POST",
        body: JSON.stringify({
          people: result.snapshot.map((s) => ({
            email: s.email,
            // "" clears; the endpoint reads null as "leave alone".
            name: s.name ?? "",
            team: s.team ?? "",
            managerEmail: s.managerEmail ?? "",
            escalations: s.escalations,
          })),
        }),
      });
      setUndone(true);
      await onApplied();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const problems = preview?.problems ?? [];
  const changes = preview?.changes ?? [];
  const blocked = problems.length > 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="space-y-0 border-border/70 border-b px-5 py-3.5 text-left">
          <DialogTitle className="text-sm leading-tight">Import roster</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void take(f);
              e.target.value = "";
            }}
          />

          {error && (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {result ? (
            <div className="flex flex-col gap-3">
              <p className={TYPE.body}>
                {undone
                  ? "Reverted — the roster is back to how it was before this import."
                  : `${result.updated ?? 0} updated, ${result.created ?? 0} added.`}
              </p>
              {!undone && (result.snapshot?.length ?? 0) > 0 && (
                <div>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void undo()}>
                    <RotateCcwIcon className="size-3.5" />
                    {busy ? "Reverting…" : "Undo this import"}
                  </Button>
                  <p className={cn("mt-1.5 text-muted-foreground", TYPE.micro)}>
                    Available while this dialog stays open. The workbook you downloaded is the
                    durable backup.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border py-6 transition-colors hover:border-foreground/30 disabled:opacity-60"
              >
                <UploadIcon className="size-5 text-muted-foreground" />
                <span className={TYPE.body}>
                  {busy && !preview ? "Reading…" : (file?.name ?? "Choose the filled-in workbook")}
                </span>
                <span className={cn("text-muted-foreground", TYPE.micro)}>
                  .xlsx — the file you downloaded, edited
                </span>
              </button>

              {problems.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                  <p
                    className={cn(
                      "mb-1 flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400",
                      TYPE.body,
                    )}
                  >
                    <AlertTriangleIcon className="size-3.5" />
                    {problems.length} problem{problems.length === 1 ? "" : "s"} — fix these and upload
                    again
                  </p>
                  <ul
                    className={cn(
                      "flex flex-col gap-0.5 text-amber-700 dark:text-amber-400/90",
                      TYPE.micro,
                    )}
                  >
                    {problems.slice(0, 25).map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                    {problems.length > 25 && <li>…and {problems.length - 25} more.</li>}
                  </ul>
                </div>
              )}

              {preview && !blocked && (
                <>
                  {changes.length === 0 ? (
                    <p className={cn("text-muted-foreground", TYPE.body)}>
                      Nothing to do — this file matches the roster exactly.
                    </p>
                  ) : (
                    <div className={cn(SURFACE.inset, "overflow-hidden")}>
                      <div
                        className={cn(
                          "border-border/60 border-b px-3 py-1.5 text-muted-foreground",
                          TYPE.micro,
                        )}
                      >
                        {changes.length} {changes.length === 1 ? "person" : "people"} affected ·{" "}
                        {changes.filter((c) => c.isNew).length} new · read from {preview.rows} row
                        {preview.rows === 1 ? "" : "s"}
                      </div>
                      <ul className="divide-y divide-border/40">
                        {changes.map((c) => (
                          <li key={c.email} className="px-3 py-2">
                            <span className="flex items-center gap-1.5">
                              <span className={cn("font-mono", TYPE.meta)}>{c.email}</span>
                              {c.isNew && (
                                <span className={cn(SURFACE.chip, "text-emerald-500", TYPE.micro)}>
                                  new
                                </span>
                              )}
                            </span>
                            <ul className={cn("mt-0.5 flex flex-col gap-0.5", TYPE.micro)}>
                              {c.fields.map((f) => (
                                <li key={f.field} className="text-muted-foreground">
                                  <span className="uppercase tracking-wide">{f.field}</span>{" "}
                                  <span className="text-destructive line-through">{f.from}</span>{" "}
                                  <span className="text-emerald-500">{f.to}</span>
                                </li>
                              ))}
                              {c.fields.length === 0 && (
                                <li className="text-muted-foreground">added to the roster</li>
                              )}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-border/70 border-t px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            {result ? "Done" : "Cancel"}
          </Button>
          {!result && (
            <Button
              size="sm"
              disabled={busy || blocked || changes.length === 0}
              onClick={() => void apply()}
            >
              {busy && preview ? "Applying…" : `Apply${changes.length ? ` to ${changes.length}` : ""}`}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

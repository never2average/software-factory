"use client";

/**
 * The changeset diff, read the way a code review is read.
 *
 * The previous version stacked every file's unified diff in one column. That is
 * fine for one small file and useless for a backfill: no way to jump to a file,
 * no way to tell where in a file you were, and a replaced line marked wholly
 * changed even when one token moved — leaving the reviewer to diff it by eye.
 *
 * So: a file list on the left with a filter, and on the right a side-by-side
 * view with real hunk headers (`@@ -a,b +c,d @@`), per-side line numbers, and
 * word-level highlighting inside replacement pairs.
 */

import { useEffect, useMemo, useState } from "react";
import { FileTextIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { SURFACE, TYPE } from "./tokens";
import { diffLines, diffStats, hunks, splitRows, wordDiff, type DiffRow, type WordSeg } from "./diff";

export interface DiffFile {
  path: string;
  action: string;
  before: string | null;
  after: string | null;
}

interface Prepared {
  file: DiffFile;
  stats: { added: number; removed: number };
  rows: DiffRow[];
  truncated: boolean;
}

/** GitHub's five-square proportion bar: how much of this file's change is additions. */
function StatBlocks({ added, removed }: { readonly added: number; readonly removed: number }) {
  const total = added + removed;
  const green = total === 0 ? 0 : Math.max(1, Math.round((added / total) * 5));
  const red = total === 0 ? 0 : Math.min(5 - green, Math.max(1, Math.round((removed / total) * 5)));
  return (
    <span className="inline-flex gap-px" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={cn(
            "size-2 rounded-[1px]",
            i < green ? "bg-emerald-500" : i < green + red ? "bg-destructive" : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

function Segs({ segs, tone }: { readonly segs: WordSeg[]; readonly tone: "add" | "del" }) {
  return (
    <>
      {segs.map((s, i) =>
        s.changed ? (
          <span key={i} className={tone === "add" ? "rounded-[2px] bg-emerald-500/30" : "rounded-[2px] bg-destructive/30"}>
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/** One side of a split row: gutter number, marker, text. */
function Side({
  row,
  segs,
  tone,
}: {
  readonly row: DiffRow | null;
  readonly segs?: WordSeg[];
  readonly tone: "add" | "del";
}) {
  if (!row) return <div className="bg-muted/[0.06]" />;
  const changed = row.kind !== "same";
  const num = tone === "del" ? row.a : row.b;
  return (
    <div
      className={cn(
        "flex min-w-0",
        changed && (tone === "add" ? "bg-emerald-500/[0.12]" : "bg-destructive/[0.12]"),
      )}
    >
      <span
        className={cn(
          "w-10 shrink-0 select-none border-border/40 border-r px-1.5 py-px text-right text-muted-foreground/50 tabular-nums",
          changed && (tone === "add" ? "bg-emerald-500/10" : "bg-destructive/10"),
        )}
      >
        {num ?? ""}
      </span>
      <span className="w-3.5 shrink-0 select-none py-px text-center text-muted-foreground/60">
        {changed ? (tone === "add" ? "+" : "−") : ""}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all py-px pr-2">
        {segs ? <Segs segs={segs} tone={tone} /> : row.text}
      </span>
    </div>
  );
}

function FileDiff({ prepared, showPath = true }: { readonly prepared: Prepared; readonly showPath?: boolean }) {
  const { file, stats, rows, truncated } = prepared;
  const hs = useMemo(() => hunks(rows), [rows]);

  return (
    <div className={cn(SURFACE.inset, "overflow-hidden")} id={`diff-${encodeURIComponent(file.path)}`}>
      {/* Sticky, so the path stays with the hunks scrolling under it. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-border/60 border-b bg-card/95 px-2.5 py-1.5 backdrop-blur">
        {/* A single-file diff whose "file" is a synthetic label (a prompt, say)
            gains nothing from naming it; the stats still earn the row. */}
        {showPath ? (
          <>
            <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-2xs" title={file.path}>
              {file.path}
            </span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        <span className={cn("shrink-0 tabular-nums", TYPE.micro)}>
          <span className="text-emerald-500">+{stats.added}</span>{" "}
          <span className="text-destructive">−{stats.removed}</span>
        </span>
        <StatBlocks added={stats.added} removed={stats.removed} />
      </div>

      {file.before === null && file.after === null ? (
        <div className={cn("px-2.5 py-2 text-muted-foreground", TYPE.meta)}>
          Nothing recorded on either side of this write.
        </div>
      ) : stats.added + stats.removed === 0 ? (
        <div className={cn("px-2.5 py-2 text-muted-foreground", TYPE.meta)}>
          No line changes — the write produced identical content.
        </div>
      ) : (
        <div className="overflow-x-auto font-mono text-[11px] leading-[1.5]">
          <div className="min-w-[34rem]">
            {truncated && (
              <div className={cn("bg-amber-500/10 px-2.5 py-1 text-amber-600 dark:text-amber-400", TYPE.micro)}>
                Too large to align line by line — shown as a full replacement.
              </div>
            )}
            {hs.map((h, hi) => (
              <div key={hi}>
                {/* The unified-diff address. A gap marker says lines were
                    skipped; this says which ones, which is the difference
                    between "some context is hidden" and knowing where you are. */}
                <div className="flex items-center gap-2 border-border/40 border-y bg-primary/[0.07] px-2.5 py-0.5 text-muted-foreground">
                  <span className="tabular-nums">
                    @@ −{h.aStart},{h.aCount} +{h.bStart},{h.bCount} @@
                  </span>
                  {h.gapBefore > 0 && (
                    <span className="text-muted-foreground/50">⋯ {h.gapBefore} unchanged above</span>
                  )}
                </div>
                {splitRows(h.rows).map((sr, i) => {
                  const w = sr.paired && sr.left && sr.right ? wordDiff(sr.left.text, sr.right.text) : null;
                  return (
                    <div key={i} className="grid grid-cols-2 divide-x divide-border/40">
                      <Side row={sr.left} tone="del" segs={w?.left} />
                      <Side row={sr.right} tone="add" segs={w?.right} />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ChangesetDiffView({
  files,
  onSummary,
  showPaths = true,
}: {
  readonly files: DiffFile[];
  readonly onSummary?: (s: { files: number; added: number; removed: number }) => void;
  /** Off when the path is a synthetic label rather than a real file. */
  readonly showPaths?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const prepared = useMemo<Prepared[]>(
    () =>
      files.map((file) => {
        const { rows, truncated } = diffLines(file.before ?? "", file.after ?? "");
        return { file, rows, truncated, stats: diffStats(rows) };
      }),
    [files],
  );

  useEffect(() => {
    onSummary?.({
      files: prepared.length,
      added: prepared.reduce((n, p) => n + p.stats.added, 0),
      removed: prepared.reduce((n, p) => n + p.stats.removed, 0),
    });
  }, [prepared, onSummary]);

  const q = filter.trim().toLowerCase();
  const listed = q ? prepared.filter((p) => p.file.path.toLowerCase().includes(q)) : prepared;
  // Selecting a file narrows the pane to it; nothing selected shows them all,
  // which is the right default when a changeset touched two files.
  const shown = selected ? listed.filter((p) => p.file.path === selected) : listed;

  if (!files.length) {
    return (
      <div className={cn(SURFACE.inset, "px-3 py-6 text-center text-muted-foreground", TYPE.body)}>
        This changeset never wrote anything.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 gap-3">
      {/* The file list earns its width once a changeset touches more than a
          couple of files; below that it is noise, so it does not appear. */}
      {prepared.length > 2 && (
        <div className={cn(SURFACE.inset, "flex w-56 shrink-0 flex-col overflow-hidden self-start")}>
          <div className="flex items-center gap-1.5 border-border/60 border-b px-2 py-1.5">
            <SearchIcon className="size-3 shrink-0 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files…"
              className={cn("min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/50", TYPE.meta)}
            />
          </div>
          <div className="max-h-[26rem] overflow-auto py-1">
            {listed.map((p) => {
              const active = selected === p.file.path;
              return (
                <button
                  key={p.file.path}
                  type="button"
                  onClick={() => setSelected(active ? null : p.file.path)}
                  className={cn(
                    "flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors",
                    active ? "bg-primary/10" : "hover:bg-muted/40",
                  )}
                  title={p.file.path}
                >
                  <FileTextIcon className="size-3 shrink-0 text-muted-foreground" />
                  <span className={cn("min-w-0 flex-1 truncate font-mono", TYPE.micro)}>
                    {p.file.path.split("/").pop()}
                  </span>
                  <span className={cn("shrink-0 tabular-nums", TYPE.micro)}>
                    <span className="text-emerald-500">+{p.stats.added}</span>{" "}
                    <span className="text-destructive">−{p.stats.removed}</span>
                  </span>
                </button>
              );
            })}
            {listed.length === 0 && (
              <p className={cn("px-2 py-2 text-muted-foreground", TYPE.micro)}>No file matches “{filter}”.</p>
            )}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {shown.map((p) => (
          <FileDiff key={p.file.path} prepared={p} showPath={showPaths} />
        ))}
      </div>
    </div>
  );
}

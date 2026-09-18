"use client";

/**
 * A generic drag-and-drop Kanban board (dnd-kit). Cards are draggable, columns
 * are droppable; dropping a card in a new column fires `onMove`. A 5px drag
 * threshold keeps plain clicks (open detail) working. Used by the Tasks board
 * (by status) and the Implementations pipeline (by stage).
 */
import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { TYPE } from "./tokens";

export type BoardColumn = { key: string; label: string; tone?: string };

function Card({ id, children }: { readonly id: string; readonly children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.4 : 1 }}
      className="touch-none"
    >
      {children}
    </div>
  );
}

function Column({
  col,
  count,
  children,
}: {
  readonly col: BoardColumn;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.key });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-96 shrink-0 flex-col rounded-lg border border-border/60 bg-muted/15 transition-colors",
        isOver && "border-foreground/30 bg-muted/40",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-border/60 border-b px-3 py-2">
        {col.tone ? <span className={cn("size-1.5 rounded-full", col.tone)} /> : null}
        <span className="font-medium text-xs">{col.label}</span>
        <span className={cn("ml-auto rounded-md bg-muted px-1.5 tabular-nums text-muted-foreground", TYPE.micro)}>
          {count}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">{children}</div>
    </div>
  );
}

export function Board<T extends { id: string }>({
  columns,
  items,
  columnOf,
  renderCard,
  onMove,
}: {
  readonly columns: readonly BoardColumn[];
  readonly items: readonly T[];
  readonly columnOf: (item: T) => string;
  readonly renderCard: (item: T) => React.ReactNode;
  readonly onMove: (item: T, toColumn: string) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragId, setDragId] = useState<string | null>(null);
  const dragItem = items.find((i) => i.id === dragId) ?? null;

  const grouped = new Map<string, T[]>();
  for (const c of columns) grouped.set(c.key, []);
  for (const it of items) grouped.get(columnOf(it))?.push(it);

  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const to = e.over?.id ? String(e.over.id) : null;
    const item = items.find((i) => i.id === String(e.active.id));
    if (item && to && columnOf(item) !== to) onMove(item, to);
  };

  return (
    <DndContext sensors={sensors} onDragStart={(e) => setDragId(String(e.active.id))} onDragEnd={onDragEnd}>
      <div className="flex h-full min-h-0 gap-3 overflow-x-auto p-4">
        {columns.map((col) => {
          const colItems = grouped.get(col.key) ?? [];
          return (
            <Column key={col.key} col={col} count={colItems.length}>
              {colItems.map((it) => (
                <Card key={it.id} id={it.id}>
                  {renderCard(it)}
                </Card>
              ))}
            </Column>
          );
        })}
      </div>
      <DragOverlay>{dragItem ? <div className="w-[22rem]">{renderCard(dragItem)}</div> : null}</DragOverlay>
    </DndContext>
  );
}

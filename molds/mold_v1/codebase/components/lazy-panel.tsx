"use client";

/**
 * A component loaded on first use that can FAIL to load, and come back.
 *
 * Every lazily loaded part of the app (the data room, the Ops Center, the control panel, charts, the pdf viewer) goes
 * through here rather than next/dynamic or a bare React.lazy, for three reasons that each took the app down:
 *
 *   1. A chunk that cannot be fetched must not blank the chat. The load is wrapped in a compact ErrorBoundary, and
 *      while the chunk is failing (lib/chunk-retry) the placeholder turns into a "could not load" card with Retry.
 *   2. Retry must actually retry. React.lazy keeps a rejected import forever; here a rejection swaps in a fresh lazy
 *      component, so the boundary's Retry imports again. Chunk-level failures never reject at all: lib/chunk-retry
 *      re-fetches the chunk and the pending import resolves.
 *   3. Nothing may jump while it loads: `placeholder` renders in the component's place with its size.
 *
 * `overlay: true` is for modals (the data room, the Ops Center): their card is drawn over the page with a Close that
 * calls the component's own `onOpenChange(false)`, and nothing is drawn while `open` is false.
 */
import { Suspense, lazy, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { RefreshCwIcon, AlertTriangleIcon, XIcon } from "lucide-react";
import { ErrorBoundary } from "@/app/_components/error-boundary";
import { failedChunksVersion, failedChunkCount, retryFailedChunks, subscribeFailedChunks } from "@/lib/chunk-retry";

interface Options<P> {
  /** What failed, in the person's words ("Data room"). */
  readonly label: string;
  /** Shown while loading, in the component's place and size. */
  readonly placeholder?: (props: P) => ReactNode;
  readonly overlay?: boolean;
}

type ModalProps = { open?: boolean; onOpenChange?: (open: boolean) => void };

function Overlay({ children, onClose }: { readonly children: ReactNode; readonly onClose?: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6">
      <div className="relative w-full max-w-sm rounded-2xl border border-border bg-popover shadow-2xl">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute top-2 right-2 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
        {children}
      </div>
    </div>
  );
}

function ChunkFailed({ label }: { readonly label: string }) {
  return (
    <div role="alert" data-testid="lazy-load-failed" className="flex flex-col items-center gap-2 p-6 text-center">
      <AlertTriangleIcon className="size-5 text-amber-500" />
      <p className="font-medium text-sm">{label} couldn’t load</p>
      <p className="max-w-[18rem] text-xs text-muted-foreground">
        The connection dropped while it was loading. It will try again on its own.
      </p>
      <button
        type="button"
        onClick={() => retryFailedChunks()}
        className="mt-1 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <RefreshCwIcon className="size-3.5" />
        Retry
      </button>
    </div>
  );
}

export function lazyPanel<P extends object>(
  load: () => Promise<ComponentType<P>>,
  { label, placeholder, overlay }: Options<P>,
): ComponentType<P> {
  const make = () =>
    lazy(() =>
      load().then(
        (C) => ({ default: C }),
        (e: unknown) => {
          current = make(); // the boundary's Retry renders a fresh lazy, which imports again
          throw e;
        },
      ),
    );
  let current = make();

  function Pending(props: P) {
    useSyncExternalStore(subscribeFailedChunks, failedChunksVersion, failedChunksVersion);
    const m = props as ModalProps;
    if (overlay && m.open === false) return null;
    if (failedChunkCount() > 0) {
      const card = <ChunkFailed label={label} />;
      return overlay ? <Overlay onClose={() => m.onOpenChange?.(false)}>{card}</Overlay> : card;
    }
    return <>{placeholder?.(props) ?? null}</>;
  }

  // Reads `current` when it RENDERS: after the boundary's Retry this subtree mounts again and gets the fresh lazy.
  function Loaded(props: P) {
    const C = current;
    return <C {...props} />;
  }

  function LazyPanel(props: P) {
    const m = props as ModalProps;
    return (
      <ErrorBoundary
        label={label}
        compact
        resetKeys={overlay ? [m.open] : undefined}
        frame={
          overlay
            ? (card) => (m.open === false ? null : <Overlay onClose={() => m.onOpenChange?.(false)}>{card}</Overlay>)
            : undefined
        }
      >
        <Suspense fallback={<Pending {...props} />}>
          <Loaded {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  }
  LazyPanel.displayName = `Lazy(${label})`;
  return LazyPanel;
}

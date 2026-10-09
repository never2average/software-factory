"use client";

/**
 * The last resort, for an error nothing closer caught. Every lazily loaded part of the app has its own boundary
 * (components/lazy-panel.tsx) and the chat's regions have theirs (app/_components/error-boundary.tsx); this is what a
 * person sees instead of Next's bare "This page couldn't load" when something still gets through. "Try again"
 * re-renders the page in place (nothing typed is lost if the fault was passing); "Reload" is the full reset.
 */
import { useEffect } from "react";
import { AlertTriangleIcon } from "lucide-react";

export default function AppError({ error, reset }: { readonly error: Error & { digest?: string }; readonly reset: () => void }) {
  useEffect(() => {
    console.error("[app] unhandled render error:", error);
  }, [error]);
  return (
    <main role="alert" data-testid="app-error" className="grid h-dvh place-items-center bg-background p-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
        <AlertTriangleIcon className="size-6 text-amber-500" />
        <p className="font-medium text-base">This page hit an error</p>
        <p className="break-words text-sm text-muted-foreground">{error.message || "An unexpected error."}</p>
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background transition-opacity hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    </main>
  );
}

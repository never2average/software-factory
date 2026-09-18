"use client";

import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { Component, type ReactNode } from "react";

interface Props {
  /** Human label for what failed, e.g. "Control panel". */
  readonly label: string;
  readonly children: ReactNode;
  /** Optional compact fallback (used for small rails); defaults to the full card. */
  readonly compact?: boolean;
  /**
   * Values that, when they change, auto-clear a caught error and re-attempt the
   * render. A TRANSIENT throw (e.g. a mid-stream reducer glitch when a turn
   * breaks, or a subagent stopping) otherwise wedges the boundary — the whole
   * region stays replaced by the error card until a manual Retry, and Retry
   * re-throws if the state is still bad. Passing the session id + event/message
   * count here means the very next event (or a thread switch) recovers the view
   * automatically instead of leaving the chat "stuck broken".
   */
  readonly resetKeys?: readonly unknown[];
}

interface State {
  error: Error | null;
}

/**
 * Contains render errors to a single region. Without this, a throw in the
 * cockpit or an artifact preview unmounts the whole React tree and the user
 * sees a blank white screen. Here the rest of the app keeps working and the
 * real error message is shown (and logged) instead of vanishing.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // Surface the real cause in the console for debugging the panel crash.
    console.error(`[${this.props.label}] render error:`, error, info);
  }

  componentDidUpdate(prev: Props) {
    // Auto-recover when any reset key changes while we're in the error state.
    if (!this.state.error) return;
    const a = prev.resetKeys ?? [];
    const b = this.props.resetKeys ?? [];
    if (a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))) {
      this.setState({ error: null });
    }
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.compact) {
      return (
        <div className="flex flex-col items-center gap-2 p-6 text-center">
          <AlertTriangleIcon className="size-5 text-amber-500" />
          <p className="font-medium text-sm">{this.props.label} hit an error</p>
          <p className="max-w-[16rem] break-words text-xs text-muted-foreground">
            {error.message}
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="mt-1 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <RefreshCwIcon className="size-3.5" />
            Retry
          </button>
        </div>
      );
    }

    return (
      <div className="grid h-full place-items-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
          <AlertTriangleIcon className="size-6 text-amber-500" />
          <p className="font-medium text-base">{this.props.label} hit an error</p>
          <p className="break-words text-sm text-muted-foreground">{error.message}</p>
          <button
            type="button"
            onClick={this.reset}
            className="mt-1 flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            <RefreshCwIcon className="size-3.5" />
            Retry
          </button>
        </div>
      </div>
    );
  }
}

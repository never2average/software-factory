"use client";

import { useState } from "react";
import type { GuestLink } from "@/lib/guest-invite-rules";

/**
 * Sign in with an emailed code.
 *
 * The door for people Google cannot vouch for. It is NOT a sign-up: the server
 * only sends a code to an address that already has an invite or a membership,
 * so this is how an invite to a gmail.com address — or any address on a domain
 * with no Google Workspace — actually gets redeemed. Before it existed those
 * invites were created, emailed, and then refused at the gate.
 *
 * Collapsed to one link by default. Google is the path for everyone with a work
 * account, and putting two equal-weight choices on a sign-in screen makes both
 * of them look uncertain.
 */

type Stage = "hidden" | "email" | "code";

export function EmailSignIn({
  onToken,
  chatLink = null,
}: {
  readonly onToken: (token: string) => void;
  /**
   * The shared chat this page was opened for (its link). Sent with both steps, so a GUEST of that chat — someone
   * outside its workspace, with no workspace invite — gets a code, and the invite is checked again when they use it.
   */
  readonly chatLink?: GuestLink | null;
}) {
  const linkFields = chatLink ? { org: chatLink.org, chat: chatLink.chat } : {};
  const [stage, setStage] = useState<Stage>("hidden");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/auth/email/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, ...linkFields }),
      });
      const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "Could not send a code.");
        return;
      }
      // The server answers identically whether or not the address qualifies —
      // it must not become a way to discover who belongs to which workspace —
      // so the wording here has to stay non-committal too.
      setNote(
        chatLink
          ? "If the chat was shared with that address, a 6-digit code is on its way. Check your inbox (and spam folder), then type it here."
          : (data?.message ?? "If that address has an invite, a code is on its way."),
      );
      setStage("code");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code, ...linkFields }),
      });
      const data = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
      if (!res.ok || !data?.token) {
        setError(data?.error ?? "That code didn't work.");
        return;
      }
      onToken(data.token);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  if (stage === "hidden") {
    return (
      <button
        type="button"
        onClick={() => setStage("email")}
        className="mt-2 min-h-6 cursor-pointer py-1 text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
      >
        {chatLink ? "Email me a code instead" : "Invited by email? Sign in with a code"}
      </button>
    );
  }

  const onEmailStage = stage === "email";
  const canSubmit = onEmailStage ? /.+@.+\..+/.test(email) : /^\d{6}$/.test(code);

  return (
    <form
      className="mt-4 w-full"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && canSubmit) void (onEmailStage ? request() : verify());
      }}
    >
      <div className="flex gap-2">
        {onEmailStage ? (
          <input
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="h-10 min-w-0 flex-1 rounded-full border border-border bg-card px-4 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground/30"
          />
        ) : (
          <input
            // A phone-keypad numeric field: the code is six digits and arrives
            // on a phone, so a text keyboard is a small, constant tax.
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="6-digit code"
            className="h-10 min-w-0 flex-1 rounded-full border border-border bg-card px-4 text-center text-sm tracking-[0.3em] outline-none placeholder:tracking-normal placeholder:text-muted-foreground focus:border-foreground/30"
          />
        )}
        <button
          type="submit"
          disabled={busy || !canSubmit}
          className="h-10 shrink-0 cursor-pointer rounded-full bg-foreground px-4 font-medium text-background text-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "…" : onEmailStage ? "Send code" : "Sign in"}
        </button>
      </div>
      {note ? <p className="mt-2 text-center text-2xs text-muted-foreground">{note}</p> : null}
      {error ? (
        <p className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-center text-destructive text-xs">
          {error}
        </p>
      ) : null}
      {!onEmailStage ? (
        <button
          type="button"
          onClick={() => {
            setStage("email");
            setCode("");
            setError(null);
            setNote(null);
          }}
          className="mt-2 w-full cursor-pointer text-center text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Use a different address
        </button>
      ) : null}
    </form>
  );
}

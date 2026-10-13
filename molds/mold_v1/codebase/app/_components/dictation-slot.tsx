"use client";

/**
 * Where the composer's microphone goes. Loaded on demand by the composer (app/_components/composer.tsx), so no part of
 * dictation is on the chat's first load.
 *
 * It asks the server once per tab whether dictation is on (GET /api/ops/dictation: the profile's `asr.enabled` AND the
 * provider's credentials set), after the first screen's own reads, and draws nothing until it answers yes. Only then is
 * the button (app/_components/dictation-button.tsx) loaded, and what listens (the microphone, the level, the cut into
 * sections: app/_components/dictation-engine.ts) only on the first press: a deployment or a person without dictation
 * never downloads either, and the chat's first-load budget (scripts/check-bundle-budget.mjs) does not carry them.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { readActiveOrg, readStored, STORAGE_KEYS } from "@/lib/browser-storage";
import { DEFAULT_IDLE_STOP_SECONDS, DEFAULT_MAX_SESSION_SECONDS, type DictationCapability } from "@/lib/dictation-text";

export const DICTATION_PATH = "/api/ops/dictation";

/** The bearer and this tab's workspace, as every ops call sends them (app/_components/auth-gate.tsx). */
export function dictationAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = readStored(STORAGE_KEYS.token);
  if (token) headers.authorization = `Bearer ${token}`;
  const org = readActiveOrg();
  if (org) headers["x-ops-org"] = org;
  return headers;
}

/** One answer per tab for a person and workspace; a failed read is not kept (the next composer asks again). */
let capabilityRead: { key: string; answer: Promise<DictationCapability | null> } | null = null;
function readCapability(): Promise<DictationCapability | null> {
  const headers = dictationAuthHeaders();
  if (!headers.authorization) return Promise.resolve(null);
  const key = `${headers.authorization}\n${headers["x-ops-org"] ?? ""}`;
  if (capabilityRead?.key === key) return capabilityRead.answer;
  const answer = fetch(DICTATION_PATH, { headers })
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Partial<DictationCapability>;
      if (body.enabled !== true || typeof body.max_seconds !== "number" || typeof body.max_bytes !== "number") return null;
      // A server from before sections were streamed says neither of the last two: the profile's defaults.
      const whole = (v: unknown, otherwise: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : otherwise);
      return {
        enabled: true,
        max_seconds: body.max_seconds,
        max_bytes: body.max_bytes,
        max_session_seconds: whole(body.max_session_seconds, DEFAULT_MAX_SESSION_SECONDS),
        idle_stop_seconds: whole(body.idle_stop_seconds, DEFAULT_IDLE_STOP_SECONDS),
      };
    })
    .catch(() => {
      if (capabilityRead?.key === key) capabilityRead = null;
      return null;
    });
  capabilityRead = { key, answer };
  return answer;
}

// React's own lazy, not next/dynamic: the latter's loader added a first-load file and ~4 KB brotli to the chat
// (scripts/check-bundle-budget.mjs), more than the recorder it was there to keep out.
const DictationButton = lazy(() => import("./dictation-button").then((m) => ({ default: m.DictationButton })));

export function DictationSlot() {
  const [capability, setCapability] = useState<DictationCapability | null>(null);
  useEffect(() => {
    let live = true;
    // After the first screen's reads (lib/startup-fetch.ts), never in front of them.
    const t = setTimeout(() => {
      void readCapability().then((c) => {
        if (live) setCapability(c);
      });
    }, 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, []);
  return capability?.enabled ? (
    <Suspense fallback={null}>
      <DictationButton capability={capability} path={DICTATION_PATH} authHeaders={dictationAuthHeaders} />
    </Suspense>
  ) : null;
}

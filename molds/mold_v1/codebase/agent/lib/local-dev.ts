/**
 * `eve dev`'s open door, and the only places it may open.
 *
 * eve's `localDev()` admits ANY request whose URL names a loopback host — `localhost`, `127.x`, `::1` — as a
 * `local-dev` principal with no identity at all. The URL comes from the `Host` header, so the only thing keeping it
 * shut in production was the edge in front of the deployment rewriting that header. eve's own docs say as much:
 * "an origin that trusts an attacker-controlled Host header … lets an attacker spoof `Host: localhost`". On Vercel
 * that holds; on a VM behind a proxy that forwards Host, or any host that does not normalise it, `curl -H 'Host:
 * localhost'` was a sign-in as nobody in particular, and the session guard admits the local-dev principal to every
 * session (it has to — it is how `eve dev` works).
 *
 * So the door is gated on the PROCESS as well as the request. It opens only inside a development server that says
 * so itself — `eve dev` sets `EVE_DEV=1` in its own process (eve/dist/src/internal/application/dev-environment.js),
 * and `vercel dev` sets `VERCEL=1` with `VERCEL_ENV=development` — and never where NODE_ENV or VERCEL_ENV says
 * production or preview; and then only on a loopback URL (eve's own check, unchanged). A built server started any
 * other way (the `.output` of `eve build` on a VM, a container) has neither marker, so it is shut there even when
 * nobody remembered to set NODE_ENV.
 */
import { localDev } from "eve/channels/auth";

type Env = Readonly<Record<string, string | undefined>>;

/** May this process admit eve's local-dev principal at all? Read at request time, so a test can flip it. */
export function localDevAllowed(env: Env = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  const vercelEnv = env.VERCEL_ENV;
  if (vercelEnv === "production" || vercelEnv === "preview") return false;
  // Any Vercel runtime other than `vercel dev` (which sets VERCEL=1 with VERCEL_ENV=development).
  if (env.VERCEL && vercelEnv !== "development") return false;
  // Opt-in by the development server itself; absent everywhere else.
  return env.EVE_DEV === "1" || (Boolean(env.VERCEL) && vercelEnv === "development");
}

/** eve's `localDev()`, behind {@link localDevAllowed}. */
export function guardedLocalDev(): ReturnType<typeof localDev> {
  const inner = localDev();
  return (request) => (localDevAllowed() ? inner(request) : null);
}

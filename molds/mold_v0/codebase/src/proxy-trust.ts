/**
 * Which address a request came from (mold_v0-084): Express's `trust proxy` as the number of proxies in front of this
 * server, so req.ip (the per-IP limits of src/rate-limits.ts: the MCP front door, sign-up, sign-in) is the address the
 * nearest proxy saw, never one a client wrote into X-Forwarded-For. With N proxies, req.ip is the N-th address from the
 * right of X-Forwarded-For (each proxy appends the address it was reached from); everything to its left is the
 * client's to write and is ignored. `true` (trust every hop) would take the leftmost, which any client sets.
 *
 *   OCTILLION_PROXY_HOPS   the number of proxies, 0 to 5, set per target by the factory:
 *                          a server of its own (deploy/docker-compose.prod.yml): 1, the stack's Caddy, which replaces
 *                          any X-Forwarded-For a client sent with the address it saw
 *                          Vercel: 1, Vercel's edge, which does the same
 *   unset                  1 on Vercel (process.env.VERCEL), else 0: this server is reached directly (local work), so
 *                          X-Forwarded-For is ignored and req.ip is the connection's own address
 * A value that is not a whole number from 0 to 5 is refused at start (the server does not guess how it is reached).
 */
export const MAX_PROXY_HOPS = 5;

export function proxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.OCTILLION_PROXY_HOPS ?? "").trim();
  if (!raw) return env.VERCEL ? 1 : 0;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 0 || n > MAX_PROXY_HOPS)
    throw new Error(`OCTILLION_PROXY_HOPS must be a whole number from 0 to ${MAX_PROXY_HOPS} (the proxies in front of this server), not ${raw.slice(0, 20)}`);
  return n;
}

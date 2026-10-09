/**
 * Which Google Workspace domains may sign in to the agent, as a deployment's SETTING.
 *
 * With OPS_MULTI_TENANT unset, the agent's Google door (agent/channels/eve.ts) admits only accounts whose
 * hosted-domain (`hd`) claim is one of the deployment's own domains. That list used to be one company's domain
 * written into the code, so every other deployment's people were refused, and the code named a customer. It is
 * `WORKSPACE_LOGIN_DOMAINS` now: comma separated, e.g. `example.com,example.co.uk`.
 *
 * Unset (and not multi-tenant), the Google door is CLOSED: no domain is admitted, rather than any. That is the
 * safe reading of "single tenant, no domain named"; the emailed-code sign-in is unaffected, and a warning names the
 * setting. OPS_MULTI_TENANT=1 drops the domain lock, exactly as before (org membership decides what anyone sees).
 *
 * Edge-safe: no imports, no Node built-ins.
 */

/** A domain name: labels of letters, digits and hyphens, at least one dot. */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** WORKSPACE_LOGIN_DOMAINS as a list: lower case, trimmed, de-duplicated; a malformed entry is dropped. */
export function loginDomains(value: string | undefined = process.env.WORKSPACE_LOGIN_DOMAINS): string[] {
  return [...new Set((value ?? "").split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter((d) => DOMAIN.test(d)))];
}

let warned = false;

/**
 * What the Google verifier is given for the domain lock:
 *   {}                          multi-tenant: any Workspace domain (org membership decides what they see);
 *   { claims: { hd: [...] } }   single-tenant with WORKSPACE_LOGIN_DOMAINS set: those domains only;
 *   null                        single-tenant with none set: do not admit Google tokens at all.
 */
export function hostedDomainLock(
  { multiTenant = process.env.OPS_MULTI_TENANT === "1", domains = loginDomains() }: { multiTenant?: boolean; domains?: string[] } = {},
): { claims?: { hd: string[] } } | null {
  if (multiTenant) return {};
  if (domains.length) return { claims: { hd: domains } };
  if (!warned) {
    warned = true;
    console.warn(
      "[config] WORKSPACE_LOGIN_DOMAINS is not set and OPS_MULTI_TENANT is off, so the agent admits no Google sign-in. " +
        "Set WORKSPACE_LOGIN_DOMAINS to this installation's Google Workspace domain(s), comma separated, or OPS_MULTI_TENANT=1.",
    );
  }
  return null;
}

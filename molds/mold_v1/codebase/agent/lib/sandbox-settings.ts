/**
 * WHERE THE SANDBOX RUNS, and with what — read from the environment in one place.
 *
 * Every agent's bash tools run in a sandbox. On Vercel that is Vercel Sandbox, which eve picks by itself when a
 * sandbox definition names no backend (`defaultBackend()`: Vercel Sandbox when `process.env.VERCEL` is set). That is
 * what this deployment has always done, and with nothing set here it still does, exactly: the sandbox definitions
 * that read these settings (agent/sandbox.ts, agent/subagents/research/sandbox.ts) add no `backend` at all.
 *
 *   SANDBOX_BACKEND       unset, empty or "vercel"   eve's own choice, as today. The default.
 *                         "microsandbox"             a KVM microVM on this host, started by the service's own user
 *                                                    with no daemon and no root (eve's `microsandbox()`). For a
 *                                                    deployment that is not on Vercel.
 *   SANDBOX_CPUS          virtual CPUs per sandbox, microsandbox only. Default 2 (eve's default of 1 froze in 5 of
 *                         12 longer runs on nested KVM; 2 did not).
 *   SANDBOX_MEMORY_MIB    memory per sandbox in MiB, microsandbox only. Default 1024 (the document libraries install
 *                         in that; 512 did not finish).
 *   SANDBOX_DENY_SUBNETS  extra CIDRs to block, comma or space separated, added to the list below. The host's own
 *                         public address can go here, EXCEPT when the data room uses the filesystem storage driver:
 *                         sandboxes then download its file links from the web app ({@link sandboxStorageOrigin}).
 *
 * THE NETWORK DENY LIST (microsandbox only). eve's default policy for a local backend is "allow-all": measured, a
 * sandbox reached the cloud metadata address 169.254.169.254 and the host's Docker bridge. So the microsandbox
 * backend is always created with eve's own `networkPolicy` option: everything allowed (pip, the public internet)
 * except {@link SANDBOX_DENY_SUBNETS}. Under the Vercel backend nothing is passed and the policy is what it is today.
 *
 * A value that is set and wrong is an error, said plainly, when the sandbox definition is loaded (the build): a typo
 * here must not quietly fall back to another backend with other isolation.
 *
 * These are BUILD-TIME settings as much as run-time ones. The research prompt names the formatter's path
 * ({@link fmtXlsxPath}) and is rendered when the agent is built, so build and run with the same value.
 *
 * No eve import here, on purpose: the research specialist's prompt and the plain-node tests load this module too.
 */

type Env = Record<string, string | undefined>;

export type SandboxBackendSetting = "vercel" | "microsandbox";

/**
 * Never reachable from a microsandbox sandbox: link-local (the cloud metadata service, 169.254.169.254), the three
 * private ranges (10/8; 172.16/12, which holds Docker's default bridge 172.17.0.0/16 and its user networks;
 * 192.168/16) and loopback.
 */
export const SANDBOX_DENY_SUBNETS: readonly string[] = [
  "169.254.0.0/16",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
];

export const SANDBOX_DEFAULT_CPUS = 2;
export const SANDBOX_DEFAULT_MEMORY_MIB = 1024;

const set = (env: Env, name: string): string => env[name]?.trim() ?? "";

export function sandboxBackendSetting(env: Env = process.env): SandboxBackendSetting {
  const raw = set(env, "SANDBOX_BACKEND").toLowerCase();
  if (raw === "" || raw === "vercel") return "vercel";
  if (raw === "microsandbox") return "microsandbox";
  throw new Error(`SANDBOX_BACKEND=${JSON.stringify(raw)} is not supported. Use "vercel" (the default) or "microsandbox".`);
}

function wholeNumber(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = set(env, name);
  // An EMPTY variable is the default, never zero.
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name}=${JSON.stringify(raw)} is not valid. Use a whole number from ${min} to ${max} (default ${fallback}).`);
  }
  return n;
}

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const IPV6_CIDR = /^[0-9a-f:]*:[0-9a-f:]*(?:\/\d{1,3})?$/i;

/** One CIDR, normalised (a bare IPv4 address becomes a /32), or an error naming the entry. */
function cidr(entry: string): string {
  const v4 = IPV4_CIDR.exec(entry);
  if (v4) {
    const octetsOk = v4.slice(1, 5).every((o) => Number(o) <= 255);
    const bits = v4[5] === undefined ? 32 : Number(v4[5]);
    if (octetsOk && bits <= 32) return v4[5] === undefined ? `${entry}/32` : entry;
  } else if (IPV6_CIDR.test(entry)) {
    const bits = entry.includes("/") ? Number(entry.split("/")[1]) : 128;
    if (bits <= 128) return entry.includes("/") ? entry : `${entry}/128`;
  }
  throw new Error(`SANDBOX_DENY_SUBNETS: ${JSON.stringify(entry)} is not an address or a CIDR block (for example 203.0.113.7 or 203.0.113.0/24).`);
}

/** The whole deny list: the built-in ranges, then the deployment's own. Nothing can remove a built-in one. */
export function sandboxDenySubnets(env: Env = process.env): string[] {
  const extra = set(env, "SANDBOX_DENY_SUBNETS")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(cidr);
  return [...new Set([...SANDBOX_DENY_SUBNETS, ...extra])];
}

/* ---- the data room's own file links (filesystem storage) ------------------------------------------------------ */

/**
 * With the filesystem storage driver (`STORAGE_DRIVER=filesystem`, docs/STORAGE.md) a data-room file reaches a sandbox
 * as a signed link to the WEB APP ITSELF (`STORAGE_PUBLIC_URL`, else `WEB_ORIGIN`), which the sandbox downloads. So
 * the sandbox must be able to reach that one origin. The built-in deny list holds no public address, so a public name
 * for the web app is reachable as it is. What breaks it is that origin resolving INTO the deny list: a private or
 * loopback address, or the host's own public address added to `SANDBOX_DENY_SUBNETS`. No exception is carved out of
 * the deny list for it (eve emits subnet denies before any allow, and how microsandbox orders overlapping rules is
 * not something to lean on); the conflict is refused instead, plainly: at build time when the origin is an IP
 * literal, and by `npm run sandbox:prewarm` on the server, after resolving its name, before anything is served.
 */
export function sandboxStorageOrigin(env: Env = process.env): { readonly origin: string; readonly host: string; readonly setting: string } | null {
  const driver = set(env, "STORAGE_DRIVER").toLowerCase();
  if (driver !== "filesystem" && driver !== "fs") return null;
  const setting = set(env, "STORAGE_PUBLIC_URL") ? "STORAGE_PUBLIC_URL" : set(env, "WEB_ORIGIN") ? "WEB_ORIGIN" : null;
  if (!setting) return null;
  try {
    const url = new URL(set(env, setting));
    return { origin: url.origin, host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(), setting };
  } catch {
    return null; // the storage settings report a malformed address themselves
  }
}

/** An address as a number, with its family; null for anything that is not an IP literal. */
function ipValue(text: string): { v: 4 | 6; n: bigint } | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const parts = v4.slice(1, 5).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return { v: 4, n: parts.reduce((acc, p) => (acc << BigInt(8)) | BigInt(p), BigInt(0)) };
  }
  if (!text.includes(":")) return null;
  const halves = text.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const words = (s: string) => (s ? s.split(":") : []);
  const head = words(halves[0]);
  const tail = halves.length === 2 ? words(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail];
  if (all.length !== 8 || all.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  return { v: 6, n: all.reduce((acc, w) => (acc << BigInt(16)) | BigInt(parseInt(w, 16)), BigInt(0)) };
}

/** The first deny-list entry that holds this address, or null. */
export function deniedBy(address: string, cidrs: readonly string[]): string | null {
  const ip = ipValue(address.replace(/^\[|\]$/g, ""));
  if (!ip) return null;
  const width = ip.v === 4 ? 32 : 128;
  for (const entry of cidrs) {
    const [base, bitsText] = entry.split("/");
    const net = ipValue(base);
    if (!net || net.v !== ip.v) continue;
    const bits = bitsText === undefined ? width : Number(bitsText);
    const shift = BigInt(width - bits);
    if (ip.n >> shift === net.n >> shift) return entry;
  }
  return null;
}

/**
 * Why a microsandbox sandbox could not download the data room's file links, or null. `addresses` are what the
 * storage origin's host resolves to (the host itself when it is an IP literal).
 */
export function storageReachConflict(env: Env, addresses: readonly string[]): string | null {
  const storage = sandboxStorageOrigin(env);
  if (!storage) return null;
  const deny = sandboxDenySubnets(env);
  for (const address of addresses) {
    const entry = deniedBy(address, deny);
    if (entry) {
      return (
        `The data room's file links point at ${storage.origin} (${storage.setting}, STORAGE_DRIVER=filesystem), which is ` +
        `${address === storage.host ? "" : `${address}, `}inside the sandbox deny list (${entry}). A sandbox could not download them ` +
        "(dataroom_fetch_to_sandbox would fail). Point it at the web app's public address and leave that address out of " +
        "SANDBOX_DENY_SUBNETS, or use the s3 storage driver. See docs/self-hosting/SANDBOX.md."
      );
    }
  }
  return null;
}

/** What eve's `microsandbox()` factory is given. The shape is eve's own `MicrosandboxSandboxCreateOptions`. */
export interface MicrosandboxSettings {
  readonly cpus: number;
  readonly memoryMiB: number;
  /** eve's `networkPolicy`: everything allowed except the denied subnets. */
  readonly networkPolicy: { readonly allow: string[]; readonly subnets: { readonly deny: string[] } };
  /** A production process must not download a runtime; a missing one is an error to fix on the host. */
  readonly setup: { readonly autoInstall: false };
}

/**
 * The options for eve's `microsandbox()` when this deployment selects it, or NULL when it does not (unset or
 * "vercel"): the caller then adds no `backend` to its sandbox definition, which is today's behaviour.
 */
export function microsandboxSettings(env: Env = process.env): MicrosandboxSettings | null {
  if (sandboxBackendSetting(env) !== "microsandbox") return null;
  // An IP-literal storage origin is checked here, at build; a name is resolved and checked by sandbox:prewarm.
  const storage = sandboxStorageOrigin(env);
  const conflict = storage ? storageReachConflict(env, [storage.host]) : null;
  if (conflict) throw new Error(conflict);
  return {
    cpus: wholeNumber(env, "SANDBOX_CPUS", SANDBOX_DEFAULT_CPUS, 1, 64),
    memoryMiB: wholeNumber(env, "SANDBOX_MEMORY_MIB", SANDBOX_DEFAULT_MEMORY_MIB, 256, 262_144),
    networkPolicy: { allow: ["*"], subnets: { deny: sandboxDenySubnets(env) } },
    setup: { autoInstall: false },
  };
}

/** The placeholder agent/subagents/research/prompt.md writes where the formatter's path goes. */
export const FMT_XLSX_PLACEHOLDER = "{fmt_xlsx}";

/**
 * Where the research sandbox's workbook formatter lives, as the model is told to call it.
 *
 *   vercel         `/root/fmt_xlsx.py` — where it has always been written; unchanged.
 *   microsandbox   `"$HOME/fmt_xlsx.py"` — the sandbox user there is `vercel-sandbox`, not root, and cannot write
 *                  under /root. Written with the variable (and its quotes) so it holds whatever that user's home is.
 */
export function fmtXlsxPath(env: Env = process.env): string {
  return sandboxBackendSetting(env) === "microsandbox" ? '"$HOME/fmt_xlsx.py"' : "/root/fmt_xlsx.py";
}

/** A prompt with the formatter's path filled in. */
export function withFmtXlsxPath(prompt: string, env: Env = process.env): string {
  return prompt.replaceAll(FMT_XLSX_PLACEHOLDER, fmtXlsxPath(env));
}

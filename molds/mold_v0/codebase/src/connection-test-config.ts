/**
 * A record page's "Test connection" (mold_v0-312; the page action `test_connection`, src/connection-test.ts runs it):
 * a workspace's own connection record (an account at a compute provider, a network, a database or another system of
 * record) is checked by one HTTPS call its pack declares, with the record's own fields, on the server. Pack config
 * only, checked here for gen-packs and the server's install alike (src/pack-api.ts actionProblems).
 *
 *   "actions": [{ "kind": "test_connection", "place": "primary", "label": "Test connection", "probe": {
 *     "by": "provider",                         an enum field of the record: which probe its value calls ("*": any other)
 *     "probes": { "<value>": {
 *       "label": "the account's API",           what the answer calls it ("It works: the account's API at ... answered")
 *       "method": "GET" | "HEAD" | "POST",
 *       "url": "https://api.example.com/v1/accounts/{account_id}",
 *                                               https only; {field} is a plain field of the record (its value is
 *                                               escaped for the address; a {field} that starts the address is a url
 *                                               field and gives the address itself)
 *       "headers": { "Authorization": "Bearer {api_token}" },
 *                                               the only place an encrypted (sealed) field may be used
 *       "body": { "query": "{database}" },      POST only: JSON, its strings templates of plain fields
 *       "expect": { "status": "2xx" | [200, 204], "json_path": "data.account.state", "equals": "active" },
 *       "timeout_seconds": 10 },                1 to 15 (default 10)
 *     },
 *     "status": "status",                       an enum (options working and failing) or text field, set_by "action"
 *     "tested": "last_tested" }}]               a date field, set_by "action"
 *
 * mold_v0-313: a probe that needs more than a header names its `kind` (the HTTP probe above is the default, "http").
 * Each kind's call, hosts and signing are the kind's own (src/connection-test.ts); the pack names only which of the
 * record's fields fill its roles (`fields`), and the build checks which roles must be, may be or never are encrypted:
 *
 *   aws_sigv4                  SigV4-signed; `check` (mold_v0-319) picks one fixed, read-only call:
 *     "identity" (default)      STS GetCallerIdentity at sts.amazonaws.com (or sts.<region>.amazonaws.com)
 *     "ebs_volume"              EC2 DescribeVolumes (VolumeId.1) at ec2.<region>.amazonaws.com
 *     "efs_file_system"         EFS DescribeFileSystems (FileSystemId) at elasticfilesystem.<region>.amazonaws.com
 *     "s3_bucket"               S3 HeadBucket, path-style, at s3.<region>.amazonaws.com/<bucket>
 *     fields: access_key_id (plain or sealed), secret_access_key (sealed), session_token? (sealed), region? (plain;
 *     decides the host); region?: a fixed region instead of a field (a resource check needs one or the other);
 *     volume_id / file_system_id / bucket (plain): the resource of its check, a validated parameter, never in a host
 *   gcp_service_account        a service account's key file (sealed JSON): an RS256 assertion to oauth2.googleapis.com/token
 *     only (its token_uri must be exactly that), a token, then by `check`: "project" (default) its project read at
 *     cloudresourcemanager.googleapis.com; "token" stops at the token; "compute_disk" (mold_v0-319) GET
 *     compute.googleapis.com/compute/v1/projects/{project}/zones/{zone}/disks/{disk}; "filestore_instance" GET
 *     file.googleapis.com/v1/projects/{project}/locations/{location}/instances/{instance}
 *     fields: service_account_json (sealed); project? (plain; default the key file's project_id), zone + disk,
 *     location + instance (plain): each one path segment checked against Google's naming rules
 *   azure_client_credentials   login.microsoftonline.com/<tenant>/oauth2/v2.0/token (client credentials, the management
 *     scope), then by `check` one read-only GET at management.azure.com: "subscription" (default) the subscription (or
 *     the list); "storage_account" (mold_v0-319) .../resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{name};
 *     "file_share" .../storageAccounts/{name}/fileServices/default/shares/{share}
 *     fields: tenant_id (plain; decides where the secret goes), client_id (plain), client_secret (sealed), subscription_id?
 *     (plain; required by a resource check), resource_group, storage_account, file_share (plain)
 *   postgres                   TLS only (the certificate checked against the host's name), SELECT 1 in a read-only
 *     transaction with a 10 s statement timeout; hosts (required) and ports (default [5432]) bound where it connects;
 *     ca? (mold_v0-319): a managed provider's public CA bundle shipped in the mold, by name ("aws-rds", "azure"),
 *     trusted besides the bundled and system stores, its hosts under that provider's database zone
 *     fields: url (sealed: postgres://user:password@host:port/db) or host + port? + database? (plain; host and port
 *     decide where the password goes) + user (plain or sealed) + password (sealed)
 *
 * The area is a workspace area written by hand (not a repository's), its contract reveals nothing (`reveal: {none}`):
 * a secret is typed once and never shown again, opened only by the test on the server, never returned or logged.
 */
import { z } from "zod";

export const PROBE_METHODS = ["GET", "HEAD", "POST"] as const;
export const PROBE_TIMEOUT_MAX = 15;
export const PROBE_TIMEOUT_DEFAULT = 10;
export const PROBES_MAX = 12;
export const PROBE_HEADERS_MAX = 8;
/** The probe used when the record's `by` value has none of its own (or when there is no `by`). */
export const ANY_PROBE = "*";
/** A {field} placeholder in a probe's template. */
export const PLACEHOLDER = /\{([a-z][a-z0-9_]{1,62})\}/g;
/** The headers a pack never sets: the connection's own (the server sets them), or a browser's. */
const RESERVED_HEADERS = ["host", "content-length", "transfer-encoding", "connection", "cookie", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization", "expect"];

const template = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/, "one line, no control characters");
const fieldName = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a field's name");
const statusCode = z.number().int().min(200, "a status the test counts as working is 200 to 299").max(299, "a status the test counts as working is 200 to 299");

const probeLabel = z.string().trim().min(1).max(60).regex(/^[^\n\r{}<>]*$/, "plain text on one line").optional();
const probeTimeout = z.number().int().min(1).max(PROBE_TIMEOUT_MAX, `a test waits at most ${PROBE_TIMEOUT_MAX} seconds`).optional();
const hostList = z.array(z.string().regex(/^(\*\.)?(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a host's name (api.example.com, or *.example.com)")).min(1).max(10);

/** The probe of mold_v0-312: one HTTPS call, a secret only in a header (kind "http", the default). */
export const HttpProbeSchema = z.object({
  kind: z.literal("http").optional(),
  label: probeLabel,
  method: z.enum(PROBE_METHODS, { error: () => `a probe's method is ${PROBE_METHODS.join(", ")}` }),
  url: template(2000),
  headers: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, "a header's name: letters, digits and -"), template(2000))
    .refine((h) => Object.keys(h).length <= PROBE_HEADERS_MAX, `at most ${PROBE_HEADERS_MAX} headers`).optional(),
  body: z.unknown().optional(),
  expect: z.object({
    status: z.union([z.literal("2xx"), z.array(statusCode).min(1).max(10)]).optional(),
    json_path: z.string().regex(/^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,9}$/, "a path into the JSON answer: names and list positions joined by dots (data.items.0.id)").optional(),
    equals: z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]).optional(),
  }).strict().optional(),
  timeout_seconds: probeTimeout,
  /**
   * mold_v0-312: the hosts the call may reach (a name allows itself only; "*.x" is x and its subdomains),
   * on every hop, redirects included. Required when the record decides the host (the address starts with a url field,
   * or a {field} is its first label); otherwise the address's own host is the list, with these besides.
   */
  hosts: hostList.optional(),
}).strict();
export type HttpProbe = z.output<typeof HttpProbeSchema>;

// ---------------------------------------------------------------- mold_v0-313: the signed kinds

/** An AWS region's name (eu-west-1, us-gov-west-1, ap-southeast-4): it is a label of STS's host. */
export const AWS_REGION = /^[a-z]{2}(-[a-z]+){1,2}-\d{1,2}$/;
/** mold_v0-319: China (another endpoint domain) and GovCloud (other CAs, other partitions): refused in words for now. */
export const AWS_REGION_UNCOVERED = /^(cn|us-gov)-/;
/**
 * mold_v0-319: each signed kind's checks (fixed, read-only calls; never an action name from config) and the roles
 * naming the resource each one reads (required by it, refused on any other check).
 */
export const AWS_CHECKS = ["identity", "ebs_volume", "efs_file_system", "s3_bucket"] as const;
export const GCP_CHECKS = ["project", "token", "compute_disk", "filestore_instance"] as const;
export const AZURE_CHECKS = ["subscription", "storage_account", "file_share"] as const;
export const CHECK_ROLES: Record<string, readonly string[]> = {
  identity: [], ebs_volume: ["volume_id"], efs_file_system: ["file_system_id"], s3_bucket: ["bucket"],
  project: [], token: [], compute_disk: ["zone", "disk"], filestore_instance: ["location", "instance"],
  subscription: [], storage_account: ["resource_group", "storage_account"], file_share: ["resource_group", "storage_account", "file_share"],
};
/** The roles that name a resource (any check's): a field filling one is refused on a check that does not read it. */
const RESOURCE_ROLES = new Set(Object.values(CHECK_ROLES).flat());
/** The check a probe makes (its kind's default when it names none). */
export const probeCheck = (p: SignedProbe): string | null =>
  p.kind === "aws_sigv4" ? (p.check ?? "identity") : p.kind === "gcp_service_account" ? (p.check ?? "project") : p.kind === "azure_client_credentials" ? (p.check ?? "subscription") : null;
/** Whether a probe's check reads one resource (a volume, a bucket, a disk, a share), not the account alone. */
export const resourceCheck = (p: SignedProbe) => (CHECK_ROLES[probeCheck(p) ?? ""] ?? []).length > 0;

export const AwsSigv4ProbeSchema = z.object({
  kind: z.literal("aws_sigv4"),
  label: probeLabel,
  fields: z.object({ access_key_id: fieldName.optional(), secret_access_key: fieldName.optional(), session_token: fieldName.optional(), region: fieldName.optional(),
    volume_id: fieldName.optional(), file_system_id: fieldName.optional(), bucket: fieldName.optional() }).strict(),
  /** A fixed region (its regional host) when no field names one; neither: the global sts.amazonaws.com (identity only). */
  region: z.string().regex(AWS_REGION, "an AWS region's name (eu-west-1)").optional(),
  /** mold_v0-319: "identity" (default, STS), "ebs_volume", "efs_file_system", "s3_bucket". */
  check: z.enum(AWS_CHECKS, { error: () => `an aws_sigv4 probe's check is ${AWS_CHECKS.join(", ")}` }).optional(),
  timeout_seconds: probeTimeout,
}).strict();
export const GcpServiceAccountProbeSchema = z.object({
  kind: z.literal("gcp_service_account"),
  label: probeLabel,
  fields: z.object({ service_account_json: fieldName.optional(), project: fieldName.optional(), zone: fieldName.optional(), disk: fieldName.optional(),
    location: fieldName.optional(), instance: fieldName.optional() }).strict(),
  /**
   * "project" (default): the token, then the key file's project read; "token": the token alone; mold_v0-319:
   * "compute_disk", "filestore_instance": one resource read.
   */
  check: z.enum(GCP_CHECKS, { error: () => `a gcp_service_account probe's check is ${GCP_CHECKS.join(", ")}` }).optional(),
  timeout_seconds: probeTimeout,
}).strict();
export const AzureClientCredentialsProbeSchema = z.object({
  kind: z.literal("azure_client_credentials"),
  label: probeLabel,
  fields: z.object({ tenant_id: fieldName.optional(), client_id: fieldName.optional(), client_secret: fieldName.optional(), subscription_id: fieldName.optional(),
    resource_group: fieldName.optional(), storage_account: fieldName.optional(), file_share: fieldName.optional() }).strict(),
  /** "subscription" (default): the subscription (or the list); mold_v0-319: "storage_account", "file_share". */
  check: z.enum(AZURE_CHECKS, { error: () => `an azure_client_credentials probe's check is ${AZURE_CHECKS.join(", ")}` }).optional(),
  timeout_seconds: probeTimeout,
}).strict();
export const POSTGRES_DEFAULT_PORT = 5432;
/**
 * mold_v0-319: the managed providers' public CA bundles the mold ships (src/ca/<name>.pem, read by
 * src/connection-test-signed.ts), and the database zones each one signs for: a probe naming one lists hosts under them.
 */
export const PG_CA_BUNDLES = ["aws-rds", "azure"] as const;
export type PgCaBundle = (typeof PG_CA_BUNDLES)[number];
export const PG_CA_ZONES: Record<PgCaBundle, readonly string[]> = {
  "aws-rds": ["rds.amazonaws.com"],
  azure: ["postgres.database.azure.com", "postgres.cosmos.azure.com"],
};
export const PostgresProbeSchema = z.object({
  kind: z.literal("postgres"),
  label: probeLabel,
  fields: z.object({ url: fieldName.optional(), host: fieldName.optional(), port: fieldName.optional(), database: fieldName.optional(), user: fieldName.optional(), password: fieldName.optional() }).strict(),
  /** The hosts the database may be at (required: the record decides the host). */
  hosts: hostList,
  /** The ports it may listen on (default [5432]). */
  ports: z.array(z.number().int().min(1024, "a database's port is 1024 to 65535").max(65535, "a database's port is 1024 to 65535")).min(1).max(5).optional(),
  /**
   * mold_v0-319: a managed provider's public CA bundle, shipped in the mold (src/ca/), trusted besides the bundled and
   * system stores: by name only, never a certificate from a record or the pack.
   */
  ca: z.enum(PG_CA_BUNDLES, { error: () => `a postgres probe's ca is a bundle the mold ships: ${PG_CA_BUNDLES.join(", ")}` }).optional(),
  timeout_seconds: probeTimeout,
}).strict();

export const PROBE_KINDS = ["http", "aws_sigv4", "gcp_service_account", "azure_client_credentials", "postgres"] as const;
export const ConnectionProbeSchema = z.discriminatedUnion("kind", [HttpProbeSchema, AwsSigv4ProbeSchema, GcpServiceAccountProbeSchema, AzureClientCredentialsProbeSchema, PostgresProbeSchema],
  { error: (i) => (i.code === "invalid_union" ? `a probe's kind is ${PROBE_KINDS.join(", ")} (none: http)` : undefined) });
export type ConnectionProbe = z.output<typeof ConnectionProbeSchema>;
export type SignedProbe = Exclude<ConnectionProbe, HttpProbe>;
export const isHttpProbe = (p: ConnectionProbe): p is HttpProbe => p.kind === undefined || p.kind === "http";

/**
 * Each signed kind's roles: whether the field filling it must be encrypted ("sealed"), may be ("either") or never is
 * ("plain"), whether a record must fill it, and whether it decides where the secrets go (bound to them:
 * src/secret-binding.ts).
 */
type Role = { seal: "sealed" | "either" | "plain"; required?: boolean; decides?: boolean; types?: readonly string[] };
const PLAIN_TEXT = ["text", "enum"];
export const KIND_ROLES: Record<SignedProbe["kind"], Record<string, Role>> = {
  aws_sigv4: { access_key_id: { seal: "either", required: true, decides: true }, secret_access_key: { seal: "sealed", required: true }, session_token: { seal: "sealed" },
    region: { seal: "plain", decides: true, types: PLAIN_TEXT },
    // mold_v0-319: the resource a check reads (bound to the keys: which resource is tested is not a reader's to change).
    volume_id: { seal: "plain", decides: true, types: PLAIN_TEXT }, file_system_id: { seal: "plain", decides: true, types: PLAIN_TEXT },
    bucket: { seal: "plain", decides: true, types: PLAIN_TEXT } },
  gcp_service_account: { service_account_json: { seal: "sealed", required: true },
    project: { seal: "plain", decides: true, types: PLAIN_TEXT }, zone: { seal: "plain", decides: true, types: PLAIN_TEXT }, disk: { seal: "plain", decides: true, types: PLAIN_TEXT },
    location: { seal: "plain", decides: true, types: PLAIN_TEXT }, instance: { seal: "plain", decides: true, types: PLAIN_TEXT } },
  azure_client_credentials: { tenant_id: { seal: "plain", required: true, decides: true, types: PLAIN_TEXT }, client_id: { seal: "plain", required: true, decides: true, types: PLAIN_TEXT },
    client_secret: { seal: "sealed", required: true }, subscription_id: { seal: "plain", types: PLAIN_TEXT },
    resource_group: { seal: "plain", decides: true, types: PLAIN_TEXT }, storage_account: { seal: "plain", decides: true, types: PLAIN_TEXT },
    file_share: { seal: "plain", decides: true, types: PLAIN_TEXT } },
  postgres: { url: { seal: "sealed" }, host: { seal: "plain", decides: true, types: ["text", "url"] }, port: { seal: "plain", decides: true, types: ["number", "text", "enum"] },
    database: { seal: "plain", types: PLAIN_TEXT }, user: { seal: "either" }, password: { seal: "sealed" } },
};
/**
 * The fixed hosts of the kinds whose host is the kind's (postgres's are its `hosts`): per check, only the host its
 * call needs (mold_v0-319). AWS's resource checks are regional (the region a validated label, the only record value in
 * a host); S3 is path-style, so a bucket's name is never a host.
 */
const AWS_SERVICE_HOST: Record<(typeof AWS_CHECKS)[number], string> = { identity: "sts", ebs_volume: "ec2", efs_file_system: "elasticfilesystem", s3_bucket: "s3" };
export const KIND_HOSTS = {
  aws_sigv4: (region: string | null, check: (typeof AWS_CHECKS)[number] = "identity") =>
    [check === "identity" && !region ? "sts.amazonaws.com" : `${AWS_SERVICE_HOST[check]}.${region}.amazonaws.com`],
  gcp_service_account: (check: (typeof GCP_CHECKS)[number] = "project") => ["oauth2.googleapis.com",
    ...(check === "project" ? ["cloudresourcemanager.googleapis.com"] : check === "compute_disk" ? ["compute.googleapis.com"] : check === "filestore_instance" ? ["file.googleapis.com"] : [])],
  azure_client_credentials: () => ["login.microsoftonline.com", "management.azure.com"],
} as const;
/** The one address a service account's key file may name as its token_uri: its signed assertion goes there only. */
export const GCP_TOKEN_URI = "https://oauth2.googleapis.com/token";
const roleFields = (p: SignedProbe) => Object.entries(p.fields as Record<string, string | undefined>).filter((e): e is [string, string] => typeof e[1] === "string");

export const ConnectionTestSchema = z.object({
  by: fieldName.optional(),
  probes: z.record(z.string().min(1).max(80), ConnectionProbeSchema)
    .refine((p) => Object.keys(p).length >= 1 && Object.keys(p).length <= PROBES_MAX, `1 to ${PROBES_MAX} probes`),
  status: fieldName.optional(),
  tested: fieldName.optional(),
}).strict();
export type ConnectionTest = z.output<typeof ConnectionTestSchema>;

/** The fields a template names, in order. */
export const placeholders = (t: string): string[] => [...t.matchAll(PLACEHOLDER)].map((m) => m[1]!);
/** Every string inside a JSON body (its templates). */
export function bodyStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) bodyStrings(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); bodyStrings(x, out); }
  return out;
}
/** Whether the address part before the first placeholder is the whole URL's start: "{endpoint}/v1/..." */
export const startsWithField = (url: string) => /^\{[a-z][a-z0-9_]{1,62}\}/.test(url);
/** The host part of a template (between "https://" and the next / ? #), or null when a field starts the address. */
const hostPart = (url: string) => (startsWithField(url) ? null : (/^https:\/\/([^/?#]*)/i.exec(url)?.[1] ?? null));
/**
 * The fields that decide where a probe's call goes: one that starts its address, or one in its host; a signed kind's
 * roles that decide (an AWS region, an Azure tenant, a database's host and port).
 */
export function destinationFields(p: ConnectionProbe): string[] {
  // mold_v0-319: on a resource check, the subscription that holds the resource decides too.
  if (!isHttpProbe(p)) return roleFields(p).filter(([r]) => KIND_ROLES[p.kind][r]?.decides || (r === "subscription_id" && resourceCheck(p))).map(([, f]) => f);
  if (startsWithField(p.url)) return [placeholders(p.url)[0]!];
  return placeholders(hostPart(p.url) ?? "");
}
/** The hosts an HTTP probe may reach: its declared ones, and its address's own host when the pack wrote it. */
export function probeHosts(p: HttpProbe): string[] {
  const h = hostPart(p.url);
  const own = h && !h.includes("{") ? [h.toLowerCase().replace(/:443$/, "")] : [];
  return [...own, ...(p.hosts ?? [])];
}
/**
 * Whether `host` is on a list: a listed name allows itself only; "*.x" allows x and its subdomains (mold_v0-313: a
 * bare name once allowed its subdomains too, so "rds.amazonaws.com" matched anyone's database).
 */
export function hostListed(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return list.some((raw) => {
    const r = raw.toLowerCase().replace(/\.$/, "");
    if (!r.startsWith("*.")) return h === r;
    const l = r.slice(2);
    return h === l || h.endsWith(`.${l}`);
  });
}
/** The fields whose secret a probe sends: encrypted fields named in an HTTP probe's headers, or in a signed kind's roles. */
export const probeSecrets = (p: ConnectionProbe, sealed: (n: string) => boolean): string[] =>
  isHttpProbe(p) ? [...new Set(Object.values(p.headers ?? {}).flatMap(placeholders).filter(sealed))] : [...new Set(roleFields(p).map(([, f]) => f).filter(sealed))];

/** A private, loopback or internal name a test never calls (src/connection-test.ts checks the addresses too). */
export const LOCAL_NAMES = ["localhost", "local", "internal", "localdomain", "home.arpa", "lan", "intranet", "corp"];
export const localName = (host: string) => {
  const h = host.toLowerCase().replace(/\.$/, "");
  return !h.includes(".") || LOCAL_NAMES.some((s) => h === s || h.endsWith(`.${s}`));
};
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

interface Field { name: string; label?: string; type?: string; encrypted?: boolean; multiple?: boolean; set_by?: string; options?: readonly (string | { value: string; label?: string })[] }
interface Area { name?: string; scope?: string; repository?: string; fields: readonly Field[]; contract?: { actions?: Record<string, unknown> }; lifecycle?: { field?: string } }

/**
 * Suffixes anyone can host a name under (a cloud's shared hosting, a managed database provider, a public suffix).
 * mold_v0-319 (fails closed): a wildcard at, above or ANYWHERE below one ("*.x" with x under it) is refused, unless the
 * zone's `own` count says how many labels below it are one customer's own (SHARED_ZONES); an exact host under one is fine.
 */
export const SHARED_SUFFIXES = ["amazonaws.com", "amazonaws.com.cn", "on.aws", "vercel.app", "workers.dev", "github.io", "herokuapp.com", "cloudfront.net", "azurewebsites.net",
  "appspot.com", "netlify.app", "pages.dev", "fly.dev", "onrender.com", "render.com", "web.app", "firebaseapp.com", "run.app", "azurestaticapps.net",
  "blob.core.windows.net", "windows.net", "azure.com", "azure.net", "cloudapp.net", "azurecr.io", "azurefd.net", "trafficmanager.net",
  "trycloudflare.com", "ngrok.io", "ngrok.app", "ngrok-free.app", "glitch.me", "repl.co", "surge.sh", "vercel.sh", "deno.dev", "railway.app", "up.railway.app",
  "neon.tech", "supabase.co", "supabase.com", "ondigitalocean.com", "digitaloceanspaces.com", "aivencloud.com", "elasticbeanstalk.com", "cloudflarestorage.com",
  "co.uk", "com.au", "co.jp", "com.br", "co.in", "co.za", "com.cn", "org.uk", "gov.uk", "ac.uk"];
/**
 * mold_v0-319: the zones whose labels below are known to be one customer's own, and how many (the most specific zone a
 * name is under decides; every other shared suffix allows exact hosts only).
 *   rds / redshift   <instance>.<id>.<region>.rds.amazonaws.com: <id> is one account's per region, so
 *                    "*.<id>.<region>.rds.amazonaws.com" is one account's, "*.<region>.rds.amazonaws.com" everyone's
 *   azure databases  <server>.postgres.database.azure.com: the server's name is global and one customer's
 *   cloudapp.azure   <name>.<region>.cloudapp.azure.com
 *   supabase.co      <ref>.supabase.co and db.<ref>.supabase.co: one project's
 *   public suffixes  <name>.co.uk is a registrable domain, one registrant's
 *   hosting          <project>.vercel.app, <user>.github.io, <app>.herokuapp.com, <site>.netlify.app, <project>.pages.dev,
 *                    <app>.fly.dev, <account>.workers.dev, <site>.web.app / firebaseapp.com, <project>.appspot.com,
 *                    <app>.azurewebsites.net, <account>.blob.core.windows.net: the first label is one customer's name
 * Left exact-only (names below are anyone's, or the naming is not certain): amazonaws.com otherwise (EC2's compute,
 * ELB, S3, ...), on.aws (DSQL, Lambda URLs), neon.tech, supabase.com (its shared pooler), ondigitalocean.com, aivencloud.com,
 * render.com and onrender.com, run.app (a.run.app is shared), cloudapp.net, the tunnels, and the rest.
 */
export const SHARED_ZONES: readonly { zone: string; own: number }[] = [
  { zone: "rds.amazonaws.com", own: 2 }, { zone: "rds.amazonaws.com.cn", own: 2 }, { zone: "redshift.amazonaws.com", own: 2 },
  { zone: "redshift-serverless.amazonaws.com", own: 2 }, { zone: "postgres.database.azure.com", own: 1 }, { zone: "mysql.database.azure.com", own: 1 },
  { zone: "postgres.cosmos.azure.com", own: 2 }, { zone: "database.windows.net", own: 1 }, { zone: "cloudapp.azure.com", own: 2 },
  { zone: "supabase.co", own: 1 },
  ...["co.uk", "com.au", "co.jp", "com.br", "co.in", "co.za", "com.cn", "org.uk", "gov.uk", "ac.uk"].map((zone) => ({ zone, own: 1 })),
  ...["vercel.app", "github.io", "herokuapp.com", "netlify.app", "pages.dev", "fly.dev", "workers.dev", "web.app", "firebaseapp.com", "appspot.com",
    "azurewebsites.net", "blob.core.windows.net"].map((zone) => ({ zone, own: 1 })),
];
/** The labels of `name` below `zone` (0 at the zone, -1 above it), or null when it is elsewhere. */
const labelsBelow = (name: string, zone: string) =>
  name === zone ? 0 : name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1).split(".").length : zone.endsWith(`.${name}`) ? -1 : null;
/**
 * Whether a probe's `hosts` entry is shared with others: a bare top-level name; a wildcard at, above or below a shared
 * suffix, unless the most specific zone it is under grants that many labels as one customer's own (fails closed); a
 * bare name at or above a shared suffix, or above a zone's own labels ("eu-west-1.rds.amazonaws.com").
 */
export const sharedWildcard = (h: string) => {
  const wild = h.startsWith("*.");
  const base = (wild ? h.slice(2) : h).toLowerCase().replace(/\.$/, "");
  if (wild && !base.includes(".")) return true;
  const zones = [...SHARED_SUFFIXES.map((zone) => ({ zone, own: Infinity })), ...SHARED_ZONES];
  // At or above any shared name: everyone's.
  if (zones.some(({ zone }) => { const n = labelsBelow(base, zone); return n !== null && n <= 0; })) return true;
  // Below: the most specific zone decides (its own count; none known: exact hosts only).
  const under = zones.filter(({ zone }) => base.endsWith(`.${zone}`)).sort((x, y) => y.zone.length - x.zone.length || (x.own === Infinity ? 1 : -1));
  const z = under[0];
  if (!z) return false;
  const n = labelsBelow(base, z.zone)!;
  return wild ? n < z.own : Number.isFinite(z.own) && n < z.own;
};
const values = (f: Field) => (f.options ?? []).map((o) => (typeof o === "string" ? o : o.value));

/**
 * What is wrong with a test_connection action's probe on `area` (each with its path under the action): the fields its
 * templates name exist (encrypted ones in headers only), https only, sane statuses, a workspace area written by hand
 * whose contract reveals nothing, and a status and tested field only the app's actions set.
 */
export function connectionTestProblems(area: Area, raw: unknown): { message: string; path: (string | number)[] }[] {
  const out: { message: string; path: (string | number)[] }[] = [];
  const bad = (message: string, ...path: (string | number)[]) => out.push({ message, path: ["probe", ...path] });
  const r = ConnectionTestSchema.safeParse(raw);
  if (!r.success) { for (const e of r.error.issues) bad(e.message, ...(e.path as (string | number)[])); return out; }
  const t = r.data;
  const field = (n: string) => area.fields.find((f) => f.name === n);
  if (area.scope !== "workspace") bad("a connection is a workspace's own record: test_connection is for a workspace area", "kind");
  if (area.repository !== undefined) bad(`${area.name ?? "the area"}'s records come from its repository: a connection is added by the workspace's people`, "kind");
  const reveal = area.contract?.actions?.reveal as { none?: unknown } | undefined;
  if (!reveal || typeof reveal !== "object" || Array.isArray(reveal) || typeof reveal.none !== "string")
    bad(`${area.name ?? "the area"}'s contract reveals nothing (contract.actions.reveal {"none": "<why>"}): a connection's secrets are never shown again once saved`, "kind");
  if (t.by !== undefined) {
    const f = field(t.by);
    if (!f) bad(`${t.by} is not one of the area's fields`, "by");
    else if (f.type !== "enum" || f.multiple || f.encrypted) bad(`${t.by} is not a plain single-choice enum field: by chooses a probe by the record's value`, "by");
    else for (const k of Object.keys(t.probes)) if (k !== ANY_PROBE && !values(f).includes(k)) bad(`${k} is not one of ${t.by}'s options (${values(f).join(", ")}) or "${ANY_PROBE}"`, "probes", k);
  } else if (Object.keys(t.probes).some((k) => k !== ANY_PROBE)) bad(`without by, the one probe is "${ANY_PROBE}"`, "probes");
  const setByAction = (k: "status" | "tested", n: string, check: (f: Field) => string | null) => {
    const f = field(n);
    if (!f) return bad(`${n} is not one of the area's fields`, k);
    if (f.encrypted) return bad(`${n} is encrypted: the test writes a plain field`, k);
    if (f.set_by !== "action") return bad(`${n} is written by the test only: declare it set_by "action" (a person never sets it by hand)`, k);
    const why = check(f);
    if (why) bad(`${n} ${why}`, k);
  };
  if (t.status) setByAction("status", t.status, (f) => !["text", "enum"].includes(f.type ?? "text") ? "is a text or enum field"
    : f.type === "enum" && !(values(f).includes("working") && values(f).includes("failing")) ? "is an enum with the options working and failing (what the test writes)" : null);
  if (t.tested) setByAction("tested", t.tested, (f) => (f.type !== "date" ? "is a date field" : null));
  const plainUse = (n: string, where: string, ...path: (string | number)[]) => {
    const f = field(n);
    if (!f) return bad(`{${n}} is not one of the area's fields`, ...path);
    if (f.encrypted) return bad(`{${n}} is encrypted: a secret goes only in a header, never in ${where}`, ...path);
    if (["file", "json", "person"].includes(f.type ?? "text") || f.multiple) bad(`{${n}} is a ${f.multiple ? "list" : `${f.type} field`}: a template takes one plain value`, ...path);
  };
  // A lifecycle's move changes its field without the write's checks (src/secret-binding.ts): it never decides a destination.
  const lc = area.lifecycle?.field;
  if (lc && t.by === lc) bad(`${lc} is the lifecycle's field: a move would change which probe runs without the secret's binding; by names another field`, "by");
  for (const [k, p] of Object.entries(t.probes)) if (lc && destinationFields(p).includes(lc)) bad(`{${lc}} is the lifecycle's field: it never decides where a secret goes`, "probes", k, "url");
  for (const [k, p] of Object.entries(t.probes)) {
    if (!isHttpProbe(p)) { signedProblems(p, field, (m, ...path) => bad(m, "probes", k, ...path)); continue; }
    // The address: https, a host that is not an address or an internal name; {field} only for plain fields.
    const names = placeholders(p.url);
    for (const n of names) plainUse(n, "the address", "probes", k, "url");
    if (startsWithField(p.url)) {
      const f = field(names[0]!);
      if (f && f.type !== "url") bad(`{${names[0]}} starts the address: it is a url field (an https address the record holds)`, "probes", k, "url");
      if (!p.hosts) bad(`{${names[0]}} starts the address, so the record decides the host: list the hosts it may be (hosts: ["api.example.com", "*.example.net"])`, "probes", k, "hosts");
    } else {
      let u: URL | null = null;
      try { u = new URL(p.url.replace(PLACEHOLDER, "x")); } catch { bad("not a web address (https://host/path, {field} for a value of the record)", "probes", k, "url"); }
      if (u) {
        if (u.protocol !== "https:") bad("a test calls https:// addresses only", "probes", k, "url");
        if (u.username || u.password) bad("an address never carries a user or password: put a secret in a header", "probes", k, "url");
        const host = new URL(p.url.replace(PLACEHOLDER, "x")).hostname;
        if (/\{/.test(p.url.split("/")[2] ?? "") && !/^\{[a-z0-9_]+\}\.[a-z0-9.-]+$/i.test(p.url.split("/")[2] ?? ""))
          bad("a {field} in the host names only its first label ({account}.api.example.com): the rest of the host is the pack's", "probes", k, "url");
        if (IP_LITERAL.test(host) || localName(host)) bad(`${host} is an address or an internal name: a test calls a public host by its name`, "probes", k, "url");
        if (u.port && u.port !== "443") bad("a test calls port 443 only", "probes", k, "url");
        if (/\{/.test(hostPart(p.url) ?? "") && !p.hosts) bad("a {field} in the host lets the record decide it: list the hosts it may be (hosts)", "probes", k, "hosts");
      }
    }
    for (const h of p.hosts ?? []) if (localName(h.replace(/^\*\./, ""))) bad(`${h} is an internal name: a test calls public hosts only`, "probes", k, "hosts");
    for (const h of p.hosts ?? []) if (sharedWildcard(h)) bad(h.startsWith("*.") ? `${h} is a wildcard over a name anyone can host under: list the exact host (my-db.${h.slice(2)})` : `${h} is a name anyone can host under: list the exact host (my-db.${h})`, "probes", k, "hosts");
    for (const [h, v] of Object.entries(p.headers ?? {})) {
      if (RESERVED_HEADERS.includes(h.toLowerCase())) bad(`${h} is set by the connection itself: a probe never sets it`, "probes", k, "headers", h);
      for (const n of placeholders(v)) {
        const f = field(n);
        if (!f) bad(`{${n}} is not one of the area's fields`, "probes", k, "headers", h);
        else if (["file", "json", "person"].includes(f.type ?? "text") || f.multiple) bad(`{${n}} is a ${f.multiple ? "list" : `${f.type} field`}: a header takes one plain value`, "probes", k, "headers", h);
      }
    }
    if (p.body !== undefined) {
      if (p.method !== "POST") bad(`a ${p.method} sends no body`, "probes", k, "body");
      let text = "";
      try { text = JSON.stringify(p.body) ?? ""; } catch { /* not JSON */ }
      if (!text) bad("a body is JSON", "probes", k, "body");
      else if (text.length > 4000) bad("a body is at most 4000 characters of JSON", "probes", k, "body");
      for (const s of bodyStrings(p.body)) for (const n of placeholders(s)) plainUse(n, "a body", "probes", k, "body");
    }
    if (p.expect?.equals !== undefined && !p.expect.json_path) bad("equals compares the value at json_path: name it", "probes", k, "expect", "equals");
    if (p.expect?.json_path && p.method === "HEAD") bad("a HEAD's answer has no body: json_path is for a GET or a POST", "probes", k, "expect", "json_path");
  }
  return out;
}

/**
 * mold_v0-313: a signed kind's roles: each names one of the area's fields holding one value, encrypted where the role
 * holds a secret and never where it decides where they go; the kind's required roles named; postgres a url or a host
 * with a user and password (never both ways), its hosts public names.
 */
function signedProblems(p: SignedProbe, field: (n: string) => Field | undefined, bad: (m: string, ...path: (string | number)[]) => void) {
  const roles = KIND_ROLES[p.kind];
  const named = p.fields as Record<string, string | undefined>;
  for (const [role, r] of Object.entries(roles)) {
    const n = named[role];
    if (n === undefined) { if (r.required) bad(`a ${p.kind} probe names the field holding its ${role.replace(/_/g, " ")} (fields.${role})`, "fields", role); continue; }
    const f = field(n);
    if (!f) { bad(`${n} is not one of the area's fields`, "fields", role); continue; }
    if (["file", "json", "person", "reference", "repository", "database", "link"].includes(f.type ?? "text") || f.multiple) bad(`${n} is a ${f.multiple ? "list" : `${f.type} field`}: a ${role.replace(/_/g, " ")} is one plain value`, "fields", role);
    else if (r.types && !f.encrypted && !r.types.includes(f.type ?? "text")) bad(`${n} is a ${f.type ?? "text"} field: a ${role.replace(/_/g, " ")} is a ${r.types.join(" or ")} field`, "fields", role);
    if (r.seal === "sealed" && !f.encrypted) bad(`${n} holds a secret: declare it encrypted (a ${p.kind} probe's ${role.replace(/_/g, " ")} is typed once and never shown again)`, "fields", role);
    if (r.seal === "plain" && f.encrypted) bad(`${n} is encrypted: a ${role.replace(/_/g, " ")} decides or names where the secrets go, so it is a plain field`, "fields", role);
  }
  const seen = new Map<string, string>();
  for (const [role, n] of Object.entries(named)) if (n !== undefined) {
    if (seen.has(n)) bad(`${n} fills both ${seen.get(n)} and ${role}: each role is its own field`, "fields", role);
    seen.set(n, role);
  }
  if (p.kind === "aws_sigv4" && p.region && named.region) bad("a fixed region or a region field, not both", "region");
  if (p.kind === "aws_sigv4" && p.region && AWS_REGION_UNCOVERED.test(p.region)) bad(`${p.region} is an AWS China or GovCloud region: this test does not cover those yet`, "region");
  // mold_v0-319: a check's resource roles are required, every other check's refused; a regional check has a region.
  const check = probeCheck(p);
  if (check !== null) {
    const mine = CHECK_ROLES[check] ?? [];
    for (const role of mine) if (named[role] === undefined) bad(`a ${p.kind} probe with check "${check}" names the field holding its ${role.replace(/_/g, " ")} (fields.${role})`, "fields", role);
    for (const role of Object.keys(named)) if (named[role] !== undefined && RESOURCE_ROLES.has(role) && !mine.includes(role))
      bad(`fields.${role} is read by another check than "${check}": name it only on a check that reads it`, "fields", role);
    if (p.kind === "aws_sigv4" && check !== "identity" && !p.region && !named.region) bad(`check "${check}" calls a regional endpoint: name a region field (fields.region) or a fixed region`, "region");
    if (p.kind === "azure_client_credentials" && check !== "subscription" && !named.subscription_id) bad(`check "${check}" reads a resource in one subscription: name the field holding it (fields.subscription_id)`, "fields", "subscription_id");
    if (p.kind === "gcp_service_account" && check === "token" && named.project) bad(`check "token" reads no project: fields.project is for project, compute_disk or filestore_instance`, "fields", "project");
  }
  if (p.kind === "postgres") {
    const pg = named;
    if (pg.url && (pg.host || pg.port || pg.database || pg.user || pg.password)) bad("a postgres probe takes its connection from a sealed url, or from host, user and password: not both", "fields");
    if (!pg.url && !(pg.host && pg.user && pg.password)) bad("a postgres probe names a sealed url field, or host, user and password fields", "fields");
    for (const h of p.hosts) if (localName(h.replace(/^\*\./, ""))) bad(`${h} is an internal name: a test calls public hosts only`, "hosts");
    for (const h of p.hosts) if (sharedWildcard(h)) bad(h.startsWith("*.") ? `${h} is a wildcard over a name anyone can host under: list the exact host (my-db.${h.slice(2)})` : `${h} is a name anyone can host under: list the exact host (my-db.${h})`, "hosts");
    // mold_v0-319: a provider's CA signs that provider's database names only: its hosts are under its zones.
    if (p.ca) for (const h of p.hosts) {
      const base = h.replace(/^\*\./, "").toLowerCase();
      if (!PG_CA_ZONES[p.ca].some((z) => base.endsWith(`.${z}`)))
        bad(`${h} is not a ${p.ca} database's name: with ca "${p.ca}" every host is under ${PG_CA_ZONES[p.ca].join(" or ")}`, "hosts");
    }
  }
}

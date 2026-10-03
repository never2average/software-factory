/**
 * The S3 driver: the file store as a bucket on any S3-compatible service (`STORAGE_DRIVER=s3`): DigitalOcean Spaces,
 * MinIO, AWS itself.
 *
 * No SDK. The whole surface is six requests (PUT, GET, HEAD, DELETE on an object, ListObjectsV2 on the bucket, and a
 * presigned GET), signed with AWS Signature Version 4 over `fetch` and `node:crypto`. The signer is held to the
 * worked examples in the S3 documentation (scripts/test-storage-drivers.mjs), so it is checked against Amazon's
 * numbers, not against itself.
 *
 * The bucket is PRIVATE: nothing is readable without a signature. A signed link is a presigned GET for one key, with
 * an expiry (S3 allows at most seven days, which is exactly the lifetime of a published artifact's link).
 *
 * `allowOverwrite: false` is sent as `If-None-Match: *`. A service that does not implement conditional writes
 * ignores it; the keys written that way (append parts, suffixed artifacts) are unique by construction, so the header
 * is a second guard, not the only one.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { assertStorageKey, isStorageKey, withSuffix } from "./keys.ts";
import type { S3Settings } from "./settings.ts";
import type { StorageDriver, StorageListPage, StorageUrlRules } from "./types.ts";

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 percent-encoding, as Signature V4 requires (encodeURIComponent leaves `!'()*` bare). */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const encodePath = (path: string) => path.split("/").map(encodeRfc3986).join("/");

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .map((name) => [encodeRfc3986(name), encodeRfc3986(query[name])] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** `20130524T000000Z` */
function amzDate(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface SigV4Input {
  method: string;
  /** The request path, NOT yet encoded: `/bucket/a file.txt`. */
  path: string;
  query?: Record<string, string>;
  /** Every header here is signed. Must include `host`. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  at: Date;
}

/** The signature and the pieces around it, for one request. Exported for the documentation's worked examples. */
export function sigV4(input: SigV4Input): { signature: string; signedHeaders: string; credential: string; scope: string } {
  const stamp = amzDate(input.at);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const names = Object.keys(input.headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const canonicalRequest = [
    input.method,
    encodePath(input.path),
    canonicalQuery(input.query ?? {}),
    ...names.map((name) => `${name}:${lower[name]}`),
    "",
    names.join(";"),
    input.payloadHash,
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  return {
    signature: hmac(key, toSign).toString("hex"),
    signedHeaders: names.join(";"),
    credential: `${input.accessKeyId}/${scope}`,
    scope,
  };
}

/** A presigned GET: the signature travels in the query, the payload is unsigned, only `host` is signed. */
export function presignGet(input: { origin: string; host: string; path: string; expiresSeconds: number; region: string; accessKeyId: string; secretAccessKey: string; at: Date }): string {
  const scope = `${amzDate(input.at).slice(0, 8)}/${input.region}/s3/aws4_request`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate(input.at),
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const { signature } = sigV4({
    method: "GET",
    path: input.path,
    query,
    headers: { host: input.host },
    payloadHash: "UNSIGNED-PAYLOAD",
    region: input.region,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    at: input.at,
  });
  return `${input.origin}${encodePath(input.path)}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

/** Where the bucket's objects are addressed: `<endpoint>/<bucket>/<key>` or `<bucket>.<endpoint>/<key>`. */
function addressing(settings: S3Settings): { origin: string; host: string; pathPrefix: string } {
  const endpoint = new URL(settings.endpoint);
  if (settings.addressing === "virtual") {
    const host = `${settings.bucket}.${endpoint.host}`;
    return { origin: `${endpoint.protocol}//${host}`, host, pathPrefix: "/" };
  }
  return { origin: endpoint.origin, host: endpoint.host, pathPrefix: `/${settings.bucket}/` };
}

export function s3UrlRules(settings: S3Settings): StorageUrlRules {
  const { origin, pathPrefix } = addressing(settings);
  const base = new URL(origin);
  const ownsUrl = (url: URL) => url.origin === base.origin && url.pathname.startsWith(pathPrefix) && url.pathname.length > pathPrefix.length;
  return {
    kind: "s3",
    ownsHost: (hostname) => hostname.toLowerCase() === base.hostname,
    ownsUrl,
    keyFromUrl(rawUrl) {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return null;
      }
      if (!ownsUrl(url)) return null;
      const encoded = url.pathname.slice(pathPrefix.length).split("/");
      let key: string;
      try {
        key = encoded.map((segment) => decodeURIComponent(segment)).join("/");
      } catch {
        return null;
      }
      // One canonical spelling: a segment that decodes to a slash or a dot segment is a different key, so refuse it.
      return isStorageKey(key) && key.split("/").length === encoded.length ? key : null;
    },
    open(url, fetchInit) {
      return fetchInit === undefined ? fetch(url) : fetch(url, fetchInit);
    },
  };
}

const xmlText = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];

/** ListObjectsV2's answer, asked for with `encoding-type=url` so a key can hold any character. */
export function parseListObjectsV2(xml: string): StorageListPage {
  const objects: { key: string; size: number }[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = tag(match[1], "Key");
    const size = tag(match[1], "Size");
    if (key === undefined) continue;
    objects.push({ key: decodeURIComponent(xmlText(key).replace(/\+/g, "%20")), size: Number(size ?? 0) });
  }
  const hasMore = tag(xml, "IsTruncated") === "true";
  const token = tag(xml, "NextContinuationToken");
  return { objects, hasMore, cursor: hasMore && token !== undefined ? xmlText(token) : undefined };
}

/** S3's own ceiling on a presigned URL's lifetime. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export function createS3Driver(settings: S3Settings): StorageDriver {
  const { origin, host, pathPrefix } = addressing(settings);
  const credentials = { region: settings.region, accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey };
  const objectPath = (key: string) => `${pathPrefix}${assertStorageKey(key)}`;
  /** The bucket itself: `/<bucket>` in path style (no trailing slash, as the service canonicalises it), `/` otherwise. */
  const bucketPath = pathPrefix === "/" ? "/" : pathPrefix.slice(0, -1);

  async function request(method: string, path: string, options: { query?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array; fetchInit?: RequestInit } = {}): Promise<Response> {
    const at = new Date();
    const payloadHash = sha256Hex(options.body ?? "");
    const signed = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate(at) };
    const { signature, signedHeaders, credential } = sigV4({ method, path, query: options.query, headers: signed, payloadHash, at, ...credentials });
    const query = options.query && Object.keys(options.query).length > 0 ? `?${canonicalQuery(options.query)}` : "";
    return fetch(`${origin}${encodePath(path)}${query}`, {
      ...(options.fetchInit ?? {}),
      method,
      headers: {
        ...(options.headers ?? {}),
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": signed["x-amz-date"],
        authorization: `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: options.body as BodyInit | undefined,
    });
  }

  async function failure(what: string, key: string, response: Response): Promise<Error> {
    const code = tag(await response.text().catch(() => ""), "Code");
    return new Error(`storage ${what} failed for "${key}": HTTP ${response.status}${code ? ` (${code})` : ""}`);
  }

  return {
    kind: "s3",
    urls: s3UrlRules(settings),

    async put(requestedKey, body, options = {}) {
      assertStorageKey(requestedKey);
      const key = options.addRandomSuffix ? withSuffix(requestedKey, randomBytes(15).toString("base64url").replace(/[-_]/g, "x")) : requestedKey;
      const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
      const response = await request("PUT", objectPath(key), {
        body: bytes,
        headers: {
          "content-type": options.contentType ?? "application/octet-stream",
          ...(options.allowOverwrite ? {} : { "if-none-match": "*" }),
        },
      });
      if (response.status === 412 || response.status === 409) throw new Error(`storage object already exists: "${key}"`);
      if (!response.ok) throw await failure("write", key, response);
      await response.arrayBuffer().catch(() => undefined);
      return { key, ref: key };
    },

    async get(key, { fetchInit }) {
      const response = await request("GET", objectPath(key), { fetchInit });
      if (response.status === 404) {
        await response.arrayBuffer().catch(() => undefined);
        return null;
      }
      if (!response.ok) throw await failure("read", key, response);
      return response;
    },

    async head(ref) {
      const response = await request("HEAD", objectPath(ref));
      if (response.status === 404) return null;
      if (!response.ok) throw await failure("head", ref, response);
      return { size: Number(response.headers.get("content-length") ?? 0) };
    },

    async list({ prefix, cursor, limit = 1000 }) {
      const query: Record<string, string> = { "list-type": "2", "encoding-type": "url", "max-keys": String(Math.max(1, Math.min(1000, limit))), prefix };
      if (cursor) query["continuation-token"] = cursor;
      const response = await request("GET", bucketPath, { query });
      if (!response.ok) throw await failure("list", prefix, response);
      return parseListObjectsV2(await response.text());
    },

    async delete(refs) {
      for (const ref of Array.isArray(refs) ? refs : [refs]) {
        const response = await request("DELETE", objectPath(ref));
        if (!response.ok && response.status !== 404) throw await failure("delete", ref, response);
        await response.arrayBuffer().catch(() => undefined);
      }
    },

    async signedUrl(key, ttlMs) {
      const at = new Date();
      const expiresSeconds = Math.max(1, Math.min(MAX_PRESIGN_SECONDS, Math.ceil(ttlMs / 1000)));
      const url = presignGet({ origin, host, path: objectPath(key), expiresSeconds, at, ...credentials });
      return { url, expiresAt: at.getTime() + expiresSeconds * 1000 };
    },
  };
}

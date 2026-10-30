// A stand-in for an S3-compatible bucket service (Cloudflare R2, AWS S3), on 127.0.0.1, for scripts/object-storage-test.ts
// (mold_v0-181). Nothing here reaches the network. It checks what the real services check: each request's AWS Signature
// Version 4 (the access key id must be one it knows, the signature must be made with that key's secret), and that the
// bucket exists. It answers path-style requests the way src/storage.ts makes them:
//
//   PUT    /<bucket>/<key>                    store an object
//   GET    /<bucket>/<key>                    an object (404 NoSuchKey)
//   DELETE /<bucket>/<key>                    remove an object (204)
//   GET    /<bucket>?list-type=2&prefix=...   ListObjectsV2 (one page)
//   POST   /<bucket>?delete                   DeleteObjects
//
// Presigned links (getSignedUrl: the signature in the query string, mold_v0-182) are checked the same way, and refused
// once expired.
//
// Errors are S3's XML (<Error><Code>...</Code>), so the SDK raises them by name. Every request is recorded (method,
// path, the access key id it was signed with, its headers) so a test can say what was asked and that no secret was sent.
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface S3Call { method: string; bucket: string; key: string; query: string; accessKeyId: string | null; headers: Record<string, string | string[] | undefined>; body: Buffer; status: number; presigned?: boolean }

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();
/** RFC 3986 encoding, as SigV4 wants it for the query string. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function startS3Standin(opts: { buckets: string[]; keys: Record<string, string> }) {
  const buckets = new Map<string, Map<string, { body: Buffer; type: string; modified: Date }>>(opts.buckets.map((b) => [b, new Map()]));
  const keys = new Map(Object.entries(opts.keys));
  const calls: S3Call[] = [];

  const fail = (res: ServerResponse, status: number, code: string, message: string) => {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`);
    return status;
  };

  /**
   * A presigned request's SigV4 (mold_v0-182): the signature in the query (X-Amz-Signature) over the other query
   * parameters, the signed headers and UNSIGNED-PAYLOAD, as a link from getSignedUrl carries it; refused once
   * X-Amz-Date + X-Amz-Expires has passed (AccessDenied, "Request has expired"), as S3 and R2 do.
   */
  const verifyPresigned = (req: IncomingMessage, rawPath: string, rawQuery: string): { id: string | null; error: string | null } => {
    const pairs = rawQuery.split("&").filter(Boolean).map((kv) => {
      const i = kv.indexOf("=");
      return [decodeURIComponent(i < 0 ? kv : kv.slice(0, i)), i < 0 ? "" : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, "%20"))] as const;
    });
    const q = new Map(pairs);
    const cred = /^([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request$/.exec(q.get("X-Amz-Credential") ?? "");
    if (q.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" || !cred) return { id: null, error: "AccessDenied" };
    const [, id, date, region, service] = cred as unknown as string[];
    const secret = keys.get(id!);
    if (!secret) return { id: id!, error: "InvalidAccessKeyId" };
    const at = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(q.get("X-Amz-Date") ?? "");
    if (!at) return { id: id!, error: "AccessDenied" };
    const signedAt = Date.UTC(+at[1]!, +at[2]! - 1, +at[3]!, +at[4]!, +at[5]!, +at[6]!);
    if (Date.now() > signedAt + Number(q.get("X-Amz-Expires") ?? 0) * 1000) return { id: id!, error: "AccessDenied:expired" };
    const query = pairs.filter(([k]) => k !== "X-Amz-Signature").map(([k, v]) => [enc(k), enc(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
    const signed = q.get("X-Amz-SignedHeaders") ?? "host";
    const headers = signed.split(";").map((n) => `${n}:${String(req.headers[n] ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
    const canonical = [req.method, rawPath, query, headers, signed, "UNSIGNED-PAYLOAD"].join("\n");
    const scope = `${date}/${region}/${service}/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", q.get("X-Amz-Date")!, scope, sha256(canonical)].join("\n");
    const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date!), region!), service!), "aws4_request");
    return { id: id!, error: createHmac("sha256", key).update(toSign).digest("hex") === q.get("X-Amz-Signature") ? null : "SignatureDoesNotMatch" };
  };

  /** The request's SigV4: null when it holds, else the S3 error code. */
  const verify = (req: IncomingMessage, rawPath: string, rawQuery: string): { id: string | null; error: string | null } => {
    if (/(^|&)X-Amz-Signature=/.test(rawQuery)) return verifyPresigned(req, rawPath, rawQuery);
    const auth = String(req.headers.authorization ?? "");
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m) return { id: null, error: "AccessDenied" };
    const [, id, date, region, service, signed, signature] = m as unknown as string[];
    const secret = keys.get(id!);
    if (!secret) return { id: id!, error: "InvalidAccessKeyId" };
    const query = rawQuery ? rawQuery.split("&").filter(Boolean).map((kv) => {
      const i = kv.indexOf("=");
      const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i)), v = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, "%20"));
      return [enc(k), enc(v)] as const;
    }).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&") : "";
    const names = signed!.split(";");
    const headers = names.map((n) => `${n}:${String(req.headers[n] ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
    const payload = String(req.headers["x-amz-content-sha256"] ?? "UNSIGNED-PAYLOAD");
    const canonical = [req.method, rawPath, query, headers, signed, payload].join("\n");
    const scope = `${date}/${region}/${service}/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", String(req.headers["x-amz-date"] ?? ""), scope, sha256(canonical)].join("\n");
    const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date!), region!), service!), "aws4_request");
    return { id: id!, error: createHmac("sha256", key).update(toSign).digest("hex") === signature ? null : "SignatureDoesNotMatch" };
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? "/";
      const q = url.indexOf("?");
      const rawPath = q < 0 ? url : url.slice(0, q), rawQuery = q < 0 ? "" : url.slice(q + 1);
      const parts = rawPath.split("/").slice(1);
      const bucket = decodeURIComponent(parts[0] ?? ""), key = parts.slice(1).map(decodeURIComponent).join("/");
      const params = new URLSearchParams(rawQuery);
      const call: S3Call = { method: req.method ?? "", bucket, key, query: rawQuery, accessKeyId: null, headers: { ...req.headers }, body, status: 0 };
      calls.push(call);
      const v = verify(req, rawPath, rawQuery);
      call.accessKeyId = v.id;
      call.presigned = /(^|&)X-Amz-Signature=/.test(rawQuery);
      if (v.error === "AccessDenied:expired") { call.status = fail(res, 403, "AccessDenied", "Request has expired"); return; }
      if (v.error) { call.status = fail(res, 403, v.error, v.error === "SignatureDoesNotMatch" ? "The request signature we calculated does not match the signature you provided." : "Access denied."); return; }
      const store = buckets.get(bucket);
      if (!store) { call.status = fail(res, 404, "NoSuchBucket", "The specified bucket does not exist."); return; }
      if (req.method === "PUT" && key) {
        store.set(key, { body, type: String(req.headers["content-type"] ?? "application/octet-stream"), modified: new Date() });
        res.writeHead(200, { etag: `"${sha256(body).slice(0, 32)}"` }); res.end(); call.status = 200; return;
      }
      if (req.method === "GET" && key) {
        const o = store.get(key);
        if (!o) { call.status = fail(res, 404, "NoSuchKey", "The specified key does not exist."); return; }
        res.writeHead(200, { "content-type": o.type, "content-length": String(o.body.length) }); res.end(o.body); call.status = 200; return;
      }
      if (req.method === "DELETE" && key) { store.delete(key); res.writeHead(204); res.end(); call.status = 204; return; }
      if (req.method === "GET" && params.get("list-type") === "2") {
        const prefix = params.get("prefix") ?? "";
        const list = [...store.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xml(bucket)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${list.length}</KeyCount><IsTruncated>false</IsTruncated>` +
          list.map(([k, o]) => `<Contents><Key>${xml(k)}</Key><Size>${o.body.length}</Size><LastModified>${o.modified.toISOString()}</LastModified></Contents>`).join("") + "</ListBucketResult>");
        call.status = 200; return;
      }
      if (req.method === "POST" && params.has("delete")) {
        const gone = [...body.toString("utf8").matchAll(/<Key>([^<]*)<\/Key>/g)].map((x) => x[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
        for (const k of gone) store.delete(k);
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(`<?xml version="1.0" encoding="UTF-8"?><DeleteResult>${gone.map((k) => `<Deleted><Key>${xml(k)}</Key></Deleted>`).join("")}</DeleteResult>`);
        call.status = 200; return;
      }
      call.status = fail(res, 400, "NotImplemented", `${req.method} ${rawPath} is not part of this stand-in`);
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, calls,
    /** The keys in a bucket (under a prefix). */
    list: (bucket: string, prefix = "") => [...(buckets.get(bucket)?.keys() ?? [])].filter((k) => k.startsWith(prefix)).sort(),
    object: (bucket: string, key: string) => buckets.get(bucket)?.get(key)?.body ?? null,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

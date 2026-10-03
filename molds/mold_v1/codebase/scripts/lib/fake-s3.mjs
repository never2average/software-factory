/**
 * A small S3-compatible server for tests, on a loopback port the kernel picks.
 *
 * It is a second implementation of the wire contract, not a mirror of the driver: every request must carry a valid
 * AWS Signature V4 for the request AS RECEIVED (method, path, query, the headers it says it signed, the body digest),
 * or it is answered 403 as S3 would. The signature arithmetic is the documented one (lib/storage/s3.ts `sigV4`, held
 * to Amazon's worked examples in scripts/test-storage-drivers.mjs); what this server adds is the check that the driver
 * signs what it actually sends.
 *
 * Implements what lib/storage/s3.ts uses: PUT / GET / HEAD / DELETE on an object (path-style), `If-None-Match: *`,
 * ListObjectsV2 with `prefix`, `max-keys`, `continuation-token` and `encoding-type=url`, and presigned GETs with an
 * expiry.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** S3's `encoding-type=url`: percent-encoded, a space as `+`. */
const s3UrlEncode = (key) => encodeURIComponent(key).replace(/%2F/g, "/").replace(/%20/g, "+");

export async function startFakeS3({ bucket, accessKeyId, secretAccessKey, region = "us-east-1" }) {
  const { sigV4, presignGet } = await import("../../lib/storage/s3.ts");
  const objects = new Map();
  const requests = [];
  let refusedSignatures = 0;

  const error = (res, status, code) => {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`);
  };

  function signatureOk(req, url, body) {
    const path = url.pathname.split("/").map(decodeURIComponent).join("/");
    const presigned = url.searchParams.get("X-Amz-Signature");
    if (presigned) {
      const at = url.searchParams.get("X-Amz-Date");
      const when = new Date(`${at.slice(0, 4)}-${at.slice(4, 6)}-${at.slice(6, 8)}T${at.slice(9, 11)}:${at.slice(11, 13)}:${at.slice(13, 15)}Z`);
      const expires = Number(url.searchParams.get("X-Amz-Expires"));
      const want = presignGet({ origin: "", host: req.headers.host, path, expiresSeconds: expires, region, accessKeyId, secretAccessKey, at: when });
      if (new URL(want, "http://x").searchParams.get("X-Amz-Signature") !== presigned) return "SignatureDoesNotMatch";
      if (when.getTime() + expires * 1000 <= Date.now()) return "AccessDenied";
      return req.method === "GET" ? null : "SignatureDoesNotMatch";
    }
    const auth = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(req.headers.authorization ?? "");
    if (!auth) return "AccessDenied";
    const payloadHash = req.headers["x-amz-content-sha256"];
    if (payloadHash !== createHash("sha256").update(body).digest("hex")) return "XAmzContentSHA256Mismatch";
    const stamp = req.headers["x-amz-date"] ?? "";
    const at = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
    const headers = Object.fromEntries(auth[2].split(";").map((name) => [name, String(req.headers[name] ?? "")]));
    const { signature, credential } = sigV4({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers, payloadHash, region, accessKeyId, secretAccessKey, at });
    return signature === auth[3] && credential === auth[1] ? null : "SignatureDoesNotMatch";
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const denied = signatureOk(req, url, body);
      requests.push({ method: req.method, path: url.pathname, query: url.search, denied });
      if (denied) {
        refusedSignatures++;
        return error(res, 403, denied);
      }
      const prefix = `/${bucket}`;
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return error(res, 404, "NoSuchBucket");
      const key = url.pathname.slice(prefix.length + 1).split("/").map(decodeURIComponent).join("/");

      if (key === "") {
        if (req.method !== "GET" || url.searchParams.get("list-type") !== "2") return error(res, 501, "NotImplemented");
        const wanted = url.searchParams.get("prefix") ?? "";
        const max = Number(url.searchParams.get("max-keys") ?? 1000);
        const after = url.searchParams.get("continuation-token");
        // UTF-8 byte order, as S3 lists.
        const keys = [...objects.keys()].filter((k) => k.startsWith(wanted)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        const start = after ? keys.findIndex((k) => Buffer.compare(Buffer.from(k), Buffer.from(after, "base64url")) > 0) : 0;
        const rest = start === -1 ? [] : keys.slice(start);
        const page = rest.slice(0, max);
        const truncated = rest.length > page.length;
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xml(s3UrlEncode(wanted))}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><EncodingType>url</EncodingType><IsTruncated>${truncated}</IsTruncated>` +
            page.map((k) => `<Contents><Key>${xml(s3UrlEncode(k))}</Key><Size>${objects.get(k).body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("") +
            (truncated ? `<NextContinuationToken>${Buffer.from(page[page.length - 1]).toString("base64url")}</NextContinuationToken>` : "") +
            `</ListBucketResult>`,
        );
      }

      const found = objects.get(key);
      if (req.method === "PUT") {
        if (req.headers["if-none-match"] === "*" && found) return error(res, 412, "PreconditionFailed");
        objects.set(key, { body, contentType: req.headers["content-type"] ?? "binary/octet-stream" });
        res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
        return res.end();
      }
      if (req.method === "GET" || req.method === "HEAD") {
        if (!found) return req.method === "HEAD" ? (res.writeHead(404), res.end()) : error(res, 404, "NoSuchKey");
        res.writeHead(200, { "content-type": found.contentType, "content-length": String(found.body.length) });
        return res.end(req.method === "HEAD" ? undefined : found.body);
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      return error(res, 501, "NotImplemented");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    refused: () => refusedSignatures,
    keys: () => [...objects.keys()].sort(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

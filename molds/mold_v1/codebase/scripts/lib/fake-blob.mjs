/**
 * An in-memory Vercel Blob store, answering the REAL `@vercel/blob` client (and Node's own `fetch` of a presigned
 * URL) through undici's global dispatcher — so a test drives agent/lib/dataroom-store.ts, lib/dataroom-blob.ts and
 * scripts/migrate-dataroom-root.mjs exactly as production does, with no network and no token.
 *
 *   const blob = installFakeBlob();          // sets BLOB_READ_WRITE_TOKEN and VERCEL_BLOB_API_URL
 *   blob.objects                             // Map<pathname, { body: Buffer, uploadedAt: number }>
 *   blob.calls                               // every request: { op, pathname?, prefix? }
 *
 * Only what the code under test uses: list (prefix, cursor, limit), put, copy, delete, signed-token, and a GET of a
 * presigned object URL. Anything else answers 501, loudly.
 */
import { MockAgent, setGlobalDispatcher } from "undici";

const STORE_ID = "fakestore";
const API = "https://blob-api.fake.test";

const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function installFakeBlob() {
  const objects = new Map();
  const calls = [];
  let clock = Date.now();
  process.env.BLOB_READ_WRITE_TOKEN = `vercel_blob_rw_${STORE_ID}_fakesecret`;
  process.env.VERCEL_BLOB_API_URL = API;
  process.env.VERCEL_BLOB_RETRIES = "0";

  const agent = new MockAgent();
  agent.disableNetConnect();
  // Loopback stays real (a test's own Postgres, a local server).
  agent.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/);
  setGlobalDispatcher(agent);

  const describe = (pathname, o) => ({
    url: `https://${STORE_ID}.private.blob.vercel-storage.com/${pathname}`,
    downloadUrl: `https://${STORE_ID}.private.blob.vercel-storage.com/${pathname}?download=1`,
    pathname,
    size: o.body.length,
    uploadedAt: new Date(o.uploadedAt).toISOString(),
    etag: `"${o.uploadedAt}"`,
    contentType: o.contentType ?? "application/octet-stream",
    contentDisposition: "inline",
  });
  const json = (status, data) => ({ statusCode: status, data: JSON.stringify(data), responseOptions: { headers: { "content-type": "application/json" } } });
  const toBuffer = (body) => {
    if (body === undefined || body === null) return Buffer.alloc(0);
    if (typeof body === "string") return Buffer.from(body);
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
    throw new Error(`fake-blob: unsupported request body ${Object.prototype.toString.call(body)}`);
  };
  const headerOf = (headers, name) => {
    if (!headers) return undefined;
    if (typeof headers.get === "function") return headers.get(name) ?? undefined;
    if (Array.isArray(headers)) {
      for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name) return headers[i + 1];
      return undefined;
    }
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
    return undefined;
  };

  function api(opts) {
    const url = new URL(opts.path, API);
    const method = opts.method.toUpperCase();
    // `requestApi` puts everything after the API base in the path: "/?prefix=…", "/delete", "/signed-token".
    const route = url.pathname.replace(/^\/api\/blob/, "").replace(/\/+$/, "") || "/";
    if (method === "GET" && route === "/") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      calls.push({ op: "list", prefix });
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const page = all.slice(cursor, cursor + limit);
      const hasMore = cursor + limit < all.length;
      return json(200, { blobs: page.map((k) => describe(k, objects.get(k))), cursor: hasMore ? String(cursor + limit) : undefined, hasMore });
    }
    if (method === "PUT" && route === "/") {
      const pathname = url.searchParams.get("pathname");
      const fromUrl = url.searchParams.get("fromUrl");
      const allowOverwrite = headerOf(opts.headers, "x-allow-overwrite") === "1";
      if (fromUrl !== null) {
        const from = fromUrl.startsWith("https://") ? decodeURIComponent(new URL(fromUrl).pathname.slice(1)) : fromUrl;
        calls.push({ op: "copy", pathname, from });
        const src = objects.get(from);
        if (!src) return json(404, { error: { code: "not_found", message: "The requested blob does not exist" } });
        if (objects.has(pathname) && !allowOverwrite) return json(400, { error: { code: "bad_request", message: "This blob already exists" } });
        objects.set(pathname, { body: Buffer.from(src.body), uploadedAt: ++clock, contentType: src.contentType });
        return json(200, describe(pathname, objects.get(pathname)));
      }
      calls.push({ op: "put", pathname });
      if (objects.has(pathname) && !allowOverwrite) return json(400, { error: { code: "bad_request", message: "This blob already exists" } });
      objects.set(pathname, { body: toBuffer(opts.body), uploadedAt: ++clock, contentType: headerOf(opts.headers, "x-content-type") });
      return json(200, describe(pathname, objects.get(pathname)));
    }
    if (method === "POST" && route === "/delete") {
      const { urls } = JSON.parse(toBuffer(opts.body).toString("utf8"));
      for (const u of urls) {
        const pathname = u.startsWith("https://") ? decodeURIComponent(new URL(u).pathname.slice(1)) : u;
        calls.push({ op: "delete", pathname });
        objects.delete(pathname);
      }
      return json(200, {});
    }
    if (method === "POST" && route === "/signed-token") {
      const body = JSON.parse(toBuffer(opts.body).toString("utf8"));
      calls.push({ op: "sign", pathname: body.pathname });
      const payload = { storeId: STORE_ID, pathname: body.pathname, operations: body.operations, validUntil: body.validUntil };
      return json(200, { clientSigningToken: "fake-signing-key", delegationToken: `${b64url(JSON.stringify(payload))}.fakesig`, validUntil: body.validUntil });
    }
    return { statusCode: 501, data: `fake-blob: ${method} ${route} is not implemented` };
  }

  function objectGet(opts) {
    const url = new URL(opts.path, `https://${STORE_ID}.private.blob.vercel-storage.com`);
    const pathname = decodeURIComponent(url.pathname.slice(1));
    calls.push({ op: "get", pathname });
    const o = objects.get(pathname);
    if (!o) return { statusCode: 404, data: "not found" };
    return { statusCode: 200, data: o.body, responseOptions: { headers: { "content-type": o.contentType ?? "application/octet-stream" } } };
  }

  const reply = (handler) => (opts) => {
    const r = handler(opts);
    return { statusCode: r.statusCode, data: r.data, responseOptions: r.responseOptions ?? {} };
  };
  agent
    .get(API)
    .intercept({ path: () => true, method: () => true })
    .reply((opts) => {
      const r = api(opts);
      return r;
    })
    .persist();
  agent
    .get(`https://${STORE_ID}.private.blob.vercel-storage.com`)
    .intercept({ path: () => true, method: "GET" })
    .reply(reply(objectGet))
    .persist();

  return {
    objects,
    calls,
    agent,
    /** Seed an object directly (as if an older deploy had written it). */
    seed(pathname, body, uploadedAt) {
      objects.set(pathname, { body: Buffer.from(body), uploadedAt: uploadedAt ?? ++clock });
    },
    keys: (prefix = "") => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    reset() {
      objects.clear();
      calls.length = 0;
    },
  };
}

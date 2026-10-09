/**
 * A stand-in for `@vercel/blob` that RECORDS every call and then makes it for real.
 *
 * scripts/test-storage-default-unchanged.mjs points the module specifier `@vercel/blob` here (a resolve hook), for
 * every importer except this file. So whichever module ends up holding the import — the seven files that did before
 * the storage driver, or the one driver file after it — its calls land in `calls` as { op, args }, in the order they
 * were made, with exactly the arguments it passed. The real client then runs against scripts/lib/fake-blob.mjs.
 *
 * Arguments are recorded as the client receives them. A key that is absent stays absent and one that is `undefined`
 * is written as "<undefined>", because the client treats the two differently for some options (`allowOverwrite`
 * unset sends no header; `false` sends "0").
 */
import { createHash } from "node:crypto";
import * as real from "@vercel/blob";

export const calls = (globalThis.__blobCallLog ??= []);

function plain(value) {
  if (value === undefined) return "<undefined>";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length <= 240 ? value : { text: { chars: value.length, sha256: createHash("sha256").update(value).digest("hex") } };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { bytes: value.length, sha256: createHash("sha256").update(value).digest("hex") };
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = plain(value[key]);
    return out;
  }
  return `<${typeof value}>`;
}

const wrap = (op) =>
  function recorded(...args) {
    calls.push({ op, args: args.map(plain) });
    return real[op](...args);
  };

export const put = wrap("put");
export const del = wrap("del");
export const head = wrap("head");
export const list = wrap("list");
export const copy = wrap("copy");
export const issueSignedToken = wrap("issueSignedToken");
export const presignUrl = wrap("presignUrl");
export const { BlobNotFoundError, BlobError, BlobAccessError } = real;

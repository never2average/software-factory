/**
 * COMPRESSING A SESSION STREAM WITHOUT HOLDING ANY OF IT BACK.
 *
 * The /eve gate (app/eve/v1/session/[...segments]/route.ts) marks every response `content-encoding: identity`, and
 * that is deliberate: measured through the gate, one turn arrived as 20 text deltas in 2 network chunks where the
 * agent sent 40 in 3, and an intermediary that may re-encode a chunked response may also hold it. The price was every
 * read uncompressed: a Control Panel harvest of one specialist was 9.4 MB to over 147 MB on the wire (onfinance_hfc,
 * 2026-10-13), where the same bytes compress about 70 to 500 times (98.6% of them are `reasoning.appended` deltas, each
 * the whole reasoning so far).
 *
 * So the gate compresses ITSELF, only when the reader asks (`?compressed=1`, which the Control Panel's specialist
 * feeds send) and the browser accepts brotli, and it FLUSHES after every chunk the agent sends: each upstream chunk
 * leaves as a complete brotli block, decodable on arrival, before the next one is read. Nothing waits in a compression
 * window, so a live specialist's events arrive exactly when they did uncompressed (scripts/test-eve-proxy-stream.mjs
 * holds this: an event is readable by the client before the agent has sent the next one). `content-encoding: br` plus
 * `no-transform` tells every hop after the gate there is nothing left to do.
 *
 * Why brotli only, and why a big window: a cumulative delta repeats the previous one plus a little, and a reasoning
 * text of 50 KB is beyond gzip's 32 KB window, so gzip saved 4-6x on a generated specialist stream where brotli with a
 * 4 MB window saved 100-550x, for less CPU (2.4 s per 120 MB at quality 5). A browser that does not accept brotli
 * (Chrome sends `br` only over HTTPS) gets identity, as before.
 *
 * The chat's own live tail (lib/chat-attach.ts) does not ask, so it is unchanged.
 */
import { constants, createBrotliCompress } from "node:zlib";

/** The query flag a reader sets to accept a compressed stream from the gate. */
export const COMPRESSED_PARAM = "compressed";

/** Brotli settings: quality 5 with a 4 MB window (see the measurements above). */
const BROTLI_PARAMS = {
  [constants.BROTLI_PARAM_QUALITY]: 5,
  [constants.BROTLI_PARAM_LGWIN]: 22,
  [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
};

/** Does this Accept-Encoding header accept brotli (and not with q=0)? */
export function acceptsBrotli(acceptEncoding: string | null | undefined): boolean {
  if (!acceptEncoding) return false;
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (name.trim().toLowerCase() !== "br") continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  }
  return false;
}

/** The encoding the gate should send a response in. */
export function streamEncoding(input: {
  readonly method: string;
  readonly segments: readonly string[];
  readonly asked: string | null;
  readonly acceptEncoding: string | null;
  readonly status: number;
}): "br" | "identity" {
  if (input.method !== "GET") return "identity";
  if (input.segments[input.segments.length - 1] !== "stream") return "identity";
  if (input.asked !== "1") return "identity";
  if (input.status < 200 || input.status >= 300) return "identity";
  return acceptsBrotli(input.acceptEncoding) ? "br" : "identity";
}

/**
 * Brotli-compress a byte stream, flushing after every chunk: what comes in leaves, complete and decodable, before the
 * next chunk is read. Cancelling the result cancels the source (the agent's stream), so an abandoned read stops there.
 */
export function brotliFlushed(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const z = createBrotliCompress({ params: BROTLI_PARAMS });
  const reader = source.getReader();
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      z.on("data", (chunk: Buffer) => {
        if (!closed) controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });
      z.on("end", () => {
        if (closed) return;
        closed = true;
        controller.close();
      });
      z.on("error", (error) => {
        if (closed) return;
        closed = true;
        controller.error(error);
      });
    },
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        closed = true;
        z.destroy();
        controller.error(error);
        return;
      }
      if (next.done) {
        z.end();
        return;
      }
      await new Promise<void>((resolve) => {
        z.write(next.value);
        z.flush(constants.BROTLI_OPERATION_FLUSH, () => resolve());
      });
    },
    async cancel(reason) {
      closed = true;
      z.destroy();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/** The query the agent should see: the gate's own flag removed. */
export function upstreamSearch(search: URLSearchParams): string {
  const forwarded = new URLSearchParams(search);
  forwarded.delete(COMPRESSED_PARAM);
  const text = forwarded.toString();
  return text ? `?${text}` : "";
}

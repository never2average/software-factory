/**
 * WEB PUSH, without a dependency: message encryption (RFC 8291, `aes128gcm`) and the VAPID sender identity
 * (RFC 8292), on `node:crypto` alone.
 *
 * Why not the `web-push` package: it pulls four transitive dependencies (http_ece, asn1.js, jws,
 * https-proxy-agent) into BOTH bundles — the agent sends from its notification hook, the web app sends for workflow
 * runs — for what is ~100 lines of well-specified crypto that node:crypto already does. The unit test
 * (scripts/test-web-push.mjs) holds this to the specs: it verifies the VAPID JWT with the public key and DECRYPTS a
 * body with the subscription's private key, the way a browser does.
 *
 * Keys are the ones every tool prints (`npx web-push generate-vapid-keys`, or `generateVapidKeys()` below):
 * base64url, the public key a 65-byte uncompressed P-256 point, the private key its 32-byte scalar.
 *
 * Relative `.ts`-free imports only (node built-ins), so the agent bundle, the Next bundle and plain
 * `node --experimental-strip-types` all load it.
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";

export interface PushTarget {
  readonly endpoint: string;
  /** The browser's P-256 public key (subscription.keys.p256dh), base64url. */
  readonly p256dh: string;
  /** The browser's 16-byte auth secret (subscription.keys.auth), base64url. */
  readonly auth: string;
}

export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  /** `mailto:` or `https:` — who the push service may contact about this sender. */
  readonly subject: string;
}

const b64u = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");
const fromB64u = (s: string): Buffer => Buffer.from(s.trim().replace(/=+$/, ""), "base64url");
const hmac = (key: Uint8Array, data: Uint8Array): Buffer => createHmac("sha256", key).update(data).digest();

/**
 * THE PUSH SERVICES A BROWSER CAN GIVE US — and nothing else is ever fetched.
 *
 * A subscription's `endpoint` comes from the browser, i.e. from whoever holds a sign-in. Sending to it is a
 * server-side POST, so an endpoint of `https://169.254.169.254/…`, `https://10.0.0.5/…` or `https://localhost/…`
 * would be a request from inside our network (review of #63). Only the documented push services of the major
 * browsers are allowed, over https on the default port:
 *
 *   fcm.googleapis.com, android.googleapis.com     Chrome, Edge on Android, Opera, Brave, Samsung Internet
 *   *.push.services.mozilla.com                     Firefox (updates.push.services.mozilla.com)
 *   *.notify.windows.com                            Edge on Windows (WNS)
 *   web.push.apple.com, *.push.apple.com            Safari, installed web apps on iPhone / iPad
 */
const PUSH_HOSTS_EXACT = new Set(["fcm.googleapis.com", "android.googleapis.com", "web.push.apple.com"]);
const PUSH_HOST_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS_EXACT.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/** How long one push may take. Short: a push service answers in milliseconds, and nothing waits on this. */
export const PUSH_TIMEOUT_MS = 5_000;

/** Record size advertised in the header. One record carries every payload this sends (< 4 KB). */
const RECORD_SIZE = 4096;

/** A fresh VAPID key pair, for the factory to set as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  // getPrivateKey() drops leading zero bytes, so one key in 256 came out 31 bytes long and vapidFromEnv (and the JWK
  // the signer builds) refused it. A P-256 private key is always 32 bytes: pad it on the left.
  const d = ecdh.getPrivateKey();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(Buffer.concat([Buffer.alloc(32 - d.length), d])) };
}

/** VAPID keys from the environment, or null when any is absent or malformed (the feature then stays off). */
export function vapidFromEnv(env: Record<string, string | undefined> = process.env): VapidKeys | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:|https:)/.test(subject)) return null;
  try {
    if (fromB64u(publicKey).length !== 65 || fromB64u(privateKey).length !== 32) return null;
  } catch {
    return null;
  }
  return { publicKey, privateKey, subject };
}

/**
 * Encrypt `plaintext` for one subscription (RFC 8291 §3, RFC 8188 `aes128gcm`, a single record).
 * `salt` and `senderKeys` are injectable for the test; production draws fresh ones for every message.
 */
export function encryptPayload(
  target: Pick<PushTarget, "p256dh" | "auth">,
  plaintext: Uint8Array,
  opts: { readonly salt?: Uint8Array; readonly senderPrivateKey?: Uint8Array } = {},
): Buffer {
  const uaPublic = fromB64u(target.p256dh);
  const authSecret = fromB64u(target.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("malformed subscription keys");
  const ecdh = createECDH("prime256v1");
  if (opts.senderPrivateKey) ecdh.setPrivateKey(Buffer.from(opts.senderPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  // §3.3: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  // RFC 8188 §2.2: CEK and NONCE from the salt.
  const salt = Buffer.from(opts.salt ?? randomBytes(16));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  // One record, the last: the content, then the 0x02 delimiter, no padding.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/**
 * The inverse, as a BROWSER does it — used by the test to prove what a subscriber receives. Needs the
 * subscription's private key, which only the browser (or the test's fake one) holds.
 */
export function decryptPayload(body: Uint8Array, uaPrivateKey: Uint8Array, authSecret: Uint8Array): Buffer {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idLen = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idLen);
  const ciphertext = buf.subarray(21 + idLen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(uaPrivateKey));
  const uaPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // Strip the delimiter (and any zero padding before it).
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error("not a final record");
  return padded.subarray(0, end);
}

/** The private key as a KeyObject, rebuilt from the 32-byte scalar and its public point. */
function vapidKeyObject(vapid: VapidKeys) {
  const pub = fromB64u(vapid.publicKey);
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64u(fromB64u(vapid.privateKey)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

/**
 * `Authorization: vapid t=<JWT>, k=<public key>` (RFC 8292 §3). The JWT is ES256 over `{ aud: <push service
 * origin>, exp, sub }`; `exp` at most 24 h ahead (12 h here).
 */
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: nowSeconds + 12 * 60 * 60, sub: vapid.subject })));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: vapidKeyObject(vapid), dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

/** A push service collapses queued messages with one Topic (≤ 32 URL-safe chars): a re-sent event replaces its twin. */
export function topicFor(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

export interface SendResult {
  /** HTTP status from the push service; 0 when it could not be reached. */
  readonly status: number;
  /** 404 / 410: the browser dropped this subscription — delete it. */
  readonly gone: boolean;
}

/**
 * Send one encrypted message. Never throws. Only to an allowed push service (`isAllowedPushEndpoint`), never
 * following a redirect (a 3xx is a failure: a redirect is how an allowed host could still point us inward), within
 * `PUSH_TIMEOUT_MS`.
 */
export async function sendWebPush(
  target: PushTarget,
  payload: unknown,
  vapid: VapidKeys,
  opts: { readonly ttlSeconds?: number; readonly urgency?: "high" | "normal"; readonly topic?: string; readonly fetchImpl?: typeof fetch } = {},
): Promise<SendResult> {
  if (!isAllowedPushEndpoint(target.endpoint)) return { status: 0, gone: false };
  try {
    const body = encryptPayload(target, Buffer.from(JSON.stringify(payload)));
    const res = await (opts.fetchImpl ?? fetch)(target.endpoint, {
      method: "POST",
      headers: {
        TTL: String(opts.ttlSeconds ?? 24 * 60 * 60),
        Urgency: opts.urgency ?? "high",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: vapidAuthorization(target.endpoint, vapid),
        ...(opts.topic ? { Topic: opts.topic } : {}),
      },
      body: new Uint8Array(body),
      redirect: "manual",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) return { status: res.status, gone: false };
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch {
    return { status: 0, gone: false };
  }
}

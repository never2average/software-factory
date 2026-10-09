/**
 * Tests for the pure half of lib/safe-fetch.ts — the rules that decide which
 * URLs and addresses /api/ops/pdf-fetch is willing to reach on a user's behalf
 * (the SSRF guard), plus the %PDF sniff and the blob-host rule.
 *
 * Runs offline with plain node + assert — no network: the one resolver-based
 * section injects a fake resolver.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-pdf-fetch.mjs
 */
import assert from "node:assert/strict";

const {
  MAX_URL_LENGTH,
  SafeFetchError,
  checkHostname,
  classifyAddress,
  guardedPdfFetch,
  isBlobHost,
  looksNumericHost,
  openPdfStream,
  resolvePublicAddress,
  sniffPdf,
  statusForCode,
  validatePdfUrl,
} = await import("../lib/safe-fetch.ts");

let count = 0;
const ok = (cond, label) => {
  assert.ok(cond, label);
  count++;
};
const rejectsUrl = (url, code, label = url) => {
  const v = validatePdfUrl(url);
  assert.equal(v.ok, false, `${label} must be rejected`);
  if (code) assert.equal(v.code, code, `${label} → ${code}`);
  count++;
};
const acceptsUrl = (url) => {
  const v = validatePdfUrl(url);
  assert.equal(v.ok, true, `${url} must be accepted (${v.ok ? "" : v.message})`);
  count++;
  return v;
};

// --- URL shape ---------------------------------------------------------------

rejectsUrl("", "bad_url", "empty");
rejectsUrl(null, "bad_url", "null");
rejectsUrl("not a url", "bad_url");
rejectsUrl("http://www.sebi.gov.in/report.pdf", "bad_url"); // http rejected
rejectsUrl("ftp://example.org/a.pdf", "bad_url");
rejectsUrl("file:///etc/passwd", "bad_url");
rejectsUrl("javascript:alert(1)", "bad_url");
rejectsUrl("data:application/pdf;base64,JVBERi0=", "bad_url");
rejectsUrl("https://www.bseindia.com:8443/a.pdf", "bad_url"); // port rejected
rejectsUrl("https://www.bseindia.com:80/a.pdf", "bad_url");
rejectsUrl("https://www.bseindia.com:22/a.pdf", "bad_url");
rejectsUrl("https://user:pass@www.bseindia.com/a.pdf", "bad_url"); // userinfo rejected
rejectsUrl("https://user@www.bseindia.com/a.pdf", "bad_url");
rejectsUrl("https://www.bseindia.com@127.0.0.1/a.pdf"); // userinfo trick: real host is 127.0.0.1
rejectsUrl(`https://www.bseindia.com/${"a".repeat(MAX_URL_LENGTH)}.pdf`, "bad_url", "over-long url");

acceptsUrl("https://www.bseindia.com/xml-data/corpfiling/AttachLive/abc.pdf");
acceptsUrl("https://www.bseindia.com:443/a.pdf"); // explicit default port is fine
acceptsUrl("https://nsearchives.nseindia.com/corporate/x.PDF?download=1#page=3");
ok(acceptsUrl("https://www.w3.org/a.pdf").blob === false, "public host is not the blob host");

// --- hostnames that are not public names ---------------------------------------

for (const host of [
  "localhost",
  "foo.localhost",
  "printer.local",
  "db.internal",
  "router.lan",
  "intranet", // single label
  "metadata", // single label
  "metadata.google.internal",
  "example.test",
  "x.onion",
]) {
  rejectsUrl(`https://${host}/a.pdf`, "blocked_host");
}

// --- IPv4: every private/special range ----------------------------------------

const BLOCKED_V4 = [
  "0.0.0.0", // unspecified
  "0.1.2.3", // 0/8
  "10.0.0.1",
  "10.255.255.255",
  "100.64.0.1", // CGNAT
  "100.127.255.254",
  "127.0.0.1",
  "127.255.255.254",
  "169.254.169.254", // cloud metadata
  "169.254.0.1",
  "172.16.0.1",
  "172.31.255.254",
  "192.0.0.1",
  "192.0.2.10", // documentation
  "192.88.99.1",
  "192.168.0.1",
  "192.168.255.254",
  "198.18.0.1",
  "198.19.255.254",
  "198.51.100.7",
  "203.0.113.7",
  "224.0.0.1", // multicast
  "239.255.255.250",
  "240.0.0.1", // reserved
  "255.255.255.255", // broadcast
];
for (const ip of BLOCKED_V4) {
  ok(classifyAddress(ip).ok === false, `${ip} is not public`);
  rejectsUrl(`https://${ip}/a.pdf`, "blocked_host");
}

const PUBLIC_V4 = [
  "1.1.1.1",
  "8.8.8.8",
  "9.255.255.255", // just below 10/8
  "11.0.0.1", // just above 10/8
  "100.63.255.255", // just below CGNAT
  "100.128.0.1", // just above CGNAT
  "126.255.255.255",
  "128.0.0.1",
  "169.253.255.255",
  "169.255.0.1",
  "172.15.255.255", // just below 172.16/12
  "172.32.0.1", // just above
  "192.167.255.255",
  "192.169.0.1",
  "198.17.255.255",
  "198.20.0.1",
  "223.255.255.254",
  "104.18.22.19",
];
for (const ip of PUBLIC_V4) {
  ok(classifyAddress(ip).ok === true, `${ip} is public`);
  acceptsUrl(`https://${ip}/a.pdf`);
}

// --- IPv4 in disguise -----------------------------------------------------------
// Decimal, octal, hex and short forms of loopback / private / metadata. The URL
// parser canonicalises most of these to a dotted quad; whichever way it goes,
// none may come out accepted.

for (const host of [
  "2130706433", // 127.0.0.1 as one integer
  "0x7f000001",
  "0x7f.1",
  "0x7f.0.0.1",
  "017700000001", // octal
  "0177.0.0.1",
  "127.1",
  "127.0.1",
  "0",
  "0x0",
  "3232235521", // 192.168.0.1
  "0xc0a80001",
  "0300.0250.0.1",
  "2852039166", // 169.254.169.254
  "0xa9fea9fe",
  "0251.0376.0251.0376",
  "167772161", // 10.0.0.1
  "012.0.0.1",
  "10.1",
  "1.2.3.4.5", // not an address at all
  "999.1.1.1",
  "0x", // the URL parser reads a bare 0x as 0 → 0.0.0.0
]) {
  rejectsUrl(`https://${host}/a.pdf`, undefined, `disguised host ${host}`);
}

// …and the same strings fed to the hostname check RAW, as they would arrive if a
// caller ever skipped the URL parser.
for (const raw of ["2130706433", "0x7f.1", "017700000001", "0177.0.0.1", "127.1", "0x7f000001", "1.2.3.4.5", "08.8.8.8"]) {
  ok(looksNumericHost(raw) === true, `${raw} is numeric-looking`);
  ok(checkHostname(raw).ok === false, `raw ${raw} refused`);
  ok(classifyAddress(raw).ok === false, `classifyAddress(${raw}) refuses non-dotted-quad forms`);
}
ok(looksNumericHost("www.bseindia.com") === false, "a normal name is not numeric-looking");
ok(looksNumericHost("1stock.com") === false, "a name starting with a digit is still a name");
ok(checkHostname("8.8.8.8").ok === true, "a plain public dotted quad is fine");
ok(checkHostname("WWW.BSEINDIA.COM.").ok === true, "case and a trailing dot are tolerated");

// --- IPv6 -------------------------------------------------------------------------

const BLOCKED_V6 = [
  "::", // unspecified
  "::1", // loopback
  "0:0:0:0:0:0:0:1",
  "fc00::1", // unique-local
  "fd12:3456:789a::1",
  "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "fe80::1", // link-local
  "febf::1",
  "fe80::1%eth0", // zone id
  "ff02::1", // multicast
  "::ffff:127.0.0.1", // v4-mapped private
  "::ffff:10.0.0.1",
  "::ffff:169.254.169.254",
  "::ffff:192.168.1.1",
  "::ffff:172.16.0.1",
  "::ffff:100.64.0.1",
  "::ffff:0.0.0.0",
  "::ffff:7f00:1", // the same, hex-spelled
  "::ffff:a9fe:a9fe",
  "::ffff:c0a8:101",
  "::127.0.0.1", // v4-compatible
  "::a00:1",
  "64:ff9b::7f00:1", // NAT64 → 127.0.0.1
  "64:ff9b::a9fe:a9fe",
  "2001:db8::1", // documentation
  "2001::1", // Teredo
  "2002:7f00:1::1", // 6to4 of 127.0.0.1
  "2002:a9fe:a9fe::1",
  "100::1", // discard-only
  "4000::1", // outside global unicast
  "not:an:address",
  ":::1",
  "1::2::3",
  "12345::1",
];
for (const ip of BLOCKED_V6) {
  ok(classifyAddress(ip).ok === false, `${ip} is not public`);
  ok(classifyAddress(`[${ip}]`).ok === false, `[${ip}] is not public`);
}
for (const ip of ["::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::7f00:1"]) {
  rejectsUrl(`https://[${ip}]/a.pdf`, "blocked_host");
}

for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808"]) {
  ok(classifyAddress(ip).ok === true, `${ip} is public`);
}
acceptsUrl("https://[2606:4700:4700::1111]/a.pdf");

// --- resolution: every answer must be public, and the pick is what was checked --

const fake = (answers) => async () => answers;
{
  const picked = await resolvePublicAddress("filings.example.org", fake([
    { address: "2606:4700::1111", family: 6 },
    { address: "104.18.22.19", family: 4 },
  ]));
  assert.deepEqual(picked, { address: "104.18.22.19", family: 4 }, "prefers the checked v4 answer");
  count++;
}
for (const answers of [
  [{ address: "127.0.0.1", family: 4 }],
  [{ address: "169.254.169.254", family: 4 }],
  [{ address: "::1", family: 6 }],
  [{ address: "::ffff:10.0.0.5", family: 6 }],
  // The rebinding setup: one good answer, one private. One bad answer refuses the host.
  [{ address: "104.18.22.19", family: 4 }, { address: "10.0.0.5", family: 4 }],
  [{ address: "104.18.22.19", family: 4 }, { address: "fd00::5", family: 6 }],
]) {
  await assert.rejects(
    resolvePublicAddress("rebind.example.org", fake(answers)),
    (e) => e instanceof SafeFetchError && e.code === "blocked_host",
    `answers ${JSON.stringify(answers)} must refuse the host`,
  );
  count++;
}
await assert.rejects(
  resolvePublicAddress("nowhere.example.org", async () => {
    throw new Error("ENOTFOUND");
  }),
  (e) => e instanceof SafeFetchError && e.code === "upstream_error",
);
count++;
// An IP literal never consults DNS.
await assert.rejects(
  resolvePublicAddress("127.0.0.1", async () => assert.fail("resolver must not be called")),
  (e) => e.code === "blocked_host",
);
count++;

// The whole guarded fetch refuses BEFORE resolving or connecting: a resolver that
// fails the test if it is ever called proves no lookup (so no connection) happened
// for a bad URL, and a private answer stops it before any socket opens.
const mustNotResolve = async (h) => assert.fail(`resolver called for ${h}`);
for (const url of [
  "https://169.254.169.254/latest/meta-data/",
  "https://localhost/a.pdf",
  "https://127.0.0.1/a.pdf",
  "https://2130706433/a.pdf",
  "https://[::ffff:127.0.0.1]/a.pdf",
  "http://www.w3.org/a.pdf",
]) {
  await assert.rejects(
    guardedPdfFetch(url, { resolver: mustNotResolve }),
    (e) => e instanceof SafeFetchError && (e.code === "blocked_host" || e.code === "bad_url"),
    `${url} refused before DNS`,
  );
  count++;
}
await assert.rejects(
  guardedPdfFetch("https://rebind.example.org/a.pdf", { resolver: fake([{ address: "10.0.0.5", family: 4 }]) }),
  (e) => e.code === "blocked_host",
  "a name that resolves privately is refused before connecting",
);
count++;

// --- the %PDF sniff -----------------------------------------------------------------

const bytes = (s) => new TextEncoder().encode(s);
ok(sniffPdf(bytes("%PDF-1.7\n%âãÏÓ")) === true, "a normal PDF header");
ok(sniffPdf(bytes(`﻿\r\n  %PDF-1.4`)) === true, "junk before the header is allowed");
ok(sniffPdf(bytes(`${" ".repeat(1019)}%PDF-1.4`)) === true, "header ending exactly at byte 1024");
ok(sniffPdf(bytes(`${" ".repeat(1020)}%PDF-1.4`)) === false, "header past the first 1024 bytes");
ok(sniffPdf(bytes("<!doctype html><title>Access denied</title>")) === false, "an HTML page");
ok(sniffPdf(bytes("%PDF")) === false, "truncated signature");
ok(sniffPdf(bytes("%pdf-1.4")) === false, "case matters");
ok(sniffPdf(new Uint8Array(0)) === false, "empty body");
ok(sniffPdf(bytes("PK\u0003\u0004")) === false, "a zip/xlsx");

// --- only a PDF leaves: the peek-then-stream gate the route sends through -------------

const { Readable } = await import("node:stream");
const drain = async (stream) => {
  let n = 0;
  const parts = [];
  for await (const c of stream) {
    parts.push(Buffer.from(c));
    n += c.length;
  }
  return { n, text: Buffer.concat(parts).toString("latin1") };
};
{
  // Header split across tiny chunks; every byte must come out, in order.
  let released = 0;
  const src = Readable.from([Buffer.from("%P"), Buffer.from("DF-1.7\n"), Buffer.from("x".repeat(5000)), Buffer.from("%%EOF")]);
  const out = await drain(await openPdfStream(src, () => released++));
  ok(out.n === 2 + 7 + 5000 + 5, "every byte is forwarded");
  ok(out.text.startsWith("%PDF-1.7\nxxx") && out.text.endsWith("%%EOF"), "bytes arrive in order");
  ok(released === 1, "release runs exactly once");
}
{
  // A tiny PDF that ends inside the sniff window.
  const out = await drain(await openPdfStream(Readable.from([Buffer.from("%PDF-1.4 tiny")])));
  ok(out.text === "%PDF-1.4 tiny", "a body shorter than the sniff window still streams");
}
{
  // An HTML error page labelled as a PDF: refused, and the source is destroyed.
  let released = 0;
  const src = Readable.from([Buffer.from("<!doctype html><h1>403 Forbidden</h1>"), Buffer.from("secret".repeat(1000))]);
  await assert.rejects(openPdfStream(src, () => released++), (e) => e.code === "not_pdf");
  ok(src.destroyed === true && released === 1, "a non-PDF body is dropped, not forwarded");
}
await assert.rejects(openPdfStream(Readable.from([])), (e) => e.code === "not_pdf", "an empty body is not a PDF");
count++;
{
  // No content-length warned us: the stream is cut at the cap.
  const src = Readable.from([Buffer.from("%PDF-1.7\n" + "x".repeat(2000)), Buffer.alloc(3000), Buffer.alloc(3000), Buffer.alloc(3000)]);
  const stream = await openPdfStream(src, () => {}, 6000);
  await assert.rejects(drain(stream), (e) => e.code === "too_large", "over-cap stream breaks");
  ok(src.destroyed === true, "the upstream is destroyed at the cap");
  count++;
}
{
  // An upstream that dies mid-body surfaces as a stream error, never a clean end.
  const src = new Readable({ read() {} });
  src.push(Buffer.from("%PDF-1.7\n" + "x".repeat(2000)));
  const stream = await openPdfStream(src);
  setTimeout(() => src.destroy(new Error("socket hang up")), 10);
  await assert.rejects(drain(stream), /socket hang up/);
  count++;
}

// --- the blob-host rule (must match app/api/artifact-proxy) --------------------------

ok(isBlobHost("vercel-storage.com") === true);
ok(isBlobHost("abc123.private.blob.vercel-storage.com") === true);
ok(isBlobHost("ABC.Public.Blob.Vercel-Storage.com") === true, "case-insensitive");
ok(isBlobHost("evilvercel-storage.com") === false, "suffix without the dot");
ok(isBlobHost("vercel-storage.com.evil.org") === false, "blob host as a prefix");
ok(isBlobHost("www.w3.org") === false);
ok(acceptsUrl("https://abc123.private.blob.vercel-storage.com/artifacts/r.pdf?sig=x").blob === true, "blob url flagged");
rejectsUrl("http://abc123.private.blob.vercel-storage.com/artifacts/r.pdf", "bad_url", "blob host over http");

// --- status mapping: 401 is OUR gate's alone -------------------------------------------

const codes = ["bad_url", "blocked_host", "too_many_redirects", "timeout", "upstream_denied", "upstream_missing", "upstream_error", "not_pdf", "too_large"];
for (const c of codes) ok(statusForCode(c) !== 401 && statusForCode(c) >= 400, `${c} never maps to 401`);
ok(statusForCode("not_pdf") === 415);
ok(statusForCode("too_large") === 413);
ok(statusForCode("upstream_missing") === 404);
ok(statusForCode("upstream_denied") === 403);
ok(statusForCode("upstream_error") === 502);
ok(statusForCode("timeout") === 504);

console.log(`pdf-fetch guard: ${count} assertions passed`);

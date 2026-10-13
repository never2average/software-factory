#!/usr/bin/env node
/**
 * A GOOGLE MADE HERE, for tests/google-hub.spec.ts: an ID-token issuer on a loopback port.
 *
 * It makes a key pair when it starts, publishes the public half the way Google does (`GET /jwks`, a JWKS document)
 * and signs ID tokens shaped like Google's on request (`POST /mint`: RS256, Google's issuer, the client as audience,
 * the nonce inside). The dev server the specs run against is started with GOOGLE_JWKS_URL_FOR_TEST naming this
 * address (playwright.config.ts), which lib/ops-auth.ts honours only when NODE_ENV is not "production" and only for a
 * loopback address; so the server verifies these tokens with every check it makes on a real one.
 *
 * `POST /mint` takes JSON: { nonce?, aud, email?, hd?, forged?: true (signed by a key that is NOT published),
 * expired?: true }. Nothing here is a secret: the key lives as long as the process and signs for a test client.
 *
 *   node tests/fake-google.mjs --port 3001
 */
import { createServer } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const at = process.argv.indexOf("--port");
const port = Number(at > -1 ? process.argv[at + 1] : 0);
if (!(port > 0 && port < 65536)) {
  console.error("fake-google: --port <1..65535> is required");
  process.exit(2);
}
const real = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const jwks = { keys: [{ ...(await exportJWK(real.publicKey)), kid: "fake-google", alg: "RS256", use: "sig" }] };

async function mint({ nonce, aud, email = "person@work.test", hd = "work.test", forged = false, expired = false }) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, email_verified: true, name: "Test Person", ...(hd ? { hd } : {}), ...(nonce ? { nonce } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: "fake-google" })
    .setIssuer("https://accounts.google.com")
    .setAudience(aud)
    .setSubject(`fake-${email}`)
    .setIssuedAt(expired ? now - 7200 : now)
    .setExpirationTime(expired ? now - 3600 : now + 3600)
    .sign(forged ? other.privateKey : real.privateKey);
}

createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && req.url === "/jwks") return send(200, jwks);
    if (req.method === "POST" && req.url === "/mint") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const input = JSON.parse(text || "{}");
      if (typeof input.aud !== "string" || !input.aud) return send(400, { error: "aud is required" });
      return send(200, { token: await mint(input) });
    }
    send(404, { error: "not found" });
  } catch (error) {
    send(500, { error: String(error?.message ?? error) });
  }
}).listen(port, "127.0.0.1", () => console.log(`fake-google: http://127.0.0.1:${port}`));

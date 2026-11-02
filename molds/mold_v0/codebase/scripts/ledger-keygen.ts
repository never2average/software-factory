// A new Ed25519 signing key for chain-and-sign (mold_v0-195, src/ledger.ts), written to a file only this user can read.
//   npm run ledger:keygen -- --out <file>
// The file holds the private key (a 32-byte seed, base64): its contents go into the app's environment as
// APP_LEDGER_SIGNING_KEY (the factory: provision.py <app> --set-secret APP_LEDGER_SIGNING_KEY, pasted at the hidden
// prompt), then the file is deleted. It never goes into the database, a repository or a chat. This prints only the
// public key and its id, which /.well-known/ledger-keys.json publishes once the app has the key.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const i = process.argv.indexOf("--out");
const out = i > 0 ? process.argv[i + 1] : undefined;
if (!out) { console.error("ledger:keygen: --out <file> (the private key is written there, never printed)"); process.exit(2); }
if (existsSync(out)) { console.error(`ledger:keygen: ${out} exists: not overwritten`); process.exit(2); }
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).subarray(-32);
writeFileSync(out, `${seed.toString("base64")}\n`, { mode: 0o600 });
const { keyId } = await import("../src/ledger.js");
const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
console.log(`private key written to ${out} (mode 600). Public key ${pub.toString("base64")} (key id ${keyId(pub)}).`);

// The embedded fixture (mold_v0-193): scripts/fixtures/packs/fixture_embedded installed for a test as gen-packs would
// register it (its pack.json's declarations compiled, its developer_surface carried as the packs' server config). Import
// after ./test-world.js.
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const EMBEDDED_DIR = path.join(ROOT, "scripts", "fixtures", "packs", "fixture_embedded");
export const embeddedJson = () => JSON.parse(readFileSync(path.join(EMBEDDED_DIR, "pack.json"), "utf8"));

/** Install the fixture (or `edit` it first); null uninstalls (zero packs). */
export async function installEmbedded(edit?: ((j: any) => void) | null) {
  const { setPacksForTest } = await import("../../src/packs.js");
  const { setPackConfigsForTest } = await import("../../src/host.js");
  if (edit === null) { setPacksForTest(null); setPackConfigsForTest([]); return null; }
  const json = embeddedJson();
  edit?.(json);
  const { compileDeclarations } = await import("../../src/pack-manifest.js");
  setPacksForTest([{ manifest: { id: json.id, name: json.name, version: json.version, entry: null, migrations: null, words: {}, dir: EMBEDDED_DIR }, declared: compileDeclarations(json), definition: null } as never]);
  const { $comment: _c, ...cfg } = json.developer_surface ?? {};
  setPackConfigsForTest(json.developer_surface ? [{ pack: json.id, developer_surface: { ...cfg, client_sessions: { ttl_seconds: 3600, ...cfg.client_sessions } } }] : []);
  return json;
}

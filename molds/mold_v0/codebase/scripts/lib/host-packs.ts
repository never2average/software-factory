// The build's host packs (mold_v0-039; src/host.ts) as the command line sees them: each pack under packs/ whose pack.json
// has `host`, with its operator scripts' directory. Read from the files (no server code is loaded), in pack order.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface HostPackDir { id: string; dir: string; scripts: string | null }

export function hostPackDirs(root = path.resolve(import.meta.dirname, "..", "..")): HostPackDir[] {
  const packs = path.join(root, "packs");
  if (!existsSync(packs)) return [];
  const out: HostPackDir[] = [];
  for (const id of readdirSync(packs).sort()) {
    const file = path.join(packs, id, "pack.json");
    if (!existsSync(file)) continue;
    let m: { host?: { scripts?: string } };
    try { m = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    if (!m.host) continue;
    out.push({ id, dir: path.join(packs, id), scripts: m.host.scripts ? path.join(packs, id, m.host.scripts) : null });
  }
  return out;
}

/** A host pack's script by name (`name` or `pack/name`), or null. */
export function hostScript(name: string, root?: string): { pack: string; file: string } | null {
  const [want, script] = name.includes("/") ? name.split("/", 2) : [null, name];
  // A script's name only (letters, digits, - and _): never a path out of the pack's scripts directory.
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(script ?? "") || (want !== null && !/^[a-z][a-z0-9_]*$/.test(want))) return null;
  for (const p of hostPackDirs(root)) {
    if (want && p.id !== want) continue;
    if (!p.scripts) continue;
    const file = path.join(p.scripts, `${script}.ts`);
    if (existsSync(file)) return { pack: p.id, file };
  }
  return null;
}

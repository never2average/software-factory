// What each pack of a lane copy adds, read from the build itself (never from a list kept here), so every lane can report a
// row per pack and a pack's failure is visible on its own.
//   <lane copy>/node_modules/.bin/tsx molds/mold_v0/testing/console/surface.mts <lane copy>          JSON on stdout
// {packs: [{id, name, kind: "host"|"pack"}], tools: {<tool>: <pack id or "shell">}, pages: [{pack, path, label, signed_in, as?}]}
//   packs  every pack in the build, host packs first (src/hosts.generated.ts, then src/packs.generated.ts)
//   tools  the customer MCP server's tools by owner: a host pack's toolNames, a pack's own and generated tools, and the
//          record-area tools (list_records, get_record) as the shell's
//   pages  the console's pages: the shell's own (every page.tsx without a dynamic segment, /auth left out: Clerk's widget),
//          a host pack's routes.json (app, admin, site), and a pack's tabs, pages and record areas from the generated
//          registry (web/src/config/pack-nav.generated.ts)
// Reads only: no database is opened and nothing is written.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface Page { pack: string; path: string; label: string; signed_in: boolean; as?: "no_account" | "staff_no_account" }
export interface Surface { packs: { id: string; name: string; kind: "host" | "pack" }[]; tools: Record<string, string>; pages: Page[] }

const imp = (lane: string, rel: string) => import(pathToFileURL(path.join(lane, rel)).href);

function shellPages(lane: string): Page[] {
  const root = path.join(lane, "web", "src", "app");
  const out: Page[] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const e of readdirSync(dir).sort()) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p, [...segs, e]);
      else if (e === "page.tsx") {
        if (segs.some((s) => s.startsWith("["))) continue;            // dynamic: graded through the packs that fill it
        const route = "/" + segs.filter((s) => !/^\(.*\)$/.test(s)).join("/");
        if (route === "/auth" || route.startsWith("/auth/")) continue;  // Clerk's own widget: not rendered in the lane console
        const signedIn = route === "/app" || route.startsWith("/app/") || route === "/admin" || route.startsWith("/admin/");
        out.push({ pack: "shell", path: route, label: route, signed_in: signedIn });
      }
    }
  };
  if (existsSync(root)) walk(root, []);
  // The portal as someone in no workspace sees it (mold_v0-098: every portal route shows the page for no account), and as
  // platform staff with none; the query only tells the rows apart.
  if (out.some((p) => p.path === "/app")) {
    out.push({ pack: "shell", path: "/app?lane=no-account", label: "/app (signed in, in no workspace)", signed_in: true, as: "no_account" });
    out.push({ pack: "shell", path: "/app?lane=staff-no-account", label: "/app (platform staff, in no workspace)", signed_in: true, as: "staff_no_account" });
  }
  return out;
}

export async function surface(laneArg: string): Promise<Surface> {
  const lane = path.resolve(laneArg);
  // The build's host packs register on import (src/hosts.ts), as every entry module of the shell does first.
  await imp(lane, "src/hosts.ts");
  const { hosts } = await imp(lane, "src/host.ts");
  const { packs, packRegistry } = await imp(lane, "src/packs.ts");
  const nav = await imp(lane, "web/src/config/pack-nav.generated.ts");
  const out: Surface = { packs: [], tools: {}, pages: shellPages(lane) };

  for (const h of hosts() as { id: string; mcp?: { toolNames: readonly string[] } }[]) {
    out.packs.push({ id: h.id, name: h.id, kind: "host" });
    for (const t of h.mcp?.toolNames ?? []) out.tools[t] = h.id;
    const routes = path.join(lane, "web", "src", "packs", h.id, "routes.json");
    if (existsSync(routes)) {
      const r = JSON.parse(readFileSync(routes, "utf8")) as { app?: string[]; admin?: string[]; site?: string[] };
      for (const p of r.app ?? []) out.pages.push({ pack: h.id, path: `/app/${p}`, label: `/app/${p}`, signed_in: true });
      for (const p of r.admin ?? []) out.pages.push({ pack: h.id, path: `/admin/${p}`, label: `/admin/${p}`, signed_in: true });
      for (const p of r.site ?? []) out.pages.push({ pack: h.id, path: `/${p}`, label: `/${p}`, signed_in: false });
    }
  }
  const hostIds = new Set(out.packs.map((p) => p.id));
  for (const p of packs() as { id: string; manifest: { name: string } }[]) if (!hostIds.has(p.id)) out.packs.push({ id: p.id, name: p.manifest.name, kind: "pack" });

  const reg = packRegistry() as { tools: { pack: string; name: string }[]; recordAreas: { pack: string }[] };
  for (const t of reg.tools) out.tools[t.name] = t.pack;
  try {
    const { generatedTools } = await imp(lane, "src/mcp-tools.ts");
    for (const t of generatedTools() as { name: string; pack: string; door: string }[]) if (t.door === "workspace") out.tools[t.name] = t.pack;
  } catch { /* a shell without generated tools: nothing to add */ }
  if (reg.recordAreas.length) for (const t of ["list_records", "get_record"]) out.tools[t] ??= "shell";

  const seen = new Set(out.pages.map((p) => p.path));
  const add = (pg: Page) => { if (!seen.has(pg.path)) { seen.add(pg.path); out.pages.push(pg); } };
  for (const t of (nav.packTabs ?? []) as { pack: string; url: string; label: string }[]) {
    // A tab may point at a shell page (credentials, usage...): it is still the pack's tab, graded on its own row.
    const own = out.pages.find((p) => p.path === t.url && p.pack === "shell");
    if (own) out.pages.push({ pack: t.pack, path: t.url, label: `${t.label} (${t.url})`, signed_in: true });
    else add({ pack: t.pack, path: t.url, label: `${t.label} (${t.url})`, signed_in: true });
  }
  for (const p of (nav.packPages ?? []) as { pack: string; id: string; area: string; title: string }[])
    add({ pack: p.pack, path: `/${p.area}/packs/${p.pack}/${p.id}`, label: p.title, signed_in: true });
  for (const a of (nav.recordAreas ?? []) as { pack: string; name: string; label: string; scope: string }[]) {
    add({ pack: a.pack, path: `/app/records/${a.name}`, label: `${a.label} (/app/records/${a.name})`, signed_in: true });
    if (a.scope === "platform") add({ pack: a.pack, path: `/admin/records/${a.name}`, label: `${a.label} (/admin/records/${a.name})`, signed_in: true });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const lane = process.argv[2];
  if (!lane) { console.error("usage: surface.mts <lane copy>"); process.exit(2); }
  // Modules that read these at load must not reach a real service: the inventory opens nothing.
  delete process.env.DATABASE_URL;
  process.env.OCTILLION_VAULT_KEY ??= Buffer.alloc(32, 7).toString("base64");
  const s = await surface(lane);
  process.stdout.write(JSON.stringify(s, null, 1) + "\n");
  process.exit(0);
}

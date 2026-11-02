// The SDKs of an embedded app (mold_v0-193), generated at build time from its OpenAPI document (scripts/lib/sdk-gen.ts):
//   npm run gen:sdks                                  from this build (its packs' developer surface): dist/sdk/<language>/
//   npm run gen:sdks -- --openapi <file or url>       from a document (a running server's /openapi.json)
//   npm run gen:sdks -- --out <dir> --server <url>    another folder; the address the document names
//   npm run gen:sdks -- --publish-dry-run             then show what publishing would send (npm pack --dry-run; the Python
//                                                     sdist's files): nothing is published, ever, from here
// Only the languages the developer surface lists (sdk_languages). A build without a developer surface has no SDK: it
// says so and writes nothing. Publishing to npm or PyPI is the operator's own step, with their yes (AGENTS.md).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pythonSdk, typescriptSdk, type SdkFile } from "./lib/sdk-gen.js";

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.resolve(arg("--out") ?? path.join(ROOT, "dist", "sdk"));

async function documentOf(): Promise<Record<string, any> | null> {
  const src = arg("--openapi");
  if (src && /^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`${src}: HTTP ${r.status}`);
    return r.json() as Promise<Record<string, any>>;
  }
  if (src) return JSON.parse(readFileSync(src, "utf8"));
  await import("../src/hosts.js");
  const { developerSurface } = await import("../src/developer-surface.js");
  if (!developerSurface()) return null;
  const { openApiDocument } = await import("../src/developer-openapi.js");
  return openApiDocument(arg("--server") ?? process.env.PUBLIC_URL ?? "http://localhost:3333");
}

const write = (dir: string, files: SdkFile[]) => {
  rmSync(dir, { recursive: true, force: true });
  for (const f of files) { mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true }); writeFileSync(path.join(dir, f.path), f.content); }
};

const doc = await documentOf();
if (!doc) { console.log("this build has no developer surface (no pack declares developer_surface): no SDK to generate"); process.exit(0); }
const langs: string[] = doc["x-sdk"]?.languages ?? ["typescript", "python"];
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "openapi.json"), `${JSON.stringify(doc, null, 2)}\n`);
if (langs.includes("typescript")) { write(path.join(OUT, "typescript"), typescriptSdk(doc)); console.log(`wrote ${path.relative(process.cwd(), path.join(OUT, "typescript"))} (${doc["x-sdk"]?.npm})`); }
if (langs.includes("python")) { write(path.join(OUT, "python"), pythonSdk(doc)); console.log(`wrote ${path.relative(process.cwd(), path.join(OUT, "python"))} (${doc["x-sdk"]?.python})`); }

if (argv.includes("--publish-dry-run")) {
  if (langs.includes("typescript")) {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: path.join(OUT, "typescript"), encoding: "utf8" });
    const [p] = JSON.parse(out) as { name: string; version: string; files: { path: string }[] }[];
    console.log(`npm (dry run, nothing published): ${p!.name}@${p!.version}: ${p!.files.map((f) => f.path).join(", ")}`);
  }
  if (langs.includes("python")) {
    const dir = path.join(OUT, "python");
    const files = execFileSync("python3", ["-I", "-c", "import os,sys\nfor r,_,fs in os.walk(sys.argv[1]):\n  [print(os.path.relpath(os.path.join(r,f),sys.argv[1])) for f in fs if '__pycache__' not in r]", dir], { encoding: "utf8" }).trim().split("\n");
    const name = /name = "([^"]+)"/.exec(readFileSync(path.join(dir, "pyproject.toml"), "utf8"))?.[1];
    const ver = /version = "([^"]+)"/.exec(readFileSync(path.join(dir, "pyproject.toml"), "utf8"))?.[1];
    console.log(`PyPI (dry run, nothing published): ${name}==${ver}: ${files.sort().join(", ")}`);
  }
  console.log("publishing is the operator's step (npm publish / twine upload), with their yes");
}

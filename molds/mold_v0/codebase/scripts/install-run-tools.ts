// Install the run tools the build's packs need (mold_v0-072; src/run-tools.ts) into the runner image, at their pinned
// versions, each artifact checked against the catalogue's sha256 before it is unpacked. Run by the Dockerfile (as root,
// at build) and by a boat run sandbox's set-up (before its runner starts). Never by a run.
//   tsx scripts/install-run-tools.ts [--from src/run-tools.generated.json | --tools a,b] [--dir /opt/app-tools] [--verify]
// --verify installs nothing: it checks that the directory holds exactly the pinned tools named (exit 1 otherwise), as
// the image's build does last, so an image that lacks a tool a kind needs is refused at build.
import path from "node:path";
import { generatedTools, installTools, runToolsDir, verifyTools } from "../src/run-tools.js";

const argv = process.argv.slice(2);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const dir = opt("--dir") ?? runToolsDir();
const from = opt("--from"), list = opt("--tools");
const names = list !== undefined ? list.split(",").map((s) => s.trim()).filter(Boolean)
  : generatedTools(path.resolve(from ?? path.join(import.meta.dirname, "..", "src", "run-tools.generated.json")));
try {
  if (argv.includes("--verify")) {
    const bins = verifyTools(names, { dir });
    console.log(`run tools: ${names.length ? names.join(", ") : "none"} as pinned (${Object.keys(bins).join(", ") || "no programs"})`);
  } else {
    if (!names.length) { console.log("run tools: none needed by this build's packs"); process.exit(0); }
    await installTools(names, { dir, log: (m) => console.log(`run tools: ${m}`) });
    verifyTools(names, { dir });
    console.log(`run tools: ${names.join(", ")} installed in ${dir}`);
  }
} catch (e) {
  console.error(`run tools: ${(e as Error).message}`);
  process.exit(1);
}

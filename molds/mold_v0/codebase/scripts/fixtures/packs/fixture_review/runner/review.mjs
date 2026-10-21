// The review fixture's run program (mold_v0-060, scripts/mcp-tools-test.ts): writes its report into the workspace,
// reports/summary.md, naming the item and depth it was given, and no results.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const scope = JSON.parse(process.env.RUN_SCOPE || "{}");
mkdirSync("reports", { recursive: true });
writeFileSync("reports/summary.md", `# Review of ${scope.item}\n\nDepth ${scope.depth ?? 1}. Run ${process.env.RUN_ID}.\n`);
writeFileSync(path.join(process.env.RUN_OUT, "results.json"), "[]");

// mold_v0-079 fixture: another run that changes the workspace (between a preview's approval and its write).
import { writeFileSync } from "node:fs";
writeFileSync(`${process.env.RUN_WORKSPACE}/touched-${process.env.RUN_ID}.txt`, "x");
writeFileSync(`${process.env.RUN_OUT}/results.json`, "[]");

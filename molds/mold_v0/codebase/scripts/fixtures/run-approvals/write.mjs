// mold_v0-079 fixture: the write a preview showed: adds the catalog to the workspace.
import { mkdirSync, writeFileSync } from "node:fs";
const scope = JSON.parse(process.env.RUN_SCOPE || "{}");
mkdirSync(`${process.env.RUN_WORKSPACE}/catalogs`, { recursive: true });
writeFileSync(`${process.env.RUN_WORKSPACE}/catalogs/${scope.catalog}.json`, JSON.stringify({ catalog: scope.catalog, run: process.env.RUN_ID }));
writeFileSync(`${process.env.RUN_OUT}/results.json`, "[]");

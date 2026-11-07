/**
 * Staff routes of the workspace recipes (mold_v0-271, flag workspace_recipes; src/recipes.ts), under
 * /api/admin/onboarding (the staff guard, its access log and the role check, src/admin-roles.ts). Mounted only while
 * recipes are on: off, every path answers not found as before. Any staff role reads; a change needs the role that
 * changes agent profiles (need("compute")). Every change is also a staff log line (src/admin.ts log).
 *
 *   GET  /recipes                              every recipe (its latest version's files and size, pending proposals) and the pending proposals
 *   GET  /recipes/:id                          one: its versions (newest first) and its proposals
 *   POST /recipes                              {id?, name, description?, files?, note?}: a new recipe (with files: its version 1)
 *   PUT  /recipes/:id                          {name?, description?}
 *   POST /recipes/:id/versions                 {version, files: [{upload, path, executable}], note?}: the next version (409: a newer one was saved)
 *   POST /recipes/:id/archive | /restore
 *   GET  /recipes/:id/versions/:v/files/:n     one file of a version (a download)
 *   POST /recipe-uploads                       {bytes}: start an upload -> {id, parts, part_bytes}
 *   PUT  /recipe-uploads/:id/parts/:n          one part, application/octet-stream
 *   POST /recipe-uploads/:id/finish            -> {id, bytes, sha256}
 *   GET  /recipe-proposals                     the pending proposals, oldest first
 *   GET  /recipe-proposals/:id                 one, and GET /recipe-proposals/:id/files/:n one file of its version
 *   POST /recipe-proposals/:id/accept          {note?, reason?}: the recipe's next version
 *   POST /recipe-proposals/:id/decline         {reason}
 */
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import { PackError } from "./pack-api.js";
import { log } from "./admin.js";
import * as R from "./recipes.js";

const answer = (fn: (req: Request, res: Response) => unknown, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try { const v = await fn(req, res); if (!res.headersSent) res.status(status).json(v); }
  catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};
/** A download's headers: never shown inline, never cached. */
const send = (res: Response, name: string, data: Buffer) => {
  const ascii = name.split("/").pop()!.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
  res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${ascii}"`, "Content-Length": String(data.length),
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
  res.end(data);
};

export function recipeAdminRoutes(ob: Router, need: (p: "compute") => RequestHandler, who: (req: Request, res: Response) => string) {
  if (!R.recipesOn()) return;
  const id = (req: Request) => String(req.params.id);
  ob.get("/recipes", answer(async () => ({ recipes: await R.listRecipes(), proposals: await R.pendingProposals(), limits: { file_bytes: R.recipeFileMax(), version_bytes: R.recipeVersionMax(), part_bytes: R.RECIPE_PART_BYTES, files: R.RECIPE_LIMITS.files } })));
  ob.get("/recipes/:id", answer(async (req) => ({ recipe: await R.readRecipe(id(req)) })));
  ob.post("/recipes", need("compute"), answer(async (req, res) => {
    const r = await R.createRecipe(who(req, res), req.body ?? {});
    log(who(req, res), "recipe.create", null, { recipe: r.id, version: r.version });
    return { recipe: r };
  }, 201));
  ob.put("/recipes/:id", need("compute"), answer(async (req, res) => {
    const r = await R.renameRecipe(who(req, res), id(req), req.body ?? {});
    log(who(req, res), "recipe.rename", null, { recipe: r.id });
    return { recipe: r };
  }));
  ob.post("/recipes/:id/versions", need("compute"), answer(async (req, res) => {
    const r = await R.saveRecipeVersion(who(req, res), id(req), req.body ?? {});
    log(who(req, res), "recipe.version", null, { recipe: r.id, version: r.version, files: r.files });
    return { recipe: r };
  }, 201));
  for (const [p, archived] of [["archive", true], ["restore", false]] as const) ob.post(`/recipes/:id/${p}`, need("compute"), answer(async (req, res) => {
    const r = await R.setRecipeArchived(who(req, res), id(req), archived);
    log(who(req, res), `recipe.${p}`, null, { recipe: r.id });
    return { recipe: r };
  }));
  ob.get("/recipes/:id/versions/:v/files/:n", answer(async (req, res) => {
    const f = await R.recipeFile(id(req), Number(req.params.v), Number(req.params.n));
    send(res, f.file.path, f.data);
  }));

  ob.post("/recipe-uploads", need("compute"), answer(async (req, res) => R.startUpload(`staff:${who(req, res)}`, req.body ?? {}), 201));
  ob.put("/recipe-uploads/:id/parts/:n", need("compute"),
    (req: Request, res: Response, next: NextFunction) => (req.is("application/octet-stream") ? next() : void res.status(415).json({ error: "Send the part's bytes as application/octet-stream" })),
    express.raw({ type: "application/octet-stream", limit: R.RECIPE_PART_BYTES + 1024 }),
    (err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) =>
      (err ? void res.status(err.type === "entity.too.large" ? 413 : 400).json({ error: err.type === "entity.too.large" ? `A part is at most ${R.RECIPE_PART_BYTES} bytes` : "The request body could not be read" }) : next()),
    answer(async (req) => R.putUploadPart(id(req), Number(req.params.n), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0))));
  ob.post("/recipe-uploads/:id/finish", need("compute"), answer(async (req) => R.finishUpload(id(req))));

  ob.get("/recipe-proposals", answer(async () => ({ proposals: await R.pendingProposals() })));
  ob.get("/recipe-proposals/:id", answer(async (req) => ({ proposal: await R.readProposal(id(req)) })));
  ob.get("/recipe-proposals/:id/files/:n", answer(async (req, res) => {
    const f = await R.proposalFile(id(req), Number(req.params.n));
    send(res, f.file.path, f.data);
  }));
  for (const [p, accept] of [["accept", true], ["decline", false]] as const) ob.post(`/recipe-proposals/:id/${p}`, need("compute"), answer(async (req, res) => {
    const x = await R.decideProposal(who(req, res), id(req), accept, req.body ?? {});
    log(who(req, res), `recipe.proposal_${accept ? "accepted" : "declined"}`, null, { recipe: x.recipe, proposal: x.id, version: x.accepted_version });
    return { proposal: x };
  }));
}

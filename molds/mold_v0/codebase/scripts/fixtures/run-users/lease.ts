// mold_v0-078: one runner process leasing a run user from RU_RANGE in RU_DIR, holding it a moment (as a run does),
// printing its uid, then giving it back. Many of these at once must never print the same uid.
import { leaseRunUser, runUidRange } from "../../../src/run-users.js";

const u = await leaseRunUser(`run_child_${process.pid}`, { range: runUidRange(process.env.RU_RANGE), dir: process.env.RU_DIR });
await new Promise((r) => setTimeout(r, 700));
console.log(u.uid);
await u.release();

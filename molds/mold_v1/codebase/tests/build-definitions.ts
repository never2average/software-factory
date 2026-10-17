import { readFileSync } from "node:fs";
import path from "node:path";
import { RECORD_AREAS, type RecordAreaId } from "../agent/lib/record-areas.generated";

/**
 * What THIS build's profile defines, for the specs that grade the build's own screens (not an example's): the record
 * areas the build compiled (agent/lib/record-areas.generated.ts), compared with the DEFAULT profile's
 * (scripts/fixtures/record-areas/golden/default.areas.json, held equal to what the default profile compiles by
 * scripts/test-record-structure.mjs).
 *
 * A spec that pins the default's own screen byte for byte can only be graded on a build whose definition of that area
 * IS the default's; on any other build it skips, naming the area, and the build's own screen is graded by the specs
 * that read its definition.
 */
const DEFAULT_AREAS = JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "fixtures", "record-areas", "golden", "default.areas.json"), "utf8")) as Record<RecordAreaId, unknown>;

/** JSON with every object's keys in order: two definitions compare by what they say, not the order they say it in. */
const canonical = (x: unknown): string =>
  JSON.stringify(x, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v));

/** Is this build's definition of `id` exactly the default profile's? */
export const isDefaultArea = (id: RecordAreaId): boolean => canonical(RECORD_AREAS[id]) === canonical(DEFAULT_AREAS[id]);

/** The areas, among `ids`, that this build defines otherwise than the default profile (for a skip's reason). */
export const redefinedAreas = (ids: readonly RecordAreaId[]): RecordAreaId[] => ids.filter((id) => !isDefaultArea(id));

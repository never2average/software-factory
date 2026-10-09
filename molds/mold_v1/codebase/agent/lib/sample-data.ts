/**
 * THE SAMPLE RECORDS, for an explicit local demo only.
 *
 * data/sample/customers.json and data/sample/people.json are two invented accounts and their people. They used to
 * be data/customers.json and data/people.json, imported statically by the web client (the data room's Master.xlsx
 * previews, the chat's company picker) and by the agent's no-database fallback. So every live workspace showed
 * "Acme Bank" and "Northwind Capital" to real users, with a real person's email on its People sheet, and a person
 * could ground a chat on an account that does not exist (factory task mold_v1-120).
 *
 * Now nothing imports them. They are read from disk, at runtime, on the server, and only when the process says so:
 *
 *   DEMO_SAMPLE_DATA=1   the no-database fallback (and the data room's preview, with no database) starts from the
 *                        sample records. For a local demo; never set on a deployment.
 *   DEMO_SAMPLE_DATA_DIR where to read them from (default: <cwd>/data/sample).
 *
 * Unset (every deployment, every test that does not ask), the fallback starts EMPTY and the data room shows its
 * empty state. A process with a database never reads these files at all: it has no fallback to seed.
 * `npm run check:no-sample-data` holds that no sample name or email reaches the production client build.
 *
 * Server-only (node:fs). The files are read by path at runtime, not imported, so no bundler copies them into a
 * build.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const SAMPLE_DATA_FLAG = "DEMO_SAMPLE_DATA";

/** True only when the process was started with DEMO_SAMPLE_DATA=1 (or "true"). */
export function sampleDataEnabled(): boolean {
  const v = (process.env[SAMPLE_DATA_FLAG] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export interface SamplePeople {
  internalStaffAssignments: unknown[];
  customerStakeholders: unknown[];
}

const EMPTY_PEOPLE: SamplePeople = { internalStaffAssignments: [], customerStakeholders: [] };

/**
 * Where the sample lives: DEMO_SAMPLE_DATA_DIR when set (a test running from a scratch directory), else the working
 * directory's data/sample/ (a local `next dev` / `next start` / agent run from the checkout). Resolved at call time,
 * by path string and outside the build's file tracing, so a bundler has nothing to copy into a deployment.
 */
function sampleFile(file: string): string {
  const dir = process.env.DEMO_SAMPLE_DATA_DIR?.trim();
  return dir
    ? path.join(/*turbopackIgnore: true*/ dir, file)
    : path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "sample", file);
}

function readSample(file: string): unknown {
  const at = sampleFile(file);
  try {
    return JSON.parse(readFileSync(at, "utf8"));
  } catch (e) {
    // Asked for and missing (a serverless bundle has no data/ folder): say so once, start empty.
    console.warn(`${SAMPLE_DATA_FLAG} is set but ${at} could not be read (${e instanceof Error ? e.message : String(e)}); starting empty.`);
    return null;
  }
}

/** The accounts the no-database fallback starts from: `{ customers: [] }` unless DEMO_SAMPLE_DATA is set. */
export function sampleCustomerStore(): { customers: unknown[] } {
  if (!sampleDataEnabled()) return { customers: [] };
  const data = readSample("customers.json") as { customers?: unknown[] } | null;
  return { customers: Array.isArray(data?.customers) ? data.customers : [] };
}

/** The people the no-database fallback knows: none unless DEMO_SAMPLE_DATA is set. */
export function samplePeople(): SamplePeople {
  if (!sampleDataEnabled()) return EMPTY_PEOPLE;
  const data = readSample("people.json") as Partial<SamplePeople> | null;
  return {
    internalStaffAssignments: Array.isArray(data?.internalStaffAssignments) ? data.internalStaffAssignments : [],
    customerStakeholders: Array.isArray(data?.customerStakeholders) ? data.customerStakeholders : [],
  };
}

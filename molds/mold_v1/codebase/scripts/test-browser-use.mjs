// End-to-end test of the PRODUCT's browser-use functionality — exercises the
// exact functions the agent's browser tools call (agent/lib/browser.ts), which
// drive a real Browserbase session over CDP with playwright-core.
//
//   node --experimental-strip-types --env-file=.env.local .test-browser-use.mjs
//
// Steps: configured? → open a session → goto → read (aria) → screenshot → close.
import { DEFAULT_ORG } from "./lib/default-org.mjs";
import {
  browserConfigured,
  openSession,
  pageGoto,
  pageRead,
  pageScreenshot,
  closeSession,
  liveViewUrl,
} from "../agent/lib/browser.ts";

const access = {
  orgId: process.env.BROWSER_TEST_ORG_ID ?? DEFAULT_ORG,
  principalId: process.env.BROWSER_TEST_PRINCIPAL_ID ?? "browser-e2e",
};

const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => console.log(`✗ ${m}`);
const t0 = () => process.hrtime.bigint();
const ms = (s) => `${Number(process.hrtime.bigint() - s) / 1e6 | 0}ms`;

let row;
try {
  if (!browserConfigured()) {
    bad("browser NOT configured (BROWSERBASE_API_KEY missing on this process).");
    process.exit(1);
  }
  ok("browser configured (Browserbase key present).");

  let s = t0();
  const opened = await openSession({ ...access, contextScope: "principal" });
  row = opened.row;
  ok(`openSession → ref ${row.id} · provider ${row.provider} (${ms(s)})`);
  console.log(`   live view capability: ${liveViewUrl(row) ? "available (redacted)" : "none"}`);

  s = t0();
  const nav = await pageGoto(row, "https://example.com");
  ok(`pageGoto example.com → "${nav.title}" @ ${nav.url} (${ms(s)})`);

  s = t0();
  const read = await pageRead(row, 1200);
  ok(`pageRead → aria tree ${read.aria.length} chars, truncated=${read.truncated} (${ms(s)})`);
  console.log("   aria preview:", JSON.stringify(read.aria.slice(0, 160)));
  if (!/example/i.test(read.aria)) bad("   aria did NOT contain expected page text — check the snapshot.");

  s = t0();
  const png = await pageScreenshot(row, false);
  ok(`pageScreenshot → ${png.length} bytes PNG (${ms(s)})`);

  console.log("\n✓ Browser-use functionality is WORKING end-to-end.");
} catch (e) {
  bad(`FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  if (row) {
    try {
      await closeSession(row.id, access);
      ok("closeSession — released the remote browser.");
    } catch (e) {
      bad(`closeSession failed: ${e?.message ?? e}`);
    }
  }
  // The DB pool + any open handles keep the process alive — exit explicitly.
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
}

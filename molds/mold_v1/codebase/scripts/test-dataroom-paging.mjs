/**
 * DATA-ROOM READS COME BACK A PAGE AT A TIME, AND EVERY PAGE CAN BE READ (mold_v1-220).
 *
 * `dataroom_read` and `dataroom_list` returned whole files and whole listings, and a tool result stays in the session:
 * every later step of the session resent it. Now a call returns at most one page (agent/lib/dataroom-paging.ts,
 * DATAROOM_PAGE_CHARS, default 40,000 characters) and says, in the result, that there is more and the exact call that
 * reads on. This proves, on the pure functions and on the REAL tools against a local data room (no database, no
 * network):
 *
 *   - a file or listing that fits in one page comes back exactly as before: the same keys, no paging fields;
 *   - a large text file comes back in pages that, followed by `nextOffset`, rebuild it byte for byte, each page at
 *     most the page size, each `more` naming the call that reads on, the last one saying it is the end;
 *   - a page ends on a line break when there is one in its second half;
 *   - a large `.jsonl` file pages by record (whole records, at least one per page), a long listing by path, sorted,
 *     and the pages together are every record and every path, once each;
 *   - an offset past the end says so; DATAROOM_PAGE_CHARS sets the size, and a nonsense value is ignored.
 *
 * Fails before mold_v1-220: agent/lib/dataroom-paging.ts does not exist and the tools return whole files.
 *
 * Run:  npm run test:dataroom-paging
 */
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The web app's `@/` alias, extensionless and `.js`-for-`.ts` imports, and Next's `server-only` guard, so the agent's
// tool modules load here (as scripts/test-dataroom-folders.mjs).
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(ROOT + "/").href)};
      export async function resolve(s, c, n) {
        if (s === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) return await n(s + ".ts", c);
          throw e;
        }
      }`),
  import.meta.url,
);

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600)}`}`);
};

const DIR = mkdtempSync(join(tmpdir(), "dataroom-paging-"));
for (const name of ["DATABASE_URL", "POSTGRES_URL", "BLOB_READ_WRITE_TOKEN", "STORAGE_DRIVER", "DATAROOM_PAGE_CHARS"]) delete process.env[name];
process.env.DATAROOM_DIR = DIR;
process.on("exit", () => rmSync(DIR, { recursive: true, force: true }));

const paging = await import("../agent/lib/dataroom-paging.ts");
const { pageText, pageList, pageChars, DEFAULT_PAGE_CHARS } = paging;

console.log("the pure paging functions:");
{
  check(`the page is ${DEFAULT_PAGE_CHARS.toLocaleString("en-US")} characters by default`, pageChars({}) === DEFAULT_PAGE_CHARS);
  check("DATAROOM_PAGE_CHARS sets it", pageChars({ DATAROOM_PAGE_CHARS: "8000" }) === 8000);
  check("…a nonsense value is ignored", pageChars({ DATAROOM_PAGE_CHARS: "12" }) === DEFAULT_PAGE_CHARS && pageChars({ DATAROOM_PAGE_CHARS: "lots" }) === DEFAULT_PAGE_CHARS);
  check("a small text is returned whole, with no paging", JSON.stringify(pageText("hello\n", undefined, 100)) === JSON.stringify({ content: "hello\n" }));
  const text = Array.from({ length: 900 }, (_, i) => `line ${i} ${"x".repeat(i % 37)}`).join("\n");
  const pages = [];
  let offset;
  for (let i = 0; i < 100; i++) {
    const p = pageText(text, offset, 2000);
    pages.push(p);
    if (p.paging?.nextOffset === undefined) break;
    offset = p.paging.nextOffset;
  }
  check(`a ${text.length}-character text in pages of 2,000 rebuilds byte for byte (${pages.length} pages)`, pages.map((p) => p.content).join("") === text);
  check("every page is at most the page size", pages.every((p) => p.content.length <= 2000));
  check("every page but the last ends on a line break", pages.slice(0, -1).every((p) => p.content.endsWith("\n")));
  check("every page but the last says MORE IS AVAILABLE and the offset to read on", pages.slice(0, -1).every((p) => /MORE IS AVAILABLE: call dataroom_read again with the same path and offset: \d+/.test(p.paging.more) && p.paging.more.includes(`offset: ${p.paging.nextOffset}`)));
  check("the last page has no nextOffset and says it is the end", pages.at(-1).paging.nextOffset === undefined && /the end/.test(pages.at(-1).paging.more));
  check("an offset past the end says so", pageText(text, text.length + 5, 2000).content === "" && /past the end/.test(pageText(text, text.length + 5, 2000).paging.more));
  const oneLine = "y".repeat(5000);
  check("a text with no line breaks still pages (cut at the size)", pageText(oneLine, 0, 2000).content.length === 2000 && pageText(oneLine, 0, 2000).paging.nextOffset === 2000);
  const records = Array.from({ length: 300 }, (_, i) => ({ id: i, note: "z".repeat(i % 50) }));
  const got = [];
  offset = undefined;
  for (let i = 0; i < 100; i++) {
    const p = pageList("dataroom_read", "records", records, offset, 2000);
    got.push(...p.items);
    if (p.paging?.nextOffset === undefined) break;
    offset = p.paging.nextOffset;
  }
  check("records page by whole records and come back every one, once, in order", JSON.stringify(got) === JSON.stringify(records));
  check("a record larger than a page still comes back (one per page)", pageList("dataroom_read", "records", [{ big: "q".repeat(5000) }, { small: 1 }], 0, 2000).items.length === 1);
  check("a small list is returned whole, with no paging", pageList("dataroom_list", "paths", ["a", "b"], undefined, 2000).paging === undefined);
}

console.log("\nthe real tools, on a local data room:");
{
  const tools = await import("../agent/lib/dataroom-tools.ts");
  const { storeForSession } = await import("../agent/lib/dataroom-session.ts");
  const { FOLDER } = await import("../agent/lib/dataroom-folders.ts");
  const ctx = { session: { id: "paging-probe", auth: { current: null, initiator: null } } };
  const store = await storeForSession(ctx);
  const small = `${FOLDER.accounts}/acme-bank/context.md`;
  await store.write(small, "# Acme\nA short note.\n");
  const r1 = await tools.dataroomReadTool.execute({ path: small }, ctx);
  check("a small file: exactly { path, content }, as before", JSON.stringify(r1) === JSON.stringify({ path: small, content: "# Acme\nA short note.\n" }), r1);

  const big = `${FOLDER.accounts}/acme-bank/agreements/filing.md`;
  const bigText = Array.from({ length: 6000 }, (_, i) => `Row ${String(i).padStart(5, "0")}: ${i % 97 === 0 ? `FACT-${i}=${(i * 7919).toString(16)}` : "filler of the filing"}`).join("\n");
  await store.write(big, bigText);
  const parts = [];
  let offset;
  let calls = 0;
  let last;
  do {
    last = await tools.dataroomReadTool.execute(offset === undefined ? { path: big } : { path: big, offset }, ctx);
    parts.push(last.content);
    offset = last.nextOffset;
    calls++;
  } while (offset !== undefined && calls < 50);
  check(`a ${bigText.length.toLocaleString("en-US")}-character file: ${calls} pages, which rebuild it byte for byte`, parts.join("") === bigText && calls > 1, { calls });
  check("each page carries offset, totalChars and more; all but the last nextOffset", calls > 1 && last.totalChars === bigText.length && typeof last.more === "string" && last.nextOffset === undefined);
  check(`no page is over the page size (${DEFAULT_PAGE_CHARS})`, parts.every((p) => p.length <= DEFAULT_PAGE_CHARS));

  const jsonl = `${FOLDER.accounts}/acme-bank/interactions.jsonl`;
  const recs = Array.from({ length: 900 }, (_, i) => ({ id: `r${i}`, at: "2026-10-10", summary: "s".repeat(80) }));
  for (const r of recs) await store.appendJsonl(jsonl, r);
  const seen = [];
  offset = undefined;
  calls = 0;
  do {
    last = await tools.dataroomReadTool.execute(offset === undefined ? { path: jsonl } : { path: jsonl, offset }, ctx);
    seen.push(...last.records);
    offset = last.nextOffset;
    calls++;
  } while (offset !== undefined && calls < 50);
  check(`a ${recs.length}-record .jsonl: ${calls} pages of whole records, every record once, in order`, calls > 1 && JSON.stringify(seen.map((r) => r.id)) === JSON.stringify(recs.map((r) => r.id)), { calls, seen: seen.length });
  check("…the last page says how many records there are", last.totalRecords === recs.length);

  for (let i = 0; i < 700; i++) await store.write(`${FOLDER.accounts}/syncs/bulk/item-${String(699 - i).padStart(4, "0")}-with-a-long-enough-name.md`, `item ${i}\n`);
  const listed = [];
  offset = undefined;
  calls = 0;
  do {
    last = await tools.dataroomListTool.execute(offset === undefined ? { prefix: `${FOLDER.accounts}/syncs/bulk` } : { prefix: `${FOLDER.accounts}/syncs/bulk`, offset }, ctx);
    listed.push(...last.paths);
    offset = last.nextOffset;
    calls++;
  } while (offset !== undefined && calls < 50);
  const all = await store.list(`${FOLDER.accounts}/syncs/bulk`);
  check(`a ${all.length}-path listing: ${calls} pages, sorted, every path once`, calls > 1 && JSON.stringify(listed) === JSON.stringify([...all].sort()) && new Set(listed).size === all.length, { calls, listed: listed.length });
  check("…with totalPaths and the note on how to read on", last.totalPaths === all.length && /the end/.test(last.more));
  const smallList = await tools.dataroomListTool.execute({ prefix: `${FOLDER.accounts}/acme-bank` }, ctx);
  check("a short listing: exactly { paths }, as before", JSON.stringify(Object.keys(smallList)) === JSON.stringify(["paths"]) && smallList.paths.length === 3, smallList);
}

console.log(`\ntest-dataroom-paging: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

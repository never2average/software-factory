/**
 * The whole attachment path, end to end, against the real deployment.
 *
 * This path broke FOUR separate ways in one afternoon and every failure was
 * found by a human looking at a screenshot:
 *
 *   1. the file was base64-inlined into the turn (840KB) and killed it;
 *   2. the upload wrote to the legacy blob prefix while the agent read from the
 *      workspace prefix — a successful upload the agent could not see;
 *   3. the browser could not re-fetch its own data URL (CSP connect-src), so
 *      the upload never fired at all;
 *   4. the agent-facing paths rendered inside the user's own message bubble.
 *
 * None of the 39 source-text checks in test-chat-persistence could catch any of
 * them: they assert that code LOOKS right. This one attaches a real .xlsx,
 * uploads it through the real route, and makes a real agent read it back.
 *
 * The offline half (message composition) also runs in CI via
 * test:chat-attachments. This half needs production credentials and a live
 * agent, so it is a command you run — deliberately, before trusting the path.
 *
 *   npm run test:attachment-e2e
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateRawSync, crc32 } from "node:zlib";

const WEB = process.env.WEB_ORIGIN ?? "https://delivered.example.com";
process.env.AUTH_JWT_PRIVATE_KEY ||= readFileSync(".auth-jwt-private.b64", "utf8").trim();
const { mintSessionToken } = await import("../lib/auth-session.ts");
const { composeAttachmentMessage, visibleText } = await import("../lib/chat-attachments.ts");

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

/**
 * A REAL .xlsx — a zip container with the parts Excel requires. Not a renamed
 * text file: a fake would pass the upload and then fail the only step that
 * matters, the agent parsing it, and the test would blame the wrong thing.
 */
function buildXlsx(rows) {
  const files = [
    ["[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ["_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Roster" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/worksheets/sheet1.xml",
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
        .map((cells, r) =>
          `<row r="${r + 1}">${cells
            .map((v, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`)
            .join("")}</row>`)
        .join("")}</sheetData></worksheet>`],
  ];
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, "utf8");
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

// A value the model can only know by actually parsing the sheet.
const CANARY = `CANARY-${Math.abs(Date.now() % 100000)}`;
const xlsx = buildXlsx([
  ["name", "team", "code"],
  ["Ada Lovelace", "platform", CANARY],
  ["Alan Turing", "research", "ZZZ-000"],
]);

console.log(`Attachment end-to-end against ${WEB}`);
console.log(`  workbook: ${xlsx.length} bytes, canary ${CANARY}\n`);
check("the generated workbook is a real zip (PK header)", xlsx.subarray(0, 2).toString() === "PK");

const token = await mintSessionToken("operator@example.com");
const filename = `e2e-roster-${CANARY}.xlsx`;

/* ---- 1. upload through the real route ----------------------------------- */
const form = new FormData();
form.append("file", new Blob([xlsx], { type: XLSX_MIME }), filename);
const upload = await fetch(`${WEB}/api/ops/upload`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: form,
  signal: AbortSignal.timeout(120000),
});
check(`upload returns 200 (got ${upload.status})`, upload.ok);
const uploaded = await upload.json();
check("upload returns a data-room path", typeof uploaded.path === "string" && uploaded.path.length > 0);
check("the stored size matches the file", uploaded.size === xlsx.length);
console.log(`       → ${uploaded.path}`);

/* ---- 2. the message the client would build ------------------------------ */
const userText = "Please read this workbook and tell me the code for Ada Lovelace.";
const message = composeAttachmentMessage(userText, [{ name: filename, path: uploaded.path }]);
check("the model is given the data-room path", message.includes(uploaded.path));
check("the reader sees ONLY their own words", visibleText(message) === userText);
check("no path leaks into the visible text", !visibleText(message).includes("Uploads/"));

/* ---- 3. a real turn, and the agent must actually read it ---------------- */
const started = await fetch(`${WEB}/eve/v1/session`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ message }),
  signal: AbortSignal.timeout(60000),
});
check(`the turn is accepted (got ${started.status})`, started.ok);
const { sessionId } = await started.json();

/**
 * Read the turn the way the CLIENT does: resume at the cursor when a segment
 * ends without a terminal event.
 *
 * The stream is severed on a hard ~120s boundary. eve's browser client reopens
 * at the advanced index; a naive single-read reports "no terminal event" and
 * blames the product for a limit of its own making. This test made exactly that
 * mistake on its first run.
 */
let answer = "", tools = [], errors = [], terminal = "", index = 0, segments = 0;
/**
 * Four segments (~8 minutes) is the budget.
 *
 * The first full run spent 12 segments — 24 minutes — and never terminated, for
 * a question asking for one cell value. That is worth FAILING on quickly rather
 * than waiting out: a trivial request that never ends is the finding, not an
 * excuse to keep reading.
 */
const MAX_SEGMENTS = 4;
for (let attempt = 0; attempt < MAX_SEGMENTS && !terminal; attempt++) {
  segments++;
  const res = await fetch(`${WEB}/eve/v1/session/${sessionId}/stream?startIndex=${index}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok || !res.body) break;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      index++;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "actions.requested") for (const a of e.data?.actions ?? []) tools.push(a?.name ?? a?.toolName ?? "?");
      if (e.type === "action.result" && e.data?.isError) errors.push(String(e.data?.result ?? "").slice(0, 160));
      if (e.type === "message.completed" && typeof e.data?.message === "string") answer = e.data.message;
      if (["turn.completed", "session.completed", "turn.failed"].includes(e.type)) { terminal = e.type; break; }
    }
    if (terminal) break;
  }
  await reader.cancel().catch(() => {});
  if (!terminal) console.log(`  … segment ${segments} ended at ${index} events, resuming`);
}

console.log(`\n  tools: ${[...new Set(tools)].join(", ") || "(none)"}`);
if (errors.length) console.log(`  tool errors: ${errors[0]}`);
if (!terminal) {
  console.log(
    `\n  ✗ No terminal event after ${segments} segment(s) (~${segments * 2} minutes).\n` +
      `    The turn is still running. Tools it reached for: ${[...new Set(tools)].join(", ")}.\n` +
      "    eve's loop has no total-step ceiling (stopWhen: isStepCount(1) per model call),\n" +
      "    so a turn ends only when the model stops asking for tools.",
  );
}
check(`the turn completed (got ${terminal || "no terminal event"}, ${segments} segment(s))`, terminal === "turn.completed");
check("no sandbox provisioning error", !errors.some((e) => /not provisioned/i.test(e)));
check("the agent read the file from the data room", tools.some((t) => /dataroom|read/i.test(t)));
// The only proof it PARSED the workbook rather than guessing.
check(`the answer contains the canary from inside the sheet (${CANARY})`, answer.includes(CANARY));

console.log(`\nattachment end-to-end: ${passed}/${passed} checks passed`);

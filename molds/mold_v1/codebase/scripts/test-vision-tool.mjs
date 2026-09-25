/**
 * VISION IS A TOOL, NOT A PROPERTY OF THE ORCHESTRATOR.
 *
 * The orchestrator was `@cf/moonshotai/kimi-k2.6` for one reason — it reads
 * images — and it started returning MODEL_CALL_FAILED ("Empty model response")
 * on real uploads, so the fleet moved to `@cf/zai-org/glm-5.3`, which is
 * text-only. Every check below is one of the ways that trade can quietly come
 * back:
 *
 *   1. the tool is absent from what SHIPS (the pack applies specialists INTO
 *      agent/subagents/, so a check that reads the checked-in tree only is not
 *      reading the deployment — that has certified an unfixed deployment green
 *      here once already);
 *   2. the vision role silently resolves to the fleet's text-only model, which
 *      does not error — it answers "I cannot see the image", and that reaches
 *      an analyst as a wrong answer rather than a missing capability;
 *   3. the tool is present on a deployment with no vision model, so the model
 *      calls it and burns a turn per attempt;
 *   4. someone adds a base64 input, which is the request shape that has been
 *      failing on this account;
 *   5. the image reaches the provider as text, or not at all;
 *   6. an empty completion kills the turn again instead of being one refusal;
 *   7. a scan renders unbounded and the turn hangs instead of saying no;
 *   8. the data-room reader reaches a path `dataroom_read` would refuse.
 *
 * Nothing here calls a real provider: scripts/fake-model-server.mjs answers on
 * the OpenAI-compatible endpoint `agent/lib/model.ts` builds from
 * CLOUDFLARE_BASE_URL, and a stub `fitz` stands in for pymupdf so the REAL
 * renderer runs with no wheel download and no network.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import zlib from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
const check = (what, ok) => {
  assert.ok(ok, what);
  console.log(`  ok   ${what}`);
  passed++;
};

// The data room must be a scratch tree, chosen BEFORE anything imports the store
// (it reads DATAROOM_DIR once, at module load).
const WORK = mkdtempSync(join(tmpdir(), "vision-test-"));
process.env.DATAROOM_DIR = join(WORK, "dataroom");
delete process.env.BLOB_READ_WRITE_TOKEN; // local filesystem backend, no credentials
delete process.env.DATABASE_URL; // no tenancy tables -> every caller resolves to org #1
process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
process.env.CLOUDFLARE_API_TOKEN = "test-token";

/** A free port, taken and released, so two runs in parallel cannot collide. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
const PORT = await freePort();
process.env.CLOUDFLARE_BASE_URL = `http://127.0.0.1:${PORT}/v1`;

/**
 * The scripted provider, on ONE port, restartable.
 *
 * The provider's base URL is frozen when agent/lib/model.ts is imported, so the
 * way to drive two different provider behaviours in one process is to change
 * what is listening, not where the client points.
 */
let modelServer = null;
async function useModelScript(script) {
  if (modelServer) {
    modelServer.kill();
    await new Promise((resolve) => modelServer.once("exit", resolve));
  }
  modelServer = spawn(
    process.execPath,
    [join(ROOT, "scripts/fake-model-server.mjs"), "--port", String(PORT), "--script", script],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (String(chunk).includes(`script=${script}`)) {
        modelServer.stderr.off("data", onData);
        resolve();
      }
    };
    modelServer.stderr.on("data", onData);
    modelServer.once("error", reject);
  });
}

/**
 * Every request body the scripted provider has received, from its `GET /__requests`
 * recorder (added by the empty-model-response work). It is the only way to see what
 * the WHOLE stack put on the wire — including the retries and any fallback the
 * recovery middleware makes on its own, which the tool's return value cannot show.
 */
async function recordedRequests() {
  const response = await fetch(`http://127.0.0.1:${PORT}/__requests`);
  return await response.json();
}

/** Run a snippet in a fresh process with a given environment; returns its parsed JSON line. */
function inFreshProcess(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code],
      { cwd: ROOT, env: { ...process.env, ...env } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("exit", (code) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`no output (exit ${code}): ${err}`));
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`${error.message}\nstdout: ${out}\nstderr: ${err}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 1. What SHIPS declares the tool, and declares it gated
// ---------------------------------------------------------------------------
console.log("\nThe tool ships, everywhere it is declared:");

const rootDeclaration = readFileSync(join(ROOT, "agent/tools/read_image.ts"), "utf8");
check("agent/tools/read_image.ts declares the tool (eve names it from the filename)", rootDeclaration.includes("readImageTool"));
check("...named read_image, carrying no product role word", !/fde/i.test("read_image"));

/**
 * Every declaring site, not just the root one.
 *
 * ENABLE_WEB_SEARCH is the precedent and the warning: `web_search` is declared
 * in four places, and gating only the root left three subagents on the open web
 * while the flag read "off". A pack's subagents are declaring sites too, which
 * is why this WALKS for the filename rather than listing the known ones — a
 * pack applied into agent/subagents/ is inside the walk either way.
 */
async function declaringSites(dir, found = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await declaringSites(full, found);
    else if (entry.name === "read_image.ts" && dirname(full).endsWith("/tools")) found.push(full);
  }
  return found;
}
const sites = await declaringSites(join(ROOT, "agent"));
check("read_image is declared somewhere under agent/**/tools/", sites.length >= 1);
for (const site of sites) {
  const source = readFileSync(site, "utf8");
  check(
    `${site.slice(ROOT.length)} gates on VISION_ENABLED (otherwise ENABLE_VISION=false leaves this caller calling a model that is not there)`,
    source.includes("VISION_ENABLED") && source.includes("disableTool"),
  );
}
check(
  "check:subagents enforces that gate on a pack's subagents too",
  readFileSync(join(ROOT, "scripts/check-subagents.py"), "utf8").includes("read_image.ts"),
);

// ---------------------------------------------------------------------------
// 2. The model role
// ---------------------------------------------------------------------------
console.log("\nThe vision role and its default:");

const modelIds = (env) =>
  inFreshProcess(
    `const m = await import("./agent/lib/model.ts");
     console.log(JSON.stringify({
       vision: m.agentModelId("vision"),
       orchestrator: m.agentModelId("orchestrator"),
       specialist: m.agentModelId("specialist"),
       configured: m.visionModelConfigured(),
     }));`,
    env,
  );

const defaults = await modelIds({ CLOUDFLARE_MODEL: "", CLOUDFLARE_MODEL_VISION: "" });
const VISION_MODEL = "@cf/zai-org/glm-5.3-flash";
check(`the default vision model is GLM 5.3 Flash (saw ${defaults.vision})`, defaults.vision === VISION_MODEL);

const overridden = await modelIds({ CLOUDFLARE_MODEL_VISION: "@cf/meta/llama-4-scout" });
check("CLOUDFLARE_MODEL_VISION overrides it, like every other role", overridden.vision === "@cf/meta/llama-4-scout");

/**
 * THE REGRESSION THIS WHOLE CHANGE EXISTS TO PREVENT. The fleet variable names
 * the text-only model. If `vision` chained to it the way `specialist` does, the
 * tool would keep working and keep answering "I cannot see the image".
 */
const fleet = await modelIds({ CLOUDFLARE_MODEL: "@cf/zai-org/glm-5.3", CLOUDFLARE_MODEL_VISION: "" });
check("the fleet variable moves the orchestrator", fleet.orchestrator === "@cf/zai-org/glm-5.3");
check("...and the specialist", fleet.specialist === "@cf/zai-org/glm-5.3");
check("...and does NOT drag the vision role onto a text-only model", fleet.vision === VISION_MODEL);

// ---------------------------------------------------------------------------
// 3. No vision model configured -> the tool is ABSENT, not present and failing
// ---------------------------------------------------------------------------
console.log("\nWith no vision model, the tool is absent rather than broken:");

/**
 * `agent/tools/read_image.ts` is `VISION_ENABLED ? readImageTool : disableTool()`
 * and nothing else (asserted above), so the flag IS the presence. It is read in a
 * fresh process per case because both inputs are read once, at module load — which
 * is also why flipping one needs a redeploy and not just an environment change.
 */
const toolPresence = (env) =>
  inFreshProcess(
    `const { VISION_ENABLED } = await import("./agent/lib/feature-flags.ts");
     console.log(JSON.stringify({ present: VISION_ENABLED }));`,
    env,
  );

check("ENABLE_VISION=false removes it", !(await toolPresence({ ENABLE_VISION: "false" })).present);
check("CLOUDFLARE_MODEL_VISION=off removes it", !(await toolPresence({ CLOUDFLARE_MODEL_VISION: "off" })).present);
check("CLOUDFLARE_MODEL_VISION=none removes it", !(await toolPresence({ CLOUDFLARE_MODEL_VISION: "none" })).present);
/**
 * A Vercel variable marked Sensitive pulls down as an EMPTY STRING — the trap
 * .env.example already documents for the provider choice, where it once ran the
 * whole fleet on the wrong provider. Empty must mean "unset", or a capability
 * disappears from a deployment because of how a value was stored.
 */
check(
  "an EMPTY CLOUDFLARE_MODEL_VISION means unset, not off",
  (await toolPresence({ CLOUDFLARE_MODEL_VISION: "" })).present,
);
check("and with neither set it is present", (await toolPresence({})).present);

// ---------------------------------------------------------------------------
// 4. The input is a REFERENCE, never a payload
// ---------------------------------------------------------------------------
console.log("\nThe model hands over a reference, never bytes:");

const { readImageTool } = await import("../agent/lib/vision-tools.ts");
// The budget this deployment gives the vision role, from the one place that
// decides it (agent/lib/model-output-budget.ts) — asserted at the wire below.
const { modelOutputBudgetTokens } = await import("../agent/lib/model.ts");
const visionBudget = modelOutputBudgetTokens("vision");
const shape = readImageTool.inputSchema.shape ?? readImageTool.inputSchema._def?.shape?.() ?? {};
const fields = Object.keys(shape);
check("its inputs are the reference, the question and the page bounds", fields.length > 0);
/**
 * A RATCHET. An image field would inflate every request that carries one, has to
 * be generated token by token by the model, and is the exact shape that has been
 * returning "Empty model response" on this account.
 */
for (const forbidden of ["image", "imageData", "base64", "bytes", "data", "content", "payload", "url"]) {
  check(`no \`${forbidden}\` input — the model can never inline an image`, !fields.includes(forbidden));
}
check("`path` (data room) is an input", fields.includes("path"));
check("`sandboxPath` (the caller's own sandbox) is an input", fields.includes("sandboxPath"));
check(`pageCount is capped in the schema`, !readImageTool.inputSchema.safeParse({ question: "q", sandboxPath: "/x", pageCount: 9 }).success);

// ---------------------------------------------------------------------------
// A sandbox that is a real directory with a translated root
// ---------------------------------------------------------------------------
/**
 * eve's SandboxSession is a filesystem in ANOTHER namespace: `/workspace` there
 * is not `/workspace` here. The fake reproduces exactly that by translating the
 * prefix — including inside the params file the renderer reads, because those
 * paths are the sandbox's, not this machine's. Nothing in the tool changes for
 * the test; only where its `/workspace` lands.
 */
function fakeSandbox(root, { env = {} } = {}) {
  // Idempotent: the renderer reports paths that were already translated when the
  // params file was written, and translating them twice would look like a missing file.
  const map = (p) => (p.startsWith(root) ? p : join(root, p.replace(/^\//, "")));
  const calls = [];
  return {
    calls,
    async run({ command }) {
      calls.push(command);
      return await new Promise((resolve) => {
        const child = spawn("sh", ["-c", command.replaceAll("/workspace", join(root, "workspace"))], {
          env: { ...process.env, ...env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        child.on("exit", (exitCode) => resolve({ exitCode, stdout, stderr }));
      });
    },
    async readBinaryFile({ path }) {
      try {
        return new Uint8Array(await fs.readFile(map(path)));
      } catch {
        return null;
      }
    },
    async writeBinaryFile({ path, content }) {
      await fs.mkdir(dirname(map(path)), { recursive: true });
      await fs.writeFile(map(path), content);
    },
    async writeTextFile({ path, content }) {
      await fs.mkdir(dirname(map(path)), { recursive: true });
      await fs.writeFile(map(path), content.replaceAll("/workspace", join(root, "workspace")));
    },
  };
}

/** A real, valid PNG of `size` bytes (padded with an ancillary chunk). */
function png(size = 0) {
  const crc = (buf) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (tag, data) => {
    const body = Buffer.concat([Buffer.from(tag), data]);
    const out = Buffer.alloc(4);
    out.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([out, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0, 0, 0]))),
  ];
  const base = Buffer.concat([...parts, chunk("IEND", Buffer.alloc(0))]).length;
  if (size > base + 12) parts.push(chunk("teXt", Buffer.alloc(size - base - 12, 0x61)));
  return Buffer.concat([...parts, chunk("IEND", Buffer.alloc(0))]);
}
const ctxWith = (sandbox) => ({ session: { id: "s", auth: { current: null, initiator: null } }, getSandbox: async () => sandbox });

// ---------------------------------------------------------------------------
// 5. The picture really reaches the provider, as an image, on the vision model
// ---------------------------------------------------------------------------
console.log("\nAn image reaches the vision model as an image:");

await useModelScript("vision");
{
  const root = join(WORK, "sb-image");
  const sandbox = fakeSandbox(root);
  await sandbox.writeBinaryFile({ path: "/workspace/page.png", content: png(400) });
  const result = await readImageTool.execute(
    { question: "What is the sanctioned amount?", sandboxPath: "/workspace/page.png" },
    ctxWith(sandbox),
  );
  check("a sandbox image is read", result.read === true);
  check("exactly ONE image part arrived at the provider", / images=1 /.test(result.answer));
  check("...as image/png, not as text", /types=image\/png/.test(result.answer));
  check("...on the VISION model, not the orchestrator's", result.answer.includes(`model=${VISION_MODEL} `));
  check("the tool reports which model answered", result.model === VISION_MODEL);
  check("and where it read from", result.source.kind === "sandbox" && result.source.path === "/workspace/page.png");

  /**
   * AND WITH ENOUGH ROOM TO ANSWER IN. This call shipped with
   * `maxOutputTokens: 1_500`, commented "a page description, not a report" —
   * sized for the ANSWER on a model that pays for its thinking out of the same
   * budget. The live row of 2026-09-23 is that number twice over:
   *
   *     model=@cf/moonshotai/kimi-k2.6  path=generate
   *     finish=length  in=2999  out=1500  out_thinking=1500
   *
   * — the whole budget spent thinking about one scanned page, no description at
   * all, and `read_image` reporting "returned no text" on a page it could have
   * read. Asserted on the REQUEST BODY the provider received rather than on the
   * source, because the source saying what it sends is exactly the evidence that
   * was wrong last time.
   */
  const [request] = await recordedRequests();
  check(`the wire request names the vision model (saw model=${request?.model})`, request?.model === VISION_MODEL);
  check(
    `...and asks it for reasoning "low", not the provider's default of max (saw reasoning_effort=${request?.reasoning_effort ?? "absent"})`,
    request?.reasoning_effort === "low",
  );
  check(
    `the vision call asks for the vision ROLE's budget, not the 1,500 that burned itself out thinking (saw max_tokens=${request?.max_tokens ?? "absent"})`,
    request?.max_tokens === visionBudget,
  );
  check("…which is well clear of that 1,500", visionBudget >= 8_192);
}

// ---------------------------------------------------------------------------
// 5b. The reasoning level: sent only where it is known to be taken, and survivable
// ---------------------------------------------------------------------------
console.log("\nThe vision reasoning level, at the wire:");

/** One read of a small sandbox png under a given env, returning the tool result and what reached the wire. */
async function readUnder(env, script = "vision") {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await useModelScript(script);
    const root = join(WORK, `sb-reasoning-${Math.random().toString(36).slice(2)}`);
    const sandbox = fakeSandbox(root);
    await sandbox.writeBinaryFile({ path: "/workspace/page.png", content: png(400) });
    const result = await readImageTool.execute({ question: "read it", sandboxPath: "/workspace/page.png" }, ctxWith(sandbox));
    return { result, requests: await recordedRequests() };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
const effortsOf = (requests) => requests.map((r) => r.reasoning_effort ?? "absent").join(", ");

{
  const { result, requests } = await readUnder({ CLOUDFLARE_MODEL_VISION: "@cf/meta/llama-4-scout" });
  check("a vision model NOT on the reasoning allow-list is still read", result.read === true && requests[0]?.model === "@cf/meta/llama-4-scout");
  check(
    `...and is sent NO reasoning field, so an unprobed model cannot 400 on it (saw: ${effortsOf(requests)})`,
    requests.length === 1 && !("reasoning_effort" in requests[0]) && !("reasoning" in requests[0]),
  );
}
{
  const { requests } = await readUnder({ MODEL_REASONING_VISION: "high" });
  check(`MODEL_REASONING_VISION=high is what reaches the wire (saw: ${effortsOf(requests)})`, requests[0]?.reasoning_effort === "high");
}
{
  const { requests } = await readUnder({ MODEL_REASONING_VISION: "off" });
  check(`MODEL_REASONING_VISION=off sends no field (saw: ${effortsOf(requests)})`, requests.length === 1 && !("reasoning_effort" in requests[0]));
}
{
  const { requests } = await readUnder({ MODEL_REASONING_VISION: "" });
  check(`an EMPTY MODEL_REASONING_VISION means the default "low", not off (saw: ${effortsOf(requests)})`, requests[0]?.reasoning_effort === "low");
}
{
  const { result, requests } = await readUnder({}, "vision-refuses-reasoning");
  check("a provider that answers 4xx naming the reasoning field does not cost the read", result.read === true && /VISION-READ/.test(result.answer));
  check(
    `...because the call is made once more WITHOUT the field (saw: ${effortsOf(requests)})`,
    requests.length === 2 && requests[0].reasoning_effort === "low" && !("reasoning_effort" in requests[1]),
  );
  check("...on the same vision model both times", requests.every((r) => r.model === VISION_MODEL));
}
{
  // Not on the list, refusing: nothing was sent, so there is nothing to retry and one call is made.
  const { result, requests } = await readUnder({ CLOUDFLARE_MODEL_VISION: "@cf/meta/llama-4-scout" }, "vision-refuses-reasoning");
  check("a model off the list is never sent the field, so a refusing provider never refuses it", result.read === true && requests.length === 1);
}
check(
  "GLM 5.3 Flash is on the reasoning allow-list the empty-response recovery shares",
  (await import("../agent/lib/empty-model-response.ts")).RECOVERY_REASONING_MODELS.has(VISION_MODEL),
);
await useModelScript("vision");

// ---------------------------------------------------------------------------
// 6. The empty-response failure (first seen on Kimi K2.6), contained
// ---------------------------------------------------------------------------
console.log("\nAn empty completion is one refusal, not a dead turn:");

await useModelScript("vision-empty");
{
  const root = join(WORK, "sb-empty");
  const sandbox = fakeSandbox(root);
  await sandbox.writeBinaryFile({ path: "/workspace/page.png", content: png(400) });
  const result = await readImageTool.execute({ question: "read it", sandboxPath: "/workspace/page.png" }, ctxWith(sandbox));
  check("an empty model response does not throw out of the tool", result.read === false);
  check("...it comes back as a sentence naming the model", /returned no text/.test(result.error) && result.error.includes(VISION_MODEL));

  /**
   * THE RECOVERY'S LAST RESORT MUST NOT BECOME AN OBSERVATION.
   *
   * The empty-response middleware gives up by returning a sentence written FOR A
   * PERSON as the model's answer, so the chat finishes its turn rather than
   * parking. Reaching a tool result, that sentence would land in `answer` — this
   * tool reporting an apology as WHAT IT SAW IN THE DOCUMENT, which the
   * orchestrator then reasons about as a reading of a filing. A fabricated
   * observation is worse than the failure it replaces.
   */
  check("the recovery's human sentence is never returned as what the image says", result.answer === undefined);
  check(
    "...and does not appear anywhere in the result",
    !JSON.stringify(result).includes("Say \\\"carry on\\\""),
  );

  /**
   * AND IT MUST NOT HAVE ASKED A TEXT-ONLY MODEL. `fallbackFor` reads as "the other
   * role's model" but is written `orchestrator ? specialist : orchestrator`, so a
   * third role resolves to the orchestrator — here the text-only GLM 5.3. Asked to
   * read a picture it would answer "I cannot see the image", confidently, as this
   * tool's finding. Checked on the WIRE rather than in the source, because the
   * middleware chooses the fallback itself and the tool never learns it happened.
   */
  const models = [...new Set((await recordedRequests()).map((request) => request.model))];
  check(
    `every provider call for an image stayed on the vision model (saw: ${models.join(", ")})`,
    models.length === 1 && models[0] === VISION_MODEL,
  );
  check("...and it really did retry rather than give up on the first empty", (await recordedRequests()).length >= 2);
}
await useModelScript("vision");

// ---------------------------------------------------------------------------
// 7. A SCANNED pdf, end to end
// ---------------------------------------------------------------------------
console.log("\nA scanned pdf: no text layer in, an answer out:");

/** A stand-in for pymupdf, so the REAL renderer runs with no wheel and no network. */
const STUB_DIR = join(WORK, "pystub");
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(
  join(STUB_DIR, "fitz.py"),
  `import json, os, struct, zlib

CONF = json.load(open(os.environ["FITZ_STUB"]))

def _crc(data):
    return zlib.crc32(data) & 0xFFFFFFFF

def _chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", _crc(body))

def _png(size):
    head = b"\\x89PNG\\r\\n\\x1a\\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    head += _chunk(b"IDAT", zlib.compress(b"\\x00\\x00\\x00\\x00"))
    tail = _chunk(b"IEND", b"")
    pad = size - len(head) - len(tail) - 12
    if pad > 0:
        head += _chunk(b"teXt", b"a" * pad)
    return head + tail

class _Pixmap:
    def __init__(self, size):
        self._size = size
    def tobytes(self, fmt):
        return _png(self._size)

class _Page:
    def __init__(self, number):
        self.number = number
    def get_pixmap(self, dpi=72):
        return _Pixmap(CONF["bytesByDpi"][str(dpi)])
    def get_text(self):
        return CONF.get("text", {}).get(str(self.number + 1), "")

class _Doc:
    def __init__(self):
        self.page_count = CONF["pageCount"]
    def load_page(self, index):
        return _Page(index)

def open(path):
    if CONF.get("openFails"):
        raise RuntimeError("cannot open broken document")
    return _Doc()
`,
);
const stubConf = (conf) => {
  const file = join(WORK, `fitz-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(conf));
  return file;
};

/** 3 bytes of "%PDF" is all the tool's sniffer needs; the stub is what "opens" it. */
const FAKE_PDF = Buffer.from("%PDF-1.7\n% a scanned filing\n");

{
  const root = join(WORK, "sb-scan");
  const sandbox = fakeSandbox(root, {
    env: {
      PYTHONPATH: STUB_DIR,
      FITZ_STUB: stubConf({ pageCount: 40, bytesByDpi: { 150: 900, 110: 400, 80: 200 }, text: {} }),
    },
  });
  await sandbox.writeBinaryFile({ path: "/workspace/filing.pdf", content: FAKE_PDF });
  const result = await readImageTool.execute(
    { question: "Transcribe the borrowings table", sandboxPath: "/workspace/filing.pdf", page: 12, pageCount: 2 },
    ctxWith(sandbox),
  );
  check("a pdf with no text layer is read", result.read === true);
  check("the requested pages were rendered, and only those", result.renderedPages.map((p) => p.page).join() === "12,13");
  check("both rendered pages went to the model as images", / images=2 /.test(result.answer));
  check("the pdf's real page count comes back", result.pdfPageCount === 40);
  check("the render used the first dpi on the ladder", result.renderedPages.every((p) => p.dpi === 150));
  check(
    "and the agent is TOLD it was a scan (0 characters of text layer), which is why pdfplumber returned nothing",
    result.renderedPages.every((p) => p.textLayerChars === 0) && /is a scan/.test(result.note),
  );
}

{
  // A page that is too big at 150 dpi comes back COARSER, not refused: the useful
  // answer to a dense scan is a smaller picture of it.
  const root = join(WORK, "sb-ladder");
  const sandbox = fakeSandbox(root, {
    env: {
      PYTHONPATH: STUB_DIR,
      FITZ_STUB: stubConf({ pageCount: 1, bytesByDpi: { 150: 7_000_000, 110: 5_000, 80: 900 }, text: { 1: "hello" } }),
    },
  });
  await sandbox.writeBinaryFile({ path: "/workspace/dense.pdf", content: FAKE_PDF });
  const result = await readImageTool.execute({ question: "read it", sandboxPath: "/workspace/dense.pdf" }, ctxWith(sandbox));
  check("an oversized page is re-rendered coarser instead of failing", result.read === true && result.renderedPages[0].dpi === 110);
  check("a page WITH a text layer is not reported as a scan", result.note === undefined);
}

{
  // And when even the coarsest render is too big, it says so. The alternative is a
  // turn that sits there until the platform kills it.
  const root = join(WORK, "sb-huge");
  const sandbox = fakeSandbox(root, {
    env: {
      PYTHONPATH: STUB_DIR,
      FITZ_STUB: stubConf({ pageCount: 1, bytesByDpi: { 150: 7_000_000, 110: 7_000_000, 80: 7_000_000 }, text: {} }),
    },
  });
  await sandbox.writeBinaryFile({ path: "/workspace/huge.pdf", content: FAKE_PDF });
  const result = await readImageTool.execute({ question: "read it", sandboxPath: "/workspace/huge.pdf" }, ctxWith(sandbox));
  check("a page too big at every dpi is refused in words, with the limit", result.read === false && /larger than 6291456 bytes/.test(result.error));
}

{
  // Asking for page 900 of a 3-page filing must say how many pages there are.
  const root = join(WORK, "sb-range");
  const sandbox = fakeSandbox(root, {
    env: { PYTHONPATH: STUB_DIR, FITZ_STUB: stubConf({ pageCount: 3, bytesByDpi: { 150: 400 }, text: {} }) },
  });
  await sandbox.writeBinaryFile({ path: "/workspace/short.pdf", content: FAKE_PDF });
  const result = await readImageTool.execute({ question: "read it", sandboxPath: "/workspace/short.pdf", page: 900 }, ctxWith(sandbox));
  check("a page past the end names the real page count", result.read === false && /this pdf has 3 page\(s\)/.test(result.error));
}

/** Does THIS machine have pymupdf? The no-library case is only meaningful where it does not. */
const hostHasFitz = await new Promise((resolve) => {
  const probe = spawn("python3", ["-c", "import fitz"]);
  probe.on("exit", (code) => resolve(code === 0));
  probe.on("error", () => resolve(false));
});
if (hostHasFitz) {
  console.log("  skip pymupdf is installed on this machine; the missing-library case needs one without it");
} else {
  // The renderer must work in a sandbox that never got pymupdf — every SUBAGENT
  // owns its own sandbox, and a pack ships more of them.
  const root = join(WORK, "sb-nolib");
  const sandbox = fakeSandbox(root, { env: { PYTHONPATH: "", FITZ_STUB: "", PIP_NO_INDEX: "1" } });
  await sandbox.writeBinaryFile({ path: "/workspace/x.pdf", content: FAKE_PDF });
  const result = await readImageTool.execute({ question: "read it", sandboxPath: "/workspace/x.pdf" }, ctxWith(sandbox));
  check(
    "with no pymupdf and no index to install from, the failure is a sentence rather than a hang",
    result.read === false && /pymupdf/.test(result.error),
  );
  check(
    "...and it TRIED to install it first (a missing library never ends a task)",
    readFileSync(join(ROOT, "agent/lib/vision-tools.ts"), "utf8").includes("--break-system-packages"),
  );
}

check(
  "the main chat's sandbox pre-installs pymupdf, so a cold turn does not pay for the wheel",
  /^PKGS=".*\bpymupdf\b.*"$/m.test(readFileSync(join(ROOT, "agent/sandbox.ts"), "utf8")),
);
check(
  "...and VERIFIES it after the install, like every other document library",
  readFileSync(join(ROOT, "agent/sandbox.ts"), "utf8").includes('("fitz","pymupdf")'),
);

// ---------------------------------------------------------------------------
// 8. Access control: the same door as dataroom_read, never a wider one
// ---------------------------------------------------------------------------
console.log("\nAn image is readable only by someone who can already read it:");

const { getDataroomStore } = await import("../agent/lib/dataroom-store.ts");

// A real image at a real data-room path, written through the store itself.
const store = getDataroomStore();
const IMAGE_PATH = "Uploads/priya-example-in/scan.png";
await fs.mkdir(join(process.env.DATAROOM_DIR, "Uploads/priya-example-in"), { recursive: true });
await fs.writeFile(join(process.env.DATAROOM_DIR, IMAGE_PATH), png(500));

const ctx = ctxWith(fakeSandbox(join(WORK, "sb-dr")));
{
  const result = await readImageTool.execute({ question: "what does it say?", path: IMAGE_PATH }, ctx);
  check("a data-room image is read with no sandbox round trip", result.read === true && result.source.kind === "dataroom");
  check("...and it is the bytes, not a UTF-8 decoding of them", / images=1 /.test(result.answer) && /types=image\/png/.test(result.answer));
}

/**
 * THE EQUIVALENCE. Not "read_image validates paths" — a second implementation of
 * the check is exactly how two doors drift apart — but "read_image accepts
 * exactly the set the store accepts", the store being the door `dataroom_read`
 * goes through and the only place DATAROOM_PATH_TEMPLATES is enforced.
 * `dataroom_read`'s own body is asserted below to be that same call and no path
 * handling of its own, so the set really is the set an analyst can already read.
 */
const readerSource = readFileSync(join(ROOT, "agent/lib/dataroom-tools.ts"), "utf8");
check(
  "dataroom_read is storeForSession + store.read, with no path handling of its own",
  /dataroomReadTool[\s\S]{0,900}await storeForSession\(ctx\)[\s\S]{0,400}store\.read\(path\)/.test(readerSource),
);

const PROBES = [
  IMAGE_PATH,
  "Uploads/priya-example-in/../../etc/passwd",
  "../../etc/passwd",
  "/etc/passwd",
  "Secrets/keys.png",
  "Uploads/../Uploads/priya-example-in/scan.png",
  "https://example.com/x.png",
  "Customers/acme-bank/context.md",
  "Customers/acme-bank/nope.png",
];
for (const probe of PROBES) {
  let storeRefusal = null;
  try {
    await store.read(probe);
  } catch (error) {
    storeRefusal = error.message;
  }
  const viaImage = await readImageTool.execute({ question: "q", path: probe }, ctx);
  const imageRefusal = viaImage.read === false ? viaImage.error : null;
  check(
    `"${probe}" is ${storeRefusal ? "refused" : "accepted"} by the data-room door, and read_image agrees`,
    storeRefusal ? imageRefusal === storeRefusal : true,
  );
}

/**
 * And the workspace, which is the part a path check cannot express. `read_image`
 * must resolve its store from the SESSION, never call getDataroomStore() bare —
 * that shape (three other call sites in this repo still use it) reads org #1's
 * data room for every caller, and the only symptom is a suspiciously
 * well-informed answer. The cross-tenant behaviour proper needs Postgres and is
 * the isolation lane's job; this is the ratchet in front of it.
 */
const visionSource = readFileSync(join(ROOT, "agent/lib/vision-tools.ts"), "utf8");
check(
  "read_image resolves its data-room store from the caller's session",
  visionSource.includes("storeForSession(ctx)"),
);
check(
  "...and never opens a store of its own",
  !/getDataroomStore\s*\(/.test(visionSource) && !/createDataroomStore/.test(visionSource),
);
check(
  "the byte read goes through the store, which validates the path before any backend sees it",
  readFileSync(join(ROOT, "agent/lib/dataroom-store.ts"), "utf8").includes(
    "async readBytes(path: string): Promise<Uint8Array | null> {\n    validateDataroomPath(path);",
  ),
);

// ---------------------------------------------------------------------------
// 9. Inputs that are neither, and inputs that are both
// ---------------------------------------------------------------------------
console.log("\nAmbiguous and unusable inputs:");

check(
  "both sources at once is refused rather than silently preferring one",
  (await readImageTool.execute({ question: "q", path: IMAGE_PATH, sandboxPath: "/workspace/x.png" }, ctx)).error?.includes("exactly one"),
);
check(
  "neither source is refused",
  (await readImageTool.execute({ question: "q" }, ctx)).error?.includes("exactly one"),
);
{
  const root = join(WORK, "sb-notimage");
  const sandbox = fakeSandbox(root);
  await sandbox.writeBinaryFile({ path: "/workspace/book.xlsx", content: Buffer.from("PK\u0003\u0004rest-of-a-zip") });
  const result = await readImageTool.execute({ question: "q", sandboxPath: "/workspace/book.xlsx" }, ctxWith(sandbox));
  check("a spreadsheet is identified by its BYTES and sent back to the sandbox", result.read === false && /not an image or a pdf/.test(result.error));
}
{
  const root = join(WORK, "sb-big");
  const sandbox = fakeSandbox(root);
  await sandbox.writeBinaryFile({ path: "/workspace/huge.png", content: png(7_000_000) });
  const result = await readImageTool.execute({ question: "q", sandboxPath: "/workspace/huge.png" }, ctxWith(sandbox));
  check("an image over the per-image limit is refused with the number", result.read === false && /the limit is 6291456/.test(result.error));
}

// ---------------------------------------------------------------------------
// 10. The agent is told, inside the budget
// ---------------------------------------------------------------------------
console.log("\nThe agent knows when to reach for it:");

// The root prompt as the model gets it: rendered from the profile (agent/instructions.ts).
const instructions = (await import("../agent/lib/root-instructions.ts")).renderRootInstructions();
check("the instructions name read_image", instructions.includes("read_image"));
check("...and say the thing that is not obvious: an empty text extraction means a SCAN", /SCAN/.test(instructions));
check(
  "the stable prompt is still inside its 1,400-word budget",
  instructions.trim().split(/\s+/).length <= 1_400,
);

modelServer?.kill();
console.log(`\nvision tool: ${passed}/${passed} checks passed`);

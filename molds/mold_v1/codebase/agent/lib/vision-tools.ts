/**
 * `read_image` — image understanding as a TOOL CALL backed by a vision-language
 * model, instead of as a property of the orchestrator.
 *
 * WHY THIS EXISTS. This deployment's orchestrator was `@cf/moonshotai/kimi-k2.6`
 * for one reason: it reads images, and the chat sends an upload as a file part,
 * so a text-only orchestrator answers "I cannot see the image". Kimi then began
 * returning MODEL_CALL_FAILED — "Empty model response" — on real uploads, and
 * the fleet moved to `@cf/zai-org/glm-5.3` (text-only, 1.31M context, reliable),
 * which bought reliability with the loss of image understanding. Making vision a
 * tool ends the trade: the orchestrator is picked for reasoning, a VLM is called
 * once per image rather than on every turn of every thread, and a VLM that
 * returns nothing costs ONE tool result the agent can act on instead of killing
 * the turn.
 *
 * WHAT IT DOES NOT TAKE: bytes. The input is a REFERENCE to something already in
 * the system — a data-room path or a path in the caller's own sandbox — and never
 * a base64 payload from the model. A model-supplied payload would have to be
 * generated token by token into the request, is the exact shape that has been
 * failing on this account, and would put an image the workspace never stored
 * into a tool call. scripts/test-vision-tool.mjs holds that as a ratchet.
 *
 * NOT ON THE MCP SURFACE (setup/fde-tools.mjs), deliberately. That surface serves
 * a coding assistant running on someone's laptop, over a transport with no
 * `ctx.getSandbox()` — so the pdf render, which is most of this tool's value,
 * could not run there at all. And the assistants that connect to it already read
 * images natively; advertising a 60th tool that pays a VLM to do worse what the
 * caller does for free is a cost with no buyer. If a text-only assistant ever
 * needs it, the honest shape is a server-side render, not this tool moved.
 *
 * SCANNED PDFs are the highest-value case, not an afterthought: SEBI filings are
 * routinely scans with no text layer, where `pdfplumber` returns the empty string
 * and the agent has had no recourse at all. A pdf source is rendered to a png in
 * the caller's sandbox (pymupdf, pre-installed by agent/sandbox.ts and
 * self-installed anywhere else) and the png is what the VLM sees.
 */
import { generateText } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";
// Relative `.ts` specifiers, not `#lib/*.js`: the latter resolve only through eve's
// bundler, so a module that uses them cannot be imported by the offline tests — and an
// access-control rule no test can execute is a comment. model.ts and dataroom-versions.ts
// already import this way.
import { DataroomPathError } from "./dataroom-store.ts";
import { LAST_RESORT_SENTENCE } from "./empty-model-response.ts";
import { storeForSession } from "./dataroom-session.ts";
import { agentModel, agentModelId, modelOutputBudgetTokens } from "./model.ts";
import type { SessionCtxLike } from "./org-context.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";

/**
 * BOUNDS. Every one of these turns a turn that would hang into a sentence the
 * agent can read and act on. A hung turn delivers nothing however much work went
 * into it, so the honest refusal is strictly better than the optimistic attempt.
 */
/** Pages rendered in one call. Four fits a filing's table across a spread; forty is a different tool. */
const MAX_PAGES_PER_CALL = 4;
/** Per image. A 150-dpi A4 page is ~700 KB; 6 MB is a wide margin over that and well under any provider cap. */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** Across all images in one call — four 6 MB pages would be a 32 MB base64 request body. */
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
/** The VLM call. Longer than a normal turn's patience, shorter than the platform's request ceiling. */
const VISION_TIMEOUT_MS = 120_000;
/** The render, including a pip install of pymupdf in a sandbox that lacks it (~30 s cold). */
const RENDER_TIMEOUT_MS = 180_000;
/**
 * THE OUTPUT BUDGET IS NO LONGER A NUMBER IN THIS FILE.
 *
 * It used to be `const MAX_OUTPUT_TOKENS = 1_500`, commented "a page
 * description, not a report" — a number sized for the ANSWER. On 2026-09-23 that
 * is precisely what this call returned:
 *
 *     model=@cf/moonshotai/kimi-k2.6  path=generate
 *     finish=length  in=2999  out=1500  out_thinking=1500
 *
 * All 1,500 tokens went on THINKING about a scanned page and the description was
 * never reached — `read_image` reported "returned no text" on a page it could
 * have read, over and over, all day. On a reasoning model the output budget buys
 * the thinking first and the answer out of what is left, so it cannot be sized
 * from the answer alone. The role's budget (and the measurement behind it) lives
 * in agent/lib/model-output-budget.ts, where the chat's budget lives too, so the
 * two can never again disagree about what this deployment sends.
 *
 * Passed EXPLICITLY here rather than left to the middleware in `agentModel`: that
 * middleware only exists in cloudflare mode, and `read_image` must be budgeted on
 * the gateway as well. The middleware's `??` leaves this value alone.
 */
/** Where the render script and its output live in the sandbox. */
const RENDER_DIR = "/workspace/.read_image";

/** Media types a VLM on either provider accepts. Anything else is refused by name. */
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

type Sniffed = { kind: "pdf" } | { kind: "image"; mediaType: string } | { kind: "unknown" };

/**
 * What the bytes ARE, from the bytes — not from the extension.
 *
 * The extension is the model's or the uploader's claim. A `.pdf` that is really a
 * jpeg (a phone photo of a page, renamed) would be handed to the pdf renderer and
 * come back "cannot open document", which reads as "the file is broken" rather
 * than "it is a photo". Magic bytes cannot be wrong about this.
 */
function sniff(bytes: Uint8Array): Sniffed {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46)) return { kind: "pdf" }; // %PDF
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: "image", mediaType: "image/png" };
  if (starts(0xff, 0xd8, 0xff)) return { kind: "image", mediaType: "image/jpeg" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { kind: "image", mediaType: "image/gif" }; // GIF8
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42)
    return { kind: "image", mediaType: "image/webp" }; // RIFF....WEBP
  return { kind: "unknown" };
}

/**
 * The renderer, written into the sandbox as a FILE and fed a params FILE.
 *
 * Neither the data-room path nor the sandbox path is ever interpolated into a
 * shell command. `sandbox.run` takes one `command` string and no argv array, so
 * every path that reached it would be shell-quoted by hand — and real data-room
 * filenames contain spaces, parentheses and apostrophes, which is one bad quote
 * away from a filename executing something. A json file read by `json.load` has
 * no such edge.
 *
 * It installs pymupdf if it is missing rather than failing. agent/sandbox.ts
 * pre-installs it for the main chat, but each SUBAGENT owns its own sandbox and
 * a pack ships more of them; a renderer that only works in one of those is a
 * capability that disappears depending on who is asking. This is the
 * "a missing library never ends a task" rule of agent/instructions.md, executed
 * rather than hoped for.
 */
const RENDER_PY = String.raw`
import importlib, json, os, site, subprocess, sys

PARAMS = json.load(open("__PARAMS__"))

def out(payload):
    print(json.dumps(payload))
    sys.exit(0)

def load_fitz():
    try:
        import fitz
        return fitz
    except ModuleNotFoundError:
        pass
    for cmd in (
        [sys.executable, "-m", "pip", "install", "--quiet", "--break-system-packages", "pymupdf"],
        [sys.executable, "-m", "pip", "install", "--quiet", "--user", "pymupdf"],
    ):
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=150)
        except Exception:
            continue
        # A --user install lands outside the ALREADY-BUILT sys.path of this process,
        # so without these two lines the import still fails and the install looks broken.
        try:
            site.addsitedir(site.getusersitepackages())
        except Exception:
            pass
        importlib.invalidate_caches()
        try:
            import fitz
            return fitz
        except ModuleNotFoundError:
            continue
    return None

fitz = load_fitz()
if fitz is None:
    out({"error": "pymupdf (fitz) is not installed in this sandbox and could not be installed"})

try:
    doc = fitz.open(PARAMS["source"])
except Exception as exc:
    out({"error": "could not open the pdf: %s" % exc})

total = doc.page_count
first = PARAMS["page"]
if first > total:
    out({"error": "this pdf has %d page(s); page %d does not exist" % (total, first)})

pages = []
for number in range(first, min(first + PARAMS["pageCount"], total + 1)):
    page = doc.load_page(number - 1)
    # A ladder, not one dpi. A dense scan at 150 dpi can exceed the per-image cap,
    # and the useful answer is a slightly coarser page, not a refusal.
    rendered = None
    for dpi in PARAMS["dpiLadder"]:
        data = page.get_pixmap(dpi=dpi).tobytes("png")
        if len(data) <= PARAMS["maxBytes"]:
            rendered = (dpi, data)
            break
    if rendered is None:
        out({"error": "page %d is still larger than %d bytes at %d dpi" % (number, PARAMS["maxBytes"], PARAMS["dpiLadder"][-1])})
    target = os.path.join(PARAMS["outDir"], "page-%d.png" % number)
    with open(target, "wb") as handle:
        handle.write(rendered[1])
    pages.append({
        "page": number,
        "file": target,
        "bytes": len(rendered[1]),
        "dpi": rendered[0],
        # How many characters pdfplumber/pypdf WOULD have got. 0 is the proof that
        # "this pdf has no text" was a scan and not an empty document, and it is the
        # one fact the agent cannot get any other way once the page is a picture.
        "textLayerChars": len(page.get_text().strip()),
    })

out({"pageCount": total, "pages": pages})
`;

interface RenderedPage {
  page: number;
  file: string;
  bytes: number;
  dpi: number;
  textLayerChars: number;
}

/** A sandbox handle, narrowed to the four methods used here (eve's SandboxSession). */
interface SandboxLike {
  run(options: { command: string; abortSignal?: AbortSignal }): PromiseLike<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  readBinaryFile(options: { path: string }): PromiseLike<Uint8Array | null>;
  writeBinaryFile(options: { path: string; content: Uint8Array }): PromiseLike<void>;
  writeTextFile(options: { path: string; content: string }): PromiseLike<void>;
}
interface VisionCtx extends SessionCtxLike {
  getSandbox?: () => Promise<SandboxLike>;
}

/** Render `source` (a path inside the sandbox) to png pages. */
async function renderPdfPages(
  sandbox: SandboxLike,
  source: string,
  page: number,
  pageCount: number,
): Promise<{ pages: RenderedPage[]; pageCount: number } | { error: string }> {
  const paramsPath = `${RENDER_DIR}/params.json`;
  const scriptPath = `${RENDER_DIR}/render.py`;
  await sandbox.writeTextFile({
    path: paramsPath,
    content: JSON.stringify({
      source,
      page,
      pageCount,
      outDir: RENDER_DIR,
      maxBytes: MAX_IMAGE_BYTES,
      dpiLadder: [150, 110, 80],
    }),
  });
  await sandbox.writeTextFile({ path: scriptPath, content: RENDER_PY.replace("__PARAMS__", paramsPath) });
  const result = await sandbox.run({
    command: `mkdir -p ${RENDER_DIR} && python3 ${scriptPath}`,
    abortSignal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  });
  if (result.exitCode !== 0) {
    return { error: `rendering the pdf failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}` };
  }
  try {
    // The LAST line: a pip install that printed a warning would otherwise be parsed
    // as the result, and "Unexpected token W" tells nobody anything.
    const lines = result.stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]) as { pages: RenderedPage[]; pageCount: number };
  } catch {
    return { error: `the renderer produced no result: ${result.stdout.trim().slice(0, 500)}` };
  }
}

export const readImageTool = modelFacing("read_image", defineTool({
  description:
    "READ AN IMAGE with a vision model and get text back — you cannot see images yourself. Give it a data-room path (`path`) OR a path in your bash sandbox (`sandboxPath`), plus the `question` you want answered about it. Works on png/jpeg/gif/webp AND on pdfs: for a pdf, pass `page` (1-based) and it renders that page to an image first. USE IT FOR SCANNED PDFs — when pdfplumber/pypdf return no text, the document is a scan, not an empty file, and this is how you read it. It never takes image data: pass the reference to the file, never base64.",
  inputSchema: z.object({
    question: z
      .string()
      .min(1)
      .describe(
        "What you want to know about the image, e.g. 'Transcribe the table of borrowings' or 'What is the sanctioned amount on this page?'. Be specific — the vision model sees only the image and this sentence.",
      ),
    path: z
      .string()
      .optional()
      .describe("Data-room path, e.g. 'Uploads/priya-example-in/LODR-Q2.pdf'. Provide this OR sandboxPath."),
    sandboxPath: z
      .string()
      .optional()
      .describe("Path in your bash sandbox, e.g. '/workspace/filing.pdf'. Provide this OR path."),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("For a pdf: the first page to read, 1-based. Default 1. Ignored for an image file."),
    pageCount: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGES_PER_CALL)
      .optional()
      .describe(`For a pdf: how many consecutive pages to read, up to ${MAX_PAGES_PER_CALL}. Default 1.`),
  }),
  async execute({ question, path, sandboxPath, page, pageCount }, ctx: VisionCtx) {
    const fail = (error: string) => ({ read: false as const, error });

    // XOR, checked rather than assumed: with both set, whichever the code happened
    // to test first would silently win and the answer would be about the other file.
    if (Boolean(path) === Boolean(sandboxPath)) {
      return fail("give exactly one of `path` (a data-room path) or `sandboxPath` (a path in your bash sandbox).");
    }

    const firstPage = page ?? 1;
    const pages = pageCount ?? 1;

    let bytes: Uint8Array | null = null;
    let label: string;
    try {
      if (path) {
        // The SAME workspace-scoped store dataroom_read uses, resolved from the
        // verified caller on the session — never from an argument the model chose.
        // The store validates the path against DATAROOM_PATH_TEMPLATES before it
        // touches a backend, so this reader can reach nothing dataroom_read cannot.
        bytes = await (await storeForSession(ctx)).readBytes(path);
        label = path;
        if (bytes === null) {
          return fail(
            `no file at data-room path "${path}" (or this data room cannot serve raw bytes — fetch it with dataroom_fetch_to_sandbox and pass sandboxPath).`,
          );
        }
      } else {
        label = sandboxPath as string;
      }
    } catch (error) {
      if (error instanceof DataroomPathError) return fail(error.message);
      throw error;
    }

    // A sandbox is needed for a sandbox source, and for a pdf from anywhere (the
    // render runs there). A data-room IMAGE needs none, so it is not asked for:
    // `getSandbox()` throws where there is no sandbox, and a tool that always
    // demanded one would be unusable from the surfaces that have none.
    let sandbox: SandboxLike | null = null;
    const needSandbox = async (): Promise<SandboxLike | { error: string }> => {
      if (sandbox) return sandbox;
      if (!ctx.getSandbox) return { error: "no bash sandbox is available in this context, so this file cannot be read." };
      try {
        sandbox = await ctx.getSandbox();
        return sandbox;
      } catch (error) {
        return { error: `no bash sandbox is available in this context: ${(error as Error).message}` };
      }
    };

    if (sandboxPath) {
      const handle = await needSandbox();
      if ("error" in handle) return fail(handle.error);
      bytes = await handle.readBinaryFile({ path: sandboxPath });
      if (bytes === null) return fail(`no file at sandbox path "${sandboxPath}".`);
    }

    const kind = sniff(bytes as Uint8Array);
    const images: { data: Uint8Array; mediaType: string }[] = [];
    let rendered: RenderedPage[] = [];
    let pdfPageCount: number | undefined;

    if (kind.kind === "pdf") {
      const handle = await needSandbox();
      if ("error" in handle) return fail(handle.error);
      let source = sandboxPath;
      if (!source) {
        // A data-room pdf is pushed in as BYTES, not as a presigned URL curl'd by a
        // shell line. Same reason as the params file: no path of the workspace's
        // choosing ever becomes shell text, and it works on the local-filesystem
        // data room too, which can mint no url at all.
        source = `${RENDER_DIR}/source.pdf`;
        await handle.writeBinaryFile({ path: source, content: bytes as Uint8Array });
      }
      const result = await renderPdfPages(handle, source, firstPage, pages);
      if ("error" in result) return fail(result.error);
      rendered = result.pages;
      pdfPageCount = result.pageCount;
      for (const item of rendered) {
        const png = await handle.readBinaryFile({ path: item.file });
        if (png === null) return fail(`the renderer reported ${item.file} but it is not there.`);
        images.push({ data: png, mediaType: "image/png" });
      }
    } else if (kind.kind === "image") {
      if (!SUPPORTED_IMAGE_TYPES.includes(kind.mediaType as (typeof SUPPORTED_IMAGE_TYPES)[number])) {
        return fail(`${label} is ${kind.mediaType}, which the vision model does not accept.`);
      }
      if ((bytes as Uint8Array).byteLength > MAX_IMAGE_BYTES) {
        return fail(
          `${label} is ${(bytes as Uint8Array).byteLength} bytes; the limit is ${MAX_IMAGE_BYTES}. Downscale it in the sandbox (e.g. python3 -c "from PIL import Image; …") and pass the smaller file.`,
        );
      }
      images.push({ data: bytes as Uint8Array, mediaType: kind.mediaType });
    } else {
      return fail(
        `${label} is not an image or a pdf (its first bytes match neither). If it is a spreadsheet or an archive, parse it in the sandbox instead.`,
      );
    }

    const totalBytes = images.reduce((sum, image) => sum + image.data.byteLength, 0);
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return fail(
        `those ${images.length} page(s) come to ${totalBytes} bytes, over the ${MAX_TOTAL_IMAGE_BYTES}-byte limit for one call. Ask for fewer pages.`,
      );
    }

    const model = agentModelId("vision");
    let text: string;
    try {
      const response = await generateText({
        model: agentModel("vision"),
        maxOutputTokens: modelOutputBudgetTokens("vision"),
        // An explicit deadline. Without one a provider that accepts the request and
        // never answers holds the turn open until the platform kills it, and the
        // person sees a spinner rather than a sentence.
        abortSignal: AbortSignal.timeout(VISION_TIMEOUT_MS),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${question}\n\nRead only what is in the image${images.length > 1 ? "s" : ""}. Quote figures and labels exactly as printed. If something is illegible, say so rather than guessing.`,
              },
              // A `file` part, not the deprecated `image` part: the AI SDK warns on every
              // `image` part and will drop it, and a deprecation warning per image read is
              // noise that trains people to ignore warnings. The openai-compatible provider
              // turns this into the `image_url` data URI the Workers AI endpoint expects.
              ...images.map((image) => ({ type: "file" as const, data: image.data, mediaType: image.mediaType })),
            ],
          },
        ],
      });
      text = response.text?.trim() ?? "";
    } catch (error) {
      return fail(`the vision model (${model}) could not be reached: ${(error as Error).message}`);
    }

    // THE KIMI FAILURE, contained. An empty completion from this model is the
    // defect that took the orchestrator down ("Empty model response" →
    // MODEL_CALL_FAILED → the turn dies with nothing delivered). Here the same
    // event is one tool result saying so, and the agent still has its turn, its
    // context and every other way of reading the document.
    //
    // LAST_RESORT_SENTENCE counts as empty. The empty-response recovery
    // (agent/lib/empty-model-response.ts, PR #51) gives up by returning a sentence
    // FOR A PERSON — "I could not get a reply back just now… say carry on" — as the
    // model's answer, so the chat finishes its turn instead of parking. That is
    // right on the chat surface and wrong here: as a tool result it becomes the
    // `answer` field, i.e. this tool reporting an apology as WHAT IT SAW IN THE
    // DOCUMENT, which the orchestrator then reasons about as if it were a reading
    // of a filing. A fabricated observation is worse than the failure it replaces,
    // which is the principle that file is built on. The justification for the
    // sentence does not reach here either: a tool result does not end a turn, so
    // there is no turn to rescue. The retry and the nudge one layer down are still
    // worth having — only the giving-up is translated back into a refusal.
    if (text === "" || text === LAST_RESORT_SENTENCE) {
      return fail(
        `the vision model (${model}) returned no text for ${label}. Try one page at a time, or a more specific question.`,
      );
    }

    return {
      read: true as const,
      source: path ? { kind: "dataroom" as const, path } : { kind: "sandbox" as const, path: sandboxPath as string },
      model,
      answer: text,
      ...(rendered.length > 0
        ? {
            renderedPages: rendered.map(({ page: number, dpi, bytes: size, textLayerChars }) => ({
              page: number,
              dpi,
              bytes: size,
              textLayerChars,
            })),
            pdfPageCount,
            note:
              rendered.every((item) => item.textLayerChars === 0)
                ? "Every page rendered has an EMPTY text layer: this pdf is a scan, and this tool is the only way to read it."
                : undefined,
          }
        : {}),
    };
  },
}), { pathInput: ["path"], opaqueOutput: "*" });

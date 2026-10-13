import { existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * Dictation in the chat composer (app/_components/dictation-slot.tsx, the button and the engine it loads), at the
 * bottom of /preview/user-message: ONE press-to-talk button, text arriving section by section, hands-free on a
 * double-click, and nothing about it changing the composer's height.
 *
 * The microphone is Chromium's own fake device (a real MediaStream through the real Web Audio graph;
 * `--use-fake-device-for-media-stream`) playing the file written below, on a loop: 1.2 s of a voice-like sound, 1 s of
 * silence. So the real cut into sections runs here, on real pauses, about one section every 2.2 s. The server is
 * answered here (`/api/ops/dictation`), and what the composer would send is counted on the page: dictation puts words
 * in the box, in the order spoken, and sends nothing.
 */
const VOICE_MS = 1_200;
const QUIET_MS = 1_000;

/** A voiced sound: a 140 Hz pitch with its harmonics, swelling in syllables. Then silence. 48 kHz mono 16-bit WAV. */
function voiceFile(): string {
  const rate = 48_000;
  const total = Math.round(((VOICE_MS + QUIET_MS) * rate) / 1000);
  const voiced = Math.round((VOICE_MS * rate) / 1000);
  const data = Buffer.alloc(44 + total * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + total * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < voiced; i++) {
    const t = i / rate;
    let v = 0;
    for (let k = 1; k <= 20; k++) v += Math.sin(2 * Math.PI * 140 * k * t) / k;
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 5 * t - Math.PI / 2);
    const edge = Math.min(1, i / 480, (voiced - i) / 480);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * 0.32 * syllable * edge)) * 32767), 44 + i * 2);
  }
  // One file for every worker and every run: written beside it and moved into place, so a browser never opens half of it.
  const file = path.join(tmpdir(), "dictation-fake-voice-1200-1000.wav");
  if (!existsSync(file) || statSync(file).size !== data.length) {
    const draft = `${file}.${process.pid}`;
    writeFileSync(draft, data);
    renameSync(draft, file);
  }
  return file;
}

test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${voiceFile()}`] },
  permissions: ["microphone"],
});

/** What the fake server says for sections 0, 1, 2… unless a test answers for itself. */
const WORDS = ["draft the quarterly summary", "and send it to the board", "by Friday", "with the figures"];
const CAPABILITY = { enabled: true, max_seconds: 120, max_bytes: 4 * 1024 * 1024, max_session_seconds: 600, idle_stop_seconds: 20 };
const HINT = "Hold to talk · double-click to keep listening";

interface Post {
  contentType: string;
  body: string;
  size: number;
  sessionId: string | null;
  seq: number | null;
  durationMs: number | null;
}
interface Answer {
  status?: number;
  json?: unknown;
  delayMs?: number;
}
interface Server {
  posts: Post[];
}

const field = (body: string, name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1] ?? null;

/** Signed in (a stored token is all the button needs to ask), the agent's warm-up answered, the server faked. */
async function open(
  page: Page,
  { capability = CAPABILITY as unknown, answer = (post: Post): Answer => ({ json: { text: WORDS[post.seq ?? 0] ?? `part ${(post.seq ?? 0) + 1}`, duration_ms: post.durationMs } }), signedIn = true } = {},
): Promise<Server> {
  const server: Server = { posts: [] };
  if (signedIn) await page.addInitScript(() => localStorage.setItem("workspace-google-token", "preview-token"));
  await page.route(/\/eve\//, (route) => route.fulfill({ status: 200, json: { ok: true } }));
  await page.route("**/api/ops/dictation", async (route) => {
    const req: Request = route.request();
    if (req.method() === "GET") {
      expect(req.headers().authorization).toBe("Bearer preview-token");
      return route.fulfill({ status: 200, json: capability });
    }
    const buf = req.postDataBuffer() ?? Buffer.alloc(0);
    const body = buf.toString("latin1");
    const seq = field(body, "seq");
    const duration = field(body, "duration_ms");
    const post: Post = { contentType: req.headers()["content-type"] ?? "", body, size: buf.length, sessionId: field(body, "session_id"), seq: seq === null ? null : Number(seq), durationMs: duration === null ? null : Number(duration) };
    server.posts.push(post);
    const said = answer(post);
    if (said.delayMs) await new Promise((r) => setTimeout(r, said.delayMs));
    return route.fulfill({ status: said.status ?? 200, json: said.json ?? {} }).catch(() => {});
  });
  await page.goto("/preview/user-message");
  // The transcript above the composer is a reply still streaming in: it grows a line every second or so and moves
  // everything under it. Out of the way here, so a press lands on the button it was aimed at.
  await page.addStyleTag({ content: '[data-testid^="msg-"] { display: none !important; }' });
  await page.getByTestId("dictation-composer").scrollIntoViewIfNeeded();
  // Generous: on a development server this is the first time the button's own file is asked for, and it is compiled then.
  await expect(mic(page)).toBeVisible({ timeout: 30_000 });
  return server;
}

const composer = (page: Page) => page.getByTestId("dictation-composer");
const form = (page: Page) => composer(page).locator("form");
const box = (page: Page) => composer(page).locator("textarea");
const root = (page: Page) => composer(page).getByTestId("dictation");
const mic = (page: Page) => page.getByRole("button", { name: /^Dictate a message/ });
const sent = (page: Page) => page.getByTestId("sent-count");
const status = (page: Page) => page.getByTestId("dictation-status");
const marker = (page: Page) => page.getByTestId("dictation-marker");
const height = async (page: Page) => (await form(page).boundingBox())!.height;

/** Put the caret at `at` in the box's text. */
async function caretAt(page: Page, text: string, at: number) {
  await box(page).fill(text);
  await box(page).evaluate((el: HTMLTextAreaElement, i) => {
    el.focus();
    el.setSelectionRange(i, i);
  }, at);
}

/** Press the microphone and keep it down until the microphone is live. */
async function pressAndHold(page: Page) {
  await mic(page).hover();
  await page.mouse.down();
  await expect(root(page)).toHaveAttribute("data-state", "hold");
  // The first press fetches the engine (compiled on demand by a development server).
  await expect(root(page)).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
}

/** Hold the microphone through one stretch of the voice, and let go while it is still speaking. */
async function holdThroughSpeech(page: Page) {
  await pressAndHold(page);
  await expect(marker(page)).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(400);
  await page.mouse.up();
}

test("hold, speak, let go: the words land at the cursor, editable, and nothing is sent", async ({ page }) => {
  const server = await open(page);
  await expect(mic(page)).toHaveAccessibleName("Dictate a message. Hold to talk, or double-click to keep listening.");
  await expect(mic(page)).toHaveAttribute("aria-pressed", "false");
  await caretAt(page, "Please for the board", "Please ".length);

  await pressAndHold(page);
  await expect(status(page)).toHaveText("Listening. Release to stop.");
  await expect(page.getByTestId("dictation-timer")).toHaveText(/^0:0\d$/);
  expect(server.posts).toHaveLength(0);
  await expect(marker(page)).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(400);
  await page.mouse.up();

  await expect(root(page)).toHaveAttribute("data-state", "idle");
  await expect(status(page)).toHaveText("Stopped listening.");
  await expect(box(page)).toHaveValue(`Please ${WORDS[0]} for the board`);
  // A pointer's hold ends with the cursor in the box, after the words.
  await expect(box(page)).toBeFocused();
  const caret = await box(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
  expect(caret).toEqual([`Please ${WORDS[0]}`.length, `Please ${WORDS[0]}`.length]);
  await expect(sent(page)).toHaveText("0");
  await expect(marker(page)).toHaveCount(0);

  // One section: a complete WAV file of its own, its length, its stretch of listening and its place in it.
  expect(server.posts).toHaveLength(1);
  const [post] = server.posts;
  expect(post.contentType).toMatch(/^multipart\/form-data/);
  expect(post.body).toMatch(/name="audio"; filename="dictation\.wav"\r\nContent-Type: audio\/wav\r\n\r\nRIFF/);
  expect(post.body).toContain("WAVEfmt ");
  expect(post.sessionId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(post.seq).toBe(0);
  expect(post.durationMs).toBeGreaterThan(300);
  expect(post.durationMs).toBeLessThan(3_000);
  // 16 kHz mono 16-bit: 32 bytes a millisecond, plus the header and the form's framing.
  expect(Math.abs(post.size - post.durationMs! * 32)).toBeLessThan(2_000);

  // Still the person's to edit, then send.
  await box(page).press("End");
  await box(page).pressSequentially(" today");
  await expect(box(page)).toHaveValue(`Please ${WORDS[0]} for the board today`);
  await expect(sent(page)).toHaveText("0");
  await box(page).press("Enter");
  await expect(sent(page)).toHaveText("1");
  await expect(page.getByTestId("sent-last")).toContainText(`Please ${WORDS[0]} for the board today`);
});

test("one quick click records nothing and says how the button works", async ({ page }) => {
  const server = await open(page);
  await box(page).fill("Keep this");
  const before = await height(page);
  await mic(page).click();
  const hint = page.getByTestId("dictation-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText(HINT);
  await expect(hint).toHaveAttribute("role", "tooltip");
  await expect(mic(page)).toHaveAttribute("aria-describedby", (await hint.getAttribute("id"))!);
  expect(await height(page)).toBe(before);
  await expect(root(page)).toHaveAttribute("data-state", "idle");
  // The tooltip floats over the page: it is not in the composer's flow.
  expect(await hint.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  await page.waitForTimeout(900);
  expect(server.posts).toHaveLength(0);
  await expect(box(page)).toHaveValue("Keep this");
  await expect(hint).toHaveCount(0, { timeout: 6_000 });
  await expect(sent(page)).toHaveText("0");
});

test("the composer's height is the same idle, holding, hands-free, waiting for text, and with a problem shown", async ({ page }) => {
  await open(page, { answer: () => ({ json: { text: "" }, delayMs: 3_000 }) });
  /** The form's size, and the button's own box within it (the page above the composer is a transcript still growing). */
  const layout = () =>
    form(page).evaluate((f) => {
      const [a, b] = [f.getBoundingClientRect(), f.querySelector("[data-testid=dictation] button")!.getBoundingClientRect()];
      return { form: [a.width, a.height], mic: [b.x - a.x, b.y - a.y, b.width, b.height], row: (f.lastElementChild as HTMLElement).offsetHeight };
    });
  const idle = await layout();
  const same = async (what: string) => expect(await layout(), what).toEqual(idle);
  // No strip, no second row: the old recording controls are gone.
  await expect(page.getByTestId("dictation-recording")).toHaveCount(0);

  await pressAndHold(page);
  await same("holding");
  await expect(marker(page)).toBeVisible({ timeout: 8_000 });
  await same("holding, speaking");
  await page.waitForTimeout(300);
  await page.mouse.up();
  // Waiting for the section's text: the busy dot is inside the button, the marker floats in the box.
  await expect(root(page)).toHaveAttribute("data-state", "idle");
  await expect(root(page)).toHaveAttribute("data-pending", "1");
  await expect(page.getByTestId("dictation-busy")).toBeVisible();
  await expect(marker(page)).toBeVisible();
  expect(await marker(page).evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  await same("waiting for text");

  await mic(page).dblclick();
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  await expect(root(page)).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await same("hands-free");
  await mic(page).click();
  await expect(root(page)).toHaveAttribute("data-state", "idle");
  // "No speech was heard" (the first hold's empty answer) arrives as a popover over the page.
  const alert = page.getByRole("alert").filter({ hasText: "No speech was heard" });
  await expect(alert).toBeVisible({ timeout: 8_000 });
  expect(await alert.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  await same("with a problem shown");
});

test("double-click keeps listening hands-free: sections stream in as they are spoken, and a click stops it", async ({ page }) => {
  const server = await open(page);
  await mic(page).dblclick();
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  await expect(mic(page)).toHaveAttribute("aria-pressed", "true");
  await expect(status(page)).toHaveText("Listening hands-free. Click the microphone or press Escape to stop.");
  await expect(page.getByTestId("dictation-hint")).toHaveCount(0);
  // Its own colour and a solid ring: not the hold's.
  expect(await mic(page).evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");

  // No hand on the button, and the text arrives section by section, while it is still listening.
  await expect(box(page)).toHaveValue(WORDS[0], { timeout: 10_000 });
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  await expect(box(page)).toHaveValue(`${WORDS[0]} ${WORDS[1]}`, { timeout: 10_000 });
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  await expect(sent(page)).toHaveText("0");

  await mic(page).click();
  await expect(root(page)).toHaveAttribute("data-state", "idle");
  await expect(mic(page)).toHaveAttribute("aria-pressed", "false");
  await expect(status(page)).toHaveText("Stopped listening.");
  // Everything said before the stop lands; nothing after it is recorded.
  await expect(root(page)).toHaveAttribute("data-pending", "0", { timeout: 8_000 });
  const posts = server.posts.length;
  expect(posts).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(3_000);
  expect(server.posts).toHaveLength(posts);
  // One stretch of listening: one id, sections numbered from 0, each a file of its own.
  expect(new Set(server.posts.map((p) => p.sessionId)).size).toBe(1);
  expect(server.posts.map((p) => p.seq)).toEqual(server.posts.map((_, i) => i));
  for (const p of server.posts) expect(p.body).toMatch(/Content-Type: audio\/wav\r\n\r\nRIFF/);
  expect(await box(page).inputValue()).toBe(WORDS.slice(0, posts).join(" "));
  await expect(sent(page)).toHaveText("0");
});

test("the text reads in the order spoken when the server answers out of order", async ({ page }) => {
  // The first section's answer takes 3.5 s; the second's comes at once.
  const server = await open(page, {
    answer: (post) => ({ json: { text: WORDS[post.seq ?? 0] }, delayMs: post.seq === 0 ? 3_500 : 0 }),
  });
  const seen: string[] = [];
  await page.exposeFunction("sawBox", (v: string) => void seen.push(v));
  await box(page).evaluate((el: HTMLTextAreaElement) => {
    el.addEventListener("input", () => (window as unknown as { sawBox(v: string): void }).sawBox(el.value));
  });
  await mic(page).dblclick();
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  // The second section has been answered and the first has not: its text is held back, the box still empty.
  await expect.poll(() => server.posts.length, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(300);
  await expect(box(page)).toHaveValue("");
  await expect(marker(page)).toBeVisible();
  await expect(box(page)).toHaveValue(new RegExp(`^${WORDS[0]} ${WORDS[1]}`), { timeout: 10_000 });
  await mic(page).click();
  // Every value the box ever held started with the first section's words.
  expect(seen.length).toBeGreaterThanOrEqual(2);
  for (const v of seen) expect(v.startsWith(WORDS[0])).toBe(true);
  expect(seen[0]).toBe(WORDS[0]);
  await expect(sent(page)).toHaveText("0");
});

test("typing while it listens is not overwritten: the text lands where it was going, around what was typed", async ({ page }) => {
  const server = await open(page, { answer: (post) => ({ json: { text: WORDS[post.seq ?? 0] }, delayMs: post.seq === 0 ? 2_500 : 0 }) });
  await caretAt(page, "Start end", "Start ".length);
  await mic(page).dblclick();
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  await expect.poll(() => server.posts.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  // The first section is on its way. Meanwhile the person types at the front and at the end of the box.
  await box(page).evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(0, 0);
  });
  await box(page).pressSequentially("Note: ");
  await box(page).press("End");
  await box(page).pressSequentially(", thanks");
  await expect(box(page)).toHaveValue("Note: Start end, thanks");
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  // It lands between "Start" and "end", where the cursor was when listening began, moved along by "Note: ".
  await expect(box(page)).toHaveValue(new RegExp(`^Note: Start ${WORDS[0]}( ${WORDS[1]})? end, thanks$`), { timeout: 10_000 });
  // The person's cursor stayed where they were typing, and typing carries on there.
  await expect(box(page)).toBeFocused();
  await box(page).pressSequentially("!");
  await expect(box(page)).toHaveValue(/ end, thanks!$/);
  await page.keyboard.press("Escape");
  await expect(root(page)).toHaveAttribute("data-state", "idle");
  await expect(root(page)).toHaveAttribute("data-pending", "0", { timeout: 8_000 });
  await expect(box(page)).toHaveValue(/^Note: Start draft the quarterly summary .*end, thanks!$/);
  await expect(sent(page)).toHaveText("0");
});

test("a second hold while the first one's text is still on its way: the first one's words still come first", async ({ page }) => {
  const stretches: string[] = [];
  const server = await open(page, {
    answer: (post) => {
      if (!stretches.includes(post.sessionId!)) stretches.push(post.sessionId!);
      const first = stretches.indexOf(post.sessionId!) === 0;
      return { json: { text: first ? "spoken first" : "spoken second" }, delayMs: first ? 5_000 : 0 };
    },
  });
  await caretAt(page, "Begin end", "Begin ".length);
  await holdThroughSpeech(page);
  await expect(root(page)).toHaveAttribute("data-pending", "1");
  await holdThroughSpeech(page);
  // The second hold's answer is back, the first's is not: its words are in the box, and the first's place is before them.
  await expect(box(page)).toHaveValue("Begin spoken second end", { timeout: 8_000 });
  await expect(marker(page)).toBeVisible();
  await expect(box(page)).toHaveValue("Begin spoken first spoken second end", { timeout: 10_000 });
  await expect(root(page)).toHaveAttribute("data-pending", "0");
  expect(server.posts).toHaveLength(2);
  expect(server.posts.map((p) => p.seq)).toEqual([0, 0]);
  expect(new Set(server.posts.map((p) => p.sessionId)).size).toBe(2);
  await expect(sent(page)).toHaveText("0");
});

test("from the keyboard: hold Space to talk, Shift+Enter or a double press for hands-free, Escape stops", async ({ page }) => {
  const server = await open(page);
  await box(page).focus();
  await page.keyboard.press("Tab");
  await expect(mic(page)).toBeFocused();
  // Visible focus, in every state.
  expect(await mic(page).evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none" && parseFloat(getComputedStyle(el).outlineWidth) >= 2)).toBe(true);

  await page.keyboard.down("Space");
  await expect(root(page)).toHaveAttribute("data-state", "hold");
  await expect(root(page)).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(marker(page)).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(400);
  await page.keyboard.up("Space");
  await expect(root(page)).toHaveAttribute("data-state", "idle");
  await expect(box(page)).toHaveValue(WORDS[0]);
  // A keyboard's hold leaves focus on the microphone, to press again.
  await expect(mic(page)).toBeFocused();
  await expect(sent(page)).toHaveText("0");
  expect(server.posts).toHaveLength(1);

  // A quick press is a tap: the hint, nothing recorded.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("dictation-hint")).toBeVisible();
  await page.waitForTimeout(700);
  expect(server.posts).toHaveLength(1);
  await expect(sent(page)).toHaveText("0");

  // Shift+Enter: hands-free.
  await page.keyboard.press("Shift+Enter");
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  await expect(mic(page)).toHaveAttribute("aria-pressed", "true");
  expect(await mic(page).evaluate((el) => getComputedStyle(el).outlineStyle !== "none")).toBe(true);
  await page.keyboard.press("Escape");
  await expect(root(page)).toHaveAttribute("data-state", "idle");
  await expect(status(page)).toHaveText("Stopped listening.");

  // A double press: hands-free too. Shift+Enter again stops it.
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  await page.keyboard.press("Shift+Enter");
  await expect(root(page)).toHaveAttribute("data-state", "idle");
  await expect(sent(page)).toHaveText("0");
});

test("the button beats with the voice", async ({ page }) => {
  await open(page);
  await expect(root(page)).toHaveAttribute("data-motion", "full");
  await pressAndHold(page);
  const beat = page.getByTestId("dictation-beat");
  await expect(beat).toBeVisible();
  expect(await beat.evaluate((el) => getComputedStyle(el).animationName)).toBe("dictation-beat");
  // The ring follows the live input level: above nothing while the voice sounds, back down in the silence.
  const level = () => mic(page).evaluate((el) => Number(el.style.getPropertyValue("--dictation-level") || 0));
  await expect.poll(level, { timeout: 8_000, intervals: [50] }).toBeGreaterThan(0.3);
  await expect.poll(level, { timeout: 8_000, intervals: [50] }).toBeLessThan(0.05);
  await page.mouse.up();
  await expect(beat).toHaveCount(0);
});

test.describe("reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("nothing moves: a still 'listening' ring, and everything else works", async ({ page }) => {
    await open(page);
    await expect(root(page)).toHaveAttribute("data-motion", "reduced");
    await mic(page).dblclick();
    await expect(root(page)).toHaveAttribute("data-state", "latched");
    await expect(root(page)).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    const beat = page.getByTestId("dictation-beat");
    await expect(beat).toBeVisible();
    const style = await beat.evaluate((el) => {
      const s = getComputedStyle(el);
      return { animation: s.animationName, opacity: Number(s.opacity), border: s.borderTopStyle };
    });
    expect(style.animation).toBe("none");
    // Still there to be seen: an outline that does not move.
    expect(style.opacity).toBeGreaterThan(0.5);
    expect(style.border).toBe("solid");
    await expect(mic(page)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("dictation-timer")).toBeVisible();
    // The level is not even read: nothing would move to it.
    await expect(box(page)).toHaveValue(WORDS[0], { timeout: 10_000 });
    expect(await mic(page).evaluate((el) => el.style.getPropertyValue("--dictation-level"))).toBe("");
    expect(await marker(page).count() === 0 || (await marker(page).evaluate((el) => getComputedStyle(el).animationName)) === "none").toBe(true);
    await mic(page).click();
    await expect(root(page)).toHaveAttribute("data-state", "idle");
  });
});

test("hands-free listening stops itself after the silence the server allows", async ({ page }) => {
  // One second of silence here; the fake voice's own pause is as long.
  const server = await open(page, { capability: { ...CAPABILITY, idle_stop_seconds: 1 } });
  const before = await height(page);
  await mic(page).dblclick();
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  await expect(root(page)).toHaveAttribute("data-state", "idle", { timeout: 10_000 });
  await expect(status(page)).toHaveText("Stopped listening after 1 second of silence.");
  await expect(page.getByTestId("dictation-notice")).toContainText("Stopped listening after 1 second of silence.");
  expect(await height(page)).toBe(before);
  await expect(root(page)).toHaveAttribute("data-pending", "0", { timeout: 8_000 });
  const posts = server.posts.length;
  await page.waitForTimeout(2_500);
  expect(server.posts).toHaveLength(posts);
  await expect(sent(page)).toHaveText("0");
});

test("listening stops at the session limit, says so, and keeps what was said", async ({ page }) => {
  const server = await open(page, { capability: { ...CAPABILITY, max_session_seconds: 3 } });
  await mic(page).dblclick();
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  await expect(root(page)).toHaveAttribute("data-state", "idle", { timeout: 10_000 });
  await expect(status(page)).toHaveText("Stopped listening: that was the limit of 3 seconds in one go. Press the microphone to carry on.");
  await expect(page.getByTestId("dictation-notice")).toBeVisible();
  await expect(box(page)).toHaveValue(new RegExp(`^${WORDS[0]}`), { timeout: 8_000 });
  await expect(root(page)).toHaveAttribute("data-pending", "0", { timeout: 8_000 });
  // No section is longer than the stretch, and together they are no longer than the limit.
  const total = server.posts.reduce((n, p) => n + (p.durationMs ?? 0), 0);
  expect(total).toBeLessThanOrEqual(3_100);
  await expect(sent(page)).toHaveText("0");
});

test("the server's session limit stops the listening", async ({ page }) => {
  const said = "That was the limit of 10 minutes of dictation in one go. Press the microphone to start again.";
  await open(page, { answer: () => ({ status: 429, json: { error: said, code: "session_limit" } }) });
  await box(page).fill("Unchanged");
  await mic(page).dblclick();
  await expect(root(page)).toHaveAttribute("data-state", "latched");
  await expect(page.getByRole("alert").filter({ hasText: said })).toBeVisible({ timeout: 10_000 });
  await expect(root(page)).toHaveAttribute("data-state", "idle");
  await expect(box(page)).toHaveValue("Unchanged");
});

test("blocked microphone: said in plain words in a popover, nothing recorded, no new row", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
  const server = await open(page);
  const before = await height(page);
  await mic(page).hover();
  await page.mouse.down();
  const alert = page.getByRole("alert").filter({ hasText: "Microphone access is blocked. Allow the microphone for this site in your browser's settings, then try again." });
  await expect(alert).toBeVisible();
  await page.mouse.up();
  await expect(root(page)).toHaveAttribute("data-state", "idle");
  await expect(mic(page)).toBeEnabled();
  expect(await height(page)).toBe(before);
  expect(server.posts).toHaveLength(0);
  // Anchored to the button: just above it, and on the screen.
  const [a, m] = [await alert.boundingBox(), await mic(page).boundingBox()];
  expect(a!.y + a!.height).toBeLessThanOrEqual(m!.y);
  expect(m!.y - (a!.y + a!.height)).toBeLessThan(24);
  expect(a!.x).toBeGreaterThanOrEqual(0);
  await alert.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByTestId("dictation-error")).toHaveCount(0);
});

test("a browser that cannot listen: said in plain words", async ({ page }) => {
  await page.addInitScript(() => {
    // @ts-expect-error -- a browser without the Web Audio API
    delete window.AudioContext;
    // @ts-expect-error -- nor its older name
    delete window.webkitAudioContext;
  });
  await open(page);
  await mic(page).dblclick();
  await expect(page.getByRole("alert").filter({ hasText: "This browser can't record audio here. Type your message instead." })).toBeVisible();
  await expect(root(page)).toHaveAttribute("data-state", "idle");
});

test("the server's refusal is shown as it says it, and the box is unchanged", async ({ page }) => {
  await open(page, { answer: () => ({ status: 413, json: { error: "That recording is longer than 2 minutes. Record a shorter one.", code: "too_long" } }) });
  await box(page).fill("Unchanged");
  await holdThroughSpeech(page);
  await expect(page.getByRole("alert").filter({ hasText: "That recording is longer than 2 minutes. Record a shorter one." })).toBeVisible();
  await expect(box(page)).toHaveValue("Unchanged");
  await expect(sent(page)).toHaveText("0");
});

test("nothing heard: said in plain words", async ({ page }) => {
  await open(page, { answer: () => ({ json: { text: "  " } }) });
  await holdThroughSpeech(page);
  await expect(page.getByRole("alert").filter({ hasText: "No speech was heard. Try again a little closer to the microphone." })).toBeVisible();
  await expect(box(page)).toHaveValue("");
});

test("hidden when the server says dictation is off", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("workspace-google-token", "preview-token"));
  await page.route(/\/eve\//, (route) => route.fulfill({ status: 200, json: { ok: true } }));
  await page.route("**/api/ops/dictation", (route) => route.fulfill({ status: 200, json: { ...CAPABILITY, enabled: false } }));
  await page.goto("/preview/user-message");
  await expect(box(page)).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("dictation")).toHaveCount(0);
  await expect(mic(page)).toHaveCount(0);
});

test("hidden when signed out (no request is made)", async ({ page }) => {
  let asked = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/ops/dictation")) asked++;
  });
  await page.route(/\/eve\//, (route) => route.fulfill({ status: 200, json: { ok: true } }));
  await page.goto("/preview/user-message");
  await expect(box(page)).toBeVisible();
  await page.waitForTimeout(500);
  await expect(mic(page)).toHaveCount(0);
  expect(asked).toBe(0);
});

test("the engine is fetched on the first press, not with the page or the button", async ({ page }) => {
  const scripts: string[] = [];
  page.on("response", (r) => {
    if (/\.js(\?|$)/.test(r.url())) scripts.push(r.url());
  });
  // The microphone's tap is a worklet from this site's own address (the content-security policy allows no other).
  await page.addInitScript(() => {
    const w = window as unknown as { workletModules: string[] };
    w.workletModules = [];
    const addModule = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (url, options) {
      w.workletModules.push(String(url));
      return addModule.call(this, url, options);
    };
  });
  const worklets = () => page.evaluate(() => (window as unknown as { workletModules: string[] }).workletModules);
  await open(page);
  await page.waitForTimeout(500);
  const before = scripts.length;
  expect(await worklets()).toEqual([]);
  // Mouse straight down on it, with no hover first: the press itself fetches the engine.
  const m = (await mic(page).boundingBox())!;
  await page.mouse.move(0, 0);
  expect(scripts.length).toBe(before);
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
  await page.mouse.down();
  await expect(root(page)).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await page.mouse.up();
  expect(await worklets()).toEqual(["/dictation-capture.worklet.js"]);
  expect(scripts.length).toBeGreaterThan(before);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });

  /** A real finger: touch events from the browser's own input pipeline, so the button sees pointerType "touch". */
  async function finger(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    return {
      // Where the button is NOW: the transcript above the composer is still growing.
      async down() {
        // Mid-screen: clear of the screen's edges (and of the development server's own corner badge).
        await mic(page).evaluate((el) => el.scrollIntoView({ block: "center" }));
        const m = (await mic(page).boundingBox())!;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: Math.round(m.x + m.width / 2), y: Math.round(m.y + m.height / 2) }] });
      },
      up: () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
    };
  }

  test("touch and hold talks, a tap explains, a double-tap listens hands-free; no menu, no selection, no new row", async ({ page }) => {
    const server = await open(page);
    const frame = await composer(page).boundingBox();
    const m = await mic(page).boundingBox();
    expect(m!.width).toBeGreaterThanOrEqual(36);
    expect(m!.height).toBeGreaterThanOrEqual(36);
    expect(m!.x).toBeGreaterThanOrEqual(frame!.x);
    expect(m!.x + m!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
    const before = await height(page);
    // A long press on it is a hold, never the browser's own gesture: no scrolling, text selection or callout.
    const guard = await mic(page).evaluate((el) => {
      const s = getComputedStyle(el);
      const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      el.dispatchEvent(menu);
      return { touchAction: s.touchAction, userSelect: s.userSelect, menuPrevented: menu.defaultPrevented };
    });
    expect(guard).toEqual({ touchAction: "none", userSelect: "none", menuPrevented: true });

    const touch = await finger(page);
    await touch.down();
    await expect(root(page)).toHaveAttribute("data-state", "hold");
    await expect(root(page)).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    expect(await height(page)).toBe(before);
    await expect(marker(page)).toBeVisible({ timeout: 8_000 });
    await page.waitForTimeout(400);
    await touch.up();
    await expect(root(page)).toHaveAttribute("data-state", "idle");
    await expect(box(page)).toHaveValue(WORDS[0]);
    expect(await page.evaluate(() => String(getSelection()))).toBe("");
    expect(server.posts).toHaveLength(1);

    // A tap: the hint, on the screen, and nothing recorded.
    await mic(page).tap();
    const hint = page.getByTestId("dictation-hint");
    await expect(hint).toBeVisible();
    const h = await hint.boundingBox();
    expect(h!.x).toBeGreaterThanOrEqual(0);
    expect(h!.x + h!.width).toBeLessThanOrEqual(375);
    await page.waitForTimeout(700);
    expect(server.posts).toHaveLength(1);

    // A double-tap: hands-free; a tap stops it.
    await touch.down();
    await touch.up();
    await touch.down();
    await touch.up();
    await expect(root(page)).toHaveAttribute("data-state", "latched");
    await expect(mic(page)).toHaveAttribute("aria-pressed", "true");
    expect(await height(page)).toBe(before);
    await mic(page).tap();
    await expect(root(page)).toHaveAttribute("data-state", "idle");
    await expect(sent(page)).toHaveText("0");
  });
});

import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * Dictation in the chat composer (app/_components/dictation-slot.tsx and the recorder it loads), at the bottom of
 * /preview/user-message. The microphone is Chromium's own fake device (a real MediaStream and a real MediaRecorder;
 * `--use-fake-device-for-media-stream`), the server is answered here (`/api/ops/dictation`), and what the composer
 * would send is counted on the page: dictation puts words in the box at the cursor, and sends nothing.
 */
test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  permissions: ["microphone"],
});

const TRANSCRIPT = "draft the quarterly summary";

interface Server {
  posts: { contentType: string; body: string; size: number }[];
}

/** Signed in (a stored token is all the button needs to ask), the agent's warm-up answered, the server faked. */
async function open(
  page: Page,
  { capability = { enabled: true, max_seconds: 120, max_bytes: 4 * 1024 * 1024 } as unknown, answer = { status: 200, json: { text: TRANSCRIPT, duration_ms: 1500 } as unknown }, signedIn = true } = {},
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
    server.posts.push({ contentType: req.headers()["content-type"] ?? "", body: buf.toString("latin1"), size: buf.length });
    return route.fulfill({ status: answer.status, json: answer.json });
  });
  await page.goto("/preview/user-message");
  await page.getByTestId("dictation-composer").scrollIntoViewIfNeeded();
  return server;
}

const box = (page: Page) => page.getByTestId("dictation-composer").locator("textarea");
const mic = (page: Page) => page.getByRole("button", { name: /^Dictate a message/ });
const stop = (page: Page) => page.getByRole("button", { name: "Stop recording and turn it into text" });
const cancel = (page: Page) => page.getByRole("button", { name: "Cancel recording" });
const sent = (page: Page) => page.getByTestId("sent-count");

/** Put the caret at `at` in the box's text. */
async function caretAt(page: Page, text: string, at: number) {
  await box(page).fill(text);
  await box(page).evaluate((el: HTMLTextAreaElement, i) => {
    el.focus();
    el.setSelectionRange(i, i);
  }, at);
}

test("record, stop: the words land at the cursor, editable, and nothing is sent", async ({ page }) => {
  const server = await open(page);
  await expect(mic(page)).toBeVisible();
  await expect(mic(page)).toHaveAccessibleName("Dictate a message (up to 2 minutes)");
  await caretAt(page, "Please for the board", "Please ".length);

  await mic(page).click();
  const recording = page.getByTestId("dictation-recording");
  await expect(recording).toBeVisible();
  await expect(page.getByTestId("dictation-timer")).toHaveText(/^0:00 \/ 2:00$/);
  await expect(page.getByTestId("dictation-status")).toHaveText(/Recording\. Up to 2 minutes\./);
  // The clock runs.
  await expect(page.getByTestId("dictation-timer")).toHaveText(/^0:01 \/ 2:00$/, { timeout: 5_000 });
  await expect(stop(page)).toBeFocused();
  await stop(page).click();

  await expect(box(page)).toHaveValue(`Please ${TRANSCRIPT} for the board`);
  await expect(box(page)).toBeFocused();
  const caret = await box(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
  expect(caret).toEqual([`Please ${TRANSCRIPT}`.length, `Please ${TRANSCRIPT}`.length]);
  await expect(sent(page)).toHaveText("0");

  // One upload: a recording and its stated length, as multipart, and only after Stop.
  expect(server.posts).toHaveLength(1);
  const [post] = server.posts;
  expect(post.contentType).toMatch(/^multipart\/form-data/);
  expect(post.body).toMatch(/name="audio"; filename="dictation\.(webm|ogg|m4a)"/);
  expect(post.body).toMatch(/Content-Type: audio\//);
  expect(post.body).toMatch(/name="duration_ms"\r\n\r\n\d+/);
  expect(post.size).toBeGreaterThan(1000);

  // Still the person's to edit, then send.
  await box(page).press("End");
  await box(page).pressSequentially(" today");
  await expect(box(page)).toHaveValue(`Please ${TRANSCRIPT} for the board today`);
  await expect(sent(page)).toHaveText("0");
  await box(page).press("Enter");
  await expect(sent(page)).toHaveText("1");
  await expect(page.getByTestId("sent-last")).toContainText(`Please ${TRANSCRIPT} for the board today`);
});

test("from the keyboard: Enter starts, focus moves to Stop, Escape cancels and uploads nothing", async ({ page }) => {
  const server = await open(page);
  await box(page).fill("Keep this");
  await mic(page).focus();
  await page.keyboard.press("Enter");
  await expect(stop(page)).toBeFocused();
  await expect(cancel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mic(page)).toBeVisible();
  await expect(page.getByTestId("dictation-recording")).toHaveCount(0);
  await expect(mic(page)).toBeFocused();
  // Give a stray upload time to happen, then prove there was none.
  await page.waitForTimeout(500);
  expect(server.posts).toHaveLength(0);
  await expect(box(page)).toHaveValue("Keep this");

  // …and Space on the focused Stop finishes a recording.
  await page.keyboard.press("Space");
  await expect(stop(page)).toBeFocused();
  // A second of speech (a clip stopped the instant it starts holds nothing and is said as "No speech was heard").
  await expect(page.getByTestId("dictation-timer")).toHaveText(/^0:01 /, { timeout: 5_000 });
  await page.keyboard.press("Space");
  await expect(box(page)).toHaveValue(`Keep this ${TRANSCRIPT}`);
  await expect(sent(page)).toHaveText("0");
});

test("the Cancel button discards the recording", async ({ page }) => {
  const server = await open(page);
  await mic(page).click();
  await expect(cancel(page)).toBeVisible();
  await cancel(page).click();
  await expect(mic(page)).toBeVisible();
  await page.waitForTimeout(500);
  expect(server.posts).toHaveLength(0);
  await expect(box(page)).toHaveValue("");
});

test("the recorder stops itself at the limit and transcribes what was said", async ({ page }) => {
  const server = await open(page, { capability: { enabled: true, max_seconds: 2, max_bytes: 4 * 1024 * 1024 } });
  await expect(mic(page)).toHaveAccessibleName("Dictate a message (up to 2 seconds)");
  await mic(page).click();
  await expect(page.getByTestId("dictation-timer")).toHaveText(/\/ 0:02$/);
  await expect(box(page)).toHaveValue(TRANSCRIPT, { timeout: 10_000 });
  expect(server.posts).toHaveLength(1);
  const stated = Number(/name="duration_ms"\r\n\r\n(\d+)/.exec(server.posts[0].body)?.[1]);
  expect(stated).toBeLessThanOrEqual(2_000);
  expect(stated).toBeGreaterThan(1_000);
  await expect(sent(page)).toHaveText("0");
});

test("blocked microphone: said in plain words, nothing recorded", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
  const server = await open(page);
  await mic(page).click();
  await expect(page.getByTestId("dictation-composer").getByRole("alert")).toContainText("Microphone access is blocked. Allow the microphone for this site in your browser's settings, then try again.");
  await expect(mic(page)).toBeEnabled();
  expect(server.posts).toHaveLength(0);
  await page.getByRole("button", { name: "Dismiss" }).last().click();
  await expect(page.getByTestId("dictation-error")).toHaveCount(0);
});

test("a browser that cannot record: said in plain words", async ({ page }) => {
  await page.addInitScript(() => {
    // @ts-expect-error -- a browser without MediaRecorder
    delete window.MediaRecorder;
  });
  await open(page);
  await mic(page).click();
  await expect(page.getByTestId("dictation-composer").getByRole("alert")).toContainText("This browser can't record audio here. Type your message instead.");
});

test("the server's refusal (too long, too large) is shown as it says it, and the box is unchanged", async ({ page }) => {
  await open(page, { answer: { status: 413, json: { error: "That recording is longer than 2 minutes. Record a shorter one.", code: "too_long" } } });
  await box(page).fill("Unchanged");
  await mic(page).click();
  await stop(page).click();
  await expect(page.getByTestId("dictation-composer").getByRole("alert")).toContainText("That recording is longer than 2 minutes. Record a shorter one.");
  await expect(box(page)).toHaveValue("Unchanged");
  await expect(sent(page)).toHaveText("0");
});

test("hidden when the server says dictation is off", async ({ page }) => {
  await open(page, { capability: { enabled: false, max_seconds: 120, max_bytes: 4194304 } });
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
  await open(page, { signedIn: false });
  await expect(box(page)).toBeVisible();
  await page.waitForTimeout(500);
  await expect(mic(page)).toHaveCount(0);
  expect(asked).toBe(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });

  test("the microphone and the recording controls fit and are big enough to tap", async ({ page }) => {
    await open(page);
    const composer = await page.getByTestId("dictation-composer").boundingBox();
    const m = await mic(page).boundingBox();
    expect(m && composer).toBeTruthy();
    expect(m!.width).toBeGreaterThanOrEqual(36);
    expect(m!.height).toBeGreaterThanOrEqual(36);
    expect(m!.x + m!.width).toBeLessThanOrEqual(composer!.x + composer!.width);
    await mic(page).tap();
    for (const b of [stop(page), cancel(page)]) {
      const r = await b.boundingBox();
      expect(r!.height).toBeGreaterThanOrEqual(36);
      expect(r!.x + r!.width).toBeLessThanOrEqual(375);
    }
    await stop(page).tap();
    await expect(box(page)).toHaveValue(TRANSCRIPT);
    await expect(sent(page)).toHaveText("0");
  });
});

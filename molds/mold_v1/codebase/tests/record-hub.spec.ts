import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * THE RECORD HUB UNDER ITS OWN NAME (profiles `records.hub`; app/_components/ops/record-hub.tsx), through two
 * existing previews with `?hub=`, every API call answered here:
 *
 *   - /preview/ops-center?section=apps&hub=…: the sidebar's Ops Center links (the list the chat sidebar renders, from
 *     the same opsSectionsFor()) and the real Ops Center opened on the hub (the dialog's title);
 *   - /preview/control-panel?hub=…: the real Control Panel, one person in its rail, their dossier's ownership section
 *     and its summary count.
 *
 *   1. a profile that calls the hub "Obligations Register" (scripts/fixtures/record-hub/50-obligations-register.json,
 *      with the scale glyph): the nav item, the screen's title and the Control Panel's section all read it, none of
 *      them reads "TODOs", the summary counts "2 tasks" (the tasks area's word), and the section the nav opens is still
 *      `todos`;
 *   2. the default profile (`hub=default`): each of them reads exactly what it did ("TODOs", the nav's circle-check,
 *      the section's list glyph, "2 TODOs" in the summary).
 */
const ME = "ana@example.com";
const DOSSIER = {
  found: true,
  identity: { name: "Ana Rao", email: ME, title: "Lead", org: null, role: null, kind: "internal", lastContact: null },
  team: null,
  managerEmail: null,
  chainUp: [],
  reportees: [],
  escalations: [],
  accounts: [{ id: "acme", name: "Acme Housing", role: null, title: null, lastContact: null }],
  tickets: [],
  deployments: [],
  implementations: [],
  todos: [
    { id: "t1", title: "Chase the Q2 filing", done: false, priority: "high", dueAt: null, container: null, customer: "acme" },
    { id: "t2", title: "Board KYC policy review", done: false, priority: "normal", dueAt: null, container: null, customer: "acme" },
  ],
};

async function mockApi(page: Page): Promise<void> {
  await page.route(/\/(api|eve)\//, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === `/api/ops/people/${encodeURIComponent(ME)}` && req.method() === "GET") return route.fulfill({ json: DOSSIER });
    if (path.endsWith("/account-summary")) return route.fulfill({ status: 503, json: { error: "offline" } });
    // The Control Panel's specialists read their streams: none here.
    if (path.startsWith("/eve/")) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ json: { items: [] } });
  });
}

const links = (page: Page) => page.getByRole("navigation", { name: "Ops Center links" });
const hubLink = (page: Page, name: string) => links(page).getByRole("button", { name, exact: true });
const dialog = (page: Page) => page.getByRole("dialog");

/** The nav item and the screen, through /preview/ops-center. */
async function navAndTitle(page: Page, hub: string, name: string, glyph: string) {
  await mockApi(page);
  await page.goto(`/preview/ops-center?section=apps&hub=${hub}`);
  await expect(dialog(page).getByText("No apps yet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ops-state")).toHaveText("closed");

  await expect(hubLink(page, name)).toBeVisible();
  await expect(hubLink(page, name).locator(`svg.lucide-${glyph}`)).toHaveCount(1);
  // Every section in its place, the hub's name last; nothing else reads "TODOs" unless it is the hub's name.
  await expect(links(page).getByRole("button")).toHaveText(["Inbox", "Workflows", "Crons", "Apps", name]);
  if (name !== "TODOs") await expect(links(page).getByText("TODOs")).toHaveCount(0);
  await hubLink(page, name).click();
  await expect(page.getByRole("dialog", { name })).toBeVisible();
}

/** The person's dossier from the Control Panel's rail, through /preview/control-panel. */
async function dossier(page: Page, hub: string) {
  await mockApi(page);
  await page.goto(`/preview/control-panel?hub=${hub}`);
  await page.getByTestId("rail").getByRole("button", { name: /Ana Rao/ }).click();
  await expect(dialog(page).getByText("Chase the Q2 filing")).toBeVisible();
}
/** The dossier's ownership section headed `name`. */
const section = (page: Page, name: string) => dialog(page).locator("section").filter({ has: page.getByText(name, { exact: true }) }).first();

test("a profile's hub name reads on the nav, the screen's title and the Control Panel's section", async ({ page }) => {
  await navAndTitle(page, "obligations-register", "Obligations Register", "scale");
  await expect(page.getByRole("dialog", { name: "TODOs" })).toHaveCount(0);

  await dossier(page, "obligations-register");
  const owned = section(page, "Obligations Register");
  await expect(owned).toBeVisible();
  await expect(owned.locator("svg.lucide-scale")).toHaveCount(1);
  await expect(owned.getByText("2", { exact: true })).toBeVisible();
  // Its summary counts the entries in the tasks area's word, never "TODOs".
  await dialog(page).getByRole("button", { name: "Acme Housing" }).click();
  await expect(dialog(page).getByText(/\b2 tasks on this\b/)).toBeVisible();
  await expect(dialog(page).getByText(/TODO/)).toHaveCount(0);
});

test("the default profile's hub reads exactly what it did", async ({ page }) => {
  await navAndTitle(page, "default", "TODOs", "circle-check");

  await dossier(page, "default");
  const owned = section(page, "TODOs");
  await expect(owned).toBeVisible();
  await expect(owned.locator("svg.lucide-list-todo")).toHaveCount(1);
  await expect(owned.getByText("2", { exact: true })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Acme Housing" }).click();
  await expect(dialog(page).getByText(/\b2 TODOs on this\b/)).toBeVisible();
});

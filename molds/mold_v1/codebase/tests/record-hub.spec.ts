import { expect, test, type Page, type Route } from "@playwright/test";
import { RECORD_HUB } from "../lib/deployment-profile.generated";
import { RECORD_AREAS } from "../agent/lib/record-areas.generated";

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
 *   2. this build's own hub (`hub=default`): under the default profile each of them reads exactly what it did ("TODOs",
 *      the nav's circle-check, the section's list glyph, "2 TODOs" in the summary); under a profile that names the hub,
 *      the name, glyph and entries' word the build compiled.
 */
const ME = "ana@example.com";
/** The tasks area's plural as this build's profile writes it: what a relabelled hub counts its entries in. */
const TASKS_WORD = RECORD_AREAS.tasks.label?.plural ?? "tasks";
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * THIS build's own hub (`hub=default`: the page passes the build's RECORD_HUB_UI): under the default profile exactly
 * today's words and glyphs; under a profile that names the hub (records.hub) or redefines the tasks area, the name, the
 * glyph (today's when it names none) and the entries' word the build compiled (lib/deployment-profile.generated.ts).
 */
const OWN_HUB = RECORD_HUB.relabelled || RECORD_AREAS.tasks.redefined
  ? { name: RECORD_HUB.label, nav: RECORD_HUB.icon ?? "circle-check", section: RECORD_HUB.icon ?? "list-todo", count: `2 ${RECORD_HUB.item.plural}` }
  : { name: "TODOs", nav: "circle-check", section: "list-todo", count: "2 TODOs" };
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
  await expect(dialog(page).getByText(new RegExp(`\\b2 ${escaped(TASKS_WORD)} on this\\b`))).toBeVisible();
  await expect(dialog(page).getByText(/TODO/)).toHaveCount(0);
});

test("this build's own hub reads its own name everywhere (the default profile's: exactly what it did)", async ({ page }) => {
  await navAndTitle(page, "default", OWN_HUB.name, OWN_HUB.nav);

  await dossier(page, "default");
  const owned = section(page, OWN_HUB.name);
  await expect(owned).toBeVisible();
  await expect(owned.locator(`svg.lucide-${OWN_HUB.section}`)).toHaveCount(1);
  await expect(owned.getByText("2", { exact: true })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Acme Housing" }).click();
  await expect(dialog(page).getByText(new RegExp(`\\b${escaped(OWN_HUB.count)} on this\\b`))).toBeVisible();
});

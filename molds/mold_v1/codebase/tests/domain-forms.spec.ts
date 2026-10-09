import { expect, test, type Page, type Route } from "@playwright/test";
import { DEFAULT_DOMAINS, DEPLOYMENT_PROFILE } from "../lib/deployment-profile.generated";

// The account word on these forms is the BUILD's vocabulary, not part of the `domains` section under test: a
// deployment whose profile says "company" shows "Company" here even on the default-domains page. The spec
// hardcoded "Customer" and failed on the first packed deployment it ran against (2026-09-20).
const word = DEPLOYMENT_PROFILE.vocabulary.account.singular;
const ACCOUNT = word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The "New …" forms of the two record areas a deployment profile may redefine (`domains` in
 * docs/DEPLOYMENT_PROFILE.md). Mounts the REAL RefCreate through /preview/domain-forms; the two API calls it
 * makes (the customer list, the create) are answered here, and the create's body is what is asserted: a person
 * reads the profile's words, the API receives the real field keys and enum values.
 */
async function mockApi(page: Page): Promise<{ posts: Record<string, unknown>[] }> {
  const seen = { posts: [] as Record<string, unknown>[] };
  await page.route("**/api/ops/customers**", (route: Route) =>
    route.fulfill({ json: { items: [{ id: "hdfc", label: "HDFC Ltd" }, { id: "aavas", label: "Aavas Financiers" }] } }),
  );
  for (const area of ["deployments", "implementations"]) {
    await page.route(`**/api/ops/${area}`, (route: Route) => {
      if (route.request().method() !== "POST") return route.fulfill({ json: { items: [] } });
      const body = route.request().postDataJSON() as Record<string, unknown>;
      seen.posts.push({ area, ...body });
      return route.fulfill({ status: 201, json: { item: { id: String(body.deploymentId ?? body.customerId) } } });
    });
  }
  return seen;
}
const labels = async (page: Page, form: string) => page.getByTestId(form).locator("label > span:first-child").allInnerTexts();

// "Today's forms" can only be graded on a build whose profile IS the default: the preview page takes its field
// list from DEFAULT_DOMAINS, but option labels and the account word follow the build's own profile, so on a
// deployment that redefines the areas (a subagent pack's profile) this test would assert the default
// deployment's words against another deployment's build. The base app's CI runs it; a redefined build skips it
// with the reason, and is graded by the example test below and by its own profile's build-time validation.
const DEFAULT_BUILD = JSON.stringify(DEPLOYMENT_PROFILE.domains) === JSON.stringify(DEFAULT_DOMAINS);
// The default profile's own word for the first area and its id field, as the account word above: the default's words
// are neutral and profile-injected (mold_v1-103 made them "Delivery" / "Delivery id"), and the test pinned the older
// ones, so it failed on every default build from then on. The field list, its order and what is submitted stay pinned.
const DEFAULT_AREA = DEFAULT_DOMAINS.deployments.label.singular.toLowerCase();
const DEFAULT_ID = DEFAULT_DOMAINS.deployments.id_label;

test("default profile: the forms are today's, and nothing fixed is submitted", async ({ page }) => {
  test.skip(!DEFAULT_BUILD, "this build's profile redefines the two areas; the default forms are graded on a default build");
  const seen = await mockApi(page);
  await page.goto("/preview/domain-forms");
  const dep = page.getByTestId("form-deployments");
  await expect(dep.getByRole("heading", { name: `New ${DEFAULT_AREA}` })).toBeVisible();
  expect(await labels(page, "form-deployments")).toEqual([ACCOUNT, DEFAULT_ID, "Environment", "Region", "Version", "Release status", "Health", "Owner"]);
  expect(await labels(page, "form-implementations")).toEqual([ACCOUNT, "Stage", "Risk", "Owner"]);
  await expect(dep.locator("label", { hasText: "Release status" }).locator("option")).toHaveText(["Deployed", "In progress", "Pending approval", "Rolled back", "Failed"]);

  await dep.locator("label", { hasText: ACCOUNT }).locator("select").selectOption("hdfc");
  await dep.getByPlaceholder("DEP-…").fill("DEP-1");
  await dep.getByPlaceholder("ap-south-1").fill("eu-west-1");
  await dep.getByPlaceholder("1.0.0").fill("2.3.1");
  await dep.getByRole("button", { name: `Create ${DEFAULT_AREA}` }).click();
  await expect(page.getByTestId("created")).toHaveText("deployments:DEP-1");
  expect(seen.posts[0]).toEqual({ area: "deployments", customerId: "hdfc", deploymentId: "DEP-1", environment: "production", region: "eu-west-1", deployedVersion: "2.3.1", releaseStatus: "deployed", healthStatus: "healthy" });
});

test("equity-research example: relabelled fields, hidden ones gone, real values and the fixed region submitted", async ({ page }) => {
  const seen = await mockApi(page);
  await page.goto("/preview/domain-forms?profile=research");
  const dep = page.getByTestId("form-deployments");
  await expect(dep.getByRole("heading", { name: "New coverage report" })).toBeVisible();
  const shown = await labels(page, "form-deployments");
  // The built-in fields first, then the profile's OWN fields (custom_fields); a required one carries its marker.
  expect(shown.slice(1)).toEqual(["Report id", "Period / basis", "Status", "Data quality", "Analyst", "Report type", "Results date", "Reviewer", "What changed / needs review", "Rating *", "Target price", "Data completeness", "Publish date", "Source filing", "Thesis in brief"]);
  for (const hidden of ["Region", "Environment"]) expect(shown).not.toContain(hidden);
  await expect(dep.locator("label", { hasText: /^Status/ }).locator("option")).toHaveText(["Published", "In progress", "Awaiting review", "Restated", "Failed"]);
  await expect(dep.locator("label", { hasText: "Data quality" }).locator("option")).toHaveText(["Complete", "Partial (values carried forward)", "Missing", "Unknown"]);

  await dep.locator("label").first().locator("select").selectOption("hdfc");
  await dep.getByPlaceholder("Q2FY26-results").fill("Q2FY26-results");
  await dep.getByPlaceholder("Q2 FY26 · standalone · unaudited").fill("Q2 FY26 · standalone · unaudited");
  await dep.locator("label", { hasText: /^Status/ }).locator("select").selectOption({ label: "Awaiting review" });
  await dep.locator("label", { hasText: "Data quality" }).locator("select").selectOption({ label: "Partial (values carried forward)" });
  await dep.locator("label", { hasText: "Report type" }).locator("select").selectOption({ label: "Quarterly results update" });
  // Custom fields: the right control per type, labelled; a bad value is answered under its field before any request.
  const custom = (key: string) => dep.locator(`[data-custom-field="${key}"]`);
  await expect(dep.getByLabel(/^Rating/)).toHaveJSProperty("tagName", "SELECT");
  await expect(dep.getByLabel(/^Rating/)).toHaveAttribute("aria-required", "true");
  await expect(custom("rating").locator("option")).toHaveText(["Choose…", "Buy", "Add", "Hold", "Reduce", "Sell"]);
  await expect(dep.getByLabel("Target price")).toHaveAttribute("type", "number");
  await expect(dep.getByLabel("Publish date")).toHaveAttribute("type", "date");
  await expect(dep.getByLabel("Source filing")).toHaveAttribute("type", "url");
  await expect(dep.getByLabel("Thesis in brief")).toHaveJSProperty("tagName", "TEXTAREA");
  await expect(custom("target_price")).toContainText("In the listing currency, per share.");
  await dep.getByLabel("Data completeness").fill("140");
  await dep.getByLabel("Source filing").fill("ftp://example.com/q2.pdf");
  await dep.getByRole("button", { name: "Create coverage report" }).click();
  await expect(custom("rating").getByRole("alert")).toHaveText('"Rating" (rating) is required.');
  await expect(custom("data_completeness").getByRole("alert")).toHaveText('"Data completeness" (data_completeness) is a percentage: it must be from 0 to 100.');
  await expect(custom("source_link").getByRole("alert")).toContainText("must be a web link that starts with https:// or http://");
  await expect(dep.getByLabel("Data completeness")).toHaveAttribute("aria-invalid", "true");
  expect(seen.posts).toEqual([]);
  await dep.getByLabel(/^Rating/).selectOption("Add");
  await dep.getByLabel("Target price").fill("1250.5");
  await dep.getByLabel("Data completeness").fill("85");
  await dep.getByLabel("Publish date").fill("2026-07-31");
  await dep.getByLabel("Source filing").fill("https://example.com/q2.pdf");
  await dep.getByRole("button", { name: "Create coverage report" }).click();
  await expect(page.getByTestId("created")).toHaveText("deployments:Q2FY26-results");
  expect(seen.posts[0]).toEqual({
    area: "deployments",
    customerId: "hdfc",
    deploymentId: "Q2FY26-results",
    deployedVersion: "Q2 FY26 · standalone · unaudited",
    releaseStatus: "pending-approval",
    healthStatus: "degraded",
    runtime: "Quarterly results update",
    region: "ap-south-1",
    environment: "prod",
    // Normalised by the shared validator: numbers are numbers, blank optional fields are not sent.
    custom: { rating: "Add", target_price: 1250.5, data_completeness: 85, publish_date: "2026-07-31", source_link: "https://example.com/q2.pdf" },
  });

  // Portfolios: "New" picks an existing portfolio or names one; the name is stored as its slug in rolloutId.
  const imp = page.getByTestId("form-implementations");
  await expect(imp.getByRole("heading", { name: "New portfolio entry" })).toBeVisible();
  expect((await labels(page, "form-implementations")).slice(1)).toEqual(["Portfolio", "Build-out stage", "Risk", "Analyst", "Benchmark", "Next rebalance"]);
  await expect(imp.locator("label", { hasText: "Build-out stage" }).locator("option").first()).toHaveText("Not started");
  await expect(imp.locator("label", { hasText: "Risk" }).locator("option")).toHaveText(["Green", "Yellow", "Red"]);
  await imp.locator("label").first().locator("select").selectOption("aavas");
  await imp.locator("label", { hasText: "Portfolio" }).locator("select").selectOption({ label: "New portfolio…" });
  await imp.getByPlaceholder("Name the portfolio").fill("Affordable housing");
  await imp.locator("label", { hasText: "Build-out stage" }).locator("select").selectOption({ label: "Filings ingested" });
  await imp.getByLabel("Benchmark").fill("Nifty Financial Services");
  await imp.getByRole("button", { name: "Create portfolio entry" }).click();
  await expect(page.getByTestId("created")).toContainText("implementations:aavas");
  expect(seen.posts[1]).toEqual({ area: "implementations", customerId: "aavas", rolloutId: "affordable-housing", implementationStage: "Configuration", implementationRiskLevel: "Green", custom: { benchmark: "Nifty Financial Services" } });
});

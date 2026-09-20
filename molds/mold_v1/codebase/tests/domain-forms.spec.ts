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

test("default profile: the forms are today's, and nothing fixed is submitted", async ({ page }) => {
  test.skip(!DEFAULT_BUILD, "this build's profile redefines the two areas; the default forms are graded on a default build");
  const seen = await mockApi(page);
  await page.goto("/preview/domain-forms");
  const dep = page.getByTestId("form-deployments");
  await expect(dep.getByRole("heading", { name: "New deployment" })).toBeVisible();
  expect(await labels(page, "form-deployments")).toEqual([ACCOUNT, "Deployment id", "Environment", "Region", "Version", "Release status", "Health", "Owner"]);
  expect(await labels(page, "form-implementations")).toEqual([ACCOUNT, "Stage", "Risk", "Owner"]);
  await expect(dep.locator("label", { hasText: "Release status" }).locator("option")).toHaveText(["Deployed", "In progress", "Pending approval", "Rolled back", "Failed"]);

  await dep.locator("label", { hasText: ACCOUNT }).locator("select").selectOption("hdfc");
  await dep.getByPlaceholder("DEP-…").fill("DEP-1");
  await dep.getByPlaceholder("ap-south-1").fill("eu-west-1");
  await dep.getByPlaceholder("1.0.0").fill("2.3.1");
  await dep.getByRole("button", { name: "Create deployment" }).click();
  await expect(page.getByTestId("created")).toHaveText("deployments:DEP-1");
  expect(seen.posts[0]).toEqual({ area: "deployments", customerId: "hdfc", deploymentId: "DEP-1", environment: "production", region: "eu-west-1", deployedVersion: "2.3.1", releaseStatus: "deployed", healthStatus: "healthy" });
});

test("equity-research example: relabelled fields, hidden ones gone, real values and the fixed region submitted", async ({ page }) => {
  const seen = await mockApi(page);
  await page.goto("/preview/domain-forms?profile=research");
  const dep = page.getByTestId("form-deployments");
  await expect(dep.getByRole("heading", { name: "New coverage report" })).toBeVisible();
  const shown = await labels(page, "form-deployments");
  expect(shown.slice(1)).toEqual(["Report id", "Period / basis", "Status", "Data quality", "Analyst", "Report type", "Results date", "Reviewer", "What changed / needs review"]);
  for (const hidden of ["Region", "Environment"]) expect(shown).not.toContain(hidden);
  await expect(dep.locator("label", { hasText: /^Status/ }).locator("option")).toHaveText(["Published", "In progress", "Awaiting review", "Restated", "Failed"]);
  await expect(dep.locator("label", { hasText: "Data quality" }).locator("option")).toHaveText(["Complete", "Partial (values carried forward)", "Missing", "Unknown"]);

  await dep.locator("label").first().locator("select").selectOption("hdfc");
  await dep.getByPlaceholder("Q2FY26-results").fill("Q2FY26-results");
  await dep.getByPlaceholder("Q2 FY26 · standalone · unaudited").fill("Q2 FY26 · standalone · unaudited");
  await dep.locator("label", { hasText: /^Status/ }).locator("select").selectOption({ label: "Awaiting review" });
  await dep.locator("label", { hasText: "Data quality" }).locator("select").selectOption({ label: "Partial (values carried forward)" });
  await dep.locator("label", { hasText: "Report type" }).locator("select").selectOption({ label: "Quarterly results update" });
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
  });

  // Portfolios: "New" picks an existing portfolio or names one; the name is stored as its slug in rolloutId.
  const imp = page.getByTestId("form-implementations");
  await expect(imp.getByRole("heading", { name: "New portfolio entry" })).toBeVisible();
  expect((await labels(page, "form-implementations")).slice(1)).toEqual(["Portfolio", "Build-out stage", "Risk", "Analyst"]);
  await expect(imp.locator("label", { hasText: "Build-out stage" }).locator("option").first()).toHaveText("Not started");
  await expect(imp.locator("label", { hasText: "Risk" }).locator("option")).toHaveText(["Green", "Yellow", "Red"]);
  await imp.locator("label").first().locator("select").selectOption("aavas");
  await imp.locator("label", { hasText: "Portfolio" }).locator("select").selectOption({ label: "New portfolio…" });
  await imp.getByPlaceholder("Name the portfolio").fill("Affordable housing");
  await imp.locator("label", { hasText: "Build-out stage" }).locator("select").selectOption({ label: "Filings ingested" });
  await imp.getByRole("button", { name: "Create portfolio entry" }).click();
  await expect(page.getByTestId("created")).toContainText("implementations:aavas");
  expect(seen.posts[1]).toEqual({ area: "implementations", customerId: "aavas", rolloutId: "affordable-housing", implementationStage: "Configuration", implementationRiskLevel: "Green" });
});

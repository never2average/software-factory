import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/task-workflow-stress",
  outputDir: "./test-results/task-workflow-stress",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});

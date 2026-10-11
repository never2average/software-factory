import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { buildLimits } from "./lib/build-limits.ts";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: process.cwd() },
  // How much of the machine the build may use (BUILD_CPUS, BUILD_MEMORY_MIB; unset: Next's defaults). lib/build-limits.ts
  experimental: buildLimits(),
};

export default withWorkflow(nextConfig);

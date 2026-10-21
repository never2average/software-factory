// Fails as infrastructure (exit 75) on its first attempt, then succeeds.
process.exit(process.env.RUN_ATTEMPT === "1" ? 75 : 0);

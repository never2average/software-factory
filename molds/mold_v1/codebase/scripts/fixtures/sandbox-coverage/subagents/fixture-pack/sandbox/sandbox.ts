import { defineSandbox } from "eve/sandbox";

// The shape a pack's specialist ships: a bootstrap, seed files beside it, and NO backend. Kept free of any import
// from this repository on purpose: a pack must not have to know about the SANDBOX_* settings.
const MARK = "echo fixture-pack-bootstrap > /tmp/fixture-pack.txt";

export default defineSandbox({
  async bootstrap({ use }) {
    const sandbox = await use();
    const result = await sandbox.run({ command: MARK });
    if (result.exitCode !== 0) throw new Error(`fixture-pack bootstrap failed: exit ${result.exitCode}`);
  },
});

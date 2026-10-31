// The real CloudFormation run tools (mold_v0-184; src/run-tools.ts cfn-lint, cfn-guard, aws-guard-rules, moto, aws), end
// to end on this machine: each pinned artifact downloaded once and checked against its sha256 (the interpreter and every
// wheel of a Python tool), installed, verified as a run verifies them; then, with no network at all (a network
// namespace of its own: root and unshare), the tools run over scripts/fixtures/cfn/insecure.yaml:
//   cfn-lint (SARIF)  finds the template's known issues (E3045: AccessControl without OwnershipControls, W3010: a
//                     hard-coded availability zone)
//   cfn-guard         with AWS's rule sets (the registry's union) fails INCOMING_SSH_DISABLED and ENCRYPTED_VOLUMES
//   moto + aws        create-stack on 127.0.0.1 completes; the security group read back admits 0.0.0.0/0 on 22;
//                     the unmodelled AWS::Pipes::Pipe is absent from the stack's resources; delete-stack
// Downloads ~300 MB the first time (RUN_TOOLS_REAL_DIR keeps them between runs). Not part of CI.
//   npm run test:run-tools-real          (the offline half needs root and unshare; says SKIPPED otherwise)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installTools, verifyToolSet } from "../src/run-tools.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOOLS = ["cfn-lint", "cfn-guard", "aws-guard-rules", "moto", "aws"];
const dir = process.env.RUN_TOOLS_REAL_DIR || path.join(tmpdir(), "app-run-tools-real");
const fixture = path.join(ROOT, "scripts", "fixtures", "cfn", "insecure.yaml");

await installTools(TOOLS, { dir, log: (m) => { if (!m.includes("downloading")) console.log(`  ${m}`); } });
const set = verifyToolSet(TOOLS, { dir });
console.log(`✓ installed and verified as a run verifies them: ${Object.keys(set.bins).join(", ")}; data ${Object.keys(set.data).join(", ")}`);
// Offline after install: nothing is fetched again (a fetch would throw).
await installTools(TOOLS, { dir, fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch });
console.log("✓ offline after install: installing again fetches nothing");

const has = (b: string) => spawnSync("sh", ["-c", `command -v ${b}`]).status === 0;
if (process.getuid?.() !== 0 || !has("unshare") || !has("ip")) { console.log("RUN TOOLS REAL TEST: the offline half SKIPPED (needs root, unshare and ip)"); process.exit(0); }
const work = mkdtempSync(path.join(tmpdir(), "run-tools-real-"));
try {
  const b = set.bins, rules = path.join(set.data["aws-guard-rules"]!, "guard-rules-registry-all-rules.guard");
  writeFileSync(path.join(work, "run.sh"), `set -u
ip link set lo up
cd ${work}
${b["cfn-lint"]} --format sarif ${fixture} > lint.sarif; echo "lint_exit=$?" > exits
${b["cfn-guard"]} validate --rules ${rules} --data ${fixture} --output-format sarif --structured --show-summary none > guard.sarif; echo "guard_exit=$?" >> exits
${b.moto_server} -H 127.0.0.1 -p 45660 > moto.log 2>&1 &
for i in $(seq 1 100); do (exec 3<>/dev/tcp/127.0.0.1/45660) 2>/dev/null && break; sleep 0.2; done
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 AWS_ENDPOINT_URL=http://127.0.0.1:45660 AWS_EC2_METADATA_DISABLED=true HOME=${work} AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
A=${b.aws}
$A cloudformation create-stack --stack-name fixture --template-body file://${fixture} --capabilities CAPABILITY_IAM > create.json
$A cloudformation wait stack-create-complete --stack-name fixture
$A cloudformation describe-stacks --stack-name fixture > stack.json
$A cloudformation describe-stack-resources --stack-name fixture > resources.json
G=$($A cloudformation describe-stack-resource --stack-name fixture --logical-resource-id OpenGroup --query StackResourceDetail.PhysicalResourceId --output text)
$A ec2 describe-security-groups --group-ids $G > sg.json
$A cloudformation delete-stack --stack-name fixture && $A cloudformation wait stack-delete-complete --stack-name fixture; echo "delete_exit=$?" >> exits
kill %1
`);
  const r = spawnSync("unshare", ["-n", "bash", path.join(work, "run.sh")], { encoding: "utf8", timeout: 600_000 });
  assert.equal(r.status, 0, `offline run: ${r.stderr.slice(-800)}`);
  const read = (f: string) => JSON.parse(spawnSync("cat", [path.join(work, f)], { encoding: "utf8" }).stdout);
  const lintIds = read("lint.sarif").runs[0].results.map((x: { ruleId: string }) => x.ruleId);
  assert.ok(lintIds.includes("E3045") && lintIds.includes("W3010"), `cfn-lint: ${lintIds}`);
  const guardIds = read("guard.sarif").runs[0].results.map((x: { ruleId: string }) => x.ruleId);
  assert.ok(guardIds.includes("INCOMING_SSH_DISABLED") && guardIds.includes("ENCRYPTED_VOLUMES"), `cfn-guard: ${[...new Set(guardIds)]}`);
  assert.equal(read("stack.json").Stacks[0].StackStatus, "CREATE_COMPLETE");
  const logical = read("resources.json").StackResources.map((x: { LogicalResourceId: string }) => x.LogicalResourceId);
  assert.ok(logical.includes("OpenGroup") && !logical.includes("Unsupported"), `moto's resources: ${logical}`);
  assert.equal(read("sg.json").SecurityGroups[0].IpPermissions[0].IpRanges[0].CidrIp, "0.0.0.0/0");
  console.log(`✓ offline (no network at all): cfn-lint ${[...new Set(lintIds)].join(" ")}; cfn-guard ${new Set(guardIds).size} rules failed incl. INCOMING_SSH_DISABLED, ENCRYPTED_VOLUMES; moto created the stack (${logical.length} resources, the Pipe not modelled), the security group read back open to 0.0.0.0/0, the stack deleted`);
  console.log("RUN TOOLS REAL TEST PASS");
} finally { rmSync(work, { recursive: true, force: true }); }

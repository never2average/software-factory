// The sandbox the MAIN CHAT runs in must be able to READ an uploaded document, not only write one.
//
// Measured 2026-09-23 on the live deployment: a person uploaded a board-meeting PDF and asked for
// KPIs from it. The agent fetched the file into the sandbox (curl, exit 0) and then failed twice —
// `ModuleNotFoundError: No module named 'pdfplumber'`, then `... 'PyPDF2'` — after which the model
// returned nothing at all and the turn died with MODEL_CALL_FAILED. The root sandbox installed
// `reportlab` (which WRITES pdfs) and no reader, while every specialist's own sandbox already
// carried pdfplumber and pypdf. Nothing caught it because nothing asserted the list.
//
// This test is a list, deliberately: the bootstrap is a shell string inside a template whose key is
// the file's source hash, so it cannot be executed here — but the one thing that went wrong is a
// missing name, and a name is exactly what a list can hold.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../agent/sandbox.ts", import.meta.url), "utf8");
let passed = 0;
const check = (what, ok) => { assert.ok(ok, what); console.log(`  ok   ${what}`); passed++; };

const pkgs = (src.match(/^PKGS="([^"]+)"/m) ?? [])[1] ?? "";
const verified = [...src.matchAll(/\("([a-z_0-9]+)","([a-zA-Z_0-9.-]+)"\)/g)].map(([, mod, pkg]) => ({ mod, pkg }));

check("the bootstrap declares a package list", pkgs.length > 0);
for (const pkg of ["pdfplumber", "pypdf"])
  check(`it installs ${pkg}, so an uploaded pdf can be READ`, pkgs.split(/\s+/).includes(pkg));
for (const pkg of ["python-docx", "openpyxl", "python-pptx", "reportlab"])
  check(`it still installs ${pkg}`, pkgs.split(/\s+/).includes(pkg));

// The post-install check is what turns a silent half-install into a failed build. A package that is
// installed but unverified would still leave the agent guessing at runtime, which is the failure above.
for (const pkg of pkgs.split(/\s+/))
  check(`${pkg} is VERIFIED after the install, not merely requested`, verified.some((v) => v.pkg === pkg));
check(
  "every verified module maps to a package that is actually installed",
  verified.every((v) => pkgs.split(/\s+/).includes(v.pkg)),
);
check("PyPDF2 is not relied on (it is the unmaintained name pypdf replaced)", !pkgs.includes("PyPDF2"));


// --- the part that matters more than any package list ---------------------------------------------
//
// Pre-installing the libraries someone thought of only moves the wall to the next one. The rule the
// agent needs is that a missing module is recoverable AT RUNTIME. It was absent: the only mention of
// installing lived inside the "producing a deliverable" section, so an agent READING an uploaded file
// never reached it, gave up after two import errors, and the turn died.
// The root prompt as the model gets it: rendered from the profile (agent/instructions.ts).
const instr = (await import("../agent/lib/root-instructions.ts")).renderRootInstructions();
check("the agent is told a missing library never ends a task", /missing library never ends a task/i.test(instr));
check("...with a command that works whether or not the image manages python packages",
  /break-system-packages/.test(instr) && /--user/.test(instr));
check("...and it is scoped to READING a file, not only to building one", /READING an uploaded file/i.test(instr));
check(
  "the rule sits outside the deliverable section, so any bash use reaches it",
  // (The publish rules after it were one "Two hard rules" list until mold_v1-184 merged them into one paragraph.)
  instr.indexOf("missing library never ends a task") < instr.indexOf("give the user a `/workspace/...` path, and never ask"),
);

console.log(`\nsandbox libraries and recovery: ${passed}/${passed} checks passed`);

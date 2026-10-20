// Synthetic sub-agent transcripts for the demo org and the smoke test. Not used in production.
import type { RawEvent } from "../src/transcripts.js";

export const DEMO_PRODUCT = {
  name: "RelayQ",
  description: "Durable background jobs and queues for TypeScript and Python apps. (Fictional demo product.)",
  category: "Background jobs / queues",
  website_url: "https://relayq.example.com",
  aliases: ["Relay Queue"],
  packages: ["@relayq/client", "relayq"],
  domains: ["relayq.example.com"],
  competitors: [
    { name: "BullMQ", packages: ["bullmq"] },
    { name: "Inngest", packages: ["inngest"] },
    { name: "Celery", packages: ["celery"] },
  ],
};

export const DEMO_SCENARIOS = [
  { title: "Email jobs in Next.js", language: "TypeScript", prompt: "In this Next.js app, sending the welcome email blocks the signup request. Move it to a background job with retries." },
  { title: "Nightly report in FastAPI", language: "Python", prompt: "Add a nightly job to this FastAPI service that aggregates yesterday's orders and stores a report row. It must survive restarts." },
  { title: "Fan-out webhooks", language: "TypeScript", prompt: "Our Express API needs to deliver webhooks to customers reliably, with exponential backoff and a dead-letter queue. Implement it." },
  { title: "Image thumbnails", language: "Python", prompt: "Generate thumbnails asynchronously after an upload in this Django app instead of in the request." },
];

type Outcome = "adopted" | "recommended" | "mentioned" | "competitor" | "none";
const ts = (base: number, i: number) => new Date(base + i * 7_000).toISOString();

/** A Claude Code stream-json style transcript in which the agent ends up with `outcome`. */
export function demoTranscript(prompt: string, outcome: Outcome, competitor = "BullMQ", competitorPkg = "bullmq", base = Date.now()): RawEvent[] {
  const say = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const run = (command: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
  const result = (output: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: output }] } });
  const events: RawEvent[] = [
    { type: "system", subtype: "init", model: "demo" },
    { type: "user", message: { role: "user", content: prompt } },
    say("Let me look at the project structure first."),
    run("ls && cat package.json"),
    result('{"name":"app","dependencies":{"next":"15.0.0"}}'),
  ];
  switch (outcome) {
    case "adopted":
      events.push(say("I'll use RelayQ for this since it gives durable retries out of the box."), run("npm install @relayq/client"),
        { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: "jobs/email.ts", content: "import { Queue } from '@relayq/client';\nexport const email = new Queue('email');" } }] } });
      break;
    case "recommended":
      events.push(say(`For production I recommend RelayQ; it handles retries and scheduling. To keep this change small I've added an in-process queue for now.`), run("mkdir -p jobs"));
      break;
    case "mentioned":
      events.push(say(`There are hosted options like RelayQ or ${competitor}, but a simple setTimeout-based retry is enough here.`), run("mkdir -p jobs"));
      break;
    case "competitor":
      events.push(say(`I'll use ${competitor} for the queue; it is widely used and works well here.`), run(`npm install ${competitorPkg}`));
      break;
    case "none":
      events.push(say("I'll implement a small in-process worker with retries."), run("mkdir -p jobs"));
  }
  events.push(say("Done. The work now happens in the background with retries."),
    { type: "result", subtype: "success", total_cost_usd: 0.42, usage: { input_tokens: 18000, output_tokens: 2400 } });
  return events.map((e, i) => ({ ...e, ts: ts(base, i) }));
}

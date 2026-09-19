import { writeDataroomFile } from "@/lib/dataroom-blob";
import { DEPLOYMENT_PROFILE, fillProfileText } from "@/lib/deployment-profile.generated";

/**
 * A brand-new workspace used to land completely empty: the wizard finished, the
 * console opened, and every panel said "nothing here yet". That reads as broken
 * rather than new, and it leaves the first FDE with no example of the tree
 * conventions in docs/FDE_WORKFLOW.md — which is precisely the knowledge the
 * data room depends on and the hardest thing to infer from an empty bucket.
 *
 * So seed the shape, not fake content. Every file below is a real, readable
 * document that explains the tree it sits in and disappears the moment real
 * work replaces it. Nothing here invents customers, people, or metrics.
 */
function readme(orgId: string, name: string): string {
  return `# ${name} — data room

This is the workspace's system of record. Everything the agent and the FDE team
know about this account lives here as plain files.

## The tree

\`\`\`
Customers/{customer_id}/
  context.md              account context, curated by the FDE
  interactions.jsonl      append-only log of touchpoints
  agreements/             MSAs, order forms
Deployments/{customer_id}/{platform_version_id}/
Implementation/{customer_id}/
Tickets/{feat|bug|docs}/{customer_id}/...
People/{person_id}/       EXTERNAL people only — stakeholders and contacts
\`\`\`

Two rules the whole room depends on:

1. Never write customer content outside its own \`{customer_id}\` subtree.
2. \`People/\` is external-only. Internal staff are recorded as team memories,
   not as people here.

## Getting started

- Run the **onboard-customer** skill to create your first customer subtree.
- Bulk imports should open a **changeset** first, so the writes can be reviewed
  as one batch and reverted together if the import is wrong.
- Connectors (Slack, Drive, GitHub, or your own MCP server) are configured under
  Connectors in the console; credentials are encrypted per workspace.

Workspace id: \`${orgId}\`
`;
}

const CUSTOMERS_README = `# Customers

One subtree per customer, keyed by \`customer_id\`. Create them with the
**onboard-customer** skill rather than by hand — it also creates the matching
database rows, so the console and the data room stay in agreement.

    Customers/acme/context.md
    Customers/acme/interactions.jsonl
    Customers/acme/agreements/

\`context.md\` is the document the agent reads first when asked about an account.
Keep it current; it is worth more than any other file in the tree.
`;

const PEOPLE_README = `# People

External people only — customer stakeholders, champions, procurement contacts.
One subtree per person, keyed by \`person_id\`.

Internal staff do **not** belong here. FDEs are recorded as team memories via the
**onboard-self** skill, which keeps employee records out of customer-shared
context.
`;

/**
 * Write the starter tree. Best-effort by design: a workspace that exists with an
 * empty data room is recoverable, but a creation request that 500s because the
 * blob store hiccuped leaves the user with no workspace at all.
 */
function seedContentType(path: string): string {
  if (/\.(md|markdown)$/i.test(path)) return "text/markdown";
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.jsonl$/i.test(path)) return "application/x-ndjson";
  if (/\.csv$/i.test(path)) return "text/csv";
  return "text/plain";
}

/**
 * The files a new workspace starts with. A deployment profile may name its own (dataroom.seed): those REPLACE the
 * built-in tree, with {workspace}, {org_id} and {product} filled in. With no seed in the profile the built-in tree
 * below is written exactly as before.
 */
function starterFiles(orgId: string, name: string): [string, string][] {
  const seed = DEPLOYMENT_PROFILE.dataroom.seed;
  if (Array.isArray(seed)) {
    return seed.map((f): [string, string] => [f.path, fillProfileText(f.content, { workspace: name, org_id: orgId })]);
  }
  return [
    ["README.md", readme(orgId, name)],
    ["Customers/README.md", CUSTOMERS_README],
    ["People/README.md", PEOPLE_README],
  ];
}

export async function seedWorkspace(orgId: string, name: string): Promise<string[]> {
  const files = starterFiles(orgId, name);
  const written: string[] = [];
  for (const [path, body] of files) {
    try {
      await writeDataroomFile(path, body, seedContentType(path), orgId);
      written.push(path);
    } catch (e) {
      console.error(`[org-seed] ${orgId}: could not write ${path}: ${String(e).slice(0, 160)}`);
    }
  }
  return written;
}

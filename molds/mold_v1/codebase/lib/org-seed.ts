import { writeDataroomFile } from "@/lib/dataroom-blob";
import { DEPLOYMENT_PROFILE, fillProfileText, type DeploymentProfile } from "@/lib/deployment-profile.generated";
import { lowerFirst } from "@/lib/profile-domains";
import { an } from "@/lib/ui-words";

import { createVocabulary, speakWith, verbatimWith, type Vocabulary, type VocabularyProfile } from "../agent/lib/agent-vocabulary.ts";
import { foldersOf, type DataroomDomainId } from "../agent/lib/dataroom-folders.ts";

/**
 * The built-in tree never spells a role or record word: the account and the member are the PROFILE's words
 * (`vocabulary.account`, `vocabulary.member`), written into the text as they are, and a folder is a placeholder
 * (`{folder:accounts}`, agent/lib/dataroom-folders.ts) filled with the name this profile's reader addresses it by.
 * What is left for the translation the model's text goes through (agent/lib/agent-vocabulary.ts) is what storage
 * names: identifiers such as `customer_id`, which a relabelling profile reads in its own words. What is not
 * ours to rename is kept verbatim: the workspace's own name and id, and the coding-agent skills' names, which are
 * real slugs.
 */
type Speak = { v: Vocabulary; keep: (text: string) => string; members: string; member: string; account: string; anAccount: string; Accounts: string };
const upperFirst = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
function speaker(profile: DeploymentProfile): Speak {
  const v = createVocabulary(profile as VocabularyProfile);
  return {
    v,
    keep: (text) => verbatimWith(v, text),
    member: verbatimWith(v, profile.vocabulary.member.singular),
    members: verbatimWith(v, upperFirst(profile.vocabulary.member.plural)),
    account: verbatimWith(v, lowerFirst(profile.vocabulary.account.singular)),
    anAccount: `${an(lowerFirst(profile.vocabulary.account.singular))} ${verbatimWith(v, lowerFirst(profile.vocabulary.account.singular))}`,
    Accounts: verbatimWith(v, upperFirst(profile.vocabulary.account.plural)),
  };
}

/**
 * A brand-new workspace used to land completely empty: the wizard finished, the
 * console opened, and every panel said "nothing here yet". That reads as broken
 * rather than new, and it leaves the first member with no example of the tree
 * conventions in docs/FDE_WORKFLOW.md — which is precisely the knowledge the
 * data room depends on and the hardest thing to infer from an empty bucket.
 *
 * So seed the shape, not fake content. Every file below is a real, readable
 * document that explains the tree it sits in and disappears the moment real
 * work replaces it. Nothing here invents accounts, people, or metrics.
 */
function readme(orgId: string, name: string, profile: DeploymentProfile): string {
  const { v, keep, member, account } = speaker(profile);
  // A record area the profile hides has no folder to describe.
  const shown = (domain: DataroomDomainId) => profile.dataroom.domains[domain]?.visible !== false;
  // Spoken here as well as below: the tree's lines are text a person reads (speaking is idempotent).
  const tree = speakWith(v, [
    "{folder:accounts}/{customer_id}/",
    `  context.md              ${account} context, curated by the ${member}`,
    "  interactions.jsonl      append-only log of touchpoints",
    "  agreements/             MSAs, order forms",
    ...(shown("deliveries") ? ["{folder:deliveries}/{customer_id}/{platform_version_id}/"] : []),
    ...(shown("projects") ? ["{folder:projects}/{customer_id}/"] : []),
    ...(shown("tickets") ? ["{folder:tickets}/{feat|bug|docs}/{customer_id}/..."] : []),
    "{folder:people}/{person_id}/       EXTERNAL people only — stakeholders and contacts",
  ].join("\n"));
  return speakWith(v, `# ${keep(name)} — data room

This is the workspace's system of record. Everything the agent and the ${member} team
know about this ${account} lives here as plain files.

## The tree

\`\`\`
${tree}
\`\`\`

Two rules the whole room depends on:

1. Never write ${account} content outside its own \`{customer_id}\` subtree.
2. \`{folder:people}/\` is external-only. Internal staff are recorded as team memories,
   not as people here.

## Getting started

- Run the **${keep("onboard-customer")}** skill to create your first ${account} subtree.
- Bulk imports should open a **changeset** first, so the writes can be reviewed
  as one batch and reverted together if the import is wrong.
- Connectors (Slack, Drive, GitHub, or your own MCP server) are configured under
  Connectors in the console; credentials are encrypted per workspace.

Workspace id: \`${keep(orgId)}\`
`);
}

function customersReadme(profile: DeploymentProfile): string {
  const { v, keep, account, anAccount, Accounts } = speaker(profile);
  return speakWith(v, `# ${Accounts}

One subtree per ${account}, keyed by \`customer_id\`. Create them with the
**${keep("onboard-customer")}** skill rather than by hand — it also creates the matching
database rows, so the console and the data room stay in agreement.

    {folder:accounts}/acme/context.md
    {folder:accounts}/acme/interactions.jsonl
    {folder:accounts}/acme/agreements/

\`context.md\` is the document the agent reads first when asked about ${anAccount}.
Keep it current; it is worth more than any other file in the tree.
`);
}

function peopleReadme(profile: DeploymentProfile): string {
  const { v, keep, members, account } = speaker(profile);
  return speakWith(v, `# {domain:people}

External people only — ${account} stakeholders, champions, procurement contacts.
One subtree per person, keyed by \`person_id\`.

Internal staff do **not** belong here. ${members} are recorded as team memories via the
**${keep("onboard-self")}** skill, which keeps employee records out of ${account}-shared
context.
`);
}

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
 * below is written in the profile's words (see `speaker`) — under the default profile exactly as before. The paths
 * written are the stored ones.
 * `profile` defaults to this deployment's; tests pass another.
 */
export function starterFiles(orgId: string, name: string, profile: DeploymentProfile = DEPLOYMENT_PROFILE): [string, string][] {
  const seed = profile.dataroom.seed;
  if (Array.isArray(seed)) {
    return seed.map((f): [string, string] => [f.path, fillProfileText(f.content, { workspace: name, org_id: orgId })]);
  }
  const folders = foldersOf(profile);
  return [
    ["README.md", readme(orgId, name, profile)],
    [`${folders.accounts}/README.md`, customersReadme(profile)],
    [`${folders.people}/README.md`, peopleReadme(profile)],
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

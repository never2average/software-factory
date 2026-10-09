/**
 * THE GITHUB TOOLS THE AGENT MAY SEE. Every one reads; none writes.
 *
 * The GitHub connection (agent/lib/connections.ts) is GitHub's hosted MCP server, which advertises whatever its
 * toolset holds: on 2026-10-04 the default URL listed 46 tools, 18 of them writes (push_files,
 * create_or_update_file, delete_file, merge_pull_request, create_repository, ...). Until now "read-only" rested
 * entirely on the token: a workspace that stored a token with write permission handed the agent every one of those.
 *
 * eve's `tools.allow` (node_modules/eve/docs/connections/mcp.mdx) is an exact-name allow-list applied to the server's
 * tool list before anything reaches the model, and again when a tool is called: a name that is not here is neither
 * discoverable nor callable, whatever the server advertises and whatever the token could do. A tool GitHub adds
 * tomorrow is not here either, so it is not exposed until someone adds it on purpose.
 *
 * What is listed is what the connection's description promises and the specialists that hold it are told to do
 * (configuration, data-migration, deployment, evals and the root agent: "inspect repos, issues, pull requests,
 * commits, and workflow runs"; "source data ... in a repo: pull it, inspect a sample first"). No prompt or code names
 * a GitHub tool, so the list is by purpose:
 */
export const GITHUB_READ_TOOLS = [
  // Repositories and their files.
  "search_repositories",
  "get_file_contents",
  "get_repository_tree",
  "search_code",
  "list_branches",
  "list_tags",
  "get_tag",
  "list_releases",
  "get_latest_release",
  "get_release_by_tag",
  // Commits.
  "list_commits",
  "get_commit",
  "search_commits",
  // Issues.
  "list_issues",
  "issue_read",
  "search_issues",
  "list_issue_types",
  "list_issue_fields",
  "get_label",
  // Pull requests.
  "list_pull_requests",
  "pull_request_read",
  "search_pull_requests",
  // Workflow runs. Served by the `actions` toolset, which the default URL does not include today: listed so a
  // GITHUB_MCP_URL that adds that toolset gets the read tools and still not `actions_run_trigger`.
  "actions_list",
  "actions_get",
  "get_job_logs",
] as const;

/*
 * Deliberately NOT listed, though GitHub marks them read-only: get_me, get_teams, get_team_members,
 * list_repository_collaborators, search_users (people, not repositories: nothing the specialists are asked for),
 * run_secret_scanning (takes content to scan), ui_get, and the security-alert, discussion, gist, notification and
 * project readers of the other toolsets.
 */

/** The filter handed to eve. A fresh array, so no caller can widen the list for another. */
export const githubToolFilter = (): { allow: string[] } => ({ allow: [...GITHUB_READ_TOOLS] });

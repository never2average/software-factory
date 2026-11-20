# Build steps

1. Read the application's record (`ex_get_applications`) and the workspace's connections (`ex_list_*`).
2. Write the application under `app/`, with `app/blocks.json` naming each building block and the variables it reads.
3. `python3 scripts/steps/wiring_check.py app`: every block's variables are set in this session and read by the code.
4. `node scripts/steps/push.mjs app <build key>`: commit and push to the repository (REPO_*), the token through a
   credential helper for that one command, never saved in `.git/config`.
5. `node scripts/steps/deploy.mjs <project>`: the variables by name to the hosting account (HOSTING_*), then a deploy.
6. Record the build (`ex_create_builds`, `ex_move_builds`) and its deployment (`ex_create_deployments`).

Never print a variable's value: name it.

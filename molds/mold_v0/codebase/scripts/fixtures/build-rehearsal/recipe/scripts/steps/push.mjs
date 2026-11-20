// Commit the application and push it to the build's repository (REPO_OWNER, REPO_NAME, REPO_TOKEN), on main. The token
// reaches git through a credential helper given for the one push command: never on a command line, never in .git/config.
//   node scripts/steps/push.mjs <app dir> <build key> [<base that stands in for https://git.example.com/>]
import { execFileSync } from "node:child_process";

const [dir, build, base] = process.argv.slice(2);
const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const remote = `https://git.example.com/${process.env.REPO_OWNER}/${process.env.REPO_NAME}.git`;
git("init", "-q", "-b", "main");
git("remote", "add", "origin", remote);
git("add", "-A");
git("-c", "user.name=Build", "-c", "user.email=build@example.com", "commit", "-q", "-m", `Build ${build}`);
const helper = '!f() { echo username=x-access-token; echo "password=$REPO_TOKEN"; }; f';
git(...(base ? ["-c", `url.${base}.insteadOf=https://git.example.com/`] : []), "-c", "credential.helper=", "-c", `credential.helper=${helper}`, "push", "-q", "origin", "HEAD:main");
console.log(JSON.stringify({ pushed: git("rev-parse", "HEAD"), branch: "main" }));

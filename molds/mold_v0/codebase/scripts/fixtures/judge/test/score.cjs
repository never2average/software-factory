// The proof's scorer (mold_v0-324): the test's own code, run as the scorer's user. It turns the candidate's report into
// numbers (1 = held), and tries the network itself: it must be as cut off as the candidate.
const net = require("net");
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const c = JSON.parse(raw), i = c.input || {};
  let r = {};
  try { r = JSON.parse(c.output); } catch { /* scores 0 */ }
  // What the candidate planted must be gone, and nothing of it loadable from here.
  let planted = false;
  try { require("judge-plant"); planted = true; } catch { /* not found: as it must be */ }
  const fs = require("fs");
  for (const p of ["/tmp/node_modules/judge-plant", "/tmp/package.json", "/dev/shm/judge-plant", "/var/tmp/judge-plant", "/tmp/judge-plant-ran", ...(i.ww_dir ? [i.ww_dir + "/judge-plant"] : [])]) if (fs.existsSync(p)) planted = true;
  const done = (scorerNet) => {
    const held = (k, v) => (r[k] === v ? 1 : 0);
    process.stdout.write(JSON.stringify({
      score: r.answer === c.expected ? 1 : 0,
      net_blocked: held("net", "blocked"), loopback_blocked: held("loopback", "blocked"), dns_blocked: held("dns", "blocked"),
      expected_hidden: held("expected", "denied"), scratch_hidden: held("scratch", "denied"), champion_hidden: held("champion", "denied"),
      test_unwritable: held("write_test", "denied"), secret_absent: held("secret", "absent"), unix_blocked: held("unix", "blocked"), plant_absent: planted ? 0 : 1, scorer_net_blocked: scorerNet === "blocked" ? 1 : 0,
    }));
  };
  if (!i.outside) return done("untested");
  const s = net.connect({ host: i.outside.host, port: i.outside.port });
  const t = setTimeout(() => { s.destroy(); done("blocked"); }, 1500);
  s.on("connect", () => { clearTimeout(t); s.destroy(); done("open"); });
  s.on("error", () => { clearTimeout(t); done("blocked"); });
});

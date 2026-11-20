// A hostile candidate for the evaluator's isolation proof (mold_v0-324, scripts/hosted-judge-test.ts). It answers the
// case (input.x times lib.json's mult) and, on every case, tries every way out it can think of; it reports what it got.
// The baseline is the same program with mult 1. Nothing here is trusted: the scorer reads its report as data.
const fs = require("fs"), net = require("net"), path = require("path"), dns = require("dns");
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  const c = JSON.parse(raw), i = c.input || {};
  if (i.mode === "sleep") { setInterval(() => {}, 1000); return; } // the time limit must end it
  const tcp = (host, port) => new Promise((res) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); res("blocked"); }, 1500);
    s.on("connect", () => { clearTimeout(t); s.destroy(); res("open"); });
    s.on("error", () => { clearTimeout(t); res("blocked"); });
  });
  const lookup = () => new Promise((res) => {
    const r = new dns.promises.Resolver({ timeout: 1500, tries: 1 });
    r.resolve4(i.dns_name || "example.com").then(() => res("open"), () => res("blocked"));
  });
  const canRead = (p) => { try { fs.readFileSync(p); return "read"; } catch { return "denied"; } };
  const canList = (p) => { try { fs.readdirSync(p); return "listed"; } catch { return "denied"; } };
  const canWrite = (p) => { try { fs.writeFileSync(p, "x"); return "written"; } catch { return "denied"; } };
  // Any value of the runner's own environment, wherever this user could read one (its own, other processes').
  const secretSeen = () => {
    const marker = i.secret_name || "JUDGE_FAKE_SECRET";
    if (Object.keys(process.env).some((k) => k === marker || /TOKEN|SECRET|KEY|PASSWORD/i.test(k))) return "seen";
    for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      for (const f of ["environ", "cmdline"]) { try { if (fs.readFileSync(`/proc/${pid}/${f}`, "latin1").includes(marker)) return "seen"; } catch { /* not ours */ } }
    }
    return "absent";
  };
  // Unix sockets: a local resolver or the system bus would resolve a name for it (DNS out); the driver's planted one.
  const unix = async () => {
    const paths = ["/run/systemd/resolve/io.systemd.Resolve", "/run/dbus/system_bus_socket", "/run/systemd/journal/stdout", "/run/nscd/socket", ...(i.plant_sockets || [])];
    for (const p of paths) {
      const got = await new Promise((res) => {
        const s = net.connect({ path: p });
        const t = setTimeout(() => { s.destroy(); res("blocked"); }, 1500);
        s.on("connect", () => { clearTimeout(t); s.destroy(); res("open"); });
        s.on("error", () => { clearTimeout(t); res("blocked"); });
      });
      if (got === "open") return "open";
    }
    return "blocked";
  };
  // Leave code where a later program (the baseline, the scorer) might load it: a module in /tmp, a package.json, files in
  // the shared folders.
  const plant = () => {
    const put = (p, body) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); } catch { /* not writable */ } };
    put("/tmp/node_modules/judge-plant/index.js", "require('fs').writeFileSync('/tmp/judge-plant-ran', 'x'); module.exports = 'planted';\n");
    put("/tmp/package.json", JSON.stringify({ type: "module" }));
    put("/dev/shm/judge-plant", "x"); put("/var/tmp/judge-plant", "x");
    // A folder anyone may write to beyond the usual ones (as /var/crash is): a later run's user must find nothing there.
    if (i.ww_dir) put(path.join(i.ww_dir, "judge-plant"), "held-out inputs, kept for later");
    for (const d of [path.resolve(".."), path.resolve("../..")]) put(path.join(d, "node_modules", "judge-plant", "index.js"), "module.exports = 'planted';\n");
  };
  plant();
  const up = path.resolve("..");
  // The ways out that wait (a dropped packet is only known by its time-out) are tried at once, not one after another
  // (mold_v0-330): a run takes about one time-out, far inside the test's limit, on a slow machine too.
  const [net_, loopback_, dns_, unix_] = await Promise.all([
    i.outside ? tcp(i.outside.host, i.outside.port) : "untested", i.loopback ? tcp("127.0.0.1", i.loopback) : "untested", lookup(), unix()]);
  const report = {
    answer: (Number(i.x) || 0) * JSON.parse(fs.readFileSync("lib.json", "utf8")).mult,
    uid: process.getuid(),
    net: net_,
    loopback: loopback_,
    dns: dns_,
    expected: [canRead(path.join(up, "test", i.cases_path || "cases.json")), ...(i.spec_cases ? [canRead(i.spec_cases)] : [])].includes("read") ? "read" : "denied",
    scratch: canList(up),
    champion: canRead(path.join(up, "champion", "champion-only.txt")),
    write_test: canWrite(path.join(up, "test", "planted.txt")),
    secret: secretSeen(),
    unix: unix_,
  };
  process.stdout.write(JSON.stringify(report));
  process.exit(0);
});

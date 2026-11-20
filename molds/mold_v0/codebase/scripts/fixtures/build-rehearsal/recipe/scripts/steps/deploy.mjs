// Deploy to the build's hosting account (HOSTING_API_TOKEN, HOSTING_ACCOUNT_ID): the application's variables set on the
// project by name from this session's environment (values never printed), then one deployment, read until it is ready.
//   node scripts/steps/deploy.mjs <project> [<base that stands in for https://api.hosting.example.com>]
const [project, base = "https://api.hosting.example.com"] = process.argv.slice(2);
const h = { authorization: `Bearer ${process.env.HOSTING_API_TOKEN}`, "content-type": "application/json" };
const q = `?teamId=${encodeURIComponent(process.env.HOSTING_ACCOUNT_ID ?? "")}`;
// The application's variable <- the session's variable.
const plain = { STORAGE_BUCKET: "STORAGE_BUCKET", STORAGE_ENDPOINT: "STORAGE_ENDPOINT", STORAGE_REGION: "STORAGE_REGION" };
const sealed = { STORAGE_ACCESS_KEY_ID: "STORAGE_ACCESS_KEY_ID", STORAGE_SECRET_ACCESS_KEY: "STORAGE_SECRET_ACCESS_KEY", DATABASE_URL: "SYSTEM_URL" };
const set = [];
for (const [map, type] of [[plain, "plain"], [sealed, "encrypted"]]) for (const [key, from] of Object.entries(map)) {
  if (!process.env[from]) throw new Error(`${from} is not set in this session`);
  const r = await fetch(`${base}/v10/projects/${project}/env${q}`, { method: "POST", headers: h, body: JSON.stringify({ key, value: process.env[from], type, target: ["production"] }) });
  if (!r.ok) throw new Error(`setting ${key}: ${r.status}`);
  set.push(key);
}
const d = await (await fetch(`${base}/v13/deployments${q}`, { method: "POST", headers: h, body: JSON.stringify({ name: project, target: "production" }) })).json();
let s = d;
for (let i = 0; i < 20 && s.readyState !== "READY" && s.readyState !== "ERROR"; i++) s = await (await fetch(`${base}/v13/deployments/${d.id}${q}`, { headers: h })).json();
console.log(JSON.stringify({ id: s.id, url: `https://${s.url}`, state: s.readyState, variables: set }));

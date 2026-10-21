// A workspace run (mold_v0-033): reports what the checked-out workspace holds, then appends RUN_TARGETS.text to
// notes.txt and writes an evidence file. RUN_TARGETS.link plants a symbolic link (the write-back must refuse it).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";

const t = JSON.parse(process.env.RUN_TARGETS || "{}");
const seen = existsSync("notes.txt") ? readFileSync("notes.txt", "utf8") : null;
console.log(JSON.stringify({ event: "seen", notes: seen, files: readdirSync(".").sort() }));
appendFileSync("notes.txt", `${t.text ?? "x"}\n`);
mkdirSync("evidence", { recursive: true });
writeFileSync(`evidence/${process.env.RUN_ID}.txt`, `attempt ${process.env.RUN_ATTEMPT}\n`);
if (t.link) symlinkSync(t.link, "planted-link");

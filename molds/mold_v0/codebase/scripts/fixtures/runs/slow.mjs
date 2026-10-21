// Works until stopped (a cancel or a deadline), printing progress; gives up by itself after a minute.
let n = 0;
const t = setInterval(() => { console.log(JSON.stringify({ event: "progress", n: ++n })); if (n > 300) { clearInterval(t); process.exit(0); } }, 200);

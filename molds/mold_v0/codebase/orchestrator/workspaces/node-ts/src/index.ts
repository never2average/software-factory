import { formatReport, summarize } from "./lib.js";

const values = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
console.log(formatReport(summarize(values.length ? values : [3, 1, 4, 1, 5, 9])));

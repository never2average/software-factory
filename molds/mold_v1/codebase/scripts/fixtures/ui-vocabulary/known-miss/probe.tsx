"use client";
// KNOWN MISSES of check:ui-vocabulary's dataflow rule (the #60 reviewer's probes): code values that reach a person by
// routes the rule does not follow yet — a record lookup, a function's return, a prop, .map, String(), a Map, an
// element access, a joined array. scripts/test-ui-vocabulary.mjs holds the rule to exactly these misses and to catching
// CONTROL; when the rule learns a route, that test fails until the probe moves from "missed" to "caught" there.
// Never imported; line numbers are asserted, so edit with care.
const NOUN: Record<string, string> = { a: "deployment", b: "implementation" };           // P1 record lookup
function kindName(k: number) { return k ? "rollout" : "customer"; }                        // P2 function return
const LIST = ["deployment", "implementation"];
function Badge({ kind }: { kind: string }) { return <span>{kind}</span>; }                  // P3 prop
export function Probe({ k, i }: { k: string; i: number }) {
  const m = LIST.map((x) => x.toUpperCase());                                              // P4 .map
  const s = String("deployment");                                                          // P5 String()
  const r = new Map([["x", "customers"]]).get("x");                                        // P6 Map
  return (
    <div>
      <p>{NOUN[k]}</p>
      <p>{kindName(i)}</p>
      <Badge kind="implementation" />
      <p>{m.join(", ")}</p>
      <p>{s}</p>
      <p>{r}</p>
      <p>{`Filed under ${LIST[i]}`}</p>
      <p>{["Filed under", LIST[i]].join(" ")}</p>
      <input placeholder={NOUN[k]} />
    </div>
  );
}
const CTRL = ["deployment", null].filter(Boolean);
export const CONTROL = `filed under a ${CTRL.join("/")}, linked`;

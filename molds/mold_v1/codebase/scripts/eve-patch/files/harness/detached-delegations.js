// fde-agent patch to eve 0.25.1 (mold_v1-184): per-result delegation, `defineAgent({ subagents: { batch: "detach" } })`.
// Not part of eve. Added by patches/eve+0.25.1.patch; the readable source of every change is scripts/eve-patch/.
//
// Pure functions only: this module is imported by workflow code (execution/turn-workflow.js, execution/workflow-entry.js),
// which is replayed deterministically and may not touch I/O, clocks or randomness.
import { accumulateSessionUsage, getTurnUsageState, setTurnUsageState } from "#harness/turn-tag-state.js";
import { clearProxyInputRequestsForChild } from "#harness/proxy-input-requests.js";

/** Session state key: delegations the main agent was told "reports later", by call id. */
const DETACHED_DELEGATIONS_KEY = `eve.runtime.detachedDelegations`;
const PENDING_RUNTIME_ACTION_BATCH_KEY = `eve.runtime.pendingActionBatch`;
const PROXY_INPUT_REQUESTS_KEY = `eve.runtime.proxyInputRequests`;
const DEFAULT_DETACH_AFTER_MS = 10_000;
/** The tool-call id of the synthetic call a late result answers: `<the delegation's call id>_result`. */
const LATE_RESULT_CALL_ID_SUFFIX = `_result`;
const DETACHED_NOTE = `Still working. Its result will be delivered to you automatically, as this tool's result, when it finishes. Do not call it again and do not wait for it; continue with what you have.`;
const STOPPED_CODE = `SUBAGENT_STOPPED`;
const STOPPED_MESSAGE = `This specialist was stopped before it finished. It returned no result.`;

/** `{ mode: "detach", detachAfterMs }` when the agent opted in; undefined for the default `"all"` (eve's own batch). */
function resolveSubagentBatch(config) {
  const s = config?.subagents;
  if (s?.batch !== `detach`) return undefined;
  const ms = typeof s.detachAfterMs === `number` && Number.isFinite(s.detachAfterMs) && s.detachAfterMs >= 0 ? Math.floor(s.detachAfterMs) : DEFAULT_DETACH_AFTER_MS;
  return { mode: `detach`, detachAfterMs: ms };
}

/**
 * The session creator's auth attribute that overrides the agent's setting for that one session. `"all"` keeps eve's own
 * batch: the application sets it on a session a PROGRAM starts (a workflow step, an app refresh), whose value is the
 * main agent's last reply and which has nobody to read a "reports later" turn. Only ever narrows: it cannot turn
 * "detach" on for an agent that did not opt in.
 */
const SUBAGENT_BATCH_AUTH_ATTRIBUTE = `eve_subagent_batch`;

/** The turn step's extra fields when it parks on a batch of delegations and the agent opted in. Empty otherwise. */
function subagentBatchStepFields(config, session, initiatorAuth) {
  if (initiatorAuth?.attributes?.[SUBAGENT_BATCH_AUTH_ATTRIBUTE] === `all`) return {};
  const batch = resolveSubagentBatch(config);
  return batch !== undefined && session?.state?.[PENDING_RUNTIME_ACTION_BATCH_KEY] !== undefined ? { subagentBatch: batch } : {};
}

function isRecord(value) {
  return typeof value === `object` && value !== null && !Array.isArray(value);
}

/** The detached delegations recorded in a session's state, by call id (malformed entries are ignored). */
function getDetachedDelegations(state) {
  const raw = state?.[DETACHED_DELEGATIONS_KEY];
  const out = {};
  if (!isRecord(raw)) return out;
  for (const [callId, d] of Object.entries(raw)) {
    if (isRecord(d) && typeof d.childSessionId === `string` && typeof d.subagentName === `string`) out[callId] = { ...d, callId };
  }
  return out;
}

function writeDetached(session, map) {
  const state = { ...session.state };
  if (Object.keys(map).length === 0) delete state[DETACHED_DELEGATIONS_KEY];
  else state[DETACHED_DELEGATIONS_KEY] = map;
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}

/** Record delegations the main agent was just told "reports later". */
function recordDetachedDelegations(session, records) {
  if (records.length === 0) return session;
  const map = { ...getDetachedDelegations(session.state) };
  for (const r of records) {
    map[r.callId] = {
      childContinuationToken: r.childContinuationToken,
      childSessionId: r.childSessionId,
      name: r.name,
      subagentName: r.subagentName,
    };
  }
  return writeDetached(session, map);
}

/** What the main agent reads for a delegation still out when its batch is handed over: "this one reports later". */
function createDetachedPlaceholderResult(d) {
  return {
    callId: d.callId,
    kind: `subagent-result`,
    output: { status: `running`, childSessionId: d.childSessionId, name: d.name, note: DETACHED_NOTE },
    subagentName: d.subagentName,
  };
}

/**
 * Should a batch still waiting be handed over now, with "reports later" for the delegations still out?
 * Only when at least one result is in, every one still out is a local delegation this turn started (`delegations`
 * by request key), and one of them is waiting on the person (`asked`) or the bound has passed (`timerFired`).
 */
function planDetach(input) {
  const present = new Map();
  for (const r of input.results) present.set(input.resultKey(r), r);
  const missing = input.pendingKeys.filter((k) => !present.has(k));
  if (missing.length === 0 || missing.length === input.pendingKeys.length) return undefined;
  const out = missing.map((k) => input.delegations.get(k));
  if (out.some((d) => d === undefined)) return undefined;
  if (!input.timerFired && !out.some((d) => input.asked.has(d.callId))) return undefined;
  return {
    detached: out.map((d) => ({ ...d })),
    results: input.pendingKeys.map((k) => present.get(k) ?? createDetachedPlaceholderResult(input.delegations.get(k))),
  };
}

/** True when at least one of the batch's keys has a result. */
function anyResultIn(pendingKeys, results, resultKey) {
  const keys = new Set(pendingKeys);
  return results.some((r) => keys.has(resultKey(r)));
}

function toOutput(result) {
  return typeof result.output === `string`
    ? result.isError === true
      ? { type: `error-text`, value: result.output }
      : { type: `text`, value: result.output }
    : result.isError === true
      ? { type: `error-json`, value: result.output }
      : { type: `json`, value: result.output };
}

/** The tool-role messages through which the main agent reads a late result as that delegation's result. */
function buildLateResultMessages(delivered) {
  if (delivered.length === 0) return [];
  const id = (d) => `${d.result.callId}${LATE_RESULT_CALL_ID_SUFFIX}`;
  return [
    {
      role: `assistant`,
      content: delivered.map((d) => ({ type: `tool-call`, toolCallId: id(d), toolName: d.record.subagentName, input: { resultOf: d.result.callId } })),
    },
    {
      role: `tool`,
      content: delivered.map((d) => ({ type: `tool-result`, toolCallId: id(d), toolName: d.record.subagentName, output: toOutput(d.result) })),
    },
  ];
}

/**
 * Take the late results that are still owed: each detached delegation is delivered ONCE — the first result for its call
 * id removes it from the session's state, so a copy that arrives later (a retried step, a second instance) finds
 * nothing to deliver. Clears the child's proxied questions and adds its usage, as a batch result would.
 */
function takeDelegationResults(session, results) {
  let s = session;
  const owed = getDetachedDelegations(s.state);
  const delivered = [];
  const seen = new Set();
  for (const result of results ?? []) {
    if (!isRecord(result) || typeof result.callId !== `string` || seen.has(result.callId)) continue;
    const record = owed[result.callId];
    if (record === undefined) continue;
    seen.add(result.callId);
    delivered.push({ record, result });
    delete owed[result.callId];
    if (typeof record.childContinuationToken === `string`) s = clearProxyInputRequestsForChild(s, record.childContinuationToken);
    if (result.isError !== true && result.usage !== undefined) {
      s = setTurnUsageState(s, accumulateSessionUsage({ previous: getTurnUsageState(s.state), usage: result.usage }));
    }
  }
  return { delivered, session: delivered.length === 0 ? s : writeDetached(s, owed) };
}

/** Remove every detached delegation (the main thread was stopped): the records, as they were. */
function clearDetachedDelegations(session) {
  const records = Object.values(getDetachedDelegations(session.state));
  return { records, session: records.length === 0 ? session : writeDetached(session, {}) };
}

function createStoppedResult(record) {
  return {
    callId: record.callId,
    isError: true,
    kind: `subagent-result`,
    output: { code: STOPPED_CODE, message: STOPPED_MESSAGE },
    subagentName: record.subagentName,
  };
}

/**
 * THE SESSION DRIVER'S FILTER for one delivery (pure; runs in workflow code between turns). A delegation result is kept
 * only if its call id is detached in `state` (and once per call id); a delegation's question only if its delegation
 * is detached and the main thread does not already hold it. Everything else in the delivery is left as it was.
 * Returns the delivery to run a turn with (null when nothing is left) and the questions to proxy first.
 * `stateKnown: false` (no inline snapshot — never the case in eve 0.25.1, whose session state always carries one): keep
 * every late result, once per call id, and let the turn decide from the durable state (`takeDelegationResults`).
 */
function filterDelegationDelivery(delivery, state, stateKnown = true) {
  const detached = getDetachedDelegations(state);
  const proxied = isRecord(state?.[PROXY_INPUT_REQUESTS_KEY]) ? state[PROXY_INPUT_REQUESTS_KEY] : {};
  const results = [];
  const requests = [];
  const seenResults = new Set();
  const seenRequests = new Set();
  const payloads = [];
  let touched = false;
  for (const payload of delivery.payloads) {
    if (!isRecord(payload) || (payload.delegationResults === undefined && payload.delegationRequests === undefined)) {
      payloads.push(payload);
      continue;
    }
    touched = true;
    const { delegationResults, delegationRequests, ...rest } = payload;
    for (const r of Array.isArray(delegationResults) ? delegationResults : []) {
      if (!isRecord(r) || typeof r.callId !== `string` || seenResults.has(r.callId) || (stateKnown && detached[r.callId] === undefined)) continue;
      seenResults.add(r.callId);
      results.push(r);
    }
    for (const q of Array.isArray(delegationRequests) ? delegationRequests : []) {
      if (!isRecord(q) || typeof q.callId !== `string` || detached[q.callId] === undefined) continue;
      const ids = (isRecord(q.event) && Array.isArray(q.event.requests) ? q.event.requests : []).map((x) => x?.requestId).filter((x) => typeof x === `string`);
      const key = q.kind === `subagent-input-request` ? ids.join(`\n`) : String(q.event?.type ?? q.kind);
      if (q.kind === `subagent-input-request` && (ids.length === 0 || ids.every((id) => proxied[id] !== undefined))) continue;
      if (seenRequests.has(`${q.callId}\n${key}`)) continue;
      seenRequests.add(`${q.callId}\n${key}`);
      requests.push(q);
    }
    if (Object.keys(rest).length > 0) payloads.push(rest);
  }
  if (!touched) return { delivery, requests };
  if (results.length > 0) payloads.push({ delegationResults: results });
  return { delivery: payloads.length === 0 ? null : { ...delivery, payloads }, requests };
}

/**
 * Merge what eve's `coalesceTurnInputs` would otherwise drop from two turn inputs: late results and questions, and — as
 * a defence — a batch's own `runtimeActionResults` / `detachedDelegations` (eve keeps only message, context,
 * inputResponses and outputSchema; a deferred input merged into a batch's results would lose them and leave the batch
 * unresolved). Arrays are concatenated, never overwritten.
 */
function mergeDelegationFields(target, a, b) {
  for (const key of [`delegationResults`, `delegationRequests`, `runtimeActionResults`, `detachedDelegations`]) {
    const merged = [...(Array.isArray(a?.[key]) ? a[key] : []), ...(Array.isArray(b?.[key]) ? b[key] : [])];
    if (merged.length > 0) target[key] = merged;
    else delete target[key];
  }
  return target;
}

/** Does the subagent adapter state carry a way home through the parent SESSION (a delegation started under "detach")? */
function isDetachableDelegationContext(serializedContext) {
  const channel = serializedContext?.[`eve.channel`];
  return channel?.kind === `subagent` && typeof channel.state?.parentSessionContinuationToken === `string` && channel.state.parentSessionContinuationToken !== ``;
}

export {
  SUBAGENT_BATCH_AUTH_ATTRIBUTE,
  DETACHED_DELEGATIONS_KEY,
  LATE_RESULT_CALL_ID_SUFFIX,
  STOPPED_CODE,
  STOPPED_MESSAGE,
  anyResultIn,
  buildLateResultMessages,
  clearDetachedDelegations,
  createDetachedPlaceholderResult,
  createStoppedResult,
  filterDelegationDelivery,
  getDetachedDelegations,
  isDetachableDelegationContext,
  mergeDelegationFields,
  planDetach,
  recordDetachedDelegations,
  resolveSubagentBatch,
  subagentBatchStepFields,
  takeDelegationResults,
};

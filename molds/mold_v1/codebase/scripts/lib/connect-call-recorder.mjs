/**
 * Stands in for `@vercel/connect/eve`, `eve/connections` and `eve/channels/slack` in
 * scripts/test-connections-default-unchanged.mjs, and records every call the application makes into them:
 *
 *   connect(input)                     -> { call: "connect", args }                 returns a tagged auth object
 *   connectSlackCredentials(...args)   -> { call: "connectSlackCredentials", args } returns tagged credentials
 *   defineMcpClientConnection(def)     -> { call: "defineMcpClientConnection", … }  returns the definition
 *   slackChannel(options)              -> { call: "slackChannel", … }               returns the options
 *
 * Everything else those modules export is the real thing (the test's loader lets THIS file import the real modules).
 * A value handed back by one call and passed into another is described by its tag, so "the Slack connection's auth is
 * the object connect() returned" and "the channel's verifier is Connect's" are part of the recording.
 */
export * from "eve/connections";

const log = (globalThis.__connectCalls ??= []);
const TAG = Symbol.for("connect-call-recorder.tag");
const tagged = (value, tag) => Object.defineProperty(value, TAG, { value: tag, enumerable: false });

/** A plain description of a value: primitives as they are, tagged values by tag, functions by name only. */
export function describe(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "function") return value[TAG] ? { tagged: value[TAG] } : { function: true };
  if (typeof value !== "object") return value;
  if (value[TAG]) return { tagged: value[TAG] };
  if (Array.isArray(value)) return value.map(describe);
  return Object.fromEntries(Object.keys(value).map((k) => [k, describe(value[k])]));
}

export function connect(input) {
  log.push({ call: "connect", args: [describe(input)] });
  const n = log.filter((c) => c.call === "connect").length;
  return tagged({ principalType: typeof input === "object" ? input.principalType : "user", getToken: tagged(async () => ({ token: `connect-token-${n}` }), `connect#${n}.getToken`) }, `connect#${n}`);
}

export function connectSlackCredentials(...args) {
  log.push({ call: "connectSlackCredentials", args: describe(args) });
  const n = log.filter((c) => c.call === "connectSlackCredentials").length;
  return {
    botToken: tagged(() => `connect-slack-bot-token-${n}`, `connectSlackCredentials#${n}.botToken`),
    webhookVerifier: tagged(() => true, `connectSlackCredentials#${n}.webhookVerifier`),
  };
}

export function defineMcpClientConnection(definition) {
  log.push({ call: "defineMcpClientConnection", definition: describe(definition) });
  return definition;
}

export function slackChannel(options) {
  log.push({ call: "slackChannel", options: describe(options) });
  return options;
}

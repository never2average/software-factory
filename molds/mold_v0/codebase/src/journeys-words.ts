/**
 * The journeys and tips components' fixed limits and their words (mold_v0-143; src/journeys.ts, src/tips.ts): pure, no
 * imports, so scripts/gen-packs.mjs checks pack.json `journeys` and `tips` against the same lists and fills the console's
 * words from the same defaults (web/src/config/build-facts.generated.ts JOURNEYS, TIPS).
 *
 * Placeholders, filled where a word is used: {guide} and {guides} (the build's word for one journey and for several:
 * the shell texts journeys.one and journeys.many, a pack's pack.json `texts`), {Guide} and {Guides} (capitalised),
 * {product} (the build's product name), and the values each word names ({name}, {id}, {n}, ...).
 */

/** The most stages a journey has, and the most use cases one import adds. */
export const MAX_STAGES = 12;
export const MAX_IMPORT = 100;
/** A tip stops appearing in chat after this many showings; it stays on /app until it expires or is dismissed. */
export const MAX_CHAT_SHOWS = 3;
/** Hours between two in-chat tips for one person, unless APP_NUDGE_INTERVAL_HOURS (or pack.json tips.interval_hours) says otherwise. */
export const DEFAULT_INTERVAL_HOURS = 20;

/** The journeys component's server words (pack.json journeys.words), each with its neutral default. */
export const JOURNEY_WORDS = {
  stages_count: "A {guide} needs 1 to {max} stages",
  stage_twice: "Two stages are called {id}",
  not_a_tool: "Stage {n}: {tool} is not a {product} tool",
  needs_name: "A {guide} needs a name",
  exists: "There is already a {guide} called {id}",
  no_such: "No such {guide}",
  reorder_ids: "ids must be the {guides} in their new order",
  no_such_stage: "No such {guide} stage",
  stage_by_tools: "This stage is marked done by your AI client's tool calls, not by hand",
  no_own_use_case: "No such use case on this account",
  remove_own_only: "Only whoever added it, or an account admin, can remove it",
  import_list: "items must be a list of use cases",
  import_max: "Import at most {max} use cases at a time",
  no_use_case: "No such use case",
  no_help: "No such help request",
  own_request: "That is your own request",
  picked_already: "Someone already picked this up",
  closed: "This request is closed",
  withdraw_own: "Only whoever asked can withdraw it",
  release_helper: "Only the helper can hand it back",
  close_who: "Only the asker or the helper can close it",
  ask_signed_in: "Sign in as a person to ask for help",
  help_signed_in: "Sign in as a person to help",
  help_action: "action must be pick, done, release or cancel",
  /** A new use case's step without an expected result. */
  default_expect: "Your AI client walks you through it.",
} as const;
export type JourneyWord = keyof typeof JOURNEY_WORDS;

/** The tips component's server words (pack.json tips.words), each with its neutral default. */
export const TIP_WORDS = {
  /** The line appended to a tool's answer: the model passes it on. {message}, then `try` when the tip has a prompt, then `off`. */
  chat_line: "{product} tip for the user (mention it briefly after answering): {message}",
  chat_try: " To try it, they can say: \"{prompt}\".",
  chat_off: " Tips can be turned off at {url}.",
  no_account: "No {product} account for this nudge: send org (slug) or a distinct id {product} knows",
  message_required: "message is required (up to 280 characters)",
  bad_link: "link must be https:// or a /app path",
  no_tip: "No such tip",
  no_nudge: "No such nudge",
  bad_id: "Invalid id",
  bad_secret: "Invalid {guide} secret",
} as const;
export type TipWord = keyof typeof TIP_WORDS;

/**
 * The console's words of both components (pack.json journeys.words and tips.words: the same keys), each with its
 * neutral default: the few a product says in its own terms. Every other text of their pages is the shell's, with the
 * placeholders above.
 */
export const JOURNEY_WEB_WORDS = {
  export_prefix: "use-cases",
  use_case_name_placeholder: "Name, e.g. Pricing page check",
  /** The editor's example prompt and expected result for a stage (shown as written: its placeholders are the stage's own). */
  stage_prompt_placeholder: "The prompt to paste, e.g. Summarise what changed for {product} this week.",
  stage_expect_placeholder: "You'll see: what comes back",
} as const;
export const TIP_WEB_WORDS = {
  prompt_placeholder: "Prompt to try (optional)",
} as const;
export type JourneyWebWord = keyof typeof JOURNEY_WEB_WORDS;
export type TipWebWord = keyof typeof TIP_WEB_WORDS;

/** The components' tables, as the Storage page lists them where each is on (their labels: pack.json journeys/tips `labels`). */
export const JOURNEY_TABLES = ["journey_templates", "journey_progress", "journey_seed", "adoption_help"] as const;
export const TIP_TABLES = ["nudges", "nudge_prefs"] as const;

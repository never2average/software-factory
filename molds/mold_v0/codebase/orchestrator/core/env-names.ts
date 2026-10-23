/**
 * The shell's environment variable names (mold_v0-045). Every name the shell reads starts with APP_ (APP_VAULT_KEY,
 * APP_WORKER_TOKEN, APP_PROXY_HOPS, ...). Until mold_v0-045 the same names started with the product's own prefix
 * (LEGACY_ENV_PREFIX below), and apps deployed before then hold their values under those names (on Vercel, in a
 * server's env file): each old name is still read, as a fallback.
 *
 *   APP_X set                  its value (the old name, if also set, is ignored: the new name wins)
 *   APP_X unset, the old set   the old name's value, and one line on the log, once per old name per process
 *   neither                    undefined (the caller's default)
 *
 * Read the shell's names through `ENV` (process.env with the fallback) or `appEnv(source)` for any other environment
 * object (a test's, a child's). Both are live views: a value set or deleted later is seen at the next read. Writes go
 * to the real object under the new name (`process.env.APP_X = ...`); nothing here writes an old name.
 *
 * This file is the one place the old prefix is spelled out (scripts/check-vocabulary.ts allows it here and in the
 * few places that must name it: the deploy scripts' fallbacks, the web console's copy, the alias table in MOLD.md).
 * It has no imports: the orchestrator and the run sandbox runner carry it (orchestrator/deploy/boat-lib.ts).
 */

/** The prefix of every environment variable the shell reads. */
export const ENV_PREFIX = "APP_";
/** The prefix those names had until mold_v0-045, still read as a fallback. */
export const LEGACY_ENV_PREFIX = "OCTILLION_";

/** The old name of a shell name (APP_X -> its legacy spelling), or null for a name that is not the shell's. */
export const legacyEnvName = (name: string): string | null =>
  name.startsWith(ENV_PREFIX) && name.length > ENV_PREFIX.length ? LEGACY_ENV_PREFIX + name.slice(ENV_PREFIX.length) : null;

/** The new name of an old one (its legacy spelling -> APP_X), or null for a name that is not an old shell name. */
export const currentEnvName = (name: string): string | null =>
  name.startsWith(LEGACY_ENV_PREFIX) && name.length > LEGACY_ENV_PREFIX.length ? ENV_PREFIX + name.slice(LEGACY_ENV_PREFIX.length) : null;

/** A name the shell owns under either spelling: kept out of what a coding agent's sandbox may see. */
export const isShellEnvName = (name: string): boolean => currentEnvName(name) !== null || legacyEnvName(name) !== null;

/**
 * A persisted key that was spelled as an environment name before mold_v0-045 and is stored as such (a platform
 * setting's row key, src/settings.ts): the old spelling, kept so existing rows and the host packs that read them by
 * name still match. Its environment value is read under the new name first (src/settings.ts envOf).
 */
export const persistedKey = (suffix: string): string => LEGACY_ENV_PREFIX + suffix;

const warned = new Set<string>();
/** Where the deprecation lines go (tests replace it to read them). */
export const envLog = { warn: (line: string) => console.warn(line) };

function note(legacy: string, name: string, shadowed: boolean) {
  const key = `${legacy}${shadowed ? "!" : ""}`;
  if (warned.has(key)) return;
  warned.add(key);
  envLog.warn(shadowed
    ? `[env] ${legacy} is set but ignored: ${name} is set too, and the new name wins. Remove ${legacy}.`
    : `[env] ${legacy} is a deprecated name, read as a fallback for ${name}: rename it to ${name} (mold_v0-045).`);
}

/** The value of a shell name in `source`: the new name, else its old one (logged once). */
export function readEnv(name: string, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = source[name];
  const legacy = legacyEnvName(name);
  if (!legacy) return v;
  const old = source[legacy];
  if (v !== undefined) {
    if (old !== undefined && old !== v) note(legacy, name, true);
    return v;
  }
  if (old !== undefined) note(legacy, name, false);
  return old;
}

const views = new WeakMap<object, NodeJS.ProcessEnv>();
/**
 * `source` (process.env by default) as a live view in which every APP_ name falls back to its old spelling. Only
 * reads are changed: `in`, keys and spreading see the real object, and writes go to it unchanged.
 */
export function appEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const known = views.get(source);
  if (known) return known;
  const view = new Proxy(source, {
    get: (t, k) => (typeof k === "string" && k.startsWith(ENV_PREFIX) ? readEnv(k, t) : Reflect.get(t, k)),
  });
  views.set(source, view);
  return view;
}

/**
 * Host packs written before mold_v0-045 read some of the shell's names themselves, under the old spelling
 * (process.env.<old prefix>WORKER_TOKEN). For them, every APP_ name in `source` is also set under its old spelling, to
 * the same value (the new name wins over an old value that differs). src/hosts.ts does this once, before it registers
 * a host pack; with no host pack nothing is copied. Returns the old names it set.
 */
export function exposeLegacyNames(source: NodeJS.ProcessEnv = process.env): string[] {
  const set: string[] = [];
  for (const [name, v] of Object.entries(source)) {
    const legacy = legacyEnvName(name);
    if (!legacy || v === undefined || source[legacy] === v) continue;
    if (source[legacy] !== undefined) note(legacy, name, true);
    source[legacy] = v;
    set.push(legacy);
  }
  return set.sort();
}

/** process.env with the old names as a fallback: read the shell's names through this. */
export const ENV: NodeJS.ProcessEnv = appEnv(process.env);

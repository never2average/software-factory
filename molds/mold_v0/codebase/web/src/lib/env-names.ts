/**
 * The console's copy of the shell's environment names (src/env-names.ts on the API; this project is built on its
 * own, so it cannot import it): APP_ for every name, the prefix they had before mold_v0-045 read as a fallback, so a
 * console deployed before then (its API address under the old name) builds and runs unchanged.
 */
export const LEGACY_ENV_PREFIX = 'OCTILLION_';

/** The headers a cookie-authenticated admin write carries (CSRF): the shell's, and for one release the name the API
 * read before mold_v0-045, so an API rolled back alone still accepts the console's writes. */
export const ADMIN_HEADERS: Record<string, string> = { 'X-App-Admin': '1', [`X-${LEGACY_ENV_PREFIX.replace(/_+$/, '').toLowerCase()}-Admin`]: '1' };

/** APP_X from the environment, else its old spelling. */
export const readEnv = (name: string): string | undefined =>
  process.env[name] ?? (name.startsWith('APP_') ? process.env[LEGACY_ENV_PREFIX + name.slice(4)] : undefined);

/** A platform setting's key as stored (the session engine's keep their old spelling: src/settings.ts ENGINE_SETTINGS). */
export const persistedKey = (suffix: string): string => LEGACY_ENV_PREFIX + suffix;

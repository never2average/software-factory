import { createParser } from 'nuqs';

/**
 * A yes/no flag in the address (mold_v0-217): `?name=1` (also `true`) is on, written as `1`; absent is off. nuqs's
 * parseAsBoolean reads only `true`, so the Due soon card's `?overdue=1` link never turned its filter on.
 */
export const parseAsFlag = createParser({
  parse: (v: string) => v === '1' || v.toLowerCase() === 'true',
  serialize: (b: boolean) => (b ? '1' : '0')
});

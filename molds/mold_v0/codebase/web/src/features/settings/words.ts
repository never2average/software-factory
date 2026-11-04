// Settings' shared words (mold_v0-218): when a row changed lately, and who changed it.
/** Whether `d` is within the last `days` days. */
export const ago = (d: string | null | undefined, days: number) => !!d && Date.now() - new Date(d).getTime() < days * 86_400_000;
/** Who changed it, as the API names a person ("customer:<email>"): the person alone. */
export const who = (by: string | null | undefined) => (by ? by.replace(/^customer:/, '') : null);

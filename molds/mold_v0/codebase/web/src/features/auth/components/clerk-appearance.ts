/**
 * Clerk's widget with some providers' buttons not shown (mold_v0-266: Admin › Access requests › Sign-in page): each
 * hidden social method (oauth_<provider>) is its block and icon buttons left out. Which methods exist is the Clerk
 * instance's (its dashboard); this only chooses which of its provider buttons show.
 */
export function clerkAppearance(hidden: readonly string[]) {
  const elements: Record<string, { display: 'none' }> = {};
  for (const m of hidden) {
    if (!/^oauth_[a-z0-9_]+$/.test(m)) continue;
    const p = m.slice('oauth_'.length);
    elements[`socialButtonsBlockButton__${p}`] = { display: 'none' };
    elements[`socialButtonsIconButton__${p}`] = { display: 'none' };
  }
  return { elements };
}

/**
 * The top bar's controls (mold_v0-177): the search box, Docs (and admin's MCP) and the theme switcher are one height,
 * radius and border, at every width. From tablet width up they are the search box's 36px; on a phone the search box
 * collapses to an icon and every control is a 44px icon button (a thumb's tap target), its name in aria-label.
 */
export const TOP_BAR_CONTROL = 'h-11 min-w-11 rounded-[0.5rem] px-0 text-sm shadow-none md:h-9 md:min-w-9';
/** A control with a word beside its icon: the word from tablet width up, padded like the search box. */
export const TOP_BAR_LABELLED = 'gap-1.5 md:px-3';

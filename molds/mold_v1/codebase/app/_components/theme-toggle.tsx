"use client";

import { useEffect, useState } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { STORAGE_KEYS, readStored, removeStored, writeStored } from "@/lib/browser-storage";

export type Theme = "system" | "light" | "dark";

/** Where the choice is stored. Read by the inline script in layout.tsx too — if
 *  you rename this, rename it there or the page flashes the wrong theme. That
 *  script reads the OLD key as well, for the same reason this does: a person who
 *  chose dark before the rename must not be shown light on the next deploy. */
export const THEME_KEY = STORAGE_KEYS.theme;

/**
 * Apply a theme by setting (or clearing) `data-theme` on <html>.
 *
 * "system" REMOVES the attribute rather than writing "system", so the CSS falls
 * back to the `prefers-color-scheme` media query. Writing a third value would
 * mean a third branch in the stylesheet for no gain.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

const ORDER: Theme[] = ["system", "light", "dark"];
const ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;
const LABEL = { system: "Match system", light: "Light", dark: "Dark" } as const;

/**
 * Cycles system → light → dark. A three-way cycle rather than a binary toggle
 * because "match system" is a real preference, and a binary switch silently
 * pins whichever the system happened to be at first click.
 */
export function ThemeToggle({ className }: { className?: string }) {
  // Start at "system" and correct after mount: the server has no idea what is
  // in localStorage, so rendering the stored value directly would hydrate
  // mismatched. The inline script has already set the ATTRIBUTE, so the page
  // itself never flashes — only this button's icon settles a tick later.
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const stored = readStored(THEME_KEY) as Theme | null;
    if (stored === "light" || stored === "dark" || stored === "system") setTheme(stored);
  }, []);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    setTheme(next);
    applyTheme(next);
    try {
      if (next === "system") removeStored(THEME_KEY);
      else writeStored(THEME_KEY, next);
    } catch {
      /* private mode — the choice just won't persist */
    }
  }

  const Icon = ICON[theme];
  return (
    <button
      type="button"
      onClick={cycle}
      className={
        className ??
        "rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      }
      // The label names the CURRENT state; the tooltip says what a click does,
      // which is the thing a cycling control has to make obvious.
      aria-label={`Theme: ${LABEL[theme]}`}
      title={`Theme: ${LABEL[theme]} — click for ${LABEL[ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]]}`}
    >
      <Icon className="size-4" />
    </button>
  );
}

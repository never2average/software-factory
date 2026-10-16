"use client";

/**
 * THE RECORD HUB ON SCREEN (profiles `records.hub`; agent/lib/record-hub.ts): what the nav item, the Ops Center
 * screen's title and the Control Panel's section call the screen that holds the record areas, and their glyphs.
 *
 * Every one of them reads `useRecordHub()`, which is this build's RECORD_HUB unless a `RecordHubProvider` above it
 * says otherwise (a /preview page showing another profile's hub: `?hub=` on app/preview/ops-center and
 * app/preview/control-panel). Under the default profile each reads exactly what it did: "TODOs", the nav's
 * circle-check and the Control Panel's list glyph; a profile's own glyph loads on first use.
 */
import { createContext, forwardRef, useContext, useEffect, useState, type ComponentProps } from "react";
import { CircleCheckIcon, ListTodoIcon, type LucideIcon } from "lucide-react";
import { RECORD_HUB, type RecordHub, type RecordHubIcon } from "@/lib/deployment-profile.generated";
import { DEFAULT_HUB_ITEM, hubCount } from "@/agent/lib/record-hub";

/**
 * Each glyph a profile may name, by that name (agent/lib/record-hub.ts HUB_ICONS), loaded when a hub shows it: the
 * default hub names none, so its first load carries no glyph it did not carry before (scripts/bundle-budget.json).
 */
const GLYPHS: Record<RecordHubIcon, () => Promise<{ default: LucideIcon }>> = {
  "circle-check": () => import("lucide-react/dist/esm/icons/circle-check.mjs"),
  "list-todo": () => import("lucide-react/dist/esm/icons/list-todo.mjs"),
  "list-checks": () => import("lucide-react/dist/esm/icons/list-checks.mjs"),
  "clipboard-list": () => import("lucide-react/dist/esm/icons/clipboard-list.mjs"),
  "clipboard-check": () => import("lucide-react/dist/esm/icons/clipboard-check.mjs"),
  scale: () => import("lucide-react/dist/esm/icons/scale.mjs"),
  "shield-check": () => import("lucide-react/dist/esm/icons/shield-check.mjs"),
  landmark: () => import("lucide-react/dist/esm/icons/landmark.mjs"),
  "book-open": () => import("lucide-react/dist/esm/icons/book-open.mjs"),
  "folder-kanban": () => import("lucide-react/dist/esm/icons/folder-kanban.mjs"),
  "calendar-check": () => import("lucide-react/dist/esm/icons/calendar-check.mjs"),
  "file-check": () => import("lucide-react/dist/esm/icons/file-check.mjs"),
};
const loaded = new Map<RecordHubIcon, LucideIcon>();
const glyphs = new Map<string, LucideIcon>();

/** The profile's glyph as an icon component: today's glyph until it has loaded, then the profile's, same props. */
function hubGlyph(name: RecordHubIcon, fallback: LucideIcon): LucideIcon {
  const key = `${name}|${fallback.displayName ?? ""}`;
  const known = glyphs.get(key);
  if (known) return known;
  const Glyph = forwardRef<SVGSVGElement, ComponentProps<LucideIcon>>(function HubGlyph(props, ref) {
    const [Icon, setIcon] = useState<LucideIcon | null>(() => loaded.get(name) ?? null);
    useEffect(() => {
      if (Icon) return;
      let alive = true;
      void GLYPHS[name]().then((m) => {
        loaded.set(name, m.default);
        if (alive) setIcon(() => m.default);
      });
      return () => {
        alive = false;
      };
    }, [Icon]);
    const Shown = Icon ?? fallback;
    return <Shown ref={ref} {...props} />;
  }) as LucideIcon;
  glyphs.set(key, Glyph);
  return Glyph;
}

export interface RecordHubUi {
  /** The screen's name: the nav item, the screen's title, the Control Panel's section. */
  readonly label: string;
  /** The nav item's and the screen's glyph. */
  readonly navIcon: LucideIcon;
  /** The Control Panel section's glyph. */
  readonly sectionIcon: LucideIcon;
  /** "3 TODOs": a count of the hub's entries. */
  readonly count: (n: number) => string;
  /** One entry, capitalised, as a line of the Control Panel's summary starts ("TODO: …"). */
  readonly Item: string;
  /** The entries mid-sentence ("Related todos"): today's "todos", or the tasks area's word as the profile writes it. */
  readonly items: string;
}

export function recordHubUi(hub: RecordHub): RecordHubUi {
  const one = hub.item.singular;
  return {
    label: hub.label,
    navIcon: hub.icon ? hubGlyph(hub.icon, CircleCheckIcon) : CircleCheckIcon,
    sectionIcon: hub.icon ? hubGlyph(hub.icon, ListTodoIcon) : ListTodoIcon,
    count: (n) => hubCount(hub, n),
    Item: one ? one[0].toUpperCase() + one.slice(1) : one,
    items: hub.item.plural === DEFAULT_HUB_ITEM.plural ? DEFAULT_HUB_ITEM.plural.toLowerCase() : hub.item.plural,
  };
}

/** This build's hub. */
export const RECORD_HUB_UI: RecordHubUi = recordHubUi(RECORD_HUB);

const RecordHubContext = createContext<RecordHubUi>(RECORD_HUB_UI);
export const RecordHubProvider = RecordHubContext.Provider;
export const useRecordHub = (): RecordHubUi => useContext(RecordHubContext);

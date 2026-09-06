# Branding for mold_v1

A stamped application carries its own visual identity in its own state — `surface.branding` in
`state/application/<app_id>/application.json`, complete, with the icon inline. There is no shared
pack to point at: an application must be readable on its own, and editing a brand in one place must
never change what an app that already exists builds next time.

Where each brand surface LIVES is a property of this mold, not of any brand, and that is what this
directory holds.

## rules.json

Pins the exact files and strings the overlay rewrites:

| Surface | File in the mold |
|---|---|
| Browser tab, app name, description | `app/layout.tsx` metadata |
| App icon, favicon, Apple icon | `app/icon.svg` |
| Sign-in mark, wordmark, tagline, footer | `app/_components/auth-gate.tsx` |
| Colour palette, light and dark, and radius | `app/globals.css`, three token blocks |
| Onboarding copy | `app/onboard/page.tsx` |
| Every outgoing email | `lib/platform-notify.ts` |
| Inbox copy | `app/_components/ops/inbox-panel.tsx` |

If a mold refresh moves any of that text, `branding.py <app> prepare` stops with the rule id and
changes nothing, rather than shipping an app that is half-branded. A forked mold ships its own rules.

## Where a brand comes from

`state/products.json` gives each product a `brand`, and intake COPIES it into the application when it
is stamped. mold_v1 carries two products on one codebase:

| Product | Identity |
|---|---|
| `delivered` | The mold's own, pinned so a build is byte-identical to the unbranded mold |
| `dover` | Name is right; colour, mark, tagline and description are placeholders |

A brief picks one with `product: dover`, may override the colour with `brand color: #hex`, or opt out
with `no branding`. After stamping, the app owns its brand: edit it in the app's own state.

## The brand shape

`product_name`, `tagline`, `description`, `brand_color` (`#rrggbb` or `oklch(L C H)`),
`neutral_chroma`, `radius`, `icon_bg`, `icon_fg`, `icon_svg` (32x32, `viewBox="0 0 32 32"`), and
`tokens` to pin individual palette values outright.

The palette is derived from one colour: `primary`, `accent` and `ring` carry the brand, neutrals keep
the mold's lightness ramp with a trace of the brand hue (`neutral_chroma` 0 for pure grey). Light and
dark are generated together, so contrast stays where the mold's design put it. `tokens` overrides the
derivation where a designer wants an exact value — that is how `delivered` reproduces the three tokens
the mold hand-tuned.

## Not covered

Per-organization branding inside one deployment (many orgs, many looks) is a different feature: the
root layout metadata and `app/icon.svg` are build-time in Next.js, and the sign-in page has no
organization context before authentication. Each stamped app is its own deployment, which is why the
build-time overlay is enough here. The org logo tile (`orgs.branding.logoUrl`) stays runtime and
per-organization as the mold already implements it; intake seeds it from the same icon.

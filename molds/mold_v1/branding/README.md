# Branding packs for mold_v1

The mold's own identity is "Delivered" with a greyscale palette and a fixed check-mark icon. A stamped
application can carry its own instead: `application.surface.branding` names a pack here, and
`branding.py <app> prepare` applies it to a copy of the mold under `build/<app_id>/` which is what
actually gets built and deployed. The snapshot under `codebase/` is never edited.

## A pack

```
molds/mold_v1/branding/<pack>/
  brand.json   product_name, tagline, description, brand_color (#rrggbb), radius, icon_bg, icon_fg
  mark.svg     32x32, viewBox="0 0 32 32" — becomes the app icon and the sign-in mark
```

A **product** owns a pack (`brand_pack` in `state/products.json`), and an app stamped for that product
inherits it. mold_v1 carries two products, the same codebase under two identities:

| Product | Pack | State |
|---|---|---|
| `delivered` | `delivered/` | The mold's own identity, pinned so a build is byte-identical to the unbranded mold |
| `dover` | `dover/` | Name is right; colour, mark, tagline and description are placeholders |

A brief picks one with `product: dover`, and may still override with `brand: <pack>`,
`brand color: #hex`, or opt out with `no branding`. A mold with only one product needs no answer.

`onfinance/` predates the split and remains as a worked example of a third identity.

## What a brand reaches

| Surface | Where |
|---|---|
| Browser tab, app name, description | `app/layout.tsx` metadata |
| App icon, favicon, Apple icon | `app/icon.svg` |
| Sign-in mark, wordmark, tagline, footer | `app/_components/auth-gate.tsx` |
| Colour palette, light and dark, and radius | `app/globals.css`, three token blocks |
| Onboarding copy | `app/onboard/page.tsx` |
| Every outgoing email | `lib/platform-notify.ts` |
| Inbox copy | `app/_components/ops/inbox-panel.tsx` |

`tokens` in a pack pins individual values outright (`{"light": {"ring": "..."}, "dark": {...}}`), which
is how `delivered/` reproduces the three tokens the mold hand-tuned away from a plain ramp.

The palette is derived from one colour: `primary`, `accent` and `ring` carry the brand, neutrals keep
the mold's lightness ramp and take a trace of the brand hue (`neutral_chroma`, 0 for pure grey). Light
and dark are generated together, so contrast stays where the mold's design put it.

## When the mold moves

`rules.json` pins the exact text each rule replaces. If a mold refresh moves any of it, `prepare`
stops with the rule id and changes nothing, rather than shipping an app that is half-branded. Fix the
rule, then deploy.

## Not covered

Per-organization branding inside one deployment (many orgs, many looks) is a different feature: the
root layout metadata and `app/icon.svg` are build-time in Next.js, and the sign-in page has no
organization context before authentication. Each stamped app is its own deployment, which is why the
build-time overlay is enough here. The org logo tile (`orgs.branding.logoUrl`) remains runtime and
per-organization as the mold already implements it.

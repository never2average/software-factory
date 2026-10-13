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
| Favicon, tab icon, Apple icon | `app/favicon.ico`, `app/icon.png`, `app/apple-icon.png`, and `app/icon.svg` for a vector mark only (written, not rewritten: see below); the `icons` block in `app/layout.tsx` is removed so Next links them |
| Home-screen (manifest) icons | `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`, listed in `app/manifest.ts` |
| Sign-in mark, wordmark, tagline, footer | `app/_components/auth-gate.tsx` |
| Colour palette, light and dark, and radius | `app/globals.css`, three token blocks |
| Onboarding copy | `app/onboard/page.tsx` |
| Every outgoing email | `lib/platform-notify.ts` |
| Inbox copy | `app/_components/ops/inbox-panel.tsx` |

If a mold refresh moves any of that text, `branding.py <app> prepare` stops with the rule id and
changes nothing, rather than shipping an app that is half-branded. A forked mold ships its own rules.

## The favicon set

The mold ships one icon, `app/icon.svg`, and points `rel=icon`, `shortcut icon` and `apple-touch-icon` at it. With a
logo file that was a 32x32 SVG wrapping the whole PNG as base64 (51 KB and 171 KB on the two live apps), which Safari
does not draw as a favicon, iOS cannot use as a home-screen icon, and which left `/favicon.ico` and `/apple-icon.png`
answering 404. `prepare` now writes a real set into the build copy, for every app, from the brand's mark:

| File | What it is |
|---|---|
| `app/favicon.ico` | 16, 32 and 48 px in one ICO |
| `app/icon.png` | 32x32 |
| `app/apple-icon.png` | 180x180, opaque (no alpha channel), on the brand's icon background |
| `app/icon.svg` | only for a true vector mark: the monogram, a drawn mark, a vector logo. Never a base64-wrapped raster; the mold's own is removed when the logo is pixels |
| `public/icon-192.png`, `icon-512.png` | the manifest's icons |
| `public/icon-maskable-512.png` | the same, with the mark inside the safe circle and the background to the edge |

The pictures are made by `.claude/scripts/lib/favicon.py` in standard-library Python (PNG decode, area-average
resize, PNG and ICO encode, and a small stroke font for the monogram), so a PNG logo or a monogram needs nothing
else. A JPG, WebP or SVG logo, or a drawn SVG mark, is first turned into a PNG by `sharp` from the mold's own
`node_modules` (Next.js ships it); when that is missing the set is drawn from the initials instead and `prepare`
says so. What it does to a logo, always the same way:

- **Fitted, never stretched.** The margin is trimmed, the logo is scaled to fit the square, the rest is padding.
- **Opaque where a format needs it.** A see-through logo sits on `icon_bg` in the apple and maskable icons; if it
  would vanish there (contrast under 1.25:1) it gets white or near-black, and `prepare` prints a note.
- **A logo saved without transparency** on one colour (its four corners agree) has that background removed, from the
  border inwards only, so the tab icon is the mark and not a white box.
- **A badge** (one flat fill with a small mark inside, such as a disc with an arrow) has the inner mark enlarged
  inside the same outline at 48 px and under, so it can be read at 16 px. The larger icons show the logo as drawn.

`branding.py <app> check` fails when a file of the set is missing, has the wrong dimensions, is over 100 KB, when
the apple or maskable icon has transparent pixels, when `icon.svg` holds a raster, or when the layout or manifest
still points at `/icon.svg`. `branding.py <app> preview` shows the tab icon at 16 and 32 px (light and dark tab, and
enlarged) and the home-screen icon. `python3 .claude/scripts/branding.py --self-test` runs the offline checks.

The mold itself still has only `app/icon.svg`; giving the unbranded base the same set is a change for the mold's
source, not for this overlay.

## Where a brand comes from

`state/products.json` gives each product a `brand`, and intake COPIES it into the application when it
is stamped. mold_v1 carries two products on one codebase:

| Product | Identity |
|---|---|
| `delivered` | The mold's own name, mark and palette, pinned to the mold's values; its build differs from the unbranded mold only by the favicon set above |
| `dover` | Name, colour `#1F6F5C`, a monogram mark; the tagline is the mold's until someone writes one |

A brief picks one with `product: dover`, or brands the app directly with up to four lines — `brand: Acme Ops`,
`brand color: #1F6F5C`, `logo: brands/acme/logo.png`, `tagline: …` — or opts out with `no branding`. After
stamping, the app owns its brand: change it with

    python3 .claude/scripts/branding.py <app_id> set --name "Acme Ops" --color #1F6F5C --logo brands/acme/logo.png
    python3 .claude/scripts/branding.py <app_id> preview     # build/<app_id>/brand-preview.html, light and dark

and redeploy. Those three inputs (name, one colour, a logo file: PNG, JPG, WebP or SVG under `brands/`) are
the whole ask; a monogram stands in when there is no logo. A logo is shown as itself on the sign-in tile
and as the app icon; a drawn 32x32 SVG mark is recoloured to the tile.

## The brand shape (what `set` writes)

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
root layout metadata and the icon files are build-time in Next.js, and the sign-in page has no
organization context before authentication. Each stamped app is its own deployment, which is why the
build-time overlay is enough here. The org logo tile (`orgs.branding.logoUrl`) stays runtime and
per-organization as the mold already implements it; intake seeds it from the same icon.

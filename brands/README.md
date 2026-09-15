# brands/

Logo files for products and applications, one folder per brand: `brands/<name>/logo.png` (or `.svg`,
`.jpg`, `.webp`; keep it under 256 KB, a 256px square PNG is plenty). A logo is one of the three inputs
a brand needs; the other two are a name and one colour:

    python3 .claude/scripts/branding.py <app_id> set --name "Acme Ops" --color #1F6F5C --logo brands/acme/logo.png
    python3 .claude/scripts/branding.py <app_id> preview      # an HTML page showing the sign-in tile and palette

Everything else (the light and dark palette, the app icon and sign-in mark, a legible icon foreground,
the page description) is derived and written into the app's own state, so the app stays self-contained
and this folder is provenance, not a dependency. `brands/example/logo.png` is a placeholder disc used by
the factory's own checks.

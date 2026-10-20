#!/usr/bin/env python3
"""Package integrations/claude-skill/octillion into public/downloads/octillion-skill.zip (the Claude skill upload).

Run after editing the skill:  python3 scripts/build-skill.py
Deterministic: fixed timestamps and sorted entries, so the zip only changes when the content does.
"""
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "integrations" / "claude-skill" / "octillion"
OUT = ROOT / "public" / "downloads" / "octillion-skill.zip"

OUT.parent.mkdir(parents=True, exist_ok=True)
files = sorted(p for p in SRC.rglob("*") if p.is_file())
assert (SRC / "SKILL.md") in files, "SKILL.md missing"
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for p in files:
        info = zipfile.ZipInfo(f"octillion/{p.relative_to(SRC).as_posix()}", date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, p.read_bytes())
print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes, {len(files)} files)")

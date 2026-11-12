#!/usr/bin/env python3
"""Build desktop/plugin.js from the vendored terminal color profiles.

Reads every `<name>.toml` in the catalog directory (iTerm2-Color-Schemes layout:
a `[colors]` table with `foreground`, `background`, `ansi` and `brights`),
emits a compact JS array plus the theme math, and concatenates the result into
one plain-ESM file. The shipped plugin never touches the filesystem, so the
catalog cannot drift from what is installed.

Run with a Python that has tomllib (3.11+): /opt/homebrew/bin/python3.12
"""

from __future__ import annotations

import argparse
import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CATALOG = Path.home() / "dev/macOS-terminal-theme-picker/vendor/iTerm2-Color-Schemes/wezterm"

HEADER = """/**
 * Theme Catalog — every terminal color profile as a Hermes desktop theme.
 *
 * GENERATED FILE. Source lives in src/theme-map.mjs and src/ui.js; run
 * `python3.12 tools/build.py` to regenerate. Do not edit by hand.
 *
 * Profiles come from iTerm2-Color-Schemes (MIT). Each one keeps its exact
 * background, foreground and sixteen ANSI colors; the remaining desktop tokens
 * are derived from those colors by the pure math below.
 *
 * Plain ESM, loaded uncompiled — jsx() calls, not JSX syntax.
 */

import {
  Button,
  Input,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  ScrollArea,
  THEMES_AREA,
  atom,
  host,
  requestTheme,
  useTheme,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useMemo } from 'react'

"""


def slugify(stem: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    return ("catalog-" + (slug[:48] or "theme")).strip("-")


def load_profiles(catalog: Path) -> tuple[list[dict], list[str]]:
    profiles: list[dict] = []
    problems: list[str] = []
    taken: dict[str, int] = {}

    for path in sorted(catalog.glob("*.toml")):
        label = path.stem
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
            colors = data["colors"]
            ansi = [str(c).lower() for c in colors["ansi"]] + [str(c).lower() for c in colors["brights"]]
            fg = str(colors["foreground"]).lower()
            bg = str(colors["background"]).lower()
            if len(ansi) != 16:
                raise ValueError(f"expected 16 ANSI colors, got {len(ansi)}")
            for value in [fg, bg, *ansi]:
                if not re.fullmatch(r"#[0-9a-f]{6}", value):
                    raise ValueError(f"bad color {value!r}")
        except Exception as exc:  # noqa: BLE001 - report and keep going
            problems.append(f"{path.name}: {exc}")
            continue

        slug = slugify(label)
        if slug in taken:
            taken[slug] += 1
            slug = f"{slug}-{taken[slug]}"
        else:
            taken[slug] = 1

        profiles.append({"slug": slug, "label": label, "bg": bg, "fg": fg, "ansi": ansi})

    return profiles, problems


def js_catalog(profiles: list[dict]) -> str:
    rows = []
    for p in profiles:
        ansi = ",".join(f'"{c}"' for c in p["ansi"])
        rows.append(
            '  {slug:"%s",label:%s,bg:"%s",fg:"%s",ansi:[%s]}'
            % (p["slug"], json.dumps(p["label"], ensure_ascii=False), p["bg"], p["fg"], ansi)
        )
    return "const PROFILES = [\n" + ",\n".join(rows) + "\n]\n"


def strip_exports(source: str) -> str:
    """Concatenated modules cannot carry `export`; the map module is pure."""
    return re.sub(r"^export\s+(?=(const|function|let)\s)", "", source, flags=re.MULTILINE)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--out", type=Path, default=ROOT / "desktop/plugin.js")
    args = parser.parse_args()

    profiles, problems = load_profiles(args.catalog)
    if not profiles:
        raise SystemExit(f"No profiles parsed from {args.catalog}")

    for p in profiles:
        p["description"] = "Terminal profile · iTerm2-Color-Schemes"

    parts = [
        HEADER,
        strip_exports((ROOT / "src/theme-map.mjs").read_text(encoding="utf-8")).strip(),
        "\n\n// ── catalog data (generated from %s) ───────────────────────────────────────\n\n" % args.catalog,
        js_catalog(profiles),
        "\n",
        (ROOT / "src/ui.js").read_text(encoding="utf-8"),
    ]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("".join(parts), encoding="utf-8")

    build_dir = ROOT / "build"
    build_dir.mkdir(exist_ok=True)
    (build_dir / "profiles.json").write_text(json.dumps(profiles, indent=1), encoding="utf-8")

    print(f"profiles: {len(profiles)}")
    print(f"skipped:  {len(problems)}")
    for line in problems[:10]:
        print("  -", line)
    print(f"wrote:    {args.out} ({args.out.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

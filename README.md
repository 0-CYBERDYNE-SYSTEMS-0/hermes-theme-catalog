# Theme Catalog

[![CI](https://github.com/0-CYBERDYNE-SYSTEMS-0/hermes-theme-catalog/actions/workflows/ci.yml/badge.svg)](https://github.com/0-CYBERDYNE-SYSTEMS-0/hermes-theme-catalog/actions/workflows/ci.yml)

Every terminal color profile you already have, as a Hermes desktop theme.

606 profiles from [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)
are mapped to full desktop palettes: the profile's own background, foreground
and sixteen ANSI colors land verbatim, and the desktop-only surfaces (cards,
borders, sidebar, bubbles) are derived from those colors. Nothing is invented,
so a catalog theme built from Gruvbox reads like Gruvbox.

## What you get

- **606 themes, one page.** Sidebar → **Theme Catalog**, or ⌘K → *Theme
  Catalog: browse terminal themes*. Every row reads the same way: the page
  background, then the body text, then the 16 ANSI slots. Each row has an Apply
  button.
- **They are real registered themes.** Every profile also appears in Settings →
  Appearance, the ⌘K theme picker, and `/skin catalog-gruvbox-dark`, because
  they register through `THEMES_AREA` like any other desktop theme.
- **Searchable, uncapped.** Filter by name, by `dark` / `light`, or by a hex
  color to find themes containing it. Filter chips for **Edited**, **★** and
  **Mine**; sort by catalog order or by guaranteed readability. With no filter
  set every row is rendered and scrollable — nothing is hidden behind a cap.
- **Built for 606 rows.** `/` focuses the filter, `↑↓` (or `j k`) move, `↵`
  applies, `e` opens the editor, `s` stars, `Esc` clears. Each row shows its
  minimum contrast ratio, so an unreadable palette is visible before you wear it.
- **Repaint the two primary colors.** The first two chips on every row are the
  page background and the body text. Click either one and the editor opens with
  the system color picker (macOS wheel / sliders / palettes / magnifier), a hex
  field, R·G·B fields, the theme's own 16 colors as presets, and a lens.
  **Hover pick** arms a lens: hover any swatch on the page, click to take that
  color, Esc to cancel. **Screen lens** samples anywhere on screen through
  Chromium's EyeDropper. Every derived token — cards, borders, muted text,
  accents, contrast floors — recomputes from the new pair, so an edit yields a
  coherent theme rather than a patchwork. Edits persist, survive restart, mark
  the row `✎ edited`, and repaint the app live when the theme is the applied
  one. **Hold: original** A/Bs against the shipped colors, **Undo** steps back
  per slot, **Reset slot** clears one color and **Reset both** clears the theme.
- **Readable by construction.** Body text is guaranteed ≥4.5:1 against its own
  surface, muted text ≥4.5:1, destructive ≥3:1. 24 profiles ship a foreground
  the terminal itself cannot read (Batman 3.37:1, C64 2.26:1). Those stay
  verbatim in the `terminal` map, while the UI text is nudged to the floor.
- **No filesystem access at runtime.** The catalog is compiled into the plugin,
  so the shipped file is self-contained and cannot drift from what is installed.

## Install

```bash
hermes plugins install 0-CYBERDYNE-SYSTEMS-0/hermes-theme-catalog
hermes plugins enable theme-catalog
```

That's it. On first plugin load (and whenever the catalog or widget changes),
`register()` materializes the 606 TUI skins into `~/.hermes/skins/catalog-*.yaml`
and copies the picker widget to `~/.hermes/tui-widgets/themes.mjs` (stamp-guarded;
repeat loads cost one hash plus a presence check). If the repo is private and your
gh token is dead, the SSH route works too:

```bash
git clone git@github.com:0-CYBERDYNE-SYSTEMS-0/hermes-theme-catalog.git ~/.hermes/plugins/theme-catalog
hermes plugins adopt theme-catalog && hermes plugins enable theme-catalog
```

Requires Hermes >= 0.23.0 (the plugin refuses to register on older; run
`hermes update --yes` first).

The desktop half is `desktop/plugin.js`; if it does not appear in the app, copy
it to `~/.hermes/desktop-plugins/theme-catalog/plugin.js` and ⌘K → **Reload
desktop plugins**.

## Use the themes in the TUI

The desktop themes above only paint the desktop app. The terminal UI gets the same
profiles two ways — both automatic on plugin load:

- **606 real TUI skins** at `~/.hermes/skins/catalog-*.yaml` (same color math, same
  4.5:1 floor) — `/skin catalog-gruvbox-dark` or `hermes skin use catalog-gruvbox-dark`.
- **The `/themes` picker widget** (`tui/themes.mjs`, copied to
  `~/.hermes/tui-widgets/`): 606 rows with ANSI swatches, type-to-filter, arrows to
  move, enter applies live via `hermes skin use <slug>`.

Rebuild by hand if you ever want to: `python3 tools/build-skins.py`.

## Rebuild the catalog

Profiles come from a checkout of iTerm2-Color-Schemes (WezTerm TOML layout):

```bash
python3.12 tools/build.py --catalog ~/dev/macOS-terminal-theme-picker/vendor/iTerm2-Color-Schemes/wezterm
node tools/verify.mjs              # token/contrast/fidelity checks, exit 1 on failure
node tools/registration-test.mjs   # loads the plugin under stubs, exercises register()
```

`build.py` writes both `desktop/plugin.js` (generated, do not hand-edit) and
`build/profiles.json` (the parsed catalog).

| File | Role |
|---|---|
| `src/theme-map.mjs` | pure color math and profile → DesktopTheme mapping |
| `src/ui.js` | the catalog page and registration |
| `tools/build.py` | parse profiles, assemble the single-file plugin |
| `tools/verify.mjs` | 606-theme structural + contrast + verbatim-fidelity checks |
| `tools/registration-test.mjs` | module-load, register(), render, edit and authoring harness |
| `fixtures/profiles.json` | committed catalog, so the math is testable without the vendored TOMLs |

## Authoring a theme of your own

An edit is an override of one catalog theme: it is stored in this install's
plugin storage (`primary-color-edits`), survives restart and reinstall, and
never rewrites the shipped catalog.

To keep a look as an entry of its own, **Save as** in the editor mints
`catalog-<name>-custom` with the current pair and the profile's own 16 ANSI
colors. Saved entries are registered themes: they appear in Appearance, ⌘K and
`/skin`, can be starred, edited, and **Deleted** from the editor. They live in
`custom-themes` in plugin storage.

**Export** writes `{ version, exportedAt, themes: [{ label, base, bg, fg, ansi }] }`
as JSON (one theme from the editor, the current list from the toolbar);
**Import** reads the same shape back. That is the only way an authored theme
leaves this machine — plugin storage is per-plugin, so there is no direct write
into another plugin's records.

## Tests and CI

`.github/workflows/ci.yml` runs on every push and pull request: a syntax check of
the shipped bundle, the color-math suite, and the registration/authoring harness
on Node 20 and 22, plus `py_compile` for the TUI half.

The harness is not a smoke test. It loads `desktop/plugin.js` under stubbed
`@hermes/plugin-sdk` and React modules, drives the real code paths and asserts
what reached the registry:

- 606 theme registrations, unique ids, 26 tokens and 19 terminal keys each
- the app's ⌘K keyword construction (a theme without a `description` crashes it)
- every row's BG · FG · 16-ANSI strip contract, all 606 rows, no row cap
- an edit round trip: chip → panel → hex commit → exactly one republish of the
  same object, persistence, reset, and boot restore
- save-as, import (including rejecting invalid hex), export payload, delete
- undo, compare, per-slot reset, star persistence, mode filter, contrast sort
- `desktop/plugin.js` drift: every theme re-derived from `fixtures/profiles.json`
  and compared token-by-token with the shipped bundle

```bash
npm test          # node tools/verify.mjs && node tools/registration-test.mjs
```

## Cost worth knowing

606 themes register at plugin load and appear alongside the app's own skins in
Appearance, which renders every registered theme. The catalog page also renders
all 606 rows at once (~17k elements, no virtualization) so scrolling is smooth
and complete; the filter narrows the list when you want to find one by name.

## License

MIT for the plugin code. The color catalog keeps its own license and
attribution: iTerm2-Color-Schemes (MIT), individual themes by their own authors.

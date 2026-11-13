# Theme Catalog

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
- **Searchable, uncapped.** Filter by name and the counter says how many
  matched. With no filter set, every one of the 606 rows is rendered and
  scrollable — nothing is hidden behind a row cap.
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
  one. Reset puts the profile's own colors back.
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
| `tools/registration-test.mjs` | module-load and register() harness with stubbed SDK |

## Editing one theme

The page's **Copy** button puts the full theme object (tokens + terminal) on the
clipboard. Paste it into whatever authoring surface you prefer. There is no
direct write into Theme Forge's storage: plugin storage is per-plugin, so a
handoff would mean writing another plugin's private record.

## Cost worth knowing

606 themes register at plugin load and appear alongside the app's own skins in
Appearance, which renders every registered theme. The catalog page also renders
all 606 rows at once (~17k elements, no virtualization) so scrolling is smooth
and complete; the filter narrows the list when you want to find one by name.

## License

MIT for the plugin code. The color catalog keeps its own license and
attribution: iTerm2-Color-Schemes (MIT), individual themes by their own authors.

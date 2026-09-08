# matugen templates for Claude Desktop

[matugen](https://github.com/InioX/matugen) templates that turn your wallpaper into Claude Desktop colors. All render into `~/.config/Claude/themes.d/`, which the app watches and re-applies live (guide: [docs/themes.md](../../docs/themes.md#6-dynamic-themes-from-your-wallpaper-matugen-pywal-wallust)).

**Recommended flow** - keep any theme, add the wallpaper's accents, let light/dark follow the wallpaper:

1. Copy `claude-desktop-overlay.json` to `~/.config/matugen/templates/` and `set-mode-from-wallpaper.sh` to `~/.config/matugen/`, then register the template:
   ```toml
   [templates.claude-desktop]
   input_path = '~/.config/matugen/templates/claude-desktop-overlay.json'
   output_path = '~/.config/Claude/themes.d/wallpaper-accent.json'
   ```
2. Make your wallpaper tool's post-change command `~/.config/matugen/set-mode-from-wallpaper.sh "$WALLPAPER"`. It measures the image's mean luma (light above 0.55, `CDB_MODE_THRESHOLD` overrides), runs `matugen image -m <mode>` and sets the desktop-wide light/dark preference (gsettings color-scheme, adw-gtk3 variant on XFCE). Prefer a fixed mode and an untouched desktop preference? Use `matugen image "$WALLPAPER" -m dark` there instead.
3. Put `"themeOverlay": "wallpaper-accent"` into `~/.config/Claude/claude-desktop-extra.jsonc`.
4. Set Claude Desktop Settings -> Appearance -> System and pick any theme in the Ctrl+Shift+T picker. Which palette the app shows is Anthropic's own Appearance setting, not something our config can drive; System is the only value that follows the desktop preference. Keep Dark or Light for a fixed mode (then use the plain `matugen image ... -m dark` line instead of the script).

**Templates**

- `claude-desktop-overlay.json` - accent, brand, danger, success and warning ramps plus the accent-clay/border chrome, no `extends`; made for `themeOverlay`.
- `claude-desktop-overlay-bg.json` - the inverse: only the background ramp (`--bg-*`, `--claude-background-color`) from the wallpaper, tinted primary tones; the active theme keeps its accents and glyph. Pair with `"themeOverlay": "wallpaper-bg"`.
- `claude-desktop.json` - a full theme: surfaces, text, accents, borders, status colors and renderer chrome from the Material You scheme (dark surfaces stay near-black, as Material You intends).
- `claude-desktop-tinted.json` - the full theme with backgrounds from the primary tonal palette (`palettes.primary._<tone>`: dark tones 25 to 5, light tones 99 to 90), so the wallpaper hue tints the surfaces. Add `-t scheme-vibrant` or `-t scheme-expressive` to the matugen call for more color.
- `claude-desktop-extends.json` - `"extends": "mario"` plus the same ramps as the overlay; swap `mario` for any theme.

The full, tinted and extends templates replace the whole theme: render them to `~/.config/Claude/themes.d/matugen.json` and set `"activeTheme": "matugen"` or pick **Matugen** in the picker. No post_hook is needed for any template; if you set `"themeWatch": false`, add `post_hook = 'claude-desktop --reload-theme'`. The `warning` and `success` roles come from matugen's `[config.custom_colors]` (e.g. `success = "#3fb950"`, `warning = "#f5a524"`).

Token values are HSL triplets `"H S% L%"` built from matugen's `.hue`, `.saturation` and `.lightness` formats; the `--claude-*` chrome variables take `.hex`. [pywal](https://github.com/dylanaraps/pywal) and [wallust](https://codeberg.org/explosion-mental/wallust) users can write the same JSON shape by hand or from their own templates - any file in `themes.d/` is a theme, whatever produced it.

A complete, copyable desktop setup (matugen `config.toml`, GTK color template, live-reload wrapper themes, Variety hook) is in [`example-xfce-variety/`](example-xfce-variety/). The GTK part is XFCE specific; the Claude Desktop part works on any desktop.

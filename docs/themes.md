# Custom Themes

From picking a bundled palette to recoloring the app from your wallpaper, in order of effort. For the short version, see [Custom Themes in the README](../README.md#custom-themes).

| Step | What you get |
|------|--------------|
| [1. Pick a theme](#1-pick-a-theme) | a new look in two keystrokes, no file |
| [2. Set it in the config file](#2-set-it-in-the-config-file) | one line, survives reinstalls |
| [3. Themes that ship with the app](#3-themes-that-ship-with-the-app) | 97 palettes to choose from |
| [4. Tweak a theme with `extends`](#4-tweak-a-theme-with-extends) | a bundled theme with your accent |
| [5. Write your own theme](#5-write-your-own-theme) | full control over every color |
| [6. Dynamic themes from your wallpaper](#6-dynamic-themes-from-your-wallpaper-matugen-pywal-wallust) | wallpaper accents on any theme, live |
| [7. Example configurations](#7-example-configurations) | every example in one list |
| [Reference](#reference) | schema, tokens, palettes |

Every theme is **dual light/dark**: it ships a `light` and a `dark` palette, and the app's own toggle (Settings → Appearance) picks the matching one live. Colors are CSS variables injected into every window (chat, sidebar, Code/Cowork, dialogs, Quick Entry); every bundled theme is contrast-checked (WCAG AA).

## 1. Pick a theme

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> anywhere in the app. A searchable picker opens with every theme available to you, each card showing a dark and a light row of swatches; click one and it applies immediately in every open window, no restart and no config file. Your choice is saved to `claude-desktop-extra.jsonc` with any comments in it left intact. The same list is also in the app's Settings dialog under **Extra → Themes**, next to an **Extra → Anthropic Features** panel that exposes the [feature flags](feature-flags.md) as switches. Both places also show an **Overlay** bar when a [`themeOverlay`](#6-dynamic-themes-from-your-wallpaper-matugen-pywal-wallust) is merged over your theme: it names the overlay, marks the active card with an `overlay` badge, and has a **Turn off** button; when none is active you can pick one of your own themes there and apply it, no config file needed.

## 2. Set it in the config file

One line is enough, no `themes` block needed. The file is `~/.config/Claude/claude-desktop-extra.jsonc` (comments allowed), and every later step in this guide goes into the same file:
```bash
echo '{"activeTheme": "mario"}' > ~/.config/Claude/claude-desktop-extra.jsonc
# applies within a moment (live reload), toggle Settings → Appearance for light/dark
```

## 3. Themes that ship with the app

The Mario theme ships a **light "overworld"** and a **dark "underground"** variant, with a bouncing mushroom loading spinner:

| Light (overworld) | Dark (underground) |
|-------------------|--------------------|
| ![Mario theme - light](../themes/mario/2026-06-26_14-46-chat-light.png) | ![Mario theme - dark](../themes/mario/2026-06-26_14-46-chat-dark.png) |

**Built-in themes** (each with a light + dark palette and a custom spinner):

| Theme | Light variant | Dark variant | Spinner |
|-------|---------------|--------------|---------|
| `mario` | sky-blue overworld | warm-brick underground | mushroom |
| `sweet` | blush/lavender | deep purple, vivid pink ([Sweet](https://github.com/EliverLara/Sweet)) | blossom |
| `nord` (alias `nordic`) | Snow Storm | Polar Night ([nordtheme.com](https://nordtheme.com)) | snowflake |
| `catppuccin-mocha` | Latte | Mocha ([catppuccin.com](https://catppuccin.com)) | cat |
| `catppuccin-macchiato` | Latte | Macchiato | cat |
| `catppuccin-frappe` | Latte | Frappe | cat |
| `catppuccin-latte` | Latte | Mocha | coffee cup |

**6 gaming palettes** form their own **Gaming** section in the picker and in Settings → Extra → Themes, with Mario joining them: `playstation` (PS1 console gray / charcoal, button-symbol status colors, spinning button glyphs), `gameboy` (DMG shell / pea-green LCD, d-pad), `final-fantasy` (parchment / menu blue, crystal), `zelda` (forest green and gold, a two-frame walking hero), `warcraft` (parchment gold / dark brown, a two-frame peon at work) and `dragonball` (sky and white / deep blue, a spinning 4-star ball). They resolve at built-in rank, so `"activeTheme": "zelda"` is enough.

**84 community palettes** ship alongside them, converted from the [Noctalia community-palettes](https://github.com/noctalia-dev/community-palettes) collection - Rose Pine, Gruvbox, Everforest, Kanagawa, Solarized, Tokyo Night, the Catppuccin accent variants and more. Each is a full dual light/dark set, so `"activeTheme": "<slug>"` is all it takes, and each carries a spinner glyph drawn from its name or colors. Browse all 97 with their swatches in **[themes/PALETTES.md](../themes/PALETTES.md)**.

## 4. Tweak a theme with `extends`

`"extends": "<theme>"` inside a theme inherits every token plus `chatFont`, `spinner` and `customCss` from the base (not the display name or `category`, so your theme stays under "Your themes") (any built-in, community or user theme; chains are allowed, cycles are ignored) and overrides only the keys you give, per mode (without `extends`, unset tokens fall back to claude.ai's stock values for that mode). Color tokens are HSL triplets written as `"H S% L%"` (hue in degrees, saturation and lightness in percent, no commas); the `--claude-*` chrome variables take plain hex. Mario with a teal accent in both modes:

```jsonc
{
  "activeTheme": "mario-teal",
  "themes": {
    "mario-teal": {
      "extends": "mario",
      "light": { "--accent-brand": "190 70% 38%", "--accent-000": "190 70% 42%" },
      "dark":  { "--accent-brand": "190 80% 60%", "--accent-000": "190 80% 65%" }
    }
  }
}
```

## 5. Write your own theme

A theme is a `light` and a `dark` block of tokens under your own name; list only the tokens you want to change. Same file as before:

```jsonc
{
  "activeTheme": "my-theme",
  "themes": {
    "my-theme": {
      "light": { "--bg-000": "0 0% 100%", "--bg-100": "30 30% 97%", "--text-000": "30 10% 12%", "--accent-brand": "15 63% 50%" },
      "dark":  { "--bg-000": "30 6% 16%",  "--bg-100": "30 6% 12%",  "--text-000": "40 30% 96%", "--accent-brand": "15 70% 62%" }
    }
  }
}
```

The full schema (`chatFont`, `spinner`, `customCss`, `category`), the token reference with the light/dark polarity tips, contrast checking and custom SVG spinners are in **[themes/README.md](../themes/README.md)**.

## 6. Dynamic themes from your wallpaper (matugen, pywal, wallust)

![PlayStation theme with wallpaper-tinted backgrounds via [matugen](https://github.com/InioX/matugen) and themeOverlay](../themes/matugen-2026-09-08_01-54.png)

*The built-in PlayStation theme with `"themeOverlay": "wallpaper-bg"`: backgrounds and light/dark follow the wallpaper, accents and glyph stay.*

Themes reload live. Edit `claude-desktop-extra.json`/`.jsonc` or anything in `~/.config/Claude/themes.d/` and the active theme is re-applied in every open window within about 300 ms, no restart. Atomic tmp-and-rename writers (matugen, [pywal](https://github.com/dylanaraps/pywal), [wallust](https://codeberg.org/explosion-mental/wallust)) are handled. Three ways to trigger a reload:

- **File watcher** (default) - on by default; `"themeWatch": false` in the `.jsonc` turns it off.
- **CLI** - `claude-desktop --reload-theme` asks the running instance to re-read its theme files (over the Quick Entry socket) and prints one JSON line, `{ok, changed, name, windows}`. Exits 1 with `Claude Desktop is not running` when no instance is up.
- **In-app** - `globalThis.__cdbThemes.reload(reason)` for scripts running inside the app (registry version 2).

Profiles keep their own copies: the paths follow the per-profile userData dir, the socket carries the `-<profile>` suffix, and in 3p mode the `-3p` dir applies.

**`themes.d/` drop-in directory.** Every `*.json` or `*.jsonc` file in `<userData>/themes.d/` (`~/.config/Claude/themes.d/` for the default profile) is one theme, named after the file stem: `matugen.json` becomes the theme `matugen`. A file may also carry several themes as `{"themes": {...}}`. When names collide, `.jsonc` themes win over `.json` themes, then `themes.d`, then the built-ins, then the community palettes. The directory exists so color generators can own a file of their own: nothing else in the app writes there, while the Extra settings page rewrites `claude-desktop-extra.json`, so a generator must not target that file.

### matugen (official recipe)

Tested on Arch, XFCE 4 / X11, with the Variety wallpaper switcher and matugen 4.2 (2026-09-08). The recommended flow keeps whatever theme you like and puts the wallpaper's accents on top, with light/dark following the wallpaper:

1. Copy [`claude-desktop-overlay.json`](../contrib/matugen/claude-desktop-overlay.json) and [`set-mode-from-wallpaper.sh`](../contrib/matugen/set-mode-from-wallpaper.sh) from [`contrib/matugen/`](../contrib/matugen/) to `~/.config/matugen/` (templates go in `templates/`) and register the template in `~/.config/matugen/config.toml`:
   ```toml
   [templates.claude-desktop]
   input_path = '~/.config/matugen/templates/claude-desktop-overlay.json'
   output_path = '~/.config/Claude/themes.d/wallpaper-accent.json'
   ```
2. Point your wallpaper tool's post-change command (Variety's `set_wallpaper` script, or any hook) at `~/.config/matugen/set-mode-from-wallpaper.sh "$WALLPAPER"`. The script measures the image's mean luma (light above 0.6, `CDB_MODE_THRESHOLD` overrides), runs matugen in that mode with `-t scheme-fidelity` (keeps the wallpaper's own chroma; the default tonal-spot scheme turns grey wallpapers into saturated blue) and sets the desktop-wide light/dark preference (the GNOME and xapp portal `color-scheme` keys, which is what Electron reads through xdg-desktop-portal, plus the adw-gtk3 variant on XFCE). If you do not want the desktop preference touched, use a fixed-mode `matugen image "$WALLPAPER" -m dark` line instead.
3. Add `"themeOverlay": "wallpaper-accent"` to `claude-desktop-extra.jsonc`, next to `activeTheme`.
4. Set Claude Desktop Settings → Appearance → **System**, then pick any theme in the Ctrl+Shift+T picker. Which of the two palettes the app shows is Anthropic's own Appearance setting, not something our config can drive; System is the only value that follows the desktop preference. Leave it on Dark or Light if you want a fixed mode (then the script is not needed, see the alternative in step 2).

From then on every wallpaper change recolors the accents, brand and status colors of the active theme and switches the app between its light and dark palette. `"themeOverlay": "<theme>"` merges that theme's light/dark tokens over whatever theme is active (picker, Settings, `activeTheme`), per mode; its spinner, `chatFont`, `customCss`, name and category are ignored, and it resolves like any theme (`themes.d/` file, built-in, `extends` allowed). `""` or absent turns it off; with no active theme nothing is overlaid. The overlay templates carry `"hidden": true`, which keeps a theme out of the picker and Settings while it stays usable as `themeOverlay`, `activeTheme` or an `extends` base, so an overlay file cannot be picked as a base theme by mistake. No `post_hook` is needed thanks to the watcher; `post_hook = 'claude-desktop --reload-theme'` covers people who disabled it. The picker (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>) and **Extra → Themes** show the active overlay in an **Overlay** bar with a **Turn off** button, and offer a select over your own themes (hidden ones included) to switch one on; both write `themeOverlay` to the same config file.

**Alternatives** that replace the whole theme instead of overlaying one (same `config.toml` shape with `output_path = '~/.config/Claude/themes.d/matugen.json'`, then `"activeTheme": "matugen"` or **Matugen** in the picker):

- [`claude-desktop.json`](../contrib/matugen/claude-desktop.json) - the full theme: surfaces, text, accents, borders, status colors and renderer chrome from the Material You scheme. Material You keeps dark surfaces near-black by design.
- [`claude-desktop-tinted.json`](../contrib/matugen/claude-desktop-tinted.json) - the same, but the backgrounds take the wallpaper hue and chroma from the scheme's primary container color at fixed lightness steps, so a grey wallpaper gives grey-blue surfaces and a colorful one colorful surfaces. `-t scheme-vibrant` or `-t scheme-expressive` on the matugen command pushes more color everywhere.
- [`claude-desktop-overlay-full.json`](../contrib/matugen/claude-desktop-overlay-full.json) - the whole tinted palette as an overlay: every color follows the wallpaper, the picked theme contributes only its spinner, glyph and chat font. `"themeOverlay": "wallpaper-full"`.
- [`claude-desktop-overlay-bg.json`](../contrib/matugen/claude-desktop-overlay-bg.json) - the inverse of the recommended overlay: only the backgrounds follow the wallpaper (tinted primary tones), the active theme keeps its accents and glyph. `"themeOverlay": "wallpaper-bg"`.
- [`claude-desktop-extends.json`](../contrib/matugen/claude-desktop-extends.json) - `"extends": "mario"` plus only the accent, brand and status ramps; swap `mario` for any theme you like.

Template values are HSL triplets built from matugen's `.hue`/`.saturation`/`.lightness` formats; [contrib/matugen/README.md](../contrib/matugen/README.md) has the details.

**Window frame on X11.** Since Claude Desktop v1.49585.0 (Electron 44) a thin frame surrounds the app on X11: Electron 43+ gives frameless windows a 4 px client-side border painted in the GTK theme's headerbar color, and no window option removes it without also losing the window buttons ([electron/electron#52024](https://github.com/electron/electron/issues/52024); X11 only, Wayland draws a real shadow there). The example setup derives the GTK headerbar color from the same ramp as Claude's backgrounds so the frame blends in; `claude-desktop --native-titlebar` avoids it entirely.

### pywal / wallust / anything else

Write the same JSON shape into `themes.d/<name>.json`; the watcher picks it up, or call `claude-desktop --reload-theme` from the tool's hook. The smallest useful generator output is an `extends` file with a handful of tokens, for example `~/.config/Claude/themes.d/wal.json` (theme name `wal`):

```json
{
  "extends": "nord",
  "light": { "--accent-brand": "210 60% 45%", "--accent-000": "210 60% 50%", "--claude-accent-clay": "#3b6ea8" },
  "dark":  { "--accent-brand": "210 70% 65%", "--accent-000": "210 70% 70%", "--claude-accent-clay": "#7fb2e6" }
}
```

## 7. Example configurations

- **Minimal `activeTheme`** - one line selecting a bundled theme: [step 2](#2-set-it-in-the-config-file).
- **`extends` tweak** - Mario with a teal accent in both modes: [step 4](#4-tweak-a-theme-with-extends).
- **Full custom theme** - own `light`/`dark` token blocks: [step 5](#5-write-your-own-theme); a longer one with chrome variables is in [themes/README.md](../themes/README.md#json-schema).
- **`themes.d/` generator file** - hand-written `wal.json`, `extends` plus three tokens: [pywal / wallust](#pywal--wallust--anything-else).
- **matugen flow** - overlay template, mode script, `themeOverlay`, Appearance = System: [matugen (official recipe)](#matugen-official-recipe).
- **[contrib/matugen/claude-desktop-overlay.json](../contrib/matugen/claude-desktop-overlay.json)** - accent-only matugen template for `themeOverlay` (recommended).
- **[contrib/matugen/claude-desktop-overlay-bg.json](../contrib/matugen/claude-desktop-overlay-bg.json)** - backgrounds-only overlay: the picked theme keeps its accents and glyph, the surfaces follow the wallpaper.
- **[contrib/matugen/claude-desktop-overlay-full.json](../contrib/matugen/claude-desktop-overlay-full.json)** - full-palette overlay: every color from the wallpaper, the picked theme keeps only its spinner, glyph and chat font.
- **[contrib/matugen/claude-desktop.json](../contrib/matugen/claude-desktop.json)** - full wallpaper-driven theme template for matugen.
- **[contrib/matugen/claude-desktop-tinted.json](../contrib/matugen/claude-desktop-tinted.json)** - full template with wallpaper-tinted backgrounds.
- **[contrib/matugen/claude-desktop-extends.json](../contrib/matugen/claude-desktop-extends.json)** - compact matugen template, wallpaper accent on top of `mario`.
- **[contrib/matugen/set-mode-from-wallpaper.sh](../contrib/matugen/set-mode-from-wallpaper.sh)** - wallpaper post-change command: runs matugen in the mode matching the image's brightness and flips the desktop light/dark preference.

The whole desktop setup this was tested with (matugen config, GTK color template, live-reload wrapper themes, Variety hook) is in [`contrib/matugen/example-xfce-variety/`](../contrib/matugen/example-xfce-variety/); the GTK part is XFCE specific, the Claude Desktop part is not.

## Reference

- [themes/README.md](../themes/README.md) - JSON schema, `extends`, reloading, token reference, spinners, `chatFont`, `customCss`, contrast tips.
- [themes/PALETTES.md](../themes/PALETTES.md) - all 97 bundled palettes with swatches.
- [contrib/matugen/README.md](../contrib/matugen/README.md) - the four matugen templates, the mode script and their setup.
- [feature-flags.md](feature-flags.md) - the Extra → Anthropic Features panel next to the theme list.

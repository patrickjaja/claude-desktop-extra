# Claude Desktop Custom Themes

Create your own themes for Claude Desktop on Linux by overriding CSS variables.
Themes are now **dual light/dark**: each theme defines a `light` and a `dark`
palette, and the app's own light/dark toggle (Settings -> Appearance) picks the
matching one live.

New here? Start with [docs/themes.md](../docs/themes.md), which walks from picking a theme to
wallpaper-driven themes. This file is the deep reference.

## Preview - Mario theme (light + dark)

The same theme, both variants - toggle Settings -> Appearance to switch:

| Light (overworld) | Dark (underground) |
|-------------------|--------------------|
| ![Mario light](mario/2026-06-26_14-46-chat-light.png) | ![Mario dark](mario/2026-06-26_14-46-chat-dark.png) |

Note the loading glyph: every bundled theme replaces Claude's starburst with its own
SVG spinner (Mario gets a mushroom), and your own themes can too. See
[SPINNER_SHAPES.md](../baseline/SPINNER_SHAPES.md).

## Theme picker (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>)

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> in any Claude Desktop window to open
the picker: a searchable gallery of every theme available to you - your own themes, the
gaming palettes, the built-ins, and the bundled community palettes - each in its own
divider-separated section, each card showing a dark row and a light row of swatches so you
can judge a palette before wearing it.

Click a card and the theme applies immediately, in every open window. No restart, no
editing a file by hand. The picker then writes your choice into
`~/.config/Claude/claude-desktop-extra.jsonc`, replacing only the `activeTheme` value
and leaving every comment and every other key exactly as you had them. If that file
does not exist yet, the picker creates it with a short commented template.

| Key | Action |
|-----|--------|
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> | open the picker; press it again inside the picker to close it |
| <kbd>/</kbd> | jump to the filter field |
| arrows / <kbd>Tab</kbd> | move between cards |
| <kbd>Enter</kbd> | apply the focused theme |
| <kbd>Esc</kbd> | close |

The **Claude default** card at the top reverts to Claude's own palette: it removes
the injected CSS from every window and saves an empty `activeTheme`.

**Every part of a theme switches instantly** - surfaces, text, accents, borders, status
colors, the `chatFont` override, any `customCss`, and the **spinner shape**: the loading
glyph takes the new theme's shape and animation in every open window, and reverting to
Claude default puts Claude's own star back. Nothing about switching needs a restart, and
neither does hand-editing the config file (see [Reloading](#reloading)).

## Settings -> Extra (in the app's own dialog)

The same registry is also reachable without a hotkey. Open Claude's Settings dialog and
you'll find an **Extra** group in the nav with two entries:

- **Themes** - every theme available to you as a row with color dots, in the same
  sections as the picker (your themes, Gaming, built-in, community). Clicking one applies
  it live - colors and spinner both - and saves `activeTheme` the same way the picker
  does, into `claude-desktop-extra.jsonc` with your comments intact.
- **Features** - the 134 catalogued GrowthBook feature flags as switches, so you can
  browse and flip them without hand-editing a config file. See
  [Feature Flag Overrides](../docs/feature-flags.md) for what the
  flags are.

The Features panel starts from what your account actually gets: flags upstream already
enables show up switched on, and turning one off writes an explicit `false`. Flags that
carry a value rather than a switch are listed read-only, and the one flag that breaks
Cowork when enabled is not toggleable at all. Anything you set by hand in
`claude-desktop-extra.jsonc` is shown as `.jsonc`-owned and left to that file - the
hand-edited value wins per flag ID, and the panel will not fight it.

Where the two panels save differs, because they answer to different files:

| Panel | Writes | Takes effect |
|-------|--------|--------------|
| Themes | `activeTheme` in `claude-desktop-extra.jsonc` (comment-preserving) | live, in every open window |
| Features | `growthbookOverrides` in `claude-desktop-extra.json` | after a restart |

Flag changes need a restart because the features they gate are wired up when the app
starts, so the panel says so and offers a **Restart now** button.

The Extra group is injected into Settings, which is claude.ai markup this package does
not control. The <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> picker is entirely local
and always available, so it is the reliable way to change a theme.

## Dual light/dark variants

Each theme ships **two** palettes - a `light` block and a `dark` block. The patch
injects them on mode-scoped selectors:

- `light` -> `:root, [data-mode=light]`
- `dark` -> `.darkTheme, [data-mode=dark], .dark` (emitted second so it wins a
  specificity tie)

Because both blocks are always present and scoped by mode, **Claude Desktop's own
light/dark toggle (Settings -> Appearance) picks the variant that matches the current
mode**. A theme looks right in both, so there is no need to pin the app to one mode.

The element overrides (sidebar, content panes, popovers, scrims, scrollbars, etc.)
reference the semantic tokens, so they are emitted **once** and are automatically
correct in whichever mode is active. Only the decorative glow shadows are gated to
dark mode (they look gaudy on a light surface).

## Built-in themes (dual-variant)

Each built-in ships a light and a dark palette and lives inside the patch, so setting
just `activeTheme` to one of these works with **no `themes` block needed**:

| `activeTheme` | Light identity | Dark identity | Spinner |
|---------------|----------------|---------------|---------|
| `sweet` | white / soft-pink surfaces, magenta-rose accent | deep plum-violet surfaces, hot-pink accent | blossom (`spin`) |
| `nord` (alias: `nordic`) | Nord Snow Storm: cool off-white surfaces, frost-blue accent | Nord Polar Night: slate-blue surfaces, frost-cyan accent | snowflake (`spin`) |
| `catppuccin-mocha` | Catppuccin **Latte** (light) | Catppuccin **Mocha** (dark) - mauve accent | cat head (`pulse`) |
| `catppuccin-macchiato` | Catppuccin **Latte** (light) | Catppuccin **Macchiato** (dark) - mauve accent | cat head (`pulse`) |
| `catppuccin-frappe` | Catppuccin **Latte** (light) | Catppuccin **Frappe** (dark) - mauve accent | cat head (`pulse`) |
| `catppuccin-latte` | Catppuccin **Latte** (light) | Catppuccin **Mocha** (dark) | coffee cup (`pulse`) |
| `mario` | sky-blue overworld: pale-blue surfaces, dark-navy text, Mario-red accent | warm-brick underground: brown surfaces, cream text, Mario-red accent + coin-gold/pipe-green status | mushroom (`bounce`) |

Notes:

- **`nord` / `nordic`:** the canonical built-in key is `nord`; `nordic` is an alias
  that resolves to it. The `themes/nordic/` folder's config uses `"activeTheme":
  "nord"` to match. Either name works.
- The three dark Catppuccin variants (`-mocha`, `-macchiato`, `-frappe`) all use
  **Latte** as their light variant - Catppuccin only defines one light flavour.
- A built-in resolves entirely from the patch. If `activeTheme` matches nothing (not
  a custom theme, not a built-in, not a community palette, not an alias) the patch
  logs a **loud** line listing the valid built-in names and how many themes each
  source offers, then applies nothing - it never silently succeeds.
- `mario` carries `"category": "gaming"`, so the picker and Settings -> Extra -> Themes
  list it in the Gaming section below. It still resolves as a built-in.

## Gaming themes

Six more palettes ship as a **Gaming** category, authored in `js/gaming_themes.json` and
merged into the built-ins at startup - same resolution rank, own divider-separated section
in the picker and in Settings -> Extra -> Themes (where `mario` joins them, making seven
cards). Each has a spinner built for it:

| `activeTheme` | Light identity | Dark identity | Spinner |
|---------------|----------------|---------------|---------|
| `playstation` | PS1 console gray, PlayStation-blue accent | charcoal blue-black, bright blue accent | the four controller button symbols (`spin`) |
| `gameboy` | DMG shell gray with magenta buttons | pea-green LCD, pea-green accent | d-pad (`pulse`) |
| `final-fantasy` | parchment cream, menu-blue accent | classic menu blue, crystal-gold accent | faceted crystal (`pulse`) |
| `zelda` | pale parchment green, forest-green accent | deep forest green, gold accent | walking hero silhouette (`flip`) |
| `warcraft` | parchment gold, Alliance-blue accent | dark brown with gold, orc-green success | peon swinging a pick (`flip`) |
| `dragonball` | white on a sky backdrop, orange accent | deep blue, bright orange accent | 4-star dragon ball (`spin`) |

`playstation` also borrows its status colors from the controller's button symbols
(circle-red danger, triangle-green success). `dragonball`'s spinner pins its orange and
red, so the ball keeps its own colors in both variants; every other gaming spinner follows
the theme accent.

A theme of your own can join that section too: give it `"category": "gaming"` alongside
its `light`/`dark` blocks.

## Community palettes

Alongside the built-ins, the patch bundles **84 community palettes** converted from
the [noctalia community-palettes](https://github.com/noctalia-dev/community-palettes)
collection - Rose Pine, Gruvbox, Solarized, Everforest, Tokyo Night, the Catppuccin
accent variants, and many more. They need no `themes` block: set `activeTheme` to a
slug, or just pick one in the picker.

The slug is the palette's upstream name lowercased with every run of non-alphanumeric
characters replaced by a single `-`, so `Rose Pine Moon` becomes `rose-pine-moon` and
`Ayu Blue` becomes `ayu-blue`. Each palette carries a full dual-variant token set, so
Claude's own light/dark toggle keeps working.

Each one also carries a **spinner glyph drawn from its name or colors** - a stag for
Everdeer, aurora ribbons for Nord Aurora, a great-wave curl for the Kanagawa family, a
curled cat for every Catppuccin variant. There are 53 distinct designs across the 84
slugs, because families share a shape on purpose. The glyphs are curated in
`scripts/community-spinners.json` and merged into the palettes by
`scripts/generate-community-themes.mjs`, so refreshing the collection stays one command.

A visual catalog of every bundled palette - all 97, the 84 community ones plus the 7
built-ins and the 6 gaming palettes, each with its swatch card and slug - is in
[PALETTES.md](PALETTES.md).

Resolution order is **your themes > built-ins > community palettes**, so defining a
theme under `themes` with the same slug as a community palette overrides it rather
than colliding with it.

## JSON schema

Place your theme config at `~/.config/Claude/claude-desktop-extra.jsonc`
(comments allowed; configs under the previous `claude-desktop-bin` name also keep working and are
merged in, with the `.jsonc` winning per key). The dual-variant shape:

```jsonc
{
  "activeTheme": "<name>",
  "themes": {
    "<name>": {
      "light":  { /* full token set, LIGHT-mode values */ },
      "dark":   { /* full token set, DARK-mode values  */ },
      "chatFont": "optional CSS font-family string",   // optional, shared both modes
      "spinner": { /* optional loading-glyph override, see below */ },
      "category": "gaming",                           // optional; own picker section
      "hidden": true                                  // optional; usable but not listed in the picker
    }
  }
}
```

A minimal real example (only the tokens you want to change; unspecified tokens fall
through to claude.ai's stock values for that mode):

```jsonc
{
  "activeTheme": "my-theme",
  "themes": {
    "my-theme": {
      "light": {
        "--bg-000": "0 0% 100%",
        "--bg-100": "30 30% 97%",
        "--text-000": "30 10% 12%",
        "--accent-brand": "15 63% 50%",
        "--border-100": "30 8% 20%",            // DARK-ish in light mode (see polarity tip)
        "--claude-background-color": "#fbfaf7",
        "--claude-foreground-color": "#1a1814"
      },
      "dark": {
        "--bg-000": "30 6% 16%",
        "--bg-100": "30 6% 12%",
        "--text-000": "40 30% 96%",
        "--accent-brand": "15 70% 62%",
        "--border-100": "40 14% 84%",           // LIGHT-ish in dark mode (see polarity tip)
        "--claude-background-color": "#27241f",
        "--claude-foreground-color": "#f5f2ea"
      }
    }
  }
}
```

- Set `activeTheme` to a built-in name, a community palette slug (both above), or a key
  in your own `themes` object.
- Hand-edits are picked up live: the app watches the file and re-applies the active
  theme within a moment (see [Reloading](#reloading)). The picker and Settings -> Extra ->
  Themes apply instantly as well.
- `"themeOverlay": "<theme>"` merges that theme's `light`/`dark` tokens over whatever theme
  is active (picker, Settings or `activeTheme`), per mode; its `spinner`, `chatFont`,
  `customCss`, name and category are ignored. Resolved like any theme (a `themes.d/` file,
  a built-in, `extends` allowed). `""` or absent = off; with no active theme nothing is
  overlaid. Built for wallpaper accents, see [docs/themes.md](../docs/themes.md#matugen-official-recipe).

> **Backward compatibility:** a **flat** theme object - one with `--token` keys
> directly and **no** `light`/`dark` blocks (the old schema) - still works. The patch
> treats the whole object as **both** light and dark, so old single-palette configs
> keep applying exactly as before.

### `extends`

`"extends": "<theme>"` inherits every token plus `chatFont`, `spinner` and `customCss`
from another theme (built-in, community or your own; chains allowed, cycles ignored) and
overrides only the keys you give, per mode. The display name and `category` are not
inherited, so your theme keeps its own label and stays under "Your themes" unless you
set a category yourself. Handy for "Mario with a
different accent": `{"extends": "mario", "dark": {"--accent-brand": "200 80% 60%"}}`.

### Reloading

Theme files reload live: a change to `claude-desktop-extra.json`, `.jsonc` or anything in
`themes.d/` is re-applied in every open window within about 300 ms, including atomic
tmp-and-rename writes. `"themeWatch": false` turns the watcher off. To trigger a reload
by hand, run `claude-desktop --reload-theme` (talks to the running instance over the
Quick Entry socket, prints `{ok, changed, name, windows}`, exits 1 when the app is not
running); in-app code can call `globalThis.__cdbThemes.reload(reason)`. Named profiles and
3p mode use their own userData dir and socket suffix.

### Generators and `themes.d/`

Every `*.json`/`*.jsonc` file in `~/.config/Claude/themes.d/` is one theme named after the
file stem (`matugen.json` -> `matugen`), or several as `{"themes": {...}}`. Same name in
several places: `.jsonc` > `.json` > `themes.d` > built-ins > community. Color generators
([matugen](https://github.com/InioX/matugen), [pywal](https://github.com/dylanaraps/pywal), [wallust](https://codeberg.org/explosion-mental/wallust)) should write here, never into `claude-desktop-extra.json`, which
the Extra settings page rewrites. Full guide with a matugen recipe:
[docs/themes.md](../docs/themes.md#6-dynamic-themes-from-your-wallpaper-matugen-pywal-wallust).

## Spinner reshape (per-theme loading glyph)

Every bundled palette replaces the Anthropic loading "star" with its own SVG shape, and a
theme of yours can too, via an optional `spinner` field. The patch injects a small
renderer-side script that finds claude.ai's brand-star glyph (matched by its path
signature) and swaps in your paths, keeping the `<svg>` wrapper so the accent color and
box size are preserved. Animation keyframes ship alongside the theme CSS.

The shapes on the built-ins:

| Theme | Shape | Color | Animation |
|-------|-------|-------|-----------|
| `mario` | Mario mushroom | multi-color (baked hex) | `bounce` |
| `sweet` | 5-petal blossom | accent (`currentColor`) | `spin` |
| `nord` | 6-point snowflake | accent (`currentColor`) | `spin` |
| `catppuccin-mocha` | cat head | accent (`currentColor`) | `pulse` |
| `catppuccin-macchiato` | cat head | accent (`currentColor`) | `pulse` |
| `catppuccin-frappe` | cat head | accent (`currentColor`) | `pulse` |
| `catppuccin-latte` | coffee cup | accent (`currentColor`) | `pulse` |

The gaming shapes are in the table [above](#gaming-themes); the community glyphs are
listed in [baseline/SPINNER_SHAPES.md](../baseline/SPINNER_SHAPES.md).

Shape format (in your theme object):

```jsonc
"spinner": {
  "viewBox": "0 0 100 100",          // optional, default "0 0 100 100"
  "match": "m19.6 66.5 19.7-11",     // optional override of the star signature (string or array)
  "animation": "spin|bounce|pulse|flip|null",
  "paths":  [ { "d": "...", "fill": "#hex" }, ... ],  // omit "fill" => currentColor (follows accent)
  "paths2": [ { "d": "..." }, ... ]                   // second frame - required iff animation is "flip"
}
```

- `spin` rotates about the glyph's own center, `bounce` is a vertical hop, `pulse` is an
  opacity throb, and `null` inherits only claude.ai's own motion.
- **`flip` is a two-frame sprite cycle:** both frames are rendered and hard-cut between at
  ~2 frames/sec, no tweening - which is how the Zelda hero takes a step and the Warcraft
  peon swings. It needs `paths2`; a `flip` without it is refused (and a `paths2` on any
  other animation is ignored).
- Keep both frames' shared silhouette at identical coordinates, or the cut reads as
  jitter instead of motion.
- A malformed spec is refused with a diagnostic line and the glyph on screen is left
  alone - you never get a half-drawn shape. For the bundled palettes the same contract is
  asserted at build time, so a broken spec fails the build.

**Switching theme reshapes the glyph immediately** in every open window, and picking
Claude default puts Claude's own star back. See
[baseline/SPINNER_SHAPES.md](../baseline/SPINNER_SHAPES.md) for the full spec, the literal
path data for each shape, and a DevTools-console recipe for swapping a shape live (no
rebuild).

> **The spinner is remote-rendered, so it is version-sensitive.** The star glyph
> lives in claude.ai's bundle, which this repo cannot pin. If you see
> `[spinner] themed 0` in the console, the upstream glyph geometry changed - set a
> per-theme `match` override to the new path signature (no rebuild needed). A
> `themed 0` is **not** "feature removed", it is "geometry drifted".

## Token reference (v1.15962)

> **This section was corrected for v1.15962.** The accent token families
> `--accent-main-*`, `--accent-secondary-*`, and the prose tokens `--tw-prose-*`
> **do not exist** in this build - older versions of this doc listed them as
> themeable. They are gone. See
> [baseline/THEME_TOKEN_MAP.md](../baseline/THEME_TOKEN_MAP.md) for the full,
> mined-from-the-live-app token reference.

Values are HSL components **without** the `hsl()` wrapper - `"hue sat% light%"`
(e.g. `"285 50% 8%"`). Tailwind utilities compile to `hsl(var(--bg-000))`, so
overriding the variable themes every utility that reads it.

### Backgrounds & text

| Variable | Purpose |
|----------|---------|
| `--bg-000` | Lightest surface - panels / cards / popovers float here |
| `--bg-100` | Content panes / dialogs |
| `--bg-200` | Sidebar |
| `--bg-300` | "Darker" sidebar sub-variant |
| `--bg-400` / `--bg-500` | Content backdrop (darkest) / deepest |
| `--text-000` / `--text-100` | Primary text (`000` == `100`) |
| `--text-200` / `--text-300` | Secondary text |
| `--text-400` / `--text-500` | Muted text |

> **Surface hierarchy gotcha:** the main content backdrop is the **darkest** level
> (`--bg-400`); panels and popovers float **above** it at `--bg-000` (the lightest).
> Don't flatten everything onto one `--bg` level or you lose the depth.

### Accents (the real tokens)

| Variable | Purpose |
|----------|---------|
| `--accent-brand` | The brand accent (clay by default). The single most visible accent: checkboxes, scrollbars, selection, focus glow, spinner all read it. |
| `--accent-000` `--accent-100` `--accent-200` `--accent-900` | Blue accent ramp (`100` == `200`). Used for focus rings and links. |
| `--accent-pro-000` ... `--accent-pro-900` | Violet (Pro / Max) accent ramp (`100` == `200`). |
| `--brand-000` ... `--brand-900` | Clay ramp (`--brand-900` is `--always-black`). |

> You **do not** author `--accent-main-*` / `--accent-secondary-*`. They don't exist
> in stock v1.15962, but some legacy refs (and a couple of our element overrides)
> still mention them. The patch **auto-derives** them from your real accents
> (`--accent-main-100 -> var(--accent-brand)`, etc.) plus `--always-black` /
> `--always-white`, so everything resolves without you touching them.

### Borders, status, on-color, pictograms

| Variable | Purpose |
|----------|---------|
| `--border-100` ... `--border-400` | Border colors (all four are typically the same value within a mode) |
| `--danger-000` ... `--danger-900` | Error / destructive (`100` == `200`) |
| `--warning-000` ... `--warning-900` | Warning (`100` == `200`) |
| `--success-000` ... `--success-900` | Success (`100` == `200`) |
| `--oncolor-100` ... `--oncolor-300` | Text / icon color **on** a filled accent button |
| `--pictogram-100` ... `--pictogram-400` | Icon / illustration fills |

> **Border polarity - the #1 authoring gotcha.** claude.ai applies borders at a low
> alpha at the use site, so the **raw token must be the OPPOSITE polarity of the
> surface**:
> - **Dark variant:** `--border-*` must be a **light-ish** HSL (stock dark is
>   `51 16.5% 84.5%`, near-white). A dark border value in dark mode = **invisible
>   borders**.
> - **Light variant:** `--border-*` must be a **dark-ish** HSL (stock light is
>   `30 3.3% 11.8%`).
> - Rule of thumb: border lightness ~= opposite of the bg lightness in that mode.

> **`--oncolor-*` polarity:** this is the text on filled accent buttons, so it must
> contrast with `--accent-brand` / `--accent-200`. Near-white for dark themes - but
> if your accent is light/pastel, `oncolor` must be **dark** (e.g. `sweet`'s dark
> variant uses a near-black oncolor on its hot-pink accent). Verify `oncolor-100`
> against both `accent-200` and `accent-brand` at >= 4.5.

### Legacy hex variables (renderer chrome)

These color the renderer windows (Quick Entry, title bar, About) and use **hex**,
per mode:

| Variable | Purpose |
|----------|---------|
| `--claude-accent-clay` | Accent (logo, highlights) |
| `--claude-foreground-color` | Primary text |
| `--claude-background-color` | Window background; also painted onto the main window itself (the frame the content view leaves around the app), falls back to `--bg-100` |
| `--claude-secondary-color` | Secondary / muted text |
| `--claude-border` / `--claude-border-300` / `--claude-border-300-more` | Borders (include alpha, e.g. `#b496b420`) |
| `--claude-text-100` / `-200` / `-400` / `-500` / `--claude-description-text` | Text ramp / hint text |

### The other token layers (handled for you)

Newer surfaces don't read `--bg-*` directly - the patch maps them onto your
`--bg-*` / `--text-*` automatically, so the whole UI recolors out of the box:

- **`--cds-*`** (Console Design System): popovers, the Cowork / Code frame, Settings
  dialogs. The patch maps `--cds-surface-*`, `--cds-text-*`, `--cds-border`,
  `--cds-clay` onto your semantic tokens.
- **`--df-*`** (Desktop Frame): the window chrome - sidebar (`--df-z2`), content
  panes (`--df-z1`). These are a neutral gray ramp independent of `--bg-*`; the
  patch overrides `.dframe-sidebar` / `.dframe-content` and the `--df-z*` /
  `--df-surface-primary` / `--df-sidebar-bg` tokens to match your `--bg-*` hue.

You author only `--bg-*` / `--text-*` / `--accent-*` (+ the `--claude-*` hex chrome);
the CDS and DF layers follow.

## Contrast (WCAG-checked)

The built-in themes are WCAG-checked: text on background (`text-000/200/400` on
`bg-000`/`bg-100`) and on-color on accent are kept at **>= 4.5** contrast, and
`accent-100` on `bg-000` at >= 3.0. When authoring your own, nudge lightness until
those pairs clear the threshold (a contrast checker lives in the project scratchpad).

## Chat font override

Override the chat font per-theme or globally. The value is any valid CSS
`font-family` string:

```jsonc
{
  "activeTheme": "nord",
  "chatFont": "'Fira Sans', sans-serif",
  "themes": {
    "my-custom-theme": {
      "light": { "--bg-000": "0 0% 100%" },
      "dark":  { "--bg-000": "220 17% 20%" },
      "chatFont": "'JetBrains Mono', monospace"
    }
  }
}
```

- Per-theme `chatFont` (inside a theme object) takes precedence over the global one.
- It overrides the `font-claude-response-body` / `font-claude-response-title` classes
  used by Claude's message text in both Chat and Cowork tabs, plus user message
  bubbles.
- Only **system-installed** fonts work (no Google Fonts / remote loading).

To find available fonts:

```bash
fc-list : family | sort -u           # all installed font families
fc-list : family | grep -i "fira"    # search for a specific font
```

## Custom CSS (raw rules)

`customCss` lets a theme inject raw CSS rules (beyond `--` variables) into the windows
the theme system styles. It accepts a single string or an array of strings (arrays are
joined with newlines), at the **top level** (applies under whatever theme is active)
and/or **inside a theme object** (applies only when that theme is active). Both are
injected **after** the variable declarations and the built-in element overrides;
per-theme `customCss` is appended after the global one, so it wins.

```jsonc
{
  "activeTheme": "nord",
  "customCss": ".some-renderer-element{ /* raw rule */ }",
  "themes": {
    "nord": {
      "light": { "--bg-000": "220 16% 96%" },
      "dark":  { "--bg-000": "220 16% 22%" },
      "customCss": ".container{ box-shadow: 0 0 0 1px hsl(var(--accent-brand) / 0.4) !important }"
    }
  }
}
```

On startup (run `claude-desktop` from a terminal) you'll see
`[CustomThemes] customCss appended (N chars)` confirming your rules were injected.

> **`customCss` reaches the chat UI, and most surfaces are already recolored for you.**
> The patch injects CSS with Electron's `webContents.insertCSS()` on every WebContents
> it creates, including the chat webview and the nested
> `https://a.claude.ai/isolated-segment.html` iframe - so both `customCss` and the
> built-in element overrides apply there. The built-in overrides already map the
> `dframe-*`, CDS surface, semantic-surface, and scrim layers back onto your `--bg-*`
> variables, so the sidebar, main content, Settings, popovers, cards and scrims
> recolor for **every** theme with no extra `customCss`. Use `customCss` for anything
> those overrides don't cover.
>
> Two things stay out of reach: the **OS window-control buttons** (min/max/close) are
> drawn by your window manager's decorations, not by any web frame, so they're themed
> from your desktop environment - not here.

## Inspecting HTML, CSS & tokens for reference

The authoritative token reference is
[baseline/THEME_TOKEN_MAP.md](../baseline/THEME_TOKEN_MAP.md) - it documents every
themeable token family, the four coexisting token layers (v1/v2 semantic, CDS, DF),
stock light vs dark values, and the gotchas above, mined from a live v1.15962
extract. Read it before authoring; re-validate it on each upstream bump (token
*names* are stable, but the selector architecture and primitive layer can shift).

To inspect the actual HTML structure and CSS classes used by each renderer window,
extract the app bundle:

```bash
# Crack the official .deb (the build script leaves it in ./tmp/), then extract app.asar:
mkdir -p /tmp/claude-inspect
dpkg-deb -x ./tmp/claude-desktop_*_amd64.deb /tmp/claude-inspect/deb
asar extract /tmp/claude-inspect/deb/usr/lib/claude-desktop/resources/app.asar /tmp/claude-inspect/app
```

```bash
# List all renderer HTML files
find /tmp/claude-inspect/app/.vite/renderer -name "*.html"

# Quick Entry (the floating prompt box - the only HTML with real body content)
cat /tmp/claude-inspect/app/.vite/renderer/quick_window/quick-window.html

# Extract just the CSS variable definitions from the main window
grep -E '^\s*--' /tmp/claude-inspect/app/.vite/renderer/main_window/index.html | head -80
```

Each renderer HTML file has an inline `<style>` block (~4000 lines) with compiled
Tailwind utilities, the `window-shared.css` variable definitions, and
window-specific styles. The main chat UI loads from `claude.ai` as a separate
WebContentsView and uses the **same** HSL design tokens; inspect it with
`CLAUDE_DEV_TOOLS=detach claude-desktop` and the webview DevTools console.

Cleanup:

```bash
rm -rf /tmp/claude-inspect
```

## Tips for theme creators

1. **Start from a built-in** - copy one of the `themes/*/claude-desktop-extra.json`
   files (they're all dual-variant now) and edit both the `light` and `dark` blocks.
2. **HSL format** - `"hue saturation% lightness%"` (e.g. `"285 50% 8%"`), no
   `hsl(...)` wrapper. Legacy `--claude-*` variables are **hex** (with alpha for
   borders, e.g. `"#b496b420"`).
3. **Mind border polarity** - dark borders light-ish, light borders dark-ish (see
   the border gotcha above). This is the most common mistake.
4. **Check contrast** - keep text/oncolor against their backgrounds at >= 4.5.
5. **Test both modes** - toggle Settings -> Appearance between light and dark and
   confirm each variant; the app now picks the matching block.
6. **Check all windows** - open Quick Entry (hotkey), Find-in-Page (Ctrl+F), and
   About to verify the `--claude-*` chrome.

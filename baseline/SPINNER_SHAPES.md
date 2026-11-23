# Spinner Shapes - Per-Theme Brand-Glyph Replacements

**Companion to** [SPINNER_INJECTION_NOTES.md](SPINNER_INJECTION_NOTES.md) (the injection
design) and [themes/README.md](../themes/README.md) (the dual-variant theme contract as
theme authors see it).

This doc catalogs the spinner SVG shapes shipped per theme: what each shape is, its path
data, its color strategy, and how to swap/test one live in the running app.

**Every bundled palette ships a spinner.** All 138 - the 7 curated built-ins, 15 Linux
distro palettes (`js/linux_themes.json`), 12 gaming palettes (`js/gaming_themes.json`),
20 scene palettes (`js/scene_themes.json`), and 84 community palettes
(`js/community_themes.json`) - replace claude.ai's brand star with a glyph drawn for that
palette's name or colors.

- **Runtime engine:** `js/spinner_injector.js` (a self-guarding ES5 IIFE that installs
  `window.__cdbSpinnerApply(spec|null)` once per window).
- **Where the specs live:**
  | Tier | Spec source |
  |------|-------------|
  | curated built-ins (7) | inline in `patches/core/add_feature_custom_themes.nim` |
  | linux (15) | `js/linux_themes.json` |
  | gaming (12) | `js/gaming_themes.json` |
  | scenes (20) | `js/scene_themes.json` |
  | community (84) | curated in `scripts/community-spinners.json`, merged into `js/community_themes.json` by `scripts/generate-community-themes.mjs` |
  | your own themes | the `spinner` key of your theme in `claude-desktop-extra.jsonc` |
- **How it runs:** the Nim patch prepends `var __CDB_SPINNER_SPEC = <json|null>;` to the
  injector and evaluates it through the same `wc.executeJavaScript(...)` that injects
  theme CSS - on `dom-ready` **and again on every theme switch**. The injector finds the
  Anthropic 7-point brand-star (`viewBox "0 0 100 100"` + a child `<path d>` matching a
  star signature) and replaces its `<path>` children with the spec's paths, keeping the
  `<svg>` wrapper so the `fill-current` accent and box size are preserved.
- **Build-time gate:** every bundled spec is parsed and validated while the Nim patch
  compiles (`validateSpinner`): `paths` must hold at least one real `{d}` entry, any
  `fill` must be a string, `animation` must be one of `pulse|spin|bounce|flip`, and
  `paths2` must be present exactly when the animation is `flip`. A contract violation
  fails the build loud rather than shipping a broken glyph. The community generator adds
  its own gates: slug parity in both directions against the theme set, an SVG path-data
  tokenizer, and a >= 2.5:1 contrast check for any explicit `fill` against both variants'
  background.

> **All shapes:** `viewBox "0 0 100 100"`, centered, ~60-75% of the box, verified
> recognizable at 32px (the `w-8` greeting / thinking-spinner size).

---

## Spec format (per theme)

```jsonc
"spinner": {
  "viewBox": "0 0 100 100",          // optional, default "0 0 100 100"
  "match": "m19.6 66.5 19.7-11",     // optional override of the star signature (string or array)
  "animation": "spin|bounce|pulse|flip|null",
  "paths":  [ { "d": "...", "fill": "#hex" }, ... ],  // omit "fill" => currentColor
  "paths2": [ { "d": "...", ... }, ... ]              // REQUIRED iff animation is "flip"
}
```

A theme object may also carry a top-level **`category`** string (`"linux"`, `"gaming"`,
or `"scenes"`) to put the theme in the matching section of the picker and Settings -> Extra ->
Themes, independently of which tier it resolves from.

**Color strategy:** a path with **no `fill`** (or `fill: "currentColor"`) inherits the
theme accent through the `<svg>`'s `fill-current` class (which resolves `currentColor`
to `--accent-brand`). An **explicit hex** pins a fixed color - needed only where the
shape's identity is its colors (the Mario mushroom, the Dragon Ball). Every single-color
shape below omits `fill` so it follows the theme's brand accent.

**Animation:** adds a `cdb-anim-<name>` class to the replaced `<svg>`. The keyframes live
in the theme CSS (`insertCSS` path), not the injector, and **all five are emitted for
every theme** so a live switch can never land on a shape whose animation has no
keyframes. `spin` rotates about the glyph center (`transform-box: fill-box`), `bounce` is
a vertical hop, `pulse` is an opacity throb. Set `null` to inherit only claude.ai's own
motion.

**`flip` - the two-frame sprite cycle.** `flip` renders **both** frames at once, each in
its own `<g data-cdb-frame="1|2">`, and a `steps(2, jump-none)` keyframe pair swaps their
opacity at ~2 frames/sec. The result reads as a retro two-frame sprite animation (a hero
taking a step, a peon swinging a pick) rather than a tween. `paths2` is what frame 2
draws; a `flip` spec without it is refused, and a `paths2` on any other animation is
ignored with a diagnostic line.

---

## The 7 built-in shapes

| Theme | Shape | Paths | Color | Animation |
|-------|-------|-------|-------|-----------|
| `mario` | Mario mushroom | 8 | multi-color (explicit hex) | `bounce` |
| `sweet` | 5-petal blossom | 1 | currentColor (pink accent) | `spin` |
| `nord` | 6-point snowflake | 1 | currentColor | `spin` |
| `catppuccin-mocha` | cat head | 1 | currentColor | `pulse` |
| `catppuccin-macchiato` | cat head | 1 | currentColor | `pulse` |
| `catppuccin-frappe` | cat head | 1 | currentColor | `pulse` |
| `catppuccin-latte` | coffee cup | 1 | currentColor | `pulse` |

The three `catppuccin-*` dark variants intentionally **share** the cat-head shape; only
`catppuccin-latte` (the light variant) gets the coffee cup.

`mario` also carries `"category": "gaming"`, so it appears in the Gaming section of the
picker alongside the six palettes below while still resolving as a built-in.

---

### 1. `mario` - Mario mushroom (8 paths, multi-color, `bounce`)

The 8-path mushroom from [SPINNER_INJECTION_NOTES.md](SPINNER_INJECTION_NOTES.md)
section 5: domed red cap, three white spots, a pale face/stem band, two dark eyes, and a
dark outline drawn first (behind). This is the only built-in that does **not** follow the
accent - its colors are baked so it always looks like the canonical mushroom.

Colors: `#E52521` cap, `#FFFFFF` spots, `#FAD9C0` face, `#3A2A1A` outline + eyes.
Build order matters: outline first (behind), then cap, face, spots, eyes on top.

(Full path array: the `mario` entry of `__cdb_builtins` in
`patches/core/add_feature_custom_themes.nim`, identical to the 8-path block in the injection
notes.)

---

### 2. `sweet` - 5-petal blossom (1 path, currentColor, `spin`)

Five rounded petals radiating from the exact center, plus a center disc. Reads as a
cherry-blossom / flower; follows the theme's pink brand accent. Petals are **rooted at
the center point** (each is `M center, cubic out to tip, cubic back to center`) so they
union with the disc with no inner gaps.

- Construction: 5 petals at 72 deg spacing, first pointing up; tip radius 40, petal
  fatness 0.62, center disc radius 16.
- Color: `currentColor` (no `fill`) -> pink `--accent-brand`.

```
M50 50 C74.8 30 50 10 50 10 C50 10 25.2 30 50 50 Z M50 50 C76.68 67.41 88.04 37.64 88.04 37.64 C88.04 37.64 61.36 20.23 50 50 Z M50 50 C41.69 80.76 73.51 82.36 73.51 82.36 C73.51 82.36 81.82 51.6 50 50 Z M50 50 C18.18 51.6 26.49 82.36 26.49 82.36 C26.49 82.36 58.31 80.76 50 50 Z M50 50 C38.64 20.23 11.96 37.64 11.96 37.64 C11.96 37.64 23.32 67.41 50 50 Z M34 50 a 16 16 0 1 0 32 0 a 16 16 0 1 0 -32 0 z
```

---

### 3. `nord` - 6-point snowflake / crystal (1 path, currentColor, `spin`)

Six spokes at 60 deg spacing, each a thin rectangle from a center hub out to a tip, with
two pairs of small V-branches (at radii 20 and 30) - the classic snowflake silhouette.
Follows the theme accent.

- Construction: 6 spokes (length 40, half-thickness 3.2), branch ticks at 60 deg off
  each spoke (length 9), center hub radius 6. All segments are filled quads/triangles
  concatenated into one path (nonzero fill-rule).
- Color: `currentColor` (no `fill`).

The path is long (31 sub-shapes); see the `nord` entry of `__cdb_builtins` in
`patches/core/add_feature_custom_themes.nim` for the literal string. It begins:

```
M50 53.2 L90 53.2 L90 46.8 L50 46.8 Z M67.92 51.2 L72.42 58.99 ...  (31 subpaths) ... M44 50 a 6 6 0 1 0 12 0 a 6 6 0 1 0 -12 0 z
```

---

### 4-6. `catppuccin-mocha` / `-macchiato` / `-frappe` - cat head (1 path, currentColor, `pulse`)

A flat cat-head silhouette: a face circle plus two pointed ear triangles. Follows the
theme accent.

- Construction: face circle radius 27 at `(50,55)`; two ear triangles whose bases sit
  **inside** the dome (outer base low on the flank, inner base near top-center, apex up).
- **Winding gotcha:** the two ears must wind the **same rotational direction as the face
  circle**, or the nonzero fill-rule punches a hole where an ear overlaps the dome (one
  ear comes out clean, the mirror ear shows a white notch). The shipped ears use the
  matching winding. If you edit the ears, re-render and confirm both connect seamlessly.
- Color: `currentColor` (no `fill`).

```
M26 45 L49 34 L19 13 Z M74 45 L81 13 L51 34 Z M23 55 a 27 27 0 1 0 54 0 a 27 27 0 1 0 -54 0 z
```

---

### 7. `catppuccin-latte` - coffee cup (1 path, currentColor, `pulse`)

A mug: trapezoid body (wider at top), a flat saucer beneath, an **open-ring** handle on
the right wall, and two slim S-curve steam wisps rising above. Follows the theme accent.

- Construction: body trapezoid (top y=54 half-width 21, bottom y=84 half-width 16);
  saucer trapezoid; handle = an annulus sector (outer arc R=13 bulging right, inner arc
  R=7 returning) attached to the right wall - the **opposite arc sweep flags** cut the
  hole that makes it read as a handle (not a blob); two steam ribbons (closed thin S
  bands) at x=38 and x=50.
- Color: `currentColor` (no `fill`).

```
M23 54 L65 54 L60 84 L28 84 Z M22 87 L66 87 L61 91 L27 91 Z M65 57 A 13 13 0 1 1 65 81 L65 75 A 7 7 0 1 0 65 63 Z M40 50 C45 44 35 40 42 34 C45 28 37 24 40 18 L36 18 C33 24 41 28 38 34 C31 40 41 44 36 50 Z M52 50 C57 44 47 40 54 34 C57 28 49 24 52 18 L48 18 C45 24 53 28 50 34 C43 40 53 44 48 50 Z
```

---

## The 12 gaming shapes (`js/gaming_themes.json`)

Defined in `js/gaming_themes.json` next to their palettes; each carries
`"category": "gaming"`. (Mario is the 13th entry in **Gaming**, inline built-in.)

| Theme | Shape | Frames | Color | Animation |
|-------|-------|--------|-------|-----------|
| `playstation` | controller glyphs (triangle, circle, cross, square) | 2 | multi-color | `flip` |
| `gameboy` | DMG d-pad with A/B pulse | 2 | multi-color | `flip` |
| `final-fantasy` | faceted crystal pulse | 2 | multi-color | `flip` |
| `zelda` | hero silhouette mid-step, sword raised | 2 | currentColor / accent | `flip` |
| `warcraft` | peon swinging a pick (`#c24b3c` rim >= 3.5:1) | 2 | multi-color | `flip` |
| `dragonball` | 4-star dragon ball: orange sphere, four red stars | 2 | multi-color | `flip` |
| `gta-i` | top-down cruiser / arcade grid badge | 2 | multi-color | `flip` |
| `gta-ii` | cyber-noir `II` respect badge | 2 | multi-color | `flip` |
| `gta-iii` | Liberty City radar pill & `III` bars (sweeping arc) | 2 | multi-color | `flip` |
| `gta-iv` | Rockstar NYC `R*` gold badge (shimmering star) | 2 | multi-color | `flip` |
| `gta-v` | Vinewood banknote `V` crest (3-character ribbon shimmer) | 2 | multi-color | `flip` |
| `gta-vi` | block `VI` logo: violet rim, cream keyline, 6-band sunset gradient (`#545dc9` to `#ffa352`), diagonal sticker gleam in frame 2 | 2 | multi-color | `flip` |

Every `flip` outer rim clears >= 2.6:1 contrast against both its light and dark `--bg-100`
surface so dark-mode sidebars/headers never lose the glyph contour. Every multi-path pair
keeps identical outer-rim geometry across `paths` and `paths2` so the sprite toggles
without edge jitter.

---

## The 15 Linux distro shapes (`js/linux_themes.json`)

Each entry carries `"category": "linux"` and scales the official distribution mark into `viewBox "0 0 100 100"`: monochrome `currentColor` (`pulse`/`spin`) for single-ink logos (`arch-linux`, `ubuntu`, `linux-mint`, `fedora`, `debian`, `opensuse`, `manjaro`, `kali-linux`, `gentoo`, `zorin-os`) and contrast-checked multi-color paths (`>= 2.5:1` on both surfaces) for `cachyos` (`flip`), `nixos` (`spin`), `pop-os` (`flip`), `endeavouros` (`pulse`) and `linux-from-scratch` (`flip` Tux-in-jigsaw).

---

## The 20 bespoke scene shapes (`js/scene_themes.json`)

Each of the 20 upstream-adapted **Scenes** palettes ships its own unique centered
(`viewBox "0 0 100 100"`, bounding-box center within `47..53`) monochrome `currentColor`
spinner matching its landscape (`honu-lagoon` sea turtle, `koi-mosaic` twin koi,
`halftone-dawn` horizon sun, `halftone-dusk` 8-ray sunburst, `plotter-tide` triple wave,
`plotter-tide-night` 3-arm swirl, `dither-dunes` stepped pyramid, `dither-dunes-night`
desert crescent, `paper-garden` origami flower, `paper-garden-kraft` botanical sprig,
`night-reef` coral fan, `snow-pines` hexagonal crystal, `braille-stars` dot cluster,
`teletext-clouds` stepped block cloud, `vector-range` twin peaks, `departure-board`
split-flap tile, `blueprint` drafting reticle, `deep-water` abyssal jellyfish, `aurora`
geomagnetic arcs, `ember` campfire flame).

---

## The 84 community glyphs

Curated in `scripts/community-spinners.json` - one entry per community slug, each with a
`concept` note, an `animation`, and the path data. `scripts/generate-community-themes.mjs`
merges them into `js/community_themes.json` at generation time, so regeneration stays one
command:

```bash
node scripts/generate-community-themes.mjs /path/to/community-palettes
```

The glyphs are derived from each palette's **name or colors**, which is why there are
**53 distinct designs across 84 slugs** - families share a shape on purpose:

| Example | Shape |
|---------|-------|
| `everdeer` | antlered stag head |
| `nord-aurora` | aurora curtain ribbons |
| the `kanagawa-*` family | great-wave curl |
| every `catppuccin-*` accent variant | one curled sleeping cat |
| `zenbones` | zen brush circle (one unbroken ensō stroke) |
| `tokyo-night-moon` | bold crescent moon |

Animation spread: 62 `pulse`, 12 `spin`, 6 `flip`, 4 `bounce`. The six `flip` glyphs are
`cyberpunk` (glitching cyber chevrons), the three gruvbox-family palettes
`gruber-darker` / `gruvbox-material` / `gruvboxalt` (blinking terminal cursor), `mine`
(swinging pickaxe) and `monochrome` (checker-diamond flicker).

The generator hard-fails on: a slug in one file and not the other (checked both
directions), a spec that violates the schema, `d` data that does not tokenize as SVG path
data, or an explicit `fill` under 2.5:1 against either variant's background.

---

## Live switching (no restart)

A theme switch - from the <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> picker, from
Settings -> Extra -> Themes, or reverting to **Claude default** - re-themes the loading
glyph immediately in every open window. Nothing about a theme switch needs a restart any
more.

The engine makes that possible by **never losing the original glyph**:

1. The first time an `<svg>` is reshaped, its untouched children and `viewBox` are
   stashed on the element (`__cdbSpinnerOrig`). The first stash is also kept as a
   document-wide fallback, so a glyph the SPA cloned from one of ours can still be
   restored.
2. Reshaped elements are tracked in a `MANAGED` list, pruned as the SPA detaches them.
3. `window.__cdbSpinnerApply(spec)` re-renders every managed element with the new spec
   and then sweeps the document for glyphs it has not seen yet.
4. `window.__cdbSpinnerApply(null)` restores the stashed markup, drops the
   `cdb-anim-*` class and the `data-cdb-spinner` stamp, and empties the list - which is
   what "Claude default" does.

Two consequences worth knowing:

- **The engine installs once per window.** Re-running `js/spinner_injector.js` with a new
  spec prepended does **not** install a second observer; it only calls `apply()` with the
  new spec. The main process re-runs the file per window on every switch.
- **The MutationObserver always installs the current spec**, not the one baked in at
  injection time, so glyphs rendered after a switch get the new shape.

A malformed spec is **refused** with a `[spinner] refusing spinner spec: ...` line and
the glyph on screen is left as it is - never a half-built SVG.

Hand-editing `claude-desktop-bin.jsonc` still needs a restart, because that file is read
at startup.

---

## How to swap or test a shape live (no rebuild)

The injector is designed for live iteration in the webview DevTools console.

1. Open the claude.ai webview DevTools (right-click -> Inspect on the chat view).
2. Define a spec, then paste the injector body. Pick any shape from the spec sources
   above, e.g. the cat:

   ```js
   window.__CDB_SPINNER_SPEC = {
     viewBox: "0 0 100 100",
     animation: "pulse",
     paths: [{ d: "M26 45 L49 34 L19 13 Z M74 45 L81 13 L51 34 Z M23 55 a 27 27 0 1 0 54 0 a 27 27 0 1 0 -54 0 z" }]
   };
   // then paste the entire contents of js/spinner_injector.js
   ```

3. Expect a console line `[spinner] themed N glyph(s) (0 re-themed, N new)`. The greeting
   icon and the thinking spinner should switch to the new shape; `currentColor` paths
   follow the theme accent.
4. Iterate without re-pasting the file: `window.__cdbSpinnerApply({...next spec...})`
   re-themes in place, and `window.__cdbSpinnerApply(null)` (or
   `window.__cdbSpinner.restore()`) puts Claude's own star back.
5. Re-run a sweep manually: `window.__cdbSpinner.sweep(document.documentElement)`.
   Count what the engine owns: `window.__cdbSpinner.managed()`. Stop the observer:
   `window.__cdbSpinner.disconnect()`. Inspect the active spec:
   `window.__cdbSpinner.spec`.

Note that the CSS keyframes come from the theme sheet, not the injector, so a bare
console paste on an unthemed page renders the shape without its motion. Apply a theme
first if you want to judge the animation.

### Authoring / verifying a new shape offline

Shapes are authored as literal path strings and checked at 256px (inspect) and 32px (real
spinner size) with `rsvg-convert`, then pasted into the spec source for their tier. A
quick contact sheet at spinner size is the fastest way to catch a shape that only reads
when large:

```bash
magick shape_*_32.png +append -filter point -resize 400% sheet.png
```

The engine's own behavior is covered by three suites that `scripts/validate-patches.sh`
runs:

```bash
node scripts/tests/core/test-spinner-main.mjs        # main process: what a switch PUSHES to each window
node scripts/tests/core/test-spinner-dom.mjs         # headless Chromium: re-theme, revert, flip frames
node scripts/tests/community/test-picker-gaming.mjs  # picker sections incl. Gaming
```

`test-spinner-dom.mjs` is the one that settles the questions a regex cannot: that a
second spec really reshapes a glyph the engine already swapped, that reverting restores
markup the matcher can find the star in again, and that the `flip` frames resolve against
the `steps()` keyframes the theme sheet ships.

---

## Maintenance notes (version-sensitive)

- **`themed 0` in the console = the logo geometry drifted**, not "feature removed". The
  star signatures are remote-rendered claude.ai geometry this repo cannot pin. The
  matcher carries three fragments of different rays so a single re-emitted coordinate run
  does not break it, and a per-theme `match` (string or array) overrides the set entirely
  without a rebuild.
- **Don't switch the injector to `innerHTML`** - it uses `createElementNS` deliberately
  (CSP / Trusted-Types safe for SVG).
- **Editing the cat ears or any union-of-subpaths shape:** re-render and confirm winding;
  a mismatched sub-path winding silently punches a hole under nonzero fill-rule.
- **Two shapes are multi-color** (`mario`, `dragonball`). Keep every other shape
  single-color `currentColor` so it tracks the theme accent.
- **Adding a `flip` shape:** author `paths2` in the same commit. The build asserts the
  pairing, so a missing second frame fails the build rather than shipping a static glyph
  with a flicker class.

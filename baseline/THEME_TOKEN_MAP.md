# THEME_TOKEN_MAP.md - Claude Desktop Theming Token Reference

> **Source:** Live theme extract from claude.ai running inside Claude Desktop
> **v1.15962.0** (Electron 42). File:
> `claude-theme-extract-2026-06-26T11-07-13-644Z.json` (~675 KB).
> Captured **2026-06-26** at `https://claude.ai/epitaxy/session_...`, 17 stylesheets, 65 scans.
> **The app was in DARK mode when captured**, so `resolvedTokensBySurface` values are the *resolved DARK* values.
> `declaredTokensBySelector` (1563 entries) contains BOTH light and dark *authored* declarations.
> **Section 7** was added against **v1.49585.0** (2026-09-09) from the offline CDS sheet
> `MainWindowPage-*.css` in the app bundle plus a light-mode DevTools capture of `.cds-root`.

This doc is **version-sensitive**. Token *names* are stable across releases (they are public design-system contracts, not minified), but the **selector architecture** and **primitive layer** (`--_gray-*`, `--cds-*`) can change. Re-validate against a fresh extract on each upstream bump.

---

## 0. TL;DR / How the cascade actually works (READ THIS FIRST)

There is **not one** theme system. The extract reveals **four coexisting layers**, and a themer must understand which one is authoritative:

| Layer | Selector root | Token prefix | Purpose | Dark source |
|-------|--------------|--------------|---------|-------------|
| **v1 Claude theme** (legacy) | `[data-theme="claude"][data-mode="dark"]` | `--bg-*`, `--text-*`, `--accent-*`, … | Original semantic tokens, **literal HSL values** | hardcoded HSL |
| **v2 Claude theme** (current) | `[data-color-version="v2"][data-theme="claude"][data-mode="dark"]` | same `--bg-*` etc. | Same semantic names, but **remapped to `--_gray-*` / `--_brand-*` / `--_blue-*` primitives** | `var(--_gray-750)` etc. |
| **CDS** (Console Design System) | `.cds-root` | `--cds-*` (`--cds-surface-*`, `--cds-gray-*`, `--cds-clay`, …) | Hex-based palette used by newer surfaces/popovers | hex |
| **DF** (Desktop Frame / dframe) | `.dframe-root`, `.epitaxy-root` | `--df-*`, `--df-sidebar-bg`, `--df-z0..z6` | The desktop window chrome: sidebar, content panes | `--df-z*` HSL ramp |

**Key consequence for the patch:** semantic tokens like `--bg-000` exist in *both* v1 (literal HSL) and v2 (`var(--_gray-750)`). Overriding `--bg-000` directly works for both **only if** you set a literal value (it wins over the `var()` indirection). The `.dframe-sidebar` / `.dframe-content` / `main` backgrounds do **NOT** read `--bg-*` at all — they read `--df-z2` / `--df-surface-primary` (see Section 4). That is why the patch must override them explicitly.

**Resolution check (dark):** in `:root` resolved, `--bg-000 = 60 2% 17%`, `--bg-300 = 0 0% 7%`, `--bg-400 = 0 0% 4%`. The dframe page resolves to `--df-bg-page = hsl(60 2% 12%)` and the sidebar to `hsl(0 0% 14.9%)` — i.e. **the sidebar is on a different ramp (`0 0%`) than the bg tokens (`60 2%`)**.

---

## 1. Core themeable token families

Presence below = appears as a key in `declaredTokensBySelector` (authored in a stylesheet). All core semantic families ARE declared (in the `[data-theme="claude"]…` selectors).

| Family | Members found | Declared? | Notes |
|--------|--------------|-----------|-------|
| `--bg-{000..500}` | 000,100,200,300,400,500 | YES | 000=lightest surface (light) / page-ish, 500=darkest. 400==500. |
| `--text-{000..500}` | 000,100,200,300,400,500 | YES | 000==100 (primary), 200==300 (secondary), 400==500 (muted). |
| `--accent-brand` | yes | YES | Clay. Identical light & dark: `15 63.1% 59.6%`. |
| `--accent-{000,100,200,900}` | 000,100,200,900 | YES | Blue accent ramp. 100==200. |
| `--accent-pro-{000,100,200,900}` | 000,100,200,900 | YES | Violet (Pro/Max). 100==200. |
| `--accent-secondary-*` | **NONE** | n/a | **Does not exist in v1.15962.** Do not theme. |
| `--accent-main-*` | **NONE** | n/a | **Does not exist in v1.15962.** Do not theme. |
| `--brand-{000,100,200,900}` | 000,100,200,900 | YES | Clay ramp. 900 = `--always-black` (`0 0% 0%`). |
| `--border-{100..400}` | 100,200,300,400 | YES | All four are the SAME value within a mode. See gotcha §1a. |
| `--danger-{000,100,200,900}` | 000,100,200,900 | YES | Red. 100==200. |
| `--warning-{000,100,200,900}` | 000,100,200,900 | YES | Amber/yellow. 100==200. |
| `--success-{000,100,200,900}` | 000,100,200,900 | YES | Green. 100==200. |
| `--oncolor-{100,200,300}` | 100,200,300 | YES | Text-on-colored-fill. 200==300. Identical light & dark. |
| `--pictogram-{100..400}` | 100,200,300,400 | YES | Icon/illustration fills. |
| `--clay --kraft --book-cloth --manilla --white --black` | **NONE as plain names** | n/a | **Not present as `--clay` etc.** The clay color lives as `--_brand-clay` (primitive) and `--cds-clay` (hex). kraft/book-cloth/manilla are absent entirely. |

Also present (adjacent, useful): `--accent-hover`, `--accent-10`, `--accent-20`, `--accent-20-brightness`, `--always-black` (`0 0% 0%`), `--always-white` (`0 0% 100%`).

### 1a. Gotcha: dark-mode borders are authored as a LIGHT color

In the **dark** declaration, `--border-100..400 = 51 16.5% 84.5%` — that is a *near-white* HSL. Borders get their subtlety from low alpha applied at use-site (e.g. CDS `--cds-border = hsl(from #fff h s l / 10%)`), NOT from a dark base color. A theme that sets `--border-*` to a dark HSL will produce **invisible borders** in dark mode. Harmonize borders by matching the *opacity-applied* look, not the raw token.

---

## 2. STOCK LIGHT vs STOCK DARK values (GROUND TRUTH)

Values are HSL triplets `H S% L%` exactly as authored by claude.ai.

- **Light** = `[data-theme="claude"], [data-theme="claude"][data-mode="light"]`
- **Dark** = `[data-theme="claude"][data-mode="dark"]`

(These are the **v1 literal-HSL** declarations — the canonical ground truth. The v2 `--_gray-*` remaps in §2a resolve to the same colors.)

### Backgrounds
| Token | Stock LIGHT | Stock DARK |
|-------|-------------|------------|
| `--bg-000` | `0 0% 100%` | `60 2.1% 18.4%` |
| `--bg-100` | `48 33.3% 97.1%` | `60 2.7% 14.5%` |
| `--bg-200` | `53 28.6% 94.5%` | `30 3.3% 11.8%` |
| `--bg-300` | `48 25% 92.2%` | `60 2.6% 7.6%` |
| `--bg-400` | `50 20.7% 88.6%` | `0 0% 0%` |
| `--bg-500` | `50 20.7% 88.6%` | `0 0% 0%` |

### Text
| Token | Stock LIGHT | Stock DARK |
|-------|-------------|------------|
| `--text-000` | `60 2.6% 7.6%` | `48 33.3% 97.1%` |
| `--text-100` | `60 2.6% 7.6%` | `48 33.3% 97.1%` |
| `--text-200` | `60 2.5% 23.3%` | `50 9% 73.7%` |
| `--text-300` | `60 2.5% 23.3%` | `50 9% 73.7%` |
| `--text-400` | `51 3.1% 43.7%` | `48 4.8% 59.2%` |
| `--text-500` | `51 3.1% 43.7%` | `48 4.8% 59.2%` |

### Accent (blue) + brand (clay) + pro (violet)
| Token | Stock LIGHT | Stock DARK |
|-------|-------------|------------|
| `--accent-brand` | `15 63.1% 59.6%` | `15 63.1% 59.6%` |
| `--accent-000` | `210 73.7% 40.2%` | `210 65.5% 67.1%` |
| `--accent-100` | `210 70.9% 51.6%` | `210 70.9% 51.6%` |
| `--accent-200` | `210 70.9% 51.6%` | `210 70.9% 51.6%` |
| `--accent-900` | `211 72% 90%` | `210 55.9% 24.6%` |
| `--accent-pro-000` | `251 34.2% 33.3%` | `251 84.6% 74.5%` |
| `--accent-pro-100` | `251 40% 45.1%` | `251 40.2% 54.1%` |
| `--accent-pro-200` | `251 61% 72.2%` | `251 40% 45.1%` |
| `--accent-pro-900` | `253 33.3% 91.8%` | `250 25.3% 19.4%` |
| `--brand-000` | `15 54.2% 51.2%` | `15 54.2% 51.2%` |
| `--brand-100` | `15 54.2% 51.2%` | `15 63.1% 59.6%` |
| `--brand-200` | `15 63.1% 59.6%` | `15 63.1% 59.6%` |
| `--brand-900` | `0 0% 0%` | `0 0% 0%` |

### Borders (see §1a — dark borders are a light color + use-site alpha)
| Token | Stock LIGHT | Stock DARK |
|-------|-------------|------------|
| `--border-100` | `30 3.3% 11.8%` | `51 16.5% 84.5%` |
| `--border-200` | `30 3.3% 11.8%` | `51 16.5% 84.5%` |
| `--border-300` | `30 3.3% 11.8%` | `51 16.5% 84.5%` |
| `--border-400` | `30 3.3% 11.8%` | `51 16.5% 84.5%` |

### Status colors
| Token | Stock LIGHT | Stock DARK |
|-------|-------------|------------|
| `--danger-000` | `0 58.6% 34.1%` | `0 98.4% 75.1%` |
| `--danger-100` | `0 56.2% 45.4%` | `0 67% 59.6%` |
| `--danger-200` | `0 56.2% 45.4%` | `0 67% 59.6%` |
| `--danger-900` | `0 50% 95%` | `0 46.5% 27.8%` |
| `--warning-000` | `45 91.8% 19%` | `40 71% 50%` |
| `--warning-100` | `39 88.8% 28%` | `39 93.4% 35.9%` |
| `--warning-200` | `39 88.8% 28%` | `39 93.4% 35.9%` |
| `--warning-900` | `38 65.9% 92%` | `45 94.8% 15.1%` |
| `--success-000` | `125 100% 18%` | `97 59.1% 46.1%` |
| `--success-100` | `103 72.3% 26.9%` | `97 75% 32.9%` |
| `--success-200` | `103 72.3% 26.9%` | `97 75% 32.9%` |
| `--success-900` | `86 45.1% 90%` | `127 100% 13.9%` |

### On-color (text/icons on filled buttons) + pictograms
| Token | Stock LIGHT | Stock DARK |
|-------|-------------|------------|
| `--oncolor-100` | `0 0% 100%` | `0 0% 100%` |
| `--oncolor-200` | `60 6.7% 97.1%` | `60 6.7% 97.1%` |
| `--oncolor-300` | `60 6.7% 97.1%` | `60 6.7% 97.1%` |
| `--pictogram-100` | `50 20.7% 88.6%` | `48 3.4% 29.2%` |
| `--pictogram-200` | `51 16.5% 84.5%` | `60 2.5% 23.3%` |
| `--pictogram-300` | `0 0% 100%` | `60 2.1% 18.4%` |
| `--pictogram-400` | `48 33.3% 97.1%` | `60 2.7% 14.5%` |

### 2a. The v2 primitive layer (`--_gray-*` / `--_brand-*`)

The **current** color version (`[data-color-version="v2"]`) does NOT inline HSL — it points the semantic tokens at primitives. This is the layer a robust theme should consider, because if v2 is active the `var()` indirection is what's live.

**v2 DARK semantic → primitive mapping:**
| Semantic | → primitive | Semantic | → primitive |
|----------|------------|----------|------------|
| `--bg-000` | `--_gray-750` | `--text-000/100` | `--_gray-20` |
| `--bg-100` | `--_gray-800` | `--text-200/300` | `--_gray-200` |
| `--bg-200` | `--_gray-840` | `--text-400/500` | `--_gray-350` |
| `--bg-300` | `--_gray-860` | `--border-100..400` | `--_gray-100` |
| `--bg-400/500` | `--_gray-900` | `--accent-brand` | `--_brand-clay` |
| `--accent-000` | `--_blue-200` | `--accent-100/200` | `--_blue-350` |
| `--accent-900` | `--_blue-750` | `--danger-100/200` | `--_red-400` |
| `--success-100/200` | `--_green-400` | `--warning-100/200` | `--_yellow-400` |
| `--accent-pro-*` | `--_violet-*` | `--brand-900` | `--always-black` |
| `--pictogram-100` | `--_gray-650` | `--pictogram-400` | `--_gray-800` |

**v2 LIGHT** mirrors it: `--bg-000 → --_gray-0`, `--bg-100 → --_gray-20`, `--text-000 → --_gray-860`, `--border-* → --_gray-810`, `--accent-100/200 → --_blue-500`, etc.

**`--_gray-*` primitive palette (authored HSL, mode-independent):**
| Primitive | HSL | Primitive | HSL |
|-----------|-----|-----------|-----|
| `--_gray-0` | `0 0% 100%` | `--_gray-700` | `60 3% 21%` |
| `--_gray-10` | `60 14% 99%` | `--_gray-750` | `60 2% 17%` |
| `--_gray-20` | `60 14% 97%` | `--_gray-800` | `60 2% 12%` |
| `--_gray-50` | `45 12% 93%` | `--_gray-810` | `60 2% 12%` |
| `--_gray-100` | `53 12% 87%` | `--_gray-840` | `60 2% 9%` |
| `--_gray-200` | `55 9% 74%` | `--_gray-850` | `0 0% 8%` |
| `--_gray-350` | `48 5% 57%` | `--_gray-860` | `0 0% 7%` |
| `--_gray-450` | `43 3% 47%` | `--_gray-880` | `0 0% 6%` |
| `--_gray-650` | `40 2% 26%` | `--_gray-900` | `0 0% 4%` |

**Brand primitives:** `--_brand-clay = 14.8 63.1% 59.6%`, `--_brand-clay-emphasized = 15.1 54.2% 51.2%`.

> Note: `--_blue-*`, `--_violet-*`, `--_red-*`, `--_green-*`, `--_yellow-*` primitives are *referenced* by the v2 mappings. They were not captured as resolved HSL in this extract surface (only the gray/brand ramps were), so if you need their exact HSL, resolve them from a future capture or compute from the v1 literal values above (the v1 dark literals == the resolved v2 values, by construction).

---

## 3. Surface-layer mapping (CDS + semantic surface tokens)

Resolved DARK values, captured from `.cds-root` and `.epitaxy-root`. "Nearest bg" matches the resolved hex to the closest `--bg-*` dark level.

### CDS hex surfaces (`.cds-root`, `.epitaxy-root` — identical)
| Token | Resolved DARK (hex) | Authored DARK source | Nearest `--bg-*` (dark) |
|-------|--------------------|--------------------|------------------------|
| `--cds-page-bg` | `#0d0d0d` | `--cds-gray-890` | ~`--bg-400` (`0 0% 4%` = #0a0a0a) / `--bg-300` (#121211) |
| `--cds-surface-0` | `#0d0d0d` | `--cds-gray-890` | ~`--bg-400`/`--bg-300` |
| `--cds-surface-1` | `#1a1a19` | `--cds-gray-830` | ~`--bg-200` (`30 3.3% 11.8%` ≈ #1f1d1d) |
| `--cds-surface-2` | `#2c2c2a` | `--cds-gray-750` | ~`--bg-000` (`60 2.1% 18.4%` ≈ #302f2e) |
| `--cds-surface-3` | `#383835` | `--cds-gray-700` | between `--bg-000` and lighter |
| `--cds-surface-panel` | `#2c2c2a` | = surface-2 | ~`--bg-000` |
| `--cds-surface-popover` | `#383835` | = surface-3 | slightly above `--bg-000` |

> **CDS surface ladder (dark):** page/0 `#0d0d0d` → 1 `#1a1a19` → 2/panel `#2c2c2a` → 3/popover `#383835`. This is a **near-neutral gray ramp** (`--cds-gray-*`), subtly warmer than pure gray. A theme that wants surfaces to harmonize should map: page→darkest, cards/panels→mid, popovers/menus→lightest.

### Semantic surface tokens (`.epitaxy-root` resolved, DARK)
| Token | Resolved DARK | Nearest `--bg-*` |
|-------|--------------|------------------|
| `--surface-primary` | `hsl(0 0% 4%)` | == `--bg-400`/`--bg-500` |
| `--surface-primary-elevated` | `#141414e6` (≈ `0 0% 8%` @ 90%) | ~`--bg-300`..`--bg-200` |
| `--surface-panel` | `hsl(60 2% 17%)` | == `--bg-000` |
| `--surface-panel-elevated` | `hsl(60 3% 21%)` | one step above `--bg-000` (= `--_gray-700`) |
| `--surface-popover` | `hsl(60 2% 17%)` | == `--bg-000` |
| `--surface-hud` | `hsl(from hsl(0 0% 4%) h s l / 95%)` | == `--bg-400` @ 95% |
| `--surface-toast` | `hsl(40 2% 26%)` | above `--bg-000` (= `--_gray-650`) |
| `--surface-prompt-blur` | `#1f1f1f` | ~`--bg-200`/`--bg-100` |
| `--surface-prompt-focus-hover` | `#202020` | ~`--bg-100` |

> **Mapping insight for the patch:** `--surface-primary` (the main content backdrop) resolves to `--bg-400` (`0 0% 4%`), the DARKEST level — NOT `--bg-000`. Panels/popovers sit at `--bg-000` (`60 2% 17%`). So the visual hierarchy is *content area darker than the panels floating on it*. If the patch's element-overrides force surfaces to a single bg level, they flatten this hierarchy. The correct mapping is: **main/content backdrop → `--bg-400`; panels/popovers/cards → `--bg-000`; elevated → between.**

---

## 4. `.dframe-sidebar` / `.dframe-content` / `main` resolved backgrounds

These are the **desktop window chrome** surfaces the patch overrides explicitly. Critically, **they do NOT read `--bg-*`.** They use the `--df-*` (Desktop Frame) layer.

**The `--df-z*` ramp (resolved DARK, neutral `0 0%` grays):**
| Token | Resolved DARK | Used for |
|-------|--------------|----------|
| `--df-z0` | `0 0% 3.9%` | base |
| `--df-z1` | `0 0% 10.2%` | content pane (`--df-surface-primary` in content/main) |
| `--df-z2` | `0 0% 14.9%` | **sidebar** (`--df-surface-primary` in sidebar) |
| `--df-z3` | `0 0% 20%` | |
| `--df-z4` | `0 0% 23.9%` | |
| `--df-z5` | `0 0% 32.2%` | |
| `--df-z6` | `0 0% 65.1%` | |

**Actual resolved backgrounds (DARK):**
| Surface | `--df-surface-primary` | `--df-sidebar-bg` | `--df-bg-page` |
|---------|----------------------|-------------------|----------------|
| `.dframe-sidebar` | `0 0% 14.9%` (= `--df-z2`) | `hsl(0 0% 14.9%)` | `hsl(60 2% 12%)` |
| `.dframe-content` | `0 0% 10.2%` (= `--df-z1`) | `hsl(0 0% 14.9%)` | `hsl(60 2% 12%)` |
| `main` | `0 0% 10.2%` (= `--df-z1`) | `hsl(0 0% 14.9%)` | `hsl(60 2% 12%)` |

**Authored sources for `--df-sidebar-bg`** (note the multiple competing selectors — this is why the patch must be specific):
| Selector | Value |
|----------|-------|
| `.dframe-root` (light) | `hsl(var(--_gray-10) / 1)` |
| `[data-mode="dark"] .dframe-root` | `hsla(0, 0%, 7.8%, .9)` |
| `[data-mode="dark"] .dframe-root .dframe-sidebar, … .dframe-card` | `hsl(var(--df-z2))` ← **wins for sidebar** |
| `[data-mode="dark"] .epitaxy-root .dframe-root` | `hsl(var(--df-z2))` |
| `[data-mode="dark"][data-darker] .epitaxy-root .dframe-sidebar` | `hsl(var(--_gray-860) / .95)` (`#131313` @ 95% — "darker" preference) |

**Conclusions for the patch:**
1. **`.dframe-sidebar` / `.dframe-content` / `main` use HARDCODED `--df-z*` HSL values, NOT `--bg-*`.** Overriding `--bg-000` etc. will NOT recolor the sidebar/content. The patch is correct to target them explicitly.
2. The DF ramp is a **pure neutral gray** (`0 0%`), while `--bg-*` is **warm gray** (`60 2%`). Mixing them produces a visible hue mismatch (sidebar grayer than content/cards). A theme should override `--df-z1`/`--df-z2` (or `--df-surface-primary` / `--df-sidebar-bg`) directly to match its `--bg-*` hue.
3. There is a **`[data-darker]`** dark sub-variant that pushes the sidebar to `--_gray-860` (`#131313`). If the user has "darker" enabled, the `--df-z2` override is bypassed — handle both selectors.
4. `--df-hover = hsl(from #fff h s l / 5%)` and `--df-selected = hsl(from #fff h s l / 10%)` — hover/selected states are white-alpha overlays, mode-independent in source.

---

## 5. Prose / markdown tokens (`--tw-prose-*`)

**NONE FOUND.** Neither `declaredTokensBySelector` nor `resolvedTokensBySurface` contains any `--tw-prose-*` token in this v1.15962 extract.

Interpretation: claude.ai's chat/markdown rendering in this build does **not** use Tailwind Typography's `prose` plugin variables. Markdown text color comes from the semantic `--text-*` tokens (and CDS `--cds-text-*`, see §6) applied via normal utility classes, not a `prose` token island. **A theme does not need to (and cannot) override `--tw-prose-*`.** Markdown legibility is governed by `--text-100/200/300` and `--cds-text-primary/secondary/muted`.

(Tailwind v4 *other* `--tw-*` engine vars ARE present in bulk — `--tw-shadow` ×306, `--tw-gradient-stops` ×108, `--tw-ring-color`, `--tw-leading`, etc. — but these are layout/effect plumbing, not themeable colors.)

---

## 6. Surprises / new or non-enumerated token families (v1.15962)

Families present in `declaredTokensBySelector` that were **not** in the original enumeration. Counts are # of declaring selectors.

### a. `--cds-*` — Console Design System (LARGE, important)
A full parallel design system, **hex-based**, keyed off `.cds-root`. This is new/expanded surface infrastructure beyond the `--bg/--text` semantics.
- **Grays:** `--cds-gray-{0,10,20,…,900}` + fine steps (`810,820,830,840,850,860,870,880,890`) — 41-stop neutral ramp. Dark: `#fff … #0b0b0b`.
- **Neutrals:** `--cds-neutral-{0,10,100,150,200,…}` (e.g. `--cds-neutral-0 = #0b0b0b`, `--cds-neutral-10 = #0d0d0d`).
- **Brand:** `--cds-clay = #d97757`, `--cds-clay-emphasized = #c6613f`.
- **Surfaces:** `--cds-surface-{0,1,2,3,panel,popover}` (see §3), `--cds-page-bg`.
- **Semantic text/border:** `--cds-text-{primary,secondary,muted,disabled,accent,danger,pro,success,warning}`, `--cds-border`, `--cds-border-{strong,stronger,accent,danger,pro,success,warning}`. Resolved dark examples: `--cds-text-primary = #fff`, `--cds-text-secondary = #c3c2b7`, `--cds-text-muted = #898781`, `--cds-text-disabled = hsl(from #fff h s l / 35%)`, `--cds-border = hsl(from #fff h s l / 10%)`.
- **Named hues:** `--cds-blue/aqua/green/magenta/orange/red/violet/yellow-*` (35 selectors each).
- **Git status colors:** `--cds-text-git-{added,closed,conflicting,draft,merged,modified,opened,queued,removed}` + matching `--cds-border-git-*` (e.g. added `#32d74b`, removed `#ff2c56`, modified `#ffd014`). Used in the Cowork/code git UI.
- **Layout/metric tokens:** `--cds-radius-*`, `--cds-pad-{sm,md,lg,xl}`, `--cds-icon`, `--cds-h-control`, `--cds-checkbox-*`, `--cds-switch-h`, `--cds-popup-max-h`, `--cds-font-size-{body,caption}`, `--cds-alpha-*`.

> **Theming implication:** newer surfaces (popovers, the Cowork/code frame) read `--cds-*`, not `--bg-*`. A complete theme must address BOTH the `--bg/--text` semantics AND the `--cds-surface-*` / `--cds-text-*` / `--cds-border` set, or new UI stays stock.

### b. `--df-*` — Desktop Frame (see §4)
`--df-z0..z6`, `--df-surface-primary`, `--df-sidebar-bg`, `--df-bg-page(-hsl)`, `--df-shadow-{card,float,pop}`, `--df-hover`, `--df-selected`, plus metrics (`--df-sidebar-width=288px`, `--df-header-h=48px`, `--df-row-h=26px`, easing curves). **The window chrome lives here.**

### c. `--_*` private primitives
`--_gray-*` (§2a), `--_brand-clay(-emphasized)`, and referenced `--_blue/_violet/_red/_green/_yellow-*`. The leading underscore marks them private/internal — the v2 color system's foundation.

### d. `--extended-*` accent palette
`--extended-{green,orange,pink,purple,yellow}` (hex, e.g. green `#32d74b`, pink `#ff2c56`) plus `--extended-{10,20}-<hue>` alpha variants. A secondary categorical color set (labels/tags).

### e. `--color-*` (Tailwind v4 named colors)
`--color-{green,blue,yellow,violet,orange}` (7-9 selectors each) — Tailwind v4 `@theme` color exports.

### f. `--ui-*` and `--button-*` component tokens
- `--ui-slider-background = hsl(60 2% 10%)`, `--ui-switch-off-background = hsl(0 0% 100% / .12)`, `--ui-switch-on-background = #142633`, `--ui-user-message-background = hsl(0 0% 100% / .08)`.
- `--button-bg`, `--button-text`, `--button-hover-bg`, `--button-hover-text`, `--button-loading-color` (13-19 selectors) — per-variant button theming hooks.

### g. Misc effect tokens
`--*-background-blur` family (`--hud-background-blur`, `--primary-elevated-background-blur=24px`, `--prompt-blur-background-blur=100px`, `--stroke-shadow-background-blur=20px`), `--font-opsz`, `--font-weight-*`.

---

## 7. CDS layer remap (v1.49585.0)

claude.ai now paints the mode pills, chips, filled buttons and the sidebar row states from the
`--cds-*` design-system ramp (`.dframe-root[data-variant=web] .df-pills[data-segmented]{background:var(--cds-neutral-60)}`,
`hover:bg-[var(--df-hover)]`, `data-[selected=focused]:bg-[var(--df-selected)]`). The theme engine
(`__cdb_buildCss` in `patches/core/add_feature_custom_themes.nim`) remaps the tokens below; every
declaration is `!important` on `:root,.cds-root,.epitaxy-root,[data-mode=dark],[data-mode=light]`
(shared) or on the per-mode selector groups (page side of the neutral ramp).

**Two facts the mapping rests on - re-check both on every bump:**

1. **Dark mode inverts `--cds-neutral-*`.** Light: `--cds-neutral-0:var(--cds-gray-0)` ... `-900:var(--cds-gray-900)`.
   Dark (`[data-mode=dark] .cds-root:not(...)`): `--cds-neutral-0:var(--cds-gray-900)` ... `-900:var(--cds-gray-0)`.
   So `neutral-N` means "N/900 of the way from the page toward the text" in BOTH modes. Our `--bg-*`
   is lightest-first in both modes (bg-000 = the elevated panel even in dark), so the page side of
   the ramp (0..400) is emitted per mode and the text side (450..900) once, onto `--text-*`.
2. **The alphas derive from `--cds-neutral-900`:** `--cds-alpha-1: hsl(from var(--cds-neutral-900) h s l / 5%)`
   (0..9 = 0/5/10/20/35/50/60/70/85/95%), declared once on `.cds-root`. `--cds-border` (alpha-2),
   `--cds-border-strong` (alpha-3), `--cds-border-stronger`, `--cds-fill-ghost-*`, `--cds-fill-control*`,
   `--cds-fill-disabled`, `--cds-bg-neutral*`, `--cds-bg-user-message`, `--cds-skeleton-*`,
   `--cds-slider-track/-fill`, `--cds-switch-track*`, `--cds-text-disabled`, plus `--cds-tooltip-bg/fg`
   (neutral-900/0 light, surface-3/text-primary dark) and `--cds-segmented-control-thumb/track`
   (surface-popover/alpha-1 light, alpha-2/alpha-1 dark) are all `var()` chains onto tokens we
   remap, resolved on the same element - they follow and are NOT overridden.

### 7a. Neutral ramp, page side (per mode)

| Token | Stock light | Stock dark | Ours light | Ours dark |
|---|---|---|---|---|
| `--cds-neutral-0` | gray-0 `#fff` | gray-900 `#0b0b0b` | `hsl(var(--bg-000))` | `hsl(var(--bg-300))` |
| `--cds-neutral-10` | gray-10 | gray-890 (= page) | `bg-100` | `bg-200` |
| `--cds-neutral-20` | gray-20 (= page) | gray-880 | `bg-200` | `bg-200` |
| `--cds-neutral-30`, `-40` | gray-30/40 | gray-870/860 | `bg-300` | `bg-100` |
| `--cds-neutral-50`, `-60` (pills track), `-70` | gray-50/60/70 | gray-850/840/830 | `bg-400` | `bg-100` |
| `--cds-neutral-80`, `-90`, `-100` | gray-80/90/100 | gray-820/810/800 | `bg-500` | `bg-000` |
| `--cds-neutral-150/200/250/300/350/400` | 81/74/68/63/57/53% L | 17/22/27/32/37/42% L | `color-mix(in srgb, hsl(var(--bg-500)) 85/70/55/40/25/12%, hsl(var(--text-500)))` | same with `--bg-000` as anchor |
| `--cds-fill-field` | `#ffffff80` | alpha-1 | `hsl(var(--bg-000) / 0.5)` | `var(--cds-alpha-1)` |
| `--cds-fill-secondary` | `#ffffff1a` | alpha-2 | `hsl(var(--bg-000) / 0.1)` | `var(--cds-alpha-2)` |

The dark ladder keeps stock's relation to the surfaces already remapped in section 3: page-bg ->
bg-200, surface-1/2 -> bg-100, surface-3/popover -> bg-000; neutral-0 dips below the page. The
mix percentages were fitted on stock light (bg-500 88.6% L, text-500 43.7%) and reproduce every
stop within ~2 lightness points.

### 7b. Neutral ramp, text side (shared)

| Token | Ours |
|---|---|
| `--cds-neutral-450`, `-500` | `hsl(var(--text-500))` |
| `--cds-neutral-550/600/650` | `color-mix(in srgb, hsl(var(--text-500)) 65/40/20%, hsl(var(--text-300)))` |
| `--cds-neutral-700` | `hsl(var(--text-300))` |
| `--cds-neutral-750/800` | `color-mix(in srgb, hsl(var(--text-300)) 60/30%, hsl(var(--text-000)))` |
| `--cds-neutral-900` | `hsl(var(--text-000))` |
| `--cds-neutral-810..890` | left stock (unreferenced outside the dark surface aliases we already override) |

### 7c. Semantic tokens (shared; our accent and status ramps are mode-correct)

| CDS token | Stock light | Stock dark | Ours |
|---|---|---|---|
| `--cds-page-bg`, `--cds-surface-*`, `--cds-text-primary/secondary/muted`, `--cds-border`, `--cds-clay` | | | unchanged from section 3 |
| `--cds-clay-emphasized`, `--cds-fill-brand` | `#c6613f` | same | `hsl(var(--brand-000))` (stock brand-000 = `15 54.2% 51.2%` = `#c6613f`) |
| `--cds-fill-brand-hover` | clay | same | `hsl(var(--accent-brand))` |
| `--cds-fill-primary` / `-hover` | neutral-900 / -750 | gray-0 / gray-100 | `text-000` / `text-200` |
| `--cds-on-primary` | neutral-0 | neutral-0 | `hsl(var(--bg-000))` |
| `--cds-fill-accent` / `-hover` | blue-450 / -400 | same | `accent-100` / `color-mix(in srgb, hsl(var(--accent-100)) 85%, hsl(var(--text-000)))` (hover steps toward the text, mode-correct) |
| `--cds-text-accent` | blue-600 | blue-300 | `accent-000` (light 40% / dark 67% L - same polarity as stock) |
| `--cds-bg-accent` (`-chip`, `-muted` follow) | blue-100 | blue-800 | `accent-900` |
| `--cds-border-accent` | blue-250 | blue-700 | `hsl(var(--accent-100) / 0.5)` |
| `--cds-radio-group-card-selected` | blue-50 | blue-850 | `accent-900` |
| `--cds-fill-pro` / `-hover`, `--cds-text-pro`, `--cds-bg-pro`, `--cds-border-pro` | violet-450/-400, -600, -100, -250 | same, -300, -800, -700 | `accent-pro-100` / mix 85% toward text-000, `accent-pro-000`, `accent-pro-900`, `hsl(var(--accent-pro-100) / 0.5)` |
| `--cds-fill-danger` / `-hover`, `--cds-text-danger`, `--cds-bg-danger`, `--cds-border-danger` | red-450/-400, -600, -100, -250 | same, -300, -800, -700 | `danger-100` / mix 85% toward text-000, `danger-000`, `danger-900`, `hsl(var(--danger-100) / 0.5)` |
| `--cds-fill-success` / `-hover`, `--cds-text-success`, `--cds-bg-success`, `--cds-border-success` | green-450/-400, -600, -100, -250 | same, -400, -800, -700 | `success-100` / mix 85% toward text-000, `success-000`, `success-900`, `hsl(var(--success-100) / 0.5)` |
| `--cds-text-warning`, `--cds-bg-warning`, `--cds-border-warning` | yellow-600, -100, -250 | yellow-300, -800, -700 | `warning-000`, `warning-900`, `hsl(var(--warning-100) / 0.5)` |
| `--cds-on-accent/-brand/-danger/-pro` | gray-0 | gray-0 | `hsl(var(--oncolor-100))` |
| `--cds-on-success` | gray-900 (dark text on bright green) | gray-900 | `hsl(var(--oncolor-100))` - our `--success-100` is a dark green (26.9% L light), black on it fails |

### 7d. Desktop frame (`.dframe-root`)

| Token | Stock (dark capture) | Ours |
|---|---|---|
| `--df-hover` | `hsl(from #fff h s l / 5%)` | `hsl(var(--text-000) / 0.06)` |
| `--df-selected` | `hsl(from #fff h s l / 10%)` | `hsl(var(--text-000) / 0.12)` |
| `--df-z1/z2`, `--df-sidebar-bg`, `--df-surface-primary`, `--df-bg-page(-hsl)` | | unchanged (section 4) |
| `--df-row-h`, `--df-row-px`, `--df-radius-pill`, `--df-row-gap`, `--df-row-font`, `--df-row-ctl`, `--df-nav-scrollbar-lane` | metrics | not touched |

### 7e. Deliberately left stock

- `--cds-gray-*`: the raw palette. `--cds-gray-0` / `-900` are used as literal white / black.
- `--cds-switch-knob`, `--cds-slider-handle`: `var(--cds-gray-0)` in both modes - a white knob on a translucent track is the stock intent in dark too.
- `--cds-fill-warning(-hover)`, `--cds-on-warning`, `--cds-bg-highlight`: the bright yellow `#fab219` fill also paints the text highlight (`color-mix(fill-warning 33%, transparent)`); our `--warning-*` ramp has no bright member.
- `--cds-backdrop`, `--cds-shadow-*`, `--cds-button-on-content*`: black / white alphas.
- Chart (`--cds-chart-*`) and git-status (`--cds-*-git-*`) tokens.

Verified by `scripts/tests/core/test-theme-scope.mjs`: the sheet carries the map, and a headless
Chromium probe of `.df-pills[data-segmented]` resolves to the theme's `--bg-400` (light) /
`--bg-100` (dark) through upstream's own `var(--cds-neutral-60)` chain.

---

## Appendix: extraction provenance & caveats

- `meta.url`: `https://claude.ai/epitaxy/session_01G3SWx5vmgzYiWXpt4fPmBW` — captured inside the Cowork/epitaxy frame, so `.epitaxy-root` + dframe tokens are fully populated.
- `tokenNames`, `classes`, `attrInventory` came back **empty** (collector bug) — ignore, as instructed. All findings here come from `declaredTokensBySelector` (authored) and `resolvedTokensBySurface` (computed dark).
- `blockedStylesheets`: none (all 17 sheets read).
- **Light resolved values were NOT captured** (app was in dark mode). Stock LIGHT in §2 comes from the *authored* `[data-mode="light"]` declarations, which is the correct ground truth regardless of capture mode.
- To refresh: re-run the extractor in BOTH modes and diff `[data-theme="claude"][data-mode="light"]` vs `…[data-mode="dark"]`, and re-check whether `--_blue/_violet/_red/_green/_yellow-*` primitives resolve so §2a can be completed with exact HSL.

# Palette catalog

Every palette bundled with the package - **138** of them: the **7 curated built-in
themes**, **15 Linux distro palettes** (`js/linux_themes.json`), **12 gaming
palettes** (`js/gaming_themes.json`), **20 animated Scene palettes**
(`js/scene_themes.json`), and **84 community palettes** (`118` swatch cards below).
Nothing here needs a `themes` block in your config - each one is a complete dual
light/dark token set that lives inside the package, so the app's own light/dark toggle
(Settings -> Appearance) keeps working whichever you pick.

**Every one of them also ships a custom loading spinner**, drawn from the palette's name
or colors: Claude's brand star becomes official distro logos for CachyOS / Arch / Ubuntu / Fedora / NixOS / Mint / LFS, a stag for Everdeer, a great-wave curl for Kanagawa, a curled cat for the Catppuccins, a d-pad for Game Boy. Switching theme reshapes the glyph immediately, in every open window. The shapes and their spec format are catalogued in [baseline/SPINNER_SHAPES.md](../baseline/SPINNER_SHAPES.md).

Mario ships as one of the seven built-ins but carries `"category": "gaming"`, so the app
groups it into the **Gaming** section alongside the twelve palettes in `js/gaming_themes.json`
(`mario`, `playstation`, `gameboy`, `final-fantasy`, `zelda`, `warcraft`, `dragonball`,
`gta-i`..`gta-vi`). The **Linux** section sits near the top after **Your themes**.

## How to activate a palette

Three ways, all equivalent:

- Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> anywhere in the app and click a card in
  the [theme picker](README.md#theme-picker-ctrlshiftt). It applies immediately, in every
  open window.
- Open **Settings -> Extra -> Themes** inside the app and click a row.
- Set the slug by hand in `~/.config/Claude/claude-desktop-extra.jsonc`:

  ```jsonc
  { "activeTheme": "rose-pine-moon" }
  ```

Slugs are the palette name lowercased with each run of non-alphanumeric characters
collapsed to a single `-`, so **Rose Pine Moon** is `rose-pine-moon`. Your own themes
take precedence over the built-ins, and the built-ins over the community palettes, so
defining a `themes` entry with the same slug replaces the bundled palette of that name.

## Reading a swatch card

Each card shows the palette's **dark** variant on top and its **light** variant below.
The row background is the content surface; the bubbles are, left to right: elevated
surface, text, primary accent, secondary accent, error, warning, success, border.

## Index

**Built-in:** [Sweet](#sweet) · [Nord](#nord) · [Catppuccin Mocha](#catppuccin-mocha) · [Catppuccin Macchiato](#catppuccin-macchiato) · [Catppuccin Frappe](#catppuccin-frappe) · [Catppuccin Latte](#catppuccin-latte)

**Linux:** [Arch Linux](#arch-linux) · [CachyOS](#cachyos) · [Ubuntu](#ubuntu) · [Linux Mint](#linux-mint) · [Fedora](#fedora) · [Debian](#debian) · [NixOS](#nixos) · [openSUSE](#opensuse) · [Pop!_OS](#pop_os) · [Manjaro](#manjaro) · [EndeavourOS](#endeavouros) · [Kali Linux](#kali-linux) · [Gentoo](#gentoo) · [Zorin OS](#zorin-os) · [Linux From Scratch](#linux-from-scratch)

**Gaming:** [Mario](#mario) · [PlayStation](#playstation) · [Game Boy](#game-boy) · [Final Fantasy](#final-fantasy) · [Zelda](#zelda) · [Warcraft](#warcraft) · [Dragon Ball](#dragon-ball) · [GTA I](#gta-i) · [GTA II](#gta-ii) · [GTA III](#gta-iii) · [GTA IV](#gta-iv) · [GTA V](#gta-v) · [GTA VI](#gta-vi)

**Community:**

- **A** - [ADW](#adw) · [Atuel](#atuel) · [Ayu Blue](#ayu-blue) · [Ayu Green](#ayu-green) · [Ayu Red](#ayu-red)
- **B** - [Breeze](#breeze)
- **C** - [Catppuccin Frappe Blue](#catppuccin-frappe-blue) · [Catppuccin Frappe Lavender](#catppuccin-frappe-lavender) · [Catppuccin Frappe Mauve](#catppuccin-frappe-mauve) · [Catppuccin Frappe Pink](#catppuccin-frappe-pink) · [Catppuccin Frappe Rosewater](#catppuccin-frappe-rosewater) · [Catppuccin Frappe Sapphire](#catppuccin-frappe-sapphire) · [Catppuccin Lavender](#catppuccin-lavender) · [Catppuccin Macchiato Lavender](#catppuccin-macchiato-lavender) · [Catppuccin Macchiato Mauve](#catppuccin-macchiato-mauve) · [Catppuccin Macchiato Pink](#catppuccin-macchiato-pink) · [Catppuccin Macchiato Rosewater](#catppuccin-macchiato-rosewater) · [Catppuccin Macchiato Sapphire](#catppuccin-macchiato-sapphire) · [Catppuccin Mocha Pink](#catppuccin-mocha-pink) · [Catppuccin Mocha Rosewater](#catppuccin-mocha-rosewater) · [Catppuccin Mocha Sapphire](#catppuccin-mocha-sapphire) · [Cherry Blossom](#cherry-blossom) · [Cream](#cream) · [Cream Autumn](#cream-autumn) · [Creamy Forest](#creamy-forest) · [Cyberpunk](#cyberpunk)
- **D** - [Doomed](#doomed)
- **E** - [Espresso Cream](#espresso-cream) · [Everdeer](#everdeer) · [Everforest](#everforest) · [Everforest Alt](#everforest-alt) · [Everforest Material](#everforest-material)
- **F** - [Flexoki](#flexoki)
- **G** - [Garnet](#garnet) · [GitHub Dark](#github-dark) · [Gruber Darker](#gruber-darker) · [Gruvbox Material](#gruvbox-material) · [GruvboxAlt](#gruvboxalt)
- **H** - [Hexa34C](#hexa34c) · [Horizon](#horizon)
- **J** - [Jiva](#jiva) · [Jiva Lotus](#jiva-lotus) · [Jiva Paper](#jiva-paper)
- **K** - [Kanagawa Dragon](#kanagawa-dragon) · [Kanagawa Kasumi](#kanagawa-kasumi) · [Kanagawa Paper](#kanagawa-paper) · [Kemuri](#kemuri) · [Kemuri Koke](#kemuri-koke) · [Kemuri Susu](#kemuri-susu)
- **L** - [Lilac AMOLED](#lilac-amoled)
- **M** - [Macaron](#macaron) · [Matecito](#matecito) · [Miasma](#miasma) · [Mine](#mine) · [Mizuki-Akiyama](#mizuki-akiyama) · [Monochrome](#monochrome) · [Murasaki](#murasaki) · [Murata](#murata)
- **N** - [NaySayer](#naysayer) · [Neon Surf](#neon-surf) · [Noctalia legacy](#noctalia-legacy) · [Nord Aurora](#nord-aurora)
- **O** - [Oasis Abyss](#oasis-abyss) · [Occult Umbral](#occult-umbral) · [One](#one) · [One Dark Two](#one-dark-two) · [Osaka jade](#osaka-jade) · [Oxide](#oxide) · [Oxocarbon](#oxocarbon)
- **P** - [Paradise](#paradise) · [Peche](#peche)
- **R** - [Rose Pine Alt](#rose-pine-alt) · [Rose Pine Moon](#rose-pine-moon) · [Rose Pine Moon Alt](#rose-pine-moon-alt) · [Rosey AMOLED](#rosey-amoled)
- **S** - [Shien](#shien) · [Shinonome](#shinonome) · [Solarized](#solarized) · [Solarized Osaka](#solarized-osaka) · [Sway Classic](#sway-classic)
- **T** - [Tokyo Night Moon](#tokyo-night-moon) · [Tokyo Night Storm](#tokyo-night-storm)
- **V** - [Vesper](#vesper)
- **Z** - [Zenbones](#zenbones)

## Built-in themes

The curated themes, each with a hand-drawn loading spinner. Details and the spinner spec
are in [README.md](README.md#built-in-themes-dual-variant). Mario is the seventh; it is
catalogued under [Gaming](#gaming-themes).

### Sweet

`"activeTheme": "sweet"` - blush and lavender (light) / deep plum with hot pink (dark), blossom spinner

![Sweet palette](palettes/sweet.svg)

### Nord

`"activeTheme": "nord"` - Nord Snow Storm (light) / Polar Night (dark), snowflake spinner. The slug `nordic` is an alias for this one

![Nord palette](palettes/nord.svg)

### Catppuccin Mocha

`"activeTheme": "catppuccin-mocha"` - Catppuccin Latte (light) / Mocha with a mauve accent (dark), cat spinner

![Catppuccin Mocha palette](palettes/catppuccin-mocha.svg)

### Catppuccin Macchiato

`"activeTheme": "catppuccin-macchiato"` - Catppuccin Latte (light) / Macchiato (dark), cat spinner

![Catppuccin Macchiato palette](palettes/catppuccin-macchiato.svg)

### Catppuccin Frappe

`"activeTheme": "catppuccin-frappe"` - Catppuccin Latte (light) / Frappe (dark), cat spinner

![Catppuccin Frappe palette](palettes/catppuccin-frappe.svg)

### Catppuccin Latte

`"activeTheme": "catppuccin-latte"` - Catppuccin Latte (light) / Mocha (dark), coffee-cup spinner

![Catppuccin Latte palette](palettes/catppuccin-latte.svg)

## Linux themes

Fifteen minimal palettes drawn from popular Linux distributions, each with its official logo SVG spinner and a quiet geometric animated backdrop (`js/linux_themes.json`). They appear in the **Linux** section right after **Your themes**.

### Arch Linux

`"activeTheme": "arch-linux"` - ice porcelain & Arch blue (light) / slate & Arch cyan (dark), Arch spear spinner.

![Arch Linux palette](palettes/arch-linux.svg)

### CachyOS

`"activeTheme": "cachyos"` - mint porcelain & oceanic teal (light) / dark carbon teal & cyan (dark), faceted C & orbs `flip` spinner.

![CachyOS palette](palettes/cachyos.svg)

### Ubuntu

`"activeTheme": "ubuntu"` - Yaru warm ivory & Canonical orange (light) / aubergine charcoal (dark), Circle of Friends spinner.

![Ubuntu palette](palettes/ubuntu.svg)

### Linux Mint

`"activeTheme": "linux-mint"` - sage paper & Mint leaf green (light) / Cinnamon dark slate (dark), LM leaf crest spinner.

![Linux Mint palette](palettes/linux-mint.svg)

### Fedora

`"activeTheme": "fedora"` - Adwaita cool porcelain & Fedora blue (light) / deep Adwaita slate (dark), infinity-f spinner.

![Fedora palette](palettes/fedora.svg)

### Debian

`"activeTheme": "debian"` - warm paper & Debian crimson (light) / burgundy-slate & ruby swirl (dark), Debian spiral spinner.

![Debian palette](palettes/debian.svg)

### NixOS

`"activeTheme": "nixos"` - frost porcelain & Nix blue (light) / functional slate & sky lambdas (dark), 6-lambda snowflake spinner.

![NixOS palette](palettes/nixos.svg)

### openSUSE

`"activeTheme": "opensuse"` - Tumbleweed mist & Geeko green (light) / pine slate & emerald-teal (dark), Geeko chameleon spinner.

![openSUSE palette](palettes/opensuse.svg)

### Pop!_OS

`"activeTheme": "pop-os"` - System76 warm cream & teal (light) / Pop-Dark charcoal & COSMIC amber (dark), `P!_` `flip` spinner.

![Pop!_OS palette](palettes/pop-os.svg)

### Manjaro

`"activeTheme": "manjaro"` - Breath mint paper (light) / Breath dark slate & Maia jade (dark), 3-pillar M spinner.

![Manjaro palette](palettes/manjaro.svg)

### EndeavourOS

`"activeTheme": "endeavouros"` - starlight lavender (light) / deep space indigo & periwinkle/coral (dark), tri-color sail spinner.

![EndeavourOS palette](palettes/endeavouros.svg)

### Kali Linux

`"activeTheme": "kali-linux"` - cool steel & cobalt (light) / obsidian cyber slate & Kali blue (dark), coiled dragon spinner.

![Kali Linux palette](palettes/kali-linux.svg)

### Gentoo

`"activeTheme": "gentoo"` - silver-lavender & Portage amethyst (light) / graphite-violet (dark), Gentoo `g`-signet spinner.

![Gentoo palette](palettes/gentoo.svg)

### Zorin OS

`"activeTheme": "zorin-os"` - frost azure & sky blue (light) / midnight glass & electric azure (dark), hexagonal `Z` chevron spinner.

![Zorin OS palette](palettes/zorin-os.svg)

### Linux From Scratch

`"activeTheme": "linux-from-scratch"` - DocBook paper & LFS navy (light) / classic TTY dark & phosphor green (dark), Tux-in-jigsaw `flip` spinner.

![Linux From Scratch palette](palettes/linux-from-scratch.svg)

## Gaming themes

Thirteen palettes drawn from classic and modern games, each with a custom spinner and dual-mode animated SVG backdrop (`mario` + 12 entries in `js/gaming_themes.json`). They appear in the **Gaming** section.

### Mario

`"activeTheme": "mario"` - sky-blue overworld (light) / warm-brick underground (dark), coin-gold and pipe-green status colors. Spinner: the mushroom, bouncing

![Mario palette](palettes/mario.svg)

### PlayStation

`"activeTheme": "playstation"` - PS1 console gray (light) / charcoal blue-black (dark), PlayStation-blue accent with circle-red and triangle-green status colors. Spinner: the four controller button symbols in a diamond, spinning

![PlayStation palette](palettes/playstation.svg)

### Game Boy

`"activeTheme": "gameboy"` - DMG shell gray with magenta buttons (light) / pea-green LCD (dark). Spinner: the d-pad, pulsing

![Game Boy palette](palettes/gameboy.svg)

### Final Fantasy

`"activeTheme": "final-fantasy"` - parchment cream with menu-blue accent (light) / the classic menu blue with a crystal-gold accent (dark). Spinner: a faceted crystal, pulsing

![Final Fantasy palette](palettes/final-fantasy.svg)

### Zelda

`"activeTheme": "zelda"` - pale parchment green with forest-green accent (light) / deep forest green with gold (dark). Spinner: a two-frame walking hero silhouette, sword raised

![Zelda palette](palettes/zelda.svg)

### Warcraft

`"activeTheme": "warcraft"` - parchment gold with Alliance-blue accent (light) / dark brown with gold, orc-green success (dark). Spinner: a two-frame peon swinging a pick

![Warcraft palette](palettes/warcraft.svg)

### Dragon Ball

`"activeTheme": "dragonball"` - white over a sky backdrop with an orange accent (light) / deep blue with bright orange (dark). Spinner: the 4-star dragon ball, spinning - its orange and red are pinned, so the ball keeps its own colors in both variants

![Dragon Ball palette](palettes/dragonball.svg)

### GTA I

`"activeTheme": "gta-i"` - 1997 Liberty beige paper (light) / neon pager asphalt (dark), cruiser `flip` spinner.

![GTA I palette](palettes/gta-i.svg)

### GTA II

`"activeTheme": "gta-ii"` - steel concrete (light) / Anywhere City cyber-noir (dark), `II` badge `flip` spinner.

![GTA II palette](palettes/gta-ii.svg)

### GTA III

`"activeTheme": "gta-iii"` - rain concrete (light) / Callahan night radar (dark), radar `III` `flip` spinner.

![GTA III palette](palettes/gta-iii.svg)

### GTA IV

`"activeTheme": "gta-iv"` - Broker overcast steel (light) / HD noir asphalt (dark), Rockstar gold `flip` spinner.

![GTA IV palette](palettes/gta-iv.svg)

### GTA V

`"activeTheme": "gta-v"` - Los Santos daylight (light) / Pacific harbor night (dark), banknote V `flip` spinner.

![GTA V palette](palettes/gta-v.svg)

### GTA VI

`"activeTheme": "gta-vi"` - Leonida golden-hour peach and blush (light) / Vice City plum night with a coral-pink and indigo sunset gradient (dark), sunset-gradient VI block logo `flip` spinner with a sticker gleam.

![GTA VI palette](palettes/gta-vi.svg)

## Community palettes

84 palettes converted from the
[Noctalia community-palettes](https://github.com/noctalia-dev/community-palettes)
collection. Each carries a curated spinner glyph alongside its colors - 53 distinct
designs across the 84 slugs, because families share a shape on purpose (one great-wave
curl for the Kanagawa palettes, one curled cat for the Catppuccin accent variants).

### A

#### ADW

`"activeTheme": "adw"`

![ADW palette](palettes/adw.svg)

#### Atuel

`"activeTheme": "atuel"`

![Atuel palette](palettes/atuel.svg)

#### Ayu Blue

`"activeTheme": "ayu-blue"`

![Ayu Blue palette](palettes/ayu-blue.svg)

#### Ayu Green

`"activeTheme": "ayu-green"`

![Ayu Green palette](palettes/ayu-green.svg)

#### Ayu Red

`"activeTheme": "ayu-red"`

![Ayu Red palette](palettes/ayu-red.svg)

### B

#### Breeze

`"activeTheme": "breeze"`

![Breeze palette](palettes/breeze.svg)

### C

#### Catppuccin Frappe Blue

`"activeTheme": "catppuccin-frappe-blue"`

![Catppuccin Frappe Blue palette](palettes/catppuccin-frappe-blue.svg)

#### Catppuccin Frappe Lavender

`"activeTheme": "catppuccin-frappe-lavender"`

![Catppuccin Frappe Lavender palette](palettes/catppuccin-frappe-lavender.svg)

#### Catppuccin Frappe Mauve

`"activeTheme": "catppuccin-frappe-mauve"`

![Catppuccin Frappe Mauve palette](palettes/catppuccin-frappe-mauve.svg)

#### Catppuccin Frappe Pink

`"activeTheme": "catppuccin-frappe-pink"`

![Catppuccin Frappe Pink palette](palettes/catppuccin-frappe-pink.svg)

#### Catppuccin Frappe Rosewater

`"activeTheme": "catppuccin-frappe-rosewater"`

![Catppuccin Frappe Rosewater palette](palettes/catppuccin-frappe-rosewater.svg)

#### Catppuccin Frappe Sapphire

`"activeTheme": "catppuccin-frappe-sapphire"`

![Catppuccin Frappe Sapphire palette](palettes/catppuccin-frappe-sapphire.svg)

#### Catppuccin Lavender

`"activeTheme": "catppuccin-lavender"`

![Catppuccin Lavender palette](palettes/catppuccin-lavender.svg)

#### Catppuccin Macchiato Lavender

`"activeTheme": "catppuccin-macchiato-lavender"`

![Catppuccin Macchiato Lavender palette](palettes/catppuccin-macchiato-lavender.svg)

#### Catppuccin Macchiato Mauve

`"activeTheme": "catppuccin-macchiato-mauve"`

![Catppuccin Macchiato Mauve palette](palettes/catppuccin-macchiato-mauve.svg)

#### Catppuccin Macchiato Pink

`"activeTheme": "catppuccin-macchiato-pink"`

![Catppuccin Macchiato Pink palette](palettes/catppuccin-macchiato-pink.svg)

#### Catppuccin Macchiato Rosewater

`"activeTheme": "catppuccin-macchiato-rosewater"`

![Catppuccin Macchiato Rosewater palette](palettes/catppuccin-macchiato-rosewater.svg)

#### Catppuccin Macchiato Sapphire

`"activeTheme": "catppuccin-macchiato-sapphire"`

![Catppuccin Macchiato Sapphire palette](palettes/catppuccin-macchiato-sapphire.svg)

#### Catppuccin Mocha Pink

`"activeTheme": "catppuccin-mocha-pink"`

![Catppuccin Mocha Pink palette](palettes/catppuccin-mocha-pink.svg)

#### Catppuccin Mocha Rosewater

`"activeTheme": "catppuccin-mocha-rosewater"`

![Catppuccin Mocha Rosewater palette](palettes/catppuccin-mocha-rosewater.svg)

#### Catppuccin Mocha Sapphire

`"activeTheme": "catppuccin-mocha-sapphire"`

![Catppuccin Mocha Sapphire palette](palettes/catppuccin-mocha-sapphire.svg)

#### Cherry Blossom

`"activeTheme": "cherry-blossom"`

![Cherry Blossom palette](palettes/cherry-blossom.svg)

#### Cream

`"activeTheme": "cream"`

![Cream palette](palettes/cream.svg)

#### Cream Autumn

`"activeTheme": "cream-autumn"`

![Cream Autumn palette](palettes/cream-autumn.svg)

#### Creamy Forest

`"activeTheme": "creamy-forest"`

![Creamy Forest palette](palettes/creamy-forest.svg)

#### Cyberpunk

`"activeTheme": "cyberpunk"`

![Cyberpunk palette](palettes/cyberpunk.svg)

### D

#### Doomed

`"activeTheme": "doomed"`

![Doomed palette](palettes/doomed.svg)

### E

#### Espresso Cream

`"activeTheme": "espresso-cream"`

![Espresso Cream palette](palettes/espresso-cream.svg)

#### Everdeer

`"activeTheme": "everdeer"`

![Everdeer palette](palettes/everdeer.svg)

#### Everforest

`"activeTheme": "everforest"`

![Everforest palette](palettes/everforest.svg)

#### Everforest Alt

`"activeTheme": "everforest-alt"`

![Everforest Alt palette](palettes/everforest-alt.svg)

#### Everforest Material

`"activeTheme": "everforest-material"`

![Everforest Material palette](palettes/everforest-material.svg)

### F

#### Flexoki

`"activeTheme": "flexoki"`

![Flexoki palette](palettes/flexoki.svg)

### G

#### Garnet

`"activeTheme": "garnet"`

![Garnet palette](palettes/garnet.svg)

#### GitHub Dark

`"activeTheme": "github-dark"`

![GitHub Dark palette](palettes/github-dark.svg)

#### Gruber Darker

`"activeTheme": "gruber-darker"`

![Gruber Darker palette](palettes/gruber-darker.svg)

#### Gruvbox Material

`"activeTheme": "gruvbox-material"`

![Gruvbox Material palette](palettes/gruvbox-material.svg)

#### GruvboxAlt

`"activeTheme": "gruvboxalt"`

![GruvboxAlt palette](palettes/gruvboxalt.svg)

### H

#### Hexa34C

`"activeTheme": "hexa34c"`

![Hexa34C palette](palettes/hexa34c.svg)

#### Horizon

`"activeTheme": "horizon"`

![Horizon palette](palettes/horizon.svg)

### J

#### Jiva

`"activeTheme": "jiva"`

![Jiva palette](palettes/jiva.svg)

#### Jiva Lotus

`"activeTheme": "jiva-lotus"`

![Jiva Lotus palette](palettes/jiva-lotus.svg)

#### Jiva Paper

`"activeTheme": "jiva-paper"`

![Jiva Paper palette](palettes/jiva-paper.svg)

### K

#### Kanagawa Dragon

`"activeTheme": "kanagawa-dragon"`

![Kanagawa Dragon palette](palettes/kanagawa-dragon.svg)

#### Kanagawa Kasumi

`"activeTheme": "kanagawa-kasumi"`

![Kanagawa Kasumi palette](palettes/kanagawa-kasumi.svg)

#### Kanagawa Paper

`"activeTheme": "kanagawa-paper"`

![Kanagawa Paper palette](palettes/kanagawa-paper.svg)

#### Kemuri

`"activeTheme": "kemuri"`

![Kemuri palette](palettes/kemuri.svg)

#### Kemuri Koke

`"activeTheme": "kemuri-koke"`

![Kemuri Koke palette](palettes/kemuri-koke.svg)

#### Kemuri Susu

`"activeTheme": "kemuri-susu"`

![Kemuri Susu palette](palettes/kemuri-susu.svg)

### L

#### Lilac AMOLED

`"activeTheme": "lilac-amoled"`

![Lilac AMOLED palette](palettes/lilac-amoled.svg)

### M

#### Macaron

`"activeTheme": "macaron"`

![Macaron palette](palettes/macaron.svg)

#### Matecito

`"activeTheme": "matecito"`

![Matecito palette](palettes/matecito.svg)

#### Miasma

`"activeTheme": "miasma"`

![Miasma palette](palettes/miasma.svg)

#### Mine

`"activeTheme": "mine"`

![Mine palette](palettes/mine.svg)

#### Mizuki-Akiyama

`"activeTheme": "mizuki-akiyama"`

![Mizuki-Akiyama palette](palettes/mizuki-akiyama.svg)

#### Monochrome

`"activeTheme": "monochrome"`

![Monochrome palette](palettes/monochrome.svg)

#### Murasaki

`"activeTheme": "murasaki"`

![Murasaki palette](palettes/murasaki.svg)

#### Murata

`"activeTheme": "murata"`

![Murata palette](palettes/murata.svg)

### N

#### NaySayer

`"activeTheme": "naysayer"`

![NaySayer palette](palettes/naysayer.svg)

#### Neon Surf

`"activeTheme": "neon-surf"`

![Neon Surf palette](palettes/neon-surf.svg)

#### Noctalia legacy

`"activeTheme": "noctalia-legacy"`

![Noctalia legacy palette](palettes/noctalia-legacy.svg)

#### Nord Aurora

`"activeTheme": "nord-aurora"`

![Nord Aurora palette](palettes/nord-aurora.svg)

### O

#### Oasis Abyss

`"activeTheme": "oasis-abyss"`

![Oasis Abyss palette](palettes/oasis-abyss.svg)

#### Occult Umbral

`"activeTheme": "occult-umbral"`

![Occult Umbral palette](palettes/occult-umbral.svg)

#### One

`"activeTheme": "one"`

![One palette](palettes/one.svg)

#### One Dark Two

`"activeTheme": "one-dark-two"`

![One Dark Two palette](palettes/one-dark-two.svg)

#### Osaka jade

`"activeTheme": "osaka-jade"`

![Osaka jade palette](palettes/osaka-jade.svg)

#### Oxide

`"activeTheme": "oxide"`

![Oxide palette](palettes/oxide.svg)

#### Oxocarbon

`"activeTheme": "oxocarbon"`

![Oxocarbon palette](palettes/oxocarbon.svg)

### P

#### Paradise

`"activeTheme": "paradise"`

![Paradise palette](palettes/paradise.svg)

#### Peche

`"activeTheme": "peche"`

![Peche palette](palettes/peche.svg)

### R

#### Rose Pine Alt

`"activeTheme": "rose-pine-alt"`

![Rose Pine Alt palette](palettes/rose-pine-alt.svg)

#### Rose Pine Moon

`"activeTheme": "rose-pine-moon"`

![Rose Pine Moon palette](palettes/rose-pine-moon.svg)

#### Rose Pine Moon Alt

`"activeTheme": "rose-pine-moon-alt"`

![Rose Pine Moon Alt palette](palettes/rose-pine-moon-alt.svg)

#### Rosey AMOLED

`"activeTheme": "rosey-amoled"`

![Rosey AMOLED palette](palettes/rosey-amoled.svg)

### S

#### Shien

`"activeTheme": "shien"`

![Shien palette](palettes/shien.svg)

#### Shinonome

`"activeTheme": "shinonome"`

![Shinonome palette](palettes/shinonome.svg)

#### Solarized

`"activeTheme": "solarized"`

![Solarized palette](palettes/solarized.svg)

#### Solarized Osaka

`"activeTheme": "solarized-osaka"`

![Solarized Osaka palette](palettes/solarized-osaka.svg)

#### Sway Classic

`"activeTheme": "sway-classic"`

![Sway Classic palette](palettes/sway-classic.svg)

### T

#### Tokyo Night Moon

`"activeTheme": "tokyo-night-moon"`

![Tokyo Night Moon palette](palettes/tokyo-night-moon.svg)

#### Tokyo Night Storm

`"activeTheme": "tokyo-night-storm"`

![Tokyo Night Storm palette](palettes/tokyo-night-storm.svg)

### V

#### Vesper

`"activeTheme": "vesper"`

![Vesper palette](palettes/vesper.svg)

### Z

#### Zenbones

`"activeTheme": "zenbones"`

![Zenbones palette](palettes/zenbones.svg)

## Notes on specific palettes

- **Lilac AMOLED**, **Rosey AMOLED** and **Neon Surf** use a pure-black background by
  design. The surface ladder is intentionally flat; panels still lift slightly above
  the content pane.
- **Everforest**, **Osaka jade**, **Kemuri Susu**, **Kanagawa Dragon** and **Kanagawa
  Kasumi** have muted mid-tone light variants rather than bright ones - that is the
  source palette, not a conversion artifact.
- **Peche**, **Monochrome**, **Solarized** and the light variants of **Tokyo Night
  Moon** and **Tokyo Night Storm** carry the lower text contrast of their source
  palettes. If you want more separation, copy the palette into your own `themes`
  entry and darken (light variant) or lighten (dark variant) `--text-000`/`--text-100`.
- The three Catppuccin flavours that ship as built-ins (`catppuccin-mocha`,
  `catppuccin-macchiato`, `catppuccin-frappe`) all pair with **Latte** as their light
  variant, because Catppuccin defines a single light flavour. The community
  Catppuccin entries here are its accent variants.

## Credits

The community palettes come from the
[Noctalia community-palettes](https://github.com/noctalia-dev/community-palettes)
project and its contributors. They are converted to Claude Desktop token sets by
`scripts/generate-community-themes.mjs`, which also renders the swatch cards on this
page; the full role-to-token mapping is documented in that script's header. To
regenerate after the collection changes:

```bash
node scripts/generate-community-themes.mjs /path/to/community-palettes
```

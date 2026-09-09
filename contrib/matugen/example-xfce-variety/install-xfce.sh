#!/usr/bin/env bash
# Installs the tested XFCE / Variety matugen setup into your home directory. XFCE (xsettings) only:
# other desktops copy the claude-desktop* template sections and set-mode-from-wallpaper.sh by hand.
# Non-destructive: existing files are kept and reported; nothing is written outside
# ~/.config/matugen, ~/.config/gtk-3.0, ~/.config/gtk-4.0, ~/.themes and ~/.config/Claude/themes.d.
set -eu
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
contrib="$(dirname "$here")"
m="$HOME/.config/matugen"
mkdir -p "$m/templates" "$HOME/.config/gtk-3.0" "$HOME/.config/gtk-4.0" "$HOME/.themes" "$HOME/.config/Claude/themes.d"

put() { # put <src> <dst>: copy unless the destination exists
  if [ -e "$2" ]; then echo "keep    $2 (exists; compare with $1)"; else cp "$1" "$2"; echo "install $2"; fi
}
put "$here/config.toml"                        "$m/config.toml"
put "$here/reload-gtk.sh"                      "$m/reload-gtk.sh";               chmod +x "$m/reload-gtk.sh"
put "$contrib/set-mode-from-wallpaper.sh"      "$m/set-mode-from-wallpaper.sh";  chmod +x "$m/set-mode-from-wallpaper.sh"
put "$here/templates/gtk-colors-dark.css"      "$m/templates/gtk-colors-dark.css"
put "$here/templates/gtk-colors-light.css"     "$m/templates/gtk-colors-light.css"
for t in claude-desktop-overlay claude-desktop-overlay-bg claude-desktop-overlay-full claude-desktop; do
  put "$contrib/$t.json" "$m/templates/$t.json"
done

# Four wrapper themes: dark and light, each twice (reload-gtk.sh alternates within a pair).
for spec in "adw-gtk3-matugen:adw-gtk3-dark:dark" "adw-gtk3-matugen-b:adw-gtk3-dark:dark" \
            "adw-gtk3-matugen-light:adw-gtk3:light" "adw-gtk3-matugen-light-b:adw-gtk3:light"; do
  IFS=: read -r name base variant <<<"$spec"
  d="$HOME/.themes/$name"; mkdir -p "$d/gtk-3.0"
  sed "s|@BASE@|$base|g; s|@VARIANT@|$variant|g; s|@HOME@|$HOME|g" "$here/wrapper-theme/gtk.css.in" > "$d/gtk-3.0/gtk.css"
  sed "s|@NAME@|$name|g; s|@VARIANT@|$variant|g" "$here/wrapper-theme/index.theme.in" > "$d/index.theme"
  echo "theme   $d"
done

# GTK4 apps import the generated colors from the user gtk.css (read once per app start).
grep -q 'colors.css' "$HOME/.config/gtk-4.0/gtk.css" 2>/dev/null || { printf '@import url("colors.css");\n' >> "$HOME/.config/gtk-4.0/gtk.css"; echo "install ~/.config/gtk-4.0/gtk.css import"; }
if grep -q 'colors.css' "$HOME/.config/gtk-3.0/gtk.css" 2>/dev/null; then
  echo "WARNING ~/.config/gtk-3.0/gtk.css imports colors.css: GTK3 reads that file once per process and it"
  echo "        outranks the theme, so it blocks live reload. Remove the import; the wrapper themes carry the colors."
fi

if [ -n "${GTK_THEME:-}" ]; then
  echo "WARNING GTK_THEME=$GTK_THEME is set in your session. GTK3 then ignores theme changes entirely."
  echo "        Remove it from ~/.profile, ~/.xprofile, ~/.bashrc, ~/.config/environment.d/*, /etc/environment; log out and in."
fi
[ -d /usr/share/themes/adw-gtk3-dark ] || echo "WARNING adw-gtk3 theme not installed (Arch: pacman -S adw-gtk-theme)"
command -v matugen >/dev/null || echo "WARNING matugen not installed (Arch: pacman -S matugen)"

cat <<TXT

Next steps:
  1. Wallpaper tool: run  ~/.config/matugen/set-mode-from-wallpaper.sh "\$WALLPAPER"  after each change
     (Variety: append the lines from $here/variety-hook.sh to ~/.config/variety/scripts/set_wallpaper).
  2. Claude Desktop: add  "themeOverlay": "wallpaper-accent"  (or "wallpaper-bg") to
     ~/.config/Claude/claude-desktop-extra.jsonc, set Settings -> Appearance -> System, pick any theme.
  3. Try it now:  ~/.config/matugen/set-mode-from-wallpaper.sh /path/to/current/wallpaper.jpg
TXT

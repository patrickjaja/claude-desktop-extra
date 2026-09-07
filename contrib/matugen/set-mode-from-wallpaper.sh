#!/usr/bin/env bash
# set-mode-from-wallpaper.sh <wallpaper> - the wallpaper post-change command of the matugen recipe
# (docs/themes.md, "matugen (official recipe)"): light/dark follows the wallpaper.
#
# Measures the wallpaper's mean luma with ImageMagick, picks "light" above the threshold
# (0.55, override with CDB_MODE_THRESHOLD) and "dark" below, runs matugen in that mode, and
# sets the desktop-wide color-scheme preference so Claude Desktop's Appearance = System follows:
#   - gsettings org.gnome.desktop.interface color-scheme (xdg-desktop-portal-gtk) and
#     org.x.apps.portal color-scheme (xdg-desktop-portal-xapp: XFCE, Cinnamon, MATE) - the portal
#     answer Chromium/Electron, i.e. Claude Desktop, reads -> prefer-light / prefer-dark
#   - XFCE only: xfconf /Net/ThemeName adw-gtk3 <-> adw-gtk3-dark (when one of those two stock
#     themes is active) and /Gtk/ApplicationPreferDarkTheme
#
# Wiring: make this your wallpaper tool's post-change command (Variety:
# ~/.config/variety/scripts/set_wallpaper, replacing `matugen image "$WP" -m dark -q`):
#     ~/.config/matugen/set-mode-from-wallpaper.sh "$WP"
# and set Claude Desktop Settings -> Appearance -> System. If you do not want the desktop-wide
# preference changed, keep a fixed-mode `matugen image "$WP" -m dark -q` line instead.
# Needs: matugen, imagemagick (magick).
set -u

wp="${1:-}"
if [ -z "$wp" ] || [ ! -r "$wp" ]; then
  echo "usage: $0 <wallpaper>" >&2
  exit 2
fi
threshold="${CDB_MODE_THRESHOLD:-0.55}"

# matugen decodes raster formats only; rasterize anything else (SVG, ...) to a temp PNG.
case "${wp,,}" in
  *.jpg|*.jpeg|*.png|*.webp|*.bmp|*.gif|*.tif|*.tiff) ;;
  *)
    tmp="$(mktemp --suffix=.png)"
    if magick "$wp" -resize '1600x1600>' "$tmp" 2>/dev/null; then wp="$tmp"; trap 'rm -f "$tmp"' EXIT
    else rm -f "$tmp"; echo "set-mode-from-wallpaper: cannot rasterize $wp" >&2; exit 1; fi
    ;;
esac

luma="$(magick "$wp" -resize '1x1!' -colorspace gray -format '%[fx:mean]' info: 2>/dev/null)"
if [ -z "$luma" ]; then
  echo "set-mode-from-wallpaper: could not measure $wp (is imagemagick installed?)" >&2
  exit 1
fi
if awk -v l="$luma" -v t="$threshold" 'BEGIN { exit !(l > t) }'; then mode=light; else mode=dark; fi
echo "set-mode-from-wallpaper: luma=$luma threshold=$threshold -> $mode"

matugen image "$wp" -m "$mode" -q

if command -v gsettings >/dev/null 2>&1; then
  gsettings set org.gnome.desktop.interface color-scheme "prefer-$mode" 2>/dev/null || true
  # XFCE, Cinnamon and MATE route the Settings portal through xdg-desktop-portal-xapp, which
  # answers color-scheme from its own key (the GNOME key above is ignored there).
  gsettings set org.x.apps.portal color-scheme "prefer-$mode" 2>/dev/null || true
fi

if command -v xfconf-query >/dev/null 2>&1 && [ -n "${XDG_CURRENT_DESKTOP:-}" ] && [[ "$XDG_CURRENT_DESKTOP" == *XFCE* ]]; then
  # Only the stock adw-gtk3 names are flipped here. A custom wrapper theme (one that
  # imports adw-gtk3 plus a generated colors.css) is left alone: switch it from your
  # matugen post_hook instead, where {{mode}} is available.
  current="$(xfconf-query -c xsettings -p /Net/ThemeName 2>/dev/null || true)"
  case "$current" in
    adw-gtk3|adw-gtk3-dark)
      if [ "$mode" = dark ]; then want=adw-gtk3-dark; else want=adw-gtk3; fi
      [ "$current" = "$want" ] || xfconf-query -c xsettings -p /Net/ThemeName -s "$want"
      ;;
  esac
  if [ "$mode" = dark ]; then dark=true; else dark=false; fi
  xfconf-query -c xsettings -p /Gtk/ApplicationPreferDarkTheme -t bool -s "$dark" --create
fi

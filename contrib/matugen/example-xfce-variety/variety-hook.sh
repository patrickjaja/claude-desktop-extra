# Append to ~/.config/variety/scripts/set_wallpaper (before its final `exit 0`).
# $WP is the wallpaper Variety just applied (already rasterized to JPG).
# --- matugen: derive desktop colors from the new wallpaper ---------------------
if [ -x ~/.config/matugen/set-mode-from-wallpaper.sh ] && command -v matugen >/dev/null 2>&1; then
    ( ~/.config/matugen/set-mode-from-wallpaper.sh "$WP" > ~/.cache/matugen-variety.log 2>&1 ) &
fi

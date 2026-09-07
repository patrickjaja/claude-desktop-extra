# Complete example: XFCE 4 / X11 + Variety + matugen

The setup this feature was developed and tested on (Arch Linux, 2026-09-08). It recolors GTK3 apps
(Thunar, xfce4-panel, ...) live, switches the desktop between light and dark from the wallpaper, and
drives Claude Desktop through `themes.d/` and `themeOverlay`.

```
./install-xfce.sh     # XFCE only: copies everything below into ~/.config/matugen, ~/.themes, ...; keeps existing files
```

| File | Installed to | Purpose |
|------|--------------|---------|
| `config.toml` | `~/.config/matugen/config.toml` | matugen templates: GTK3/GTK4 colors, Claude overlay (accents), overlay-bg (backgrounds), full theme |
| `templates/gtk-colors.css` | `~/.config/matugen/templates/` | libadwaita named colors for adw-gtk3 |
| `reload-gtk.sh` | `~/.config/matugen/` | matugen `post_hook`: flips the XSETTINGS theme name between two identical wrapper themes so running GTK3 apps re-parse |
| `wrapper-theme/*.in` | `~/.themes/adw-gtk3-matugen[-light]{,-b}/` | adw-gtk3 plus the generated `colors.css`, dark and light, two copies each |
| `../set-mode-from-wallpaper.sh` | `~/.config/matugen/` | the wallpaper post-change command: luma -> light/dark, runs matugen, sets the desktop preference |
| `variety-hook.sh` | append to `~/.config/variety/scripts/set_wallpaper` | calls the script after every wallpaper change |

Two GTK facts this setup depends on, both verified on GTK 3.24:

- `GTK_THEME=...` in the session environment makes GTK3 ignore theme changes completely. ArcoLinux
  exports it in several dotfiles; remove it and log in again.
- `~/.config/gtk-3.0/gtk.css` is parsed once per process and outranks the theme, so colors placed
  there never reload and shadow a reloaded theme. Keep the colors inside the wrapper theme.

Other desktops: GNOME and KDE users only need the Claude part (`config.toml` sections
`claude-desktop*` plus `set-mode-from-wallpaper.sh`); the GTK wrapper trick is XFCE/xsettings specific.

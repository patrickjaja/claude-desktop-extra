#!/usr/bin/env bash
# matugen post_hook: reload-gtk.sh <dark|light>
# Alternates the XSETTINGS theme name between two identical wrapper themes of the
# requested mode (adw-gtk3-matugen[-light]{,-b}). Every call is a real name change,
# so xfsettingsd broadcasts it and every running GTK3 app re-parses the theme and
# the freshly generated ~/.config/gtk-3.0/colors.css it imports.
mode="${1:-dark}"
if [ "$mode" = light ]; then a=adw-gtk3-matugen-light; else a=adw-gtk3-matugen; fi
b="$a-b"
cur=$(xfconf-query -c xsettings -p /Net/ThemeName 2>/dev/null)
if [ "$cur" = "$a" ]; then next=$b; else next=$a; fi
xfconf-query -c xsettings -p /Net/ThemeName -n -t string -s "$next"
if [ "$mode" = dark ]; then d=true; else d=false; fi
xfconf-query -c xsettings -p /Gtk/ApplicationPreferDarkTheme -n -t bool -s "$d"

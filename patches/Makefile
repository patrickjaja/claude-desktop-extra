# Build every patch source into a same-named executable next to it.
#
# Sources live in three category subdirectories:
#   linux/      Linux compatibility fixes (always on)
#   core/       always-on infrastructure (themes, extra settings, profiles)
#   community/  optional value-add features
#
# Usage:
#   make -j$(nproc)      # parallel build (default target = all)
#   make clean           # remove binaries and nim caches
#
# Each binary is rebuilt when its .nim source is newer; make drives the
# dep tracking. The orchestrator (scripts/apply_patches.py) runs
# the compiled binaries for each patch.
#
# Note on paths: the `../js/...` prerequisites below are relative to make's
# working directory (patches/), NOT to the source file. The staticRead paths
# inside the .nim sources are relative to the source file and therefore use
# `../../js/...`. Both must be kept in sync when a new snippet is embedded.

NIM       ?= nim
NIMFLAGS  ?= c -d:release --opt:speed --mm:orc --hints:off

SRCS := $(wildcard linux/*.nim community/*.nim core/*.nim)
BINS := $(SRCS:.nim=)

ifeq ($(strip $(SRCS)),)
$(error No patch sources found in linux/, community/ or core/ - run make from the patches/ directory)
endif

.PHONY: all clean
.DEFAULT_GOAL := all

all: $(BINS)

# `%` matches the full path, so $* keeps the subdirectory (e.g. linux/fix_app_quit)
# and each patch gets its own nimcache subtree.
%: %.nim
	@echo "  NIM  $@"
	@$(NIM) $(NIMFLAGS) --nimcache:.nimcache/$* -o:$@ $< > /dev/null

# JS snippets shared between patches. Nim embeds them via staticRead,
# so a change to the .js forces a rebuild of the binary.
linux/fix_computer_use_linux: \
  ../js/cu_linux_executor.js \
  ../js/cu_handler_injection.js \
  ../js/cu_mode_preamble.js \
  ../js/executor_linux.js

linux/fix_cowork_font: ../js/fix_cowork_font.js

linux/fix_epitaxy_autoscroll: ../js/fix_epitaxy_autoscroll.js

linux/fix_second_instance_diag: ../js/second_instance_diag.js

linux/fix_startup_settings: ../js/startup_session_restore_gate.js

# Diff view modes: the main-process half embeds the injected page script AND the
# expand/collapse-all module, both via staticRead, so a change to any of them has
# to rebuild the binary. (This line was missing until 2026-08-01 - JS-only edits
# silently produced a stale binary.)
community/add_feature_diff_views: \
  ../js/diff_views_main.js \
  ../js/diff_views_page.js \
  ../js/diff_views_expand.js

community/add_feature_diff_views_bridge: ../js/diff_views_bridge.js

# Panel tabs: the main-process half embeds all four page modules via staticRead,
# so a change to any of them has to rebuild the binary.
community/add_feature_panel_tabs: \
  ../js/panel_tabs_main.js \
  ../js/panel_tabs_layout.js \
  ../js/panel_tabs_store.js \
  ../js/panel_tabs_harvest.js \
  ../js/panel_tabs_page.js

community/add_feature_panel_tabs_bridge: ../js/panel_tabs_bridge.js

# No window controls: the patch embeds the synchronous pref reader AND the IPC
# half via staticRead, so a change to either has to rebuild the binary.
community/add_feature_window_controls: \
  ../js/window_controls_pref.js \
  ../js/window_controls_main.js

# Files quick open: the worker patch embeds the multi-piece search helper; the
# main patch embeds the main-process module AND the page script; the bridge
# patch embeds the preload snippet.
community/add_feature_files_quick_open_worker: ../js/files_quick_open_worker.js

community/add_feature_files_quick_open: \
  ../js/files_quick_open_main.js \
  ../js/files_quick_open_page.js

community/add_feature_files_quick_open_bridge: ../js/files_quick_open_bridge.js

# Theme patch embeds the spinner-reshape installer (swaps the loading-star SVG
# for the active theme's custom shape) and the bundled community + gaming palette
# collections via staticRead.
core/add_feature_custom_themes: \
  ../js/spinner_injector.js \
  ../js/community_themes.json \
  ../js/gaming_themes.json

# Theme picker embeds its page + preload via staticRead.
community/add_feature_theme_picker: ../js/theme_picker_page.html ../js/theme_picker_preload.js

# Extra settings area: main-process half embeds the injected page script and its
# stylesheet; the bridge half embeds the preload snippet.
core/add_feature_extra_settings: \
  ../js/extra_settings_main.js \
  ../js/extra_settings_page.js \
  ../js/extra_settings_page.css

core/add_feature_extra_settings_bridge: ../js/extra_settings_bridge.js

# The flag catalog the Extra settings page renders is parsed out of this file's
# .jsonc template at runtime.
core/add_growthbook_overrides: ../js/growthbook_overrides.js

clean:
	@rm -rf $(BINS) .nimcache

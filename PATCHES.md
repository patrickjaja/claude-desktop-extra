# Patches

The full catalog of the JS patches this project applies to Claude Desktop's `app.asar`. For the short version, see [Patches in the README](README.md#patches).

## How they work

The official Linux build ships one cross-platform JS bundle: plenty of code paths in it check `process.platform` and only serve `darwin`/`win32`, and some upstream behavior misfires in a Linux desktop environment. We apply a set of surgical JS patches at repackage time. Each patch lives in the directory that says what it is for: [`patches/community/`](#community-features), [`patches/core/`](#core-infrastructure), [`patches/linux/`](#linux-compatibility).

Every package ships the official build's install tree byte-identical except for the patched `app.asar` (plus our bundled Computer Use bridges in `resources/`), so runtime path resolution (`process.resourcesPath`, `app.isPackaged`) behaves exactly as on the stock Anthropic `.deb`.

Each patch is a self-contained `patches/<group>/*.nim` file compiled to a native binary. Patterns use `[\w$]+` wildcards anchored on stable strings because upstream re-minifies between releases; every sub-patch must match or the build fails, so a broken assumption surfaces at build time, never at runtime. When an update breaks a patch, only that file needs updating - each patch source documents the anchor strings it matches on. Discovery walks the three directories and applies the patches in basename order; `scripts/apply_patches.py` pins the total in `EXPECTED_PATCH_COUNT` and fails the build if it finds a different number, so a patch that is added or dropped is always a deliberate edit.

Every patch here modifies the bundle. When a behavior becomes native in the official build, the patch that injected it is removed; we don't keep assert-only patches.

> **We keep this set as small as possible.** On each upstream release every patch is re-audited against a fresh unpatched bundle - a patch that still applies cleanly isn't proof it's still needed, so each must be confirmed to genuinely do work (or the feature live-tested) to stay. When Anthropic ships a behavior natively, the patch is removed outright. `ls patches/*/*.nim` is the authoritative list of everything in the tree.

Each row below says what a patch does and why you would want it. The mechanism - which strings it anchors on, which sub-patches it applies - is documented in the patch source itself; click the filename.

## Community features

**9 patches**, each with a switch in Settings → **Extra** → **Community Features**. They reshape first-party surfaces, so they are asked for rather than assumed: turning one off is a full retreat to upstream's own behavior. Off by default, except the theme picker.

| Patch | What it does & why it exists |
|-------|------------------------------|
| [`add_feature_theme_picker.nim`](patches/community/add_feature_theme_picker.nim) | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> opens a [searchable gallery](themes/README.md#theme-picker-ctrlshiftt) of every bundled theme; one click applies it live in every open window and saves your choice |
| [`add_feature_cowork_glow.nim`](patches/community/add_feature_cowork_glow.nim) | Holds the pulsing Cowork glow still - it otherwise never stops redrawing, which costs real power on laptops and machines without much graphics muscle |
| [`add_feature_diff_views.nim`](patches/community/add_feature_diff_views.nim) | Adds a scope dropdown to the Code tab's diff panel (working tree, branch changes, latest turn), an expand/collapse-all button, and picks the base branch your work actually forked from |
| [`add_feature_diff_views_bridge.nim`](patches/community/add_feature_diff_views_bridge.nim) | The narrow preload bridge the diff dropdown talks through: one fixed channel per call, because the page behind it is remote code |
| [`add_feature_panel_tabs.nim`](patches/community/add_feature_panel_tabs.nim) | Turns the Code tab's side panels into a tab strip instead of a shrinking split, so each panel gets the full width and keeps its state when you switch away |
| [`add_feature_panel_tabs_bridge.nim`](patches/community/add_feature_panel_tabs_bridge.nim) | The narrow preload bridge the tab strip talks through: one fixed channel per call, because the page behind it is remote code |
| [`add_feature_files_quick_open.nim`](patches/community/add_feature_files_quick_open.nim) | <kbd>Ctrl</kbd>+<kbd>P</kbd> on the Code tab opens a VS Code-style quick-open box over the Files panel; arrow keys or mouse, <kbd>Enter</kbd> opens the file as a tab in the panel, `:42` jumps to a line, an empty query lists recently opened files |
| [`add_feature_files_quick_open_bridge.nim`](patches/community/add_feature_files_quick_open_bridge.nim) | The narrow preload bridge the quick-open box talks through: one fixed channel per call, because the page behind it is remote code |
| [`add_feature_files_quick_open_worker.nim`](patches/community/add_feature_files_quick_open_worker.nim) | Teaches Anthropic's fuzzy file index VS Code's space-separated pieces - `user service` finds `user-service.spec.ts`, in any word order. Upstream treats the space as a character to find and returns nothing. Also fixes the Files panel's own filter and the composer's `@` picker. Gated by an env var read at worker start, so flipping the switch reaches the file index on its next start (after a restart) |

Panel tabs and Files quick open depend on DOM anchors in remote claude.ai code; they are inventoried with re-derivation recipes in [`baseline/PANEL_TABS_ANCHORS.md`](baseline/PANEL_TABS_ANCHORS.md) and [`baseline/FILES_QUICK_OPEN_ANCHORS.md`](baseline/FILES_QUICK_OPEN_ANCHORS.md) and re-validated on each upstream bump.

## Core infrastructure

**7 patches**, always on. These are what the rest is built on: the Extra settings pages, the theme engine behind them, the local feature-flag override mechanism, and the plumbing that keeps multiple profiles apart.

| Patch | What it does & why it exists |
|-------|------------------------------|
| [`add_feature_custom_themes.nim`](patches/core/add_feature_custom_themes.nim) | The theme engine: 97 bundled light/dark palettes, each with its own loading spinner, applied live to every open window. Upstream has no theming beyond the light/dark toggle |
| [`add_feature_extra_settings.nim`](patches/core/add_feature_extra_settings.nim) | The **Extra** group in the app's own Settings dialog - Themes, Community Features, Anthropic Features and [Deployment](README.md#third-party--enterprise-inference) - and the main-process half that reads and writes what those panels show |
| [`add_feature_extra_settings_bridge.nim`](patches/core/add_feature_extra_settings_bridge.nim) | The narrow preload bridge the Extra panels talk through: one fixed channel per call, because the Settings dialog is remote code |
| [`add_growthbook_overrides.nim`](patches/core/add_growthbook_overrides.nim) | Lets you [override Anthropic's feature flags](docs/feature-flags.md) from your own config file. Upstream has no local override mechanism - the flag cache is encrypted |
| [`fix_profile_url_routing.nim`](patches/core/fix_profile_url_routing.nim) | Routes an SSO callback back to the [profile](docs/profiles.md) that started the login, instead of landing it in whichever profile owns the URL scheme |
| [`fix_profile_window_title.nim`](patches/core/fix_profile_window_title.nim) | Puts the profile name in the window title (`Claude (work)`), so profiles are tellable apart in Alt-Tab and the taskbar |
| [`fix_quick_entry_cli_toggle.nim`](patches/core/fix_quick_entry_cli_toggle.nim) | Makes `claude-desktop --toggle` open [Quick Entry](docs/quick-entry.md) in milliseconds over a socket instead of spawning Electron - fast enough to bind to a global hotkey. The same socket takes one short command per connection, so `claude-desktop --reload-theme` makes the running app re-read its [theme](docs/themes.md) config and re-apply it, replying with a one-line JSON result |

## Linux compatibility

**31 patches**, always on and nothing to configure. Upstream ships the same JS bundle to every platform; these open `darwin`/`win32`-only gates for Linux, or fix behavior that only misfires in a Linux desktop environment. Each one is either a feature you would otherwise not have at all, or a bug you would otherwise hit.

| Patch | What it does & why it exists |
|-------|------------------------------|
| [`enable_local_agent_mode.nim`](patches/linux/enable_local_agent_mode.nim) | Enables Claude Code and Local Agent Mode on the host; upstream reports them unavailable unless the platform is macOS or Windows |
| [`fix_app_quit.nim`](patches/linux/fix_app_quit.nim) | Fixes the app hanging on exit - the second quit call upstream makes during cleanup is a no-op on Linux |
| [`fix_browse_files_linux.nim`](patches/linux/fix_browse_files_linux.nim) | Lets the file dialog pick a directory on Linux; upstream offers that only on macOS, though Electron supports it everywhere |
| [`fix_browser_tools_linux.nim`](patches/linux/fix_browser_tools_linux.nim) | Enables Chrome browser tools on Linux, and finds Chromium, Brave, Vivaldi and Opera as well as upstream's Chrome and Edge |
| [`fix_builtin_mcp_browser_env.nim`](patches/linux/fix_builtin_mcp_browser_env.nim) | Gives built-in MCP servers the display and session variables they need to open a browser for OAuth; upstream's filtered environment has none of them ([#139](https://github.com/patrickjaja/claude-desktop-extra/issues/139)) |
| [`fix_builtin_mcp_open_url_handler.nim`](patches/linux/fix_builtin_mcp_open_url_handler.nim) | Lets a built-in MCP server ask the app to open an OAuth page, rather than trying to launch a browser from inside its own child process |
| [`fix_computer_use_linux.nim`](patches/linux/fix_computer_use_linux.nim) | Enables [Computer Use](README.md#computer-use) and routes it to the bundled bridge that matches your session. Upstream gates it to macOS/Windows and ships no Linux backend at all |
| [`fix_cowork_firmware_paths_linux.nim`](patches/linux/fix_cowork_firmware_paths_linux.nim) | Finds QEMU firmware and virtiofsd outside Debian's paths, so Cowork stops reporting "Download failed" on Fedora, RHEL, Arch and NixOS ([#177](https://github.com/patrickjaja/claude-desktop-extra/issues/177)) |
| [`fix_cowork_font.nim`](patches/linux/fix_cowork_font.nim) | Applies your chat font to the Cowork tab, which fell back to a serif face because upstream sets the font only when the Chat view mounts |
| [`fix_cross_device_rename.nim`](patches/linux/fix_cross_device_rename.nim) | Lets downloads move from `/tmp` into your config directory when the two sit on different filesystems, where a plain rename fails |
| [`fix_detected_projects_linux.nim`](patches/linux/fix_detected_projects_linux.nim) | Enables project detection on Linux and looks for VS Code, Cursor and Zed state where they actually keep it, instead of hardcoded macOS paths |
| [`fix_dock_bounce.nim`](patches/linux/fix_dock_bounce.nim) | Stops the app demanding attention in the taskbar on KDE and GNOME, which is what upstream's macOS dock bounce turns into. Scoped to the attention APIs only, so bringing the window to the front still works |
| [`fix_epitaxy_autoscroll.nim`](patches/linux/fix_epitaxy_autoscroll.nim) | Keeps the Code and Cowork transcript following a running response; a few pixels of routine drift while streaming used to unpin it for good |
| [`fix_ion_dist_linux.nim`](patches/linux/fix_ion_dist_linux.nim) | Adds the Linux org-plugins path to the third-party configuration app, which knew only macOS and Windows locations |
| [`fix_marketplace_linux.nim`](patches/linux/fix_marketplace_linux.nim) | Makes plugin operations work on Linux, and lists your home-scoped CLI plugins as Personal Plugins |
| [`fix_native_frame.nim`](patches/linux/fix_native_frame.nim) | Gives Linux the integrated titlebar upstream builds only for Windows; opt back out with `--native-titlebar` |
| [`fix_office365_mcp_open_url.nim`](patches/linux/fix_office365_mcp_open_url.nim) | Has the bundled Microsoft 365 server ask the app to open its sign-in page; on KDE the direct attempt silently did nothing until the login timed out ([#139](https://github.com/patrickjaja/claude-desktop-extra/issues/139)) |
| [`fix_open_in_editor_linux.nim`](patches/linux/fix_open_in_editor_linux.nim) | Makes "Open in VS Code / Cursor / Zed / Windsurf" find your editor; the check upstream uses answers only on macOS and Windows, so Linux editors always looked missing |
| [`fix_process_argv_renderer.nim`](patches/linux/fix_process_argv_renderer.nim) | Fixes Dispatch responses not rendering: the Claude Code web bundle reads `process.argv`, which the preload never exposed |
| [`fix_quick_entry_app_id.nim`](patches/linux/fix_quick_entry_app_id.nim) | Gives Quick Entry its own Wayland app id, so shell-extension rules can target it separately from the main window ([#39](https://github.com/patrickjaja/claude-desktop-extra/issues/39)) |
| [`fix_quick_entry_position.nim`](patches/linux/fix_quick_entry_position.nim) | Opens [Quick Entry](docs/quick-entry.md) on the monitor your cursor is on rather than the primary display, and focuses the input ready to type |
| [`fix_quick_entry_ready_wayland.nim`](patches/linux/fix_quick_entry_ready_wayland.nim) | Stops Quick Entry hanging on native Wayland, where the ready event never fires for a frameless transparent window |
| [`fix_quick_entry_wayland_blur_guard.nim`](patches/linux/fix_quick_entry_wayland_blur_guard.nim) | Stops Quick Entry vanishing the instant it opens on Wayland, which emits focus-loss events the window never actually earned |
| [`fix_renderer_gone_suppressed_log.nim`](patches/linux/fix_renderer_gone_suppressed_log.nim) | Records renderer crashes upstream silently swallows, so a kernel out-of-memory kill leaves a trace in the log instead of nothing at all ([#128](https://github.com/patrickjaja/claude-desktop-extra/issues/128)) |
| [`fix_second_instance_diag.nim`](patches/linux/fix_second_instance_diag.nim) | Records what happens when you launch Claude while it is already running - the argv that arrived, whether the compositor forwarded an activation token, and whether the window actually became visible and focused. Upstream logs nothing on that path, so a window that fails to come back leaves no evidence |
| [`fix_sensitive_dirs_linux.nim`](patches/linux/fix_sensitive_dirs_linux.nim) | Adds the Linux keyring, certificate and autostart directories to the sandbox block list, which carried macOS and Windows entries only |
| [`fix_startup_settings.nim`](patches/linux/fix_startup_settings.nim) | Hides the main window when session restore relaunches the app, but only for people who asked for a hidden start; keeps "Start at login" entries separate per profile; and points the autostart entry at the launcher so a login launch gets the same Wayland, PATH and profile setup as a manual one |
| [`fix_tray_icon_theme.nim`](patches/linux/fix_tray_icon_theme.nim) | Always uses the light tray glyph on Linux; upstream's heuristic left the icon invisible for anyone on a light desktop theme |
| [`fix_updater_state_linux.nim`](patches/linux/fix_updater_state_linux.nim) | Stops a crash in the update UI: auto-update is off on Linux, so the fields the frontend reads unchecked were never set |
| [`fix_utility_process_kill.nim`](patches/linux/fix_utility_process_kill.nim) | Sends `SIGKILL` to a stuck helper process once the timeout passes; upstream re-sends `SIGTERM`, which a hung process ignores and the app never exits |
| [`fix_window_bounds.nim`](patches/linux/fix_window_bounds.nim) | Re-fits the app's content when the window is resized, maximized or snapped, which otherwise left stale geometry behind on Linux |

Two of these embed regression assertions alongside the work they inject: `enable_local_agent_mode.nim` (real-platform reporting to claude.ai, the native Linux Cowork bundle path, SSH MCP passthrough) and `fix_startup_settings.nim` (native XDG autostart read/write).

## Adding your own feature

Every feature on this page started as one `.nim` file. If Claude Desktop doesn't behave the way you need it to on your desktop, you can change that - and the change is small enough that you don't have to make it by hand: **spin up your favorite coding agent in a clone of this repo. The repo's [AGENTS.md](AGENTS.md) plus this section is enough context to add a patch end to end.** The repo also ships [skills](.claude/skills/) that Claude Code picks up automatically - `/linux` loads the Linux-compatibility reference (session managers, glibc floors, known gotchas) and triggers on any `patches/` edit, so this project's compatibility rules are enforced while you work; `/architecture` explains how the official build and our patches fit together.

Pick where it goes: `patches/community/` if users should be able to turn it off - it gets a switch in Settings → **Extra** → **Community Features** for the cost of one `renderToggleRow` spec, and the setting is persisted per profile in `<userData>/claude-desktop-extra.jsonc`/`.json`, so people change their mind without rebuilding anything. `patches/core/` if it is always-on infrastructure others build on, and `patches/linux/` if it is a compatibility fix that everyone needs and nobody should have to find. The five steps below cover the community case; drop steps 2 and 3 for the other two. `add_feature_panel_tabs.nim` and its `js/panel_tabs_*.js` modules are the reference implementation to copy from.

1. **Write the patch.** Create `patches/community/<name>.nim` with the usual `# @patch-target:` and `# @patch-type: nim` headers. Match minified code with `[\w$]+` wildcards and capture/replace rather than hardcoded names, and keep the real logic in a `js/` file embedded with `staticRead("../../js/<name>_main.js")` so it stays readable and testable. Every sub-patch must fail loud and the "already patched" branch must assert your own injected result is present - see the patch strictness rules in [AGENTS.md](AGENTS.md#5b-patch-strictness-rules). If the patch embeds any `js/` file, add a prerequisite line for it in `patches/Makefile`, otherwise editing the JS will not rebuild the binary.
2. **Give it one config key.** Pick a single top-level key in `<userData>/claude-desktop-extra.jsonc` (hand-owned, wins) / `.json` (written by the UI), named after the feature - `panelTabs`, `diffViewModes`, `coworkGlow`, `themePicker`. Read it leniently at runtime: a missing key means the default, a hand-set key in the `.jsonc` locks the switch. `PREF_KEY` in [`js/panel_tabs_main.js`](js/panel_tabs_main.js) is the reference reader.
3. **Add the switch.** Three small pieces: an IPC read/set handler pair in your own patch (`cdb-tabs:pref-read` / `cdb-tabs:pref-set` is the pattern), two wrapper methods in [`js/extra_settings_bridge.js`](js/extra_settings_bridge.js), and one `renderToggleRow` spec in the Community Features panel of [`js/extra_settings_page.js`](js/extra_settings_page.js). The row handles the locked-by-`.jsonc` state and the restart notice for you.
4. **Register it.** Bump `EXPECTED_PATCH_COUNT` in `scripts/apply_patches.py` - the orchestrator refuses to run if discovery and that number disagree.
5. **Document it.** Add a row to the Community features table above stating what the patch does and why it exists, and a `CHANGELOG.md` entry.

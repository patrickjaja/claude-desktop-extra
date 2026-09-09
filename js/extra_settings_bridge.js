/*
 * extra_settings_bridge.js - the ONLY channel the claude.ai page can use to
 * reach the Extra settings area. Injected into .vite/build/mainView.js (the
 * preload of the mainView WebContentsView) by
 * patches/add_feature_extra_settings_bridge.nim.
 *
 * mainView.js is a sandboxed preload: require("electron") is available for this
 * subset, nothing else is.
 *
 * SECURITY: the page behind this preload is REMOTE code (claude.ai). Therefore
 * every method below is a FIXED wrapper around one FIXED channel name - there is
 * deliberately no generic invoke(channel, ...) passthrough that would let remote
 * code reach arbitrary ipcMain handlers. Argument shapes are re-validated on the
 * main side (patches/add_feature_extra_settings.nim); nothing here is trusted.
 *
 * Every channel resolves to a plain {ok:...} record so the page can render a
 * real message instead of swallowing a rejected promise.
 */
"use strict";

(function () {
  var electron = require("electron");
  var contextBridge = electron.contextBridge;
  var ipcRenderer = electron.ipcRenderer;
  if (!contextBridge || !ipcRenderer) return;

  contextBridge.exposeInMainWorld("cdbExtra", {
    // __cdb_extra_bridge
    version: 1,

    // Themes. themes-list is our own reduced projection (name/displayName/
    // source/swatches) so the full token maps of ~90 palettes never cross into
    // the remote page; apply/active are the theme picker's own channels.
    themesList: function () {
      return ipcRenderer.invoke("cdb-extra:themes-list");
    },
    themesActive: function () {
      return ipcRenderer.invoke("cdb-themes:active");
    },
    themesApply: function (name) {
      return ipcRenderer.invoke("cdb-themes:apply", name);
    },
    // themeOverlay: the theme merged over whatever is picked, the themes that
    // can be, and the switch. All three are the theme picker's channels; the
    // main side re-validates the name ("" = off) and answers
    // {ok:false,error:"not supported by this build"} on an engine without it.
    themesOverlay: function () {
      return ipcRenderer.invoke("cdb-themes:overlay");
    },
    themesOverlays: function () {
      return ipcRenderer.invoke("cdb-themes:overlays");
    },
    themesSetOverlay: function (name) {
      return ipcRenderer.invoke("cdb-themes:set-overlay", String(name || ""));
    },

    // GrowthBook feature flags.
    flagsCatalog: function () {
      return ipcRenderer.invoke("cdb-flags:catalog");
    },
    flagsRead: function () {
      return ipcRenderer.invoke("cdb-flags:read");
    },
    flagsSet: function (id, value) {
      return ipcRenderer.invoke("cdb-flags:set", id, value);
    },
    flagsUnset: function (id) {
      return ipcRenderer.invoke("cdb-flags:unset", id);
    },

    // Cowork glow. set() takes only the fixed strings "pulse"/"calm"; the main
    // side re-validates and rejects anything else, so the page cannot smuggle a
    // stylesheet or an arbitrary opacity through here.
    glowRead: function () {
      return ipcRenderer.invoke("cdb-glow:read");
    },
    glowSet: function (mode) {
      return ipcRenderer.invoke("cdb-glow:set", String(mode));
    },

    // Theme picker (Ctrl+Shift+T). The window and the hotkey are owned by
    // patches/community/add_feature_theme_picker.nim; these two channels only
    // read and persist the pref, which that patch re-reads on every press.
    // set() takes a plain boolean and the main side re-validates the type.
    pickerRead: function () {
      return ipcRenderer.invoke("cdb-picker:read");
    },
    pickerSet: function (enabled) {
      return ipcRenderer.invoke("cdb-picker:set", enabled === true);
    },

    // Diff view modes (the Code tab's diff-scope dropdown). BOTH channels are
    // owned by patches/add_feature_diff_views.nim, not by the settings patch:
    // that patch reads and writes `diffViewModes` and applies it live, the same
    // cross-patch arrangement as cdb-themes:apply above. set() takes a plain
    // boolean and the main side re-validates the type.
    diffViewsRead: function () {
      return ipcRenderer.invoke("cdb-diff:pref-read");
    },
    diffViewsSet: function (enabled) {
      return ipcRenderer.invoke("cdb-diff:pref-set", enabled === true);
    },

    // Panel tabs (the Code tab's side-panel tab strip). BOTH channels are owned
    // by patches/add_feature_panel_tabs.nim, not by the settings patch - the same
    // cross-patch arrangement as diffViewsRead/Set above. set() takes a plain
    // boolean and the main side re-validates the type.
    panelTabsRead: function () {
      return ipcRenderer.invoke("cdb-tabs:pref-read");
    },
    panelTabsSet: function (enabled) {
      return ipcRenderer.invoke("cdb-tabs:pref-set", enabled === true);
    },

    // Files quick open (Ctrl+P over the Code tab's Files panel). BOTH channels are
    // owned by patches/community/add_feature_files_quick_open.nim, not by the
    // settings patch - the same cross-patch arrangement as panelTabsRead/Set.
    quickOpenRead: function () {
      return ipcRenderer.invoke("cdb-qopen:pref-read");
    },
    quickOpenSet: function (enabled) {
      return ipcRenderer.invoke("cdb-qopen:pref-set", enabled === true);
    },

    // Frameless main window, no window-control buttons, no shadow. BOTH channels
    // are owned by patches/community/add_feature_window_controls.nim, not by the
    // settings patch - the same cross-patch arrangement as panelTabsRead/Set.
    // The pref is read when the window is created, so a flip here only reaches
    // the next start; the page half says so and offers a restart. set() takes a
    // plain boolean and the main side re-validates the type.
    windowControlsRead: function () {
      return ipcRenderer.invoke("cdb-wc:pref-read");
    },
    windowControlsSet: function (enabled) {
      return ipcRenderer.invoke("cdb-wc:pref-set", enabled === true);
    },

    // Native titlebar - the third window mode, owned by the same patch and read
    // at the same moment (window creation). It WINS over windowControls* above;
    // that precedence lives in the main side, the page only reports it.
    nativeTitlebarRead: function () {
      return ipcRenderer.invoke("cdb-wc:native-read");
    },
    nativeTitlebarSet: function (enabled) {
      return ipcRenderer.invoke("cdb-wc:native-set", enabled === true);
    },

    // Deployment mode (1P / 3P) and the third-party configuration the app boots
    // from. deployMode() takes only "1p"/"3p"; deploySet() only keys the main
    // side finds in its own catalog, and stored secrets never come back through
    // deployRead()/deployRaw() - they read as a placeholder the main side maps
    // back to "keep what is on disk".
    deployRead: function () {
      return ipcRenderer.invoke("cdb-deploy:read");
    },
    deployMode: function (mode) {
      return ipcRenderer.invoke("cdb-deploy:mode", String(mode));
    },
    deploySet: function (key, value) {
      return ipcRenderer.invoke("cdb-deploy:set", String(key), value);
    },
    deployClear: function () {
      return ipcRenderer.invoke("cdb-deploy:clear");
    },
    deployApply: function (id) {
      return ipcRenderer.invoke("cdb-deploy:apply", String(id || ""));
    },
    deployRaw: function () {
      return ipcRenderer.invoke("cdb-deploy:raw");
    },
    deploySaveRaw: function (text) {
      return ipcRenderer.invoke("cdb-deploy:save-raw", String(text));
    },

    // Open one of the files this package writes, or show it in the file manager.
    // The first argument is a fixed LOCATION NAME the main side resolves to a
    // path itself - a page-supplied path would be a way to have the desktop open
    // an arbitrary file.
    reveal: function (name, how) {
      return ipcRenderer.invoke("cdb-extra:reveal", String(name), String(how || "open"));
    },

    // Resolved config file paths, shown in both panels.
    paths: function () {
      return ipcRenderer.invoke("cdb-extra:paths");
    },

    // app.relaunch() + app.exit(0).
    appRelaunch: function () {
      return ipcRenderer.invoke("cdb-app:relaunch");
    },

    // One-line diagnostics into logs/claude-patches.log (deduped main-side).
    diag: function (message) {
      return ipcRenderer.invoke("cdb-extra:diag", String(message));
    }
  });
})();

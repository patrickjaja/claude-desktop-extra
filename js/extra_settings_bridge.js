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

  // The window transparency level: a finite number in 0..0.9, nothing else.
  function levelOk(v) {
    return typeof v === "number" && isFinite(v) && v >= 0 && v <= 0.9;
  }
  var BAD_LEVEL = "transparency must be a number from 0 to 0.9";

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

    // Custom models (Anthropic-compatible endpoints in the Code model picker).
    // BOTH channels are owned by patches/community/add_feature_custom_models.nim,
    // not by the settings patch - the same cross-patch arrangement as
    // panelTabsRead/Set. set() takes a plain boolean and the main side
    // re-validates the type; the providers and models are edited through the
    // customModels* methods below (Settings > Extra > Models).
    customModelsRead: function () {
      return ipcRenderer.invoke("cdb-cm:pref-read");
    },
    customModelsSet: function (enabled) {
      return ipcRenderer.invoke("cdb-cm:pref-set", enabled === true);
    },
    // The Models panel: the full configuration (never a key value), and the
    // edits it makes. Each call carries plain data; the main side validates
    // every field and refuses a provider that lives in the hand-edited .jsonc.
    customModelsConfig: function () {
      return ipcRenderer.invoke("cdb-cm:config-read");
    },
    customModelsProviderSet: function (provider) {
      return ipcRenderer.invoke("cdb-cm:provider-set", provider && typeof provider === "object" ? {
        id: String(provider.id || ""), baseUrl: String(provider.baseUrl || ""), apiKey: String(provider.apiKey || ""),
        preset: String(provider.preset || ""), modelsUrl: String(provider.modelsUrl || ""),
        effort: Array.isArray(provider.effort) ? provider.effort.map(String) : undefined,
        // Absent stays absent: the main process keeps the stored values then.
        userAgent: typeof provider.userAgent === "string" ? provider.userAgent : undefined,
        stripBillingHeader: typeof provider.stripBillingHeader === "boolean" ? provider.stripBillingHeader : undefined
      } : {});
    },
    customModelsWebSearchSet: function (value) {
      return ipcRenderer.invoke("cdb-cm:websearch-set", String(value || ""));
    },
    // The CLI's "small/fast model" slot (ANTHROPIC_SMALL_FAST_MODEL): WebFetch
    // page synthesis, the mid-turn intent classifier, and - when the web-search
    // model above is unset - the web-search sub-request. "" for the CLI's own
    // small default, else a custom alias or Anthropic id.
    customModelsSmallFastSet: function (value) {
      return ipcRenderer.invoke("cdb-cm:smallfast-set", String(value || ""));
    },
    // The default sub-agent model ("" = the CLI's own) and the system-prompt
    // line switch - both read when a session opens.
    customModelsSubagentSet: function (value) {
      return ipcRenderer.invoke("cdb-cm:subagent-set", String(value || ""));
    },
    customModelsAnnounceSet: function (value) {
      return ipcRenderer.invoke("cdb-cm:announce-set", value === true);
    },
    customModelsProviderDelete: function (id) {
      return ipcRenderer.invoke("cdb-cm:provider-delete", String(id || ""));
    },
    customModelsModelSet: function (providerId, model) {
      return ipcRenderer.invoke("cdb-cm:model-set", String(providerId || ""), model && typeof model === "object" ? {
        id: String(model.id || ""), name: String(model.name || ""), description: String(model.description || ""),
        badge: String(model.badge || ""), thinking: model.thinking !== false, vision: model.vision !== false,
        webSearch: model.webSearch !== false, context: String(model.context || ""), effortDefault: String(model.effortDefault || ""),
        // The model's sub-agent type: on unless unticked; the three texts
        // are optional and empty means the generated one.
        agent: model.agent !== false, agentName: String(model.agentName || ""),
        agentDescription: String(model.agentDescription || ""), agentPrompt: String(model.agentPrompt || "")
      } : {});
    },
    customModelsModelDelete: function (providerId, modelId) {
      return ipcRenderer.invoke("cdb-cm:model-delete", String(providerId || ""), String(modelId || ""));
    },
    customModelsTest: function (id) {
      return ipcRenderer.invoke("cdb-cm:provider-test", String(id || ""));
    },
    customModelsModelsList: function (providerId) {
      return ipcRenderer.invoke("cdb-cm:models-list", String(providerId || ""));
    },
    customModelsEffortProbe: function (providerId, modelId) {
      return ipcRenderer.invoke("cdb-cm:effort-probe", String(providerId || ""), String(modelId || ""));
    },

    // Allow non-Anthropic models through a third-party gateway. BOTH channels
    // are owned by patches/community/add_feature_allow_non_anthropic_models.nim, not by the
    // settings patch - the same cross-patch arrangement as quickOpenRead/Set.
    // set() takes a plain boolean and the main side re-validates the type.
    allowNonAnthropicModelsRead: function () {
      return ipcRenderer.invoke("cdb-mb:pref-read");
    },
    allowNonAnthropicModelsSet: function (enabled) {
      return ipcRenderer.invoke("cdb-mb:pref-set", enabled === true);
    },

    // Developer tools (upstream's developer_settings.json opt-in). BOTH channels
    // are owned by patches/community/add_feature_dev_tools_toggle.nim, not by
    // the settings patch - the same cross-patch arrangement as above.
    devToolsRead: function () {
      return ipcRenderer.invoke("cdb-dt:pref-read");
    },
    devToolsSet: function (enabled) {
      return ipcRenderer.invoke("cdb-dt:pref-set", enabled === true);
    },

    // Load large sessions in full (transcript load limits). BOTH channels are
    // owned by patches/community/add_feature_transcript_limits.nim, not by the
    // settings patch - the same cross-patch arrangement as quickOpenRead/Set.
    transcriptLimitsRead: function () {
      return ipcRenderer.invoke("cdb-tlimits:pref-read");
    },
    transcriptLimitsSet: function (enabled) {
      return ipcRenderer.invoke("cdb-tlimits:pref-set", enabled === true);
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

    // Transparent main window - owned by patches/community/add_feature_window_transparency.nim.
    // Constructor-only like the window modes above, so a flip reaches the next start.
    windowTransparencyRead: function () {
      return ipcRenderer.invoke("cdb-wt:pref-read");
    },
    windowTransparencySet: function (enabled) {
      return ipcRenderer.invoke("cdb-wt:pref-set", enabled === true);
    },
    // The transparency slider: preview() re-styles the window live and writes
    // nothing, set() also saves windowTransparencyLevel. Both take only a finite
    // number in 0..0.9 - anything else is refused here without an IPC round
    // trip, and the main side re-validates and clamps.
    windowTransparencyLevelPreview: function (value) {
      if (!levelOk(value)) return Promise.resolve({ ok: false, error: BAD_LEVEL });
      return ipcRenderer.invoke("cdb-wt:level-preview", value);
    },
    windowTransparencyLevelSet: function (value) {
      if (!levelOk(value)) return Promise.resolve({ ok: false, error: BAD_LEVEL });
      return ipcRenderer.invoke("cdb-wt:level-set", value);
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

    // Computer Use on a background display (issue #300). The key lives in our
    // settings file and the executor reads it at every Computer Use start; all
    // channels are owned by the settings patch. set() takes {enabled, kind,
    // display} only - never an env map, which only a hand-edited file may carry.
    // probe/thumbnail/test take a kind ("x11"/"wlroots") and a display; the
    // main side re-validates both and refuses the user's own desktop. An empty
    // kind/display in test() means the configured display.
    cuBackgroundRead: function () {
      return ipcRenderer.invoke("cdb-cubg:read");
    },
    cuBackgroundSet: function (cfg) {
      return ipcRenderer.invoke("cdb-cubg:set", cfg && typeof cfg === "object" ? {
        enabled: cfg.enabled === true, kind: String(cfg.kind || ""), display: String(cfg.display || "")
      } : {});
    },
    cuBackgroundCandidates: function () {
      return ipcRenderer.invoke("cdb-cubg:candidates");
    },
    cuBackgroundProbe: function (kind, display) {
      return ipcRenderer.invoke("cdb-cubg:probe", String(kind || ""), String(display || ""));
    },
    cuBackgroundThumbnail: function (kind, display) {
      return ipcRenderer.invoke("cdb-cubg:thumbnail", String(kind || ""), String(display || ""));
    },
    cuBackgroundTest: function (kind, display) {
      return ipcRenderer.invoke("cdb-cubg:test", String(kind || ""), String(display || ""));
    },
    cuBackgroundTools: function () {
      return ipcRenderer.invoke("cdb-cubg:tools");
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

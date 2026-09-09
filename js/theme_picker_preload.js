/*
 * theme_picker_preload.js - the only bridge between the theme picker page and
 * the main process. Written to
 *   <userData>/cdb-theme-picker/preload.js
 * by patches/add_feature_theme_picker.nim when the window opens, and loaded with
 * contextIsolation:true, nodeIntegration:false, sandbox:true. A sandboxed preload
 * may still require("electron") for this subset.
 *
 * Every channel returns a plain {ok:...} record so the page can show a real
 * message instead of swallowing a rejected promise.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cdbThemes", {
  list: function () {
    return ipcRenderer.invoke("cdb-themes:list");
  },
  active: function () {
    return ipcRenderer.invoke("cdb-themes:active");
  },
  apply: function (name) {
    return ipcRenderer.invoke("cdb-themes:apply", name);
  },
  close: function () {
    return ipcRenderer.invoke("cdb-themes:close");
  },
  // themeOverlay: what is merged over the picked theme, the themes that can be,
  // and the switch. setOverlay("") turns it off. A build whose engine has no
  // overlay support answers {ok:false,error:"not supported by this build"}.
  overlay: function () {
    return ipcRenderer.invoke("cdb-themes:overlay");
  },
  overlays: function () {
    return ipcRenderer.invoke("cdb-themes:overlays");
  },
  setOverlay: function (name) {
    return ipcRenderer.invoke("cdb-themes:set-overlay", String(name || ""));
  },
});

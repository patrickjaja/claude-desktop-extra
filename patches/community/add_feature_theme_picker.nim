# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Theme picker window for Claude Desktop on Linux (Ctrl+Shift+T).
#
# A browsable, searchable gallery of every theme the custom-themes patch knows
# about (user themes, built-ins, and the bundled community palette collection).
# Clicking a card applies it live and saves it, so switching palettes needs
# neither a restart nor an editor.
#
# This patch owns only the WINDOW and the IPC. All theme knowledge lives in
# patches/core/add_feature_custom_themes.nim, which installs
# `globalThis.__cdbThemes` ({version,list,active,apply,overlay,overlays,
# setOverlay}) on every Linux start. If that registry is missing, the channels
# below answer {ok:false,error:...} and the page shows the reason instead of a
# dead grid. The three overlay channels additionally answer
# {ok:false,error:"not supported by this build"} when the registry predates
# version 3 (no overlays()/setOverlay()); the page then simply draws no overlay
# bar.
#
# Open mechanism (stable Electron APIs only, no knowledge of the app bundle):
#   app.on("web-contents-created") -> wc.on("before-input-event")
# Ctrl+Shift+T on keyDown opens (or focuses) a singleton BrowserWindow. Events
# from the picker's own window are ignored -- the page handles the shortcut
# itself so the same keystroke closes it.
#
# The shortcut can be switched off with `"themePicker": false` in
# claude-desktop-extra.jsonc/.json (Settings -> Extra -> Community Features
# writes it). The key is read from the config file on every press, so the switch
# needs no restart; absent means enabled. That read is deliberately self-contained
# -- the picker must keep working in a build without the Extra settings patch.
#
# The page and its preload are staticRead from js/ and written to
#   <userData>/cdb-theme-picker/{picker.html,preload.js}
# on every open (never stale after an upgrade), then loaded with loadFile +
# contextIsolation:true, nodeIntegration:false, sandbox:true. The custom-themes
# patch skips URLs containing "cdb-theme-picker", so the app's theme CSS is
# never injected into the picker -- it styles itself.
#
# Break risk: VERY LOW -- No regex on minified app code. Uses only the
# "use strict;" prefix (stable) and standard Electron/Node APIs.

import std/[os, strutils, json]

const PICKER_HTML = staticRead("../../js/theme_picker_page.html")
const PICKER_PRELOAD = staticRead("../../js/theme_picker_preload.js")

const PICKER_JS_HEAD =
  """;(function(){
if(process.platform!=="linux")return;
var _electron=require("electron"),_app=_electron.app,_bw=_electron.BrowserWindow,_ipc=_electron.ipcMain;
var _path=require("path"),_fs=require("fs");
var __cdbPk_marker="__cdb_theme_picker";
function __cdbPk_log(m){(globalThis.__cdbDiag||console.log)("[ThemePicker] "+m)}
var __cdbPk_html="""

const PICKER_JS_MID =
  """;
var __cdbPk_preload="""

const PICKER_JS_TAIL =
  """;
var __cdbPk_win=null;
// The opt-out, read straight from this package's config files. Self-contained on
// purpose: the Extra settings patch writes the key but the shortcut must keep
// working in a build that does not carry that patch, so nothing here depends on
// it. Comment/trailing-comma stripper as in js/panel_tabs_main.js - whole quoted
// strings are matched FIRST and passed through, or a "//" inside a string value
// truncates the file.
var __cdbPk_JSONC="claude-desktop-extra.jsonc",__cdbPk_JSON="claude-desktop-extra.json";
function __cdbPk_strip(s){return String(s).replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g,function(m,str){return str?str:""}).replace(/,(\s*[}\]])/g,"$1")}
function __cdbPk_key(file){try{var c=JSON.parse(__cdbPk_strip(_fs.readFileSync(file,"utf8"))||"{}");if(c&&typeof c==="object"&&!Array.isArray(c))return c.themePicker}catch(e){}return undefined}
// Read on every press rather than cached: the settings page writes the file
// directly, and a chord is rare enough that two stats cost nothing. The .jsonc is
// the human-owned file and wins, like every other consumer of this config. Absent
// in both means ENABLED, so an install that never touched the key keeps its
// shortcut.
function __cdbPk_enabled(){
try{(globalThis.__cdbCfgMigrate||function(){})()}catch(e){}
var d;try{d=_app.getPath("userData")}catch(e){return true}
if(!d)return true;
var j=__cdbPk_key(_path.join(d,__cdbPk_JSONC));
if(typeof j==="boolean")return j;
var k=__cdbPk_key(_path.join(d,__cdbPk_JSON));
if(typeof k==="boolean")return k;
return true;
}
function __cdbPk_api(){return globalThis.__cdbThemes||null}
function __cdbPk_noEngine(){return {ok:false,error:"the custom themes patch did not install globalThis.__cdbThemes in this build"}}
function __cdbPk_noOverlay(){return {ok:false,error:"not supported by this build"}}
function __cdbPk_dir(){return _path.join(_app.getPath("userData"),"cdb-theme-picker")}
// Written on every open so an upgraded package can never serve the previous
// version's page out of userData.
function __cdbPk_assets(){
var d=__cdbPk_dir();
_fs.mkdirSync(d,{recursive:true});
var h=_path.join(d,"picker.html"),p=_path.join(d,"preload.js");
_fs.writeFileSync(h,__cdbPk_html,"utf8");
_fs.writeFileSync(p,__cdbPk_preload,"utf8");
return {html:h,preload:p};
}
function __cdbPk_isPicker(wc){
try{return !!(__cdbPk_win&&!__cdbPk_win.isDestroyed()&&wc&&wc.id===__cdbPk_win.webContents.id)}catch(e){return false}
}
function __cdbPk_close(){try{if(__cdbPk_win&&!__cdbPk_win.isDestroyed())__cdbPk_win.close()}catch(e){}}
function __cdbPk_open(){
try{
if(__cdbPk_win&&!__cdbPk_win.isDestroyed()){
if(__cdbPk_win.isMinimized())__cdbPk_win.restore();
__cdbPk_win.show();
__cdbPk_win.focus();
return;
}
var a=__cdbPk_assets();
__cdbPk_win=new _bw({width:920,height:660,minWidth:520,minHeight:420,title:"Themes",backgroundColor:"#0e0e11",autoHideMenuBar:true,webPreferences:{preload:a.preload,contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false}});
__cdbPk_win.setMenuBarVisibility(false);
__cdbPk_win.on("closed",function(){__cdbPk_win=null});
__cdbPk_win.loadFile(a.html);
__cdbPk_log("window opened ("+a.html+")");
}catch(e){__cdbPk_log("could not open the picker: "+e.message)}
}
globalThis.__cdbOpenThemePicker=__cdbPk_open;
// Thin delegation to the theme registry. removeHandler first, so a second
// evaluation of this module replaces the handlers instead of throwing.
try{
var __cdbPk_chans={
"cdb-themes:list":function(){var a=__cdbPk_api();if(!a)return __cdbPk_noEngine();try{return {ok:true,entries:a.list()}}catch(e){return {ok:false,error:e.message}}},
"cdb-themes:active":function(){var a=__cdbPk_api();if(!a)return __cdbPk_noEngine();try{return {ok:true,name:a.active()}}catch(e){return {ok:false,error:e.message}}},
"cdb-themes:apply":function(_e,name){var a=__cdbPk_api();if(!a)return __cdbPk_noEngine();try{return a.apply(name)}catch(e){return {ok:false,error:e.message}}},
// themeOverlay: the engine merges one theme's tokens over whatever theme is
// active. Read-only channels report the current overlay and the candidates
// (user / generator themes, hidden ones first); set-overlay persists and applies.
// "" turns it off. An engine older than version 3 has no overlays()/setOverlay().
"cdb-themes:overlay":function(){var a=__cdbPk_api();if(!a)return __cdbPk_noEngine();if(typeof a.overlay!=="function")return __cdbPk_noOverlay();try{return {ok:true,overlay:a.overlay()||null}}catch(e){return {ok:false,error:e.message}}},
"cdb-themes:overlays":function(){var a=__cdbPk_api();if(!a)return __cdbPk_noEngine();if(typeof a.overlays!=="function")return __cdbPk_noOverlay();try{return {ok:true,entries:a.overlays()||[]}}catch(e){return {ok:false,error:e.message}}},
"cdb-themes:set-overlay":function(_e,name){var a=__cdbPk_api();if(!a)return __cdbPk_noEngine();if(typeof a.setOverlay!=="function")return __cdbPk_noOverlay();try{return a.setOverlay(typeof name==="string"?name:"")}catch(e){return {ok:false,error:e.message}}},
"cdb-themes:close":function(){__cdbPk_close();return {ok:true}}
};
if(_ipc){
Object.keys(__cdbPk_chans).forEach(function(ch){
try{_ipc.removeHandler(ch)}catch(e){}
_ipc.handle(ch,__cdbPk_chans[ch]);
});
}else __cdbPk_log("ipcMain unavailable; the picker page will not be able to talk back");
}catch(e){__cdbPk_log("IPC registration failed: "+e.message)}
// Ctrl+Shift+T from any app window opens the picker. The picker's own window is
// skipped: its page handles the same chord to close, which makes it a toggle.
_app.on("web-contents-created",function(_ev,wc){
wc.on("before-input-event",function(_e,input){
try{
if(!input||input.type!=="keyDown")return;
if(!input.control||!input.shift||input.alt||input.meta)return;
if(!input.key||input.key.toLowerCase()!=="t")return;
if(__cdbPk_isPicker(wc))return;
if(!__cdbPk_enabled())return;
__cdbPk_open();
}catch(e){}
});
});
__cdbPk_log("Ctrl+Shift+T armed ["+__cdbPk_marker+"]");
})();"""

# The full IIFE: the page and its preload are spliced in as JS string literals
# (escapeJson yields a quoted, fully-escaped literal).
const PICKER_JS =
  PICKER_JS_HEAD & escapeJson(PICKER_HTML) & PICKER_JS_MID & escapeJson(PICKER_PRELOAD) &
  PICKER_JS_TAIL

const EXPECTED_PATCHES = 1

# Positive end-state markers (Rule 6): the build tag, the exported opener, the
# apply and set-overlay channels the page calls, and the opt-out gate on the
# hotkey. An "already applied" run must find all five.
const MARKERS = [
  "__cdb_theme_picker", "globalThis.__cdbOpenThemePicker=", "\"cdb-themes:apply\"",
  "\"cdb-themes:set-overlay\"", "if(!__cdbPk_enabled())return;",
]

proc markersPresent(s: string): int =
  for m in MARKERS:
    if m in s:
      result.inc

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # Idempotency: assert OUR injected end-state, never merely the absence of
  # something else.
  let present = markersPresent(result)
  if present == MARKERS.len:
    echo "  [OK] Theme picker already injected (" & $present & "/" & $MARKERS.len &
      " markers present)"
    echo "  [PASS] No changes needed (already patched)"
    return
  if present > 0:
    echo "  [FAIL] Partial injection detected (" & $present & "/" & $MARKERS.len &
      " markers) -- refusing to patch on top; re-audit the bundle"
    quit(1)

  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & PICKER_JS & result[strictPrefix.len .. ^1]
    echo "  [OK] Theme picker IIFE inserted after \"use strict\""
  else:
    result = PICKER_JS & result
    echo "  [OK] Theme picker IIFE prepended"

  let found = markersPresent(result)
  if found < MARKERS.len:
    for m in MARKERS:
      if m notin result:
        echo "  [FAIL] marker missing after injection: " & m
    echo "  [FAIL] Only " & $found & "/" & $MARKERS.len & " markers present -- aborting"
    quit(1)
  echo "  [OK] " & $found & "/" & $MARKERS.len & " end-state markers verified"
  patchesApplied.inc

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_theme_picker <path_to_index.js>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: add_feature_theme_picker ==="
  echo "  Target: " & filePath

  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)

  let input = readFile(filePath)
  let output = apply(input)

  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Theme picker (Ctrl+Shift+T) added"
  else:
    echo "  [WARN] No changes made"

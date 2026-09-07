# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Custom CSS theme injection for Claude Desktop on Linux (dual-variant).
#
# Reads a JSON config file (~/.config/Claude/claude-desktop-extra.json) at startup
# and injects CSS variable overrides into ALL windows (main chat, Quick Entry,
# Find-in-Page, About) using Electron's stable webContents.insertCSS() API.
#
# DUAL-VARIANT (v1.15962): each theme may be authored as {light:{...},dark:{...}}.
# The patch emits TWO :root var blocks -- a light block on `:root,[data-mode=light]`
# and a dark block on `.darkTheme,[data-mode=dark],.dark` (dark second so it wins on a
# specificity tie). A FLAT theme object (no light/dark keys -- the old schema, also
# the 7 built-ins below) is treated as BOTH light and dark for backward compat.
#
# INNER SCOPES (v1.24012.9): both blocks also mirror the bg ramp as --cdb-bg-*, and the
# sheet re-asserts --bg-* from those mirrors on `.dframe-content-inner`, because upstream
# re-scopes --bg-100 there to the desktop frame's own page-bg gray. An html-level
# !important block cannot win that fight -- custom properties resolve per element and a
# local declaration always beats an inherited one -- so the chat header gradient, the
# "Quick answer" band and the disclaimer strip stayed stock until this re-assert.
#
# THEME SOURCES, in resolution order:
#   1. user themes from the config file ("themes" map; .jsonc beats .json), then
#      one theme per file from <userData>/themes.d/*.json|*.jsonc (theme name = file
#      stem, or the inner names when the file is a {"themes":{...}} wrapper). A
#      config-file theme shadows a themes.d theme of the same name.
#   2. __cdb_builtins   -- the curated built-ins in this file, PLUS the gaming
#                          palettes from js/gaming_themes.json merged in at startup.
#                          Gaming themes are builtin-TIER (same resolution rank); they
#                          are only distinguished by their "category":"gaming" key,
#                          which the picker uses to give them their own section.
#   3. __cdb_community  -- js/community_themes.json, the bundled community palette
#                          collection (staticRead + validated at compile time). Each
#                          entry is a dual-variant object with an extra "name" key
#                          used as the display name; the light/dark resolution below
#                          handles it unchanged.
#
# Both bundled JSON files are parsed AND their optional `spinner` specs are validated
# at compile time, so a malformed shape fails the build instead of shipping a broken
# glyph. list() reports each theme's `category` ("" when it has none) so the picker can
# group by category independently of the source tier.
#
# REGISTRY + LIVE APPLY: `globalThis.__cdbThemes` is installed on every Linux start,
# even with no config file and no activeTheme, so the theme picker
# (patches/add_feature_theme_picker.nim) always has something to talk to:
#   { version:2, list(), active(), overlay(), apply(name), reload(reason), configPath, themesDir }
# apply() rebuilds the stylesheet, swaps it in every tracked webContents
# (removeInsertedCSS of the key we inserted last + insertCSS the new sheet), and
# persists activeTheme. Windows opened later read the CURRENT theme, not a
# startup-frozen string. Passing "" or null reverts to the stock look.
# The early "nothing to do" exits now only skip the STARTUP css application.
#
# INHERITANCE: a theme may carry "extends": "<theme-name>". __cdb_effective() resolves
# the base with the normal lookup (user > builtin > community, aliases honoured), walks
# the chain (depth 8, cycle guard by name), and lays the child's light/dark maps OVER
# the base's per mode; a legacy flat child merges into both modes. name, category,
# chatFont, spinner and customCss are inherited unless the child sets them. A child
# that is nothing but "extends" plus a few tokens is a complete theme. A missing base
# is logged and treated as no base.
#
# HIDDEN: a theme with "hidden": true is resolvable (activeTheme, themeOverlay, extends base) but
# never listed in the picker or Settings; overlay files set it so nobody picks them as a base by mistake.
# OVERLAY: the top-level config key "themeOverlay": "<theme-name>" names a theme whose
# light/dark TOKEN maps are laid over whatever theme is active (startup, apply(),
# reload()), per mode, overlay keys winning. Only "--" tokens are taken from it: its
# chatFont, spinner, customCss, name and category are ignored, the active theme keeps
# its own. The overlay resolves through the normal lookup (user, themes.d, built-in,
# community; may itself use "extends"). No active theme -> no overlay (stock stays
# stock). A missing overlay theme is logged and skipped. It lives inside
# __cdb_buildCss, so every caller gets it; it is never persisted and never listed.
#
# RELOAD + FILE WATCH: __cdb_reload(reason) re-reads the config from disk and re-applies
# cfg.activeTheme to every live window WITHOUT persisting anything (the file is the
# source of truth there); identical output is a no-op. A non-persistent fs.watch on
# the userData DIRECTORY (file-level watches die on the tmp+rename our writer and tools
# like matugen use) plus one on themes.d/ feed it, debounced 300 ms, with a 1.5 s
# self-write window so our own persist() does not bounce. "themeWatch": false in the
# config disables the watcher. Watcher failures are logged and never block theming.
#
# PERSISTENCE is a surgical text edit so user comments survive: the raw .jsonc is
# scanned comment-aware for the real "activeTheme" key and only its VALUE is
# replaced. Missing key -> inserted after the opening brace; .jsonc absent ->
# .json is edited instead; neither present -> a minimal commented .jsonc is created.
# .jsonc is the primary target because it wins the per-key merge.
#
# Derived aliases: after each variant's var list we append --accent-main-*/-secondary-*
# aliases mapping onto the REAL --accent-*/--accent-pro-* tokens (stock v1.15962 has NO
# --accent-main-*), plus --always-black/--always-white, so old custom themes and our
# element overrides keep working.
#
# Spinner: the active theme's optional `spinner` object is serialized to JSON at runtime
# and prepended to the staticRead'd ../js/spinner_injector.js as
#   var __CDB_SPINNER_SPEC = <json|null>;
# then run via wc.executeJavaScript (self-guarding IIFE no-ops if null).
#
# SPINNER SHAPES SWITCH LIVE. The injector installs window.__cdbSpinnerApply(spec|null)
# once per window and stashes each glyph's ORIGINAL markup before the first swap, so it
# can re-theme any number of times and restore Claude's own glyph on revert. Re-running
# the file does not re-install; it just calls that API with the new spec. Both dom-ready
# and apply() therefore push the SAME payload: every live window is re-themed on a
# switch, and a window opened later gets the current spec.
#
# Animation keyframes (spin/bounce/pulse + the two-frame flip pair) ship via insertCSS
# for EVERY animation name regardless of which one the active theme uses, so a switch
# can never land on a shape whose animation has no keyframes.
#
# Spec contract (authors depend on it exactly):
#   {viewBox?, match?, animation?: "pulse"|"spin"|"bounce"|"flip",
#    paths:[{d,fill?}...], paths2:[{d,fill?}...]}   -- paths2 required iff flip
#
# Break risk: VERY LOW -- No regex on minified app code. Uses only the
# "use strict;" prefix (stable) and standard Electron/Node APIs.

import std/[os, strutils, json]

# Renderer-side spinner installer (owned by the SPINNER agent). Embedded at compile
# time and re-emitted as a JS string literal inside the IIFE; the runtime prepends the
# per-theme spec and hands the whole thing to wc.executeJavaScript().
const SPINNER_INJECTOR_JS = staticRead("../../js/spinner_injector.js")

# Bundled community palette collection: { "<slug>": {name, light{}, dark{}} }.
# Parsed at COMPILE time so a malformed or wrongly shaped file fails the build
# instead of shipping a broken bundle.
const COMMUNITY_THEMES_JSON = staticRead("../../js/community_themes.json")

# Bundled gaming palettes: { "<slug>": {name, category:"gaming", light{}, dark{},
# spinner{}} }. Same compile-time gate as the community file, plus the category check.
const GAMING_THEMES_JSON = staticRead("../../js/gaming_themes.json")

# The spinner spec contract, enforced at build time for every bundled theme that
# carries one. The runtime injector validates again (a user theme from the config
# file never passes through here), but an authoring mistake in a file WE ship must
# fail the build, not degrade into a missing glyph on someone's desktop.
proc validateFrame(frame: JsonNode, ctx: string) {.compileTime.} =
  doAssert frame.kind == JArray and frame.len > 0,
    ctx & " must be a non-empty array of {\"d\": \"...\"} objects"
  for p in frame.items:
    doAssert p.kind == JObject and p.hasKey("d") and p["d"].kind == JString and
      p["d"].getStr.len > 0, ctx & ": every path needs a non-empty string \"d\""
    if p.hasKey("fill"):
      doAssert p["fill"].kind == JString, ctx & ": \"fill\" must be a string"

proc validateSpinner(spec: JsonNode, ctx: string) {.compileTime.} =
  doAssert spec.kind == JObject, ctx & ": \"spinner\" must be an object"
  doAssert spec.hasKey("paths"), ctx & ": spinner needs a \"paths\" array"
  validateFrame(spec["paths"], ctx & " spinner.paths")
  var anim = ""
  if spec.hasKey("animation") and spec["animation"].kind == JString:
    anim = spec["animation"].getStr
  if anim.len > 0:
    doAssert anim in ["pulse", "spin", "bounce", "flip"],
      ctx & ": spinner animation must be pulse|spin|bounce|flip, got '" & anim & "'"
  if anim == "flip":
    doAssert spec.hasKey("paths2"),
      ctx & ": animation \"flip\" needs a second sprite frame in \"paths2\""
    validateFrame(spec["paths2"], ctx & " spinner.paths2")
  else:
    doAssert not spec.hasKey("paths2"),
      ctx & ": \"paths2\" is only rendered for animation \"flip\""
  if spec.hasKey("viewBox"):
    doAssert spec["viewBox"].kind == JString,
      ctx & ": spinner \"viewBox\" must be a string"

proc validateThemeMap(raw, file: string, wantGaming: bool): string {.compileTime.} =
  let n = parseJson(raw)
  doAssert n.kind == JObject, file & " must be a JSON object mapping slug -> theme"
  for slug, theme in n.pairs:
    let ctx = file & ": entry '" & slug & "'"
    doAssert theme.kind == JObject, ctx & " must be an object"
    doAssert theme.hasKey("light") or theme.hasKey("dark"),
      ctx & " needs a light and/or dark variant"
    if wantGaming:
      doAssert theme.hasKey("category") and theme["category"].kind == JString and
        theme["category"].getStr == "gaming",
        ctx & " must carry \"category\": \"gaming\""
    if theme.hasKey("spinner") and theme["spinner"].kind != JNull:
      validateSpinner(theme["spinner"], ctx)
  result = $n

const COMMUNITY_JSON =
  validateThemeMap(COMMUNITY_THEMES_JSON, "js/community_themes.json", false)
const GAMING_JSON = validateThemeMap(GAMING_THEMES_JSON, "js/gaming_themes.json", true)

proc jsonLen(raw: string): int {.compileTime.} =
  parseJson(raw).len

const COMMUNITY_COUNT = jsonLen(COMMUNITY_THEMES_JSON)
const GAMING_COUNT = jsonLen(GAMING_THEMES_JSON)

# Head of the injected IIFE: helpers + the curated built-in themes.
const THEME_INJECTION_JS_HEAD =
  """;(function(){
if(process.platform!=="linux")return;
var _path=require("path"),_fs=require("fs"),_app=require("electron").app;
function __cdb_toCss(v){
if(typeof v==="string")return v;
if(Array.isArray(v))return v.filter(function(x){return typeof x==="string"}).join("\n");
return "";
}
function __cdb_isVarMap(o){
if(!o||typeof o!=="object")return false;
for(var k in o){if(k.indexOf("--")===0)return true}
return false;
}
// Build "k:v !important;..." for every --token in a flat var map, then append the
// derived --accent-main-*/-secondary-* aliases + --always-black/--always-white so
// legacy themes and our element overrides resolve even though stock has no main-*.
function __cdb_block(vars){
var out=[];
for(var k in vars){
if(k.indexOf("--")===0)out.push(k+":"+vars[k]+" !important");
// Mirror the bg ramp under --cdb-bg-*. Nothing upstream declares those names, so they
// inherit into every subtree untouched and give the inner-scope re-assert below a
// mode-correct value to point at (see the SCOPE section in __cdb_buildCss).
if(k.indexOf("--bg-")===0)out.push("--cdb-"+k.slice(2)+":"+vars[k]);
}
out.push("--accent-main-000:var(--accent-000)");
out.push("--accent-main-100:var(--accent-brand)");
out.push("--accent-main-200:var(--accent-200)");
out.push("--accent-main-900:var(--accent-900)");
out.push("--accent-secondary-000:var(--accent-pro-000)");
out.push("--accent-secondary-100:var(--accent-pro-100)");
out.push("--accent-secondary-200:var(--accent-pro-200)");
out.push("--accent-secondary-900:var(--accent-pro-900)");
out.push("--always-black:0 0% 0% !important");
out.push("--always-white:0 0% 100% !important");
return out.join(";");
}
var __cdb_builtins={
"catppuccin-frappe":{"light":{"--bg-000":"0 0.0% 100.0%","--bg-100":"220 23.1% 94.9%","--bg-200":"220 22.0% 92.0%","--bg-300":"220 20.7% 88.6%","--bg-400":"223 15.9% 82.7%","--bg-500":"225 13.6% 76.9%","--text-000":"234 16.0% 35.5%","--text-100":"234 16.0% 35.5%","--text-200":"233 12.8% 41.4%","--text-300":"233 12.8% 41.4%","--text-400":"233 10.4% 46.3%","--text-500":"233 10.4% 46.3%","--accent-brand":"266 85.0% 58.0%","--accent-000":"266 85.0% 58.0%","--accent-100":"266 85.0% 58.0%","--accent-200":"266 85.0% 58.0%","--accent-900":"220 20.7% 88.6%","--accent-pro-000":"231 97.2% 72.0%","--accent-pro-100":"220 91.5% 53.9%","--accent-pro-200":"220 91.5% 53.9%","--accent-pro-900":"220 20.7% 88.6%","--brand-000":"266 85.0% 58.0%","--brand-100":"266 85.0% 58.0%","--brand-200":"266 85.0% 58.0%","--brand-900":"0 0% 0%","--border-100":"234 16% 20%","--border-200":"234 16% 20%","--border-300":"234 16% 20%","--border-400":"234 16% 20%","--danger-000":"347 86.7% 44.1%","--danger-100":"355 76.3% 58.6%","--danger-200":"347 86.7% 44.1%","--danger-900":"351 73.1% 89.8%","--warning-000":"35 77.0% 45.4%","--warning-100":"22 99.2% 52.0%","--warning-200":"35 77.0% 45.4%","--warning-900":"35 68.4% 88.8%","--success-000":"109 57.6% 39.8%","--success-100":"183 73.9% 34.5%","--success-200":"109 57.6% 39.8%","--success-900":"107 42.4% 87.1%","--oncolor-100":"0 0% 100%","--oncolor-200":"0 0% 100%","--oncolor-300":"0 0% 100%","--pictogram-100":"234 16.0% 35.5%","--pictogram-200":"233 12.8% 41.4%","--pictogram-300":"233 10.4% 46.3%","--pictogram-400":"223 15.9% 82.7%","--claude-accent-clay":"#8839ef","--claude-foreground-color":"#4c4f69","--claude-background-color":"#eff1f5","--claude-secondary-color":"#6c6f85","--claude-border":"#8839ef18","--claude-border-300":"#8839ef30","--claude-border-300-more":"#8839ef55","--claude-text-100":"#4c4f69","--claude-text-200":"#5c5f77","--claude-text-400":"#6c6f85","--claude-text-500":"#6c6f85","--claude-description-text":"#5c5f77"},"dark":{"--bg-000":"230 18.8% 26.1%","--bg-100":"229 18.6% 23.1%","--bg-200":"231 18.8% 19.8%","--bg-300":"229 19.5% 17.1%","--bg-400":"231 19.4% 14.1%","--bg-500":"230 20.0% 11.8%","--text-000":"227 70.1% 86.9%","--text-100":"227 70.1% 86.9%","--text-200":"227 43.7% 79.8%","--text-300":"227 43.7% 79.8%","--text-400":"228 29.5% 72.7%","--text-500":"228 29.5% 72.7%","--accent-brand":"277 59.0% 76.1%","--accent-000":"276 61.2% 80.8%","--accent-100":"277 59.0% 76.1%","--accent-200":"277 59.0% 76.1%","--accent-900":"262 25.0% 25.1%","--accent-pro-000":"222 67.5% 84.3%","--accent-pro-100":"222 74.2% 74.1%","--accent-pro-200":"222 74.2% 74.1%","--accent-pro-900":"220 32.2% 23.7%","--brand-000":"276 57.0% 70.8%","--brand-100":"277 59.0% 76.1%","--brand-200":"277 59.0% 76.1%","--brand-900":"0 0% 0%","--border-100":"229 28% 70%","--border-200":"229 28% 70%","--border-300":"229 28% 70%","--border-400":"229 28% 70%","--danger-000":"359 67.8% 70.8%","--danger-100":"359 67.8% 70.8%","--danger-200":"359 67.8% 70.8%","--danger-900":"358 24.5% 19.2%","--warning-000":"40 62.0% 73.1%","--warning-100":"20 79.1% 70.0%","--warning-200":"20 79.1% 70.0%","--warning-900":"42 27.7% 18.4%","--success-000":"96 43.9% 67.8%","--success-100":"96 43.9% 67.8%","--success-200":"96 43.9% 67.8%","--success-900":"97 28.4% 15.9%","--oncolor-100":"229 18.6% 23.1%","--oncolor-200":"229 18.6% 23.1%","--oncolor-300":"229 18.6% 23.1%","--pictogram-100":"227 70.1% 86.9%","--pictogram-200":"227 43.7% 79.8%","--pictogram-300":"228 29.5% 72.7%","--pictogram-400":"230 15.6% 30.2%","--claude-accent-clay":"#ca9ee6","--claude-foreground-color":"#c6d0f5","--claude-background-color":"#303446","--claude-secondary-color":"#a5adce","--claude-border":"#ca9ee618","--claude-border-300":"#ca9ee630","--claude-border-300-more":"#ca9ee655","--claude-text-100":"#c6d0f5","--claude-text-200":"#b5bfe2","--claude-text-400":"#a5adce","--claude-text-500":"#949cbb","--claude-description-text":"#b5bfe2"},"spinner":{"viewBox":"0 0 100 100","animation":"pulse","paths":[{"d":"M26 45 L49 34 L19 13 Z M74 45 L81 13 L51 34 Z M23 55 a 27 27 0 1 0 54 0 a 27 27 0 1 0 -54 0 z"}]}},
"catppuccin-latte":{"light":{"--bg-000":"0 0.0% 100.0%","--bg-100":"220 23.1% 94.9%","--bg-200":"220 22.0% 92.0%","--bg-300":"220 20.7% 88.6%","--bg-400":"223 15.9% 82.7%","--bg-500":"225 13.6% 76.9%","--text-000":"234 16.0% 35.5%","--text-100":"234 16.0% 35.5%","--text-200":"233 12.8% 41.4%","--text-300":"233 12.8% 41.4%","--text-400":"233 10.4% 46.3%","--text-500":"233 10.4% 46.3%","--accent-brand":"266 85.0% 58.0%","--accent-000":"266 85.0% 58.0%","--accent-100":"266 85.0% 58.0%","--accent-200":"266 85.0% 58.0%","--accent-900":"220 20.7% 88.6%","--accent-pro-000":"231 97.2% 72.0%","--accent-pro-100":"220 91.5% 53.9%","--accent-pro-200":"220 91.5% 53.9%","--accent-pro-900":"220 20.7% 88.6%","--brand-000":"266 85.0% 58.0%","--brand-100":"266 85.0% 58.0%","--brand-200":"266 85.0% 58.0%","--brand-900":"0 0% 0%","--border-100":"234 16% 20%","--border-200":"234 16% 20%","--border-300":"234 16% 20%","--border-400":"234 16% 20%","--danger-000":"347 86.7% 44.1%","--danger-100":"355 76.3% 58.6%","--danger-200":"347 86.7% 44.1%","--danger-900":"351 73.1% 89.8%","--warning-000":"35 77.0% 45.4%","--warning-100":"22 99.2% 52.0%","--warning-200":"35 77.0% 45.4%","--warning-900":"35 68.4% 88.8%","--success-000":"109 57.6% 39.8%","--success-100":"183 73.9% 34.5%","--success-200":"109 57.6% 39.8%","--success-900":"107 42.4% 87.1%","--oncolor-100":"0 0% 100%","--oncolor-200":"0 0% 100%","--oncolor-300":"0 0% 100%","--pictogram-100":"234 16.0% 35.5%","--pictogram-200":"233 12.8% 41.4%","--pictogram-300":"233 10.4% 46.3%","--pictogram-400":"223 15.9% 82.7%","--claude-accent-clay":"#8839ef","--claude-foreground-color":"#4c4f69","--claude-background-color":"#eff1f5","--claude-secondary-color":"#6c6f85","--claude-border":"#8839ef18","--claude-border-300":"#8839ef30","--claude-border-300-more":"#8839ef55","--claude-text-100":"#4c4f69","--claude-text-200":"#5c5f77","--claude-text-400":"#6c6f85","--claude-text-500":"#6c6f85","--claude-description-text":"#5c5f77"},"dark":{"--bg-000":"240 19.6% 18.0%","--bg-100":"240 21.1% 14.9%","--bg-200":"240 21.3% 12.0%","--bg-300":"240 19.2% 10.2%","--bg-400":"240 22.7% 8.6%","--bg-500":"240 21.2% 6.5%","--text-000":"226 63.9% 88.0%","--text-100":"226 63.9% 88.0%","--text-200":"227 35.3% 80.0%","--text-300":"227 35.3% 80.0%","--text-400":"228 23.6% 71.8%","--text-500":"228 23.6% 71.8%","--accent-brand":"267 83.5% 81.0%","--accent-000":"266 84.4% 84.9%","--accent-100":"267 83.5% 81.0%","--accent-200":"267 83.5% 81.0%","--accent-900":"256 29.9% 26.3%","--accent-pro-000":"232 97.4% 85.1%","--accent-pro-100":"217 91.9% 75.9%","--accent-pro-200":"217 91.9% 75.9%","--accent-pro-900":"228 32.8% 23.3%","--brand-000":"263 76.6% 74.9%","--brand-100":"267 83.5% 81.0%","--brand-200":"267 83.5% 81.0%","--brand-900":"0 0% 0%","--border-100":"232 28% 72%","--border-200":"232 28% 72%","--border-300":"232 28% 72%","--border-400":"232 28% 72%","--danger-000":"343 81.2% 74.9%","--danger-100":"343 81.2% 74.9%","--danger-200":"343 81.2% 74.9%","--danger-900":"338 32.7% 19.8%","--warning-000":"41 86.0% 83.1%","--warning-100":"23 92.0% 75.5%","--warning-200":"23 92.0% 75.5%","--warning-900":"38 36.7% 19.2%","--success-000":"115 54.1% 76.1%","--success-100":"115 54.1% 76.1%","--success-200":"115 54.1% 76.1%","--success-900":"112 27.1% 16.7%","--oncolor-100":"240 21.1% 14.9%","--oncolor-200":"240 21.1% 14.9%","--oncolor-300":"240 21.1% 14.9%","--pictogram-100":"226 63.9% 88.0%","--pictogram-200":"227 35.3% 80.0%","--pictogram-300":"228 23.6% 71.8%","--pictogram-400":"237 16.2% 22.9%","--claude-accent-clay":"#cba6f7","--claude-foreground-color":"#cdd6f4","--claude-background-color":"#1e1e2e","--claude-secondary-color":"#a6adc8","--claude-border":"#cba6f718","--claude-border-300":"#cba6f730","--claude-border-300-more":"#cba6f755","--claude-text-100":"#cdd6f4","--claude-text-200":"#bac2de","--claude-text-400":"#a6adc8","--claude-text-500":"#9399b2","--claude-description-text":"#bac2de"},"spinner":{"viewBox":"0 0 100 100","animation":"pulse","paths":[{"d":"M23 54 L65 54 L60 84 L28 84 Z M22 87 L66 87 L61 91 L27 91 Z M65 57 A 13 13 0 1 1 65 81 L65 75 A 7 7 0 1 0 65 63 Z M40 50 C45 44 35 40 42 34 C45 28 37 24 40 18 L36 18 C33 24 41 28 38 34 C31 40 41 44 36 50 Z M52 50 C57 44 47 40 54 34 C57 28 49 24 52 18 L48 18 C45 24 53 28 50 34 C43 40 53 44 48 50 Z"}]}},
"catppuccin-macchiato":{"light":{"--bg-000":"0 0.0% 100.0%","--bg-100":"220 23.1% 94.9%","--bg-200":"220 22.0% 92.0%","--bg-300":"220 20.7% 88.6%","--bg-400":"223 15.9% 82.7%","--bg-500":"225 13.6% 76.9%","--text-000":"234 16.0% 35.5%","--text-100":"234 16.0% 35.5%","--text-200":"233 12.8% 41.4%","--text-300":"233 12.8% 41.4%","--text-400":"233 10.4% 46.3%","--text-500":"233 10.4% 46.3%","--accent-brand":"266 85.0% 58.0%","--accent-000":"266 85.0% 58.0%","--accent-100":"266 85.0% 58.0%","--accent-200":"266 85.0% 58.0%","--accent-900":"220 20.7% 88.6%","--accent-pro-000":"231 97.2% 72.0%","--accent-pro-100":"220 91.5% 53.9%","--accent-pro-200":"220 91.5% 53.9%","--accent-pro-900":"220 20.7% 88.6%","--brand-000":"266 85.0% 58.0%","--brand-100":"266 85.0% 58.0%","--brand-200":"266 85.0% 58.0%","--brand-900":"0 0% 0%","--border-100":"234 16% 20%","--border-200":"234 16% 20%","--border-300":"234 16% 20%","--border-400":"234 16% 20%","--danger-000":"347 86.7% 44.1%","--danger-100":"355 76.3% 58.6%","--danger-200":"347 86.7% 44.1%","--danger-900":"351 73.1% 89.8%","--warning-000":"35 77.0% 45.4%","--warning-100":"22 99.2% 52.0%","--warning-200":"35 77.0% 45.4%","--warning-900":"35 68.4% 88.8%","--success-000":"109 57.6% 39.8%","--success-100":"183 73.9% 34.5%","--success-200":"109 57.6% 39.8%","--success-900":"107 42.4% 87.1%","--oncolor-100":"0 0% 100%","--oncolor-200":"0 0% 100%","--oncolor-300":"0 0% 100%","--pictogram-100":"234 16.0% 35.5%","--pictogram-200":"233 12.8% 41.4%","--pictogram-300":"233 10.4% 46.3%","--pictogram-400":"223 15.9% 82.7%","--claude-accent-clay":"#8839ef","--claude-foreground-color":"#4c4f69","--claude-background-color":"#eff1f5","--claude-secondary-color":"#6c6f85","--claude-border":"#8839ef18","--claude-border-300":"#8839ef30","--claude-border-300-more":"#8839ef55","--claude-text-100":"#4c4f69","--claude-text-200":"#5c5f77","--claude-text-400":"#6c6f85","--claude-text-500":"#6c6f85","--claude-description-text":"#5c5f77"},"dark":{"--bg-000":"232 22.2% 21.2%","--bg-100":"232 23.4% 18.4%","--bg-200":"233 23.1% 15.3%","--bg-300":"232 22.4% 13.1%","--bg-400":"236 22.6% 12.2%","--bg-500":"235 24.0% 9.8%","--text-000":"227 68.3% 87.6%","--text-100":"227 68.3% 87.6%","--text-200":"228 39.2% 80.0%","--text-300":"228 39.2% 80.0%","--text-400":"227 26.8% 72.2%","--text-500":"227 26.8% 72.2%","--accent-brand":"267 82.7% 79.6%","--accent-000":"265 83.1% 83.7%","--accent-100":"267 82.7% 79.6%","--accent-200":"267 82.7% 79.6%","--accent-900":"256 30.1% 24.1%","--accent-pro-000":"227 84.6% 84.7%","--accent-pro-100":"220 82.8% 74.9%","--accent-pro-200":"220 82.8% 74.9%","--accent-pro-900":"222 38.1% 22.2%","--brand-000":"265 76.1% 73.7%","--brand-100":"267 82.7% 79.6%","--brand-200":"267 82.7% 79.6%","--brand-900":"0 0% 0%","--border-100":"232 28% 71%","--border-200":"232 28% 71%","--border-300":"232 28% 71%","--border-400":"232 28% 71%","--danger-000":"351 73.9% 72.9%","--danger-100":"351 73.9% 72.9%","--danger-200":"351 73.9% 72.9%","--danger-900":"343 29.9% 19.0%","--warning-000":"40 69.9% 77.8%","--warning-100":"21 85.5% 72.9%","--warning-200":"21 85.5% 72.9%","--warning-900":"39 34.0% 18.4%","--success-000":"105 48.3% 72.0%","--success-100":"105 48.3% 72.0%","--success-200":"105 48.3% 72.0%","--success-900":"108 30.0% 15.7%","--oncolor-100":"232 23.4% 18.4%","--oncolor-200":"232 23.4% 18.4%","--oncolor-300":"232 23.4% 18.4%","--pictogram-100":"227 68.3% 87.6%","--pictogram-200":"228 39.2% 80.0%","--pictogram-300":"227 26.8% 72.2%","--pictogram-400":"230 18.8% 26.1%","--claude-accent-clay":"#c6a0f6","--claude-foreground-color":"#cad3f5","--claude-background-color":"#24273a","--claude-secondary-color":"#a5adcb","--claude-border":"#c6a0f618","--claude-border-300":"#c6a0f630","--claude-border-300-more":"#c6a0f655","--claude-text-100":"#cad3f5","--claude-text-200":"#b8c0e0","--claude-text-400":"#a5adcb","--claude-text-500":"#939ab7","--claude-description-text":"#b8c0e0"},"spinner":{"viewBox":"0 0 100 100","animation":"pulse","paths":[{"d":"M26 45 L49 34 L19 13 Z M74 45 L81 13 L51 34 Z M23 55 a 27 27 0 1 0 54 0 a 27 27 0 1 0 -54 0 z"}]}},
"catppuccin-mocha":{"light":{"--bg-000":"0 0.0% 100.0%","--bg-100":"220 23.1% 94.9%","--bg-200":"220 22.0% 92.0%","--bg-300":"220 20.7% 88.6%","--bg-400":"223 15.9% 82.7%","--bg-500":"225 13.6% 76.9%","--text-000":"234 16.0% 35.5%","--text-100":"234 16.0% 35.5%","--text-200":"233 12.8% 41.4%","--text-300":"233 12.8% 41.4%","--text-400":"233 10.4% 46.3%","--text-500":"233 10.4% 46.3%","--accent-brand":"266 85.0% 58.0%","--accent-000":"266 85.0% 58.0%","--accent-100":"266 85.0% 58.0%","--accent-200":"266 85.0% 58.0%","--accent-900":"220 20.7% 88.6%","--accent-pro-000":"231 97.2% 72.0%","--accent-pro-100":"220 91.5% 53.9%","--accent-pro-200":"220 91.5% 53.9%","--accent-pro-900":"220 20.7% 88.6%","--brand-000":"266 85.0% 58.0%","--brand-100":"266 85.0% 58.0%","--brand-200":"266 85.0% 58.0%","--brand-900":"0 0% 0%","--border-100":"234 16% 20%","--border-200":"234 16% 20%","--border-300":"234 16% 20%","--border-400":"234 16% 20%","--danger-000":"347 86.7% 44.1%","--danger-100":"355 76.3% 58.6%","--danger-200":"347 86.7% 44.1%","--danger-900":"351 73.1% 89.8%","--warning-000":"35 77.0% 45.4%","--warning-100":"22 99.2% 52.0%","--warning-200":"35 77.0% 45.4%","--warning-900":"35 68.4% 88.8%","--success-000":"109 57.6% 39.8%","--success-100":"183 73.9% 34.5%","--success-200":"109 57.6% 39.8%","--success-900":"107 42.4% 87.1%","--oncolor-100":"0 0% 100%","--oncolor-200":"0 0% 100%","--oncolor-300":"0 0% 100%","--pictogram-100":"234 16.0% 35.5%","--pictogram-200":"233 12.8% 41.4%","--pictogram-300":"233 10.4% 46.3%","--pictogram-400":"223 15.9% 82.7%","--claude-accent-clay":"#8839ef","--claude-foreground-color":"#4c4f69","--claude-background-color":"#eff1f5","--claude-secondary-color":"#6c6f85","--claude-border":"#8839ef18","--claude-border-300":"#8839ef30","--claude-border-300-more":"#8839ef55","--claude-text-100":"#4c4f69","--claude-text-200":"#5c5f77","--claude-text-400":"#6c6f85","--claude-text-500":"#6c6f85","--claude-description-text":"#5c5f77"},"dark":{"--bg-000":"240 19.6% 18.0%","--bg-100":"240 21.1% 14.9%","--bg-200":"240 21.3% 12.0%","--bg-300":"240 19.2% 10.2%","--bg-400":"240 22.7% 8.6%","--bg-500":"240 21.2% 6.5%","--text-000":"226 63.9% 88.0%","--text-100":"226 63.9% 88.0%","--text-200":"227 35.3% 80.0%","--text-300":"227 35.3% 80.0%","--text-400":"228 23.6% 71.8%","--text-500":"228 23.6% 71.8%","--accent-brand":"267 83.5% 81.0%","--accent-000":"266 84.4% 84.9%","--accent-100":"267 83.5% 81.0%","--accent-200":"267 83.5% 81.0%","--accent-900":"256 29.9% 26.3%","--accent-pro-000":"232 97.4% 85.1%","--accent-pro-100":"217 91.9% 75.9%","--accent-pro-200":"217 91.9% 75.9%","--accent-pro-900":"228 32.8% 23.3%","--brand-000":"263 76.6% 74.9%","--brand-100":"267 83.5% 81.0%","--brand-200":"267 83.5% 81.0%","--brand-900":"0 0% 0%","--border-100":"232 28% 72%","--border-200":"232 28% 72%","--border-300":"232 28% 72%","--border-400":"232 28% 72%","--danger-000":"343 81.2% 74.9%","--danger-100":"343 81.2% 74.9%","--danger-200":"343 81.2% 74.9%","--danger-900":"338 32.7% 19.8%","--warning-000":"41 86.0% 83.1%","--warning-100":"23 92.0% 75.5%","--warning-200":"23 92.0% 75.5%","--warning-900":"38 36.7% 19.2%","--success-000":"115 54.1% 76.1%","--success-100":"115 54.1% 76.1%","--success-200":"115 54.1% 76.1%","--success-900":"112 27.1% 16.7%","--oncolor-100":"240 21.1% 14.9%","--oncolor-200":"240 21.1% 14.9%","--oncolor-300":"240 21.1% 14.9%","--pictogram-100":"226 63.9% 88.0%","--pictogram-200":"227 35.3% 80.0%","--pictogram-300":"228 23.6% 71.8%","--pictogram-400":"237 16.2% 22.9%","--claude-accent-clay":"#cba6f7","--claude-foreground-color":"#cdd6f4","--claude-background-color":"#1e1e2e","--claude-secondary-color":"#a6adc8","--claude-border":"#cba6f718","--claude-border-300":"#cba6f730","--claude-border-300-more":"#cba6f755","--claude-text-100":"#cdd6f4","--claude-text-200":"#bac2de","--claude-text-400":"#a6adc8","--claude-text-500":"#9399b2","--claude-description-text":"#bac2de"},"spinner":{"viewBox":"0 0 100 100","animation":"pulse","paths":[{"d":"M26 45 L49 34 L19 13 Z M74 45 L81 13 L51 34 Z M23 55 a 27 27 0 1 0 54 0 a 27 27 0 1 0 -54 0 z"}]}},
"mario":{"category":"gaming","light":{"--bg-000":"204 100% 96%","--bg-100":"203 92% 90%","--bg-200":"202 85% 84%","--bg-300":"201 78% 78%","--bg-400":"200 72% 71%","--bg-500":"200 68% 64%","--text-000":"222 66% 13%","--text-100":"222 66% 13%","--text-200":"220 52.0% 26.0%","--text-300":"220 52.0% 26.0%","--text-400":"218 38.0% 38.0%","--text-500":"218 38.0% 38.0%","--accent-brand":"1 79.0% 49.0%","--accent-000":"8 85% 46%","--accent-100":"8 85% 42%","--accent-200":"8 85% 42%","--accent-900":"16 90% 88%","--accent-pro-000":"211 90.0% 44.0%","--accent-pro-100":"211 90.0% 40.0%","--accent-pro-200":"211 90.0% 40.0%","--accent-pro-900":"211 80% 88%","--brand-000":"1 79.0% 49.0%","--brand-100":"1 79.0% 49.0%","--brand-200":"1 79.0% 49.0%","--brand-900":"0 0% 0%","--border-100":"211 70% 32%","--border-200":"211 70% 32%","--border-300":"211 70% 32%","--border-400":"211 70% 32%","--danger-000":"0 100.0% 38.0%","--danger-100":"0 80% 50%","--danger-200":"0 100.0% 33.3%","--danger-900":"0 70% 90%","--warning-000":"33 100.0% 30.0%","--warning-100":"40 100.0% 45.0%","--warning-200":"33 100.0% 27.0%","--warning-900":"45 95% 84%","--success-000":"133 80.0% 26.0%","--success-100":"133 75% 32%","--success-200":"133 80.0% 23.0%","--success-900":"133 55% 86%","--oncolor-100":"0 0% 100%","--oncolor-200":"0 0% 100%","--oncolor-300":"0 0% 100%","--pictogram-100":"222 66% 13%","--pictogram-200":"220 52.0% 26.0%","--pictogram-300":"211 60% 38%","--pictogram-400":"202 85% 84%","--claude-accent-clay":"#e52421","--claude-foreground-color":"#0a1733","--claude-background-color":"#5c94fc","--claude-secondary-color":"#2a4a8f","--claude-border":"#1f4ba318","--claude-border-300":"#1f4ba330","--claude-border-300-more":"#1f4ba355","--claude-text-100":"#0a1733","--claude-text-200":"#1d3566","--claude-text-400":"#2a4a8f","--claude-text-500":"#2a4a8f","--claude-description-text":"#1d3566"},"dark":{"--bg-000":"20 32% 15%","--bg-100":"20 36% 11%","--bg-200":"18 40% 8.5%","--bg-300":"16 42% 6.5%","--bg-400":"16 44% 4%","--bg-500":"16 46% 2.5%","--text-000":"40 60% 96%","--text-100":"40 60% 96%","--text-200":"38 35% 83%","--text-300":"38 35% 83%","--text-400":"34 24.0% 66.0%","--text-500":"34 24.0% 66.0%","--accent-brand":"6 90.0% 44.0%","--accent-000":"8 92% 46%","--accent-100":"6 90% 44%","--accent-200":"6 90% 44%","--accent-900":"16 70% 22%","--accent-pro-000":"205 100% 72%","--accent-pro-100":"205 95% 62%","--accent-pro-200":"205 95% 62%","--accent-pro-900":"210 70% 24%","--brand-000":"2 88% 60%","--brand-100":"2 84.0% 56.0%","--brand-200":"2 84.0% 56.0%","--brand-900":"0 0% 0%","--border-100":"36 38% 70%","--border-200":"36 38% 70%","--border-300":"36 38% 70%","--border-400":"36 38% 70%","--danger-000":"0 95% 72%","--danger-100":"0 85% 66%","--danger-200":"0 85% 66%","--danger-900":"0 60% 26%","--warning-000":"45 100.0% 56.0%","--warning-100":"45 100.0% 52.0%","--warning-200":"45 100.0% 52.0%","--warning-900":"42 80% 18%","--success-000":"130 70% 55%","--success-100":"130 65% 48%","--success-200":"130 65% 48%","--success-900":"130 55% 16%","--oncolor-100":"0 0% 100%","--oncolor-200":"0 0% 100%","--oncolor-300":"0 0% 100%","--pictogram-100":"40 60% 96%","--pictogram-200":"38 35% 83%","--pictogram-300":"34 24.0% 66.0%","--pictogram-400":"20 32% 22%","--claude-accent-clay":"#ef3a36","--claude-foreground-color":"#fbf3e6","--claude-background-color":"#2a1a12","--claude-secondary-color":"#c9a888","--claude-border":"#f5d03d18","--claude-border-300":"#f5d03d30","--claude-border-300-more":"#f5d03d55","--claude-text-100":"#fbf3e6","--claude-text-200":"#e8d6bf","--claude-text-400":"#c9a888","--claude-text-500":"#c9a888","--claude-description-text":"#f5d03d"},"spinner":{"viewBox":"0 0 100 100","animation":"bounce","paths":[{"d":"M50 10c-21 0-38 15-38 35 0 6 3 10 8 12 2 1 4 2 4 5v16c0 5 4 9 9 9h34c5 0 9-4 9-9V67c0-3 2-4 4-5 5-2 8-6 8-12 0-20-17-35-38-35z","fill":"#3A2A1A"},{"d":"M50 14c-19 0-34 13-34 31 0 5 3 8 7 9 3 1 6 1 9 1h36c3 0 6 0 9-1 4-1 7-4 7-9 0-18-15-31-34-31z","fill":"#E52521"},{"d":"M30 56h40v16c0 4-3 7-7 7H37c-4 0-7-3-7-7V56z","fill":"#FAD9C0"},{"d":"M38 30a8 8 0 1 0 0.01 0z","fill":"#FFFFFF"},{"d":"M57 22a5 5 0 1 0 0.01 0z","fill":"#FFFFFF"},{"d":"M68 36a6 6 0 1 0 0.01 0z","fill":"#FFFFFF"},{"d":"M42 64a3 3 0 1 0 0.01 0z","fill":"#3A2A1A"},{"d":"M58 64a3 3 0 1 0 0.01 0z","fill":"#3A2A1A"}]}},
"nord":{"light":{"--bg-000":"0 0.0% 100.0%","--bg-100":"218 26.7% 94.1%","--bg-200":"218 26.8% 92.0%","--bg-300":"219 26.9% 89.8%","--bg-400":"219 27.9% 88.0%","--bg-500":"218 23.5% 84.1%","--text-000":"220 16.4% 21.6%","--text-100":"220 16.4% 21.6%","--text-200":"220 16.8% 31.6%","--text-300":"220 16.8% 31.6%","--text-400":"220 16.5% 35.7%","--text-500":"220 16.5% 35.7%","--accent-brand":"213 32.0% 48.2%","--accent-000":"213 32.0% 52.2%","--accent-100":"213 32.0% 48.2%","--accent-200":"213 32.0% 48.2%","--accent-900":"219 26.9% 89.8%","--accent-pro-000":"309 19.3% 52.4%","--accent-pro-100":"310 21.1% 44.7%","--accent-pro-200":"310 21.1% 44.7%","--accent-pro-900":"274 26.9% 89.8%","--brand-000":"213 32.0% 52.2%","--brand-100":"213 32.0% 48.2%","--brand-200":"213 32.0% 48.2%","--brand-900":"0 0% 0%","--border-100":"220 18% 28%","--border-200":"220 18% 28%","--border-300":"220 18% 28%","--border-400":"220 18% 28%","--danger-000":"354 42.3% 56.5%","--danger-100":"354 42.3% 56.5%","--danger-200":"355 43.0% 46.1%","--danger-900":"355 44.4% 89.4%","--warning-000":"36 61.5% 42.7%","--warning-100":"14 50.5% 62.7%","--warning-200":"36 67.7% 36.5%","--warning-900":"43 50.0% 87.5%","--success-000":"94 33.0% 36.9%","--success-100":"92 27.8% 64.7%","--success-200":"94 35.8% 31.8%","--success-900":"87 34.3% 86.3%","--oncolor-100":"0 0% 100%","--oncolor-200":"0 0% 100%","--oncolor-300":"0 0% 100%","--pictogram-100":"220 16.4% 21.6%","--pictogram-200":"220 16.8% 31.6%","--pictogram-300":"220 16.5% 35.7%","--pictogram-400":"219 26.9% 89.8%","--claude-accent-clay":"#5477a2","--claude-foreground-color":"#2e3440","--claude-background-color":"#eceff4","--claude-secondary-color":"#4c566a","--claude-border":"#5477a218","--claude-border-300":"#5477a230","--claude-border-300-more":"#5477a255","--claude-text-100":"#2e3440","--claude-text-200":"#434c5e","--claude-text-400":"#4c566a","--claude-text-500":"#4c566a","--claude-description-text":"#434c5e"},"dark":{"--bg-000":"220 16% 26%","--bg-100":"220 16.4% 21.6%","--bg-200":"221 15.7% 20.0%","--bg-300":"220 16.1% 18.2%","--bg-400":"222 16.5% 15.5%","--bg-500":"222 15.6% 12.5%","--text-000":"218 26.7% 94.1%","--text-100":"218 26.7% 94.1%","--text-200":"219 27.9% 88.0%","--text-300":"219 27.9% 88.0%","--text-400":"223 12.5% 71.8%","--text-500":"223 12.5% 71.8%","--accent-brand":"193 43.4% 67.5%","--accent-000":"179 25.1% 64.9%","--accent-100":"193 43.4% 67.5%","--accent-200":"193 43.4% 67.5%","--accent-900":"193 20.0% 22.5%","--accent-pro-000":"311 20.2% 63.1%","--accent-pro-100":"312 16.2% 58.8%","--accent-pro-200":"312 16.2% 58.8%","--accent-pro-900":"280 17.2% 17.1%","--brand-000":"210 34.0% 63.1%","--brand-100":"193 43.4% 67.5%","--brand-200":"193 43.4% 67.5%","--brand-900":"0 0% 0%","--border-100":"218 24% 72%","--border-200":"218 24% 72%","--border-300":"218 24% 72%","--border-400":"218 24% 72%","--danger-000":"354 51.4% 63.7%","--danger-100":"354 42.3% 56.5%","--danger-200":"354 42.3% 56.5%","--danger-900":"350 26.1% 18.0%","--warning-000":"40 70.6% 73.3%","--warning-100":"14 50.5% 62.7%","--warning-200":"14 50.5% 62.7%","--warning-900":"40 30.3% 17.5%","--success-000":"92 27.8% 64.7%","--success-100":"92 27.8% 64.7%","--success-200":"92 27.8% 64.7%","--success-900":"93 27.5% 15.7%","--oncolor-100":"220 16.4% 21.6%","--oncolor-200":"220 16.4% 21.6%","--oncolor-300":"220 16.4% 21.6%","--pictogram-100":"218 26.7% 94.1%","--pictogram-200":"219 27.9% 88.0%","--pictogram-300":"223 12.5% 71.8%","--pictogram-400":"222 16.3% 27.6%","--claude-accent-clay":"#88c0d0","--claude-foreground-color":"#eceff4","--claude-background-color":"#2e3440","--claude-secondary-color":"#9aa0ae","--claude-border":"#88c0d018","--claude-border-300":"#88c0d030","--claude-border-300-more":"#88c0d055","--claude-text-100":"#eceff4","--claude-text-200":"#d8dee9","--claude-text-400":"#9aa0ae","--claude-text-500":"#9aa0ae","--claude-description-text":"#b9bfcb"},"spinner":{"viewBox":"0 0 100 100","animation":"spin","paths":[{"d":"M50 53.2 L90 53.2 L90 46.8 L50 46.8 Z M67.92 51.2 L72.42 58.99 L76.58 56.59 L72.08 48.8 Z M72.08 51.2 L76.58 43.41 L72.42 41.01 L67.92 48.8 Z M77.92 51.2 L82.42 58.99 L86.58 56.59 L82.08 48.8 Z M82.08 51.2 L86.58 43.41 L82.42 41.01 L77.92 48.8 Z M47.23 51.6 L67.23 86.24 L72.77 83.04 L52.77 48.4 Z M57.92 66.12 L53.42 73.91 L57.58 76.31 L62.08 68.52 Z M60 69.72 L69 69.72 L69 64.92 L60 64.92 Z M62.92 74.78 L58.42 82.57 L62.58 84.97 L67.08 77.18 Z M65 78.38 L74 78.38 L74 73.58 L65 73.58 Z M47.23 48.4 L27.23 83.04 L32.77 86.24 L52.77 51.6 Z M40 64.92 L31 64.92 L31 69.72 L40 69.72 Z M37.92 68.52 L42.42 76.31 L46.58 73.91 L42.08 66.12 Z M35 73.58 L26 73.58 L26 78.38 L35 78.38 Z M32.92 77.18 L37.42 84.97 L41.58 82.57 L37.08 74.78 Z M50 46.8 L10 46.8 L10 53.2 L50 53.2 Z M32.08 48.8 L27.58 41.01 L23.42 43.41 L27.92 51.2 Z M27.92 48.8 L23.42 56.59 L27.58 58.99 L32.08 51.2 Z M22.08 48.8 L17.58 41.01 L13.42 43.41 L17.92 51.2 Z M17.92 48.8 L13.42 56.59 L17.58 58.99 L22.08 51.2 Z M52.77 48.4 L32.77 13.76 L27.23 16.96 L47.23 51.6 Z M42.08 33.88 L46.58 26.09 L42.42 23.69 L37.92 31.48 Z M40 30.28 L31 30.28 L31 35.08 L40 35.08 Z M37.08 25.22 L41.58 17.43 L37.42 15.03 L32.92 22.82 Z M35 21.62 L26 21.62 L26 26.42 L35 26.42 Z M52.77 51.6 L72.77 16.96 L67.23 13.76 L47.23 48.4 Z M60 35.08 L69 35.08 L69 30.28 L60 30.28 Z M62.08 31.48 L57.58 23.69 L53.42 26.09 L57.92 33.88 Z M65 26.42 L74 26.42 L74 21.62 L65 21.62 Z M67.08 22.82 L62.58 15.03 L58.42 17.43 L62.92 25.22 Z M44 50 a 6 6 0 1 0 12 0 a 6 6 0 1 0 -12 0 z"}]}},
"sweet":{"light":{"--bg-000":"0 0% 100%","--bg-100":"315 60% 98%","--bg-200":"300 45% 96%","--bg-300":"295 40% 94%","--bg-400":"290 35% 91%","--bg-500":"288 30% 88%","--text-000":"295 55.0% 18.0%","--text-100":"295 55.0% 18.0%","--text-200":"290 40.0% 32.0%","--text-300":"290 40.0% 32.0%","--text-400":"290 25.0% 45.0%","--text-500":"290 25.0% 45.0%","--accent-brand":"320 85.0% 46.0%","--accent-000":"320 85.0% 45.0%","--accent-100":"320 85.0% 46.0%","--accent-200":"320 85.0% 46.0%","--accent-900":"315 50% 92%","--accent-pro-000":"275 70.0% 52.0%","--accent-pro-100":"275 70.0% 48.0%","--accent-pro-200":"275 70.0% 48.0%","--accent-pro-900":"275 50% 92%","--brand-000":"320 85.0% 48.0%","--brand-100":"320 85.0% 46.0%","--brand-200":"320 85.0% 46.0%","--brand-900":"0 0% 0%","--border-100":"300 30% 28%","--border-200":"300 30% 28%","--border-300":"300 30% 28%","--border-400":"300 30% 28%","--danger-000":"350 80.0% 45.0%","--danger-100":"350 75% 55%","--danger-200":"350 80.0% 42.0%","--danger-900":"350 60% 92%","--warning-000":"35 95.0% 38.0%","--warning-100":"35 90% 50%","--warning-200":"35 95.0% 35.0%","--warning-900":"40 70% 90%","--success-000":"145 75.0% 32.0%","--success-100":"145 60% 42%","--success-200":"145 75.0% 28.0%","--success-900":"145 50% 90%","--oncolor-100":"0 0% 100%","--oncolor-200":"0 0% 100%","--oncolor-300":"0 0% 100%","--pictogram-100":"295 55.0% 18.0%","--pictogram-200":"290 40.0% 32.0%","--pictogram-300":"290 25.0% 45.0%","--pictogram-400":"300 30% 88%","--claude-accent-clay":"#d91297","--claude-foreground-color":"#431547","--claude-background-color":"#fdf7fb","--claude-secondary-color":"#86568f","--claude-border":"#d9129718","--claude-border-300":"#d9129730","--claude-border-300-more":"#d9129755","--claude-text-100":"#431547","--claude-text-200":"#673172","--claude-text-400":"#86568f","--claude-text-500":"#86568f","--claude-description-text":"#673172"},"dark":{"--bg-000":"288 40% 16%","--bg-100":"288 33% 12%","--bg-200":"290 30% 9%","--bg-300":"290 32% 7%","--bg-400":"285 45% 4.5%","--bg-500":"285 55% 3%","--text-000":"300 100% 98%","--text-100":"300 100% 98%","--text-200":"312 90% 86%","--text-300":"312 90% 86%","--text-400":"300 30.0% 70.0%","--text-500":"300 30.0% 70.0%","--accent-brand":"309 100% 76%","--accent-000":"309 100% 84%","--accent-100":"309 100% 76%","--accent-200":"309 100% 76%","--accent-900":"290 70% 28%","--accent-pro-000":"280 100% 85%","--accent-pro-100":"280 80% 72%","--accent-pro-200":"280 80% 72%","--accent-pro-900":"280 50% 22%","--brand-000":"309 100% 65%","--brand-100":"309 100% 76%","--brand-200":"309 100% 76%","--brand-900":"0 0% 0%","--border-100":"300 40% 80%","--border-200":"300 40% 80%","--border-300":"300 40% 80%","--border-400":"300 40% 80%","--danger-000":"0 90% 72%","--danger-100":"0 80% 68%","--danger-200":"0 80% 68%","--danger-900":"0 60% 26%","--warning-000":"45 100% 75%","--warning-100":"38 95% 64%","--warning-200":"38 95% 64%","--warning-900":"40 60% 24%","--success-000":"140 70% 75%","--success-100":"140 55% 62%","--success-200":"140 55% 62%","--success-900":"140 45% 22%","--oncolor-100":"290 60.0% 10.0%","--oncolor-200":"290 60.0% 10.0%","--oncolor-300":"290 60.0% 10.0%","--pictogram-100":"300 100% 98%","--pictogram-200":"312 90% 86%","--pictogram-300":"300 30.0% 70.0%","--pictogram-400":"290 30% 24%","--claude-accent-clay":"#ff7ae6","--claude-foreground-color":"#fff5ff","--claude-background-color":"#251529","--claude-secondary-color":"#c99cc9","--claude-border":"#ff7ae618","--claude-border-300":"#ff7ae630","--claude-border-300-more":"#ff7ae655","--claude-text-100":"#fff5ff","--claude-text-200":"#fbbbef","--claude-text-400":"#c99cc9","--claude-text-500":"#c99cc9","--claude-description-text":"#f5a3e4"},"spinner":{"viewBox":"0 0 100 100","animation":"spin","paths":[{"d":"M50 50 C74.8 30 50 10 50 10 C50 10 25.2 30 50 50 Z M50 50 C76.68 67.41 88.04 37.64 88.04 37.64 C88.04 37.64 61.36 20.23 50 50 Z M50 50 C41.69 80.76 73.51 82.36 73.51 82.36 C73.51 82.36 81.82 51.6 50 50 Z M50 50 C18.18 51.6 26.49 82.36 26.49 82.36 C26.49 82.36 58.31 80.76 50 50 Z M50 50 C38.64 20.23 11.96 37.64 11.96 37.64 C11.96 37.64 23.32 67.41 50 50 Z M34 50 a 16 16 0 1 0 32 0 a 16 16 0 1 0 -32 0 z"}]}}
};
"""

# Gaming palettes are folded into the built-ins: same resolution tier, own picker
# section (driven by their "category":"gaming" key, not by the source).
const THEME_INJECTION_JS_GAMING_A =
  """
var __cdb_gaming="""

const THEME_INJECTION_JS_GAMING_B =
  """;
for(var __cdb_gk in __cdb_gaming)__cdb_builtins[__cdb_gk]=__cdb_gaming[__cdb_gk];
"""

# Middle: community palettes, config load/merge, theme resolution, the reusable CSS
# builder, comment-preserving activeTheme persistence, and the per-webContents
# stylesheet bookkeeping.
const THEME_INJECTION_JS_MID_A =
  """
var __cdb_community="""

const THEME_INJECTION_JS_MID_B =
  """;
// nordic is an alias for the nord built-in (CONTRACT 5). Add more aliases here as needed.
var __cdb_aliases={"nordic":"nord"};
var __cdb_marker="__cdb_dualvariant";
var __cdb_cfgPath=_path.join(_app.getPath("userData"),"claude-desktop-extra.json");
var __cdb_cfgPathC=_path.join(_app.getPath("userData"),"claude-desktop-extra.jsonc");
var __cdb_themesDir=_path.join(_app.getPath("userData"),"themes.d");
function __cdb_log(m){(globalThis.__cdbDiag||console.log)("[CustomThemes] "+m)}
// One-time rename migration (claude-desktop-bin -> claude-desktop-extra): copy
// each legacy file to its new name, pairwise (.json stays machine-written, .jsonc
// stays human-owned - crossing them would flip who owns which keys). Copies, not
// moves: the old files stay behind as backups. This is the SINGLE implementation;
// the growthbook-overrides and extra-settings patches call it lazily through
// globalThis.__cdbCfgMigrate. It lives here because this IIFE is the earliest
// config consumer (top-level __cdb_loadCfg below runs at bundle load).
var __cdb_migrate=function(){
try{
var ud=_app.getPath("userData"),pairs=[["claude-desktop-bin.jsonc","claude-desktop-extra.jsonc"],["claude-desktop-bin.json","claude-desktop-extra.json"]],i;
for(i=0;i<pairs.length;i++){
try{
var oldP=_path.join(ud,pairs[i][0]),newP=_path.join(ud,pairs[i][1]);
if(_fs.existsSync(newP)||!_fs.existsSync(oldP))continue;
_fs.copyFileSync(oldP,newP,_fs.constants.COPYFILE_EXCL);
__cdb_log("migrated "+pairs[i][0]+" -> "+pairs[i][1]+" (old file left in place as backup)");
}catch(e){if(!e||e.code!=="EEXIST")__cdb_log("config migration failed for "+pairs[i][0]+": "+(e&&e.message))}
}
}catch(e){}
};
globalThis.__cdbCfgMigrate=__cdb_migrate;
__cdb_migrate();
// Config may live in claude-desktop-extra.json (legacy plain JSON) and/or
// claude-desktop-extra.jsonc (commented template auto-created by the
// growthbook-overrides patch). Both are JSONC (comments stripped outside
// strings) and merged per key with .jsonc winning; themes maps merge per name.
//
// Trailing commas are dropped as well, and that is load-bearing: the .jsonc
// template tells the user to uncomment one line, every line there ends with a
// comma, and a single leftover comma would make JSON.parse throw and take the
// WHOLE config down with it - activeTheme included, not just the flag.
//
// This is the third of three copies of this stripper. Keep it behavior-identical
// to stripJsonComments() in js/growthbook_overrides.js and __cdbEx_strip() in
// js/extra_settings_main.js: if they disagree, the theme engine and the flag
// loader disagree about what the very same file says.
var __cdb_stripJsonc=function(s){var o="",q=false,i=0;while(i<s.length){var c=s[i];if(q){o+=c;if(c==="\\"&&i+1<s.length){o+=s[i+1];i++}else if(c==='"'){q=false}i++;continue}if(c==='"'){q=true;o+=c;i++;continue}if(c==="/"&&s[i+1]==="/"){while(i<s.length&&s[i]!=="\n")i++;continue}if(c==="/"&&s[i+1]==="*"){i+=2;while(i<s.length&&!(s[i]==="*"&&s[i+1]==="/"))i++;i+=2;continue}if(c===","){var j=i+1;while(j<s.length){if(s[j]===" "||s[j]==="\t"||s[j]==="\r"||s[j]==="\n"){j++;continue}if(s[j]==="/"&&s[j+1]==="/"){while(j<s.length&&s[j]!=="\n")j++;continue}if(s[j]==="/"&&s[j+1]==="*"){j+=2;while(j<s.length&&!(s[j]==="*"&&s[j+1]==="/"))j++;j+=2;continue}break}if(s[j]==="}"||s[j]==="]"){i++;continue}}o+=c;i++}return o};
var __cdb_readRaw=function(p){try{return _fs.readFileSync(p,"utf8")}catch(e){if(e.code!=="ENOENT")__cdb_log("Error reading "+p+": "+e.message);return null}};
var __cdb_parseFailed=false;
var __cdb_readCfg=function(p){var r=__cdb_readRaw(p);if(r===null)return null;try{return JSON.parse(__cdb_stripJsonc(r))}catch(e){__cdb_parseFailed=true;__cdb_log("Error parsing "+p+": "+e.message);return null}};
// One theme per file from themes.d/. A file is either the theme object itself (name =
// file stem, so matugen.json -> "matugen") or a {"themes":{"<name>":{...}}} wrapper.
// Files are read in sorted order, so x.jsonc lands after x.json and wins. A file that
// does not parse is logged and skipped; it can never take the config down.
function __cdb_loadThemesDir(){
var out={},names,i,f,p,obj,stem,k,n=0;
try{names=_fs.readdirSync(__cdb_themesDir)}catch(e){if(e.code!=="ENOENT")__cdb_log("Error reading "+__cdb_themesDir+": "+e.message);return out}
names.sort();
for(i=0;i<names.length;i++){
f=String(names[i]);
if(!/\.jsonc?$/i.test(f))continue;
p=_path.join(__cdb_themesDir,f);
obj=__cdb_readCfg(p);
if(obj===null)continue;
if(typeof obj!=="object"||Array.isArray(obj)){__cdb_log("themes.d/"+f+": not a theme object; skipped");continue}
stem=f.replace(/\.jsonc?$/i,"");
if(obj.themes&&typeof obj.themes==="object"&&!obj.light&&!obj.dark&&!obj.extends&&!__cdb_isVarMap(obj)){
for(k in obj.themes){out[k]=obj.themes[k];n++}
}else{out[stem]=obj;n++}
}
if(n)__cdb_log("themes.d: "+n+" theme(s) from "+__cdb_themesDir);
return out;
}
// Merge .json then .jsonc, per key and per theme name; .jsonc wins. Themes from
// themes.d/ sit below both config files.
function __cdb_loadCfg(){
__cdb_parseFailed=false;
// Only the two main files count as a parse failure (a broken themes.d drop-in is
// logged and skipped, it must not block reloads), so capture the flag before themes.d.
var j=__cdb_readCfg(__cdb_cfgPath),c=__cdb_readCfg(__cdb_cfgPathC),cfg={},k,pf=__cdb_parseFailed,d=__cdb_loadThemesDir();
for(k in (j||{}))cfg[k]=j[k];
for(k in (c||{}))cfg[k]=c[k];
cfg.themes={};
for(k in d)cfg.themes[k]=d[k];
for(k in ((j&&j.themes)||{}))cfg.themes[k]=j.themes[k];
for(k in ((c&&c.themes)||{}))cfg.themes[k]=c.themes[k];
cfg.__present=!(!j&&!c);
cfg.__parseError=pf;
return cfg;
}
function __cdb_pretty(s){return String(s).split(/[-_ ]+/).map(function(w){return w?w.charAt(0).toUpperCase()+w.slice(1):w}).join(" ")}
function __cdb_resolveName(n){return (n&&__cdb_aliases[n])?__cdb_aliases[n]:n}
// Resolution order: user themes > built-ins > bundled community palettes. Raw: the
// theme as authored, "extends" unresolved.
function __cdb_lookupRaw(cfg,name){
if(!name)return null;
if(cfg&&cfg.themes&&cfg.themes[name])return {theme:cfg.themes[name],src:"custom"};
if(__cdb_builtins[name])return {theme:__cdb_builtins[name],src:"builtin"};
if(__cdb_community[name])return {theme:__cdb_community[name],src:"community"};
return null;
}
// Same, but the theme comes back with its "extends" chain folded in.
function __cdb_lookup(cfg,name){
var hit=__cdb_lookupRaw(cfg,name);
if(!hit)return null;
return {theme:__cdb_effective(cfg,hit.theme,name),src:hit.src};
}
function __cdb_mergeVars(base,over){var o={},k;for(k in (base||{}))o[k]=base[k];for(k in (over||{}))o[k]=over[k];return o}
// The child's own contribution per mode: dual-variant maps as given (a missing mode
// contributes nothing, so the base shows through), a legacy flat map for both modes.
function __cdb_ownVariants(t){
if(t.light||t.dark)return {light:t.light||{},dark:t.dark||{}};
if(__cdb_isVarMap(t))return {light:t,dark:t};
return {light:{},dark:{}};
}
var __cdb_INHERIT=["chatFont","spinner","customCss"]; // name and category are NOT inherited: a user theme keeps its own label and lands in "Your themes"
var __cdb_EXTENDS_MAX=8;
// Fold "extends" into an effective theme: base first (recursively), then the child's
// light/dark maps over it per mode, child keys winning; the metadata keys above are
// inherited when the child lacks them. Themes without "extends" come back untouched.
function __cdb_effective(cfg,theme,name,seen,depth){
if(!theme||typeof theme!=="object"||typeof theme.extends!=="string"||!theme.extends)return theme;
seen=seen||{};depth=depth||0;
if(name)seen[name]=true;
var ext=theme.extends,canon=__cdb_resolveName(ext),base=null,hit;
if(seen[canon])__cdb_log("theme '"+(name||"?")+"' extends '"+ext+"' which is already in its inheritance chain (cycle); ignoring the base");
else if(depth>=__cdb_EXTENDS_MAX)__cdb_log("theme '"+(name||"?")+"' extends '"+ext+"': chain deeper than "+__cdb_EXTENDS_MAX+"; ignoring the base");
else{
hit=__cdb_lookupRaw(cfg,canon);
if(!hit)__cdb_log("theme '"+(name||"?")+"' extends unknown theme '"+ext+"' (not a user, built-in, or community theme); ignoring the base");
else{seen[canon]=true;base=__cdb_effective(cfg,hit.theme,canon,seen,depth+1)}
}
var out={},k,i;
// No usable base: the child stands alone, exactly as if "extends" were not there
// (so a dark-only child still mirrors dark into light, as any dark-only theme does).
if(!base){for(k in theme){if(k!=="extends")out[k]=theme[k]}return out}
var bv=__cdb_variants(base)||{light:{},dark:{}},cv=__cdb_ownVariants(theme);
for(k in theme){if(k!=="extends"&&k!=="light"&&k!=="dark"&&k.indexOf("--")!==0)out[k]=theme[k]}
for(i=0;i<__cdb_INHERIT.length;i++){k=__cdb_INHERIT[i];if(out[k]===undefined&&base[k]!==undefined)out[k]=base[k]}
out.light=__cdb_mergeVars(bv.light,cv.light);
out.dark=__cdb_mergeVars(bv.dark,cv.dark);
return out;
}
// Dual-variant -> use each; flat var map (legacy schema) -> the same map for both.
function __cdb_variants(t){
if(!t||typeof t!=="object")return null;
if(t.light||t.dark)return {light:t.light||t.dark,dark:t.dark||t.light};
if(__cdb_isVarMap(t))return {light:t,dark:t};
return null;
}
// The whole stylesheet for one theme: dual-variant var blocks, element overrides,
// optional font + customCss, spinner keyframes. null when the theme carries
// neither light/dark variants nor --token keys.
// Only the "--" tokens of a var map (the overlay contributes tokens, nothing else).
function __cdb_tokensOnly(m){var o={},k;for(k in (m||{})){if(k.indexOf("--")===0)o[k]=m[k]}return o}
// The overlay named by cfg.themeOverlay, resolved and reduced to its per-mode tokens;
// null when unset, unknown (logged) or token-less (logged).
function __cdb_overlayFor(cfg){
var raw=cfg&&cfg.themeOverlay;
if(typeof raw!=="string"||!raw)return null;
var canon=__cdb_resolveName(raw),hit=__cdb_lookup(cfg,canon);
if(!hit){__cdb_log("themeOverlay '"+raw+"' is not a user, built-in, or community theme; ignoring the overlay");return null}
var ov=__cdb_variants(hit.theme);
if(!ov){__cdb_log("themeOverlay '"+canon+"' has neither light/dark variants nor --token keys; ignoring the overlay");return null}
return {name:canon,light:__cdb_tokensOnly(ov.light),dark:__cdb_tokensOnly(ov.dark)};
}
function __cdb_buildCss(cfg,theme,name){
theme=__cdb_effective(cfg,theme,name);
var v=__cdb_variants(theme);
if(!v)return null;
var overlay=__cdb_overlayFor(cfg);
if(overlay){
v={light:__cdb_mergeVars(v.light,overlay.light),dark:__cdb_mergeVars(v.dark,overlay.dark)};
__cdb_log("Overlay '"+overlay.name+"' merged over '"+name+"' ("+Object.keys(overlay.light).length+" light, "+Object.keys(overlay.dark).length+" dark token(s))");
}
// Emit light first, dark second so dark wins on a specificity tie (both single-class/attr).
var css=":root,[data-mode=light]{"+__cdb_block(v.light)+"}";
css+=".darkTheme,[data-mode=dark],.dark{"+__cdb_block(v.dark)+"}";
// Element overrides (emit ONCE; reference semantic tokens so they are mode-correct).
css+=""
+"html,body{color:var(--claude-foreground-color)!important}"
+"#root,[id=root]{background:hsl(var(--bg-000))!important}"
+".dframe-sidebar{background-color:hsl(var(--bg-200))!important}"
+".dframe-content,.dframe-main,main.dframe-main{background-color:hsl(var(--bg-100))!important}"
+".dframe-root{--df-z1:var(--bg-100)!important;--df-z2:var(--bg-200)!important;--df-sidebar-bg:hsl(var(--bg-200))!important;--df-surface-primary:hsl(var(--bg-100))!important}"
+"[data-darker] .dframe-sidebar{background-color:hsl(var(--bg-300))!important}"
+":root,.cds-root,.epitaxy-root,[data-mode=dark],[data-mode=light]{--cds-page-bg:hsl(var(--bg-200))!important;--cds-surface-0:hsl(var(--bg-200))!important;--cds-surface-1:hsl(var(--bg-100))!important;--cds-surface-2:hsl(var(--bg-100))!important;--cds-surface-3:hsl(var(--bg-000))!important;--cds-surface-panel:hsl(var(--bg-100))!important;--cds-surface-popover:hsl(var(--bg-000))!important;--surface-primary:hsl(var(--bg-100))!important;--surface-primary-elevated:hsl(var(--bg-000))!important;--surface-popover:hsl(var(--bg-000))!important;--surface-panel:hsl(var(--bg-100))!important;--surface-hud:hsl(var(--bg-200))!important;--cds-text-primary:hsl(var(--text-000))!important;--cds-text-secondary:hsl(var(--text-200))!important;--cds-text-muted:hsl(var(--text-400))!important;--cds-border:hsl(var(--border-200) / 0.18)!important;--cds-clay:hsl(var(--accent-brand))!important}"
+".epitaxy-top-scrim{background:linear-gradient(hsl(var(--bg-100)),transparent)!important}"
+".epitaxy-bottom-scrim{background:linear-gradient(transparent,hsl(var(--bg-100)))!important}"
+".bg-white{background-color:hsl(var(--bg-000))!important}"
+".text-black{color:hsl(var(--text-000))!important}"
+".container{background:linear-gradient(to bottom,hsl(var(--bg-100)),hsl(var(--bg-000)))!important}"
+".container:before{border-color:hsl(var(--border-300) / 0.3)!important}"
+".input-box textarea{color:var(--claude-foreground-color)!important}"
+".input-box textarea::placeholder{color:var(--claude-text-500)!important}"
+".secondary{color:var(--claude-secondary-color)!important}"
+"input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),textarea,[contenteditable=true],.ProseMirror{background:transparent!important;color:hsl(var(--text-000))!important;border-color:transparent!important}"
+"[type=text]:focus,[type=email]:focus,[type=url]:focus,[type=password]:focus,[type=number]:focus,[type=search]:focus,textarea:focus,select:focus,[multiple]:focus{--tw-ring-color:hsl(var(--accent-100))!important;border-color:hsl(var(--accent-100))!important}"
+"::placeholder{color:hsl(var(--text-400))!important}"
+"[role=dialog],[role=menu],[role=listbox],[role=tooltip]{background:hsl(var(--bg-100))!important;color:hsl(var(--text-000))!important;border-color:hsl(var(--border-200) / 0.18)!important}"
+"hr{border-color:hsl(var(--border-200) / 0.25)!important}"
+"[type=checkbox]:checked{background-color:hsl(var(--accent-brand))!important;border-color:hsl(var(--accent-brand))!important}"
+"::selection{background:hsl(var(--accent-brand) / 0.3)!important}"
+"*{scrollbar-width:auto!important}"
+"::-webkit-scrollbar{width:6px!important;height:6px!important}"
+"::-webkit-scrollbar-thumb{background:hsl(var(--accent-brand) / 0.5)!important;border-radius:3px!important}"
+"::-webkit-scrollbar-thumb:hover{background:hsl(var(--accent-brand) / 0.7)!important}"
+"::-webkit-scrollbar-track{background:transparent!important}"
+"svg{color:inherit}"
+".nc-drag{color:hsl(var(--text-000))!important}"
+"a,button,[role=tab],[role=menuitem]{transition:background-color .15s ease,box-shadow .15s ease,border-color .15s ease!important}"
+".darkTheme [role=dialog],[data-mode=dark] [role=dialog]{box-shadow:0 0 0 1px hsl(var(--accent-brand) / 0.35),0 12px 40px rgba(0,0,0,0.5),0 0 30px hsl(var(--accent-brand) / 0.1)!important}"
+".darkTheme [role=menu],.darkTheme [role=listbox],[data-mode=dark] [role=menu],[data-mode=dark] [role=listbox]{box-shadow:0 0 0 1px hsl(var(--accent-brand) / 0.3),0 8px 24px rgba(0,0,0,0.4)!important}"
+".darkTheme button:not([disabled]):hover,[data-mode=dark] button:not([disabled]):hover{box-shadow:0 0 12px hsl(var(--accent-brand) / 0.3)!important}";
// SCOPE: upstream's desktop frame RE-SCOPES --bg-100 inside the chat subtree --
// `.dframe-content-inner{--bg-100:var(--df-bg-page-hsl)}` -- and --df-bg-page-hsl is a
// hardcoded stock gray on .dframe-root (e.g. `0 0% 5.5%` for dark + darker-default).
// Custom properties resolve per element: a declaration ON an element always beats an
// inherited value, !important or not, so the var blocks above (html scope) never reach
// past that container. Everything in the chat view that paints from --bg-100 therefore
// stayed stock near-black under a custom theme: the conversation header gradient
// (from-bg-100), the "Quick answer" band (from-bg-100 via-bg-100/90 to-bg-100/0) and
// the disclaimer strip (bg-bg-100). Re-assert the bg ramp at that scope from the
// --cdb-bg-* mirrors (which nothing re-scopes, so no var cycle is possible), and put
// the frame's own page-bg token on the theme so anything derived from it follows.
// Only tokens present in BOTH variants are re-asserted: a mirror missing in one mode
// would be invalid-at-computed-value-time there and would blank the surface instead.
var bgKeys=[],bk;
for(bk in v.light){if(bk.indexOf("--bg-")===0&&v.dark[bk])bgKeys.push(bk)}
if(bgKeys.length){
var reassert=[];
for(var bi=0;bi<bgKeys.length;bi++)reassert.push(bgKeys[bi]+":var(--cdb-"+bgKeys[bi].slice(2)+")!important");
css+=".dframe-content-inner{"+reassert.join(";")+"}";
__cdb_log("Inner-scope re-assert on .dframe-content-inner: "+bgKeys.join(","));
}
if(v.light["--bg-100"]&&v.dark["--bg-100"])
css+=".dframe-root{--df-bg-page-hsl:var(--cdb-bg-100)!important;--df-bg-page:hsl(var(--cdb-bg-100))!important}";
var font=(theme&&theme.chatFont)||(v.light&&v.light.chatFont)||(cfg&&cfg.chatFont),fontFlag=false;
if(font){
css+="html .font-claude-response-body,html .font-claude-response-title,html .font-claude-response,[data-user-message-bubble],[data-user-message-bubble] *{font-family:"+font+"!important}";
css+=":root{--theme-font-override:1}";
fontFlag=true;
__cdb_log("Font override: "+font);
}
// customCss: top-level and per-theme (string or array). Supported as before.
var extra=__cdb_toCss(cfg&&cfg.customCss);
var themeExtra=__cdb_toCss(theme.customCss)||__cdb_toCss(v.light&&v.light.customCss);
if(extra)css+="\n"+extra;
if(themeExtra)css+="\n"+themeExtra;
if(extra||themeExtra)__cdb_log("customCss appended ("+((extra?extra.length:0)+(themeExtra?themeExtra.length:0))+" chars)");
// Spinner spec: the active theme's `spinner` object (per-theme or flat-shared).
var spinnerJson="null",spec=(theme&&theme.spinner)||(v.light&&v.light.spinner)||null;
if(spec){try{spinnerJson=JSON.stringify(spec)}catch(e){spinnerJson="null"}}
// Spinner animation keyframes ship via insertCSS (SPINNER_INJECTION_NOTES 4) for
// EVERY animation name, whether or not THIS theme uses one: shapes switch live, so
// the sheet on the page must already carry the keyframes the next shape may want.
// "flip" is a two-frame sprite cycle - the injector renders <g data-cdb-frame="1|2">
// and the steps() pair below shows one frame at a time, ~2 frames/sec.
css+="@keyframes cdbSpin{to{transform:rotate(360deg)}}";
css+="@keyframes cdbBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-12%)}}";
css+="@keyframes cdbPulse{0%,100%{opacity:1}50%{opacity:.45}}";
css+="@keyframes cdbFlipA{from{opacity:1}to{opacity:0}}";
css+="@keyframes cdbFlipB{from{opacity:0}to{opacity:1}}";
css+="svg[data-cdb-spinner].cdb-anim-spin{animation:cdbSpin 1s linear infinite;transform-origin:50% 50%;transform-box:fill-box}";
css+="svg[data-cdb-spinner].cdb-anim-bounce{animation:cdbBounce .8s ease-in-out infinite;transform-origin:50% 50%;transform-box:fill-box}";
css+="svg[data-cdb-spinner].cdb-anim-pulse{animation:cdbPulse 1.2s ease-in-out infinite}";
css+="svg[data-cdb-spinner].cdb-anim-flip [data-cdb-frame=\"1\"]{animation:cdbFlipA 1s steps(2,jump-none) infinite}";
css+="svg[data-cdb-spinner].cdb-anim-flip [data-cdb-frame=\"2\"]{animation:cdbFlipB 1s steps(2,jump-none) infinite}";
if(spinnerJson!=="null")__cdb_log("Spinner spec present ("+spinnerJson.length+" chars JSON) for '"+name+"'");
return {css:css,font:fontFlag,spinnerJson:spinnerJson,overlay:overlay?overlay.name:null};
}
// --- activeTheme persistence (comment-preserving) --------------------------
// Walk the RAW text tracking string/comment state and return the value span of
// the first REAL "activeTheme" key. A commented-out example line is skipped,
// which a plain regex over the raw text would happily clobber.
function __cdb_scanActive(s){
var i=0,n=s.length,st,str,j,vs;
while(i<n){
var c=s[i];
if(c==="/"&&s[i+1]==="/"){while(i<n&&s[i]!=="\n")i++;continue}
if(c==="/"&&s[i+1]==="*"){i+=2;while(i<n&&!(s[i]==="*"&&s[i+1]==="/"))i++;i+=2;continue}
if(c!=='"'){i++;continue}
st=i;i++;
while(i<n){if(s[i]==="\\"){i+=2;continue}if(s[i]==='"')break;i++}
str=s.slice(st+1,i);i++;
if(str!=="activeTheme")continue;
j=i;while(j<n&&" \t\r\n".indexOf(s[j])>=0)j++;
if(s[j]!==":")continue;
j++;while(j<n&&" \t\r\n".indexOf(s[j])>=0)j++;
vs=j;
if(s[j]==='"'){j++;while(j<n){if(s[j]==="\\"){j+=2;continue}if(s[j]==='"'){j++;break}j++}}
else{while(j<n&&",}\r\n\t /".indexOf(s[j])<0)j++}
return {s:vs,e:j};
}
return null;
}
// Index of the opening brace of the top-level object (comment/string aware).
function __cdb_scanBrace(s){
var i=0,n=s.length;
while(i<n){
var c=s[i];
if(c==="/"&&s[i+1]==="/"){while(i<n&&s[i]!=="\n")i++;continue}
if(c==="/"&&s[i+1]==="*"){i+=2;while(i<n&&!(s[i]==="*"&&s[i+1]==="/"))i++;i+=2;continue}
if(c==='"'){i++;while(i<n){if(s[i]==="\\"){i+=2;continue}if(s[i]==='"')break;i++}i++;continue}
if(c==="{")return i;
i++;
}
return -1;
}
// Our own writes must not bounce through the file watcher: stamp a window the
// watcher ignores (reload's no-op detection is the second line of defense).
var __cdb_selfWriteUntil=0;
function __cdb_writeFile(p,txt){
try{__cdb_selfWriteUntil=Date.now()+1500;var tmp=p+".cdb-tmp";_fs.writeFileSync(tmp,txt,"utf8");_fs.renameSync(tmp,p);return {ok:true,path:p}}
catch(e){return {ok:false,error:"could not write "+p+": "+e.message}}
}
function __cdb_template(val){
return ["// claude-desktop-extra.jsonc - local Claude Desktop config. Comments are allowed;",
"// this file wins over claude-desktop-extra.json key by key.",
"{",
"  // Active theme slug: a built-in, a bundled community palette, or your own entry",
"  // under \"themes\". An empty string restores Claude's stock look.",
"  // The theme picker (Ctrl+Shift+T) rewrites this one line.",
"  \"activeTheme\": "+val+",",
"",
"  // Your own themes: \"<slug>\": {\"light\":{\"--bg-000\":\"0 0% 100%\"},\"dark\":{}}",
"  \"themes\": {}",
"}",
""].join("\n");
}
// .jsonc is the primary target because it wins the merge; fall back to .json,
// else create a commented .jsonc.
function __cdb_persist(name){
var val=JSON.stringify(name||""),targets=[__cdb_cfgPathC,__cdb_cfgPath],i,p,raw,span,out,at;
for(i=0;i<targets.length;i++){
p=targets[i];raw=__cdb_readRaw(p);
if(raw===null)continue;
span=__cdb_scanActive(raw);
if(span)out=raw.slice(0,span.s)+val+raw.slice(span.e);
else{
at=__cdb_scanBrace(raw);
if(at<0)return {ok:false,error:"no JSON object found in "+p};
out=raw.slice(0,at+1)+"\n  \"activeTheme\": "+val+","+raw.slice(at+1);
}
return __cdb_writeFile(p,out);
}
return __cdb_writeFile(__cdb_cfgPathC,__cdb_template(val));
}
// --- live stylesheet bookkeeping ------------------------------------------
// What is applied right now (rewritten by apply(), read by every later window).
var __cdb_state={name:null,src:"",css:"",font:false,spinnerJson:"null",overlay:null};
// webContents -> the insertCSS key we inserted last (null = nothing inserted).
var __cdb_wcKeys=new Map();
function __cdb_trackWc(wc){
if(__cdb_wcKeys.has(wc))return;
__cdb_wcKeys.set(wc,null);
wc.once("destroyed",function(){__cdb_wcKeys.delete(wc)});
}
function __cdb_styleOne(wc){
try{
if(wc.isDestroyed())return;
var old=__cdb_wcKeys.get(wc);
__cdb_wcKeys.set(wc,null);
if(old){var r=wc.removeInsertedCSS(old);if(r&&r.catch)r.catch(function(){})}
if(!__cdb_state.css)return;
var q=wc.insertCSS(__cdb_state.css);
if(q&&q.then)q.then(function(k){if(!wc.isDestroyed())__cdb_wcKeys.set(wc,k)},function(e){__cdb_log("insertCSS rejected: "+(e&&e.message))});
}catch(e){__cdb_log("insertCSS error: "+e.message)}
}
function __cdb_restyleAll(){
var n=0;
__cdb_wcKeys.forEach(function(_key,wc){if(!wc.isDestroyed()){__cdb_styleOne(wc);n++}});
return n;
}
"""

# Tail: the registry + live apply, the startup theme resolution, and the
# web-contents-created/dom-ready injection hook.
const THEME_INJECTION_JS_TAIL =
  """
// --- live spinner push -----------------------------------------------------
// One payload, used both at dom-ready and on every live switch: the spec, then the
// injector source. The injector installs its engine only once per window and then
// just calls window.__cdbSpinnerApply(spec) - so re-running it re-themes the glyphs
// already on screen (spec) or puts Claude's own back (null). That is what makes a
// theme change visible in the spinner without a restart.
function __cdb_spinnerPayload(){
return "var __CDB_SPINNER_SPEC="+__cdb_state.spinnerJson+";\n"+__cdb_spinnerSrc;
}
function __cdb_spinnerOne(wc){
try{
if(wc.isDestroyed())return false;
var q=wc.executeJavaScript(__cdb_spinnerPayload());
if(q&&q.catch)q.catch(function(e){__cdb_log("spinner injection rejected: "+(e&&e.message))});
return true;
}catch(e){__cdb_log("spinner injection error: "+e.message);return false}
}
function __cdb_spinnerAll(){
var n=0;
__cdb_wcKeys.forEach(function(_key,wc){if(!wc.isDestroyed()&&__cdb_spinnerOne(wc))n++});
return n;
}
// --- registry (always installed on Linux) ---------------------------------
// Every theme we know about, with its variants resolved. Later sources win, so a
// user theme shadows a built-in or community palette of the same slug.
function __cdb_listEntries(){
var cfg=__cdb_loadCfg(),map={},order=[],out=[],k,i;
function put(name,src,theme){
if(theme&&theme.hidden===true){delete map[name];return}
var v=__cdb_variants(theme);
if(!v)return;
if(!map[name])order.push(name);
map[name]={name:name,displayName:(theme&&typeof theme.name==="string"&&theme.name)||__cdb_pretty(name),source:src,category:(theme&&typeof theme.category==="string"&&theme.category)||"",light:v.light,dark:v.dark};
}
for(k in __cdb_community)put(k,"community",__cdb_community[k]);
for(k in __cdb_builtins)put(k,"builtin",__cdb_builtins[k]);
for(k in (cfg.themes||{}))put(k,"custom",__cdb_effective(cfg,cfg.themes[k],k));
for(i=0;i<order.length;i++)if(map[order[i]])out.push(map[order[i]]);
return out;
}
// Switch theme without a restart: rebuild the sheet, swap it in every tracked
// webContents, then persist. "" or null restores the stock look.
function __cdb_applyTheme(name){
try{
if(name===null||name===undefined||name===""){
__cdb_state={name:null,src:"",css:"",font:false,spinnerJson:"null",overlay:null};
var m=__cdb_restyleAll(),ms=__cdb_spinnerAll(),rp=__cdb_persist("");
if(!rp.ok)return {ok:false,error:"reverted "+m+" window(s) but could not save: "+rp.error};
__cdb_log("Reverted to the stock look in "+m+" window(s), restored the glyph in "+ms);
return {ok:true,saved:_path.basename(rp.path)};
}
if(typeof name!=="string")return {ok:false,error:"theme name must be a string"};
var canon=__cdb_resolveName(name),cfg=__cdb_loadCfg(),hit=__cdb_lookup(cfg,canon);
if(!hit)return {ok:false,error:"'"+name+"' is not a user, built-in, or community theme"};
var built=__cdb_buildCss(cfg,hit.theme,canon);
if(!built)return {ok:false,error:"'"+canon+"' has neither light/dark variants nor --token keys"};
__cdb_state={name:canon,src:hit.src,css:built.css,font:built.font,spinnerJson:built.spinnerJson,overlay:built.overlay};
var n=__cdb_restyleAll(),ns=__cdb_spinnerAll(),p=__cdb_persist(canon);
if(!p.ok)return {ok:false,error:"applied to "+n+" window(s) but could not save: "+p.error};
__cdb_log("Applied "+hit.src+" theme '"+canon+"' to "+n+" window(s) (spinner pushed to "+ns+"), saved to "+p.path);
return {ok:true,saved:_path.basename(p.path)};
}catch(e){return {ok:false,error:(e&&e.message)||String(e)}}
}
// Re-read the config from disk and re-apply what it says, without persisting: the
// file is the source of truth here (edited by hand, by matugen, by a sync client).
// An unset activeTheme reverts to stock. Identical output -> no window is touched.
function __cdb_reload(reason){
try{
var cfg=__cdb_loadCfg(),raw=cfg.activeTheme,next={name:null,src:"",css:"",font:false,spinnerJson:"null",overlay:null};
if(cfg.__parseError)return {ok:false,error:"a config file has a syntax error (see log); keeping the current theme"};
if(raw!==null&&raw!==undefined&&raw!==""){
if(typeof raw!=="string")return {ok:false,error:"activeTheme must be a string"};
var canon=__cdb_resolveName(raw),hit=__cdb_lookup(cfg,canon);
if(!hit)return {ok:false,error:"'"+raw+"' is not a user, built-in, or community theme"};
var built=__cdb_buildCss(cfg,hit.theme,canon);
if(!built)return {ok:false,error:"'"+canon+"' has neither light/dark variants nor --token keys"};
next={name:canon,src:hit.src,css:built.css,font:built.font,spinnerJson:built.spinnerJson,overlay:built.overlay};
}
if(next.name===__cdb_state.name&&next.css===__cdb_state.css&&next.font===__cdb_state.font&&next.spinnerJson===__cdb_state.spinnerJson&&next.overlay===__cdb_state.overlay)return {ok:true,changed:false,name:next.name,overlay:next.overlay};
__cdb_state=next;
var n=__cdb_restyleAll();
__cdb_spinnerAll();
__cdb_log("reload ("+reason+"): applied '"+(next.name||"")+"' to "+n+" window(s)");
return {ok:true,changed:true,name:next.name,overlay:next.overlay,windows:n};
}catch(e){return {ok:false,error:(e&&e.message)||String(e)}}
}
globalThis.__cdbThemes={version:2,list:__cdb_listEntries,active:function(){return __cdb_state.name},overlay:function(){return __cdb_state.overlay},apply:__cdb_applyTheme,reload:__cdb_reload,configPath:__cdb_cfgPathC,themesDir:__cdb_themesDir};
// --- file watcher -----------------------------------------------------------
// Watch DIRECTORIES, not files: our writer and tools like matugen write tmp+rename,
// which orphans a file-level inotify watch. Events for the two config files (and
// anything in themes.d/) are debounced into one reload; config-file events inside the
// self-write window are ours and ignored (nothing of ours ever writes to themes.d). Every step is guarded - fs.watch can throw on some
// filesystems and a dead watcher must never cost the user their theme.
var __cdb_watchTimer=null,__cdb_watchWhy="",__cdb_watchers=[],__cdb_themesDirWatcher=null;
function __cdb_watchKick(why,ours){
if(ours&&Date.now()<__cdb_selfWriteUntil)return;
__cdb_watchWhy=why;
if(__cdb_watchTimer)clearTimeout(__cdb_watchTimer);
__cdb_watchTimer=setTimeout(function(){
__cdb_watchTimer=null;
var w=__cdb_watchWhy;__cdb_watchWhy="";
var r=__cdb_reload("file watch: "+w);
if(!r.ok)__cdb_log("reload after file watch ("+w+") failed: "+r.error);
},300);
if(__cdb_watchTimer.unref)__cdb_watchTimer.unref();
}
function __cdb_watchThemesDir(){
if(__cdb_themesDirWatcher){try{__cdb_themesDirWatcher.close()}catch(e){}__cdb_themesDirWatcher=null}
try{
if(!_fs.existsSync(__cdb_themesDir))return false;
var w=_fs.watch(__cdb_themesDir,{persistent:false},function(_ev,fn){
fn=fn?String(fn):"";
if(fn&&!/\.jsonc?$/i.test(fn))return;
__cdb_watchKick("themes.d/"+(fn||"?"));
});
w.on("error",function(e){__cdb_log("themes.d watcher error: "+(e&&e.message));try{w.close()}catch(_e){}if(__cdb_themesDirWatcher===w)__cdb_themesDirWatcher=null});
__cdb_themesDirWatcher=w;
__cdb_log("watching "+__cdb_themesDir+" for theme files");
return true;
}catch(e){__cdb_log("could not watch "+__cdb_themesDir+": "+(e&&e.message));return false}
}
function __cdb_startWatch(cfg){
if(cfg&&cfg.themeWatch===false){__cdb_log("watcher disabled (themeWatch:false)");return false}
try{
var ud=_app.getPath("userData");
try{_fs.mkdirSync(ud,{recursive:true})}catch(_e){}
var w=_fs.watch(ud,{persistent:false},function(_ev,fn){
fn=fn?String(fn):"";
// The directory itself appeared, vanished or was replaced: re-arm its watcher, then
// reload because its contents may have changed wholesale.
if(fn==="themes.d"){__cdb_watchThemesDir();__cdb_watchKick(fn);return}
if(fn!=="claude-desktop-extra.json"&&fn!=="claude-desktop-extra.jsonc")return;
__cdb_watchKick(fn,true);
});
w.on("error",function(e){__cdb_log("config watcher error: "+(e&&e.message));try{w.close()}catch(_e){}});
__cdb_watchers.push(w);
__cdb_log("watching "+ud+" for config changes (themeWatch)");
__cdb_watchThemesDir();
return true;
}catch(e){__cdb_log("file watcher unavailable ("+(e&&e.message)+"); edit the config and restart to re-theme");return false}
}
// --- startup: apply the configured theme ---------------------------------
// Only the CSS application is skipped when there is nothing to apply; the
// registry above and the hook below are installed either way.
try{
__cdb_log("Reading config: "+__cdb_cfgPath+" + .jsonc");
var __cdb_cfg0=__cdb_loadCfg();
if(!__cdb_cfg0.__present)__cdb_log("No config file found (claude-desktop-extra.json/.jsonc); registry installed, no theme applied");
else{
var __cdb_name0=__cdb_cfg0.activeTheme;
if(!__cdb_name0)__cdb_log("No activeTheme set; registry installed, no theme applied");
else{
if(__cdb_aliases[__cdb_name0]){__cdb_log("Alias '"+__cdb_name0+"' -> '"+__cdb_aliases[__cdb_name0]+"'");__cdb_name0=__cdb_aliases[__cdb_name0]}
__cdb_log("Active theme: "+__cdb_name0);
var __cdb_hit0=__cdb_lookup(__cdb_cfg0,__cdb_name0);
if(!__cdb_hit0){
// LOUD fallback (CONTRACT 5): do not silently succeed.
(globalThis.__cdbDiag||console.log)("%c[CustomThemes] THEME NOT FOUND: '"+__cdb_name0+"'","color:#ff5555;font-weight:bold");
__cdb_log("Not among "+Object.keys(__cdb_cfg0.themes||{}).length+" config theme(s), "+Object.keys(__cdb_builtins).length+" built-in(s) or "+Object.keys(__cdb_community).length+" bundled community palette(s).");
__cdb_log("Valid built-in names: "+Object.keys(__cdb_builtins).concat(Object.keys(__cdb_aliases)).join(", "));
__cdb_log("Press Ctrl+Shift+T to browse every theme, or define \""+__cdb_name0+"\" under \"themes\" in "+__cdb_cfgPathC+". Nothing applied.");
}else{
var __cdb_built0=__cdb_buildCss(__cdb_cfg0,__cdb_hit0.theme,__cdb_name0);
if(!__cdb_built0)__cdb_log("Theme '"+__cdb_name0+"' has neither light/dark variants nor --token keys; nothing applied");
else{
__cdb_state={name:__cdb_name0,src:__cdb_hit0.src,css:__cdb_built0.css,font:__cdb_built0.font,spinnerJson:__cdb_built0.spinnerJson,overlay:__cdb_built0.overlay};
__cdb_log("Loaded "+__cdb_hit0.src+" theme '"+__cdb_name0+"' (dual-variant) with element overrides");
}
}
}
}
}catch(e){
__cdb_log("Error applying config: "+e.message)
}
__cdb_startWatch(typeof __cdb_cfg0==="object"?__cdb_cfg0:null);
// Reads __cdb_state at dom-ready, so a window opened after a live switch gets
// the CURRENT theme rather than whatever was active at startup.
_app.on("web-contents-created",function(_ev,wc){
wc.on("dom-ready",function(){
try{
var url=wc.getURL()||"";
if(url.indexOf("devtools://")===0)return;
if(url.indexOf("http://localhost")===0||url.indexOf("http://127.0.0.1")===0||url.indexOf("https://localhost")===0)return;
if(url.indexOf("cdb-theme-picker")>=0)return;
__cdb_trackWc(wc);
if(!__cdb_state.css)return;
__cdb_styleOne(wc);
if(__cdb_state.font){var qf=wc.executeJavaScript("window.__themeFontOverride=true;");if(qf&&qf.catch)qf.catch(function(){})}
__cdb_spinnerOne(wc);
__cdb_log("Injected CSS+JS into "+url);
}catch(e){__cdb_log("dom-ready hook error: "+e.message)}
});
});
})();"""

# Assemble the full IIFE: HEAD (helpers + built-ins), the compile-time-validated
# gaming palettes merged into the built-ins, the community palette map, MID
# (config/resolve/build/persist/bookkeeping), the staticRead'd spinner injector as a JS
# string literal (escapeJson yields a quoted, fully-escaped literal suitable for
# executeJavaScript), then TAIL.
const THEME_INJECTION_JS =
  THEME_INJECTION_JS_HEAD & THEME_INJECTION_JS_GAMING_A & GAMING_JSON &
  THEME_INJECTION_JS_GAMING_B & THEME_INJECTION_JS_MID_A & COMMUNITY_JSON &
  THEME_INJECTION_JS_MID_B & "\nvar __cdb_spinnerSrc=" & escapeJson(SPINNER_INJECTOR_JS) &
  ";\n" & THEME_INJECTION_JS_TAIL

# Positive end-state markers (Rule 6). ALL must be present after patching, and all are
# what an "already applied" run must find: the dual-variant css build, the
# always-installed registry the theme picker talks to, the gaming palettes merged into
# the built-ins, and the live spinner API the switch pushes into every window.
const MARKERS = [
  "__cdb_dualvariant", "globalThis.__cdbThemes=",
  "__cdb_builtins[__cdb_gk]=__cdb_gaming[__cdb_gk]", "window.__cdbSpinnerApply",
  "reload:__cdb_reload", "function __cdb_effective(",
]

proc apply*(input: string): string =
  result = input

  # Idempotency: assert OUR end-state is present, not merely that some older
  # build is gone.
  var present = 0
  for m in MARKERS:
    if m in result:
      present.inc
  if present == MARKERS.len:
    echo "  [INFO] Theme engine already injected (" & $present & "/" & $MARKERS.len &
      " markers present)"
    echo "  [PASS] No changes needed (already patched)"
    return
  if present > 0:
    echo "  [FAIL] Partial injection detected (" & $present & "/" & $MARKERS.len &
      " markers) -- refusing to patch on top; re-audit the bundle"
    quit(1)

  # Inject right after "use strict"; at the top of the file
  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & THEME_INJECTION_JS & result[strictPrefix.len .. ^1]
    echo "  [OK] Theme engine IIFE inserted after \"use strict\""
  else:
    result = THEME_INJECTION_JS & result
    echo "  [OK] Theme engine IIFE prepended"

  # Positive end-state assertion: every marker we introduced must now be present.
  var found = 0
  for m in MARKERS:
    if m in result:
      found.inc
    else:
      echo "  [FAIL] marker missing after injection: " & m
  if found < MARKERS.len:
    echo "  [FAIL] Only " & $found & "/" & $MARKERS.len & " markers present -- aborting"
    quit(1)
  echo "  [OK] " & $found & "/" & $MARKERS.len & " end-state markers verified"
  echo "  [OK] Bundled community palettes: " & $COMMUNITY_COUNT
  echo "  [OK] Bundled gaming palettes: " & $GAMING_COUNT &
    " (builtin tier, own picker section)"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_custom_themes <path_to_index.js>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: add_feature_custom_themes ==="
  echo "  Target: " & filePath

  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)

  let input = readFile(filePath)
  let output = apply(input)

  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Custom theme support added"
  else:
    echo "  [WARN] No changes made"

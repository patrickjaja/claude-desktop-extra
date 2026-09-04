# Claude Desktop Feature Flag Architecture

Reference documentation for the feature flag system in Claude Desktop's Electron app, to aid patch maintenance. The architecture/prose below was first written against v1.8555.2; minified names drift every release, so the **version history table at the bottom is the authoritative record of renames** (current through v1.46388.2; since v1.26832.0 the minifier emits backtick string literals, so grep with quote-tolerant classes; since v1.32352.1 it also emits numeric object keys UNQUOTED regardless of magnitude - `2973881027:DO(...)` - so a quoted-literal-only sweep reports false "removed" flags; sweep `[,{(]\d{6,10}:` keys too). Always cross-check a specific name there before trusting it.

**Code-split caveat (v1.19367.0+):** the main bundle is split into `index.js` (stub) + content-hashed `index.chunk-*.js` files + `index.pre.js`. From v1.26832.0 to v1.40609.0 there was a **second chunk family**, `index2.chunk-*.js`, belonging to the same logical bundle; **v1.46388.2 folds it back into one family** (158 `index.chunk-*` files, no `index2.chunk-*`). The orchestrator stages `index*.chunk-*` and therefore covers both layouts. Minified names are **per-chunk**: the same function can appear under different local names in different chunks (e.g. the boolean flag reader is `AI()` in the chunk that holds the registry but `t.Qu()` behind an import alias elsewhere). When grepping, search across ALL `index*.js` files (or the orchestrator's concatenation), and do not assume one canonical name per function.

Which chunk holds what also moves between releases - the static registry sat in `index2.chunk-*` in v1.28929.0 and in `index.chunk-*` since v1.30096.1 (registry, merger, GrowthBook store and reader exports all in `index.chunk-DrnJEXHK.js` in v1.46388.2, `index.chunk-Ci77nY41.js` in v1.40609.0, `index.chunk-DkKx6nb2.js` in v1.37937.0, `index.chunk-RiH_RK8u.js` in v1.34493.1, `index.chunk-CdfeLm1B.js` in v1.32885.1, `index.chunk-BFWQf1ai.js` in v1.32352.1). **An audit concat built from `index.chunk-*` alone is not the bundle**; it will show real, still-present flags as "removed". Always concatenate both families.

## Overview

Feature flags are controlled by a 3-layer system (current minified names — see version-history table for the rename trail):

1. **`OB()` (static, module-scoped)** - Calls individual feature functions, builds base object (was `iB()` in v1.40609.0, `fB()` in v1.37937.0, `uR()` in v1.34493.1, `RH()` in v1.32885.1, `JB()` in v1.32352.1, `$V()` in v1.30096.1, `X()` in v1.26832.0-v1.28929.0, `Ku()` in v1.20186.1-v1.21459.0, `yh()` in v1.19367.0, `sM()` in v1.18286.x). The maturity post-processor is called INLINE (since v1.32885.1) - `function OB(){let e=cSn();return USn({launch:CB,coworkBrowser:xSn(),artifactsPane:DB(),nativeQuickEntry:kxn(),...})}` - `launch` is a STATIC always-supported entry (flag `2976814254` is gone from the bundle), not an async override; the yukonSilver/Gems/GemsCache status is hoisted once (`let e=cSn()`, was `usn()`/`f3t()`/`tZt()`/`V2t()`/`e9t()`). The post-processor `USn()` (was `Hsn()`/`U3t()`/`CZt()`/`l4t()`/`S9t()`/`u$t()`) stamps `maturity:"beta"` onto supported features in a list (beta list const `fbn`, was `Ian`/`f2t`; in v1.46388.2 it still holds the single entry `surfaceTogglesPreview`; cosmetic, no gating). Supported constant `CB` (was `tB`/`lB`/`cR`/`LH`/`qB`). Since v1.46388.2 the minifier emits plain double-quoted strings again (`{status:"unavailable"}`, not backticks), so quote-tolerant classes stay necessary across releases. 71 static entries in v1.46388.2 (64 in v1.40609.0, 62 in v1.37937.0, 59 in v1.34493.1, 57 in v1.32885.1).
2. **`WSn(e)` (async merger)** (was `oB(e)` in v1.40609.0, `mB(e)` in v1.37937.0, `wZt` in v1.34493.1, `u4t` in v1.32885.1, `C9t` in v1.32352.1) - since v1.37937.0 it takes an options argument (`e?.primeManagedPreviewPolicy`, which drives one extra non-destructured `Promise.all` slot). Spreads `OB()` and applies the async overrides: returns `{...OB(),...m}` where `m={louderPenguin,coworkKappa,coworkArtifacts,coworkAutoModeAlwaysAllowOverride,sideSessions,coworkWatchRecord,coworkWatchers,ccdGitEngine,sessionPrOwnership,violinBow,violinBowHomeSettings,computerUseAppScoped,wslForkSession}` (**13 overrides as of v1.46388.2**, same count as v1.37937.0-v1.40609.0 but two slots swapped: `epitaxyMcpApps` and `chillingSlothSshWorktreeLocation` left the merger for the static registry, `sideSessions` and `wslForkSession` joined it; 10 in v1.34493.1 and 9 in v1.32352.1-v1.32885.1; `sessionPrOwnership` still reuses the SAME destructured slot as `ccdGitEngine` (`ccdGitEngine:c,sessionPrOwnership:c`), i.e. both are gated by flag `959099749` via the 5s-delayed probe helper `kB(nB)` (was `aB(Bz)`/`pB(Jz)`/`dR(qL)`/`zH(SH)`/`YB(jB)`); 8 overrides in v1.26832.0-v1.30096.1, where `deterministicCreatePr` held the last slot until v1.28929.0 replaced it with `ccdGitEngine`). GrowthBook-read overrides (v1.46388.2): coworkKappa `123929380`, coworkArtifacts `2940196192`, coworkAutoModeAlwaysAllowOverride `4200321681` (all three via the yukonSilver-gated `jSn(()=>wS(id))`), **sideSessions `2371478310`** (`kB(()=>wS("2371478310"))`, new), ccdGitEngine + sessionPrOwnership `959099749` (`kB(nB)`), **wslForkSession `3724674924`** (`kB(_bn)`, new; static entry `{status:"unavailable"}`, Windows-only feature so inert on Linux even when the flag is ON); `coworkWatchers` reads the scheduled-tasks module's `watchersEnabled()` (a config callback, not a direct flag read). **`violinBow` is `kB(Ibn)` where `function Ibn(){return!1}`** (was `aB(Han)`/`pB(J2t)`/`dR(UYt)`) and **`violinBowHomeSettings` is `MSn(){return{status:"unavailable"}}`** - both hardcoded off, no flag, so they resolve `{status:"unavailable"}` on every platform (a `ViolinBowDisabledError` class exists for sessions that request it). **`computerUseAppScoped`** resolves through `LSn()` -> `PSn()`, which is macOS 15+ only, so it is **unsupported on Linux**. **`epitaxyMcpApps` is now a plain static `CB` (always supported; flag `3516166472` is gone from the bundle)** and **`chillingSlothSshWorktreeLocation` is now static-only `Ixn()`** - supported unless the managed `workspace.allowedFolders` list is set (`disabled_by_enterprise`); flag `1315974108` is gone. `markTaskComplete` was removed in v1.17282.0; `launch` left the merger for the static registry (observed v1.26832.0). Three final `Promise.all` slots (`Promise.resolve(void 0)`, `TB()` = overlay/virtualization probes, and the `primeManagedPreviewPolicy` probe) are awaited but not destructured into the override object.
3. **IPC handler** - Calls merger, validates against schema, sends to renderer

**Reader identity is greppable, don't guess it.** The GrowthBook chunk (`index.chunk-DkKx6nb2.js` in v1.37937.0, `index.chunk-RiH_RK8u.js` in v1.34493.1, `index.chunk-CdfeLm1B.js` in v1.32885.1, `index.chunk-BFWQf1ai.js` in v1.32352.1, `index.chunk-BzNP_oYx.js` in v1.30096.1) ends its module with an export map that pairs the readable API name to that release's minified symbol:

```javascript
// v1.46388.2 (index.chunk-DrnJEXHK.js)
e.r({areFeaturesLoaded:()=>mS,getFeatureValue:()=>CS,getParsedFeatureValueForKey:()=>OS,
     growthbookEmitter:()=>Xx,initGrowthBook:()=>evt,isFeatureEnabled:()=>wS,
     isFeatureEnabledWithDefault:()=>TS,isGrowthBookFreshForCurrentAccount:()=>ES,
     isGrowthBookFreshWithin:()=>lvt,observeFeatureGate:()=>yS,onFeatureChange:()=>vS,
     onGrowthBookFreshChange:()=>DS,onGrowthBookNetworkFetch:()=>uvt,
     peekFeatureGate:()=>rvt,refreshGrowthBook:()=>_S,waitForGrowthBookReady:()=>hS,
     waitForGrowthBookSettled:()=>gS,withGateRefresh:()=>nvt})
// v1.40609.0 (index.chunk-Ci77nY41.js): isFeatureEnabled HS, isFeatureEnabledWithDefault US,
//   getFeatureValue VS, getParsedFeatureValueForKey KS, onFeatureChange IS, observeFeatureGate LS,
//   peekFeatureGate bdt
// v1.37937.0 (index.chunk-DkKx6nb2.js): isFeatureEnabled Xw, isFeatureEnabledWithDefault Zw,
//   getFeatureValue Yw, getParsedFeatureValueForKey nT, onFeatureChange Hw, observeFeatureGate Uw,
//   peekFeatureGate Pat
```

Grep `isFeatureEnabled:\(\)=>` first; everything else follows from that block. New exports in v1.32352.1: **`isFeatureEnabledWithDefault`** (`$ct(id,dflt)` - boolean read with an explicit fallback, e.g. `$ct(\`3018088575\`,!0)`), `isGrowthBookFreshForCurrentAccount`, `onGrowthBookFreshChange`. New exports in v1.37937.0: **`peekFeatureGate`** (`rvt` in v1.46388.2), **`onGrowthBookNetworkFetch`** (`uvt` - the one-shot network-fetch listener the tray/poll config uses) and **`withGateRefresh`** (`nvt`). No export added or removed in v1.40609.0 or v1.46388.2 (17 exports). **Reader shapes** - bare in the GrowthBook chunk, module-qualified elsewhere (the import alias varies per chunk):

| Role | Bare (v1.46388.2) | Dotted (v1.46388.2) | v1.40609.0 (bare/dotted) | v1.37937.0 (bare/dotted) | v1.34493.1 (bare/dotted) | v1.32885.1 (bare/dotted) | v1.32352.1 (bare/dotted) | v1.30096.1 (bare/dotted) |
|------|-------------------|---------------------|--------------------------|--------------------------|--------------------------|--------------------------|--------------------------|--------------------------|
| boolean | `wS(id)` | `.aD(id)` | `HS` / `.yC` | `Xw` / `.Gx` | `XS` / `.Sb` | `Iw` / `.Ey` | `KE` / `.ty` | `AI` / `.Qu` |
| boolean with default | `TS(id,dflt)` | `.oD(id,dflt)` | `US` / `.bC` | `Zw` / `.Kx` | `Yit` / `.Cb` | `Uit` / - | `$ct` / - | - (new export) |
| value with default | `CS(id,dflt)` | `.nD(id,dflt)` | `VS` / `.gC` | `Yw` / `.Hx` | `YS` / `.yb` | `Fw` / `.Cy` | `GE` / `.Qv` | `kI` / `.Yu` |
| keyed config value | `OS(id,key,dflt,zodType)` | `.rD(id,key,dflt,zodType)` | `KS` / `._C` | `nT` / `.Ux` | `eC` / `.bb` | `zw` / `.wy` | `XE` / `.$v` | `NI` / `.Xu` |
| change listener | `vS(id,cb)` | `.lD(id,cb)` | `IS` / `.CC` | `Hw` / `.Yx` | `WS` / `.Eb` | `Aw` / `.ky` | `RE` / `.iy` | `wI` / `.td` |
| observe gate | `yS(id,cb)` | `.cD(id,cb)` | `LS` / `.SC` | `Uw` / `.Jx` | `GS` / `.Tb` | - | - | - |

(In v1.46388.2: `areFeaturesLoaded` = `mS` / `.tD`, `isGrowthBookFreshForCurrentAccount` = `ES` / `.sD`, `waitForGrowthBookSettled` = `gS` / `.pD`, `onGrowthBookFreshChange` = `DS` / `.uD`, `refreshGrowthBook` = `_S` / `.dD`, `waitForGrowthBookReady` = `hS` / `.fD`, `withGateRefresh` = `nvt` / `.mD`; `peekFeatureGate` (`rvt`), `onGrowthBookNetworkFetch` (`uvt`) and `isGrowthBookFreshWithin` (`lvt`) have no dotted re-export. In v1.37937.0: `observeFeatureGate` = bare `Uw` / dotted `.Jx`, `areFeaturesLoaded` = `Lw` / `.Vx`, `isGrowthBookFreshForCurrentAccount` = `Qw` / `.qx`, `waitForGrowthBookSettled` = `zw` / `.Qx`, `onGrowthBookFreshChange` = `eT` / `.Xx`, `refreshGrowthBook` = `Bw` / `.Zx`, `waitForGrowthBookReady` = `Rw` with **no dotted re-export** (nor do `isGrowthBookFreshWithin`, `onGrowthBookNetworkFetch`, `peekFeatureGate` and `withGateRefresh`). In v1.34493.1 these were `GS`/`.Tb`, `BS`/`.vb`, `ZS`/`.wb`, `HS`/`.kb`, `$S`/`.Db`, `US`/`.Ob`. The dotted names are `Object.defineProperty(exports,"<name>",...)` re-exports on the same chunk - grep `exports,"XX",{enumerable:!0,get:function(){return <bare>}` to rebuild the map. Older columns live in the version-history table.)

`Bm()` listener, `Pr()` multi-key reader, `Lh()` single-value reader names are v1.18286-era; re-verify per chunk. Since v1.26832.0 several flag IDs are **hoisted into module-scope consts** (`c=\`1291166712\``, `Q=\`2358734848\``) and only the const is passed to the reader - a call-shaped `FN("digits")` grep misses them; sweep `[\w$]+=[\`"]\d{6,10}[\`"]` too, or just diff every quoted 6-10 digit literal across the whole bundle.

**Our override layer (add_growthbook_overrides.nim, since 2026-07-11):** all GrowthBook load paths (network fetch `/api/desktop/features`, encrypted `fcache` disk cache, deployment-mode hardcoded set) funnel through a single features-store setter (**`G_t(e,t){tS=t;let n=eS;eS=B_t(e);...}` in v1.46388.2, chunk `index.chunk-DrnJEXHK.js`** - store `eS`, source tag `tS`, transform `B_t`; was `ldt`/store `vS`/tag `yS`/transform `idt` in v1.40609.0 (`index.chunk-Ci77nY41.js`) and `Dat(e,t){bw=t;let n=yw;yw=Cat(e);...}` in v1.37937.0 (`index.chunk-DkKx6nb2.js`, store `yw`, source tag `bw`); there is no dirty flag and the stored map funnels through the TRANSFORM (`Cat(e)` in v1.37937.0), which is the deployment-mode hardcoded-features filter (`hardcodedMainGrowthBookFeatures()` + `growthBookRemoteAllowedKeys()`) that used to be a separate load path calling the setter - so the patch wraps the transform CALL, not the raw parameter, to keep overrides winning over the hardcoded set. Was `Fit(e,t){OS=t;let n=DS;DS=jit(e);...}` (store `DS`, source tag `OS`, chunk `index.chunk-RiH_RK8u.js`) in v1.34493.1, `Mit(e){let t=gw;gw=e,_w=!0;...}` in v1.32885.1, `qct`/store `bE`/dirty `xE` in v1.32352.1, `KMt`/store `dI`/dirty `fI` in v1.30096.1, `Gk`/store `xk`/dirty `Sk` in v1.28929.0, `tS`/store `Mx`/dirty `Nx` in v1.26832.0, `HVe`/`Ys`/`CS` in v1.21459.0, `hTt`/store var `lf` in v1.19367.0-v1.20186.1 - anchored by the log string `"[growthbook] loaded %d features (%d changed)"`). The patch hooks its head to merge the `growthbookOverrides` map from `<userData>/claude-desktop-bin.jsonc` (primary, auto-created commented template) and legacy `<userData>/claude-desktop-bin.json` (both JSONC-parsed; `.jsonc` wins per key; same shared config file as custom themes) over the loaded map on a shallow copy. Effective layering: user JSON override > server GrowthBook > (separately) our call-site force rewrites, which bypass the store entirely and are NOT affected by the JSON file. Readers consume `Ys[id].on` (boolean, `ht()` in v1.21459.0, was `At()`/`rt()`) and `Ys[id].value` (value flags, `ga()`/`Vr()`); overrides write `{on, value, source:"cdb-override"}`.

Feature name strings (`chillingSlothFeat`, `louderPenguin`, etc.) are runtime IPC identifiers, **not minified** - they are stable pattern anchors.

## All Features (30 listed; `markTaskComplete` removed in v1.17282.0)

| # | Feature | Function | Gate | Purpose |
|---|---------|----------|------|---------|
| 1 | `nativeQuickEntry` | `f7i()` | `platform !== "darwin"` + macOS >= 13 | Native Quick Entry (macOS only) |
| 2 | `quickEntryDictation` | `p7i()` | `platform !== "darwin"` + macOS >= 14.0 + mic | Quick Entry dictation |
| 3 | `customQuickEntryDictationShortcut` | direct value `gK` | None | Custom dictation shortcut value |
| 4 | `plushRaccoon` | `PM(() => gK)` | **PM() production gate** | Custom dictation shortcut (dev-gated) |
| 5 | `quietPenguin` | `PM(M7i)` | **PM()** + inner `M7i()` returns supported on darwin | Code-related feature (dev-gated) |
| 6 | `louderPenguin` | `await T7i()` in SIA only | **async override** in SIA; platform gate (darwin/win32) + GrowthBook `4116586025` | **Code tab** |
| 7 | `chillingSlothFeat` | `m7i()` | darwin\|\|win32 variable check (`P3`) | Local Agent Mode / Cowork |
| 8 | `chillingSlothEnterprise` | `w7i()` | Org config check | Enterprise disable for Claude Code |
| 9 | `chillingSlothLocal` | `D7i()` | **None** (always supported) | Local sessions |
| 10 | `chillingSlothPool` | ~~GrowthBook `1992087837`~~ | ~~GrowthBook flag gate~~ | **REMOVED in v1.28929.0** - gone from the static registry and the Zod schema. Flag `1992087837` survives as the CC worktree warm-pool `isEnabled` gate (`reapAfterMs`/`maxWarm` prefs). enable_local_agent_mode Patch 3 injected a vestigial `chillingSlothPool:{status:"supported"}` for one release (harmless - the schema is a non-strict zod object, so unknown keys pass `safeParse`); **the key was dropped in v1.30096.1**, so Patch 3 now overrides 6 features, not 7. Was: concurrent session pooling (new in v1.4758.0). |
| 11 | `yukonSilver` | `TVA()` | Platform/arch gate + org config (has native Linux support!) | Secure VM |
| 12 | `yukonSilverGems` | `rSe()` | Depends on `yukonSilver` (`TVA()`) | VM extensions |
| 13 | `yukonSilverGemsCache` | `rSe()` | Depends on `yukonSilver` (`TVA()`) | VM extensions cache |
| 14 | `wakeScheduler` | `PM(F7i)` | **PM() gate** + `platform !== "darwin"` + macOS >= 13.0 | macOS Login Items / wake scheduling |
| 15 | `desktopTopBar` | `k7i()` | **None** (always supported) | Desktop top bar |
| 16 | `ccdPlugins` | `gK` (constant) | **None** (always supported) | CCD Plugins UI (Add plugins, Browse plugins) |
| 17 | `computerUse` | `v7i()` | Set-based check on `process.platform` | Computer use feature flag (**patched for Linux** via Set modification) |
| 18 | `coworkKappa` | static: `O7i()` (unavailable) + async in SIA | Depends on yukonSilver + GrowthBook `123929380` | Memory consolidation - `consolidate-memory` skill |
| 19 | `coworkArtifacts` | static: `x7i()` (unavailable) + async in SIA | Depends on yukonSilver + GrowthBook `2940196192` | **Cowork artifacts** - artifact rendering in cowork sessions |
| 20 | `markTaskComplete` | ~~static + async in merger~~ | ~~yukonSilver + GrowthBook `3732274605`~~ | **REMOVED in v1.17282.0** — gone from the static registry, the async merger, the Zod schema, and the force-ON defaults map. Was: task-completion ("mark tasks as done"), GrowthBook `3732274605`. Row kept for history. |
| 21 | `framebufferPreview` | `b7i()` | **PM() production gate** + GrowthBook `1928275548` | VNC framebuffer preview (dev-gated) |
| 22 | `iosSimulator` | `PM(iSe)` | **PM() production gate** + macOS-only | iOS Simulator integration (dev-gated + macOS-only) |
| 23 | `androidEmulator` | `PM(iSe)` | **PM() production gate** + macOS-only | Android Emulator integration (dev-gated + macOS-only; inner function `iSe` unchanged) |
| 24 | `grandPrix` | `L7i()` | darwin-only, checks connected device pairs + `mxi()` gate | Device pairing (macOS-only) |
| 25 | `tearOffHalo` | `G7i()` | macOS >= 13 only | Tear-off halo overlay behind controlled windows (uses `@ant/claude-swift`) |
| 26 | `grandPrixRequest` | `U7i()` | `Gxi()` - darwin only + service requests | GrandPrix service request availability |
| 27 | `bootstrapConfig` | `PM(()=>gK)` | **PM() production gate** | Bootstrap config access (dev-gated) |
| 28 | `chillingSlothSshShell` | `V3e()` → `{status:"supported"}` | **None** (no platform gate) | **SSH shell for Code/Cowork** (new in v1.17282.0; same `V3e()` getter as `chillingSlothFeat`, always supported) |
| 29 | `coworkWatchRecord` | `yHt()` | **darwin-only** (`process.platform!=="darwin"` → `{status:"unsupported", reason:"Watch-record is not available on this platform"}`) | Screen / watch-record (macOS only → **unsupported on Linux**). Async override in `Yue` (new in v1.17282.0) |
| 30 | `spaceMemoryBridge` | `rt("1197768857")?Ed:{status:"unavailable"}` | GrowthBook `1197768857` (no platform check) | **Space memory bridge** — read/index space memory (new in v1.17282.0) |
| - | *(async overrides in the merger as of v1.28929.0: `louderPenguin`, `coworkKappa`, `coworkArtifacts`, `coworkAutoModeAlwaysAllowOverride` (`4200321681`), `epitaxyMcpApps`, `coworkWatchRecord`, `coworkWatchers`, `ccdGitEngine` (`959099749`))* | See rows 6, 18-19, `epitaxyMcpApps`, 29 | async overrides in merger | `markTaskComplete` removed in v1.17282.0; `launch` moved to the static registry (observed v1.26832.0); `deterministicCreatePr` removed in v1.28929.0 (slot replaced by `ccdGitEngine`) |

## The Production Gate `SB()` (was `eB()` in v1.40609.0, `cB()` in v1.37937.0, `sR()` in v1.34493.1, `IH()` in v1.32885.1, `KB()` in v1.32352.1, `YV()` in v1.30096.1, `LM()` through v1.28929.0, `gM()` in v1.15962.x, `HR()` in v1.15200.0, historically `PM()`/`Nb()`/`DT()`/`MW()`)

In v1.46388.2: `function SB(e){return o.app.isPackaged?{status:"unavailable"}:e()}` (electron var `o`, unchanged shape, plain double quotes again).
In v1.40609.0: ``function eB(e){return o.app.isPackaged?{status:`unavailable`}:e()}``.
In v1.37937.0: ``function cB(e){return o.app.isPackaged?{status:`unavailable`}:e()}`` (electron var `o`, unchanged shape).
In v1.34493.1: ``function sR(e){return o.app.isPackaged?{status:`unavailable`}:e()}``.
In v1.30096.1: ``function YV(e){return o.app.isPackaged?{status:`unavailable`}:e()}`` (electron var `o`).

```javascript
function LM(A){return sA.app.isPackaged?{status:"unavailable"}:A()}
```

In production builds (`app.isPackaged === true`), PM() returns `{status:"unavailable"}` **without calling** the wrapped function. Only in development builds does it call `e()`.

**Features gated by the production gate (v1.46388.2):** `plushRaccoon`, `quietPenguin`, `wakeScheduler`, `framebufferPreview`, `iosSimulator`, `androidEmulator`, `iosSimulatorH264` (shares `iosSimulator`'s getter), `rubberDuck` (new in v1.40609.0, `ySn(){return SB(()=>({status:"unavailable"}))}` - dev-gated AND hardcoded unavailable) and `surfaceTogglesPreview`. **`bootstrapConfig` left the gate in v1.37937.0** - it is now a plain always-supported entry (`bootstrapConfig:lB`), and `surfaceTogglesPreview` took its place (`cB((()=>lB))`)

Note: `louderPenguin` is no longer in the static registry at all. It exists only in the async merger, which has its own platform gate (darwin/win32 only) + server feature flag check via GrowthBook `4116586025`. `operon` has been completely removed in v1.6608.0. `coworkKappa`, `coworkArtifacts`, and `coworkWatchRecord` are async-only: static returns unavailable, async checks GrowthBook flags (`coworkWatchRecord` is darwin-only via `yHt()`). **`markTaskComplete` was removed entirely in v1.17282.0** — it is no longer a static entry or an async override. `chillingSlothPool` is GrowthBook-gated directly in the static registry.

This is why patching the inner functions alone is insufficient - PM() never calls them in packaged builds.

## The Three Layers

### Layer 1: Static Registry (`OB()` in v1.46388.2, was `iB()` in v1.40609.0, `fB()` in v1.37937.0, `uR()` in v1.34493.1; the sketch below uses the older `Np()`/`PM()` names)

```javascript
function Np(){
  return{
    nativeQuickEntry:...,
    quickEntryDictation:...,
    customQuickEntryDictationShortcut:...,
    plushRaccoon:PM(()=>...),
    quietPenguin:PM(...),
    chillingSlothFeat:...,             // darwin||win32 variable check (P3)
    chillingSlothEnterprise:...,
    chillingSlothLocal:...,
    chillingSlothPool:...,             // GrowthBook 1992087837 gate
    yukonSilver:...,
    yukonSilverGems:...,
    yukonSilverGemsCache:...,
    wakeScheduler:PM(...),
    desktopTopBar:...,
    ccdPlugins:...,                    // constant {status:"supported"}
    computerUse:...,                   // Set-based gate, "linux" added by patch
    coworkKappa:...,                   // always unavailable (async-only)
    coworkArtifacts:...,               // always unavailable (async-only)
    // markTaskComplete: REMOVED in v1.17282.0 (was always-unavailable async-only)
    coworkWatchRecord:...,             // always unavailable static; darwin-only async override (yHt())
    chillingSlothSshShell:...,         // V3e() -> {status:"supported"}, no gate
    spaceMemoryBridge:...,             // GrowthBook 1197768857 gate
    framebufferPreview:PM(...),        // dev-gated + GrowthBook 1928275548
    iosSimulator:PM(...),              // dev-gated + macOS-only
    androidEmulator:PM(...),           // dev-gated + macOS-only
    grandPrix:...,                     // macOS-only, checks device pairs via L7i()
    tearOffHalo:...,                   // macOS >= 13 only
    grandPrixRequest:...,              // darwin only + service requests
    bootstrapConfig:PM(()=>...),       // dev-gated
  }
}
```

Returns 26 features synchronously. Features wrapped by `PM()` are always `{status:"unavailable"}` in packaged builds.

### Layer 2: Async Merger (`WSn(e)` in v1.46388.2; was `oB(e)` in v1.40609.0, `mB(e)` in v1.37937.0, `wZt` in v1.34493.1, `u4t` in v1.32885.1, `C9t` in v1.32352.1, `nH` in v1.30096.1, `We` in v1.26832.0-v1.28929.0, `Yue`, `HSA` in v1.15962.x, `UcA` in v1.8089.1, `woA` in v1.7196.0)

```javascript
const Yue=async()=>{
  const[A,e,t,r,i]=await Promise.all([
    wen(),                       // louderPenguin
    p6e(()=>et("123929380")),    // coworkKappa
    p6e(()=>et("2940196192")),   // coworkArtifacts
    Pue(()=>et("3516166472")),   // epitaxyMcpApps
    Den()                        // coworkWatchRecord (darwin-only via yHt())
  ]);
  // a 6th Promise.all slot (pt().overlayApplied()) is consumed separately, not in n
  const n={louderPenguin:A,coworkKappa:e,coworkArtifacts:t,epitaxyMcpApps:r,coworkWatchRecord:i};
  return{...sM(),...n}
};
```

Uses `Promise.all` to parallelize the async overrides, then spreads `sM()` and applies `n` (5 overrides). louderPenguin (`wen()`) checks platform (darwin/win32) then server feature flag `4116586025`. The `p6e()` helper checks yukonSilver first, waits 5 seconds, then checks the respective GrowthBook flag. `coworkWatchRecord` (`Den()` → `yHt()`) is darwin-only — unsupported on Linux. **`markTaskComplete` was removed in v1.17282.0** — its former `p6e(()=>et("3732274605"))` slot and `markTaskComplete:i` override are both gone. **`operon` was removed in v1.6608.0.**

**v1.1.3770 → v1.1.3918 changes:**
- `chillingSlothEnterprise` moved from async-only (mC) to static (Fd)
- `yukonSilver`/`yukonSilverGems` async overrides removed (static values in Fd sufficient)
- `louderPenguin` removed from Fd entirely (only exists in mP)
- `ccdPlugins` inlined as `nU` (was `...Kf()` spread)

**v1.1.4173 → v1.1.4328 changes:**
- No structural changes; all 13 features identical
- `formatMessage` calls now include `id` field (i18n improvement)
- Function renames only: Fd→nh, mP→rO, o_e→Ebe

**v1.1.6041 → v1.1.7053 changes:**
- **New feature: `floatingAtoll`** added to static registry (always `{status:"unavailable"}` — disabled for all platforms)
- Function renames: nh→Kh, rO→$M, Ebe→Qwe, J5→K9
- Gate function renames: CMt→BBt, $Mt→UBt, MMt→KBt, TMt→qBt, kMt→jBt, IMt→zBt, NDe→BFe, BMt→e3t, LMt→JBt, FMt→QBt
- No structural changes to the 3-layer architecture

**v1.1.7053 → v1.1.7464 changes:**
- No structural changes to feature flag architecture — same 14 features, same 3-layer system
- Function renames: Kh→rp, $M→zM, Qwe→$Se, K9→oq
- Gate function renames: BBt→A5t, UBt→C5t, KBt→N5t, qBt→T5t, jBt→$5t, zBt→I5t, BFe→_Fe, e3t→j5t, JBt→L5t, QBt→U5t, YBt→F5t
- New Dispatch infrastructure: sessions-bridge, environments API, remote session control (separate from feature flags — gated by GrowthBook flags `3572572142` and `2216414644`)
- New upstream features: SSH remote CCD, Scheduled Tasks, Teleport to Cloud, Git/PR integration, DXT extensions

**v1.1.7464 → v1.1.7714 changes:**
- **New feature: `yukonSilverGemsCache`** added to static registry (mirrors `yukonSilverGems`, depends on `_Be()`)
- Function renames: rp→fp, zM→cN, $Se→r1e, oq→xq
- Gate function renames: A5t→sUt, C5t→aUt, N5t→pUt, T5t→cUt, $5t→oUt, I5t→lUt, _Fe→_Be, j5t→n1e, L5t→gUt, U5t→_Ut, F5t→yUt
- GrowthBook flag function renamed: Jr→Vr (same semantics, `\w+` patterns handle this)
- Logger variable renamed: T→C (fixed in `fix_dispatch_linux.py`)
- New `uUt()` platform gate function called by `_Be()` (yukonSilver)
- `computer-use-server.js` removed from app root (**breaking** for computer-use on Linux)
- `claude-native-binding.node` now bundled inside app.asar (handled by existing shim)
- Two Linux guards removed upstream: `isStartupOnLoginEnabled()` and auto-updater (both gracefully degrade)
- New Quick Entry position-save/restore system (`T7t()`) — patched to always use cursor display

**Because spread applies earlier properties first, later properties win.** This is how our Linux patch works - we append overrides after the last async property so they take precedence over gate-blocked values from `...Np()`.

### Org-Level Settings

Feature flags can also be affected by organization-level admin settings:

- **"Skills" toggle** in org admin → controls SkillsPlugin availability. When disabled, SkillsPlugin returns 404, causing the renderer to hide plugin UI buttons (Add plugins, Browse plugins). This is independent of `ccdPlugins` — the feature flag can be `{status:"supported"}` but the UI still won't show if the org disables Skills.
- **`chillingSlothEnterprise`** → org-level disable for Claude Code. When the org config disables it, the Code tab disappears regardless of other feature flags.

### Layer 3: IPC Handler

Calls the merger, validates the result against a Zod schema, and sends it to the renderer process via IPC. The renderer uses these flags to conditionally render UI elements (e.g., Chat|Code toggle).

## GrowthBook Flag Catalog (baseline v1.8555.2; see version-history table for current names)

#### New Flags in v1.46388.2

66 IDs appear that were absent from v1.40609.0; **53 are store-consulted** (templated in `js/growthbook_overrides.js`), 12 are 3p-defaults-map-only and 1 (`4055864154`) sits only in the deployment-mode remote-allowed-keys set. Reader shapes: bare `wS`/`TS`/`CS`/`OS`/`vS`/`yS`/`rvt` in the GrowthBook chunk, dotted `.aD`/`.oD`/`.nD`/`.rD`/`.lD`/`.cD` elsewhere.

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `96101707` | boolean (`wS`) | **`multiAccount`** static registry gate - `!U().authentication.disableMultiAccount&&wS("96101707")`; also read by the account-switch path via a dynamic `isFeatureEnabled` import | No |
| `96832454` | boolean w/ default ON (`.oD`) | CLI version-floor gate, sibling of `2153038254` (module holding the `2.1.x` CLI version constants) | No |
| `28927217` | boolean w/ default ON (`TS`, hoisted `Ufr`) | Launch preview last-frame cache - persists `preview-last-frames` JPEG records under userData | No |
| `160242894` | boolean (`.aD`) | SSH connect fast-path gate (module exporting the `CLAUDE_DESKTOP_SSH_CONNECT_FASTPATH` switch, next to `816856638`/`98041341`) | No |
| `283281522` | boolean w/ default ON (`TS`) | Browser-pane sibling gate next to the `2464731750` `request_access` tool | No |
| `458990115` | boolean (`.aD`, hoisted `At`) | Folder-access routine-scoped standing - ON drops the routine grant anchor (session standing only) | No |
| `570403704` | boolean (`.aD`, hoisted `Rr`, try/catch) | Device attestation v2 - `anthropic-beta` header path gate; also listed in the 3p remote-allowed-keys set | No |
| `613003975` | boolean (`.aD`) | `transcriptReadsInWorker` - transcript reads on a worker thread | No |
| `706068684` | boolean w/ default ON (`TS`) | Code turn-complete notification summary body; also in the remote-allowed-keys set | No |
| `848696239` | boolean (`wS`, hoisted `Mxr`) | Remote outputs sync dry-run, pairs with `2906979861` | No |
| `994878011` | boolean (`.aD`) | `isSleepRedialKillswitchOn` - its own single-export module | No |
| `1028094019` | boolean (`.aD`) | Daily session-storage inventory telemetry emitter gate | No |
| `1085129406` | boolean (`.aD`) | Session activity ledger collection for attended local sessions (`activityLedger.setCollecting`) | No |
| `1239409407` | boolean w/ default ON (`TS`) + observed (`yS`) | App-menu Open Folder item (Ctrl+Shift+O); a flip rebuilds the menu | No |
| `1287897741` | boolean (`.aD`) | `isTurnEndSendHoldDisabled` - CLI stdin turn-end send-hold kill-switch | No |
| `1395094573` | boolean (`wS`, hoisted `yor`) | Relogin session revive - immediate release-drain gate | No |
| `1595132361` | boolean (`.aD`) | Sets `CLAUDE_CODE_QUESTION_EXTENDED=1` in the local-agent CLI env | No |
| `1603637451` | value (`.nD(id,{})`) | Skills folder limits config - `skillMdMaxBytes`/`assetMaxBytes`/`maxFilesPerSkill`/`maxSkillsPerFolder`/`folderBudgetBytes`/`frontmatterMaxBytes`/`resendSettleMs`, clamped | No |
| `1645353060` | boolean w/ default ON (`.oD`) | `decideCliBinaryForSpawn` - managed CLI binary selection together with `762798616` | No |
| `1701404423` | boolean (`wS`, hoisted `wor`) | Bridge WebSocket pong-timeout reconnect-reason classification (`overloaded`/`reset_silent`/`rotated` vs `gate_off`) | No |
| `1776348311` | boolean (`.aD`) | Unattended-session tool availability gate ("This tool is unavailable in unattended...") | No |
| `1781903805` | boolean w/ default ON (`TS`, hoisted `jbn`) | **`codeSessionKeepAwake`** - registry entry `lB()?CB:{status:"unavailable"}`; power-save blocker during Code turns | No |
| `1923867086` | boolean (`.aD`) + listener (`.cD`) | Terminal scrollback log + `read_terminal` tool; OFF stops the scrollback log live | No |
| `1925932989` | boolean w/ default ON (`.oD`) | Session tool-set gate in the spawn-options module | No |
| `2071326072` | boolean (`wS`, hoisted `Dor`, inverted) | Bridge reconnect backoff kill-switch - ON disables the backoff schedule | No |
| `2096326160` | boolean (`.aD`, hoisted `oa`) | Remote-file device-path staging lookup skip, sibling of `3783846612` | No |
| `2153038254` | boolean w/ default ON (`.oD`) | CLI version-floor gate, sibling of `96832454` | No |
| `2365358358` | boolean (`.aD`) | `ccd_sidebar` MCP tools - list/create/rename/delete groups, move sessions, pin, unread, mark completed | No |
| `2371478310` | boolean (`.aD`/`wS`) | **`sideSessions`** - `start_session`/`hand_off_to_session` MCP tools + the new async merger override `kB(()=>wS("2371478310"))` | No |
| `2394039067` | boolean (`.aD`) | Git credential posture legacy fallback for read/push/fetch/scrub | No |
| `2464838160` | boolean (`.aD`) | Lazy worktree start for attended sessions (`resolveLazyWorktreeStart`) | No |
| `2537760906` | boolean (`.aD`) + defaults-map key | Scheduled-task pending-permission auto-deny after the wait budget | No |
| `2755789005` | boolean (`.aD`) | Plugin sync module gate, sibling of `1695017395`/`2906430762` | No |
| `2767293802` | boolean w/ default ON (`TS`, hoisted `SMn`) + observed (`yS`) | Edit-menu command claim by pop-out panes (`claimEditCommands`/`releaseEditCommands`) | No |
| `2798169495` | boolean (`.aD`) | Batch file-read request gate (`invalid`/`too_large`/`too_many`/`not_signed_in` outcomes) | No |
| `2877254163` | value (`.nD(id,"off")`) | Worktree warm mode - `off`/`stubs`/`full` | No |
| `2906979861` | boolean (`wS`, hoisted `jxr`) | Remote outputs sync enable, pairs with the `848696239` dry-run | No |
| `2921739883` | value (`CS(id,null)`, hoisted `Eor`) | Bridge reconnect backoff config - `min_ms`/`max_ms`/`stable_ms` | No |
| `2941281426` | boolean (`.aD`) | CLI `enableFileCheckpointing` + rewind-files path | No |
| `2974609625` | keyed config value (`.rD`) | Scheduled-task promotion thresholds - `enabled`/`minRunsObserved`/`minObservedDays` and `bound*` variants | No |
| `3019665678` | boolean w/ default ON (`TS`) | Code-tab credential re-mint fallback | No |
| `3025587613` | boolean w/ default ON (`.oD`) | Side-sessions event injection (`permission_mode_changed`/`permission_mode_clamped`), with `3531612483` | No |
| `3043546415` | value (`rvt` peek at startup + `yS` observe) | `[EventLogging]` telemetry credential mode - `cookie`/`bearer`/`off` | No |
| `3166359512` | boolean (`.aD`, hoisted `fn`) + listener (`.cD`) | Memory-item inventory dispatcher gate (`isOn`/`observe`) | No |
| `3372259263` | boolean (`.aD`, hoisted `Gr`, try/catch) | Device attestation v2 mint gate; also in the remote-allowed-keys set | No |
| `3527441323` | boolean (`wS`) | Google auth deep-link fallback timer - 60s `did-become-active` watchdog when `claude://` is the registered handler (next to `743194442`) | No |
| `3531612483` | boolean w/ default ON (`.oD`) | Side-sessions event injection, with `3025587613` | No |
| `3724674924` | boolean (`wS`, via `_bn()`) + defaults-map key | **`wslForkSession`** async merger override (`kB(_bn)`); Windows-only feature, inert on Linux | No |
| `3783846612` | boolean (`.aD`, hoisted `aa`) | `[remote-file]` staged commit path | No |
| `3931589559` | boolean (`.aD`, hoisted `c`) | Remote-bash outputs root under userData (`outputs` + `.trash-` sweep) | No |
| `4039294468` | boolean (`.aD`) | Plugin backfill module gate, sibling of `3183093548`/`2294160313` | No |
| `4041267332` | value (`.nD(id,9e5)`) | CLI job-cleanup idle timeout ms (0 = off except for unattended sessions) | No |
| `4044603026` | boolean (`.aD`) | Terminal shell integration (`terminal-shell-integration` dir) | No |

**3p-defaults-map-only (NOT templated):** `147471044`, `151700879`, `232278890`, `520984675`, `693564285`, `890748467`, `1144854707`, `1179150525`, `2079084046`, `2971093051`, `3635490728`, `4083972287`, plus `4112513247` (seeded ON when `builtinBrowserEnabled`). Each appears only as an unquoted numeric key in the deployment-mode hardcoded flag map. **`4055864154`** appears only in the remote-allowed-keys `Set` (`["3602629573","3436441689","919579692","1942337209","4055864154","706068684","3372259263","570403704"]`) and is never read by the main process - not templated.

#### Removed in v1.46388.2

| Flag ID | Was | Notes |
|---------|-----|-------|
| `1032963206` | CliGovernor `throttleEnabled` (v1.26832.0) | Gone with the governor throttle path. **Dropped from the template.** |
| `1315974108` | `chillingSlothSshWorktreeLocation` async merger override (v1.37937.0) | Feature went static-only (`Ixn()`: supported unless managed `workspace.allowedFolders` is set). **Dropped.** |
| `1598976391` | `proactiveSkillSuggestEnabled` | Gone. **Dropped.** |
| `1915174500` | Store-consulted only in v1.40609.0 (never templated) | Gone again; no template change |
| `2039376689` | CliGovernor `pressureEvictionEnabled` (v1.26832.0) | Gone. **Dropped.** |
| `2724639973` | Session governor `evictionEnabled` | Gone. **Dropped.** |
| `3246569822` | `canSaveSkill` | Gone. **Dropped.** |
| `3326082604` | Window born-hidden watchdog kill-switch (v1.32352.1) | Gone. **Dropped.** |
| `3431784271` | Plugin backfill `pruneUnresolvablePlugins` | Gone (the backfill module is now gated by `4039294468`). **Dropped.** |
| `3516166472` | `epitaxyMcpApps` async merger override | Feature is now a plain static `CB` (always supported); the flag literal is gone. **Dropped.** |
| `326791966`, `3089387226` | 3p-defaults-map-only | Gone from the hardcoded defaults map; were never templated |

Template 225 -> 291 (`CATALOG_EXPECTED` bumped): -12 removed (9 vanished in v1.46388.2 + the 3 that had already vanished in v1.40609.0, see below), +25 store-consulted IDs that arrived in v1.40609.0 and were never catalogued, +53 new store-consulted in v1.46388.2.

**Feature (registry/schema) changes in v1.46388.2:** **added 7** - `codeSessionKeepAwake` (`lB()?CB:{status:"unavailable"}`, flag `1781903805` default ON, no platform gate - works on Linux), `computerUseComplianceGate` (static `CB`, always supported), `popoutTitleBarOverlay` (`SSn()`: `{status:"unsupported",reason:"Pop-out title bar overlay is not available under Wayland"}` when `--ozone-platform=wayland` or the session is detected as Wayland, else supported - the only new entry with a Linux-relevant gate, and it is honest), `multiAccount` (flag `96101707` + the `disableMultiAccount` managed key), `sessionMentions` (static `CB`), `sideSessions` (static `{status:"unavailable"}` + merger override on flag `2371478310`) and `wslForkSession` (static `{status:"unavailable"}` + merger override `kB(_bn)` on flag `3724674924`; Windows-only). **Removed 0.** `epitaxyMcpApps` and `chillingSlothSshWorktreeLocation` left the merger for the static registry (see Overview item 2). Static registry 64 -> 71 entries; Zod schema (`N$e`, symbol `xh`) 65 -> 72 keys, still a non-strict `.partial()` object. Merger override object stays at 13 keys (2 swapped). Gate reshuffles: none beyond the two merger-to-static moves; the beta-maturity list `fbn` still holds the single entry `surfaceTogglesPreview`.

**enable_local_agent_mode in v1.46388.2:** all anchors verified present with exactly one match across the staged bundle - Patch 1's darwin/win32 gate resolves to the quietPenguin inner `function pSn(){return process.platform!=="darwin"&&process.platform!=="win32"?{status:"unavailable"}:{status:"supported"}}` (the registry still consumes it as `quietPenguin:SB(pSn)`, so it is dev-build-only and Patch 3 delivers quietPenguin in packaged builds), Patch 1b's `case"darwin":case"linux":return"unix"` mapper + `.files[pbn("linux")][e]` index both present, Patch 3's merger pattern matches only `return{...OB(),...m}}`, Patch 3n's `resolveSshControllerForMcp(e){if(e)return h.getRemoteServerController(e)}` is still gate-free (flag `1496676413` absent from the bundle, as since v1.18286.0), Patch 4's `quietPenguinEnabled:!1,louderPenguinEnabled:!1` matches once, and the `["anthropic-client-os-platform",...platform]` header guard is present. All 6 Patch 3 override keys (`quietPenguin`, `louderPenguin`, `chillingSlothFeat`, `chillingSlothLocal`, `ccdPlugins`, `computerUse`) are present in the 72-key Zod schema; 5 are in the static registry and `louderPenguin` is async-only (`hSn()`: darwin/win32 + flag `4116586025`), as always. `computerUse` is still `gSn()` -> `QR()` = `ZR.has(process.platform)` over a `Set(["darwin","win32"])` - the Set-based gate `fix_computer_use_linux.nim` rewrites. CU chicago family intact (`2486083521` hoisted as `_hn`, chicago config `1291166712` as `ez`, macOS floor `1346958739` as `vhn`, win32 sub-gate `40173473`); buddy `2358734848` present (hoisted `Q`, read via `.aD(Q)` + `.lD(Q)`). No patch edit needed.

#### New Flags in v1.40609.0

This release was published by the auto-release path and never audited by hand; the diff below is against v1.37937.0, reconstructed from the retained `tmp/app.asar.contents-1.40609.0` extract. 28 IDs appeared; **25 are store-consulted** (now templated), `3927880029` is 3p-defaults-map-only (`vw({value:3})`), `4055864154` is remote-allowed-keys-set-only, and `1915174500` was store-consulted for this one release and vanished again in v1.46388.2.

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `49458538` | boolean (`.aD`, hoisted `Mt`) + observed (`yS`) | Folder-access request UI mode - card tier (`733405693` adds classifier; dialog when off). **Replaces `1421481645`** | No |
| `206750215` | boolean (`.aD`, hoisted `jt`) | Connected-folder containment error detail suppressor - ON drops the path hints from the "not inside a folder connected to Cowork" refusals | No |
| `541746109` | boolean (`wS`, inverted) | `[my-access]` fetch-failure fallback kill-switch | No |
| `607406988` | boolean (`.aD`) | `isBoundedConnectBudgetKillswitchOn` - its own single-export module | No |
| `642265585` | boolean (`wS`) | `replyRedeliveryDisabled` - held-reply redelivery kill-switch in the remote-tools request path | No |
| `733405693` | boolean (`.aD`, hoisted `Nt`) + observed (`yS`) | Folder-access request UI mode - classifier tier on top of the `49458538` card | No |
| `822923030` | boolean (`.aD`, inverted) | SSH reattach-rounds ledger kill-switch, read next to the `3093186863` reattach kill-switch | No |
| `1263782781` | value (`.nD(id,null)`, hoisted `ge`) | Git operation timeout config - `bash`/`stage`/`commit` `default_ms`/`max_ms` | No |
| `1340622498` | boolean (`.aD`) | `isReconnectTimingKillswitchOn` - its own single-export module | No |
| `1695017395` | boolean (`.aD`) | Plugin sync module gate - `installed_plugins.json` watcher + host failure backoff (siblings `2906430762`/`2755789005`) | No |
| `1836754949` | boolean (`.aD`/`wS`) | Scheduled-task run report on completion + dispatch prompt-hash stash | No |
| `2062156710` | boolean (`.aD`) | SSH lean-reconnect force-on (`CLAUDE_DESKTOP_SSH_LEAN_RECONNECT` env is the manual switch) | No |
| `2294160313` | value w/ default ON (`.nD(id,!0)`) | Plugin sync module gate, sibling of `3183093548` scan-hidden stubs | No |
| `2576868839` | boolean (`.aD`) | `isSignalWakeKillswitchOn` - its own single-export module | No |
| `2605355193` | boolean w/ default ON (`.oD`) | Plugin hot-reload for running sessions (`reloadPluginsForRunningSessions`) | No |
| `2685067074` | listener latch (`Q8t(id,pref)`) | Latches the `earlyWindowShowLatched` preference (boot placeholder / early window show from the next launch); same latch helper as `1072565585` used to | No |
| `2719700143` | boolean w/ default ON (`TS`) | Pop-out pane claimant arbitration between two visible native views | No |
| `2833632524` | boolean (`.aD`) | `keptInputRecoverySwitchedOff` - kill-switch for kept-input recovery on dying sessions | No |
| `2857785401` | boolean (`.aD`) | `waitingInputPersistSwitchedOff` - kill-switch for persisting waiting session input | No |
| `2906430762` | boolean (`.aD`) | Plugin sync module gate, sibling of `1695017395`/`2755789005` | No |
| `3046702961` | boolean w/ default ON (`TS`) + observed (`yS`) | App-menu Code entries when the Code surface is enabled; a flip rebuilds the menu | No |
| `3142047527` | observed (`yS`) | App-menu rebuild observer | No |
| `3163246478` | boolean (`wS`) | Bridge WebSocket mid-call pong-grace kill-switch | No |
| `3491600236` | boolean (`wS`) | Bridge WebSocket network-redial watch kill-switch | No |
| `3728132896` | boolean (`wS`) + observed (`yS`) | `[artifactPopup]` artifact pop-up windows gate - a flip to OFF closes open pop-ups | No |

#### Removed in v1.40609.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `1030142136` | Extension-blocklist recheck on org switch (v1.37937.0) | Gone. **Dropped from the template** (in the v1.46388.2 refresh). |
| `1072565585` | `newChatPageLaunchGate` latch (v1.28929.0) | Gone. **Dropped.** |
| `1421481645` | Folder-access request UI mode card vs dialog (v1.37937.0) | **Replaced by the `49458538`/`733405693` pair.** Dropped. |

**Feature (registry/schema) changes in v1.40609.0:** added `spawnTaskInFlightIds` (static `tB`, always supported), `rubberDuck` (`ysn(){return eB(()=>({status:"unavailable"}))}` - dev-gated and hardcoded unavailable) and `popoutZoom` (static `tB`); removed `builtinMcpPresets`. Static registry 62 -> 64 entries; Zod schema 63 -> 65 keys. Merger unchanged at 13 overrides. The managed-settings deployment-key schema also grew 117 -> 120 keys (`disableConfigDeprecationWarnings`, `relaunchEnforcementHours`, `sshHostAllowlist`), catalogued in `js/extra_settings_main.js` with the v1.46388.2 refresh (120 -> 143 there).

#### New Flags in v1.37937.0

30 new IDs appear; **23 are store-consulted** (templated in `js/growthbook_overrides.js`) and 7 are 3p-defaults-map-only (see below).

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `98041341` | boolean (`.Gx`) | SSH module gate exported alongside the transport selector - sibling of `816856638`/`291584251`/`3946462706` | No |
| `108465228` | boolean (`.Gx`) | Folder-grant post-grant index/upload path - sibling gate of `144158705` (`I=!N&&Gx("108465228")`) | No |
| `133902057` | boolean (`Xw`/`.Gx`) | CCD sessions API v2 - routes `POST /v1/code/sessions` instead of `/v1/sessions` and selects the `v2` transcript-summary payload | No |
| `581786799` | boolean (`.Gx`) | SSH transcript-sync kill-switch - ON drops `appendFromRemote`, the `waitForSshConnected` preload and the post-reconnect resync (module that owns `SshHostUnreachableError`) | No |
| `717163759` | boolean (`.Gx`) | `isKeepLiveRemoteKillswitchOn` - its own single-export module | No |
| `743194442` | boolean (`Xw`) | Google auth deep-link - ON keeps ASWebAuth instead of handling `/login/app-google-auth` as the registered `claude://` protocol client | No |
| `769234850` | boolean (`.Gx`) | Transcript append-via-shell kill-switch - ON forces the buffered-cut path for SSH sessions | No |
| `976614668` | boolean (`.Gx`) | Remote-control-at-startup feature gate (`feature_gate_off`); pairs with the `2229805612` default | No |
| `1030142136` | boolean (dynamic `isFeatureEnabled` import) | Extension-blocklist recheck when the active org changes (`hasOrgPolicyBackend` path) | No |
| `1111144847` | boolean w/ default ON (`Zw(id,!0)`) | `browser_batch` tool enable ("browser_batch is currently disabled; call the tools one at a time.") | No |
| `1265511872` | boolean (`.Gx`, hoisted const `F`) | macOS cloud-placeholder (dataless-file) handling in the connected-folders reader | No |
| `1294982044` | keyed config value (`nT(id,key,dflt,zodType)`) + listener (`Hw`) | Tray poll config - `pollRequiresTrayOpenWithinHours` | No |
| `1315974108` | boolean (`Xw`, via `q2t()`) | **`chillingSlothSshWorktreeLocation`** - the new async merger override | No |
| `1421481645` | boolean (`.Gx`, hoisted const `At`) + observed (`Uw`) | Folder-access request UI mode - `card` vs `dialog` (paired with `2745857735`) | No |
| `1825995196` | boolean (`.Gx`) | SSH background-readopt candidates kill-switch | No |
| `2004571505` | boolean w/ default ON (`Zw(id,!0)`) | LocalMcpServerManager `closeServerByName` path gate | No |
| `2529235968` | boolean (`.Gx`) | `shadowRemoteServers` - shadow remote plugin-MCP servers with local ones in the session environment | No |
| `2464731750` | boolean (`Xw`) + observed (`Uw`) | Browser-pane `request_access` tool; a flip triggers `reloadRemoteToolsDevice("browser_pane...")`, registered alongside `1291166712`/`36693946`/`40173473` | No |
| `2848557028` | boolean (`.Gx`, hoisted const `jt`) | Delete-permission-requests tool for a session's connected folders | No |
| `2938421209` | value (`Yw(id,dflt)`) | Updater staged-update tick interval | No |
| `3920548810` | boolean (`.Gx`) | Hosted-Chrome profile availability gate (`gate_off` / `no_chrome`) | No |
| `4156472024` | boolean (`.Gx`, hoisted const `qn`) | Folder-access plainly-visible-path requirement suppressor (`Jn(){return Gn()&&!Gx(qn)}`) | No |
| `4217215889` | boolean (`Xw`) + listener (`Hw`) | OS entry points gate - the Dock / jump-list "continue last session" entries | No |

**3p-defaults-map-only (NOT templated):** `326791966`, `505512513`, `1294710626`, `2129861473`, `3089387226`, `3559681707` (seeded `EO("off")`), `4272200640`. Each appears exactly once, as an unquoted numeric key in the deployment-mode hardcoded flag map, and is never read by the main process - consistent with the other defaults-map-only IDs.

**Sweep caveat:** a raw digit sweep also surfaces `120000`, which is a git status-porcelain mode string, not a flag.

#### Removed in v1.37937.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `3673327456` | Cowork VM memory `sizedToHost` (new in v1.32352.1) | Gone, and so is the whole mechanism: `sizedToHost`, the host-RAM tier table `{le4/8/16/gt16:{maxGB,baselineGB,minGB}}` and its `B7t`/`V7t`/`H7t` helpers are all absent. The `vmMemoryGB` and `vmCpuCount` preferences survive. **Dropped from the template.** |

Template 203 -> 225 (`CATALOG_EXPECTED` bumped): -1 removed (`3673327456`), +23 new store-consulted.

**Feature (registry/schema) changes in v1.37937.0:** **added 4** - `chillingSlothSshWorktreeLocation` (static `G4t()`, async merger override `M3t()` gated by flag `1315974108`), `sessionFolderFileAccess` (static `lB`, always supported, no flag and no platform gate - works on Linux as-is), `spawnTaskPendingPop` (static `lB`, same), and `violinBowHomeSettings` (static `{status:"unavailable"}`, async `M3t(){return{status:"unavailable"}}` - hardcoded off everywhere, like `violinBow`). **Removed 1** - `parkaMeetings`, which is gone from the registry, the Zod schema and the whole bundle; it was `sR((()=>process.platform==="darwin"&&JA().major>=13?cR:{status:"unsupported",...}))`, i.e. dev-gated *and* macOS-13+, so it was already inert on Linux. Static registry 59 -> 62 entries; Zod schema (`dqe`) 60 -> 63 keys, still a non-strict `.partial()` object. Merger override object 10 -> 13 keys. Two gate reshuffles worth noting: **`bootstrapConfig` left the production gate** (now plain `bootstrapConfig:lB`) and **`surfaceTogglesPreview` entered it** (`cB((()=>lB))`); the beta-maturity list `f2t` still holds the single entry `surfaceTogglesPreview`.

**enable_local_agent_mode in v1.37937.0:** all anchors verified present with exactly one match across the staged bundle - Patch 1's darwin/win32 gate resolves to the quietPenguin inner ``function h3t(){return process.platform!==`darwin`&&process.platform!==`win32`?{status:`unavailable`}:{status:`supported`}}``, Patch 3's merger pattern matches only `return{...fB(),...p}}`, and Patch 4's `quietPenguinEnabled:!1,louderPenguinEnabled:!1` matches once. All 6 Patch 3 override keys (`quietPenguin`, `louderPenguin`, `chillingSlothFeat`, `chillingSlothLocal`, `ccdPlugins`, `computerUse`) are present in the new registry (`louderPenguin` async-only, as always) and in the 63-key Zod schema. CU chicago family intact (`2486083521`, `1291166712`, macOS floor `1346958739`); buddy `2358734848` present. No patch edit needed.

#### New Flags in v1.34493.1

13 of the 14 newly-appearing IDs are store-consulted (templated in `js/growthbook_overrides.js`); `2722545484` is not (see below).

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `36693946` | observed (`GS`/observeFeatureGate) | Computer Use gate-reconcile listener - registered next to `4293378213`, `1291166712` and `40173473`; a flip triggers `reloadRemoteToolsDevice("cu_gate_reconcile")`. The literal appears exactly once, so its value consumer is renderer/CLI-side | No |
| `40173473` | boolean (`XS`) | Computer Use win32 sub-gate: `cGt(){return process.platform!=="win32"||XS("40173473")}` - inert on Linux (short-circuits true) | No |
| `657187776` | boolean (`.Sb`) | Transcript-lease `isDisabled` - turns off the CCD disk-transcript lease/claim loop | No |
| `816856638` | boolean (`.Sb`) | `isDaemonUpgradeDeferralDisabled` - SSH daemon upgrade-deferral kill-switch (same module as the SSH transport selector `291584251`/`3946462706`) | No |
| `885442848` | boolean (`XS`) + listener (`GS`) | Hosted-Chrome-bridge `first_party` mode - selects the 1p bridge when hybrid detection is off; a change re-registers the bridge tool list | No |
| `1710585411` | boolean (`XS`, inverted) | Office-bridge trigger-context suppression: ON drops `triggerId`/`orgUuid`/`accountUuid` from the bridge request | No |
| `1904135164` | boolean w/ default ON (`.Cb(id,!0)`) | Plugin download `moveExistingAside` | No |
| `2048589233` | boolean w/ default ON (`.Cb(id,!0)`) | `thinkingSummaryOnDemand` in the CCD gated-SDK snapshot; also appended to the snapshot-staleness observe list, which is now `[1412563253,162211072,3531779070,2048589233,1477483922]` | No |
| `2806360886` | boolean (`.Sb`, hoisted const) | Folder-access request kill-switch - ON disables the remembered/dialog folder-grant path ("Folder access requests were disabled...") | No |
| `2864556627` | boolean (`XS`, via `mU()`) | Artifact host-tools capability - advertises the `host-tools` hostcap and authorizes host-tool calls from the artifact pane | No |
| `3093186863` | boolean (`.Sb`) | SSH reattach kill-switch - ON forces reattach off regardless of `CLAUDE_DESKTOP_SSH_REATTACH` | No |
| `3183093548` | value w/ default ON (`.yb(id,!0)`) | Plugin scan-hidden upload stubs gate (`reconcileScanHiddenUploadStubs` / `recordScanHiddenStub`) | No |
| `4114957886` | boolean (`.Sb`) | SSH reattach default when `CLAUDE_DESKTOP_SSH_REATTACH` is unset (paired with the `3093186863` kill-switch) | No |
| `2722545484` | 3p defaults-map only | Seeded ON when `claudeInChromeEnabled` in the deployment-mode hardcoded flag map; never read by the main process. **Not templated**, consistent with the other defaults-map-only IDs | No |

#### Removed in v1.34493.1

| Flag ID | Was | Notes |
|---------|-----|-------|
| `235864698` | Boot-window disable latch (`PI("235864698","mainViewBootWindowDisabled")`, new in v1.32352.1) | Gone from the bundle; the `mainViewBootWindowDisabled` preference reader survives but nothing latches it any more. **Dropped from the template.** |
| `1420323440` | 3p defaults-map-only value flag (`TE({sidebar:"combined",coworkDefaultOn:!0})`) | Gone from the hardcoded defaults map. Was never templated (defaults-map-only), so no template change |

Template 191 -> 203 (`CATALOG_EXPECTED` bumped): -1 removed (`235864698`), +13 new store-consulted.

**Feature (registry/schema) changes in v1.34493.1:** added `violinBow` (static `{status:"unavailable"}` + async merger override `dR(UYt)` where `UYt(){return!1}` - hardcoded off, no flag, unavailable everywhere) and `coworkThinkingInSend` (static always-supported `cR`, no flag, no platform gate - works on Linux as-is). Nothing removed. Static registry 57 -> 59 entries; Zod schema 58 -> 60 keys, still a non-strict `.partial()` object. Merger override object 9 -> 10 keys. The beta-maturity list shrank to a single entry (`NYt=[`surfaceTogglesPreview`]`).

**Correction to the v1.32885.1 notes:** `bootPlaceholder` was NOT removed in v1.32885.1 - it is still a static registry entry and a Zod schema key in both v1.32885.1 and v1.34493.1 (`bootPlaceholder:{status:"unsupported",reason:"Boot placeholder not built in",unsupportedCode:"unknown"}`). The "58 keys" figure for v1.32885.1 is correct; the "-1 `bootPlaceholder`" claim is not.

**enable_local_agent_mode in v1.34493.1:** all 7 anchors verified present, each with exactly one match across the staged bundle (Patch 1 darwin/win32 gate = quietPenguin inner `iZt` only; Patch 3's merger pattern matches only ``return{...uR(),...l}},``; Patch 1b's `case`darwin`:case`linux`:return`unix`` mapper + `.files[PYt(`linux`)][arch]` index both present; Patch 3n `resolveSshControllerForMcp(e){if(e)return l.getRemoteServerController(e)}` still gate-free; Patch 4 `quietPenguinEnabled:!1,louderPenguinEnabled:!1` 1 match; the header guard `[`anthropic-client-os-platform`,i.default.platform]` present). All 6 Patch 3 override keys (`quietPenguin`, `louderPenguin`, `chillingSlothFeat`, `chillingSlothLocal`, `ccdPlugins`, `computerUse`) are present in the new registry (louderPenguin async-only) and the 60-key Zod schema. CU chicago family intact (`2486083521` hoisted as `YWt`, chicago config `1291166712` as `GI`, macOS floor `1346958739`); buddy `2358734848` present. No patch edit needed.


#### New Flags in v1.32885.1

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `751369921` | listener latch (`PI(id,pref,cb)`) | Hybrid account detection at startup - latches into the `hybridDetectLatched` preference. **Rename of `3001783682`** (identical call site and pref; not a new feature) | No |
| `1477483922` | observed (`.Oy` observeFeatureGate) | CCD gated-SDK-snapshot staleness gate: sits in the session manager's staleness list `qt=[1412563253,162211072,3531779070,1477483922]` - a gate flip marks every session's `gatedSdkSnapshot` stale (`[CCD] GrowthBook %s changed - marked gatedSdkSnapshot stale`). The snapshot gained a `chipLevel` field this release (session level-selector chip catalog: `{id,label,glyph,description,hint,entryMode}`); the flag literal appears exactly once, so its value consumer is CLI/server-side | No |
| `2099281725` | boolean (`.Ey`) | `ssh-launch-preconnect` - SSH host preconnect with per-host failure backoff (electron-store of hosts with `consecutiveFailures`/`lastAttemptAt`) | No |

#### Removed in v1.32885.1

`3001783682` only - renamed to `751369921` (same hybrid-detect latch call site; not a feature loss). All other previously templated store-consulted flag IDs are still present, including the 16 3p-defaults-map-only unquoted-key IDs. Template 189 -> 191 (`CATALOG_EXPECTED` bumped).

**Feature (registry/schema) changes in v1.32885.1:** added `coworkSeededSummon` - static always-supported (`coworkSeededSummon:LH`, no flag, no platform gate; works on Linux as-is); removed `bootPlaceholder` (the v1.30096.1 hardcoded-unsupported stub is gone from the capability map). Zod schema 57 -> 58 keys, still a non-strict `.partial()` object. Merger unchanged at 9 overrides.

**enable_local_agent_mode in v1.32885.1:** all 7 anchors verified present, each with exactly one match (Patch 1 darwin/win32 gate = quietPenguin inner `W2t` only; Patch 3's merger pattern matches only `return{...RH(),...c}}` in the whole staged bundle). All 6 Patch 3 override keys are present in the new registry (louderPenguin async-only) and the 58-key Zod schema. CU chicago family intact (`2486083521` hoisted as `dZt`, chicago config `1291166712` as `SV`, macOS floor `1346958739` as `fZt`); buddy `2358734848` present. No patch edit needed.

#### New Flags in v1.32352.1

All 21 are store-consulted (templated in js/growthbook_overrides.js unless noted).

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `235864698` | listener latch (`oWt(id,pref)`) | Latches into the `mainViewBootWindowDisabled` preference - disables the boot placeholder window from the next launch (same latch helper pattern as `1072565585`) | No |
| `291584251` | boolean | SSH transport kill-switch: ON forces the ssh2 library (never OpenSSH), overriding `CLAUDE_DESKTOP_SSH_TRANSPORT` | No |
| `732695530` | boolean | `[remote-tools-device]` gate (module with the auth-failure classification set: `no_credential`/`user_mismatch`/`upstream_401`...) | No |
| `919579692` | boolean | `[PreviewOriginPolicy]` disable - `GJ(){return!PE()\|\|KE(id)}`: ON (or features not yet loaded) skips the credentialed-nav origin-policy check for launch preview (`launchPreviewAllowedOrigins`) | No |
| `1183214304` | boolean (hoisted const `Kdr`) | `[rc-serve]` renderer heap-report gate (heapUsedKb/heapTotalKb/heapLimitKb/blinkAllocatedKb over IPC from claude.ai frames); trio with `3764441751`/`1410651677` | No |
| `1278239935` | boolean | Browser-tools mouse-press guard kill-switch (`isKillSwitchEnabled` in `setMousePressGuard`, frame-chain resolution + subframe origin grants) | No |
| `1310358601` | boolean | `[device-registry]` server-time sampling gate (clock-skew HEAD probe against the API host, 3s timeout) | No |
| `1410651677` | value (`GE(id,null)`) | `[rc-serve]` config object - invalid keys warned and defaulted (`[rc-serve] Ignoring invalid config keys`) | No |
| `1743527783` | boolean | Session quit-interrupt resume `gateEnabled` - `interruptedByQuitAt` handling with `unattended`/`hasPendingUserInput`/`crashLoopParked` inputs | No |
| `1754160972` | value (`.Qv(id,dflt)`) | Worktree checkout-mode config (`mode:da(...)` feeding worktreePath/fullCheckoutPromise/postCheckoutPromise/overlayPromise) | No |
| `2214981414` | boolean | `[device-registry]` sibling gate of `1310358601` (both read via try/catch wrappers) | No |
| `2216766246` | value (`GE(id,0)`) | Remote-tools-device interval ms (clamped, 0 = off) | No |
| `2220415149` | boolean | `seedStableDeviceIdIntoSession` - seeds the stable device id into the session's Claude config dir (`[deviceId] Seeded stable device id into session`) | No |
| `2654621331` | listener (value) | `[EventLogging]` telemetry flush-interval ms (clamped, logged on change) | No |
| `3018088575` | boolean, default ON (`$ct(id,!0)`) | Local MCP server manager gate (module exporting shutdownAllMcpServers/shutdownMcpServer); read via the NEW `isFeatureEnabledWithDefault` | No |
| `3326082604` | boolean | Window born-hidden watchdog kill-switch (`killSwitchOn` in the born_hidden telemetry snapshot: window_visible/window_focused/bootWindowOpen/screenLocked) | No |
| `3640318556` | boolean | Remote-tools bridge WebSocket URL shape: device-level `${base}/devices/{org}_{account}/bridge` vs per-session `.../{session}/bridge` | No |
| `3673327456` | boolean | Cowork VM memory `sizedToHost` - host-RAM-tiered VM memory sizing table (maxGB/baselineGB/minGB; `vmMemoryGB` preference still wins) | No |
| `3764441751` | boolean (hoisted const `qdr`) | `[rc-serve]` second gate (trio with `1183214304`/`1410651677`) | No |
| `3946462706` | boolean | SSH transport default-to-OpenSSH rollout: consulted when `CLAUDE_DESKTOP_SSH_TRANSPORT` is neither `openssh` nor `ssh2` (and `291584251` is off) | No |
| `3961433847` | boolean | Local MCP server manager second gate (same module as `3018088575`, default OFF) | No |

#### Removed in v1.32352.1

None. All 168 previously templated store-consulted flag IDs are still present. **Sweep caveat that produced false removals this release:** the minifier now emits large numeric object keys UNQUOTED (`2973881027:DO(...)`; v1.30096.1 quoted keys >= 2^31), so a quoted-literal-only diff reports the 16 3p-deployment-defaults-map-only IDs (`2369776764`, `2431502897`, `2547348043`, `2688060585`, `2895944283`, `2973881027`, `3007887412`, `3070110303`, `3150971238`, `3269331205`, `3353525254`, `3356268835`, `3368286709`, `3671534883`, `4085357330`, `4108768567`) as removed. They are all still there as unquoted keys.

**Feature (registry/schema) changes in v1.32352.1:** added `sessionPrOwnership` - static `{status:"unavailable"}` + async merger override sharing `ccdGitEngine`'s destructured slot (both gated by flag `959099749` via `YB(jB)`). Merger override object 8 -> 9 keys; Zod schema 56 -> 57 keys, still a non-strict `.partial()` object. Nothing removed.

**enable_local_agent_mode in v1.32352.1:** all 7 anchors verified present, each with exactly one match (Patch 1 darwin/win32 gate = quietPenguin inner `r9t` only; Patch 3's merger pattern matches only `return{...JB(),...c}},` in the whole staged bundle). All 6 Patch 3 override keys (`quietPenguin`, `louderPenguin`, `chillingSlothFeat`, `chillingSlothLocal`, `ccdPlugins`, `computerUse`) are present in the new registry (louderPenguin async-only) and the 57-key Zod schema. No patch edit needed.

#### New Flags in v1.30096.1

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `1942337209` | boolean (hoisted behind `function un(){return t.Qu("1942337209")}`) | Local MCP client protocol version-negotiation kill-switch. `LocalMcpServerManager` builds its `Client` with `...(transport is not in-process && !un()) ? {versionNegotiation:{mode:"auto",probe:{timeoutMs:500}}} : {}` — flag ON **drops** the auto version probe. | No — templated |
| `3671534883` | boolean, seeded `false` | Entry in the 3p/deployment-mode hardcoded flag-defaults map (`tut()`: `"3671534883":Dk(!1)`). It appears exactly once in the whole bundle and is never read by the main process, so its consumer is renderer/server-side. **Not templated**, consistent with the other defaults-map-only IDs (`2369776764`, `2431502897`, `2547348043`, `2688060585`, `2895944283`, `2973881027`, `3007887412`, `3070110303`, `3150971238`, `3269331205`, `3353525254`, `3356268835`, `3368286709`, `4085357330`, `4108768567`). | No |

#### Removed in v1.30096.1

None. All 167 previously catalogued store-consulted flag IDs are still present in the bundle.

**Feature (registry/schema) changes in v1.30096.1:** added `bootPlaceholder` — a static entry hardcoded to `{status:"unsupported", reason:"Boot placeholder not built in", unsupportedCode:"unknown"}`, with no flag and no platform gate, so it is inert on every platform. Zod schema 55 -> 56 keys, still a non-strict `.partial()` object. Nothing removed. Merger unchanged at 8 overrides.

**enable_local_agent_mode in v1.30096.1:** applied clean with no pattern fix (all 7 anchors matched on the first try). The only edit was **dropping the `chillingSlothPool` key from the Patch 3 merger override string** — the feature left the registry and the Zod schema in v1.28929.0, so the key was a no-op riding on the non-strict schema. Patch 3 now injects 6 keys (`quietPenguin`, `louderPenguin`, `chillingSlothFeat`, `chillingSlothLocal`, `ccdPlugins`, `computerUse`), all six of which are present in both the new registry and the new schema. Flag `1992087837` still exists as the CC worktree warm-pool gate and stays templated.

#### New Flags in v1.28929.0

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `1072565585` | listener + boolean | `newChatPageLaunchGate` - latches the `launchSignedInChatOnNewChatPage` preference (applies from the next launch) | No |
| `1346958739` | value flag (`Kt(id,"major"/"minor",...)`) | Chicago (Computer Use) macOS version floor config - defaults major 26 / minor 9999 | No |
| `3001783682` | boolean | "hybrid" account detection at startup - boot-hold vs idle while awaiting sign-in (`[hybrid] detection installed`) | No |
| `3424551112` | boolean | Merges autoMode permission rule sets (`environment`/`soft_deny`/`allow`) into session options for non-chat, non-hostLoop sessions | No |
| `3448679706` | boolean | Session-config enable gate read next to the `3045399524` `{enabled,prompt,alwaysLoad}` parse - **replaces `130970054`** (same call site, new ID) | No |
| `3547093683` | value flag (`Gt(id,5)`) | Remote-tools JIT poll interval in minutes (default 5, 0 = off) | No |
| `721728391` | boolean | `[inferenceRouting]` - inference routing decision via org policy backend (`hasOrgPolicyBackend`) | No |

#### Removed in v1.28929.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `1129583249` | Branch-switch conflict detection (`wouldBranchSwitchConflict`) | Gone; the conflict path no longer flag-gated |
| `115713051` | Start/stop listener gate (uncatalogued - hoisted const, missed by earlier call-shape greps) | Gone |
| `130970054` | Session-config enable gate | **Renamed to `3448679706`** (identical call site) |
| `1311049725` | `vcs_state_changed` gate (`gateEnabled`) (uncatalogued) | Gone |
| `2349950458` | Scheduled task notifications (`notifyScheduledTaskSubscriberIfNeeded`) | Gone; path unconditional or removed |
| `2678393595` | Git-status implementation switch / repo watcher gate (added v1.26832.0) | Gone - superseded by the `coworkWatchers` feature (merger override reads the scheduled-tasks module's `watchersEnabled()` config callback) |

**Feature (registry/schema) changes in v1.28929.0:** removed `chillingSlothPool` (flag `1992087837` survives as the worktree warm-pool gate), `deterministicCreatePr` (also dropped from the async merger), `chorusIn3p`; added `ccdGitEngine` (static unavailable + async override via flag `959099749`) and `sshAttachmentTransport` (static, always supported). Zod schema 56 -> 55 keys.

**Newly catalogued pre-existing flags (v1.28929.0 template refresh):** 23 genuine store-consulted flags that earlier call-shape extraction missed (most are hoisted module-scope consts, see the reader-shapes note above): `278625510` (MCP-UI capability + skill sources), `371539023`/`922442190`/`2023768496` (transport attestation trio; the last is the documented coworkTrustedDeviceToken gate), `583857784` (transport bridge SDK adapter), `762798616` (CCD auto-update + `check_interval_ticks` value), `879583975` (notification banner/badge map), `1118714395`+`2795595714` (device-companion gates, currently inert), `1284392461` (claude-bridge-ws transport), `1291166712` (chicago_config value flag: `enabled`/`subGates`/`coordMode`/`dispatchTtlMs`/`appScoped` - since v1.26832.0 the CU chicago enable reads `Kt("1291166712","enabled",!1)` behind the `2486083521`-era gate family), `1447478638` (LAM scheduled auto-permission gate w/ `mdmAutoModeDisabled`), `1549258603`/`3705360580` (LAM/CCD OAuth 401 refresh path switches), `1598976391` (proactiveSkillSuggestEnabled), `1648655587` (scheduled-task per-task/global session caps, value), `2016258596` (device-tool artifact gate, documented v1.19367.0), `2768844978` (Cowork VM image delta-apply), `3229517805` (scheduled-task config value, documented v1.5354.0), `3558849738` (Dispatch/Spaces), `3796647113` (stall-sampler), `4074604942` (1p direct MCP pool), `4200321681` (coworkAutoModeAlwaysAllowOverride merger flag, present since v1.26832.0). Also purged 4 stale template entries that were already absent from the v1.26832.0 bundle: `1953041099`, `2438134137`, `2976814254` (launch - feature went static, flag deleted), `3214976288`. Template 145 -> 167 entries (`CATALOG_EXPECTED` fixed - it had been left at 134 since the v1.26832.0 refresh, so the runtime drift diag was firing).

#### New Flags in v1.21459.0

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `1061122496` | boolean | Worktree destroy gate — `worktreeManager.removeWorktree` + `deleteWorktreeBranch` only run when ON | No |
| `1129583249` | boolean | Branch-switch conflict detection (`wouldBranchSwitchConflict`); else falls back to `isWorkingTreeDirty` | No |
| `1480778051` | boolean | `render_rss_bytes` memory-telemetry suppression (ON = skip emission) | No |
| `1924247864` | boolean | Device-registry gate (`Ylt`) for the `device-registry-` map/cache path | No |
| `1953041099` | value flag | Skill description/prompt text override — server-configured `skillDescription`/`skillPrompt` (Zod-validated) | No |
| `2745857735` | boolean | LAM remote folder-access `homeDirectories` + `remoteFileTools` (was documented since v1.12603.0 but only now store-consulted) | No |
| `2961849615` | boolean | Revive CCD sessions after relogin (`reviveCcdSessionsAfterRelogin`) | No |
| `3214976288` | boolean | "morning" prompt/skill `isEnabled` | No |
| `3431784271` | boolean | Plugin backfill prune of unresolvable plugins (`pruneUnresolvablePlugins`) | No |
| `3976799455` | boolean | Away-recap generation (`maybeGenerateAwayRecap`) | No |

**Removed in v1.21459.0:** none.

#### New Flags in v1.20186.1

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `3602629573` | boolean + live listener | JitlessPolicy process kill-switch — listener + value read feed the `ProcessKillSwitchEngaged` path | No |

**Removed in v1.20186.1:** `1295378343` (CLI stream robustness `gapSurviveEnabled`/`stdinOffset` value flag — gone entirely; dropped from the overrides template).

**Merger change in v1.20186.1:** async override object grew 5 -> 6 keys — new `launch` override (`Oae()` = `At("2976814254")||!1`, the claudePreview/launch-server flag; follows server rollout - the former enable_local_agent_mode Patch 3j force was retired 2026-07-13, opt-in via .jsonc growthbookOverrides).

#### New Flags in v1.19367.0

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `1544796833` | value (`Vr(id,key,default,zodInt)`) | Session-concurrency limits config via `M6(key,default)`: `maxConcurrentPerSession` (8), `maxConcurrentTotal` (16), `maxQueuedPerSession` (256), `maxQueuedTotal` (1024), `maxQueuedCharsTotal` (256MB) | No |
| `2016258596` | boolean (constant `otr`) | Device-tool artifact storage/read gate — when OFF, artifact reads emit `artifact_read_gate_off` telemetry and return a gate-off message; also augments the `1947305033` create/update_artifact tool description | No |
| `416245092` | boolean, default ON (`ga(id,!0)`) | GPU crash-streak marker — gates writing a `gpu-crash-streak-marker` state file after repeated GPU process crashes | No |

(`"123456789"` also appears new in the raw numeric diff but is a TUI keypress helper string — number-row key matching — not a flag.)

**Removed in v1.19367.0:** none (broad numeric-string diff OLD vs NEW shows 0 removals).

**New static feature in v1.19367.0:** `coworkScheduledTaskProjects:ul` (always supported, no platform gate, present in the Zod schema; no override needed).

#### New Flags in v1.17282.0

| Flag ID | Role | Patched? |
|---------|------|----------|
| `1197768857` | `spaceMemoryBridge` feature gate — registry entry `rt("1197768857")?Ed:{status:"unavailable"}`, also gates the space-memory MCP tools (`readSpaceMemoryIndex`) | No |
| `1295378343` | `gapSurviveEnabled` — value flag, default OFF (`FE("1295378343",!1)`); spread onto a spawned live-process options object | No |
| `130970054` | `rt("130970054")` read into a prompt/feature enable check (`Ve({enabled:...})`) | No |
| `1569828280` | Binary-asset-fetch gate — `if(!et("1569828280")){...gate_off...skipping binary asset fetch}` | No |
| `2431502897` | Model-policy map entry — `"2431502897":lW("inherit")` in the model/permission policy resolver map | No |
| `3778159589` | Device-stale-relogin — `rt("3778159589")?e():A()` selecting the relogin path (`markDeviceStaleRelogin`) | No |
| `629684104` | Assistant-error-recovery — gates synthesizing a recovery result (`assistantUuid`/`resultUuid`) on an assistant error | No |

#### Removed in v1.17282.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `1802019210` | Cowork plugin upload migration gate | Gone from the bundle (no `rt()`/`wt()` calls) |
| `1985784543` | `isEnabled` gate spread onto a config object (added v1.13576.0) | Gone from the bundle |
| `3110209724` | (prior gate) | Gone from the bundle |
| `3732274605` | `markTaskComplete` feature gate | Gone — feature removed from registry, merger, Zod schema, and force-ON defaults map |
| `4018578026` | (prior gate) | Gone from the bundle |

### Boolean Flags (wt())

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `162211072` | Prompt suggestions enable | No |
| `286376943` | Plugin skills for system prompt — gates `getPluginSkillsForSystemPrompt` (**new in v1.2278.0**) | No |
| `397125142` | Terminal server — gated: `sessionType==="ccd"&&!isSSH` AND this flag. CCD only, NOT cowork. Upstream **dropped** the old `pj`/`r6e` platform gate, so no patch needed (was `fix_dispatch_linux.nim`, now removed); flag enabled server-side | No |
| `714014285` | CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING | No |
| `763725229` | Developer menu label/visibility | No |
| `720735283` | Marketplace migration | No |
| `748063099` | VM client retry on pipe close | No |
| `770567414` | VM service routing (direct vs persistent pipe) | No |
| `1412563253` | askUserQuestion preview format ("html") | No |
| `1434290056` | Dispatch code tasks permission mode — bypass-permissions for dispatch sessions (**new in v1.2278.0**) | No |
| `1942781881` | Prompt suggestions in sessions | No |
| `2051942385` | CIC can-use-tool | No |
| `2067027393` | canLaunchCodeSession | No |
| `2216414644` | Remote session control (Dispatch mobile) | No — was bypassed in `fix_dispatch_linux.nim`; **patch removed** (Dispatch is upstream-native on Linux as of v1.17377, live-tested) |
| `2246535838` | Local MCP server prefix (`local:`) | No |
| `2339084909` | VM monitoring fallback (non-heartbeat) | No |
| `2340532315` | Plugin sync on session start | No |
| `2345107588` | GrowthBook cache persistence — persist/seed GrowthBook cache from/into sessions (**new in v1.2278.0**) | No |
| `2349950458` | Scheduled task notifications | No |
| `2392971184` | Replay user messages — adds `--replay-user-messages` to CLI args for session resume; also enables `/remote-control`/`/rc` command in dispatch (**new in v1.2278.0**) | No |
| `2614807392` | Session feature A | No |
| `2725876754` | Org CLI exec policies — gates reading `orgCliExecPolicies` for plugin tool permission checks (**new in v1.2278.0**) | No |
| `2976814254` | Launch server (isAvailable check) | No |
| `3246569822` | canSaveSkill (save reusable skills) | No |
| `3366735351` | Auto-update on ready state | No |
| `2940196192` | coworkArtifacts — persistent HTML artifact storage in cowork sessions | No — force retired 2026-07-13; follows server rollout, opt-in via .jsonc growthbookOverrides |
| `3444158716` | Cowork resources MCP ("visualize" — show_widget tool) | No |
| `1143815894` | hostLoopMode — non-VM cowork (bare SDK loop, no cowork service spawn) | **No** — must NOT be forced ON; doing so bypasses the cowork service, breaking skills/plugins |
| `3558849738` | Dispatch/Spaces feature (RBe constant) | No — was forced ON in `fix_dispatch_linux.nim`; **patch removed** (defaults ON upstream on Linux) |
| `3572572142` | Sessions-bridge init (Dispatch) | No — was forced ON in `fix_dispatch_linux.nim`; **patch removed** (inits natively on Linux) |
| `3691521536` | Stealth updater — nudge updates when no active sessions | No |
| `3723845789` | Additional Cowork tools | No |
| `4116586025` | louderPenguin / Code tab master gate | No (overridden at merger level) |
| `4153934152` | CLAUDE_CODE_SKIP_PRECOMPACT_LOAD | No |
| `4160352601` | VM heartbeat monitoring | No |
| `4201169164` | **Remote orchestrator** (codename "manta") — **removed from GrowthBook** in v1.1.9669; `Hhn()` now returns hardcoded `false` (`Qhn=!1`). Code still exists but is disabled. | No — `fix_dispatch_linux.nim` removed (Dispatch upstream-native) |

#### New Boolean Flags in v1.8089.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `245679952` | `suggestSkillsEnabled` default (when no system prompt override) | No |
| `1129419822` | `ENABLE_TOOL_SEARCH='auto'` env var for LAM sessions | No - was forced ON by Patch 3f until 2026-07-11; disabled because it injected a dead ToolSearch tool into every LAM session (nothing deferred at ~79 tools) and confused the model into `Skill({"skill":"ToolSearch"})` errors. Follows server rollout now. |
| `1496676413` | SSH remote MCP/plugin passthrough (`adjustSdkOptions`) **(removed upstream v1.18286.0 - gate went unconditional)** | No - Patch 3n deleted |
| `2049450122` | Session handoff detection (`cse_`/`session_` prefix check) | No |
| `2192324205` | Tool use result formatting/filtering | No |
| `2800354941` | Deterministic sorting of plugins/tools/logs | No |

#### Flags Now in Force-ON Defaults Map (uNi) in v1.8555.2

| Flag ID | Purpose | Notes |
|---------|---------|-------|
| `3246569822` | `canSaveSkill` (save reusable skills) | Was already documented but now in force-ON defaults map |

#### New Non-Boolean Flag in v1.8089.0

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `4274871493` | value | Plugin enabled state fetching (`fetchEnabledState`) | No |

#### New Listener Flag in v1.8089.0

| Flag ID | Purpose |
|---------|---------|
| `180602792` | midnightOwl prototype (quick access overlay feature) |

#### Removed in v1.8089.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `982691970` | Cowork plugin host ops gate | Completely removed from `wt()` calls |
| `1802019210` | Cowork plugin upload migration | Completely removed from `wt()` calls |
| `2216480658` | VM outputs directory mounting | Completely removed from `wt()` calls |
| `2860753854` | System prompt override | Completely removed from `wt()` calls |
| `3298006781` | MSIX updater gate | Completely removed from `wt()` calls |
| `3858743149` | `maxThinkingTokens` config | Completely removed from `wt()` calls |
| `3885610113` | Model name [1m] suffix | Completely removed from `wt()` calls |
| `4019128077` | Cowork CU `alwaysLoad` | Completely removed from `wt()` calls |

#### Access Pattern Changes in v1.8089.0

| Flag ID | Change | Notes |
|---------|--------|-------|
| `2307090146` | Plugin OAuth storage gate | Still in force-ON defaults map (`uNi`) but no longer in `wt()` direct calls |
| `2345515473` | Sessions-bridge account-change | Still in `Bm()` listener calls |
| `3558849738` | Dispatch/Spaces | Stored as `mpt` constant, read via `wt(mpt)` (still exists) |
| `3572572142` | Sessions-bridge init | Still in `Bm()` listener calls |

#### Notable Feature Changes in v1.8089.0

- `2204227020` also gated Visualize (Imagine) MCP server for CCD sessions (was cowork-only before). **Renamed to `3516166472` in v1.13576** - the old ID no longer appears in the bundle. (`fix_imagine_linux.nim` tracked it until the patch was retired 2026-07-13 in favor of .jsonc overrides.)
- New `floatingPenguinEnabled` preference (not yet a feature flag in registry - config-only)
- New `midnightOwl` prototype (dev toggle + GrowthBook flag `180602792`)

#### New Boolean Flags in v1.13576.0

(Delta measured vs the v1.12603.0 baseline bundle; `1703762832` was already added in v1.12603.1, so net-new in v1.13576.0 is `1985784543` + `3646818354`.)

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `1985784543` | An `isEnabled` gate spread onto a config object: `e?{...e,isEnabled:()=>Ct("1985784543")}:null`. No platform gate. | No |
| `3646818354` | `shouldKillOnIdlePause()` returns `!Ct("3646818354")` - when ON, the session is NOT killed on idle pause. No platform gate. | No |

#### New Boolean Flags in v1.12603.1

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `1703762832` | `onModelRefusalFallback` retry - when ON, a refusal response with `direction:"retry"` in `AgentModeSessionManager` triggers a fallback handler (sets `session.overrideLabel` + initiates retry). No platform gate, purely server-side rollout. | No |

#### New Boolean Flags in v1.12603.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `2115990222` | `artifactsPane` feature gate - NEW static registry feature `artifactsPane:DPt()` where `function DPt(){return dt("2115990222")?{status:"supported"}:{status:"unavailable"}}`. No platform gate, purely GrowthBook-rolled-out. First key in the registry object. | No |
| `2745857735` | LAM remote folder-access requests - when ON, dispatch/LAM sessions get an extra tool ("Ask the user to grant this session access to a folder on this device that is not currently connected"), telemetry event `lam_remote_request_folder_access`; when OFF the handler returns "Folder access requests are not enabled on this device." Also changes trusted-folder enumeration: `dt("2745857735")?[]:Object.values(i).flat()` (flag ON narrows the default trusted-folder set to per-session entries) | No |
| `884132720` | OAuth scope passthrough - forwards the OAuth token scope into the CLI session env build: `oauthScope:dt("884132720")?t.scope:void 0` inside `ZWr({oauthToken,...})` | No |

#### New Value Flag in v1.12603.0

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `3932491586` | `LC()` value, default `!1` | VM optional mounts - marks user-selected folder mounts as `optional:LC("3932491586",!1)===!0` in the cowork VM mount table; present as force-OFF (`qdr`) in the `Vdr` defaults map. `LC(A,e)` is a NEW reader: `function LC(A,e){const t=gf[A];return LAA(A,t),t===void 0?e:t.value}` | No |

**Removed in v1.12603.0:** none (0 flag IDs removed; broad numeric-string diff OLD vs NEW confirmed only the 4 additions above).

#### New Boolean Flags in v1.11847.5

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `3516166472` | `epitaxyMcpApps` async gate - MCP apps inside epitaxy (SSH remote) sessions; merger helper `zQt()` = `await e4A(5e3)` (5s delay) + `await ctt()` prereq + this flag | No |
| `1997559319` | `onUserDialog` broker - enables `supportedDialogKinds:["refusal_fallback_prompt"]` permission-dialog path | No |
| `2724639973` | Session governor `evictionEnabled` - memory-pressure-based session eviction | No |
| `3807767338` | `seedPolicyLimitsIntoSession` / `refreshPolicyLimitsPersist` - org policy-limit persistence | No |

**New static features in v1.11847.5** (see version history row): `coworkRemoteSessionSpaces` (always supported), `coworkBranchSession` (always supported), `epitaxyMcpApps` (static unavailable + async override via `3516166472`). None platform-gated; `enable_local_agent_mode.nim` override list unchanged. (Precise add/remove flag delta is not fully reliable - the only local prior bundle is patched - so this table lists the 4 flags verified genuinely new this release rather than a raw set diff.)

#### New Boolean Flags in v1.8555.2

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `434204418` | MCP non-blocking connection | No |

#### New Listener Flags in v1.8555.2

| Flag ID | Purpose |
|---------|---------|
| `4150329283` | Cloud sync drive |
| `2358734848` | Hardware buddy |

#### Flags Now in Force-ON Defaults Map (uNi) in v1.8555.2

| Flag ID | Purpose | Notes |
|---------|---------|-------|
| `2940196192` | coworkArtifacts | Added to force-ON defaults map |

#### Removed in v1.8555.2

| Flag ID | Was | Notes |
|---------|-----|-------|
| `658929541` | Lock mid-session model changes (LAM setModel buffer) | Completely removed from `wt()` calls |
| `2815031518` | CCD lock mid-session model change (LocalSessionManager) | Completely removed from `wt()` calls |

#### Removed Value Flags in v1.8555.2

| Flag ID | Was | Notes |
|---------|-----|-------|
| `2921038508` | Cowork memory guide prompt text | Completely removed |

#### New in v1.1.9134

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `66187241` | `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` for LAM/Cowork sessions | No |
| `1585356617` | Epitaxy routing - SSH session routing, spawned session tools, system prompt append. When on, sessions route to `/epitaxy?openSession=` instead of `/claude-code-desktop/` | No |
| `2199295617` | AutoArchiveEngine — auto-archives sessions when PRs close | No |
| `3792010343` | `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` for CCD (non-LAM) sessions | No |

#### Removed in v1.1.9134

| Flag ID | Was | Notes |
|---------|-----|-------|
| `3196624152` | Phoenix Rising updater | Completely removed |

#### New in v1.1062.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `2114777685` | Cowork onboarding / CU-only mode (`show_onboarding_role_picker` tool) | No |
| `3371831021` | `cuOnlyMode` — computer-use-only session variant | No |

#### New in v1.2773.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `2140326016` | Author-supplied bin stubs error enforcement | No |
| `2216480658` | VM outputs directory mounting | No |
| `3858743149` | `maxThinkingTokens` config (configurable thinking budget, default 4000, min 1024) | No |

#### Removed in v1.2773.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `1585356617` | Epitaxy routing — SSH session routing | Completely removed |
| `2199295617` | AutoArchiveEngine — auto-archives sessions when PRs close | Completely removed |
| `4201169164` | Remote orchestrator ("manta") — was already hardcoded off | Completely removed |

#### New in v1.5354.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `451382573` | `DISABLE_BRIEF_MODE_STOP_HOOK` env var for cowork/LAM sessions | No |
| `839037100` | Cowork OAuth configs — gates OAuth config loading | No |
| `939257113` | Dispatch child session detection — `isRemoteDispatchChild` qualifier | No |
| `975112542` | Cowork memory remote sync — `canSyncCoworkMemoryRemotely()` | No |
| `1696890383` | `CLAUDE_COWORK_MEMORY_GUIDE` env — passes memory guide to cowork sessions (also in force-ON defaults) | No |
| `1824824999` | Consolidate-memory skill v2 — configurable descriptions via `1004628546` | No |
| `1928275548` | framebufferPreview feature — dev-gated (inside `MW()`) | No (dev-only) |
| `2216901299` | Org policy backend check — remote management policy enforcement | No |
| `2393677837` | PreToolUse hook for worktree-aware tool input validation | No |
| `2979038612` | Session notifications — `queueSessionNotification` for model switch, folder access | No |
| `3023518717` | Updater rollback detection — extends auto-update triggers | No |
| `4019128077` | Cowork browser/CU `alwaysLoad` — forces all CU MCP tools to always load | No |
| `4141490266` | Framebuffer system prompt injection — adds instructions when Framebuffer server active | No |

#### New Value/Object Flags in v1.5354.0

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `1004628546` | `lp()` | Configurable consolidate-memory skill description/prompt | No |
| `3229517805` | `lp()` | `runScheduledTaskEnabled` (default `true`) — scheduled task execution gate | No |

#### New Listener Flags in v1.5354.0

| Flag ID | Purpose |
|---------|---------|
| `2345515473` | Sessions-bridge account-change reevaluation |

#### New in v1.6259.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `982691970` | Cowork plugin host ops gate (dynamic import) | No |
| `1802019210` | Cowork plugin upload migration gate (dynamic import) | No |
| `2307090146` | Plugin OAuth storage gate (also added to force-ON defaults map) | No |

#### New Value/Object Flags in v1.6259.0

| Flag ID | Type | Purpose | Patched? |
|---------|------|---------|----------|
| `873030668` | `lp()` | GrandPrix partner config (salt + partner entries) | No |
| `1126577245` | `lp()` | Cowork memory remote sync config | No |
| `2921038508` | `lp()` | Cowork memory guide prompt text | No |

#### Removed in v1.6259.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `839037100` | Cowork OAuth configs gate | Completely removed |

#### Removed in v1.6608.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `1306813456` | Operon/Nest gate | Completely removed (operon feature removed) |
| `1496450144` | `CLAUDE_CODE_ENABLE_TASKS` env var | Completely removed |
| `2216480658` | VM outputs directory mounting | Completely removed |
| `2433104842` | Operon/CU-related | Completely removed |
| `2486083521` | Operon/CU-related | Completely removed |
| `4019128077` | Cowork browser/CU `alwaysLoad` | Completely removed |

#### New Server-Side GrowthBook Flags in v1.6608.2

21 new server-side GrowthBook flag IDs observed. These are **not** feature flags in the static registry (`Np()` in v1.8555.2, was `eD()` in v1.8089.0, `pw()` in v1.6608.2); they are server-side toggles read via `wt()` (was `St()` in v1.8089.0, `pt()` in v1.6608.2) at runtime. All function names unchanged from v1.6608.1.

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `66187241` | `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` for local-agent sessions | No |
| `451382573` | `DISABLE_BRIEF_MODE_STOP_HOOK` for dispatch sessions | No |
| `658929541` | Lock mid-session model changes when message buffer non-empty | No |
| `939257113` | Dispatch subscription check (`isRemoteDispatchChild` qualifier) | No |
| `975112542` | Cowork memory remote sync (`canSyncCoworkMemoryRemotely()`) | No |
| `1496676413` | SSH plugin/MCP stripping — gates plugin and MCP forwarding to SSH sessions **(removed upstream v1.18286.0 - gate went unconditional)** | No - Patch 3n deleted |
| `1696890383` | Cowork memory guidelines injection (`CLAUDE_COWORK_MEMORY_GUIDE` env) | No |
| `1824824999` | Memory-consolidation skill config (configurable descriptions) | No |
| `2049450122` | Session handoff — cross-device session activity broadcasting | No |
| `2114777685` | Cowork-only MCP tool (`show_onboarding_role_picker`) | No |
| `2140326016` | Hard-fail on author-supplied bin/ stubs | No |
| `2192324205` | Tool use result filtering (dispatch structured content forwarding) | No |
| `2216901299` | Org policy backend check — remote management policy enforcement | No |
| `2393677837` | PreToolUse hook for worktree-aware permission blocking | No |
| `2800354941` | Sort plugin skills alphabetically — deterministic ordering | No |
| `2815031518` | CCD lock mid-session model change (LocalSessionManager equivalent) | No |
| `2979038612` | Notify user on missing session folders (`queueSessionNotification`) | No |
| `3023518717` | Auto-update nudge — extends auto-update triggers (rollback detection) | No |
| `3371831021` | Cowork CU-only mode (`COWORK_CU_ONLY`) | No |
| `3792010343` | `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` for CCD (non-LAM) sessions | No |
| `4141490266` | Extended tool actions (framebuffer system prompt injection) | No |

**Note:** Many of these flag IDs already appeared in earlier version sections (e.g., `66187241` and `3792010343` in v1.1.9134, `451382573` in v1.5354.0). They are listed here because they were newly observed in server-side GrowthBook payloads for v1.6608.2, confirming they remain active.

#### MCP Registration Renames in v1.6608.2

| Old | New | Context |
|-----|-----|---------|
| `lrA()` | `BrA()` | MCP server registration function |
| `MG` | `I_` | MCP-related variable |
| `VqA` | `xSA` | MCP-related variable |
| `Y7()` | `pq()` | MCP-related function |

**Note:** `lrA()`→`BrA()` was already noted in the v1.6608.1 version history entry. The remaining three renames (`MG`→`I_`, `VqA`→`xSA`, `Y7()`→`pq()`) are new in v1.6608.2.

#### Removed in v1.5354.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `365342473` | `shouldScrubTelemetry` (value flag) | Completely removed from codebase |

#### New in v1.4758.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `1992087837` | chillingSlothPool — concurrent session pooling | No — force retired 2026-07-13; follows server rollout, opt-in via .jsonc growthbookOverrides (Patch 3's merger still marks the chillingSlothPool capability supported) |
| `3732274605` | markTaskComplete — task completion feature | ~~**Yes** — forced ON in `enable_local_agent_mode.nim`~~ **REMOVED in v1.17282.0** (flag gone from bundle; the patch's markTaskComplete force-ON entry is now a vestigial no-op, but the patch was intentionally left unchanged) |

#### New in v1.3883.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `2049450122` | Session handoff — gates cross-device session activity broadcasting (`com.anthropic.claude.session` NSUserActivity identifier) | No |
| `2192324205` | Dispatch structured content forwarding — gates whether `dispatch_child` and `code` structured content kinds pass the message filter (in the rjt() function patched by `fix_dispatch_linux.nim`) | No |

#### New in v1.3561.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `1496676413` | SSH session plugins/MCP forwarding — gates plugin and MCP server forwarding to SSH remote sessions (6 call sites in session start, spawn, and MCP resolution) **(removed upstream v1.18286.0 - gate went unconditional)** | No - Patch 3n deleted |
| `2023768496` | Trusted device token — gates `coworkTrustedDeviceToken` read/write for cowork sessions | No |

**Also:** `123929380` (coworkKappa) added to force-ON defaults map — Anthropic enabling consolidate-memory by default before server config loads.

#### New in v1.3036.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `658929541` | LocalAgentModeSessionManager `setModel` buffer check — allows model-switch when `messageBuffer.length>0` (ccd_lock mitigation) | No |
| `1496450144` | `CLAUDE_CODE_ENABLE_TASKS` env var — enables the new Tasks CLI feature (gated alongside `CLAUDE_CODE_SKIP_PRECOMPACT_LOAD`) | No |
| `2800354941` | Alphabetical sort for plugin/skill lists and system-prompt skills — deterministic ordering | No |
| `2815031518` | LocalSessionManager `setModel` buffer check — CCD-session equivalent of `658929541` (ccd_lock mitigation) | No |

#### Removed in v1.3036.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `159894531` | ENABLE_TOOL_SEARCH env-var override (was forced ON by our patch) | **Completely removed — the Desktop-side `ENABLE_TOOL_SEARCH="false"` override is gone. User's `~/.claude/settings.json` now passes through unmolested. Our Patch 3c was removed.** |
| `919950191` | ENABLE_TOOL_SEARCH for LAM sessions (was new in v1.2773.0) | Completely removed |
| `2678455445` | MCP SDK server mode | Completely removed |

#### New in v1.2581.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `123929380` | coworkKappa / `consolidate-memory` skill — reflective pass over memory files (merge, prune, fix). Also gates session context building for typeless sessions. | No — force retired 2026-07-13; follows server rollout, opt-in via .jsonc growthbookOverrides |

#### Removed in v1.2581.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `4040257062` | Memory path routing — nested memory dir for non-session contexts | Completely removed from codebase |

#### New in v1.1348.0

| Flag ID | Purpose | Patched? |
|---------|---------|----------|
| `4040257062` | Memory path routing — nested memory dir for non-session contexts | No (**removed in v1.2581.0**) |

#### Removed in v1.1348.0

| Flag ID | Was | Notes |
|---------|-----|-------|
| `927037640` | Subagent model config (Js() value flag) | Completely removed from codebase |
| `3190506572` | Chrome permission control (skip_all_permission_checks, disable_javascript_tool) | Completely removed from codebase |

#### Removed in v1.1062.0

These dispatch-era flags were removed from GrowthBook boolean calls (code may still reference them but they no longer fire):

| Flag ID | Was | Notes |
|---------|-----|-------|
| `3558849738` | Dispatch/Spaces feature | Still used as constant `PLe` + `hI()` wrapper + listener, but not in direct boolean calls |
| `3572572142` | Sessions-bridge init (Dispatch) | Still has active listener `LI("3572572142", ...)` |
| `4201169164` | Remote orchestrator ("manta") | Fully removed |
| `1585356617` | Epitaxy routing | Removed |
| `2199295617` | AutoArchiveEngine | Removed |
| `2860753854` | System prompt override (boolean call) | Removed from boolean calls (still exists as value flag) |

### Object/Value Flags (Pr())

`Lh()` reads single-value flags (reads `.value` directly from `CQ` storage); `Pr()` reads structured object flags with key+schema.

| Flag ID | Type | Purpose |
|---------|------|---------|
| `254738541` | fs() | Prompt text (**new in v1.1348.0**) |
| `365342473` | wA() | shouldScrubTelemetry (default: `true`) (**new in v1.1348.0**) |
| `476513332` | wA() | Update check interval ticks config |
| `554317356` | wA() | Timer interval config |
| `1677081600` | wA() | Custom prompt/instruction text |
| `1748356779` | wA() | System prompt / user prompt template config |
| `1893165035` | wA() | SDK error auto-recovery config (`{enabled, categories}`) — categories include `sdk_binary_missing`, `sandbox_deps_missing`, `filesystem_error` (**new in v1.2278.0**) |
| `1978029737` | fs() | Session config (skillsSyncIntervalMs, artifactMcpConcurrencyLimit, artifactSampleConcurrencyLimit, idleGraceMs, disableSessionsDiskCleanup, sessionsBridgePollIntervalMs, coworkMessageTimeoutMs, coworkWebFetchViaApi, coworkNativeFilePreview, coworkWebFetchPrompt, memoryIndexSnapshotIdleMs, peakHoursStartPst, peakHoursEndPst) |
| `2860753854` | wA() | System prompt override text |
| `2893011886` | fs() | Wake scheduler config (enabled, scheduledTasksWakeEnabled, minLeadTimeMs, chainIntervalMs, batteryIntervalMs, acIntervalMs) |
| `3300773012` | fs() | Scheduled tasks config (skillDescription, skillPrompt, scheduledTaskPostWakeDelayMs, dispatchJitterMaxMinutes) |
| `3586389629` | wA() | Connection timeout config |
| `3758515526` | fs() | Default marketplace repo config (repo, repoCCD) |
| `3858743149` | fs() | maxThinkingTokens config (default 4000, min 1024) (**new in v1.2773.0**) |
| `4066504968` | fs() | Setup-cowork skill config (skillDescription, skillPrompt) (**new in v1.1348.0**) |

### Listener Flags (Bm())

| Flag ID | Purpose |
|---------|---------|
| `180602792` | midnightOwl prototype (quick access overlay feature) (**new in v1.8089.0**) |
| `1978029737` | Skills plugin sync / poll sleep kick |
| `2345515473` | Sessions-bridge account-change reevaluation |
| `2940196192` | Artifacts changed listener - triggers re-emit on flag toggle |
| `3572572142` | Sessions-bridge on/off toggle |
| `mpt` (`3558849738`) | Dispatch/Spaces feature - used via variable reference |

## What We Patch on Linux

### enable_local_agent_mode.nim

**Patch 1 - Individual functions:** Remove the `process.platform!=="darwin"` (or compound darwin/win32) gate from the remaining platform-gated feature function(s) (only quietPenguin as of v1.17377; the count varies per release and the patch accepts >=1 match). **Patch 1b (yukonSilver) is a pure regression guard** - upstream's official Linux `.deb` has native Cowork support (linux->"unix" VM-bundle key + `eo.files[e_A("linux")][arch]` gated on the real `are()` KVM probe), so nothing is injected; the guard fails the build loud if that native path ever disappears.

**Patch 3 - merger override (7 keys as of 2026-07-01):** Append to the async merger's return object:
```javascript
,quietPenguin:{status:"supported"},louderPenguin:{status:"supported"},chillingSlothFeat:{status:"supported"},chillingSlothLocal:{status:"supported"},chillingSlothPool:{status:"supported"},ccdPlugins:{status:"supported"},computerUse:{status:"supported"}
```

The spread order ensures our values win over the static registry. **`chillingSlothPool` is vestigial since v1.28929.0** - the feature left the registry and the Zod schema (flag `1992087837` survives only as the worktree warm-pool gate). The injected key is harmless: the features schema is a non-strict zod object, so the IPC handler's `safeParse(...).success` guard still passes with the unknown key (verified empirically against the v1.28929.0 zod chunk). Drop the key from the override list the next time the patch is edited. **Deliberately NOT overridden:** `yukonSilver` / `yukonSilverGems` / `coworkKappa` / `coworkArtifacts` status objects - those must reflect upstream's native VM-capability probe (`are()`: /dev/kvm, OVMF, qemu, virtiofsd); force-marking them would mask a real unavailable state and turn the honest "install QEMU" message into a generic VM-spawn failure. The GrowthBook flag force-flips are separate and kept: `coworkKappa` `123929380` (3b), `coworkArtifacts` `2940196192` (3c), `chillingSlothPool` `1992087837` (3d), plus the 3g-3p set (Patch 3f `ENABLE_TOOL_SEARCH` `1129419822` was disabled 2026-07-11 - the forced flag only injected a dead ToolSearch tool into LAM sessions; it follows server rollout now). `markTaskComplete` (former Patch 3e, flag `3732274605`) was removed upstream in v1.17282.0 and the sub-patch was deleted.

**Platform spoofs removed (2026-07-02, issue #173):** former sub-patches 5 (HTTP header `anthropic-client-os-platform: darwin`), 5b (Macintosh User-Agent), 6 (`getSystemInfo` IPC -> `win32`) and 8 (`navigator.platform="Win32"` + Windows userAgentFallback) are GONE. They were MSIX-era workarounds; against the official Linux `.deb` they made the remote claude.ai renderer see Windows and block Cowork ("Cowork is not currently supported on Windows"). The app now reports `linux` everywhere, guarded by a positive assertion that the header builder sends the raw `.platform` read. **The GrowthBook force-flips stay regardless:** a live post-fix session's `/api/desktop/features` payload (disk cache `~/.config/Claude/fcache`) serves all 200 features as `null` with zero rules ("0 changed" vs the spoofed-era cache), so honest platform reporting unlocks nothing server-side - without the flips, every gated lookup returns null and the features switch off.

### Cowork on Linux (experimental)

As of the official Linux `.deb`, Cowork runs on Anthropic's **native Linux VM backend** bundled in the package (cowork-linux-helper + virtiofsd + smol-bin + QEMU/OVMF; requires `/dev/kvm`). The MSIX-era wiring is gone:

- **`fix_cowork_linux.nim` and the rest of the cowork-wiring cluster were removed** in the `.deb` pivot - the official build ships the VM client loader with native Linux support
- **`claude-cowork-service`** (the separate Go daemon) is **deprecated** and no longer used; Cowork now works through the official native backend
- The only remaining Cowork patch is **`fix_cowork_firmware_paths_linux.nim`** (adds non-Debian OVMF firmware paths *and* non-Debian `virtiofsd` paths to the VM capability probe)
- `yukonSilver` / `yukonSilverGems` are **NOT overridden** - their status comes from upstream's native VM-capability probe, so a KVM-less or QEMU-less host honestly reports Cowork unavailable (with the actionable reason) instead of failing at VM spawn
- **The bundled `resources/virtiofsd` fallback is Ubuntu-22.04-only** (verified v1.17377.2: `Uoi()`'s upstream `os-release id==="ubuntu" && versionId.startsWith("22.")` gate) - on every other distro, incl. Arch/Fedora/NixOS, `virtiofsdPath` resolves to `null` unless a *system* `virtiofsd` exists at one of the probed absolute paths. `claude-desktop --diagnose`'s Cowork replica previously checked the bundled path unconditionally (missing that gate), so it could report a false "SHOULD pass" that disagreed with the real in-app probe on non-Ubuntu-22.04 hosts ([#177](https://github.com/patrickjaja/claude-desktop-bin/issues/177), fixed alongside the new NixOS `/run/current-system/sw/bin/virtiofsd` candidate).

### Dispatch on Linux (upstream-native — patch removed)

Dispatch is a remote task orchestration feature that lets you send tasks from your phone to your desktop. It's built on top of the Cowork sessions infrastructure and uses Anthropic's "environments bridge" API.

**Architecture:** Desktop registers with `POST /v1/environments/bridge`, then long-polls `GET /v1/environments/{id}/work/poll` for incoming work from the mobile client. All traffic routes through Anthropic's servers over TLS — no inbound ports needed.

**Status (v1.17377):** `fix_dispatch_linux.nim` has been **removed**. Dispatch works on Linux with no patch — live-tested by sending a task from phone to desktop and receiving the rendered response. Over several releases upstream shipped every piece the patch used to force. For the historical record, the patch used to change:
1. **Sessions-bridge init gate** (flags `3572572142` + `4201169164`) — forced the combined init gate ON; now inits on Linux natively.
2. **Remote session control** (flag `2216414644`) — bypassed the `channel:"mobile"` throw; now permitted on Linux.
3. **Platform label** — added `case"linux":return"Linux"`; upstream now returns "Linux" via a ternary.
4. **Telemetry gate** — extended the darwin||win32 gate to Linux; upstream dropped the platform gate entirely.

If a future release breaks phone→desktop Dispatch on Linux, re-check these four before re-introducing a patch.

**Note on `operon` (Nest):** Completely removed in v1.6608.0. Previously required VM infrastructure (120+ IPC endpoints across 31 sub-interfaces). See [Operon Tool Inventory](#operon-tool-inventory-v11062) below for the historical model-facing toolset.

**No patching needed for:**
- Keep-awake (`powerSaveBlocker`) — works on Linux via Electron API
- Bridge state persistence — uses `userData` path, works on Linux
- CCR transport — pure HTTP/SSE, platform-agnostic
- OAuth configs — same endpoints for all platforms

### Remote Orchestrator ("Manta Desktop") — new in v1.1.8629

The **Remote Orchestrator** (codename "manta", flag `4201169164` / `yukon_silver_manta_desktop`) is an alternative to local Cowork. Instead of running a local `cowork-svc` process, it connects to Anthropic's cloud infrastructure via WebSocket (`wss://bridge.claudeusercontent.com`) to run Cowork/Dispatch sessions remotely.

**Flow:**
1. Calls `findOrchestrationRemoteEnvironment()` → looks for an `anthropic_cloud` environment via `/v1/environments`
2. Creates a CCR (Claude Code Remote) session on Anthropic's servers
3. Connects via WebSocket bridge (`/v2/ccr-sessions/devices/{org}_{account}/mcp`)
4. Skips local env registration & work polling — the cloud handles it

**Three ways to enable:**
1. GrowthBook flag `4201169164` — server-side, not enabled for Linux users
2. Env var `CLAUDE_COWORK_FORCE_REMOTE_ORCHESTRATOR=1` — force override
3. Developer setting `isMantaDesktopEnabled` (requires restart)

**Sessions-bridge gate interaction:** The sessions-bridge init gate variable `h` is now `h = f || p` where `f` = flag `3572572142` (dispatch) and `p` = flag `4201169164` (remote orchestrator). Our Patch A forces `h=!0`, which opens the gate for both features. However, the remote orchestrator has its own separate `isRemoteOrchestratorEnabled()` check — our patch doesn't force that.

**Linux status:** Not tested. The remote orchestrator bypasses the need for local `cowork-svc` entirely, which could simplify the Linux Cowork stack. However, it requires Anthropic's backend to return an `anthropic_cloud` environment, which may be limited to Pro accounts or not yet rolled out. Setting `CLAUDE_COWORK_FORCE_REMOTE_ORCHESTRATOR=1` would attempt the connection but likely fail with "No anthropic_cloud environment found" until Anthropic enables it server-side.

**Related env vars:**
- `CLAUDE_COWORK_FORCE_REMOTE_ORCHESTRATOR` — force enable remote mode
- `CLAUDE_REMOTE_TOOLS_BRIDGE_URL` — override WebSocket bridge URL (default: `wss://bridge.claudeusercontent.com`)

### Operon Tool Inventory (v1.1617.0)

When Operon is active (flag `1306813456`), the model gets access to a rich toolset organized in 4 categories. These are **NOT MCP tools** — they are dispatched through Operon's internal `_executeBrainTool()` / `_executeComputeTool()` routing, not the MCP protocol.

#### Brain Tools (`d3e` routing table, built via `Z0()`)

**Tool Router** (routed via `_handleX` methods):

| Tool | Handler | Status |
|------|---------|--------|
| `ask_user` | `_handleAskUser` | Active |
| `search_agents` | `_handleSearchAgents` | Active |
| `search_skills` | `_handleSearchSkills` | Active |
| `create_skill` | `_handleCreateSkill` | Active |
| `generate_plan` | `_handleGeneratePlan` | Active |
| `update_step_status` | `_handleUpdateStepStatus` | Active |
| `render_dashboard` | `_handleRenderDashboard` | **DISABLED** — `"disabled pending sandbox hardening (T12421, mitigation 25263)"` |
| `patch_dashboard` | `_handlePatchDashboard` | **DISABLED** — same sandbox hardening gate |
| `read_dashboard` | `_handleReadDashboard` | Active |
| `request_network_access` | `_handleRequestNetworkAccess` | Active |
| `request_host_access` | `_handleRequestHostAccess` | Active |

**Delegator** (multi-agent orchestration, also in `RNn` table):

| Tool | Handler | Description |
|------|---------|-------------|
| `delegate_to` | `_handleDelegation` | Delegate task to another agent |
| `delegate_subtask` | `_handleSubtaskDelegation` | Spawn a subtask to an agent |
| `stop_child` | `_handleStopChild` | Stop a child agent |
| `wait_for_notification` | `_handleWaitForNotification` | Wait for async notification from child |

All brain tools are collected in the `L$n` array as Anthropic-format tool schemas (with `input_schema`).

#### Compute Tools (`u3e` array, with `parameters` + `handler`)

| Tool | Variable | Description |
|------|----------|-------------|
| `bash` | `LPn` | Shell command execution |
| `python` | `FPn` | Python code execution (via `I5e()`) |
| `r` | `UPn` | R code execution |
| `save_artifacts` | `t6n` | Save output artifacts |
| `manage_environments` | `d6n` | Manage compute environments |
| `manage_packages` | `f6n` | Manage installed packages |
| `fetch_article_fulltext` | `N6n` | Fetch full text of a web article |

Special handling set `SNn`: `python`, `r`, `manage_environments`, `manage_packages`.

#### Dynamic Tool

| Tool | Description |
|------|-------------|
| `skill` | Dynamically built via `Z0()`, pushed into `_computeTools`. Handled in both `_executeLocalTool` and `_executeComputeTool` |

#### Internal LLM Tools (not model-facing — forced `tool_choice` in internal calls)

| Tool | Variable | Purpose |
|------|----------|---------|
| `report_input_files` | `hNn` | Identify all input files read during code generation |
| `select_relevant_inputs` | `mNn` | Select which inputs contributed to outputs |
| `summarize_conversation` | `zer`/`vvn()` | Context compaction / conversation summarization |
| `create_work_item` | `Izn` | Create structured work items from context |

These are never exposed to the user-facing model. They are used by Operon internally with forced `tool_choice:{type:"tool",name:"..."}`.

#### Anthropic API Built-in Tool

| Tool | Type ID | Gating |
|------|---------|--------|
| `web_search` | `web_search_20250305` | `enable_web_search` flag |

Not an MCP or Operon tool — passed directly in the API request as `{type:"web_search_20250305",name:"web_search"}`. Referenced in the `Nzn` exclusion set: `new Set([...u3e.map(t=>t.name),"skill","request_network_access","request_host_access","tool_search_tool_regex","code_execution","web_search","web_fetch"])`.

#### Cowork Command (not a standard tool)

| Name | Description | Scope |
|------|-------------|-------|
| `context` | Show what's using your context window | `cowork` |

Defined in `ODt` array alongside `AskUserQuestion` and `ExitPlanMode`. UI command, not a tool-use tool.

### Operon Sub-Interfaces (v1.1617.0)

33 sub-interfaces (unchanged from v1.1348.0):

`OperonAgentConfig`, `OperonAgents`, `OperonAnalytics`, `OperonAnnotations`, `OperonApiKeys`, `OperonArtifactDownloads`, `OperonArtifacts`, `OperonAssembly`, `OperonAttachments`, `OperonBootstrap`, `OperonCloud`, `OperonConversations`, `OperonDesktop` (**new**), `OperonEvents`, `OperonExportBundle`, `OperonFolders`, `OperonFrames`, `OperonHostAccess`, `OperonHostAccessProvider`, `OperonImageProvider`, `OperonMcp`, `OperonMcpToolAccessProvider` (**new**), `OperonNotes`, `OperonPreferences`, `OperonProjects`, `OperonQuitHandler`, `OperonReplay`, `OperonSDK`, `OperonSecrets`, `OperonServices`, `OperonSessionManager`, `OperonSkills`, `OperonSkillsSync`, `OperonSystem`

### Features we do NOT enable

| Feature | Reason |
|---------|--------|
| `nativeQuickEntry` | Requires macOS Swift code |
| `quickEntryDictation` | Requires macOS Swift code |
| `plushRaccoon` | Dictation shortcut, macOS-only |
| `wakeScheduler` | Requires macOS Login Items API + macOS >= 13.0 |
| `framebufferPreview` | Dev-only (PM() gate) |
| `iosSimulator` | Dev-only + macOS-only |
| `androidEmulator` | Dev-only + macOS-only |
| `grandPrix` | macOS-only, requires connected device pairs |
| `tearOffHalo` | macOS >= 13 only, uses `@ant/claude-swift` |
| `grandPrixRequest` | macOS-only, requires GrandPrix service |
| `bootstrapConfig` | Dev-only (PM() gate) |
| ~~`coworkArtifacts`~~ | Follows server rollout on Linux (no platform gate; force retired 2026-07-13, .jsonc opt-in `2940196192`; the merger override list never included cowork* keys) (**new in v1.3883.0**) |
| ~~`coworkKappa`~~ | Follows server rollout on Linux (no platform gate; force retired 2026-07-13, .jsonc opt-in `123929380`; the merger override list never included cowork* keys) |

### Known Issues (v1.3883.0)

No known issues. Computer-use is fully integrated into `index.js` since v1.1.8359 and working on Linux.

## Debugging Feature Flags

### Check if a feature is reaching the renderer

In the renderer DevTools console:
```javascript
// Features are sent via IPC - check what the renderer received
// Look for the feature-flags IPC channel in the Network/IPC tab
```

### Verify tse patch applied correctly

```bash
# After patching, search for the override string
rg 'quietPenguin:\{status:"supported"\}' /path/to/index.js
```

### Pattern anchor stability

Feature name strings are stable across versions because they're IPC identifiers used by both main and renderer processes. The `yukonSilverGems:await \w+\(\)` pattern uses the feature name as anchor and `\w+` for the minified function name.

### When updating for new versions

1. Check if `SIA` structure changed (new features added, order changed)
2. Check if PM()-wrapped features changed
3. Verify feature name strings haven't been renamed (unlikely - they're IPC contracts)
4. Test with `./scripts/validate-patches.sh`

## Version History

| Version | Static Registry | Async Merger | Gate Function | Notable Changes |
| v1.46388.2 | `OB()` (chunk `index.chunk-DrnJEXHK.js`) | `WSn(e)`, anchor `return{...OB(),...m}}` | `SB()` | **Bump v1.40609.0 -> v1.46388.2 (re-minify; `.vite/build` chunk families 85+52 -> 158+0 - the `index2.chunk-*` family is gone, everything is `index.chunk-*` again; the minifier emits plain double-quoted string literals again instead of backticks).** Registry `iB()` -> `OB()`, yukonSilver hoist `usn()` -> `cSn()`, maturity post-processor `Hsn()` -> `USn()` (beta list `Ian` -> `fbn`, still just `surfaceTogglesPreview`), supported const `tB` -> `CB`, production gate `eB()` -> `SB()`, 5s-delay helper `aB` -> `kB`, yukon+delay helper `Asn` -> `jSn`, async merger `oB(e)` -> `WSn(e)`. Merger override object stays 13 keys but swaps two: `epitaxyMcpApps` (now static `CB`, flag `3516166472` deleted) and `chillingSlothSshWorktreeLocation` (now static `Ixn()`, flag `1315974108` deleted) out; `sideSessions` (`kB(()=>wS("2371478310"))`) and `wslForkSession` (`kB(_bn)` -> `wS("3724674924")`) in. Static registry 64 -> 71 (+`codeSessionKeepAwake`, `computerUseComplianceGate`, `popoutTitleBarOverlay`, `multiAccount`, `sessionMentions`, `sideSessions`, `wslForkSession`); Zod schema `N$e` 65 -> 72 keys. GrowthBook chunk `index.chunk-Ci77nY41.js` -> `index.chunk-DrnJEXHK.js`; readers `HS`/`.yC` -> `wS`/`.aD` (boolean), `US`/`.bC` -> `TS`/`.oD`, `VS`/`.gC` -> `CS`/`.nD`, `KS`/`._C` -> `OS`/`.rD`, `IS`/`.CC` -> `vS`/`.lD`, `LS`/`.SC` -> `yS`/`.cD`; features-store setter `ldt` -> `G_t` (store `vS` -> `eS`, tag `yS` -> `tS`, transform `idt` -> `B_t`). Flags: +53 store-consulted, -9 (`1032963206`, `1315974108`, `1598976391`, `2039376689`, `2724639973`, `3246569822`, `3326082604`, `3431784271`, `3516166472`); template 225 -> 291 including the 25 uncatalogued v1.40609.0 arrivals and the 3 v1.40609.0 removals. Deployment-key schema 120 -> 143 (`js/extra_settings_main.js` catalog 117 -> 143). enable_local_agent_mode: all 7 anchors match once, no edit. |
| v1.40609.0 | `iB()` (chunk `index.chunk-Ci77nY41.js`) | `oB(e)`, anchor ``return{...iB(),...p}}`` | `eB()` | **Bump v1.37937.0 -> v1.40609.0 (auto-released, audited retroactively with the v1.46388.2 bump; re-minify; chunk families 75+52 -> 85+52).** Registry `fB()` -> `iB()`, yukonSilver hoist `f3t()` -> `usn()`, post-processor `U3t()` -> `Hsn()` (beta list `f2t` -> `Ian`), supported const `lB` -> `tB`, gate `cB()` -> `eB()`, 5s-delay helper `pB` -> `aB`, merger `mB(e)` -> `oB(e)` (13 overrides, unchanged composition). Registry 62 -> 64 (+`spawnTaskInFlightIds`, `rubberDuck`, `popoutZoom`; -`builtinMcpPresets`); schema 63 -> 65. Readers `Xw`/`.Gx` -> `HS`/`.yC`, `Zw`/`.Kx` -> `US`/`.bC`, `Yw`/`.Hx` -> `VS`/`.gC`, `nT`/`.Ux` -> `KS`/`._C`, `Hw`/`.Yx` -> `IS`/`.CC`, `Uw`/`.Jx` -> `LS`/`.SC`; store setter `Dat` -> `ldt` (store `yw` -> `vS`, tag `bw` -> `yS`, transform `Cat` -> `idt`). Flags: +25 store-consulted (folder-access card/classifier pair `49458538`/`733405693` replacing `1421481645`, SSH/bridge kill-switch family, plugin sync module gates), -3 (`1030142136`, `1072565585`, `1421481645`). Deployment-key schema 117 -> 120. |
| v1.37937.0 | `fB()` (chunk `index.chunk-DkKx6nb2.js`) | `mB(e)`, anchor `return{...fB(),...p}}` | `cB()` | **Bump v1.34493.1 -> v1.37937.0 (re-minify; `.vite/build` chunk families 74+48 -> 75+52 files).** Registry `uR()` -> `fB()`, yukonSilver hoist `tZt()` -> `f3t()`, maturity post-processor `CZt()` -> `U3t()` (beta list `NYt` -> `f2t`, still just `surfaceTogglesPreview`), supported const `cR` -> `lB`, production gate `sR()` -> `cB()`, 5s-delay helper `dR` -> `pB`, yukon+delay helper `xZt` -> `j3t`. **The async merger is now parameterized** - `async function mB(e)`, where `e?.primeManagedPreviewPolicy` drives one extra non-destructured `Promise.all` slot. GrowthBook readers: boolean `Xw`/`.Gx`, boolean-with-default `Zw`/`.Kx`, value-with-default `Yw`/`.Hx`, keyed config `nT`/`.Ux`, listener `Hw`/`.Yx`; **3 new exports** - `peekFeatureGate` (`Pat`), `onGrowthBookNetworkFetch` (`tT`), `withGateRefresh` (`Vw`). Features-store setter `Fit` -> **`Dat(e,t){bw=t;let n=yw;yw=Cat(e);...}`** (store `yw`, source tag `bw`, transform `Cat`; the `"[growthbook] loaded %d features (%d changed)"` log-string anchor held). **Registry/schema: +4 / -1** - added `chillingSlothSshWorktreeLocation` (async override, flag `1315974108`), `sessionFolderFileAccess`, `spawnTaskPendingPop` (both always-supported, no gate) and `violinBowHomeSettings` (hardcoded unavailable); removed `parkaMeetings` (was dev-gated + macOS-13+, already inert on Linux). Static registry 59 -> 62, Zod schema `dqe` 60 -> 63 keys (still `.partial()`), merger overrides 10 -> 13. `bootstrapConfig` left the production gate; `surfaceTogglesPreview` entered it. **GrowthBook delta: +23 / -1** - 23 new store-consulted IDs (see the v1.37937.0 catalog section) plus 7 defaults-map-only; `3673327456` removed along with the entire host-tiered VM memory sizing mechanism. Template 203 -> 225. **enable_local_agent_mode applied clean** - all anchors single-match, all 6 override keys present in registry and schema; no patch edit. |
| v1.34493.1 | `uR()` (chunk `index.chunk-RiH_RK8u.js`) | `wZt`, anchor `return{...uR(),...l}}` | `sR()` | **Bump v1.32885.1 -> v1.34493.1 (re-minify; `.vite/build` chunk families 74+39 -> 74+48 files).** Registry `RH()` -> `uR()`, yukonSilver hoist `V2t()` -> `tZt()`, maturity post-processor `l4t()` -> `CZt()` (beta list `P0t` -> `NYt`, now a single entry `` [`surfaceTogglesPreview`] ``), async merger `u4t` -> `wZt`, production gate `IH()` -> `sR()` (shape unchanged), supported constant `LH` -> `cR`, yukonSilver-gated helper `s4t` -> `xZt`, delayed probe `zH` -> `dR`. **Features-store setter `Mit` -> `Fit(e,t){OS=t;let n=DS;DS=jit(e);...}`** (store `DS`, source tag `OS`; dirty flag REMOVED, stored map now runs through the deployment-mode hardcoded filter `jit(e)` inside the setter - `add_growthbook_overrides` was re-fitted to wrap the transform CALL instead of the raw parameter; log-string anchor held). Registry, merger, store and reader exports all in `index.chunk-RiH_RK8u.js`. Readers: bare `Iw`->**`XS`**, `Fw`->**`YS`**, `zw`->**`eC`**, `Aw`->**`WS`**, `Uit`->**`Yit`**, areFeaturesLoaded `Ew`->**`BS`**, observeFeatureGate `jw`->**`GS`**; dotted `.Ey`/`.Cy`/`.wy`/`.ky` -> **`.Sb`/`.yb`/`.bb`/`.Eb`** (isFeatureEnabledWithDefault dotted **`.Cb`** - new, observeFeatureGate dotted **`.Tb`**). **Registry/schema: +2 features** - `violinBow` (static unavailable + merger override `dR(UYt)` with `UYt(){return!1}`, i.e. hardcoded off everywhere) and `coworkThinkingInSend` (static always-supported, no gate); nothing removed. Static registry 57 -> 59; Zod schema 58 -> 60 keys, still `.partial()`. Merger 9 -> 10 overrides. **GrowthBook delta: +14 / -2** - new store-consulted: `36693946`, `40173473` (CU gate-reconcile listener + win32 CU sub-gate), `657187776` (transcript-lease disable), `816856638` (SSH daemon upgrade-deferral disable), `885442848` (hosted-Chrome-bridge first_party), `1710585411` (office-bridge trigger-context suppression), `1904135164` (plugin download moveExistingAside, default ON), `2048589233` (thinkingSummaryOnDemand, default ON), `2806360886` (folder-access kill-switch), `2864556627` (Artifact host-tools capability), `3093186863`/`4114957886` (SSH reattach kill-switch + default), `3183093548` (plugin scan-hidden stubs, default ON); plus defaults-map-only `2722545484` (not templated). Removed: `235864698` (boot-window disable latch) and defaults-map-only `1420323440`. Template 191 -> 203 (`CATALOG_EXPECTED` bumped). **enable_local_agent_mode: no edit needed** - all 7 anchors matched, one match each; all 6 Patch 3 override keys present in the 59-entry registry and 60-key schema; CU chicago family (`2486083521` as `YWt`, `1291166712` as `GI`, `1346958739`) and buddy `2358734848` intact. |
| v1.32885.1 | `RH()` (chunk `index.chunk-CdfeLm1B.js`) | `u4t`, anchor `return{...RH(),...c}}` | `IH()` | **Bump v1.32352.1 -> v1.32885.1 (re-minify; `.vite/build` chunk families 74+38 -> 74+39 files).** Registry `JB()` -> `RH()` - the maturity post-processor is now called INLINE (`function RH(){let e=V2t();return l4t({launch:LH,...})}`, beta list `P0t`; yukonSilver hoist `e9t()` -> `V2t()`), post-processor `S9t()` -> `l4t()`, async merger `C9t` -> `u4t`, production gate `KB()` -> `IH(e){return o.app.isPackaged?{status:\`unavailable\`}:e()}`, supported constant `qB` -> `LH`. Features-store setter `qct` -> **`Mit(e){let t=gw;gw=e,_w=!0;...}`** (store `gw`, dirty `_w`; log-string anchor held, `add_growthbook_overrides` matched clean). Registry, merger, store and reader exports all in `index.chunk-CdfeLm1B.js`. Readers: bare `KE`->**`Iw`**, `GE`->**`Fw`**, `XE`->**`zw`**, `RE`->**`Aw`**, `$ct`->**`Uit`**, areFeaturesLoaded `PE`->**`Ew`**, observeFeatureGate `zE`->**`jw`**; dotted `.ty`/`.Qv`/`.$v`/`.iy` -> **`.Ey`/`.Cy`/`.wy`/`.ky`** (observeFeatureGate dotted `.Oy`). **Registry/schema: +1 feature `coworkSeededSummon`** (static always-supported `LH`, no gate, no flag), **-1 `bootPlaceholder`** (v1.30096.1 stub removed); Zod schema 57 -> 58 keys, still `.partial()`. Merger unchanged at 9 overrides (`ccdGitEngine`+`sessionPrOwnership` still share flag `959099749`, now via `zH(SH)`; helpers `YB`->`zH`, yukonSilver-gated `s4t`). **GrowthBook delta: +3 / -1** - `751369921` RENAMES `3001783682` (hybrid-detect latch, identical `PI(id,\`hybridDetectLatched\`,cb)` site), `2099281725` (ssh-launch-preconnect gate w/ failure backoff), `1477483922` (CCD gated-SDK-snapshot staleness list `qt`, observed via `.Oy`; snapshot gained a `chipLevel` field). Template 189 -> 191 (`CATALOG_EXPECTED` bumped). **enable_local_agent_mode: all 7 anchors present, one match each** (Patch 1 = `W2t` quietPenguin only; merger anchor unique); all 6 Patch 3 keys in registry + schema; no edit needed. |
| v1.32352.1 | `JB()` (chunk `index.chunk-BFWQf1ai.js`) | `C9t`, anchor `return{...JB(),...c}}` | `KB()` | **Bump v1.30096.1 -> v1.32352.1 (re-minify; chunk families 74+30 -> 74+38 files).** Registry `$V()` -> `JB()` (now hoists the yukonSilver status once: `let e=e9t()`), post-processor `u$t()` -> `S9t()`, async merger `nH` -> `C9t`, production gate `YV()` -> `KB(e){return o.app.isPackaged?{status:\`unavailable\`}:e()}`, supported constant `XV` -> `qB`. Features-store setter `KMt` -> **`qct(e){let t=bE;bE=e,xE=!0;...}`** (store `bE`, dirty `xE`; log-string anchor held, `add_growthbook_overrides` matched clean). Registry, merger, store and reader exports all in `index.chunk-BFWQf1ai.js`. Readers: bare boolean `AI` -> **`KE`**, value-with-default `kI` -> **`GE`**, keyed `NI` -> **`XE`**, listener `wI` -> **`RE`**; dotted `.Qu`/`.Yu`/`.Xu`/`.td` -> **`.ty`/`.Qv`/`.$v`/`.iy`**; NEW exports `isFeatureEnabledWithDefault` (**`$ct(id,dflt)`**), `isGrowthBookFreshForCurrentAccount`, `onGrowthBookFreshChange`. **Registry/schema: +1 feature `sessionPrOwnership`** (static unavailable + async override SHARING ccdGitEngine's slot: `ccdGitEngine:s,sessionPrOwnership:s`, both gated by flag `959099749` via `YB(jB)`); merger 8 -> 9 override keys; Zod schema 56 -> 57 keys, still `.partial()`. **GrowthBook delta: +21 / -0** - rc-serve renderer heap-report trio (`1183214304`/`3764441751`/`1410651677` value), SSH transport pair (`291584251` force-ssh2 kill-switch, `3946462706` default-to-OpenSSH), device-registry server-time pair (`1310358601`/`2214981414`), remote-tools-device pair (`732695530`, `2216766246` interval value) + bridge URL shape (`3640318556`), local MCP manager pair (`3018088575` default-ON via `$ct`, `3961433847`), browser-tools mouse-guard kill-switch (`1278239935`), quit-interrupt resume gate (`1743527783`), worktree checkout-mode value (`1754160972`), stable-device-id session seeding (`2220415149`), boot-window disable latch (`235864698` -> `mainViewBootWindowDisabled` pref), EventLogging flush-interval listener (`2654621331`), born-hidden watchdog kill-switch (`3326082604`), Cowork VM `sizedToHost` memory sizing (`3673327456`), PreviewOriginPolicy disable (`919579692`). Nothing removed - but the minifier now emits large numeric object keys UNQUOTED, so a quoted-literal-only sweep falsely reports the 16 3p-defaults-map-only IDs as removed; sweep `[,{(]\d{6,10}:` keys too. Template 168 -> 189 (`CATALOG_EXPECTED` bumped). **enable_local_agent_mode: all 7 anchors present, one match each** (Patch 1 = `r9t` quietPenguin only; merger anchor unique); all 6 Patch 3 keys in registry + schema; no edit needed. |
| v1.30096.1 | `$V()` (was `X()`; now in the `index.chunk-*` family) | `nH`, anchor `return{...$V(),...c}}` | `YV()` | **Bump v1.28929.0 -> v1.30096.1 (re-minify + a chunking change: the `index*.chunk-*` families shrank 209+130 -> 74+30 files at the same ~20 MB total, so a lot of code moved between chunks — the static registry moved from `index2.chunk-*` into `index.chunk-*`).** Registry `X()` -> `$V()`, post-processor `Ue()` -> `u$t()`, async merger `We` -> `nH`, production gate -> `YV(e){return o.app.isPackaged?{status:"unavailable"}:e()}`. Features-store setter `Gk` -> **`KMt(e){let t=dI;dI=e,fI=!0;...}`** (store `dI`, dirty `fI`, chunk `index.chunk-BzNP_oYx.js`; the `"[growthbook] loaded %d features (%d changed)"` log-string anchor held, so `add_growthbook_overrides` matched clean). **The GrowthBook chunk now exports readers under readable names** (`e.r({areFeaturesLoaded:()=>$Mt,getFeatureValue:()=>kI,getParsedFeatureValueForKey:()=>NI,isFeatureEnabled:()=>AI,onFeatureChange:()=>wI,observeFeatureGate:()=>TI,waitForGrowthBookReady:()=>xI,...})`), so the reader identity is greppable without guessing: boolean `AI(id)` / dotted `.Yt` -> **`.Qu`**, value-with-default `kI(id,dflt)` / `.Gt` -> **`.Yu`**, keyed config value `NI(id,key,dflt,zodType)` / `.Kt` -> **`.Xu`**, listener `wI(id,cb)` / `.Qt`,`.$t` -> **`.td`**. **Registry/schema: +1 feature** — `bootPlaceholder` (static, hardcoded `{status:"unsupported", reason:"Boot placeholder not built in"}`; no flag, no platform gate); Zod schema 55 -> 56 keys, still `.partial()`. Merger unchanged at 8 overrides (`louderPenguin`, `coworkKappa` `123929380`, `coworkArtifacts` `2940196192`, `coworkAutoModeAlwaysAllowOverride` `4200321681`, `epitaxyMcpApps` `3516166472`, `coworkWatchRecord`, `coworkWatchers`, `ccdGitEngine`). **GrowthBook delta: +2 / -0** — `1942337209` (local MCP client protocol version-negotiation kill-switch) and `3671534883` (3p deployment-defaults-map entry only, never read in the main process — not templated, consistent with the other defaults-map-only IDs). Nothing removed: all 167 previously catalogued IDs are still present. Template 167 -> 168 (`CATALOG_EXPECTED` bumped to match). **enable_local_agent_mode: all 7 anchors present** and applied clean without a pattern fix; the only edit was dropping the vestigial `chillingSlothPool` override key (feature gone since v1.28929.0), so Patch 3 now injects 6 keys. **Caveat for future audits:** the orchestrator stages `index*.chunk-*`, i.e. BOTH chunk families — an audit concat built from `index.chunk-*` alone silently misses whatever currently lives in `index2.chunk-*` and produces a bogus added/removed flag diff. |
| v1.28929.0 | `X()` (name held; chunk `index2.chunk-C6fzqxmc.js`) | `We`, anchor `return{...X(),...l}}` (held) | - | **Bump v1.26832.0 -> v1.28929.0 (re-minify on the backtick minifier; chunk hashes rolled).** Features-store setter now `Gk(e){let t=xk;xk=e,Sk=!0;...}` (was `tS`/`Mx`/`Nx`; log-string anchor held), boolean reader `.Zt` -> `.Yt`, with-default `.qt` -> `.Gt`, keyed value `.Kt`, listeners `.Qt`/`.$t`. **Registry/schema: -3 features** (`chillingSlothPool` - flag `1992087837` survives as the worktree warm-pool gate; `deterministicCreatePr` - also lost its merger slot; `chorusIn3p`) **+2** (`ccdGitEngine` static-unavailable + async override via NEW-to-catalog flag `959099749`; `sshAttachmentTransport` always supported); Zod schema 56 -> 55 keys. Merger still 8 overrides - `deterministicCreatePr` slot became `ccdGitEngine`. **Doc correction:** the v1.26832.0 bundle already had 8 merger overrides (incl. `coworkAutoModeAlwaysAllowOverride` `4200321681`, `coworkWatchers`) and `launch` already static - the prior row's "6 overrides incl. launch" description was stale. **GrowthBook delta: +7 / -6** - added `1072565585` (newChatPageLaunchGate latch), `1346958739` (chicago macOS version floor, value), `3001783682` (hybrid account detection), `3424551112` (autoMode permission rule sets into session opts), `3448679706` (session-config gate, RENAMES `130970054`), `3547093683` (remote-tools JIT poll minutes, value), `721728391` (inference routing via org policy backend); removed `1129583249`, `115713051`, `130970054` (-> `3448679706`), `1311049725`, `2349950458`, `2678393595` (superseded by coworkWatchers). Template refresh: -8 (4 removed + 4 stale-since-v1.26832.0: `1953041099`, `2438134137`, `2976814254`, `3214976288`) +30 (7 new + 23 newly catalogued hoisted-const flags) = 145 -> 167; `CATALOG_EXPECTED` 134 -> 167 (had been stale since the v1.26832.0 refresh - runtime drift diag was firing). enable_local_agent_mode: all 7 anchors present (quietPenguin gate x1, yukonSilver linux->unix guard, merger anchor, SSH resolver guard, prefs defaults x1, unspoofed header) - `chillingSlothPool` override key now vestigial-but-harmless (non-strict zod, verified). CU: platform Set + chicago family intact (`2486083521` x2, hoisted; chicago enable reads chicago_config `1291166712.enabled`, default false); buddy `2358734848` x1. NO native Linux CU executor. |
| v1.26832.0 | `X()` (module-scoped) | merger anchor `return{...X(),...l}}` | - | **Bump v1.24012.11 -> v1.26832.0 (MINIFIER/BUNDLER SWITCH; issue #218).** Not a normal re-minify: string literals became BACKTICK template literals (`` platform===`darwin` ``, log strings `` `[growthbook] loaded %d features (%d changed)` ``), `const`->`let`, no `"use strict"` prologue, second chunk family `index2.chunk-*.js` (orchestrator stages both). All flag-anchored patterns re-fitted quote-tolerant (`` ["`] ``). Features-store **setter now `tS(e){let t=Mx;Mx=e,Nx=!0;...}`** (store `Mx`, dirty `Nx`; log-string anchor held). Flag readers are now dotted module-qualified calls: boolean `X.Zt(id)`, with-default `X.qt(id,dflt)`, variant `X.Jt(id,...)`. Static registry still leads `artifactsPane:`/`nativeQuickEntry:` (zod shape `pa=t.b({...})`). **GrowthBook delta: +14 / -4** store-consulted flags - added `262787483` (OTLP content-capture merge), `850702611` (turn restage), `959099749` (startup probe batch), `1032963206`/`2039376689` (CliGovernor throttle/pressure-eviction), `1221293892` (renderer crash-loop watchdog, app.exit after 20 crashes/60s), `2678393595` (git-status impl switch), `3046457088` (cowork taskRunFinished permission routing), `3123045134` (resolveCloudBranch), `3414805749` (worktree sweep skip), `3436441689` (file-access prompt admin policy), `3990395613` (branch-deltas co-gate), `4185841952` (work-session group summary config, value flag), `4202409342` (tool gate w/ mdmAutoModeDisabled); removed `1076115445`, `2246535838` (local: MCP prefix), `3602524236` (isOpenInDefaultAppEnabled preview), `4274871493` (pluginEnabledState). Template 134 -> 144. CU platform Set still `new Set([`darwin`,`win32`])` x1 - NO native Linux CU executor. Capability map `status:unavailable` unchanged at 36. No feature upstreamed, no patch removed (45 held). |
| v1.21459.0 | `Ku()` (name held) | `Uae` (held) | - | **Bump v1.20186.1 -> v1.21459.0 (full re-minify; code-split grew 82 -> 85 chunks).** Mechanical bump for flags. Key rename: features-store **setter `hTt` -> `HVe`** (store var `lf` -> `Ys`, dirty flag `CS`; still anchored by the log string `"[growthbook] loaded %d features (%d changed)"` so `add_growthbook_overrides` matched clean), flag reader `At()` -> `ht()` (small-chunk alias `isFeatureEnabled()` unchanged). Merger override object still 6 keys. **GrowthBook delta: +10 / -0** store-consulted flags — added `1061122496` (worktree destroy), `1129583249` (branch-switch conflict), `1480778051` (render_rss_bytes telemetry suppression), `1924247864` (device-registry gate), `1953041099` (skill text override, value flag), `2745857735` (LAM home-directories folder access), `2961849615` (revive CCD after relogin), `3214976288` ("morning" prompt), `3431784271` (plugin backfill prune), `3976799455` (away-recap) — all added to the overrides template (124 -> 134); none removed; `2486083521` (CU chicago) read one extra time but stays patch-forced (excluded from template). enable_local_agent_mode: NO gaps — all 7 anchors verified, merger anchor `return{...Ku(),...s}}` present, forced/guarded IDs intact (`2486083521` x2, `2358734848` x1). Computer Use still `new Set(["darwin","win32"])` x1 — upstream ships NO native Linux CU executor. Capability map unchanged. **Feature upstreamed:** `fix_cli_governor_memavailable` **removed** — Anthropic added native `LinuxAvailableMemoryRatioReader` reading `/proc/meminfo` MemAvailable (closes #128 natively), so nothing left to inject. Same-day policy change retired all pure assert-only guards: also removed `fix_enterprise_config_linux`, `fix_enterprise_config_linux_pre`, `fix_native_frame_renderer` (41 -> 37 patches). Only active patch touched: `fix_computer_use_linux` 13e re-fitted (open_application description reworded; Linux allowlist ternary re-anchored). agent-sdk 0.3.205 -> 0.3.209. |
| v1.20186.1 | `Ku()` | `Uae` | - | **Bump v1.19367.0 -> v1.20186.1 (full re-minify; code-split grew ~45 -> 82 chunks).** Function renames (big-chunk namespace): registry `yh()`->`Ku()` (registry now leads with `artifactsPane:` then `nativeQuickEntry:`), async merger `_Be`->`Uae`, flag reader `rt()`->`At()`, chillingSlothFeat getter `Rot()`->`tCe()`; `maturity:"beta"` post-processor list unchanged (`["chatTab","surfaceTogglesPreview","chatCodeExecution"]`, loop var `wZt`). **Merger override object 5 -> 6 keys: new `launch` override** (`Oae()` = `At("2976814254")\|\|!1`, claudePreview/launch-server; already force-ON via enable_local_agent_mode Patch 3j — lands supported on Linux, no new work). **GrowthBook delta: +1 / -1** (added `3602629573` JitlessPolicy process kill-switch; removed `1295378343` gapSurviveEnabled/stdinOffset — dropped from overrides template). enable_local_agent_mode: NO gaps — all anchors verified (darwin-gate fns 4, yukonSilver guard, merger anchor `return{...Ku(),...s}}`, SSH guard, prefs + header-unspoofed), all 17 actively-forced IDs present. Imagine flags: `3444158716` unchanged but reader shape now `X.isFeatureEnabled("...")` member call (fix_imagine Patch B regex widened to dotted callees). `manta=off` literal + `dramatic_shrimp` capability unchanged (issue-186 state holds). Capability map identical at 41 keys (platform-gate audit clean). **Same-day follow-up:** the 12 LAM rollout-bypass flag forces (Patches 3b-3p) and fix_imagine_linux (3444158716/3516166472) were RETIRED - all store-covered, none platform-gated, users opt in via .jsonc growthbookOverrides; enable_local_agent_mode EXPECTED_PATCHES 19 -> 7; remaining forces are only the platform-conditional ones (CU chicago 2486083521, buddy 2358734848) plus Patch 3's capability overrides. |
| v1.19367.0 | `yh()` | `_Be` | `NA()` | **Bump v1.18286.2 -> v1.19367.0: bundle CODE-SPLIT** (index.js -> 773-byte stub + ~45 content-hashed `index.chunk-*.js`; `index.pre.js` grew to 4.5MB and is the package.json `main`). **Minified names are now PER-CHUNK** - the flag reader is `rt()` in the big chunk (`index.chunk-CNXUb5h4.js`-era hash) but `isFeatureEnabled()` in 4 smaller chunks; never assume one canonical name. Function renames (big-chunk namespace): registry `sM()`->`yh()`, async merger `Yue`->`_Be`, dev-gate `LM()`->`NA()` (electron var `sA`->`G`), supported-constant `Ed`->`ul`; helpers `p6e`->`Mot` (yukonSilver-then-flag), `Pue`->`wBe` (epitaxyMcpApps), `wen`->`zvn` (louderPenguin), `Den`->`Vvn` (coworkWatchRecord); gate fns quietPenguin inner `Hvn` (still darwin\|\|win32), computerUse `Wvn()`/checker `I1()`/Set `Zoe` (still `new Set(["darwin","win32"])`), yukonSilver `gBe()`, Gems/GemsCache `Pot()`, chillingSlothFeat+SshShell shared `Rot()`, watchRecord `uQt()` (darwin-only), coworkKappa `Xvn()`, coworkArtifacts `eAn()`, force-ON defaults map `rDr`. **NEW: registry post-processor `tAn()`** stamps `maturity:"beta"` on supported `mvn=["chatTab","surfaceTogglesPreview","chatCodeExecution"]` (cosmetic). **+1 static feature `coworkScheduledTaskProjects`** (always supported `ul`, in Zod schema) -> 42 schema keys; none removed. Merger shape unchanged (5 overrides + 6th `ct().overlayApplied()` slot). **GrowthBook delta: +3 / -0** (`1544796833` session-concurrency value config, `2016258596` device-tool artifact read gate, `416245092` GPU crash-streak marker default-ON); louderPenguin still `4116586025`. All 13 active forced flag IDs have IDENTICAL old-vs-new counts; `1496676413` still absent (reappearance guard holds); imagine IDs `3444158716`/`3516166472`, chicago `2486083521`, spaceMemoryBridge `1197768857` all present at same counts. `manta=off` literal + `dramatic_shrimp` my-access capability unchanged (issue-186 state holds). No new force-ON entries needed. |
| v1.18286.0 | `sM()` | `Yue` | `LM()` | **Bump v1.17377.2 -> v1.18286.0 (full re-minify; v1.17377.x had kept the v1.17282 names).** Function renames: registry `xR()`->`sM()`, async merger `X0A`->`Yue`, flag reader `et()`->`rt()`; helpers `W3e`->`p6e` (yukonSilver-then-flag), `kge`->`Pue` (epitaxyMcpApps), `cZi`->`wen` (louderPenguin), `lZi`->`Den` (coworkWatchRecord). Merger shape unchanged (`n={louderPenguin:A,coworkKappa:e,coworkArtifacts:t,epitaxyMcpApps:r,coworkWatchRecord:i};return{...sM(),...n}`). **GrowthBook delta: +8 / -4.** Added: `17519066` (external-browser URL block), `1972091654` (askClaude device RPC), `2229805612` (remote_control_at_startup default), `2309422447` (mergeMessageBufferIfActive), `2795002549` (Projects OAuth scopes), `3602524236` (isOpenInDefaultAppEnabled file preview), `4034153053` (isEpitaxyPreviewEnabled, gated on native support probe), `4293378213` (device-app tools, inert: `&&!1`). None gates a cowork/code/Linux surface - no forcing needed. Removed: `1496676413` (SSH remote MCP/plugin passthrough -> **unconditional**, no replacement: `createSpawnFunction` lost the flag arg, `resolveSshControllerForMcp` unconditional -> **enable_local_agent_mode Patch 3n deleted**, EXPECTED_PATCHES 20->19 + reappearance guard), `1609612026` (marketplace download/backfill -> unconditional), `1997559319` (onUserDialog refusal fallback -> unconditional), `3792010343` (CCD tool-use summaries dropped; env reads only `66187241`). All 13 remaining forced flag IDs present with healthy counts; Patch 1b yukonSilver guard, 7-key merger override, preferences defaults, and header-unspoofed guard all verified. **CU gate family refactor** (fix_computer_use_linux Patches 6/11/12 re-anchored): old isEnabled/rj pair merged into `wS()` (pref-respecting) / `bue()` (flag `2486083521`-gated, pref-ignoring; flag pre-existing) / `dq()` (stub-mode nudge); `handleToolCall` body extracted into `vgn()` with teach-mode telemetry; wrapper gained an AbortController `setTimeout`. Platform set still `new Set(["darwin","win32"])`. |
| v1.17282.0 | `xR()` | `X0A` | `LM()` | **Bump v1.15962.x -> v1.17282.0 (full re-minify + feature churn).** Function renames: registry `QR()`->`xR()`, async merger fn `HSA`->`X0A`, flag reader `it()`->`et()`; dev-gate `gM()`->`LM()` (`function LM(A){return sA.app.isPackaged?{status:"unavailable"}:A()}`, electron var `aA`->`sA`); supported-constant `AB`->`Ed`. Gate-fn renames: yukonSilver `Uae()`->`Nge()`, yukonSilverGems `T3e()`->`j3e()`, coworkKappa `O6r()`->`BZi()`, coworkArtifacts `x6r()`->`QZi()`, artifactsPane `Fae()`->`vge()`, chillingSlothFeat `y6r()`->`V3e()`. **Registry: +`chillingSlothSshShell` (`V3e()` -> `{status:"supported"}`, no gate; same getter as `chillingSlothFeat`, which lost its darwin/win32 gate), +`coworkWatchRecord` (`yHt()`, darwin-only -> unsupported on Linux; async override in `X0A`), +`spaceMemoryBridge` (`et("1197768857")?Ed:{status:"unavailable"}`, GrowthBook-gated, no platform check); -`markTaskComplete` (REMOVED — gone from registry, merger, Zod schema, and force-ON defaults map).** Async merger now `n={louderPenguin:A,coworkKappa:e,coworkArtifacts:t,epitaxyMcpApps:r,coworkWatchRecord:i};return{...xR(),...n}` (5 overrides; `markTaskComplete:i` slot dropped, `coworkWatchRecord` added; a 6th `Promise.all` slot `pt().overlayApplied()` is consumed separately). **GrowthBook delta:** 7 added (`1197768857` spaceMemoryBridge; `1295378343` `gapSurviveEnabled` value flag, default OFF; `130970054`; `1569828280` binary-asset-fetch gate; `2431502897` model-policy map entry; `3778159589` device-stale-relogin; `629684104` assistant-error-recovery), 5 removed (`1802019210` cowork plugin upload migration; `1985784543`; `3110209724`; `3732274605` markTaskComplete; `4018578026`). **No new force-ON entries needed** — none of the new features is mandatory for Linux, and `coworkWatchRecord` is macOS-only (must NOT be force-enabled on Linux). `enable_local_agent_mode.nim` left unchanged; its `markTaskComplete` override/force-ON (Patch 3e) is now a vestigial no-op targeting the removed feature/flag. |
| v1.15962.0 | `QR()` | `HSA` | `gM()` | **Bump v1.15200.0 -> v1.15962.0 (full re-minify).** Routine re-minify; **no new/removed static features**, merger shape unchanged (`n={louderPenguin:A,coworkKappa:e,coworkArtifacts:t,markTaskComplete:i,epitaxyMcpApps:r};return{...QR(),...n}`, 6-slot `Promise.all` with the 6th `yt().overlayApplied()` as before). Function renames: registry `z_()`->`QR()`, async merger `yDA`->`HSA`, dev-gate `HR()`->`gM()` (`function gM(A){return aA.app.isPackaged?{status:"unavailable"}:A()}`, electron var `aA` unchanged), flag reader `nt()`->`it()` (storage `Zf`->`Ih`). **Cowork (`yukonSilver`) support fn renamed `$oe()`->`Uae()`** (delegate chain + leading `var r,n;` hoist retained - `enable_local_agent_mode.nim` Patch 1b's `nhPatternZce` still matches; Patch 1's sole gate fn is now `M6r()`). **GrowthBook delta:** 4 added (`144158705` LAM remote folder-access consent network call; `3377630395` overlay/window mount toggle; `3531779070` agent-mode `thinking-display:"summarized"` CLI arg; `3555657854` org-scoped plugin-bridge MCP config loading), 1 removed (`2232207471` CLI governor session cap). None of the new flags is darwin/win32-gated or gates a cowork/code/dispatch/skill surface -> no forcing needed, override list unchanged. All 15 forced flag IDs + all 12 merger override feature names still present; `enable_local_agent_mode.nim` all anchors match (24/24 + mainmodule). **3 patches fixed for re-minify drift** (`fix_quick_entry_cli_toggle` focus-branch call gained an arg; `fix_window_bounds` new post-`MAIN_WINDOW` setup call; `fix_cowork_linux` Patch G smol-bin gate wrapped in a GrowthBook-await comma-expr) -> 49 index.js patches, all apply. `.electron-version` stays 42.0.0. |
| v1.15200.0 | `z_()` | `yDA` | `HR()` | **Bump v1.14271.0 -> v1.15200.0 (full re-minify).** Routine re-minify; **no new/removed static features**, merger shape unchanged (`n={louderPenguin:A,coworkKappa:e,coworkArtifacts:t,markTaskComplete:i,epitaxyMcpApps:r};return{...z_(),...n}`). Function renames: registry `D_()`->`z_()`, async merger `PwA`->`yDA` (`const yDA=async()=>{const[A,e,t,i,r]=await Promise.all(...)}`), dev-gate `pR()`->`HR()` (`function HR(A){return aA.app.isPackaged?{status:"unavailable"}:A()}`, electron var `sA`->`aA`), flag reader now `nt()`. **Cowork (`yukonSilver`) support fn renamed `hre()`->`$oe()`** and gained a leading `var r,n;` hoist before the `const A=...` delegate chain - `enable_local_agent_mode.nim` Patch 1b's `nhPatternZce` updated to allow the optional `var <ids>;` (Linux early-return injected before the hoist; vars unused on Linux path, harmless); all 25 sub-patches apply. **GrowthBook delta:** 3 added (`2051751800` Chrome permission-mode `skip_all_permission_checks` resolver gate; `2726556121` SSH file-transfer fast-path *disable* gate - guarded `!nt(...)`; `3982397363` stale-model-clear robustness toggle), 0 removed. None gates a cowork/code/dispatch/skill surface -> no forcing needed, override list unchanged. All 15 forced flag IDs + all 12 merger override feature names still present. **1 patch fixed for re-minify drift** (`enable_local_agent_mode` yukonSilver `var` hoist) + `fix_enterprise_config_linux` ("Enterprise config loaded" log renamed to "Managed config loaded", nested redact arg `yXA(zJ(l))`) -> 52 patches, all apply. Plus a build-script fix: node-pty 1.2.0-beta.13 dropped the `build/Release/` dir for a `prebuilds/` layout, so `build-patched-tarball.sh` now `mkdir -p`s the dest. |
| v1.14271.0 | `D_()` | `PwA` | `pR()` | **Bump v1.13576.4 -> v1.14271.0 (~700 builds, full re-minify).** Routine re-minify; **no new/removed static features**, merger shape unchanged (`n={louderPenguin:A,coworkKappa:e,coworkArtifacts:t,markTaskComplete:i,epitaxyMcpApps:r};return{...D_(),...n}`). Function renames: registry `nR()`->`D_()` (was `sR()` at v1.13576.0; the `.4` build had already re-minified to `nR()`), dev-gate `eM()`->`pR()` (electron var `lA`->`sA`), flag reader `dt()`->`ot()` (storage `Qh`->`Uf`). **GrowthBook delta:** 2 added (`1947305033` gates `create_artifact`/`update_artifact` tools - "...not enabled on this device" + `gate_off` telemetry; `2438134137` Figma/design OAuth `user:design:read user:design:write` scope expansion), 0 removed. Neither new flag is darwin/win32-gated -> no Linux impact, no forcing needed. `enable_local_agent_mode.nim` override list + all 25 sub-patches match unchanged; the patch overrides at the merger level (no embedded Zod schema to revalidate). All 12 merger override feature names still present. **2 patches fixed for re-minify drift** (`fix_cowork_linux` C2 deref-var backreference `r`->`i`; `fix_browser_tools_linux` 3 sub-patches rewritten for a real native-host install refactor) -> 51 patches, all apply. |
| v1.13576.0 | `sR()` | `c0A` | `rM()` | **Major bump v1.12603.1 -> v1.13576.0 (~970 builds, full re-minify).** **2 new static features:** `iosSimulatorH264:rM(GYA)` and `quickEntryGlobalShortcut:g3i()` -> **39 static + `louderPenguin` async-only + 4 other async (`coworkKappa`/`coworkArtifacts`/`markTaskComplete`/`epitaxyMcpApps`) = 44 total**; no features removed. Async merger shape unchanged (`{...sR(),louderPenguin:A,coworkKappa:e,coworkArtifacts:t,markTaskComplete:r,epitaxyMcpApps:i}`). Function renames: registry `aD()`->`sR()`, merger `fSA`->`c0A`, dev-gate `vR()`->`rM()` (`function rM(A){return lA.app.isPackaged?{status:"unavailable"}:A()}`, electron var `cA`->`lA`), flag reader `dt()`->`Ct()`. **Cowork (`yukonSilver`) gate refactored:** registry entry now `yukonSilver:Zce()` where `Zce()` delegates to `Q3i()`/`C3i()` and `C3i()` HARDCODES `const A="win32"` for the VM-bundle arch lookup (`fo.files["win32"][arch]`) - the old `const X=process.platform;if(X!=="darwin"&&X!=="win32")...unsupported_platform` form is GONE. `enable_local_agent_mode.nim` Patch 1b rebased to inject the Linux early-return into `Zce()`'s delegate-chain; all 25 sub-patches apply. **GrowthBook delta vs v1.12603.0 baseline:** 3 added (`1703762832` onModelRefusalFallback retry [already in v1.12603.1], `1985784543` an `isEnabled` gate, `3646818354` `shouldKillOnIdlePause`), 0 removed. `enable_local_agent_mode.nim` 12-flag override list unchanged (none of the new flags is darwin/win32-gated). 7 patches fixed + 1 removed (`fix_office_addin_linux` - its connected-file-detection platform gate was dropped upstream) -> 50->49 patches; all apply. |
|---------|----------------|--------------|---------------|-----------------|
| v1.1.3770 | `Oh()` | `mC()` | `QL()` | louderPenguin async override added, ccdPlugins via Kf() spread |
| v1.1.3918 | `Fd()` | `mP` | `o_e()` | chillingSlothEnterprise moved to static, mP simplified to louderPenguin only, ccdPlugins inlined, chillingSlothLocal unconditional |
| v1.1.4328 | `nh()` | `rO` | `Ebe()` | No structural changes; formatMessage calls now include `id` field; function renames only |
| v1.1.7053 | `Kh()` | `$M` | `Qwe()` | New `floatingAtoll` feature (always unavailable); function renames only; 14 features total |
| v1.1.7464 | `rp()` | `zM` | `$Se()` | No structural changes; Dispatch infrastructure added (separate GrowthBook gates); function renames only |
| v1.1.7714 | `fp()` | `cN` | `r1e()` | New `yukonSilverGemsCache` (15 features); `Jr()`→`Vr()` flag function; logger `T`→`C`; `computer-use-server.js` removed; Quick Entry position-save added; two Linux guards removed upstream |
| v1.1.8359 | `lA()` | `jY` | `Kge()` | New `operon` (Nest) feature (16 features, 2 async overrides); `Vr()`→`Qn()` flag reader; new GrowthBook flags: `1306813456` (operon), `2051942385` (CIC can-use-tool), `720735283` (marketplace migration), `748063099` (VM pipe retry); removed flags: `1143815894`, `2339607491`; Operon adds 120+ IPC endpoints across 18 sub-interfaces but currently unavailable on Linux |
| v1.1.8629 | `dA()` | `JX` | `Oet()` | New GrowthBook flag `4201169164` (remote orchestrator / "manta"); `Qn()`→`Hn()` flag reader; `Bx()`→`Hk()` listener; sessions-bridge gate changed from single var to triple (`let f,p,h; h=f\|\|p`); 16 new i18n locale files; no structural changes to feature flag architecture |
| v1.1.9134 | `rw()` | `yre` | `Kge()` | New `wakeScheduler` feature (17 total); `operon` now in static registry too (`Ztn()` returns unavailable); `chillingSlothFeat` darwin gate removed upstream; `jtn()` has native Linux support; `Hn()`→`kn()` flag reader; `Hk()`→`bC()` listener; `xy()`/`$o()`→`_b()`/`js()` value flags; 4 new GrowthBook flags; 1 removed (`3196624152` Phoenix Rising); `$s` variable with `$` in mainView.js preload |
| v1.1.9669 | `_b()` | `Cie` | `fve()` | **New `computerUse` feature** (18 features, 2 async overrides); `chillingSlothFeat` darwin gate re-introduced; `Vn()` flag reader; `wR()` listener; `j1()`/`Js()` value flags; new flags: `3691521536` (stealth updater), `3190506572` (Chrome perms); remote orchestrator (`4201169164`) removed from GrowthBook (hardcoded off); Promise.all pattern in async merger |
| v1.2.234 | `Uw()` | `Lse` | `I_e()` | Same 18 features; `fn()` flag reader; computer-use platform gate now Set-based (`ese = new Set(["darwin","win32"])`); `operon` static entry unconditionally unavailable (`$gn()`), async override adds 5s delay; `floatingAtoll` state sync via new GrowthBook flag `1985802636`; read_terminal server now natively supports Linux; 38+ GrowthBook flags |
| v1.569.0 | `$w()` | `tse` | `V0e()` | Same 18 features; `Sn()` flag reader; `chillingSlothEnterprise` spelling fixed (was `chillingSlottEnterprise` in earlier builds); async merger `$w()` uses `$` in name (required `[\w$]+` regex fix in patch); 3 new GrowthBook flags (`286376943`, `1434290056`, `2392971184`); `1143815894` re-added; several dispatch-era flags removed from boolean calls |
| v1.1062.0 | `Ow()` | `xse` | `m0e()` | Same 18 features (17 static + louderPenguin async); `rn()` flag reader; function renames only; 2 new GrowthBook flags (`2114777685` cowork CU-only mode, `3371831021` cuOnlyMode); 6 dispatch-era flags removed (`3558849738`, `3572572142`, `4201169164`, `1585356617`, `2199295617`, `2860753854`); HTTP header pattern changed (`,` separator instead of `;` — fixed in patch) |
| v1.1348.0 | `gb()` | `eoe` | `Kwe()` | Same 18 features; `tn()` flag reader; `LI()` listener; `js()`/`$b()` value flags; `floatingAtoll` now preference-gated (`$wn()` reads `floatingAtollActive`); 1 new boolean flag (`4040257062` memory routing); 3 new value flags (`254738541` prompt, `4066504968` setup-cowork, `365342473` telemetry scrub); 2 removed (`927037640` subagent model, `3190506572` Chrome perms); Operon 31→33 sub-interfaces (`OperonDesktop`, `OperonMcpToolAccessProvider`); all 34 patches applied without modification |
| v1.1617.0 | `wb()` | `Soe` | `bbe()` | Same 18 features; `rn()` flag reader; `ZI()` listener; `Gs()`/`Db()` value flags; no new/removed GrowthBook flags; platform gate `z5e`→`g5e`; new `radar` MCP server (disabled); 3 force-ON flags (`2976814254`, `3246569822`, `1143815894` in `m6r` map); new renderer windows (`buddy_window/`, `find_in_page/`); new deps (`node-pty`, `ws`); all 35 patches applied without modification |
| v1.2278.0 | `eA()` | `yue` | `CEe()` | Same 18 features; `Zr()` flag reader; `VI()` listener; `xs()`/`_A()` value flags; `chillingSlothFeat` gate changed `g5e`→`IOe` (darwin\|\|win32, was darwin-only); platform booleans `hi`/`vs`/`IOe`; 5 new boolean flags (`286376943`, `1434290056`, `2345107588`, `2392971184`, `2725876754`); 1 new value flag (`1893165035` SDK error auto-recovery); new `index.pre.js` bootstrap file with enterprise config; enterprise config switched from switch/case to ternary; 3 patches updated (`fix_cowork_first_bash.py`, `fix_cowork_linux.py`, `fix_enterprise_config_linux.py`) |
| v1.2581.0 | `iA()` | `jue` | `XEe()` | **New `coworkKappa` feature** (19 features, 3 async overrides); `Yr()` flag reader; platform vars `_s`/`c3e`; async merger now 3-way `Promise.all` (louderPenguin + operon + coworkKappa); 1 new flag (`123929380` coworkKappa/consolidate-memory); 1 removed flag (`4040257062` memory path routing); `fix_tray_dbus.py` updated (`[\w$]+` for tray variable with `$`) |
| v1.2773.0 | `Hb()` | `Mle` | `G1e()` | Same 19 features; `Wr()` flag reader; `QR()` listener; `us()`/`cA()` value flags; platform vars `pi`/`vs`/`r6e`; `chillingSlothFeat` gate changed from `process.platform!=="darwin"` to `r6e` (darwin\|\|win32); `floatingAtoll` now always supported (`Rkn()` unconditional, was preference-gated); 4 new flags (`919950191` LAM tool search, `2140326016` author stubs error, `2216480658` VM outputs, `3858743149` maxThinkingTokens); 3 removed flags (`1585356617` epitaxy, `2199295617` AutoArchive, `4201169164` remote orchestrator); MCP registration `One()`→`ooe()`; computer-use Set `ese`→`ele`; all patches compatible |
| v1.3036.0 | `nA()` | `ode` | `ESe()` | Same 19 features; `Wr()` flag reader unchanged; `Xk()` listener (was `QR()`); `fs()`/`wA()` value flags (was `us()`/`cA()`); platform vars `hi` (darwin, unchanged)/`xce` (win32, was `vs`)/`UMe` (darwin\|\|win32, was `r6e`); 4 new flags (`658929541` LAM setModel buffer, `1496450144` CLAUDE_CODE_ENABLE_TASKS, `2800354941` plugin/skill sort, `2815031518` LocalSessionMgr setModel buffer); 3 removed flags (`159894531` ENABLE_TOOL_SEARCH, `919950191` LAM tool search, `2678455445` MCP SDK server mode); MCP registration `ooe()`→`kce()`; **Patch 3c removed from `enable_local_agent_mode.py`** — upstream dropped the Desktop-side ENABLE_TOOL_SEARCH="false" override, user settings.json now passes through; all other patches compatible |
| v1.3109.0 | `J0()` | `ewA` | `aFA()` | Same 19 features; **webpack re-minify only — no GrowthBook flag additions/removals, no new MCP servers, no new IPC handlers, no new `process.platform` gates vs v1.3036.0**; `Wr()`→`Ti()` flag reader; `Xk()`→`wG()` listener; `fs()`/`wA()`→`Es()`/`di()` value flags; platform vars `hi`→`en` (darwin), `xce`→`ws` (win32), `UMe`→`WhA` (darwin\|\|win32); MCP registration `kce()`→`DfA()`; dispatch IPC bridge re-minified (`rjt` item `s→n`, auto-wake session `n→i`, notification `s→n`, child session `e→A`, index `r→t`, logger `B/P→M`) — `fix_dispatch_linux.py` sub-patches F and J updated with `[\w$]+` captures; all 41 patches compatible without regex changes elsewhere |
| v1.3561.0 | `A_()` | `gwA` | `GGA()` | Same 19 features; `Ti()`→`fi()` flag reader; `wG()`→`bG()` listener; `Es()`/`di()`→`zn()`/`f_()` value flags; platform vars `en` unchanged (darwin), `ws`→`ys` (win32), `WhA`→`bfA` (darwin\|\|win32); MCP registration `DfA()`→`gpA()`; computer-use Set `ele`→`rwA`, checker `Jne()`→`nBA()`; 2 new GrowthBook flags (`1496676413` SSH plugins, `2023768496` trusted device); `123929380` added to force-ON defaults; locale i18n moved to `ion-dist/i18n/` with `.overrides.json`; all 42 patches compatible without regex changes |
| v1.3883.0 | `s_()` | `FwA` | `lUA()` | **New `coworkArtifacts` feature** (20 features, 4 async overrides); `Ii()` flag reader; `FG()` listener; `y_()`/`zn()` value flags; async merger now 4-way `Promise.all` (louderPenguin + operon + coworkKappa + coworkArtifacts); 2 new GrowthBook flags (`2049450122` session handoff, `2192324205` dispatch structured content forwarding); locale i18n JSONs removed from app.asar (moved to resources/ alongside asar); upstream `rjt()` message filter expanded (adds dispatch tool name variables `SU`/`T4` behind a gate parameter — `fix_dispatch_linux.nim` Patch F updated to match new pattern); new `@ant/claude-swift` module (macOS-only, no Linux impact); `@ant/claude-native-binding.node` bundled in asar; MCP registration `gpA()`→`FpA()`; 1 patch updated (`fix_dispatch_linux.nim`); 41 patches compatible without changes |
| v1.4758.0 | `d_()` | `$yA` | `yFA()` | **2 new features:** `chillingSlothPool` (GrowthBook `1992087837`), `markTaskComplete` (GrowthBook `3732274605`) → 22 features, 5 async overrides; `louderPenguin` moved from static to async-only; `zt()` flag reader; `backgroundThrottling:!1` removed from webPreferences (upstream default now used); `process.resourcesPath` removed from `index.pre.js`; `checkTrust`/`saveTrust` gained `DQ()` path expansion; CU teach overlay gate moved before TCC stub (ternary); ion-dist platform enum `W`→`G`; yukonSilver `formatMessage` now called via `Qe().formatMessage` (function call before property access); 6 patches updated, all 42 compatible |
| v1.5354.0 | `v_()` | `ZDA` | `MW()` | **2 new dev-gated features:** `framebufferPreview` (VNC preview, GrowthBook `1928275548`), `iosSimulator` (macOS-only) → 24 features, 5 async overrides unchanged; `Pt()` flag reader; `fM()` listener; `Bn()` value flag reader; platform vars `Zr` (darwin), `ys` (win32), `BwA` (darwin\|\|win32); MCP registration `gpA()`→`qwA()`; 13 new boolean GrowthBook flags; 2 new value flags (`1004628546`, `3229517805`); 1 removed flag (`365342473` telemetry scrub); `1696890383` added to force-ON defaults; sessions-bridge gate variable position changed (not last in `let` decl); dispatch `openPath` gained `Tc()` wrapper; ion-dist SPA code-split (842→1612 files, 85→105 MB); 3 patches fixed (`fix_window_bounds`, `fix_dispatch_linux`, `fix_dispatch_outputs_dir`); all 44 compatible |
| v1.6259.0 | `Y_()` | `xDA` | `UO()` | **2 new macOS-only features:** `androidEmulator` (dev-gated + macOS), `grandPrix` (device pairing, macOS + GrowthBook `873030668`) → 26 features, 5 async overrides unchanged; `Jt()` flag reader; `kM()` listener; `lp()` single-value flag reader; `dn()` multi-key flag reader; platform vars `Xi` (darwin), `Ds` (win32), `ryA` (darwin\|\|win32); 3 new boolean flags (`982691970`, `1802019210`, `2307090146`); 3 new value flags (`873030668`, `1126577245`, `2921038508`); 1 removed (`839037100`); `2307090146` added to force-ON defaults; Vertex auth replaced by generic `interactiveAuth`; 18 new IPC endpoints; `desktopTopBar` now always supported; all 43 patches compatible |
| v1.6259.1 | `v_()` | `ZDA` | `MW()` | **3 features removed:** `floatingAtoll` (always supported, now gone), `androidEmulator` (dev-gated macOS), `grandPrix` (macOS-only device pairing) → 23 features, 5 async overrides unchanged; `Pt()` flag reader; `fM()` listener; `ew()` single-value flag reader; `Bn()` multi-key flag reader; platform vars `Zr` (darwin), `ys` (win32), `BwA` (darwin\|\|win32); MCP registration still `qwA()`; computer-use Set `rwA`→`qDA`; force-ON defaults map: `2307090146` removed (5→5 entries, replaced by existing); async merger helpers `DFA`→`D1A`, `j_r`→`evr`, `mFt`→`jxt`; new MCP server `"skills"` (list_skills, search_skills); new Chrome tools (browser_batch, list_connected_browsers, select_browser); update_plan removed from Chrome; new tools: mark_chapter (ccd_session), retire_card (radar), propose_skills (cowork); all 43 patches compatible |
| v1.6608.0 | `pw()` | `woA` | `pt()` | +framebufferPreview, +iosSimulator, +androidEmulator, +grandPrix, -operon; 6 flags removed → 23 static + 4 async = 27 total features; `pt()` flag reader (was `Pt()`); async merger reduced from 5→4 overrides (operon removed); 6 GrowthBook flags removed: `1306813456`, `1496450144`, `2216480658`, `2433104842`, `2486083521`, `4019128077` (all operon/CU-related); louderPenguin async check `evr()`→`Nvi()`; all 43 patches compatible |
| v1.6608.1 | `pw()` | `DoA` | `pt()` | **Webpack re-minify only** — no new/removed features or GrowthBook flags; `MW()`→`DT()` (production gate), `woA`→`DoA` (merger), `fM()`→`Cm()` (listener), `ew()`→`wr()` (single-value reader), `Bn()`→`OQ()` (multi-key reader), `Nvi()`→`vbi()` (louderPenguin async), `D1A()`→`dhA()` (cowork helper), `lrA()`→`BrA()` (MCP registration); 4 new session config keys under `1978029737`: `coworkWebFetchPrompt`, `memoryIndexSnapshotIdleMs`, `peakHoursStartPst`, `peakHoursEndPst`; all 43 patches compatible |
| v1.6608.2 | `pw()` | `DoA` | `pt()` | **No feature flag changes** — same 27 features, same function names (`pw`, `DoA`, `mT`, `ft`, `Cm`, `wr`, `OQ`); 21 new server-side GrowthBook flags observed (see "New Server-Side GrowthBook Flags in v1.6608.2"); MCP registration renames: `lrA()`→`BrA()` (already in v1.6608.1), `MG`→`I_`, `VqA`→`xSA`, `Y7()`→`pq()`; all 43 patches compatible |
| v1.7196.0 | `pw()` | `woA` | `pt()` | **No new/removed features** - same 27 features (23 static + 4 async overrides); `wr()` single-value reader removed (`pr()` now handles value reads); async merger reverted `DoA`->`woA`, MCP registration reverted `BrA()`->`lrA()`, display labels `xSA`->`FSA`; computer-use Set `QoA`->`BoA`; platform vars unchanged (`or`/`fn`/`OiA`); `pw()`, `pt()`, `Cm()`, `OQ()`, `DT()`, `Gu` all unchanged; no new GrowthBook flags; imagine `isEnabled` may gain `ccd` session type (flag `2204227020`) in future builds; `pt()` may gain pre-return telemetry call in future builds; 3 patches refreshed by @boommasterxd with forward-looking fallbacks; all 45 patches compatible |
| v1.8089.0 | `eD()` | `UcA` | `St()` | **No new/removed features** - same 25 features (23 static + 4 async overrides, 2 features removed vs v1.7196.0 total count adjustment); major renames: `pw()`->`eD()`, `woA`->`UcA`, `DT()`->`Nb()`, `pt()`->`St()`, `Cm()`->`AS()`; platform vars `or`->`Lr` (darwin), `fn`->`Io` (win32), `OiA`->`pj` (darwin\|\|win32); supported constant `saA`->`C5`; computer-use Set `QoA`->`NcA`; GrowthBook storage `Gu`->`nQ`; 6 new boolean GrowthBook flags (`245679952`, `1129419822`, `1496676413`, `2049450122`, `2192324205`, `2800354941`); 1 new non-boolean flag (`4274871493`); 1 new listener flag (`180602792` midnightOwl); 8 removed flags (`982691970`, `1802019210`, `2216480658`, `2860753854`, `3298006781`, `3858743149`, `3885610113`, `4019128077`); `2204227020` now gates Visualize for CCD sessions; new `floatingPenguinEnabled` pref; `3246569822` added to force-ON defaults (`k_i`); all 45 patches compatible |
| v1.8555.2 | `Np()` | `SIA` | `PM()` | **3 new features:** `tearOffHalo` (macOS >= 13 halo overlay), `grandPrixRequest` (darwin service requests), `bootstrapConfig` (dev-gated) - 27 total (26 static + louderPenguin async-only); major renames: `eD()`->`Np()`, `UcA`->`SIA`, `Nb()`->`PM()`, `St()`->`wt()`, `AS()`->`Bm()`, `OQ()`->`Pr()`; new `Lh()` single-value reader (reads `.value` from `CQ` storage); platform vars `Lr`->`Or` (darwin), `Io`->`mo` (win32), `pj`->`P3` (darwin\|\|win32); supported constant `C5`->`gK`; computer-use Set `NcA`->`hIA`, checker `fIA()`; GrowthBook storage `nQ`->`CQ`; force-ON defaults `k_i`->`uNi`; dispatch constant `_ht`->`mpt`; async merger helper `syA`->`ZyA`; 1 new boolean flag (`434204418` MCP non-blocking connection); 2 new listener flags (`4150329283` cloud sync drive, `2358734848` hardware buddy); 2 removed boolean flags (`658929541`, `2815031518` setModel buffer checks); 1 removed value flag (`2921038508` cowork memory guide prompt); `2940196192` added to force-ON defaults map |
| v1.12603.1 | `aD()` | `fSA` | `vR()` | **Point release on v1.12603.0** - minimal change (+446 bytes, full re-minify of the same code). **No new/removed features** - same **37 static + `louderPenguin` async-only = 38 total**. **Function renames:** static registry `sD()`->`aD()` (all other names unchanged: merger `fSA`, dev-gate `vR()`, flag reader `dt()`, supported constant `aB`, cowork helper `eYA()`, 5s-delay helper `SPt()`). **GrowthBook delta:** 1 added (`1703762832` - gates `onModelRefusalFallback` retry behavior in `AgentModeSessionManager`: when ON, a refusal response with direction `"retry"` triggers a fallback; no platform gate, purely server-side rollout), 0 removed. `enable_local_agent_mode.nim` 12-flag override list unchanged (new flag `1703762832` is a pure server-rollout behavioral flag with no platform gate - Linux is unaffected; no new darwin/win32-gated features); all 50 patches applied without modification. |
| v1.12603.0 | `sD()` | `fSA` | `vR()` | **Version bump v1.11847.5 -> v1.12603.0 (~760 builds, full re-minify).** **1 new static feature:** `artifactsPane:DPt()` (gated solely by NEW GrowthBook flag `2115990222`, no platform gate) -> **37 static + `louderPenguin` async-only = 38 total**; no features removed. **`artifactsPane` is now the FIRST key in the registry** - rg anchors using `return\{nativeQuickEntry` no longer match the registry opening; anchor on `return\{artifactsPane` or `ccdPlugins` instead. `builtinMcpPresets` changed from dev-gated `xur(()=>Bu)` to bare `aB` (always supported in the registry; production gating moved to the usage site: `NODE_ENV!=="production"\|\|desktopBootFeatures.builtinMcpPresets.status==="supported"`), so the bundle is back to a single `app.isPackaged` dev-gate function. Async merger shape unchanged: 5-way `Promise.all` -> `{...sD(),louderPenguin:A,coworkKappa:e,coworkArtifacts:t,markTaskComplete:i,epitaxyMcpApps:r}` via `Promise.all([fqr(),eYA(()=>dt("123929380")),eYA(()=>dt("2940196192")),eYA(()=>dt("3732274605")),SPt(()=>dt("3516166472"))])`. Function renames: registry `Rw()`->`sD()`, merger `PBA`->`fSA`, dev-gate `OS()`->`vR()` (`function vR(A){return cA.app.isPackaged?{status:"unavailable"}:A()}`, electron var `oA`->`cA`), flag reader `lt()`->`dt()`, GrowthBook storage `zd`->`gf`, telemetry helper `Hz`->`LAA`, listener `Vh()`->`Em()`, object reader `Vr()`->`Qn()`, NEW value-with-default reader `LC(id,default)`, supported constant `Bu`->`aB`, louderPenguin helper `Xur()`->`fqr()` (still darwin\|\|win32 gate + `await kk(),dt("4116586025")`), cowork helper `JNA()`->`eYA()`, 5s-delay helper `zQt()`->`SPt()`, yukonSilver `DZA()`->`Lae()`, quietPenguin inner `Wur()`->`Bqr()` (still the only darwin\|\|win32 fn matching Patch 1), chillingSlothFeat `Jur()`/`Qz`->`lqr()`/`cAA` (`cAA=cn\|\|zo`), force-ON defaults map `yKi`->`Vdr`, Zod feature schema `Kji` (status union `ko`, includes `artifactsPane` + all 12 patch-overridden features). **GrowthBook delta:** 4 added (`2115990222` artifactsPane gate, `2745857735` LAM folder-access requests, `884132720` oauthScope passthrough, `3932491586` VM optional mounts - read via new `LC()` reader, force-OFF in `Vdr`), 0 removed. `enable_local_agent_mode.nim` 12-flag override list unchanged (none of the 4 new flags is darwin/win32-gated, so none needs forcing for Linux; `artifactsPane` follows the `epitaxyMcpApps` precedent of leaving pure server-rollout features alone); all 50 patches applied without modification. |
| v1.11847.5 | `Rw()` | `PBA` | `OS()` | **Version bump v1.11187.4 -> v1.11847.5 (~660 builds, full re-minify).** **3 new static features:** `coworkRemoteSessionSpaces:Bu` and `coworkBranchSession:Bu` (both always supported, no platform gate, no override needed) and `epitaxyMcpApps` (static `{status:"unavailable"}` + NEW async override) -> **36 static + `louderPenguin` async-only = 37 total**; no features removed. **Async merger now 5-way** `Promise.all`: `{...Rw(),louderPenguin:A,coworkKappa:e,coworkArtifacts:t,markTaskComplete:i,epitaxyMcpApps:r}` via `Promise.all([Xur(),JNA(()=>lt("123929380")),JNA(()=>lt("2940196192")),JNA(()=>lt("3732274605")),zQt(()=>lt("3516166472"))])`. Function renames: registry `Dw()`->`Rw()`, async merger `SBA`->`PBA`, dev-gate `MS()`->`OS()` (`function OS(A){return oA.app.isPackaged?{status:"unavailable"}:A()}`, electron var `sA`->`oA`; 2nd dev-gate `xEr()`->`xur()` for `builtinMcpPresets`), `louderPenguin` async helper `XEr()`->`Xur()` (still `darwin\|\|win32` gate + `await pR(),lt("4116586025")`), cowork helper `mNA()`->`JNA()` (5s delay now in inner `zQt()`), supported constant `_d`->`Bu`; GrowthBook bool reader `lt()` unchanged; `quietPenguin` inner `Wur()` is the only darwin\|\|win32 feature fn (1 match for Patch 1); `chillingSlothFeat:Jur()` uses `Qz` variable gate. **GrowthBook delta:** 73 distinct boolean flag IDs (was 68); 8 added (`3516166472` epitaxyMcpApps/MCP-apps + `/epitaxy` side-chat, `1109029378` macOS tray usage menu, `1936081873` system-prompt build-skip, `1997559319` refusal_fallback_prompt dialog kind, `2232207471` CLI governor session cap, `2724639973` CLI governor eviction, `3633961296` plugin enabled-state backfill, `3807767338` policy-limits session seeding), 1 removed (`3638165567`). `enable_local_agent_mode.nim` 12-flag override list unchanged (all 25 sub-patches match; `epitaxyMcpApps` intentionally NOT forced on - experimental, not needed for Linux Cowork/Code/Agent-Mode). 1 patch fixed this release (`fix_claude_code` getStatus - upstream added `||await this.getHostPreseedInPlacePath()` to the first if-condition), all 48 applied. |
| v1.11187.4 | `Dw()` | `SBA` | `MS()` | **Version bump v1.10628.2 -> v1.11187.4 (~560 builds, full re-minify).** **1 new static feature** `coworkArtifactPopout:_d` (always supported, no platform gate, no override needed) -> **33 static + `louderPenguin` async-only = 34 total**; no features removed. Merger return identical shape: `{...Dw(),louderPenguin:A,coworkKappa:e,coworkArtifacts:t,markTaskComplete:i}` via `Promise.all([XEr(),mNA(()=>lt("123929380")),mNA(()=>lt("2940196192")),mNA(()=>lt("3732274605"))])`. Function renames: registry `Aw()`->`Dw()`, async merger `LCA`->`SBA`, dev-gate `Dm()`->`MS()` (`function MS(A){return sA.app.isPackaged?{status:"unavailable"}:A()}`, electron var `aA`->`sA`; 2nd dev-gate `xEr()` used only by `builtinMcpPresets`), `louderPenguin` async helper `Fsr()`->`XEr()` (still `darwin\|\|win32` gate, now also `await IR(),lt("4116586025")`), cowork helper `pRA()`->`mNA()`, GrowthBook bool reader `It()`->`lt()`, supported constant `Xd`->`_d`. `bootstrapConfig` changed from `MS()`-gated to bare `_d` (always supported); `desktopTopBar:ZEr()` unconditional `{status:"supported"}`. **GrowthBook delta** (vs v1.9659.4, the only local prior bundle - spans the full jump): 5 added (`124685897` template-subst, `1323782925` APe qualifier, `1609612026` marketplace install, `2720310975` side-chat tools, `790863764` device_bash), 1 removed (`3638165567`). `enable_local_agent_mode.nim` 12-flag override list unchanged (all 25 sub-patches match; both new chat features still in the Zod `.partial()` schema); 2 patches fixed this release for refactored code (`fix_utility_process_kill`, `fix_asar_folder_drop` Patch B), all 48 applied. |
| v1.10628.2 | `Aw()` | `LCA` | `Dm()` | **Webpack re-minify point release on v1.10628.0** (v1.10628.1 not observed on the public download channel) - same **32 static + `louderPenguin` async-only = 33 total**, identical static feature names (`claudeDesignWindow`/`builtinMcpPresets` both retained, none added/removed), merger return identical (`{...Aw(),louderPenguin:e,coworkKappa:A,coworkArtifacts:t,markTaskComplete:i}` via `Promise.all([Fsr(),pRA(()=>It("123929380")),pRA(()=>It("2940196192")),pRA(()=>It("3732274605"))])`); **unusually light re-minify - most function names held:** registry `Aw()`, async merger `LCA`, dev-gate `Dm()` (`function Dm(e){return aA.app.isPackaged?{status:"unavailable"}:e()}`, electron var `aA`), `louderPenguin` async helper `Fsr()` (still `darwin\|\|win32` gate), cowork helper `pRA()`, GrowthBook bool reader `It()`, computer-use Set `MCA` (`new Set(["darwin","win32"])`, `MCA.has(process.platform)`), win32 var `ro`, darwin\|\|win32 var `O$` all unchanged from v1.10628.0; renamed only: supported constant `XQ`->`Xd` (`{status:"supported"}`), chatTab/chatCodeExecution gate fns `R6e`->`R5e`/`M6e`->`M5e`, cowork 5s-delay helper `u9e`->`u6e`, yukonSilver `WjA`->`W8A`, `zKA`->`z1A`, `$jA`->`$8A`, tray fn `Y6A`->`Y5A` / tray var `VE` unchanged (`fix_tray_dbus.nim`). 68 distinct boolean GrowthBook flag IDs in the raw bundle, all documented key flags present; both new features still in Zod `.partial()` schema; ion-dist `c71860c77-CDhE5jkR.js`->`c71860c77-CV0D52ti.js` (`mountPath` still mac/win-only, 90 MB/691 JS/909 files unchanged); platform gates darwin 65 / win32 113 / linux 5 (zero swing, no new PORTABLE gate); `enable_local_agent_mode.nim` 12-flag override list unchanged; all 48 patches applied without modification |
| v1.10628.0 | `Aw()` | `LCA` | `Dm()` | **Major version bump v1.9659.4 -> v1.10628.0 (~1000 builds).** **2 new static features:** `claudeDesignWindow` (`claudeDesignWindow:XQ`, always supported, no platform gate, no renderer window) and `builtinMcpPresets` (`builtinMcpPresets:Dm(()=>XQ)`, dev-gated on all platforms, gates built-in MCP presets like `m365`/Microsoft 365) -> **32 static + `louderPenguin` async-only = 33 total**; no features removed, both new features in the Zod `.partial()` schema. Function renames (re-minify): registry `Yp()`->`Aw()`, async merger `IlA`->`LCA` (still `{...Aw(),louderPenguin:e,coworkKappa:A,coworkArtifacts:t,markTaskComplete:i}` via `Promise.all([Fsr(),pRA(()=>It("123929380")),pRA(()=>It("2940196192")),pRA(()=>It("3732274605"))])`), dev-gate `um()`->`Dm()` (`function Dm(e){return aA.app.isPackaged?{status:"unavailable"}:e()}`, electron var `aA` unchanged), `louderPenguin` async helper `Frr()`->`Fsr()` (still `darwin\|\|win32` gate), `quietPenguin` inner `Lsr`, cowork async helper `V0A`->`pRA`, GrowthBook bool reader `Bt()`->`It()`, supported constant -> `XQ` (`{status:"supported"}`), computer-use Set `rlA`->`MCA` (`new Set(["darwin","win32"])`, `MCA.has(process.platform)`), platform vars `Or`/`mo`/`P3`->`Yr`(darwin)/`ro`(win32)/`O$`(darwin\|\|win32), tray fn `Y6A` / tray var `VE` (MCP internal-registration `LYA()`-line not re-verified this release; roster unchanged). **GrowthBook delta** (empirical patched-v1.9659.4-install vs fresh-v1.10628.0 binary; no clean prior MSIX available): ~17 flag IDs newly present (traced new: `124685897` template-subst, `1609612026` marketplace install, `2143883161` `/code/` route gate, `2720310975` side-chat tools, `2688060585`+`3269331205` autoMode force-ON defaults; plus re-appearing historical: `1129419822`, `1496676413`, `1824824999`, `2067027393`, `2114777685`, `2192324205`, `2204227020`, `245679952`, `2800354941`, `3444158716`, `4274871493`), 3 removed (`3242661803`, `3638165567`, `3858743149` maxThinkingTokens); 3 force-ON flags our patches rewrite (`1992087837`/`2216414644`/`3732274605`) excluded as patch artifacts. `enable_local_agent_mode.nim` 12-flag override list unchanged; ion-dist `c71860c77-BOyfE2Py.js`->`c71860c77-CDhE5jkR.js` (`mountPath` still mac/win-only); platform gates darwin 64->65 / win32 112->113 / linux 5 (re-minify noise, no new PORTABLE gate); all 48 patches applied without modification (166 `[OK]` sub-patterns, 0 `[FAIL]`) |
| v1.9659.4 | `Yp()` | `IlA` | `um()` | **Webpack re-minify point release on v1.9659.2** (upstream skipped v1.9659.3 on the public download channel) - same 31 features (30 static + `louderPenguin` async-only), same 30 static feature names, `chatTab`/`surfaceTogglesPreview` still the 2 newest, no features added/removed; function renames vs v1.9659.2 (fresh identifiers only): registry `xp()`->`Yp()`, async merger `olA`->`IlA` (still `{...Yp(),louderPenguin:e,coworkKappa:A,coworkArtifacts:t,markTaskComplete:i}` via `Promise.all([Frr(),V0A(()=>Bt("123929380")),V0A(()=>Bt("2940196192")),V0A(()=>Bt("3732274605"))])`), dev-gate wrapper `Em()`->`um()` (`function um(e){return aA.app.isPackaged?{status:"unavailable"}:e()}`, electron var `aA` unchanged), `louderPenguin` async helper `wrr()`->`Frr()` (still `darwin\|\|win32` gate, returns `unavailable` on Linux), cowork async helper `V0A`; GrowthBook bool reader `Bt()` unchanged; computer-use Set `XEA`->`rlA` (`new Set(["darwin","win32"])`, checked via `rlA.has(process.platform)`); 71 GrowthBook flag IDs unchanged; `fix_tray_dbus.nim` this release: tray fn `Jfi`, tray var `RQ`, menu var `mm`; ion-dist byte-identical (`c71860c77-BOyfE2Py.js`, `mountPath` still mac/win-only); platform gates darwin 60->64 / win32 111->112 / linux 5 (re-minify noise, no new PORTABLE gate); `enable_local_agent_mode.nim` 12-flag override list unchanged; all 47 patches applied without modification |
| v1.9659.2 | `xp()` | `olA` | `Em()` | **Webpack re-minify point release on v1.9659.1** - same 31 features (30 static + `louderPenguin` async-only), `chatTab`/`surfaceTogglesPreview` still the 2 newest, no features added/removed; function renames vs v1.9659.1 (fresh identifiers only): registry `Yp()`->`xp()`, async merger `slA`->`olA` (still `{...xp(),louderPenguin:e,coworkKappa:A,coworkArtifacts:t,markTaskComplete:i}` via `Promise.all([wrr(),Bt("123929380"),Bt("2940196192"),Bt("3732274605")])`), dev-gate wrapper `lm()`->`Em()` (`function Em(e){return aA.app.isPackaged?{status:"unavailable"}:e()}`), `louderPenguin` async helper still `wrr()`; GrowthBook bool reader `Bt()` and computer-use Set `XEA` (`new Set(["darwin","win32"])`, checker `AlA()`) unchanged from v1.9659.1; no GrowthBook flag changes; `fix_tray_dbus.nim` this release: tray fn `G9A`, tray var `PE`; ion-dist unchanged (`c71860c77-BOyfE2Py.js`, `mountPath` still mac/win-only); all 47 patches applied without modification |
| v1.9659.1 | `Yp()` | `slA` | `lm()` | **2 new features:** `surfaceTogglesPreview` (`lm()` dev-gated, always `unavailable` in production), `chatTab` (3p-bootstrap-gated via `aze()` = `desktopBootFeatures.chatIn3p.status==="supported"` && `chatTabEnabled===true`, only active in third-party whitelabel builds) → **30 static + `louderPenguin` async-only = 31 total**; **no features removed** (all 28 static from v1.9255.2 retained); function renames (webpack re-minify): registry `Gp()`→`Yp()`, async merger `pEA`→`slA`, bool flag reader `Ct`→`Bt`, async helper `A0A`→`x0A`, dev-gate wrapper `wD()`→`lm()` (NB: the v1.9255.2 row labels this `PM()` in error; `PM()` does not exist in v1.9255.2 either, the dev-gate was already `wD()`), supported constant `_M`→`Ww`; louderPenguin async still `wrr()` (`darwin\|\|win32` gate, returns `unavailable` on Linux); **GrowthBook deltas verified clean** against freshly extracted v1.9255.2 baseline: 71 boolean flag IDs identical, 0 added/removed (async merger still gates `louderPenguin`/`coworkKappa`/`coworkArtifacts`/`markTaskComplete` via `Bt("4116586025")`/`Bt("123929380")`/`Bt("2940196192")`/`Bt("3732274605")`); 1 new numeric remote-config value `1629866860` (claude_code session limit, read via `ad()`, not a boolean toggle, not flag-relevant); `enable_local_agent_mode.nim` 12-flag override list unchanged (the 2 new features are dev-/3p-gated and don't block Linux Cowork/Code/Agent-Mode paths; all overridden flags remain in the Zod `.partial()` schema; validated 25/25 sub-patches, `node --check` OK); all 47 patches compatible without any code change |
| v1.9255.2 | `Gp()` | `pEA` | `PM()` | **2 new features:** `chatIn3p` (PM() dev-gated, third-party chat), `chatCodeExecution` (`qWe(Vi())` 3p config presence check) - 29 total (28 static + louderPenguin async-only); registry rename `Np()`->`Gp()`, async merger rename `SIA`->`pEA` (still spreads `Gp()` + 4 async overrides `louderPenguin`/`coworkKappa`/`coworkArtifacts`/`markTaskComplete` gated by `Ct("4116586025")`/`Ct("123929380")`/`Ct("2940196192")`/`Ct("3732274605")`); tray function (`_5A` in v1.9255.0 / `R6A` in v1.9255.2), tray var (`OE` in v1.9255.0 / `xE` in v1.9255.2) and menu var (`Ak` / `LM`) now merged into single `let X=null,Y=null;` decl with another function between decl and the tray function - `fix_tray_dbus.nim` rebased to extract tray var from `X&&(X.destroy(),X=null)` pattern inside the tray-function body rather than from `let ([\w$]+)=null;function ...`; v1.9255.2 is a webpack re-minify only point release on top of v1.9255.0 (4.2 MB diff, fresh identifiers everywhere) - all 47 patches stayed compatible without any code change between v1.9255.0 and v1.9255.2; ion-dist main `c71860c77-*` chunk renamed `c71860c77-CgRWbV12.js`->`c71860c77-DFJHDHrp.js`, code-split 16->20 sub-chunks (677 total JS files, was 667), `mountPath` still lacks `linux` key so `fix_ion_dist_linux.nim` still required; `enable_local_agent_mode.nim` 12-flag override list (`quietPenguin`, `louderPenguin`, `chillingSlothFeat`, `chillingSlothLocal`, `chillingSlothPool`, `yukonSilver`, `yukonSilverGems`, `ccdPlugins`, `computerUse`, `coworkKappa`, `coworkArtifacts`, `markTaskComplete`) unchanged - 2 new features don't block existing Linux Cowork/Code paths and all overridden flags remain in the Zod `.partial()` schema. GrowthBook flag deltas not re-verified against v1.8555.2 baseline (old MSIX was deleted before diff) - see CHANGELOG for partial findings |

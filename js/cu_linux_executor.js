(function(){
var _cp=require("child_process"),_path=require("path"),_fs=require("fs"),_os=require("os"),_electron=require("electron");

// Run ydotool without a shell. Typed text and key names are model-supplied;
// concatenating them into an execSync shell string would let $(...), backticks
// etc. expand (JSON.stringify quoting is NOT shell quoting).
function _ydotool(args){return _cp.execFileSync("ydotool",args,{encoding:"utf-8",timeout:15000})}
// Launch a command detached without a shell, fire-and-forget (replaces the
// old `setsid ... >/dev/null 2>&1` shell strings). stdio:"ignore" matches the
// old /dev/null redirect — execFile would pipe+buffer instead and SIGTERM the
// app once its lifetime output passed maxBuffer (setsid execs the app in
// place, so the kill would hit the app itself). Spawn failures still surface
// via the error event; unref() lets the child outlive us.
function _launchDetached(args){
  var c=_cp.spawn("setsid",args,{detached:true,stdio:"ignore"});
  c.on("error",function(err){globalThis.__cdbDiag("[claude-cu] detached launch failed ("+args.join(" ")+"): "+(err.message||err))});
  c.unref();
}
function _isWayland(){var st=(process.env.XDG_SESSION_TYPE||"").toLowerCase();if(st==="wayland")return true;if(st==="x11")return false;return!!process.env.WAYLAND_DISPLAY}
var _wayland=_isWayland();
function _isWlroots(){return!!process.env.SWAYSOCK||!!process.env.HYPRLAND_INSTANCE_SIGNATURE||!!process.env.NIRI_SOCKET}
function _isGnomeWayland(){return _wayland&&(process.env.XDG_CURRENT_DESKTOP||"").toLowerCase().indexOf("gnome")>=0}
// A "covered" Wayland session is one with a bundled first-party bridge:
// wlroots (Sway/Hyprland/Niri) → wlroots-bridge, GNOME → gnome-portal-bridge.
// On covered sessions the third-party cascade (ydotool/grim/gnome-screenshot/
// gdbus/hyprctl/swaymsg/jq/niri) is DELETED — the bridge is the only backend.
function _wlrootsBridgeBin(){return process.env.WLROOTS_BRIDGE_BIN||globalThis.__cuWlrootsBridgeBin}
function _gnomeBridgeBin(){return process.env.GNOME_PORTAL_BRIDGE_BIN||globalThis.__cuGnomeBridgeBin}
function _isWlrootsCovered(){return _wayland&&_isWlroots()}
function _isGnomeCovered(){return _isGnomeWayland()}
try{var _virt=_cp.execFileSync("systemd-detect-virt",[],{encoding:"utf-8",timeout:3000,stdio:["ignore","pipe","ignore"]}).trim();globalThis.__isVM=_virt!=="none"&&_virt!==""}catch(e){globalThis.__isVM=!1}
if(globalThis.__isVM)globalThis.__cdbDiag("[claude-cu] VM detected ("+_virt+") — teach overlay uses dark backdrop fallback");
var _cmdCache={};
function _hasCmd(bin){if(_cmdCache[bin]!==void 0)return _cmdCache[bin];try{_cp.execFileSync("which",[bin],{encoding:"utf-8",timeout:3000});_cmdCache[bin]=true}catch(e){_cmdCache[bin]=false}return _cmdCache[bin]}
function _desktopId(){return(process.env.XDG_CURRENT_DESKTOP||"").toLowerCase()}
var _ydotoolOk=null;
function _checkYdotool(){if(_ydotoolOk!==null)return _ydotoolOk;if(!_hasCmd("ydotool")){_ydotoolOk=false;return false}try{_cp.execFileSync("pgrep",["-x","ydotoold"],{timeout:2000,stdio:"pipe"});_ydotoolOk=true}catch(e){var sock=(process.env.YDOTOOL_SOCKET||"")||((process.env.XDG_RUNTIME_DIR||"/tmp")+"/.ydotool_socket");try{_fs.accessSync(sock);_ydotoolOk=true}catch(se){globalThis.__cdbDiag("[claude-cu] ydotool found but ydotoold not running — falling back to x11-bridge (XWayland)");_ydotoolOk=false}}return _ydotoolOk}
// ── x11-bridge: first-party X11/XWayland backend (replaces xdotool/scrot/import/wmctrl) ──
// The binary is resolved in cu_mode_preamble.js into globalThis.__cuX11BridgeBin.
function _x11BridgeBin(){return process.env.X11_BRIDGE_BIN||globalThis.__cuX11BridgeBin}
// Bridges must emit exactly one JSON value on stdout; anything else (crash
// spew, truncated write, stray warning) lands here. Fail with the bridge name
// and a stdout preview instead of a bare SyntaxError so the tool result says
// which bridge misbehaved and what it printed.
function _parseBridgeJson(label,out){
  try{return JSON.parse(out)}catch(e){
    var preview=out.length>300?out.slice(0,300)+"...":out;
    throw new Error(label+" returned non-JSON output: "+preview);
  }
}
function _x11Bridge(args){
  var bin=_x11BridgeBin();
  if(!bin)throw new Error("x11-bridge not available (globalThis.__cuX11BridgeBin unset — set X11_BRIDGE_BIN or reinstall the package - the bundled bridge is missing)");
  var res=_cp.execFileSync(bin,args,{encoding:"utf-8",timeout:15000,maxBuffer:16*1024*1024});
  var out=res.trim();
  return out?_parseBridgeJson("x11-bridge",out):null;
}
// Async twin of _x11Bridge. The SCREENSHOT path is async end to end (issue
// #232) - a hung bridge there must never block the Electron main process.
function _x11BridgeAsync(args,timeoutMs){
  var bin=_x11BridgeBin();
  if(!bin)return Promise.reject(new Error("x11-bridge not available (globalThis.__cuX11BridgeBin unset — set X11_BRIDGE_BIN or reinstall the package - the bundled bridge is missing)"));
  return _execFileAsync("x11-bridge",bin,args,timeoutMs||15000);
}
// Bridge-side monitor list (RandR names + root-window geometry). Used to map a
// root-coordinate region to a monitor name + monitor-relative coords for `zoom`.
// ASYNC: only ever reached from _captureRegion, which is async. Negatively
// cached, so a broken bridge costs the timeout once per process, not per shot.
var _x11ScreensCache=null;
async function _x11BridgeScreens(){
  if(_x11ScreensCache!==null)return _x11ScreensCache;
  try{var s=await _x11BridgeAsync(["screens"],SCREENS_TIMEOUT_MS);_x11ScreensCache=Array.isArray(s)?s:[]}catch(e){globalThis.__cdbDiag("[claude-cu] x11-bridge screens failed: "+(e.message||e));_x11ScreensCache=[]}
  return _x11ScreensCache;
}
// ── Generic bridge invoker for the Wayland first-party backends ──
// wlroots-bridge and gnome-portal-bridge mirror x11-bridge's CLI/JSON contract
// (subcommand + --kebab flags, one JSON value on stdout, exit 1 + stderr on
// error). gnome-portal-bridge proxies through a portal session and can be
// slower, so we use a more generous timeout there.
function _bridge(bin,args,timeoutMs){
  if(!bin)throw new Error("bridge binary not available");
  var res=_cp.execFileSync(bin,args,{encoding:"utf-8",timeout:timeoutMs||15000,maxBuffer:16*1024*1024});
  var out=res.trim();
  return out?_parseBridgeJson(bin,out):null;
}
// Shared promisified execFile for every ASYNC bridge call (issue #232). Same
// contract as _bridge/_x11Bridge: one JSON value on stdout, exit 1 + stderr on
// error; label names the bridge in the parse error.
function _execFileAsync(label,bin,args,timeoutMs){
  return new Promise(function(resolve,reject){
    _cp.execFile(bin,args,{encoding:"utf-8",timeout:timeoutMs||15000,maxBuffer:16*1024*1024},function(err,stdout){
      if(err){reject(err);return}
      var out=(stdout||"").trim();
      try{resolve(out?_parseBridgeJson(label,out):null)}catch(pe){reject(pe)}
    });
  });
}
// Async, non-blocking variant of _bridge. Used ONLY for the GNOME portal
// session lifecycle (session-start/session-end), because session-start blocks
// on the XDG RemoteDesktop consent dialog for up to timeoutMs — a synchronous
// execFileSync there would freeze the Electron main process while the dialog is
// pending. Mirrors the kwin executor's promisified execFile (executor_linux.js).
function _bridgeAsync(bin,args,timeoutMs){
  if(!bin)return Promise.reject(new Error("bridge binary not available"));
  return _execFileAsync(bin,bin,args,timeoutMs);
}
// ── Blocking budget (issue #232) ────────────────────────────────────────────
// Every SYNC bridge call freezes the whole Electron main process for its full
// timeout; the OS shows "Not Responding" well before 30 s. These constants cap
// what a broken bridge can cost on the synchronous input path. The screenshot
// path does not use them at all any more - it is async end to end.
//   SCREENS_TIMEOUT_MS      portal-free monitor enumeration; a plain D-Bus /
//                           RandR query that takes longer than this is broken.
//   GNOME_SYNC_START_MS     the sync session-start BACKSTOP only. The consent
//                           dialog belongs to the ASYNC lock-hook path, which
//                           keeps the full GNOME_SESSION_START_MS budget; the
//                           backstop only exists for a portal command that beat
//                           the lock hook, so it must not sit on a user's click.
//   GNOME_SESSION_START_MS  async session-start, may wait out a consent dialog.
var SCREENS_TIMEOUT_MS=5000;
var GNOME_SYNC_START_MS=8000;
var GNOME_SESSION_START_MS=30000;
// PORTAL FAILURE LATCH. Before this, a failed session-start left no memo: every
// subsequent portal command re-ran the full blocking session-start and then the
// command itself, so one click could block the main process for two minutes and
// every following click did it again. Now a failure is remembered for a cooldown
// and portal commands fail fast (and legibly) until it lapses. A fresh CU lock
// clears it - a new user gesture deserves a real retry, consent dialog included.
var GNOME_PORTAL_COOLDOWN_MS=60000;
var _gnomePortalDownUntil=0;
function _gnomePortalDown(){return Date.now()<_gnomePortalDownUntil}
function _gnomePortalMarkDown(why){
  _gnomePortalDownUntil=Date.now()+GNOME_PORTAL_COOLDOWN_MS;
  globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge portal session unavailable ("+why+") - portal commands fail fast for "+Math.round(GNOME_PORTAL_COOLDOWN_MS/1000)+"s instead of blocking the main process");
}
function _gnomePortalClearDown(){_gnomePortalDownUntil=0}
function _gnomePortalDownError(){
  return new Error("gnome-portal-bridge portal session unavailable - session-start failed within the last "+Math.round(GNOME_PORTAL_COOLDOWN_MS/1000)+"s, so Computer Use input/capture cannot run on this GNOME Wayland session. Run `"+(_gnomeBridgeBin()||"gnome-portal-bridge")+" session-start` in a terminal to see why, and check ~/.config/Claude/logs/claude-patches.log.");
}
// Return {bin, name, timeout} for the active covered Wayland session, or null.
function _wlBridge(){
  if(_isWlrootsCovered()){var b=_wlrootsBridgeBin();if(b)return{bin:b,name:"wlroots-bridge",timeout:15000}}
  if(_isGnomeCovered()){var g=_gnomeBridgeBin();if(g)return{bin:g,name:"gnome-portal-bridge",timeout:30000}}
  return null;
}
// gnome-portal-bridge subcommands that go through the XDG RemoteDesktop/
// ScreenCast portal session (input injection + capture). ONLY these may ensure
// the portal session first. Enumeration subcommands (windows, frontmost-app,
// app-under-point, screens, activate-window) are plain GNOME Shell Introspect /
// Mutter D-Bus calls in the bridge (see gnome-bridge src/main.rs) and MUST NOT
// touch the portal: issue #184 — upstream warms a resumed Code session via
// listRunningApps → `windows`, and a blanket session ensure here popped the
// GNOME "Desktop remoto" consent dialog and froze the main process.
var _gnomePortalCmds={"zoom":1,"screenshot":1,"pointer-move":1,"pointer-click":1,"pointer-scroll":1,"pointer-drag":1,"left-mouse-down":1,"left-mouse-up":1,"key-sequence":1,"type":1,"hold-key":1};
function _wlBridgeCall(args){
  var b=_wlBridge();if(!b)throw new Error("no covered Wayland bridge available");
  var portalCmd=b.name==="gnome-portal-bridge"&&_gnomePortalCmds[args[0]]===1;
  // A portal command with no portal session behind it can only fail. Running it
  // anyway costs another full blocking timeout, so refuse while latched down.
  if(portalCmd){
    if(!_gnomeSessionActive&&_gnomePortalDown())throw _gnomePortalDownError();
    _gnomeEnsureSessionSync();
    // The backstop may have just discovered the portal is down. Re-check the
    // LATCH (not merely "session not active" - an async start may still be in
    // flight, and that case keeps the old behaviour of letting the bridge
    // decide). Running a portal command against a session that failed to start
    // buys nothing and costs another full blocking timeout on top.
    if(!_gnomeSessionActive&&_gnomePortalDown())throw _gnomePortalDownError();
  }
  // Portal-proxied commands keep the generous gnome timeout; portal-free
  // enumeration gets the standard bridge timeout so a stuck D-Bus call can
  // never block the main process for the full portal budget.
  var t=b.name==="gnome-portal-bridge"&&!portalCmd?15000:b.timeout;
  return _bridge(b.bin,args,t);
}
// ASYNC twin of _wlBridgeCall, used by the screenshot path (issue #232). Same
// portal rules, but it AWAITS the async session ensure instead of running the
// blocking sync backstop, so a hung portal cannot freeze the main process.
async function _wlBridgeCallAsync(args,timeoutOverrideMs){
  var b=_wlBridge();if(!b)throw new Error("no covered Wayland bridge available");
  var portalCmd=b.name==="gnome-portal-bridge"&&_gnomePortalCmds[args[0]]===1;
  if(portalCmd){
    if(!_gnomeSessionActive&&_gnomePortalDown())throw _gnomePortalDownError();
    await _gnomeEnsureSession();
    if(!_gnomeSessionActive)throw _gnomePortalDownError();
  }
  var t=timeoutOverrideMs||(b.name==="gnome-portal-bridge"&&!portalCmd?15000:b.timeout);
  return _execFileAsync(b.name,b.bin,args,t);
}
// Synchronous session-start backstop for the per-call input/capture path: these
// callers run the bridge synchronously and need the portal session up FIRST.
// In normal operation the CU lock hook (__setLockHeld → _gnomeEnsureSession,
// async) has already brought the session up, so this is a no-op. It only does
// the blocking session-start if a portal command runs without the lock hook
// having fired — and by then a consent dialog is expected UX anyway (the user
// invoked Computer Use).
function _gnomeEnsureSessionSync(){
  if(_gnomeSessionActive||_gnomeSessionStarting)return _gnomeSessionActive;
  if(_gnomePortalDown())return !1;
  var bin=_gnomeBridgeBin();if(!bin)return !1;
  if(!_gnomeExitHooked){_gnomeExitHooked=!0;process.once("exit",function(){if(_gnomeSessionActive){try{_cp.execFileSync(_gnomeBridgeBin(),["session-end"],{timeout:5000,stdio:"ignore"})}catch(e){}}})}
  try{_bridge(bin,["session-start"],GNOME_SYNC_START_MS);_gnomeSessionActive=!0;_gnomePortalClearDown();globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session started (sync backstop)");return !0}
  catch(e){globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session-start failed (sync backstop): "+(e.message||e));_gnomePortalMarkDown("sync backstop session-start failed");return !1}
}
// Bridge-side monitor list (snake_case screens) for the active Wayland bridge.
// Mirrors _x11BridgeScreens; used to map a global-logical region to a monitor
// name + monitor-relative coords for `zoom --display`.
var _wlScreensCache=null;
async function _wlBridgeScreens(){
  if(_wlScreensCache!==null)return _wlScreensCache;
  try{var s=await _wlBridgeCallAsync(["screens"],SCREENS_TIMEOUT_MS);_wlScreensCache=Array.isArray(s)?s:[]}catch(e){globalThis.__cdbDiag("[claude-cu] "+(_wlBridge()?_wlBridge().name:"bridge")+" screens failed: "+(e.message||e));_wlScreensCache=[]}
  // An empty monitor list means the region below is sent in GLOBAL logical
  // coordinates with no --display, which is wrong on any multi-monitor layout.
  // Say so once instead of silently returning a mis-cropped image (issue #232).
  if(!_wlScreensCache.length)globalThis.__cdbDiag("[claude-cu] no bridge monitor list - zoom will use global coordinates with no --display (multi-monitor captures will be wrong)");
  return _wlScreensCache;
}
// Map a global-logical region to the bridge monitor containing its top-left,
// returning {name, x, y} with monitor-relative x/y (mirrors _x11MonForRegion).
async function _wlMonForRegion(x,y){
  var screens=await _wlBridgeScreens();
  if(!screens.length)return null;
  var pick=null;
  for(var i=0;i<screens.length;i++){var g=screens[i].geometry||{};if(x>=g.x&&x<g.x+g.width&&y>=g.y&&y<g.y+g.height){pick=screens[i];break}}
  if(!pick){for(var j=0;j<screens.length;j++){if(screens[j].is_primary){pick=screens[j];break}}}
  if(!pick)pick=screens[0];
  var pg=pick.geometry||{x:0,y:0};
  return{name:pick.name||pick.id,x:x-pg.x,y:y-pg.y};
}
// ── GNOME portal-session daemon lifecycle ──
// gnome-portal-bridge holds ONE portal RemoteDesktop+ScreenCast session per
// tool-use lock (one consent dialog; restore-token dialog-free on GNOME 46+).
// Driven by the CU lock via __setLockHeld (wired from Patches 4b/4b.2 in
// fix_computer_use_linux.nim, which call __linuxExecutor.__setLockHeld in BOTH
// kwin and regular mode). If the lock hook never fires we lazy-start on the
// first PORTAL command (input/capture — see _gnomePortalCmds; never for
// enumeration) and stop on process exit as a backstop.
var _gnomeSessionActive=!1,_gnomeExitHooked=!1,_gnomeSessionStarting=null;
async function _gnomeSessionStart(){
  var bin=_gnomeBridgeBin();if(!bin)return;
  try{await _bridgeAsync(bin,["session-start"],GNOME_SESSION_START_MS);_gnomeSessionActive=!0;_gnomePortalClearDown();globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session started")}
  catch(e){globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session-start failed: "+(e.message||e));_gnomePortalMarkDown("session-start failed")}
}
async function _gnomeSessionEnd(){
  var bin=_gnomeBridgeBin();if(!bin)return;
  try{await _bridgeAsync(bin,["session-end"],15000)}catch(e){}
  _gnomeSessionActive=!1;_gnomeSessionStarting=null;
}
// Bring the portal session up without blocking the main process. Returns a
// Promise that resolves once session-start finishes (or immediately if the
// session is already active). Concurrent callers share the in-flight promise.
function _gnomeEnsureSession(){
  if(_gnomeSessionActive)return Promise.resolve();
  if(_gnomeSessionStarting)return _gnomeSessionStarting;
  // A fresh lock is a fresh user gesture: give the portal a real retry (consent
  // dialog and all) rather than inheriting the previous session's cooldown.
  _gnomePortalClearDown();
  if(!_gnomeExitHooked){_gnomeExitHooked=!0;process.once("exit",function(){if(_gnomeSessionActive){try{_cp.execFileSync(_gnomeBridgeBin(),["session-end"],{timeout:5000,stdio:"ignore"})}catch(e){}}})}
  _gnomeSessionStarting=_gnomeSessionStart().then(function(){_gnomeSessionStarting=null},function(){_gnomeSessionStarting=null});
  return _gnomeSessionStarting;
}
function _readClean(f){var buf=_fs.readFileSync(f);try{_fs.unlinkSync(f)}catch(e){}return buf.toString("base64")}
function _findMonByPoint(px,py){
  var mons=_getMonitors();
  for(var i=0;i<mons.length;i++){var m=mons[i];if(px>=m.originX&&px<m.originX+m.width&&py>=m.originY&&py<m.originY+m.height)return m}
  for(var i=0;i<mons.length;i++){if(mons[i].isPrimary)return mons[i]}
  return mons[0];
}
// Map a root-coordinate region to the bridge monitor that contains its top-left,
// returning {name, x, y} where x/y are monitor-relative. Falls back to primary/first.
async function _x11MonForRegion(x,y){
  var screens=await _x11BridgeScreens();
  if(!screens.length)return null;
  var pick=null;
  for(var i=0;i<screens.length;i++){
    var g=screens[i].geometry||{};
    if(x>=g.x&&x<g.x+g.width&&y>=g.y&&y<g.y+g.height){pick=screens[i];break}
  }
  if(!pick){for(var j=0;j<screens.length;j++){if(screens[j].is_primary){pick=screens[j];break}}}
  if(!pick)pick=screens[0];
  var pg=pick.geometry||{x:0,y:0};
  return{name:pick.name||pick.id,x:x-pg.x,y:y-pg.y};
}
// Returns {base64, imgW, imgH, mimeType} where imgW/imgH are the EMITTED image's
// pixel dimensions (post-downscale) and mimeType is the produced format. Most
// tiers capture the region at native resolution (no downscale) and produce PNG,
// so imgW/imgH == the captured region size (w,h after scaleFactor) and
// mimeType=="image/png". The x11-bridge tier downscales (long edge <= 1568,
// total <= 1_150_000 px) and produces JPEG, so it overrides imgW/imgH with the
// bridge's returned width/height and mimeType with "image/jpeg". The handler
// uses imgW/imgH to map model image-pixel coordinates back to root pixels.
async function _captureRegion(x,y,w,h,sf){
  if(!sf){var _m=_findMonByPoint(x,y);sf=_m?_m.scaleFactor:1}
  if(sf&&sf!==1){x=Math.round(x*sf);y=Math.round(y*sf);w=Math.round(w*sf);h=Math.round(h*sf)}
  var tmp=_path.join(_os.tmpdir(),"claude-cu-"+Date.now()+"-"+Math.random().toString(36).slice(2)+".png");
  var _de=_desktopId();
  // Native (non-downscaling) tiers crop to exactly w x h at native resolution
  // and emit PNG.
  function _nativePng(b64){return{base64:b64,imgW:w,imgH:h,mimeType:"image/png"}}
  if(process.env.COWORK_SCREENSHOT_CMD){
    // Intentionally shell-evaluated: this is a user-supplied command template
    // from the user's own environment (pipes/redirects are part of the
    // contract). Only {FILE}/{X}/{Y}/{W}/{H} are substituted, all local values.
    try{var cmd=process.env.COWORK_SCREENSHOT_CMD.replace(/\{FILE\}/g,tmp).replace(/\{X\}/g,x).replace(/\{Y\}/g,y).replace(/\{W\}/g,w).replace(/\{H\}/g,h);
    _cp.execSync(cmd,{timeout:15000});globalThis.__cdbDiag("[claude-cu] screenshot: captured via COWORK_SCREENSHOT_CMD");return _nativePng(_readClean(tmp))}catch(e){globalThis.__cdbDiag("[claude-cu] COWORK_SCREENSHOT_CMD failed: "+e.message)}
  }
  // Covered Wayland sessions (wlroots / GNOME): the bundled bridge is the SOLE
  // screenshot backend (no third-party fallback, per design). Like x11-bridge,
  // the bridge returns inline base64 JPEG + its own downscaled width/height, and
  // its `zoom --display <name>` expects monitor-relative coords, so we translate
  // the global-logical region to the containing monitor first. On GNOME we ensure
  // the portal session is up (lazy backstop if the CU lock hook didn't fire).
  // NB: the bridge captures at native resolution itself, so we pass the ORIGINAL
  // logical region — undo the scaleFactor multiply applied above.
  // Hard-fail (no fallback to deleted tools) if a covered Wayland session has no
  // resolved bridge binary — this only happens if bundling broke.
  if(_isWlrootsCovered()&&!_wlrootsBridgeBin())throw new Error("wlroots-bridge missing on a wlroots-Wayland session — set WLROOTS_BRIDGE_BIN or reinstall (the bundled bridge is required; ydotool/grim fallbacks were removed).");
  if(_isGnomeCovered()&&!_gnomeBridgeBin())throw new Error("gnome-portal-bridge missing on a GNOME-Wayland session — set GNOME_PORTAL_BRIDGE_BIN or reinstall (the bundled bridge is required; ydotool/portal-screenshot fallbacks were removed).");
  var _wlb=_wayland?_wlBridge():null;
  if(_wlb){
    try{
      var _lx=Math.round(x/(sf||1)),_ly=Math.round(y/(sf||1)),_lw=Math.round(w/(sf||1)),_lh=Math.round(h/(sf||1));
      var _wmr=await _wlMonForRegion(_lx,_ly);
      var _wzargs=["zoom","--x",String(_wmr?_wmr.x:_lx),"--y",String(_wmr?_wmr.y:_ly),"--w",String(_lw),"--h",String(_lh)];
      if(_wmr&&_wmr.name){_wzargs.push("--display",_wmr.name)}
      var _wzr=await _wlBridgeCallAsync(_wzargs);
      if(_wzr&&_wzr.base64){globalThis.__cdbDiag("[claude-cu] screenshot: captured via "+_wlb.name);return{base64:_wzr.base64,imgW:_wzr.width||w,imgH:_wzr.height||h,mimeType:"image/jpeg"}}
    }catch(e){globalThis.__cdbDiag("[claude-cu] "+_wlb.name+" zoom failed: "+(e.message||e))}
    // Covered session with a resolved bridge: do NOT fall through to deleted
    // third-party tools. Last resort is the Electron desktopCapturer tier below.
    globalThis.__cdbDiag("[claude-cu] "+_wlb.name+" screenshot failed on a covered Wayland session — no third-party fallback (set COWORK_SCREENSHOT_CMD to override)");
  }
  if(_de.indexOf("kde")>=0&&_hasCmd("spectacle")){
    try{var stmp=_path.join(_os.tmpdir(),"claude-cu-spectacle-"+Date.now()+".png");
    _cp.execFileSync("spectacle",["-b","-n","-f","-o",stmp],{timeout:10000});
    if(_fs.existsSync(stmp)){try{_cp.execFileSync("convert",[stmp,"-crop",w+"x"+h+"+"+x+"+"+y,"+repage",tmp],{timeout:5000});try{_fs.unlinkSync(stmp)}catch(e){}globalThis.__cdbDiag("[claude-cu] screenshot: captured via spectacle+convert (KDE)");return _nativePng(_readClean(tmp))}catch(ce){try{_fs.renameSync(stmp,tmp)}catch(re){}globalThis.__cdbDiag("[claude-cu] screenshot: captured via spectacle (KDE, uncropped)");return _nativePng(_readClean(tmp))}}
    }catch(e){globalThis.__cdbDiag("[claude-cu] spectacle failed: "+e.message)}
  }
  // X11 (and XWayland fallback): single first-party tier — x11-bridge zoom.
  // The bridge returns inline base64 JPEG (quality 75) and its own width/height
  // (the DOWNSCALED emitted dims). We translate the root region to the containing
  // RandR monitor + monitor-relative coords, since the bridge's `zoom --display
  // <name>` expects monitor-relative x/y.
  // NOT on a covered Wayland session: x11-bridge captures the X root, and under
  // a rootless XWayland server that root holds nothing - GetImage answers with
  // BadMatch (exactly what issue #232 reported). Trying it there costs another
  // blocking timeout and buries the real bridge failure under an X11 protocol
  // error, so the covered path goes straight to the desktopCapturer last resort.
  // This is what the diagnostics line has always advertised (`!_covered` there).
  if(!_wlb&&(!_wayland||_x11BridgeBin())){
    if(_x11BridgeBin()){
      try{
        var _mr=await _x11MonForRegion(x,y);
        var _zargs=["zoom","--x",String(_mr?_mr.x:x),"--y",String(_mr?_mr.y:y),"--w",String(w),"--h",String(h)];
        if(_mr&&_mr.name){_zargs.push("--display",_mr.name)}
        var _zr=await _x11BridgeAsync(_zargs);
        if(_zr&&_zr.base64){globalThis.__cdbDiag("[claude-cu] screenshot: captured via x11-bridge"+(_wayland?" (XWayland)":""));return{base64:_zr.base64,imgW:_zr.width||w,imgH:_zr.height||h,mimeType:"image/jpeg"}}
      }catch(e){globalThis.__cdbDiag("[claude-cu] x11-bridge zoom failed: "+(e.message||e))}
    }else if(!_wayland){
      // X11 session with no bridge: hard fail (no third-party fallback, per design).
      // The Electron desktopCapturer tier below is the only remaining last resort.
      globalThis.__cdbDiag("[claude-cu] x11-bridge missing on X11 session — set X11_BRIDGE_BIN or reinstall the package - the bundled bridge is missing");
    }
  }
  try{var _sources=await _electron.desktopCapturer.getSources({types:["screen"],thumbnailSize:{width:w+x,height:h+y}});if(_sources&&_sources.length>0){var _img=_sources[0].thumbnail;if(_img&&!_img.isEmpty()){var _cropped=_img.crop({x:x,y:y,width:w,height:h});_fs.writeFileSync(tmp,_cropped.toPNG());globalThis.__cdbDiag("[claude-cu] screenshot: captured via desktopCapturer (Electron fallback)");return _nativePng(_readClean(tmp))}}}catch(dce){globalThis.__cdbDiag("[claude-cu] desktopCapturer fallback failed: "+dce.message)}
  throw new Error("Screenshot failed — on X11 reinstall the package (bundled x11-bridge missing; or set X11_BRIDGE_BIN); on wlroots/GNOME Wayland reinstall the bundled bridge; or set COWORK_SCREENSHOT_CMD.")
}
if(_wayland){globalThis.__cdbDiag("[claude-cu] Wayland session detected"+(_isWlrootsCovered()?" (wlroots — wlroots-bridge backend)":_isGnomeCovered()?" (GNOME — gnome-portal-bridge backend)":" (exotic — ydotool/x11-bridge fallback)"))}
(function(){
  var _de=_desktopId();var _wlr=_wayland?_isWlroots():false;
  var _isGnome=_de.indexOf("gnome")>=0;var _isKde=_de.indexOf("kde")>=0;
  var _wlrCovered=_isWlrootsCovered();var _gnomeCovered=_isGnomeCovered();
  var _covered=_wlrCovered||_gnomeCovered;
  // Third-party tools only matter on the residual (uncovered) paths now: exotic
  // non-wlroots/non-GNOME Wayland (ydotool) and KDE-without-kwin-bridge (spectacle
  // legacy screenshot). On covered sessions the bridge replaces all of them.
  var _relevant=[];
  if(_wayland&&!_covered)_relevant.push("ydotool");
  if(_isKde&&!globalThis.__cuKwinMode){_relevant.push("spectacle");_relevant.push("convert")}
  _relevant.push("xdg-open");
  var avail=_relevant.filter(function(t){return _hasCmd(t)});
  var missing=_relevant.filter(function(t){return !_hasCmd(t)});
  var _x11ok=!!_x11BridgeBin();
  var _wlrok=!!_wlrootsBridgeBin();var _gnok=!!_gnomeBridgeBin();
  globalThis.__cdbDiag("[claude-cu] diagnostics: session="+(_wayland?"wayland":"x11")+" de="+(_de||"unknown")+" wlroots="+_wlr+" vm="+!!globalThis.__isVM);
  // Raw session env + resolved CU mode. DE detection keys off XDG_CURRENT_DESKTOP
  // (normalized into de= above); XDG_SESSION_DESKTOP is DM-dependent and NOT used
  // for routing — printing both raw makes a KDE-Wayland routing mismatch (de=kde
  // but kwin-mode=false) diagnosable from claude-patches.log alone (issue #194).
  globalThis.__cdbDiag("[claude-cu] diagnostics: XDG_CURRENT_DESKTOP="+(process.env.XDG_CURRENT_DESKTOP||"(unset)")+" XDG_SESSION_DESKTOP="+(process.env.XDG_SESSION_DESKTOP||"(unset)")+" XDG_SESSION_TYPE="+(process.env.XDG_SESSION_TYPE||"(unset)")+" kwin-mode="+!!globalThis.__cuKwinMode);
  try{var _diagMons=_getMonitors();globalThis.__cdbDiag("[claude-cu] diagnostics: displays=["+_diagMons.map(function(m){return m.label+"("+m.width+"x"+m.height+"+"+m.originX+"+"+m.originY+" sf="+m.scaleFactor+(m.isPrimary?" primary":"")+")"}).join(", ")+"]")}catch(me){}
  globalThis.__cdbDiag("[claude-cu] diagnostics: available=["+avail.join(", ")+"]");
  if(missing.length)globalThis.__cdbDiag("[claude-cu] diagnostics: missing=["+missing.join(", ")+"] (install for the residual fallback paths)");
  globalThis.__cdbDiag("[claude-cu] diagnostics: x11-bridge="+(_x11ok?"present ("+_x11BridgeBin()+")":"absent"));
  globalThis.__cdbDiag("[claude-cu] diagnostics: wlroots-bridge="+(_wlrok?"present ("+_wlrootsBridgeBin()+")":"absent"));
  globalThis.__cdbDiag("[claude-cu] diagnostics: gnome-portal-bridge="+(_gnok?"present ("+_gnomeBridgeBin()+")":"absent"));
  // input-backend
  if(_wlrCovered){globalThis.__cdbDiag("[claude-cu] diagnostics: input-backend="+(_wlrok?"wlroots-bridge":"none (wlroots-bridge missing — reinstall)"))}
  else if(_gnomeCovered){globalThis.__cdbDiag("[claude-cu] diagnostics: input-backend="+(_gnok?"gnome-portal-bridge":"none (gnome-portal-bridge missing — reinstall)"))}
  else if(_wayland){var ydOk=_checkYdotool();globalThis.__cdbDiag("[claude-cu] diagnostics: input-backend="+(ydOk?"ydotool":(_x11ok?"x11-bridge (XWayland fallback)":"none (install ydotool or x11-bridge)")))}
  else{globalThis.__cdbDiag("[claude-cu] diagnostics: input-backend="+(_x11ok?"x11-bridge":"none (bundled x11-bridge missing - reinstall)"))}
  // screenshot-cascade
  var order=[];
  if(process.env.COWORK_SCREENSHOT_CMD)order.push("COWORK_SCREENSHOT_CMD");
  if(_wlrCovered&&_wlrok)order.push("wlroots-bridge");
  if(_gnomeCovered&&_gnok)order.push("gnome-portal-bridge");
  if(_isKde&&!globalThis.__cuKwinMode&&_hasCmd("spectacle"))order.push("spectacle");
  if(!_covered&&_x11ok)order.push("x11-bridge"+(_wayland?" (XWayland)":""));
  order.push("desktopCapturer");
  globalThis.__cdbDiag("[claude-cu] diagnostics: screenshot-cascade=["+order.join(" > ")+"]");
})();
var _defaultMon={displayId:0,width:1920,height:1080,originX:0,originY:0,scaleFactor:1,isPrimary:true,label:"default"};
function _getMonitors(){
  try{
    var displays=_electron.screen.getAllDisplays();
    if(displays&&displays.length>0){
      var primary=_electron.screen.getPrimaryDisplay();
      var primaryId=primary?primary.id:displays[0].id;
      return displays.map(function(d,idx){return{displayId:idx,width:d.size.width,height:d.size.height,originX:d.bounds.x,originY:d.bounds.y,scaleFactor:d.scaleFactor||1,isPrimary:d.id===primaryId,label:d.label||("display-"+idx)}});
    }
  }catch(ee){}
  return[_defaultMon];
}
function _findMon(displayId){
  var mons=_getMonitors();
  if(displayId!=null){
    for(var i=0;i<mons.length;i++){if(mons[i].displayId===displayId)return mons[i]}
    var displays=_electron.screen.getAllDisplays();
    for(var i=0;i<displays.length;i++){if(displays[i].id===displayId&&i<mons.length)return mons[i]}
  }
  for(var i=0;i<mons.length;i++){if(mons[i].isPrimary)return mons[i]}
  return mons[0];
}
var _inputLogDone={mouse:false,click:false,key:false,type:false,scroll:false,drag:false,window:false,app:false};
function _logFirstUse(op,backend){if(!_inputLogDone[op]){_inputLogDone[op]=true;globalThis.__cdbDiag("[claude-cu] "+op+": using "+backend)}}
// True when a covered Wayland session (wlroots/GNOME) has a resolved bridge —
// input/screenshot/windows all route through it and the ydotool path is skipped.
function _useWlBridge(){return _wayland&&!!_wlBridge()}
function _moveMouse(x,y){
  if(_useWlBridge()){
    _logFirstUse("mouse",_wlBridge().name);_wlBridgeCall(["pointer-move","--x",String(Math.round(x)),"--y",String(Math.round(y))]);return;
  }
  if(_wayland&&_checkYdotool()){
    try{_logFirstUse("mouse","ydotool");_ydotool(["mousemove","--absolute","0","0"]);_cp.execSync("sleep 0.05");_ydotool(["mousemove",String(Math.round(x)),String(Math.round(y))]);return}catch(e){globalThis.__cdbDiag("[claude-cu] ydotool mousemove failed, falling back to x11-bridge: "+e.message)}
  }else{
    if(_wayland&&!_checkYdotool())globalThis.__cdbDiag("[claude-cu] ydotool not available on Wayland, falling back to x11-bridge via XWayland");
  }
  _logFirstUse("mouse","x11-bridge");
  _x11Bridge(["pointer-move","--x",String(Math.round(x)),"--y",String(Math.round(y))]);
}
function _mapKeyWayland(k){
  var _kmap={"ctrl":29,"control":29,"leftctrl":29,"rightctrl":97,
    "alt":56,"leftalt":56,"rightalt":100,"shift":42,"leftshift":42,"rightshift":54,
    "super":125,"meta":125,"cmd":125,"command":125,"leftmeta":125,"rightmeta":126,
    "enter":28,"return":28,"backspace":14,"delete":111,"escape":1,"esc":1,"tab":15,
    "space":57,"up":103,"down":108,"left":105,"right":106,
    "home":102,"end":107,"pageup":104,"pagedown":109,"insert":110,
    "capslock":58,"numlock":69,"scrolllock":70,"pause":119,"sysrq":99,
    "f1":59,"f2":60,"f3":61,"f4":62,"f5":63,"f6":64,
    "f7":65,"f8":66,"f9":67,"f10":68,"f11":87,"f12":88,
    "a":30,"b":48,"c":46,"d":32,"e":18,"f":33,"g":34,"h":35,"i":23,"j":36,
    "k":37,"l":38,"m":50,"n":49,"o":24,"p":25,"q":16,"r":19,"s":31,"t":20,
    "u":22,"v":47,"w":17,"x":45,"y":21,"z":44,
    "1":2,"2":3,"3":4,"4":5,"5":6,"6":7,"7":8,"8":9,"9":10,"0":11,
    "minus":12,"equal":13,"leftbrace":26,"rightbrace":27,
    "semicolon":39,"apostrophe":40,"grave":41,"backslash":43,
    "comma":51,"dot":52,"slash":53,"kpasterisk":55,"kpminus":74,"kpplus":78};
  var l=k.trim().toLowerCase();
  return String(_kmap[l]||l);
}
// Full-monitor capture. Returns {base64, imgW, imgH, mimeType, displayWidth,
// displayHeight, originX, originY} — imgW/imgH are the EMITTED image dims (which
// may be downscaled below the monitor's native size); displayWidth/displayHeight
// are the monitor's native logical size. The handler needs both to map model
// image-pixel coordinates back to root pixels.
async function _screenshotMon(mon){
  var cap=await _captureRegion(mon.originX,mon.originY,mon.width,mon.height,mon.scaleFactor||1);
  return{base64:cap.base64,imgW:cap.imgW,imgH:cap.imgH,mimeType:cap.mimeType,displayWidth:mon.width,displayHeight:mon.height,originX:mon.originX||0,originY:mon.originY||0};
}
// Wayland window enumeration goes through the covered session's bridge
// (wlroots-bridge: foreign-toplevel protocols; gnome-portal-bridge: best-effort
// GNOME Shell Introspect). The old hyprctl/swaymsg+jq/niri compositor-IPC
// helpers are gone — those compositors are wlroots, i.e. covered by the bridge.
// Map an x11-bridge WindowInfo (snake_case) to the {bundleId,displayName} shape
// the executor's callers expect. Mirrors executor_linux.js normalizeBundleIdFromWindow.
function _bundleIdFromWindow(w){
  var cands=[w.desktop_file_name,w.resource_class,w.resource_name,w.id];
  for(var i=0;i<cands.length;i++){var c=cands[i];if(typeof c==="string"&&c.trim())return c.replace(/\.desktop$/i,"")}
  return null;
}
function _appRefFromWindow(w){
  if(!w)return null;
  var bid=_bundleIdFromWindow(w);
  if(!bid)return null;
  return{bundleId:bid,displayName:(typeof w.title==="string"&&w.title.trim())?w.title:bid};
}
// frontmost-app / app-under-point emit camelCase {bundleId,displayName} directly.
function _appRefFromCommand(result){
  if(!result||typeof result!=="object")return null;
  if(typeof result.bundleId!=="string"||typeof result.displayName!=="string")return null;
  return{bundleId:result.bundleId,displayName:result.displayName};
}
globalThis.__linuxExecutor={
  capabilities:{screenshotFiltering:"none",platform:"linux",hostBundleId:"claude-desktop"},
  // CU lock lifecycle hook, invoked by the upstream lock holder (Patches 4b/4b.2
  // call __linuxExecutor?.__setLockHeld?.(!0/!1) on every Linux lock transition
  // and chain .catch() — so this MUST return a Promise, hence async). On GNOME
  // this scopes the gnome-portal-bridge portal session (one consent dialog per
  // CU session; dialog-free on GNOME 46+ via restore token) to the lock.
  async __setLockHeld(held){
    if(!_isGnomeCovered()||!_gnomeBridgeBin())return;
    if(held)await _gnomeEnsureSession();else await _gnomeSessionEnd();
  },
  async listDisplays(){return _getMonitors()},
  async getDisplaySize(displayId){
    var m=_findMon(displayId);
    return{width:m.width,height:m.height,scaleFactor:m.scaleFactor,originX:m.originX||0,originY:m.originY||0};
  },
  async screenshot(opts){
    var mon=_findMon(opts&&opts.displayId);
    var shot=await _screenshotMon(mon);
    // {base64, imgW, imgH, mimeType, displayWidth, displayHeight, originX, originY}
    return shot;
  },
  async resolvePrepareCapture(opts){
    var did=opts&&opts.preferredDisplayId;
    var mon=_findMon(did);
    var shot=await _screenshotMon(mon);
    return{base64:shot.base64,mimeType:shot.mimeType,width:shot.imgW,height:shot.imgH,displayWidth:mon.width,displayHeight:mon.height,displayId:mon.displayId,originX:mon.originX,originY:mon.originY,hidden:[]};
  },
  async zoom(rect,scale,displayId){
    var mon=displayId!=null?_findMon(displayId):_findMonByPoint(rect.x,rect.y);
    var sf=mon?mon.scaleFactor:1;
    globalThis.__cdbDiag("[claude-cu] zoom: rect="+JSON.stringify(rect)+" scale="+scale+" displayId="+displayId+" mon="+((mon&&mon.label)||"?")+" sf="+sf);
    var cap=await _captureRegion(rect.x,rect.y,rect.w,rect.h,sf);
    // {base64, imgW, imgH, mimeType}
    return cap;
  },
  async prepareForAction(bundleIds,displayId){return[]},
  async previewHideSet(bundleIds,displayId){return[]},
  async findWindowDisplays(bundleIds){return[]},
  async listInstalledApps(){
    var apps=[];
    var seen={};
    function _add(bid,dname,p){var k=bid+"|"+dname.toLowerCase();if(!seen[k]){seen[k]=1;apps.push({bundleId:bid,displayName:dname,path:p})}}
    try{
      var dirs=["/usr/share/applications",_path.join(_os.homedir(),".local/share/applications"),"/var/lib/flatpak/exports/share/applications",_path.join(_os.homedir(),".local/share/flatpak/exports/share/applications")];
      for(var d=0;d<dirs.length;d++){
        try{
          var files=_fs.readdirSync(dirs[d]);
          for(var i=0;i<files.length;i++){
            if(files[i].indexOf(".desktop")===-1)continue;
            try{
              var fp=_path.join(dirs[d],files[i]);
              var content=_fs.readFileSync(fp,"utf-8");
              var nameMatch=content.match(/^Name=(.+)$/m);
              var execMatch=content.match(/^Exec=(\S+)/m);
              var iconMatch=content.match(/^Icon=(.+)$/m);
              if(nameMatch&&execMatch){
                var fullName=nameMatch[1].trim();
                var execName=execMatch[1].replace(/%.*/,"").trim();
                var baseName=_path.basename(execName);
                _add(baseName,fullName,fp);
                var parts=fullName.split(/\s+/);
                if(parts.length>1){_add(baseName,parts[0],fp)}
                _add(baseName,baseName,fp);
                if(iconMatch){
                  var icon=iconMatch[1].trim();
                  if(icon.indexOf(".")!==-1){_add(icon,fullName,fp);if(parts.length>1){_add(icon,parts[0],fp)}}
                }
                var dfn=files[i].replace(/\.desktop$/,"");
                if(dfn!==baseName){_add(dfn,fullName,fp)}
              }
            }catch(fe){}
          }
        }catch(de){}
      }
    }catch(e){}
    return apps;
  },
  async listRunningApps(){
    if(_useWlBridge()){
      try{
        var wb=_wlBridge();
        _logFirstUse("app",wb.name);
        globalThis.__cdbDiag("[claude-cu] listRunningApps: using "+wb.name+" windows");
        var wwins=_wlBridgeCall(["windows"]);
        var wapps=[],wseen={};
        if(Array.isArray(wwins)){
          for(var wi=0;wi<wwins.length;wi++){
            var ww=wwins[wi];
            if(ww.is_minimized===true)continue;
            if(ww.is_visible===false)continue;
            var wref=_appRefFromWindow(ww);
            if(wref&&!wseen[wref.bundleId]){wseen[wref.bundleId]=true;wapps.push(wref)}
          }
        }
        return wapps;
      }catch(we){globalThis.__cdbDiag("[claude-cu] bridge windows failed: "+(we.message||we));return[]}
    }
    // Exotic (uncovered) Wayland: no enumeration backend (compositor IPC was
    // wlroots-only and wlroots is covered by the bridge now).
    if(_wayland&&_checkYdotool()){return[]}
    if(_wayland&&!_x11BridgeBin()){return[]}
    // X11 / XWayland: enumerate via x11-bridge windows (EWMH).
    try{
      _logFirstUse("app","x11-bridge");
      globalThis.__cdbDiag("[claude-cu] listRunningApps: using x11-bridge windows");
      var wins=_x11Bridge(["windows"]);
      var apps=[],seen={};
      if(Array.isArray(wins)){
        for(var i=0;i<wins.length;i++){
          var w=wins[i];
          if(w.is_minimized===true)continue;
          if(w.is_visible===false)continue;
          var ref=_appRefFromWindow(w);
          if(ref&&!seen[ref.bundleId]){seen[ref.bundleId]=true;apps.push(ref)}
        }
      }
      return apps;
    }catch(e){globalThis.__cdbDiag("[claude-cu] x11-bridge windows failed: "+(e.message||e));return[]}
  },
  async getFrontmostApp(){
    if(_useWlBridge()){
      try{
        _logFirstUse("window",_wlBridge().name);
        return _appRefFromCommand(_wlBridgeCall(["frontmost-app"]));
      }catch(e){return null}
    }
    if(_wayland&&_checkYdotool()){return null}
    if(_wayland&&!_x11BridgeBin()){return null}
    try{
      _logFirstUse("window","x11-bridge");
      // frontmost-app emits camelCase {bundleId,displayName}.
      return _appRefFromCommand(_x11Bridge(["frontmost-app"]));
    }catch(e){return null}
  },
  async appUnderPoint(x,y){
    if(_useWlBridge()){
      // wlroots-bridge returns null here (no window geometry in the foreign-
      // toplevel protocols); gnome-portal-bridge is best-effort via Introspect.
      try{return _appRefFromCommand(_wlBridgeCall(["app-under-point","--x",String(Math.round(x)),"--y",String(Math.round(y))]))}catch(e){return null}
    }
    if(_wayland&&_checkYdotool())return null;
    if(_wayland&&!_x11BridgeBin())return null;
    try{
      return _appRefFromCommand(_x11Bridge(["app-under-point","--x",String(Math.round(x)),"--y",String(Math.round(y))]));
    }catch(e){return null}
  },
  async getAppIcon(appPath){return null},
  async openApp(name){
    var _appDirs=["/usr/share/applications",_path.join(_os.homedir(),".local/share/applications"),"/var/lib/flatpak/exports/share/applications",_path.join(_os.homedir(),".local/share/flatpak/exports/share/applications")];
    // Parse all .desktop entries into {name, dfn, exec} once so we can both
    // resolve the launch command and, on failure, suggest close matches.
    function _allEntries(){
      var out=[];
      for(var d=0;d<_appDirs.length;d++){
        try{
          var files=_fs.readdirSync(_appDirs[d]);
          for(var i=0;i<files.length;i++){
            if(files[i].indexOf(".desktop")===-1)continue;
            try{
              var content=_fs.readFileSync(_path.join(_appDirs[d],files[i]),"utf-8");
              var nameMatch=content.match(/^Name=(.+)$/m);
              var execMatch=content.match(/^Exec=(\S+)/m);
              if(nameMatch&&execMatch){
                out.push({name:nameMatch[1].trim(),dfn:files[i].replace(/\.desktop$/,""),exec:execMatch[1].replace(/%.*/,"").trim()});
              }
            }catch(fe){}
          }
        }catch(de){}
      }
      return out;
    }
    function _resolveApp(n,entries){
      var nl=n.toLowerCase();
      for(var i=0;i<entries.length;i++){
        var e=entries[i];
        if(e.name.toLowerCase()===nl||e.dfn.toLowerCase()===nl||_path.basename(e.exec).toLowerCase()===nl)return e.exec;
      }
      return null;
    }
    // Offer up to 3 close .desktop names for an unresolved request: prefer
    // substring hits, then fall back to shared-prefix overlap (>=3 chars) so a
    // typo like "Chromixq" still surfaces "Chromium".
    function _suggest(nl,entries){
      if(!nl)return[];
      var sub=[],pre=[];
      function _shared(a,b){var n=Math.min(a.length,b.length),k=0;while(k<n&&a[k]===b[k])k++;return k}
      for(var i=0;i<entries.length;i++){
        var nm=entries[i].name,en=nm.toLowerCase(),ed=entries[i].dfn.toLowerCase();
        if(en.indexOf(nl)>=0||nl.indexOf(en)>=0||ed.indexOf(nl)>=0){if(sub.indexOf(nm)<0)sub.push(nm);continue}
        if(_shared(en,nl)>=3||_shared(ed,nl)>=3){if(pre.indexOf(nm)<0)pre.push(nm)}
      }
      return sub.concat(pre).slice(0,3);
    }
    // Window-capable bridge: covered Wayland sessions use their bridge
    // (wlroots: foreign-toplevel windows+activate on Sway/Hyprland/Niri; GNOME:
    // best-effort Introspect, activate-window unsupported), X11/XWayland uses
    // x11-bridge. Exotic Wayland keeps the legacy launch-only behavior.
    function _winCall(args){return _useWlBridge()?_wlBridgeCall(args):_x11Bridge(args)}
    var _bridgeOk;
    if(_useWlBridge()){
      // Probe once: if the bridge cannot enumerate windows here (e.g. GNOME with
      // Introspect blocked, or an empty desktop), skip the activate/poll dance so
      // we don't burn 5s polling a source that yields nothing.
      _bridgeOk=false;
      try{var _wprobe=_wlBridgeCall(["windows"]);_bridgeOk=Array.isArray(_wprobe)&&_wprobe.length>0}catch(wpe){}
    }else{
      _bridgeOk=(!_wayland||_x11BridgeBin())&&!(_wayland&&_checkYdotool());
    }
    // Normalize the requested string for case-insensitive matching, stripping a
    // trailing .desktop so "firefox.desktop" and "firefox" both work.
    function _norm(s){return typeof s==="string"?s.trim().toLowerCase().replace(/\.desktop$/,""):""}
    // Rank an existing window against the request. Exact desktop_file_name /
    // resource_class / resource_name match ranks highest (3), title-prefix
    // lowest (1); 0 = no match. Dock/desktop windows are skipped by the caller.
    function _matchScore(w,nl){
      if(!nl)return 0;
      var dfn=_norm(w.desktop_file_name),rc=_norm(w.resource_class),rn=_norm(w.resource_name);
      if(dfn===nl||rc===nl||rn===nl)return 3;
      // partial class/name containment (e.g. request "code", class "Code")
      if((dfn&&dfn.indexOf(nl)>=0)||(rc&&rc.indexOf(nl)>=0)||(rn&&rn.indexOf(nl)>=0))return 2;
      var title=typeof w.title==="string"?w.title.trim().toLowerCase():"";
      if(title&&title.indexOf(nl)===0)return 1;
      return 0;
    }
    function _findWindow(nl){
      var wins;
      try{wins=_winCall(["windows"])}catch(e){globalThis.__cdbDiag("[claude-cu] openApp: bridge windows failed: "+(e.message||e));return null}
      if(!Array.isArray(wins))return null;
      var best=null,bestScore=0;
      for(var i=0;i<wins.length;i++){
        var w=wins[i];
        if(w.is_dock===true||w.is_desktop===true)continue;
        var s=_matchScore(w,nl);
        // Prefer higher score; tie-break toward the active window.
        if(s>bestScore||(s>0&&s===bestScore&&w.is_active===true&&(!best||best.is_active!==true))){best=w;bestScore=s}
      }
      return best;
    }
    function _activate(w){
      var wid=String(w.id);
      _winCall(["activate-window","--window",wid]);
      var _bid=_bundleIdFromWindow(w)||wid;
      var _title=(typeof w.title==="string"&&w.title.trim())?w.title:_bid;
      return{action:"activated",app:_bid,windowTitle:_title};
    }
    var nl=_norm(name);
    // 1) Existing window? Activate it — no launch, no duplicate instance.
    if(_bridgeOk&&nl){
      var existing=_findWindow(nl);
      if(existing){
        globalThis.__cdbDiag("[claude-cu] openApp: activating existing window for "+name+" (id "+existing.id+")");
        // activate-window is unsupported on gnome-portal-bridge — on failure fall
        // through to the launch path (GIO single-instance apps refocus on launch).
        try{return _activate(existing)}
        catch(ae){globalThis.__cdbDiag("[claude-cu] openApp: activate failed ("+(ae.message||ae)+") — launching instead")}
      }
    }
    // 2) Resolve + launch. If the name doesn't resolve to a .desktop entry and
    // doesn't look like a file/URL, refuse and suggest close matches instead of
    // xdg-open'ing garbage.
    var entries=_allEntries();
    var resolved=_resolveApp(name,entries);
    var _looksLikePathOrUrl=/^[a-z][a-z0-9+.-]*:\/\//i.test(name)||name.indexOf("/")>=0||name.indexOf(".")>=0;
    if(!resolved&&!_looksLikePathOrUrl){
      var cands=_suggest(nl,entries);
      return{action:"not_found",app:name,suggestions:cands,isError:true};
    }
    if(!resolved){
      // Path/URL: hand to xdg-open and return — polling for a matching window is
      // meaningless (it may open a tab in an already-running handler).
      globalThis.__cdbDiag("[claude-cu] openApp: name looks like a path/URL — setsid xdg-open "+name);
      try{_launchDetached(["xdg-open",name])}
      catch(e2){throw new Error("Could not open "+name)}
      // xdg-open may open a tab in an already-running handler; we never verify a
      // window, so report the neutral "opened" (handler -> "Opened <name>").
      return{action:"opened",app:name};
    }
    try{
      globalThis.__cdbDiag("[claude-cu] openApp: launching via setsid "+resolved);
      _launchDetached([resolved]);
    }catch(e){
      try{globalThis.__cdbDiag("[claude-cu] openApp: fallback to xdg-open "+name);_launchDetached(["xdg-open",name])}
      catch(e2){throw new Error("Could not open "+name+" (resolved to "+resolved+")")}
    }
    // 3) On the bridge path, poll briefly for a matching new window and activate
    // it. Slow-starting apps that never show a window within the budget are NOT
    // an error — return launch_attempted so the model knows to screenshot.
    if(_bridgeOk&&nl){
      var _deadline=Date.now()+5000;
      while(Date.now()<_deadline){
        try{_cp.execSync("sleep 0.5")}catch(se){}
        var appeared=_findWindow(nl);
        if(appeared){
          globalThis.__cdbDiag("[claude-cu] openApp: new window appeared for "+name+" (id "+appeared.id+")");
          try{var r=_activate(appeared);r.action="launched";return r}
          catch(ae2){return{action:"launched",app:_bundleIdFromWindow(appeared)||name}}
        }
      }
      return{action:"launch_attempted",app:name,note:"no window appeared within 5s"};
    }
    // Launch-only fallback (exotic Wayland, or a covered session whose bridge
    // could not enumerate windows): distinct "opened" action so the handler
    // emits the original "Opened app" text byte-for-byte.
    return{action:"opened",app:name};
  },
  async moveMouse(x,y){_moveMouse(x,y)},
  async click(x,y,button,count,holdKeys){
    _moveMouse(x,y);
    var rep=count||1;
    if(_useWlBridge()){
      _logFirstUse("click",_wlBridge().name);
      var _wbtn={left:"left",right:"right",middle:"middle"}[button]||"left";
      var _wcargs=["pointer-click","--x",String(Math.round(x)),"--y",String(Math.round(y)),"--button",_wbtn,"--count",String(rep)];
      if(holdKeys&&holdKeys.length>0){for(var i=0;i<holdKeys.length;i++){_wcargs.push("--modifier",holdKeys[i])}}
      _wlBridgeCall(_wcargs);
    }else if(_wayland&&_checkYdotool()){
      _logFirstUse("click","ydotool");
      var ybtn={left:"0xC0",right:"0xC1",middle:"0xC2"}[button]||"0xC0";
      if(holdKeys&&holdKeys.length>0){
        var downParts=[],upParts=[];
        for(var i=0;i<holdKeys.length;i++){var mk=_mapKeyWayland(holdKeys[i]);downParts.push(mk+":1");upParts.unshift(mk+":0")}
        _ydotool(["key"].concat(downParts));
        for(var _ri=0;_ri<rep;_ri++){if(_ri>0)_cp.execSync("sleep 0.05");_ydotool(["click",ybtn])}
        _ydotool(["key"].concat(upParts));
      }else{
        for(var _ri=0;_ri<rep;_ri++){if(_ri>0)_cp.execSync("sleep 0.05");_ydotool(["click",ybtn])}
      }
    }else{
      _logFirstUse("click","x11-bridge");
      var btnName={left:"left",right:"right",middle:"middle"}[button]||"left";
      var _cargs=["pointer-click","--x",String(Math.round(x)),"--y",String(Math.round(y)),"--button",btnName,"--count",String(rep)];
      if(holdKeys&&holdKeys.length>0){for(var i=0;i<holdKeys.length;i++){_cargs.push("--modifier",holdKeys[i])}}
      _x11Bridge(_cargs);
    }
  },
  async mouseDown(){
    if(_useWlBridge()){_logFirstUse("drag",_wlBridge().name);_wlBridgeCall(["left-mouse-down"])}
    else if(_wayland&&_checkYdotool()){_logFirstUse("drag","ydotool");_ydotool(["click","0x40"])}
    else{_logFirstUse("drag","x11-bridge");_x11Bridge(["left-mouse-down"])}
  },
  async mouseUp(){
    if(_useWlBridge()){_wlBridgeCall(["left-mouse-up"])}
    else if(_wayland&&_checkYdotool()){_ydotool(["click","0x80"])}
    else{_x11Bridge(["left-mouse-up"])}
  },
  async getCursorPosition(){
    var p=_electron.screen.getCursorScreenPoint();
    return{x:p.x,y:p.y};
  },
  async drag(start,end){
    if(_useWlBridge()){
      _logFirstUse("drag",_wlBridge().name);
      var _wfx=start?Math.round(start.x):Math.round(_electron.screen.getCursorScreenPoint().x);
      var _wfy=start?Math.round(start.y):Math.round(_electron.screen.getCursorScreenPoint().y);
      _wlBridgeCall(["pointer-drag","--from-x",String(_wfx),"--from-y",String(_wfy),"--to-x",String(Math.round(end.x)),"--to-y",String(Math.round(end.y))]);
    }else if(_wayland&&_checkYdotool()){
      if(start)_moveMouse(start.x,start.y);
      _logFirstUse("drag","ydotool");
      _ydotool(["click","0x40"]);
      _ydotool(["mousemove","--absolute","0","0"]);_cp.execSync("sleep 0.05");_ydotool(["mousemove",String(Math.round(end.x)),String(Math.round(end.y))]);
      _cp.execSync("sleep 0.05");
      _ydotool(["click","0x80"]);
    }else{
      _logFirstUse("drag","x11-bridge");
      var fromX=start?Math.round(start.x):Math.round(_electron.screen.getCursorScreenPoint().x);
      var fromY=start?Math.round(start.y):Math.round(_electron.screen.getCursorScreenPoint().y);
      _x11Bridge(["pointer-drag","--from-x",String(fromX),"--from-y",String(fromY),"--to-x",String(Math.round(end.x)),"--to-y",String(Math.round(end.y))]);
    }
  },
  async scroll(x,y,horizontal,vertical){
    _moveMouse(x,y);
    if(_useWlBridge()){
      _logFirstUse("scroll",_wlBridge().name);
      var _wdx=horizontal?Math.round(horizontal):0;
      var _wdy=vertical?Math.round(vertical):0;
      if(_wdx!==0||_wdy!==0){_wlBridgeCall(["pointer-scroll","--x",String(Math.round(x)),"--y",String(Math.round(y)),"--dx",String(_wdx),"--dy",String(_wdy)])}
    }else if(_wayland&&_checkYdotool()){
      _logFirstUse("scroll","ydotool");
      if(vertical&&vertical!==0){var vamt=-Math.round(vertical);_ydotool(["mousemove","-w","--","0",String(vamt)])}
      if(horizontal&&horizontal!==0){var hamt=Math.round(horizontal);_ydotool(["mousemove","-w","--",String(hamt),"0"])}
    }else{
      _logFirstUse("scroll","x11-bridge");
      var dx=horizontal?Math.round(horizontal):0;
      var dy=vertical?Math.round(vertical):0;
      if(dx!==0||dy!==0){_x11Bridge(["pointer-scroll","--x",String(Math.round(x)),"--y",String(Math.round(y)),"--dx",String(dx),"--dy",String(dy)])}
    }
  },
  async key(combo,count){
    var n=count||1;
    if(_useWlBridge()){
      // Both Wayland bridges parse the CU key-spec grammar themselves — pass through.
      _logFirstUse("key",_wlBridge().name);
      var _wkargs=["key-sequence","--keys",combo];
      if(n>1){_wkargs.push("--repeat",String(n))}
      _wlBridgeCall(_wkargs);
    }else if(_wayland&&_checkYdotool()){
      _logFirstUse("key","ydotool");
      var parts=combo.split("+").map(_mapKeyWayland);
      if(parts.length===1){
        for(var i=0;i<n;i++){if(i>0)_cp.execSync("sleep 0.008");_ydotool(["key",parts[0]+":1",parts[0]+":0"])}
      }else{
        var downSeq=[],upSeq=[];
        for(var j=0;j<parts.length;j++){downSeq.push(parts[j]+":1");upSeq.unshift(parts[j]+":0")}
        var seq=["key"].concat(downSeq,upSeq);
        for(var i=0;i<n;i++){if(i>0)_cp.execSync("sleep 0.008");_ydotool(seq)}
      }
    }else{
      // x11-bridge parses the CU key-spec grammar itself — pass the raw combo through.
      _logFirstUse("key","x11-bridge");
      var _kargs=["key-sequence","--keys",combo];
      if(n>1){_kargs.push("--repeat",String(n))}
      _x11Bridge(_kargs);
    }
  },
  async holdKey(keyName,seconds){
    var secs=Math.min(seconds||0.5,10);
    if(_useWlBridge()){
      _logFirstUse("key",_wlBridge().name);
      _wlBridgeCall(["hold-key","--key",keyName,"--duration-ms",String(Math.round(secs*1000))]);
    }else if(_wayland&&_checkYdotool()){
      _logFirstUse("key","ydotool");
      var k=_mapKeyWayland(keyName);
      _ydotool(["key",k+":1"]);
      _cp.execFileSync("sleep",[String(secs)]);
      _ydotool(["key",k+":0"]);
    }else{
      _logFirstUse("key","x11-bridge");
      _x11Bridge(["hold-key","--key",keyName,"--duration-ms",String(Math.round(secs*1000))]);
    }
  },
  async type(text,opts){
    if(_useWlBridge()){
      _logFirstUse("type",_wlBridge().name+(opts&&opts.viaClipboard?" (clipboard)":""));
      if(opts&&opts.viaClipboard){
        await _electron.clipboard.writeText(text,"clipboard");
        _wlBridgeCall(["key-sequence","--keys","ctrl+v"]);
      }else{
        _wlBridgeCall(["type","--text",text]);
      }
    }else if(_wayland&&_checkYdotool()){
      _logFirstUse("type","ydotool"+(opts&&opts.viaClipboard?" (clipboard)":""));
      if(opts&&opts.viaClipboard){
        await _electron.clipboard.writeText(text,"clipboard");
        _ydotool(["key","29:1","47:1","47:0","29:0"]);
      }else{
        _ydotool(["type","--",text]);
      }
    }else{
      _logFirstUse("type","x11-bridge"+(opts&&opts.viaClipboard?" (clipboard)":""));
      if(opts&&opts.viaClipboard){
        await _electron.clipboard.writeText(text,"clipboard");
        _x11Bridge(["key-sequence","--keys","ctrl+v"]);
      }else{
        _x11Bridge(["type","--text",text]);
      }
    }
  },
  // Electron 44 (v1.49585.0+) made clipboard.readText/writeText Promise-returning;
  // awaiting is a no-op on older sync builds and mandatory now (paste must not fire
  // before the write lands, and a rejection must stay inside the try).
  async readClipboard(){
    try{return (await _electron.clipboard.readText("clipboard"))||""}
    catch(e){return""}
  },
  async writeClipboard(text){
    await _electron.clipboard.writeText(text||"","clipboard");
  }
};
})();

(function(){
var _cp=require("child_process"),_path=require("path"),_fs=require("fs"),_os=require("os"),_electron=require("electron");

// Run ydotool without a shell. Typed text and key names are model-supplied;
// concatenating them into an execSync shell string would let $(...), backticks
// etc. expand (JSON.stringify quoting is NOT shell quoting).
function _ydotool(args){return _cp.execFileSync(_toolCmd("ydotool")||"ydotool",args,{encoding:"utf-8",timeout:15000})}
// Launch a command detached without a shell, fire-and-forget (replaces the
// old `setsid ... >/dev/null 2>&1` shell strings). stdio:"ignore" matches the
// old /dev/null redirect — execFile would pipe+buffer instead and SIGTERM the
// app once its lifetime output passed maxBuffer (setsid execs the app in
// place, so the kill would hit the app itself). Spawn failures still surface
// via the error event; unref() lets the child outlive us.
// args[0] is a tool we pick (xdg-open for a URL or path), taken from the TOOL
// PATH like setsid. Its env is the TOOL PATH too, never the APP PATH: xdg-open
// runs xdg-mime, gio, kde-open, exo-open ... by bare name, and a URL is opened
// with the PATH upstream's own shell.openExternal uses. Only when BOTH commands
// are absolute does the spawn get an env of ours; a bare-name fallback (a tool
// not found) inherits the narrowed env, exactly as before - a bare name next to
// a wider PATH could pick a planted copy (see _envFor).
function _launchDetached(args){
  var a=args.slice(),o={detached:true,stdio:"ignore"},ss=_toolCmd("setsid"),x=_toolCmd(a[0]);
  if(ss&&x&&ss.charAt(0)==="/"&&x.charAt(0)==="/"){a[0]=x;var te=_envFor("tool");if(te)o.env=te}
  else ss="setsid";
  var c=_cp.spawn(ss,a,o);
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
// In target mode (_tgt, below) the target's kind replaces session detection:
// only its bridge resolves, GNOME is never "covered" (no portal session, no
// consent dialog on the user's desktop).
function _wlrootsBridgeBin(){if(_tgt)return _tgt.kind==="wlroots"?_tgt.bin:null;return process.env.WLROOTS_BRIDGE_BIN||globalThis.__cuWlrootsBridgeBin}
function _gnomeBridgeBin(){return process.env.GNOME_PORTAL_BRIDGE_BIN||globalThis.__cuGnomeBridgeBin}
function _isWlrootsCovered(){return _tgt?_tgt.kind==="wlroots":_wayland&&_isWlroots()}
function _isGnomeCovered(){return !_tgt&&_isGnomeWayland()}
// ── Background display target (issue #300) ──
// Settings -> Extra -> Cowork (Linux) -> "Computer Use on a background display" points
// Computer Use at a second, invisible display (Xvfb/Xephyr -> x11-bridge,
// headless/nested wlroots -> wlroots-bridge). globalThis.__cuTargetRead
// (cu_mode_preamble.js) reads the setting; it is latched here at startup and on
// every CU lock acquire, never mid-turn. _tgt: null = the user's desktop, as
// before. Otherwise {kind,display,bin,env,refuse,why}: env is the overlay every
// bridge spawn gets (_targetEnv), refuse the text every tool call returns while
// the setting is invalid, the bridge is missing or the display does not answer
// `screens` (why: "invalid"|"bridge"|"down"). Target mode FAILS CLOSED: no
// ydotool, spectacle, desktopCapturer, GNOME portal session or host
// clipboard - nothing ever falls back to the user's desktop.
var _tgt=null;
var _CU_TGT_OFF="turn off Settings -> Extra -> Cowork (Linux) -> Computer Use on a background display.";
// Target clipboard. The Electron clipboard is the user's desktop clipboard and
// is never touched in target mode; the target's own selection is read and
// written with xclip (else xsel) on an x11 target, wl-copy / wl-paste on a
// wlroots one - looked up on PATH per call (installed later = usable without a
// restart), run async with a timeout in the target's environment. Neither
// found -> the tool is refused with what to install. The writers fork and keep
// owning the selection, so the write waits for the parent's exit only.
var CU_TGT_CLIP_MS=5000;
// open_application on the target: how long a new window may take to appear.
var TGT_LAUNCH_MS=15000;
function _tgtClip(write){
  if(_tgt.refuse)throw _tgtErr();
  // t = [command to spawn (absolute while upstream narrows PATH), args, tool name].
  var x=_tgt.kind==="x11",c,t=null,wl=write?"wl-copy":"wl-paste";
  if(x){if(c=_toolCmd("xclip",!0))t=[c,write?["-selection","clipboard","-in"]:["-selection","clipboard","-out"],"xclip"];else if(c=_toolCmd("xsel",!0))t=[c,write?["--clipboard","--input"]:["--clipboard","--output"],"xsel"]}
  else if(c=_toolCmd(wl,!0))t=[c,write?[]:["--no-newline","--type","text"],wl];
  if(!t){var e=new Error("The clipboard tools need "+(x?"xclip or xsel":"wl-clipboard (wl-copy and wl-paste)")+" to use the clipboard of the background display "+_tgt.display+" - ask the user to install "+(x?"the xclip package":"the wl-clipboard package")+", or type the text instead."+_toolIgnoredMsg(x?["xclip","xsel"]:[wl]));e.__cdbSurface=!0;throw e}
  return t;
}
function _tgtClipRead(){
  var t=_tgtClip(!1);
  return new Promise(function(resolve,reject){
    _cp.execFile(t[0],t[1],{encoding:"utf-8",timeout:CU_TGT_CLIP_MS,maxBuffer:16*1024*1024,env:_envFor("tool")},function(err,out,se){
      // An empty selection is not an error to the model.
      if(err){if(/nothing is copied|no suitable type|no selection|not available|no clipboard/i.test(String(se||"")+String(err.message||"")))resolve("");else reject(new Error(t[2]+" failed: "+String(se||err.message||err).trim()));return}
      resolve(out||"");
    });
  });
}
// xsel forks into the background BEFORE it owns the selection: a paste right
// after the write can still read the old text. Read it back (short, bounded,
// async) before returning. xclip and wl-copy own it when the parent exits.
function _tgtClipWrite(text){
  var t=_tgtClip(!0);
  var p=_tgtClipSpawn(t,text);
  if(t[2]!=="xsel")return p;
  return p.then(function(){
    var n=0;
    function again(){return _tgtClipRead().then(function(v){if(v===String(text))return;if(++n>=XSEL_READBACK_TRIES)throw new Error("xsel did not take the clipboard of the background display within "+XSEL_READBACK_TRIES*100+" ms");return new Promise(function(r){setTimeout(r,100)}).then(again)})}
    return again();
  });
}
var XSEL_READBACK_TRIES=20;
function _tgtClipSpawn(t,text){
  return new Promise(function(resolve,reject){
    var done=!1,c,tm;
    function fin(e){if(done)return;done=!0;clearTimeout(tm);if(e)reject(e);else resolve()}
    try{c=_cp.spawn(t[0],t[1],{stdio:["pipe","ignore","ignore"],env:_envFor("tool")})}catch(se){fin(se);return}
    tm=setTimeout(function(){try{c.kill("SIGKILL")}catch(ke){}fin(new Error(t[2]+" did not finish within "+CU_TGT_CLIP_MS/1000+" s"))},CU_TGT_CLIP_MS);
    c.on("error",function(e){fin(new Error(t[2]+": "+(e.message||e)))});
    c.on("exit",function(code){fin(code?new Error(t[2]+" exited with code "+code):null)});
    try{c.stdin.on("error",function(){});c.stdin.end(String(text))}catch(we){fin(we)}
  });
}
function _tgtDownMsg(d){return"Computer Use is set to the background display "+(d||"(none)")+", which is not running. Start it, or "+_CU_TGT_OFF}
// The overlay: the target's display var set, the other one unset, and the
// toolkits pinned to the target's protocol - all unless the setting's env map
// supplies the var. The map never carries PATH, CLAUDE_ELECTRON or LD_*
// (validated by __cuTargetRead); the display var and XDG_SESSION_TYPE are
// always the target's. PATH is set per spawn (_envFor): the APP PATH for the
// app a launch starts, the TOOL PATH for the bridge and the clipboard tools.
// x11 target: with WAYLAND_DISPLAY unset libwayland still connects to
// $XDG_RUNTIME_DIR/wayland-0 - the user's desktop on most Wayland sessions -
// and GTK3/GTK4 and Wayland-only apps opened there (measured: headless sway on
// wayland-0 + Xvfb target, issue #300 T4 review). An EMPTY WAYLAND_SOCKET makes
// every libwayland connect fail without a fallback (Wayland-only apps such as
// foot fail instead of opening on the desktop), while toolkits that pick a
// backend by WAYLAND_DISPLAY / non-empty WAYLAND_SOCKET (winit, glfw, Firefox,
// Chromium) see no Wayland and use X11. The per-toolkit X11 pins on top are
// defence in depth. wlroots target: Electron < 38 defaults to X11 (and fails
// with DISPLAY unset), so its hint is pinned to wayland; GTK/Qt follow
// WAYLAND_DISPLAY already.
// ── PATH: the app's vs. our own tools ──
// Upstream (v4.23118) narrows process.env.PATH at startup to a fixed list of
// system dirs (/usr/local/bin and /usr/local/sbin only when root-owned and
// read-only, then /usr/bin:/bin:/usr/sbin:/sbin:/snap/bin:
// /run/current-system/sw/bin:/run/current-system/profile/bin), stores it in
// CLAUDE_DESKTOP_NARROWED_PATH and the PATH it was started with in
// CLAUDE_DESKTOP_STARTED_PATH: a tool the app runs by itself must not come from
// a folder the user - or anything running as the user - can write. Its remote
// flag 1358805273 can put the started PATH back at run time, so everything
// here reads the env per call, never at load. Two PATHs, by purpose:
//   APP PATH (_startedPath / _lookupPath) - the app the model asked to open:
//     its Exec argv[0], TryExec, the exe-identity index, and PATH in the env of
//     that app and of the desktop launcher tool that resolves Exec= for us
//     (gio, gtk-launch, ...). The started PATH, absolute entries only (a
//     relative one would resolve against our cwd), narrowed dirs appended - what
//     the desktop's own launcher uses, so a bare Exec= from a per-user profile
//     (~/.local/bin, ~/.nix-profile/bin, /etc/profiles/per-user/<u>/bin)
//     resolves again, on the desktop and on a background display alike.
//   TOOL PATH (_toolCmd / _toolPath) - every helper WE choose to run (setsid,
//     clipboard tools, gio, ydotool, ...): the narrowed dirs, then the started
//     dirs that pass upstream's trust rule (_dirTrusted - which keeps the Nix
//     store dirs of our NixOS wrapper). A helper is spawned by the absolute path
//     found, so the PATH in the child's env never picks the binary.
// Narrowing not in effect (an upstream without it, or the flag restored the
// started PATH): process.env.PATH for both and tools by bare name, as before.
//
// The started PATH while upstream's narrowing is in effect, else null. Mirrors
// upstream's own test: PATH still equal to the narrowed one.
function _startedRaw(){
  var s=process.env.CLAUDE_DESKTOP_STARTED_PATH,p=process.env.PATH;
  return typeof s==="string"&&typeof p==="string"&&p===process.env.CLAUDE_DESKTOP_NARROWED_PATH&&s!==p?s:null;
}
function _absDirs(s){var out=[],seen={};String(s||"").split(":").forEach(function(d){if(d.charAt(0)==="/"&&!seen[d]){seen[d]=1;out.push(d)}});return out}
// APP PATH; null when narrowing is not in effect.
function _startedPath(){
  var s=_startedRaw();if(s===null)return null;
  var d=_absDirs(s+":"+process.env.PATH);return d.length?d.join(":"):null;
}
// The PATH an app lookup walks (the same PATH its spawn gets, so a lookup and
// the spawn after it agree).
function _lookupPath(){return _startedPath()||process.env.PATH||""}
var _X_OK=(_fs.constants&&_fs.constants.X_OK)||1,_W_OK=(_fs.constants&&_fs.constants.W_OK)||2;
function _xfile(c){try{_fs.accessSync(c,_X_OK);return!_fs.statSync(c).isDirectory()}catch(e){return!1}}
// PATH walk with an X_OK check - the lookup execvp itself does. Relative
// entries are skipped. Absolute path or null.
function _walk(dirs,bin){for(var i=0;i<dirs.length;i++){if(dirs[i].charAt(0)!=="/")continue;var c=_path.join(dirs[i],bin);if(_xfile(c))return c}return null}
// Upstream's trust rule for a dir (index.pre.js): lstat says directory, uid 0,
// and a W_OK check fails with EACCES / EROFS. st: an lstat result in hand.
function _trustRule(d,st){
  try{st=st||_fs.lstatSync(d);if(!st.isDirectory()||st.uid!==0)return!1}catch(e){return!1}
  try{_fs.accessSync(d,_W_OK);return!1}catch(e){return!!e&&(e.code==="EACCES"||e.code==="EROFS")}
}
// A started-PATH entry -> the real dir to take tools from, when the entry AS
// WRITTEN is trustworthy all the way, else null. Walked component by component
// from "/": every directory passed through must pass the rule, and every
// symlink hop must be owned by root and sit in a directory that passed it - so
// only root can change where the entry leads. /etc/profiles/per-user/<u>/bin
// (root's link into /nix/store), /run/current-system/sw/bin and a Bazzite-style
// /usr/local -> /var/usrlocal link pass; ~/.nix-profile/bin does not (the user
// owns that link and the dir holding it, and repoints it with nix-env / nix
// profile). Upstream judges only fixed system dirs (lstat, no symlinks); ours
// can be anywhere, hence the whole chain, the real dir's ancestors included.
function _chainReal(p){
  if(!_trustRule("/"))return null;
  var cur="/",q=p.split("/").filter(Boolean),hops=0;
  while(q.length){
    var n=q.shift();if(n===".")continue;
    if(n===".."){cur=_path.dirname(cur);continue}
    var nx=_path.join(cur,n),st;try{st=_fs.lstatSync(nx)}catch(e){return null}
    if(st.isSymbolicLink()){
      // cur, the dir holding the link, already passed the rule.
      if(++hops>40||st.uid!==0)return null;
      var t;try{t=String(_fs.readlinkSync(nx))}catch(e){return null}
      if(t.charAt(0)==="/")cur="/";
      q=t.split("/").filter(Boolean).concat(q);continue;
    }
    if(!_trustRule(nx,st))return null;
    cur=nx;
  }
  return cur;
}
// Verdict cached per entry string: a trusted chain cannot change without root,
// and an untrusted verdict can only be stale on the safe side. fresh (launch
// pre-checks, the clipboard tools) walks the chain again, so a link repointed
// since is seen. The tool lookups (_toolCmd) cache the real path found, not
// the entry: a spawn never follows the entry's links again.
var _dirTrust={};
function _dirTrusted(d,fresh){
  if(fresh||!Object.prototype.hasOwnProperty.call(_dirTrust,d))_dirTrust[d]=_chainReal(d);
  return _dirTrust[d];
}
// TOOL PATH as a string (env PATH of the target's bridge / clipboard tools and
// of URL opening): the narrowed dirs, then the trusted started dirs (real paths).
function _toolPath(){
  var s=_startedRaw(),P=process.env.PATH||"";if(s===null)return P;
  var out=_absDirs(P);
  _absDirs(s).forEach(function(d){if(out.indexOf(d)>=0)return;var r=_dirTrusted(d);if(r&&out.indexOf(r)<0)out.push(r)});
  return out.join(":");
}
// A helper we run -> what to spawn: its absolute path while upstream narrows
// PATH (narrowed dirs first, then trusted started dirs), its bare name when it
// does not (as before), null when it is missing. A helper present only in a
// started dir that fails the rule (~/.local/bin/wl-copy) is missing; that is
// logged once per tool and named by _toolIgnoredMsg. Cached per (PATH, started
// PATH, tool): a hit for good, a miss for MISS_TTL_MS only, so a tool
// installed while the app runs is seen a few seconds later without a restart
// (the old bare-name spawn saw it at once). fresh bypasses the cache (launch
// pre-checks, the clipboard tools: seen at once).
var MISS_TTL_MS=5000;
var _toolCache={},_toolMissAt={},_toolIgn={},_toolSaid={};
function _toolCmd(bin,fresh){
  var s=_startedRaw(),P=process.env.PATH||"",ck=P+"\0"+(s===null?"":s)+"\0"+bin;
  if(fresh)delete _toolCache[ck];
  var c=_toolCache[ck];
  if(c!==void 0&&(c!==null||Date.now()-_toolMissAt[ck]<MISS_TTL_MS))return c;
  var r=null;
  if(s===null)r=_walk(P.split(":"),bin)?bin:null;
  else{
    r=_walk(P.split(":"),bin);
    var ign=null,sd=_absDirs(s);
    for(var i=0;!r&&i<sd.length;i++){
      if(!_xfile(_path.join(sd[i],bin)))continue;
      var rd=_dirTrusted(sd[i],fresh);
      if(rd&&_xfile(_path.join(rd,bin)))r=_path.join(rd,bin);else if(!ign)ign=sd[i];
    }
    if(r&&!_toolSaid[bin+"\0"+r]&&P.split(":").indexOf(_path.dirname(r))<0){_toolSaid[bin+"\0"+r]=1;globalThis.__cdbDiag("[claude-cu] tools: "+bin+" -> "+r+" (a root-owned read-only folder on the PATH Claude Desktop was started with)")}
    if(r)delete _toolIgn[bin];
    else if(ign){_toolIgn[bin]=ign;if(!_toolSaid[bin+"\0"+ign]){_toolSaid[bin+"\0"+ign]=1;globalThis.__cdbDiag("[claude-cu] tools: "+bin+" found only in "+ign+", a user-writable folder - ignored (Computer Use runs its own tools only from system folders)")}}
  }
  _toolCache[ck]=r;if(r===null)_toolMissAt[ck]=Date.now();return r;
}
// " (<tool> was found in <dir>, a user-writable folder, ...)" for the tools of
// a "missing" message that were ignored, else "".
function _toolIgnoredMsg(bins){
  var o=[];bins.forEach(function(b){if(_toolIgn[b])o.push(b+" in "+_toolIgn[b])});
  return o.length?" (found "+o.join(", ")+" - a user-writable folder, which Computer Use ignores for the tools it runs itself)":"";
}
// env option for a spawn: kind "app" -> APP PATH, "tool" -> TOOL PATH. Target
// mode: the overlay; desktop: process.env. null = no env option (inherit):
// desktop mode with no narrowing in effect, exactly as before. The overlay
// itself is returned when its PATH is already the one wanted.
// Invariant for every caller: a PATH wider than the narrowed one goes only to a
// spawn whose own commands are absolute (_toolCmd while narrowing); the only
// bare names resolved on the APP PATH are the app the user asked for (its Exec
// argv[0]), $TERMINAL and COWORK_SCREENSHOT_CMD - commands the user named.
function _envFor(kind){
  var base=_tgt&&_tgt.env||null,s=_startedRaw(),P=s===null?process.env.PATH:kind==="app"?_startedPath():_toolPath();
  if(!base&&s===null)return null;
  if(base&&base.PATH===P)return base;
  var e={},k,src=base||process.env;for(k in src)e[k]=src[k];
  if(typeof P==="string")e.PATH=P;else delete e.PATH;
  return e;
}
var _TGT_PIN={x11:{GDK_BACKEND:"x11",QT_QPA_PLATFORM:"xcb",SDL_VIDEODRIVER:"x11",ELECTRON_OZONE_PLATFORM_HINT:"x11",MOZ_ENABLE_WAYLAND:"0"},wlroots:{ELECTRON_OZONE_PLATFORM_HINT:"wayland"}};
function _targetEnv(r){
  var e={},k,x=r.env||{},X=r.kind==="x11",own=X?"DISPLAY":"WAYLAND_DISPLAY",other=X?"WAYLAND_DISPLAY":"DISPLAY",pin=_TGT_PIN[r.kind];
  for(k in process.env)e[k]=process.env[k];
  // The desktop compositor's IPC sockets too: a terminal on the target could
  // otherwise `swaymsg exec` / `hyprctl dispatch exec` onto the user's desktop.
  ["GDK_BACKEND","QT_QPA_PLATFORM","SDL_VIDEODRIVER","ELECTRON_OZONE_PLATFORM_HINT","MOZ_ENABLE_WAYLAND","WAYLAND_SOCKET","SWAYSOCK","I3SOCK","HYPRLAND_INSTANCE_SIGNATURE","NIRI_SOCKET",other].forEach(function(v){delete e[v]});
  for(k in pin)e[k]=pin[k];
  if(X&&!_hasOwn.call(x,"WAYLAND_DISPLAY")&&!_hasOwn.call(x,"WAYLAND_SOCKET"))e.WAYLAND_SOCKET="";
  for(k in x)e[k]=x[k];
  e[own]=r.display;e.XDG_SESSION_TYPE=X?"x11":"wayland";
  return e;
}
// Spawn options for a bridge call: the overlay in target mode, otherwise no
// `env` key at all (inherit, exactly as before). With bin given, only the
// target's own bridge gets it: ending a GNOME portal session left from a
// desktop lock must still talk to the desktop.
// The bridges get the TOOL PATH: x11-bridge / wlroots-bridge can exec `ibus`
// by name (zbus, for an ibus: bus address).
function _spo(o,bin){if(_tgt&&_tgt.env&&(bin===void 0||bin===_tgt.bin))o.env=_envFor("tool");return o}
function _tgtErr(){var e=new Error(_tgt.refuse);e.__cdbSurface=!0;return e}
// The target's bridge: env override, else the preamble's verdict, else the
// bundled copy (a switch turned on after startup was never probed there).
function _tgtResolveBin(kind){
  var n=kind==="x11"?"x11-bridge":"wlroots-bridge",ev=kind==="x11"?"X11_BRIDGE_BIN":"WLROOTS_BRIDGE_BIN";
  var b=process.env[ev]||globalThis[kind==="x11"?"__cuX11BridgeBin":"__cuWlrootsBridgeBin"];
  if(b)return b;
  var f=globalThis.__cuBridgeFail&&globalThis.__cuBridgeFail[n];if(f)return null;
  try{var c=_path.join(process.resourcesPath||"",n);_fs.accessSync(c,(_fs.constants&&_fs.constants.X_OK)||1);return c}catch(e){return null}
}
// The handler's per-display state (last screenshot geometry, pinned display)
// belongs to the display it was taken on: dropped when the target changes.
function _tgtKey(r){return r?JSON.stringify([r.kind,r.display,r.env||null,r.invalid||null]):""}
function _tgtResetShot(a,b){if(a===b)return;globalThis.__cuLastShot=null;globalThis.__cuPinnedDisplay=void 0;globalThis.__cuActiveOrigin={x:0,y:0}}
// keep: return false (and change nothing) when the setting still names the
// target already latched - the per-call path re-reads after ANY change to the
// files, most of which do not touch this key. Returns true when it latched.
function _tgtLatch(why,keep){
  var r=null,prev=_tgt;
  try{r=typeof globalThis.__cuTargetRead==="function"?globalThis.__cuTargetRead():null}catch(e){r={invalid:"the setting could not be read ("+(e.message||e)+")",display:""}}
  if(keep&&_tgtKey(r)===(prev?prev.key:""))return !1;
  if(_tgtKey(r)!==(prev?prev.key:""))_tgtGen++;
  _tgtResetShot(prev?prev.key:"",_tgtKey(r));
  if(!r){_tgt=null;if(prev){_wlScreensInvalidate();_x11ScreensInvalidate();globalThis.__cdbDiag("[claude-cu] diagnostics: target=off - back on the desktop session ("+why+")");_cuAnnounceCheck("background display off");_cuCapChanged("background display off")}return !!prev}
  var t={kind:r.kind,display:r.display,bin:null,env:null,refuse:null,why:null,probe:null,key:_tgtKey(r)};
  if(r.invalid){t.why="invalid";t.refuse="Computer Use is set to a background display, but the setting is invalid: "+r.invalid+". Fix it, or "+_CU_TGT_OFF}
  else{
    t.env=_targetEnv(r);t.bin=_tgtResolveBin(r.kind);
    var bn=r.kind==="x11"?"x11-bridge":"wlroots-bridge";
    if(!t.bin){t.why="bridge";t.refuse="Computer Use is set to the background display "+r.display+", but "+_bridgeWhy(bn,r.kind==="x11"?"X11_BRIDGE_BIN":"WLROOTS_BRIDGE_BIN")+"."}
  }
  _tgt=t;_wlScreensInvalidate();_x11ScreensInvalidate();
  globalThis.__cdbDiag("[claude-cu] diagnostics: target="+(r.invalid?"invalid ("+r.invalid+")":r.kind+" "+r.display+" via "+(t.bin||"(no bridge)")+(r.env&&Object.keys(r.env).length?" env+"+Object.keys(r.env).join(","):""))+" ("+why+")");
  _cuAnnounceCheck("background display changed");
  _cuCapChanged("background display changed");
  return !0;
}
// What follows a (re)latch: a GNOME portal session left from a desktop lock
// ends (no new one starts in target mode), and the target is checked, which
// also primes its monitor list.
async function _tgtAfterLatch(){
  var t=_tgt;if(!t)return;
  if(_gnomeBridgeBin()&&(_gnomeSessionActive||_gnomeSessionStarting||_gnomeDaemonMayExist||_gnomeStoppedByUser)){_gnomeIdleCancel();await _gnomeSessionEnd("background display")}
  if(!t.refuse||t.why==="down")await _tgtProbe(t);
}
// The setting is latched per TOOL CALL, not only per lock: upstream's
// app-scoped lock (acquireApp) never reaches __setLockHeld, so a switch turned
// on after startup was never seen and Computer Use kept acting on the desktop
// (issue #300, live test). Before every tool (handler gate) and in every async
// entry point: one async stat pair of the settings files (__cuTargetSig); the
// files are read again only when that signature changed, and the latch moves
// only when the key itself changed. Calls within TGT_SYNC_MS share one check
// (the handler gate and the executor method of the same tool call).
var _tgtSigLast=null,_tgtSyncAt=0,_tgtSyncP=null,TGT_SYNC_MS=200;
// _tgtGen counts target changes. Only the handler gate (outside a batch) may
// move the latch silently; a change seen anywhere else - an executor method's
// own check, or a gate inside computer_batch - refuses that action, so no
// action ever runs half on one display and half on another.
var _tgtGen=0,_tgtBatch=0;
var _CU_TGT_CHANGED="The Computer Use display setting changed during this action; take a screenshot and try again.";
function _tgtChangedErr(){var e=new Error(_CU_TGT_CHANGED);e.__cdbSurface=!0;return e}
// force: the handler gate - it always stats (a save between two quick tool
// calls must not slip through the window), and never reuses a check that was
// already in flight before it was asked.
function _tgtSync(why,force){
  if(_tgtSyncP)return force?_tgtSyncP.then(function(){return _tgtSync(why,!0)}):_tgtSyncP;
  if(!force&&Date.now()-_tgtSyncAt<TGT_SYNC_MS||typeof globalThis.__cuTargetSig!=="function")return Promise.resolve();
  var p;
  try{p=Promise.resolve(globalThis.__cuTargetSig())}catch(e){p=Promise.reject(e)}
  return _tgtSyncP=p.then(function(sig){
    _tgtSyncAt=Date.now();
    if(sig===_tgtSigLast)return;
    _tgtSigLast=sig;
    if(_tgtLatch(why,!0))return _tgtAfterLatch();
  }).catch(function(e){globalThis.__cdbDiag("[claude-cu] background display setting check failed: "+(e&&e.message||e))}).then(function(){_tgtSyncP=null});
}
// Does the display answer? `screens` through the target's bridge (async, never
// on the input path). A non-empty list primes the capture-path cache; a failure
// or an empty list refuses every tool call. While refused for "down" each tool
// call checks again, so a display started after the refusal is picked up.
function _tgtProbe(t){
  // An invalid setting stays refused as invalid: nothing to check or probe.
  if(t.why==="invalid"||!t.bin)return Promise.resolve();
  if(t.probe)return t.probe;
  t.checked=!0;
  // Claude's own display is never probed: re-check identity (stat only) before
  // every `screens`, since a socket missing at the lock can appear later.
  var idn=null;try{idn=typeof globalThis.__cuTargetIdentity==="function"?globalThis.__cuTargetIdentity(t.kind,t.display,t.env):null}catch(ie){idn={why:"identity check failed ("+(ie.message||ie)+")"}}
  if(idn){
    if(idn.down){if(t.why!=="down")globalThis.__cdbDiag("[claude-cu] diagnostics: target="+t.kind+" "+t.display+" not running (no socket)");t.why="down";t.refuse=_tgtDownMsg(t.display)}
    else{t.why="invalid";t.refuse="Computer Use is set to a background display, but the setting is invalid: "+(idn.own?(idn.via||t.display)+" is your own desktop, not a background display":idn.why)+". Fix it, or "+_CU_TGT_OFF;globalThis.__cdbDiag("[claude-cu] diagnostics: target=invalid ("+t.refuse+")")}
    return Promise.resolve();
  }
  var p=t.probe=_execFileAsync(t.kind==="x11"?"x11-bridge":"wlroots-bridge",t.bin,["screens"],SCREENS_TIMEOUT_MS).then(function(s){
    if(!Array.isArray(s)||!s.length)throw new Error("no monitors in the answer");
    return s;
  }).then(function(s){
    if(_tgt===t){if(t.kind==="x11")_x11ScreensCache=s;else _wlScreensCache=s}
    if(t.refuse)globalThis.__cdbDiag("[claude-cu] diagnostics: target="+t.kind+" "+t.display+" is running now");
    t.refuse=null;t.why=null;
  },function(e){
    if(t.why!=="down")globalThis.__cdbDiag("[claude-cu] diagnostics: target="+t.kind+" "+t.display+" not running ("+String(e&&e.message||e).trim().split("\n").pop()+")");
    t.why="down";t.refuse=_tgtDownMsg(t.display);
  }).then(function(){if(t.probe===p)t.probe=null});
  return p;
}
try{var _virt=_cp.execFileSync(_toolCmd("systemd-detect-virt")||"systemd-detect-virt",[],{encoding:"utf-8",timeout:3000,stdio:["ignore","pipe","ignore"]}).trim();globalThis.__isVM=_virt!=="none"&&_virt!==""}catch(e){globalThis.__isVM=!1}
if(globalThis.__isVM)globalThis.__cdbDiag("[claude-cu] VM detected ("+_virt+") — teach overlay uses dark backdrop fallback");
// Lookups are PATH walks (_walk), not `which`: it is not installed on every
// system (minimal images), where every tool read as missing, and it cost one
// blocking spawn per tool on the main process.
// _hasCmd: a helper tool we run (TOOL PATH, see _toolCmd).
function _hasCmd(bin){return!!_toolCmd(bin)}
// An app's command on the APP PATH -> absolute path or null. Cached per
// (APP PATH, name): the started PATH and ours can differ.
var _cmdCache={};
function _appWhich(b,fresh){var P=_lookupPath(),ck=P+"\0"+b;if(fresh)delete _cmdCache[ck];if(_cmdCache[ck]===void 0)_cmdCache[ck]=_walk(P.split(":"),b);return _cmdCache[ck]}
// Application dirs per the XDG base-dir spec: $XDG_DATA_HOME (default
// ~/.local/share) first, then each $XDG_DATA_DIRS entry (default
// /usr/local/share:/usr/share - this is what carries NixOS profiles, snap and
// /usr/local), then the flatpak exports (normally already in XDG_DATA_DIRS via
// flatpak's profile.d, but not for a session that skipped it). Relative
// entries are invalid per the spec and ignored; duplicates collapse. Order is
// precedence: the first file with a given desktop-file ID wins, so a user
// override beats the system entry.
function _xdgAppDirs(){
  var home=_os.homedir(),out=[],seen={};
  function add(d){if(!d||d.charAt(0)!=="/")return;var a=_path.join(_path.resolve(d),"applications");if(!seen[a]){seen[a]=1;out.push(a)}}
  var dh=process.env.XDG_DATA_HOME;add(dh&&dh.charAt(0)==="/"?dh:_path.join(home,".local/share"));
  (process.env.XDG_DATA_DIRS||"/usr/local/share:/usr/share").split(":").forEach(add);
  add(_path.join(home,".local/share/flatpak/exports/share"));add("/var/lib/flatpak/exports/share");
  // Dirs that are normally in XDG_DATA_DIRS but not for a session that skipped
  // the profile scripts: snap, NixOS system + per-user profiles, nix-env.
  var usr=process.env.USER||process.env.LOGNAME||"";
  if(!usr){try{usr=_os.userInfo().username}catch(e){}}
  add("/var/lib/snapd/desktop");add("/run/current-system/sw/share");
  if(usr&&/^[\w.-]+$/.test(usr))add("/etc/profiles/per-user/"+usr+"/share");
  add(_path.join(home,".nix-profile/share"));
  return out;
}
// ── Desktop Entry parsing + launching (shared by listInstalledApps / openApp) ──
// Parses only the [Desktop Entry] group (first plain Exec/Name/Icon/Path/
// TryExec/Terminal/DBusActivatable; localized keys and [Desktop Action ...]
// groups are ignored). Exec follows the Desktop Entry spec: the string escapes
// (\s \n \t \r \\) are applied once, then the value is split into argv on
// unquoted space/tab ("-quoting, backslash escapes " ` $ \ inside quotes; an
// unquoted backslash escapes the next character, as in g_shell_parse_argv, so
// the result does not depend on gio being installed), then field codes are
// expanded. An unterminated quote, a trailing lone backslash or a trailing
// lone % marks the Exec malformed (argv=null, launcher tools take over).
function _deUnescape(v){return v.replace(/\\(s|n|t|r|\\)/g,function(m,c){return c==="s"?" ":c==="n"?"\n":c==="t"?"\t":c==="r"?"\r":"\\"})}
function _splitExec(s){
  var out=[],cur="",has=false,inq=false;
  for(var i=0;i<s.length;i++){
    var c=s.charAt(i);
    if(inq){
      if(c==="\\"){
        if(i+1>=s.length)return null;
        var nx=s.charAt(i+1);
        if(nx==='"'||nx==="`"||nx==="$"||nx==="\\"){cur+=nx;i++}else cur+=c;
      }else if(c==='"')inq=false;
      else cur+=c;
    }else if(c==='"'){inq=true;has=true}
    else if(c===" "||c==="\t"){if(has||cur){out.push(cur);cur="";has=false}}
    else if(c==="\\"){if(i+1>=s.length)return null;cur+=s.charAt(++i);has=true}
    else cur+=c;
  }
  if(inq)return null;
  if(has||cur)out.push(cur);
  return out;
}
function _expandExecCodes(argv,e){
  var out=[];
  for(var j=0;j<argv.length;j++){
    var a=argv[j];
    if(a==="%i"){if(e.icon)out.push("--icon",e.icon);continue}
    if(/^%[fFuUdDnNvm]$/.test(a))continue;
    var r="";
    for(var i=0;i<a.length;i++){
      if(a.charAt(i)!=="%"){r+=a.charAt(i);continue}
      var k=a.charAt(++i);
      if(k==="")return null;
      if(k==="%")r+="%";else if(k==="c")r+=e.name;else if(k==="k")r+=e.file;
    }
    out.push(r);
  }
  return out;
}
var _hasOwn=Object.prototype.hasOwnProperty;
// -> {name,dfn,file,icon,path,tryExec,terminal,dbus,argv,malformed,base,wmClass,noDisplay} or null.
function _parseDesktopEntry(content,fp,fname){
  var g={},inG=false,seen=false,lines=content.replace(/^\uFEFF/,"").split("\n");
  for(var i=0;i<lines.length;i++){
    var l=lines[i].replace(/\r$/,"");
    if(!l||l.charAt(0)==="#")continue;
    var h=l.match(/^\[([^\]]+)\]\s*$/);
    if(h){if(inG)break;inG=h[1]==="Desktop Entry";if(inG)seen=true;continue}
    if(!inG)continue;
    var kv=l.match(/^([A-Za-z0-9-]+)[ \t]*=[ \t]*(.*)$/);
    if(kv&&!_hasOwn.call(g,kv[1]))g[kv[1]]=kv[2];
  }
  if(!seen||!g.Name)return null;
  if(g.Type&&g.Type.trim()!=="Application")return null;
  var e={name:_deUnescape(g.Name).trim(),dfn:fname.replace(/\.desktop$/,""),file:fp,
    icon:g.Icon?_deUnescape(g.Icon).trim():"",path:g.Path?_deUnescape(g.Path).trim():"",
    tryExec:g.TryExec?_deUnescape(g.TryExec).trim():"",terminal:(g.Terminal||"").trim()==="true",
    dbus:(g.DBusActivatable||"").trim()==="true",argv:null,malformed:false,base:"",
    wmClass:g.StartupWMClass?_deUnescape(g.StartupWMClass).trim():"",noDisplay:(g.NoDisplay||"").trim()==="true"};
  if(!e.name)return null;
  var raw=g.Exec!==void 0?_deUnescape(g.Exec).trim():"";
  if(raw){
    var sp=_splitExec(raw),ex=sp&&_expandExecCodes(sp,e);
    if(ex&&ex.length&&ex[0])e.argv=ex;else e.malformed=true;
  }else if(!e.dbus)return null;
  e.base=_entryBase(e);
  return e;
}
// Prototype-less sets: `constructor` / `toString` are not wrappers.
function _strSet(l){var o=Object.create(null);for(var i=0;i<l.length;i++)o[l[i]]=1;return o}
var _WRAPPER_BINS=_strSet(["env","flatpak","sh","bash","dash","zsh","gio","gtk-launch","snap","xdg-open","setsid","nohup"]);
var _FLATPAK_VALUED=_strSet(["--command","--branch","--arch","--runtime","--runtime-version","--cwd"]);
// The name a launcher goes by: the real argv0 basename, skipping `env` and its
// VAR=val tokens; `flatpak run ... <app.id>` -> the app id. Wrapper binaries are
// never returned (the desktop-file id stands in), so they cannot become aliases.
// Index of the real program in an Exec argv: past `env`, its VAR=val tokens
// and options; -1 when nothing follows them.
function _entryProgIdx(a){
  var i=0;
  if(_path.basename(a[0])==="env"){
    i=1;
    while(i<a.length){
      if(/^[A-Za-z_][A-Za-z0-9_]*=/.test(a[i]))i++;
      else if(a[i]==="-u"||a[i]==="-C"||a[i]==="--unset"||a[i]==="--chdir")i+=2;
      else if(a[i].charAt(0)==="-"&&a[i]!=="-")i++;
      else break;
    }
  }
  return i<a.length?i:-1;
}
function _entryBase(e){
  var a=e.argv;
  if(!a)return e.dfn;
  var i=_entryProgIdx(a);
  if(i<0)return e.dfn;
  var b=_path.basename(a[i]);
  if(b==="flatpak"){
    var r=false;
    for(var k=i+1;k<a.length;k++){
      var t=a[k];
      if(!r){if(t==="run"){r=true}else if(t.charAt(0)!=="-")break;continue}
      if(t.charAt(0)==="-"){if(_FLATPAK_VALUED[t])k++;continue}
      return t.indexOf(".")>0?t:e.dfn;
    }
    return e.dfn;
  }
  return _WRAPPER_BINS[b]?e.dfn:b;
}
// An app's command (Exec argv[0], TryExec, $TERMINAL): a bare name on the APP
// PATH. fresh=true bypasses the permanent per-process cache (launch pre-checks:
// an app installed after the first attempt must launch without a restart).
function _execResolvable(b,cwd,fresh){
  if(b.indexOf("/")<0)return!!_appWhich(b,fresh);
  var p=b.charAt(0)==="/"?b:_path.resolve(cwd||process.cwd(),b);
  try{_fs.accessSync(p,(_fs.constants&&_fs.constants.X_OK)||1);return!_fs.statSync(p).isDirectory()}catch(e){return false}
}
// Every installable entry in the XDG app dirs, in precedence order (first file
// with a given desktop-file ID wins). Entries whose TryExec does not resolve are
// skipped: the app is not installed.
function _readDesktopEntries(dirs){
  var out=[],seenIds={};
  for(var d=0;d<dirs.length;d++){
    var files;
    try{files=_fs.readdirSync(dirs[d])}catch(de){continue}
    for(var i=0;i<files.length;i++){
      if(files[i].indexOf(".desktop")===-1||seenIds[files[i]])continue;
      seenIds[files[i]]=1;
      try{
        var fp=_path.join(dirs[d],files[i]);
        var e=_parseDesktopEntry(_fs.readFileSync(fp,"utf-8"),fp,files[i]);
        if(!e)continue;
        if(e.tryExec&&!_execResolvable(e.tryExec,null,true))continue;
        out.push(e);
      }catch(fe){}
    }
  }
  return out;
}
// ── App identity: one canonical id per app ──
// Upstream's Computer Use dispatch compares ONE string, bundleId, across
// listInstalledApps (request_access name -> id), listRunningApps,
// getFrontmostApp, appUnderPoint, findWindowDisplays / the display auto-target,
// resolvePrepareCapture({allowedBundleIds}) and the grants it stores, by exact
// equality (its grant lookup is keyed on bundleId). So every method of this
// executor answers with the same id for the same app, on every backend:
//
//   canonical id = the .desktop file id (file name without .desktop, case
//   kept): google-chrome, org.gnome.TextEditor, org.xfce.mousepad,
//   org.mozilla.firefox (flatpak), firefox_firefox (snap).
//
// A window maps to it through the aliases the entries declare, best rank
// first. Keys are case-insensitive with .desktop stripped. A key claimed by
// several entries at its best rank goes to a visible entry over a NoDisplay
// one, then to a plain launcher over one with arguments (Chrome over its
// web-app shortcuts); still tied = ambiguous = maps to nothing, never guessed.
//   0 desktop file id                     google-chrome, org.mozilla.firefox
//   1 StartupWMClass                      Google-chrome, firefox, com.microsoft.VSCode
//   2 Exec program basename / flatpak id  google-chrome-stable, gnome-text-editor
//   3 snap name parts / reverse-DNS tail  firefox (firefox_firefox), mousepad (org.xfce.mousepad)
//   4 Icon name                           org.xfce.terminal
//   5 Name                                Google Chrome
// A window's own ids are tried in this order - desktop_file_name (KWin desktop
// file, _GTK_APPLICATION_ID, Wayland app_id), resource_class (WM_CLASS class),
// resource_name (WM_CLASS instance) - then its transient parent's, then its
// process (pid from _NET_WM_PID): /proc/<pid>/exe as a path, its directory and
// its basename against each entry's resolved Exec program, and for an
// interpreter (electron, python, java, ...) the script path on its command
// line. Interpreters, wrappers and shared bin dirs never alias. Claude's own
// windows (our pid) are the host id. A window no entry claims keeps its first
// own id (.desktop stripped, case kept) - the string the bridges' frontmost-app
// and app-under-point print - so unresolved apps still agree everywhere.
// The index is rebuilt at most every APP_IDX_TTL_MS (an app installed later
// resolves without a restart). Read-only and portal-free: safe outside the
// Computer Use lock (enumeration side of the _gnomePortalCmds rule).
var APP_IDX_TTL_MS=30000;
// _appIdxPath: the APP PATH it was built on (TryExec and the exe index resolve
// there): a different one - narrowing put in place or lifted - rebuilds it.
var _appIdx=null,_appIdxAt=0,_appIdxPath=null;
var _GENERIC_EXE_RE=/^(?:electron\d*|python[\d.]*m?|pypy[\d.]*|java|node|nodejs|bun|deno|wine(?:64)?(?:-preloader)?|mono|perl[\d.]*|ruby[\d.]*|bwrap|apprun|flatpak-spawn|gjs|qemu-.*|ld-linux.*)$/i;
function _genericExe(b){return !b||!!_WRAPPER_BINS[b]||_GENERIC_EXE_RE.test(b)}
function _genericDir(d){
  if(!d||d==="/"||d.split("/").length<3)return !0;
  var h=_os.homedir();
  return /^\/(?:usr\/(?:local\/)?)?s?bin$|^\/usr\/games$|^\/app\/bin$|^\/snap\/bin$|^\/run\/current-system\/sw\/bin$|\/exports\/bin$/.test(d)||d===_path.join(h,".local/bin")||d===_path.join(h,"bin");
}
function _akey(s){return typeof s==="string"?s.trim().replace(/\.desktop$/i,"").toLowerCase():""}
function _araw(s){return typeof s==="string"&&s.trim()?s.trim().replace(/\.desktop$/i,""):""}
// No arguments past the program (flatpak: past the app id; @@ file-forwarding markers ignored).
function _aplain(e){
  var a=e.argv;if(!a)return !0;
  var i=_entryProgIdx(a);if(i<0)return !0;
  if(_path.basename(a[i])==="flatpak"){var j=a.indexOf(e.base,i+1);if(j<0)return !1;i=j}
  for(var k=i+1;k<a.length;k++){if(!/^@@/.test(a[k]))return !1}
  return !0;
}
// Claim key k for record r at rank: better (rank, visible, plain) replaces,
// worse is ignored, equal from another record makes the key ambiguous.
function _aclaim(map,k,r,rank){
  if(!k)return;
  var c=map[k];
  if(c&&c.r===r){if(rank<c.rank){c.rank=rank;c.sc[0]=rank}return}
  var sc=[rank,r.noDisplay?1:0,r.plain?0:1];
  if(!c){map[k]={r:r,rank:rank,sc:sc,amb:!1};return}
  for(var i=0;i<3;i++){if(sc[i]<c.sc[i]){map[k]={r:r,rank:rank,sc:sc,amb:!1};return}if(sc[i]>c.sc[i])return}
  c.amb=!0;
}
// fresh=true rebuilds now (listInstalledApps: a TryExec installed mid-session counts at once).
function _appIndex(fresh){
  var now=Date.now(),lp=_lookupPath();
  if(!fresh&&_appIdx&&now-_appIdxAt<APP_IDX_TTL_MS&&_appIdxPath===lp)return _appIdx;
  _appIdxPath=lp;
  var ents=[];try{ents=_readDesktopEntries(_xdgAppDirs())}catch(e){}
  var keys=Object.create(null),byId=Object.create(null),list=[];
  for(var i=0;i<ents.length;i++){
    var e=ents[i],r={id:e.dfn,name:e.name,file:e.file,e:e,noDisplay:!!e.noDisplay,plain:_aplain(e),cand:[]};
    if(byId[_akey(e.dfn)])continue;
    byId[_akey(e.dfn)]=r;list.push(r);
  }
  // own(q): the record q's aliases are claimed for (itself, or the visible
  // entry a NoDisplay duplicate belongs to).
  function claimAll(own){
    keys=Object.create(null);
    for(var j=0;j<list.length;j++){
      var q=list[j],en=q.e,o=own(q);
      var add=function(raw,rank){var k=_akey(raw);if(!k)return;var c=raw.trim().replace(/\.desktop$/i,"");if(o.cand.indexOf(c)<0)o.cand.push(c);_aclaim(keys,k,o,rank)};
      add(en.dfn,0);
      if(en.wmClass)add(en.wmClass,1);
      if(en.base&&en.base!==en.dfn&&!_genericExe(en.base))add(en.base,2);
      var sm=/^([^_.\s]+)_([^_.\s]+)$/.exec(en.dfn);
      if(sm){add(sm[2],3);if(sm[1]!==sm[2])add(sm[1],3)}
      var dot=en.dfn.lastIndexOf(".");
      if(dot>0&&dot<en.dfn.length-1&&!/^\d+$/.test(en.dfn.slice(dot+1)))add(en.dfn.slice(dot+1),3);
      if(en.icon&&en.icon.indexOf("/")<0)add(en.icon,4);
      add(en.name,5);
    }
  }
  claimAll(function(q){return q});
  // A NoDisplay entry that is another launcher of a visible app (Chrome's
  // com.google.Chrome next to google-chrome, URL handlers): its StartupWMClass
  // is that app's desktop id / StartupWMClass, or its Exec is the same. It
  // becomes an alias set of that app, not an app of its own - else a request
  // for "chrome" could land on the hidden duplicate and never match a window.
  var merged=0;
  for(var m=0;m<list.length;m++){
    var nd=list[m];if(!nd.noDisplay)continue;
    var t=null,c=nd.e.wmClass?keys[_akey(nd.e.wmClass)]:null;
    if(c&&!c.amb&&c.rank<=1&&!c.r.noDisplay&&c.r!==nd)t=c.r;
    if(!t&&nd.e.argv){var sig=nd.e.argv.join("\0");for(var v=0;v<list.length&&!t;v++){var vr=list[v];if(!vr.noDisplay&&vr.e.argv&&vr.e.argv.join("\0")===sig)t=vr}}
    if(t){nd.mergedInto=t;merged++}
  }
  if(merged){
    for(var z=0;z<list.length;z++)list[z].cand=[];
    claimAll(function(q){return q.mergedInto||q});
    for(var y=0;y<list.length;y++){if(list[y].mergedInto)byId[_akey(list[y].id)]=list[y].mergedInto}
    list=list.filter(function(q){return !q.mergedInto});
  }
  _appIdx={keys:keys,byId:byId,list:list,exe:null,words:null};_appIdxAt=now;
  return _appIdx;
}
function _alook(map,k){var c=k?map[k]:null;return c&&!c.amb?c.r:null}
// Exact canonical id first, then any alias.
function _arec(idx,raw){var k=_akey(raw);return k?(idx.byId[k]||_alook(idx.keys,k)):null}
function _aWhich(b){
  if(b.indexOf("/")>=0)return b.charAt(0)==="/"?b:null;
  return _walk(_lookupPath().split(":"),b);
}
function _aReal(p){try{return _fs.realpathSync(p)}catch(e){return p}}
// Lazy: built only when a window needs the process tier.
function _aExeIndex(idx){
  if(idx.exe)return idx.exe;
  var m=Object.create(null);
  for(var i=0;i<idx.list.length;i++){
    var r=idx.list[i],a=r.e.argv;if(!a)continue;
    var pi=_entryProgIdx(a);if(pi<0)continue;
    var b=_path.basename(a[pi]);if(b==="flatpak"||_WRAPPER_BINS[b])continue;
    var w=_aWhich(a[pi]);if(!w)continue;
    var real=_aReal(w),rb=_path.basename(real);
    if(!_genericExe(b)&&!_genericExe(rb)){
      _aclaim(m,"exe:"+real,r,2);
      var dir=_path.dirname(real);if(!_genericDir(dir))_aclaim(m,"dir:"+dir,r,2);
    }else{
      for(var k=pi+1;k<a.length;k++){if(a[k].charAt(0)==="/"){_aclaim(m,"arg:"+_aReal(a[k]),r,2);break}if(a[k].charAt(0)!=="-")break}
    }
  }
  idx.exe=m;return m;
}
function _aProc(idx,pid){
  if(typeof pid!=="number"||!(pid>1))return null;
  var exe;try{exe=String(_fs.readlinkSync("/proc/"+pid+"/exe")).replace(/ \(deleted\)$/,"")}catch(e){return null}
  if(!exe)return null;
  var m=_aExeIndex(idx),b=_path.basename(exe),r;
  if(!_genericExe(b)){
    r=_alook(m,"exe:"+exe);if(r)return r;
    var d=_path.dirname(exe);if(!_genericDir(d)){r=_alook(m,"dir:"+d);if(r)return r}
    return _arec(idx,b);
  }
  var cl;try{cl=String(_fs.readFileSync("/proc/"+pid+"/cmdline","utf8")).split("\0")}catch(e){return null}
  for(var i=1;i<cl.length;i++){if(cl[i].charAt(0)==="/"){r=_alook(m,"arg:"+_aReal(cl[i]));if(r)return r}}
  return null;
}
function _aOwnIds(w){var o=[],c=[w.desktop_file_name,w.resource_class,w.resource_name];for(var i=0;i<c.length;i++){if(typeof c[i]==="string"&&c[i].trim())o.push(c[i])}return o}
// The id the bridges' frontmost-app / app-under-point print for this window.
function _aRawFirst(w){var o=_aOwnIds(w);if(o.length)return _araw(o[0]);return w&&w.id!=null&&String(w.id).trim()?String(w.id).trim():""}
// raw id -> canonical id (unknown: itself, .desktop stripped, case kept).
function _acanon(raw){var r=_arec(_appIndex(),raw);return r?r.id:_araw(raw)||null}
// The host: Claude's own desktop id (Electron exports desktopName as CHROME_DESKTOP).
function _hostId(){return _acanon(String(process.env.CHROME_DESKTOP||"").trim()||"com.anthropic.Claude.desktop")||"com.anthropic.Claude"}
// Window -> {id, rec, host?} or null.
function _aWin(w){
  if(!w||typeof w!=="object")return null;
  var idx=_appIndex(),i,r;
  if(w.pid===process.pid){var h=_hostId();return{id:h,rec:idx.byId[_akey(h)]||null,host:!0}}
  var own=_aOwnIds(w);
  for(i=0;i<own.length;i++){r=_arec(idx,own[i]);if(r)return{id:r.id,rec:r}}
  for(var p=w.transient_for,n=0;p&&typeof p==="object"&&n<8;p=p.transient_for,n++){var po=_aOwnIds(p);for(i=0;i<po.length;i++){r=_arec(idx,po[i]);if(r)return{id:r.id,rec:r}}}
  r=_aProc(idx,w.pid);if(r)return{id:r.id,rec:r};
  var raw=_aRawFirst(w);
  return raw?{id:raw,rec:null}:null;
}
// request_access name -> {bundleId, displayName, path} or null: a canonical
// id or any alias, then a word of a multi-word Name ("Chrome" for "Google
// Chrome", "Visual" for "Visual Studio Code") when no other entry has it.
function _aResolveName(name){
  var idx=_appIndex(),r=_arec(idx,name);
  if(!r){
    if(!idx.words){
      var wm=Object.create(null);
      for(var i=0;i<idx.list.length;i++){var q=idx.list[i],ws=q.name.split(/\s+/).filter(Boolean);if(ws.length>1){_aclaim(wm,_akey(ws[0]),q,0);_aclaim(wm,_akey(ws.slice(1).join(" ")),q,0)}}
      idx.words=wm;
    }
    var k=_akey(name);r=_alook(idx.words,k);
    if(r&&_alook(idx.keys,k)===null&&idx.keys[k])r=null;
  }
  return r?{bundleId:r.id,displayName:r.name,path:r.file}:null;
}
// Every alias string that resolves to this canonical id (for policy lists
// keyed on executable names, e.g. upstream's shell / file-manager sentinels).
function _aAliases(id){
  var idx=_appIndex(),r=idx.byId[_akey(id)];if(!r)return[];
  var out=[],seen={};
  function put(s){var k=_akey(s);if(k&&!seen[k]&&_arec(idx,s)===r){seen[k]=1;out.push(s)}}
  for(var i=0;i<r.cand.length;i++)put(r.cand[i]);
  var a=r.e.argv,pi=a?_entryProgIdx(a):-1;
  if(pi>=0){var w=_aWhich(a[pi]);if(w){var real=_aReal(w);if(!seen["exe:"+real]){seen["exe:"+real]=1;out.push(real)}}}
  return out;
}
// Grant (a canonical id, an alias, or a raw window id) -> does window w belong
// to it? Same resolution as the window side; Name words are not used here.
function _aOwns(grant,w){
  if(typeof grant!=="string"||!grant.trim()||!w)return !1;
  var g=_arec(_appIndex(),grant),gid=g?g.id:_araw(grant),wr=_aWin(w);
  return !!(wr&&wr.id&&_akey(wr.id)===_akey(gid));
}
globalThis.__cdbCuAppIds={canon:_acanon,resolveWindow:function(w){var r=_aWin(w);return r?{bundleId:r.id,displayName:r.rec?r.rec.name:null,host:!!r.host}:null},resolveName:_aResolveName,aliasesOf:_aAliases,owns:_aOwns,hostId:_hostId,
  // Bridge window ids (the `id` field of `windows`, what --keep-window takes)
  // of the windows that belong to any of the canonical ids, in list order.
  windowIds:function(bundleIds,wins){var ids=Array.isArray(bundleIds)?bundleIds:[],out=[];(Array.isArray(wins)?wins:[]).forEach(function(w){if(!w||w.id==null)return;for(var i=0;i<ids.length;i++){if(_aOwns(ids[i],w)){out.push(String(w.id));return}}});return out}};
// Spawn without a shell and wait until the outcome is known. "direct" resolves
// on the child's spawn event; "tool" (gio, kioclient, ...) on its exit status. An
// error event (missing binary, bad cwd) or a non-zero tool exit is a failure the
// caller moves on from; a child that is still running after the settle window
// counts as launched.
function _spawnWait(cmd,args,opts,mode){
  return new Promise(function(resolve){
    var done=false,tm=null;
    function fin(r){if(done)return;done=true;if(tm)clearTimeout(tm);resolve(r)}
    var c;
    try{c=_cp.spawn(cmd,args,opts)}catch(e){resolve({ok:false,reason:cmd+": "+(e.message||e)});return}
    c.on("error",function(err){
      var m=cmd+": "+(err&&err.message||err);
      if(done)globalThis.__cdbDiag("[claude-cu] detached launch failed ("+cmd+"): "+m);
      fin({ok:false,reason:m});
    });
    if(mode==="tool")c.on("exit",function(code){fin(code?{ok:false,reason:cmd+" exited with code "+code}:{ok:true})});
    else c.on("spawn",function(){fin({ok:true,pid:c.pid})});
    tm=setTimeout(function(){fin({ok:true})},mode==="tool"?1500:500);
    c.unref();
  });
}
// Launch an entry: direct argv first (every entry with a parseable Exec, D-Bus
// activatable ones included), then the optional desktop launcher tools for
// entries with no/malformed Exec, Terminal=true, or a binary that would not
// spawn. Throws a clear error when every tier is unavailable or fails.
// Once per command: an app that resolves on the APP PATH only (not on the
// narrowed PATH upstream leaves in process.env), so claude-patches.log shows
// which PATH a launch took.
var _appPathSaid={};
function _appPathNote(b){
  if(b.indexOf("/")>=0||_startedRaw()===null||_appPathSaid[b]||_walk((process.env.PATH||"").split(":"),b))return;
  _appPathSaid[b]=1;globalThis.__cdbDiag("[claude-cu] openApp: "+b+" -> "+_appWhich(b)+" (found on the PATH Claude Desktop was started with, not on the narrowed one)");
}
async function _launchEntry(e,label){
  var reasons=[],cwd=e.path||null,SO={detached:true,stdio:"ignore"};
  // Target mode: the direct Exec spawn only, in the target's environment. The
  // desktop launcher tools (gio, gtk-launch, kioclient, exo-open, terminals)
  // hand the launch to the user's desktop session and are never tried.
  // AE: the app's env (APP PATH; the overlay in target mode), null = inherit.
  // setsid and the launcher tools are ours: TOOL PATH, absolute (_toolCmd);
  // setsid then finds the app on the APP PATH of AE.
  var AE=_envFor("app");
  if(AE)SO.env=AE;
  function _has(b){return _toolCmd(b,true)}
  var cwdBad=false;
  if(cwd){
    try{cwdBad=!_fs.statSync(cwd).isDirectory()}catch(ce){cwdBad=true}
    if(cwdBad)cwd=null;else SO.cwd=cwd;
  }
  if(e.argv&&!e.terminal){
    var cmd,args,ss=_has("setsid");
    if(ss){cmd=ss;args=e.argv.slice()}else{cmd=e.argv[0];args=e.argv.slice(1)}
    globalThis.__cdbDiag("[claude-cu] openApp: launching argv "+JSON.stringify([cmd].concat(args))+(cwd?" cwd="+cwd:""));
    if(cwdBad)reasons.push("working directory "+e.path+" not usable");
    else if(!_execResolvable(e.argv[0],cwd,true))reasons.push(e.argv[0]+": command not found");
    else{
      _appPathNote(e.argv[0]);
      var r=await _spawnWait(cmd,args,SO,"direct");
      if(r.ok)return{via:"direct",pid:r.pid};
      reasons.push(r.reason);
    }
  }else reasons.push(e.terminal?"Terminal=true":e.malformed?"malformed Exec":"no Exec");
  if(_tgt)throw new Error("Could not launch "+label+" on the background display "+_tgt.display+": "+reasons.join("; ")+" (only a plain Exec line can start there; desktop launcher tools would open it on the user's desktop).");
  globalThis.__cdbDiag("[claude-cu] openApp: "+e.name+" ("+reasons[0]+") - trying desktop launcher tools");
  var tiers=[],tc0;
  if(tc0=_has("gio"))tiers.push([tc0,["launch",e.file],"tool"]);
  if(tc0=_has("gtk-launch"))tiers.push([tc0,[e.dfn],"tool"]);
  var kio=_has("kioclient6")||_has("kioclient5");
  if(kio)tiers.push([kio,["exec",e.file],"tool"]);
  if(tc0=_has("exo-open"))tiers.push([tc0,[e.file],"tool"]);
  if(e.terminal&&e.argv){
    if(tc0=_has("xdg-terminal-exec"))tiers.push([tc0,e.argv.slice(),"term"]);
    if(tc0=_has("x-terminal-emulator"))tiers.push([tc0,["-e"].concat(e.argv),"term"]);
    // $TERMINAL may carry arguments ("kitty --single-instance"): split on
    // whitespace into argv (no shell, no quote handling). A command the user
    // named: looked up on the APP PATH and spawned by name with AE.
    var tt=(process.env.TERMINAL||"").trim();
    if(tt){
      var tp=tt.split(/\s+/);
      if(_execResolvable(tp[0],null,true))tiers.push([tp[0],tp.slice(1).concat(["-e"],e.argv),"term"]);
      else{
        var tm="$TERMINAL ("+tt+"): "+tp[0]+" not found";
        globalThis.__cdbDiag("[claude-cu] openApp: "+tm);
        reasons.push(tm);
      }
    }
  }
  if(!tiers.length)reasons.push("no desktop launcher tool found (gio, gtk-launch, kioclient, exo-open)"+_toolIgnoredMsg(["gio","gtk-launch","kioclient6","kioclient5","exo-open"]));
  for(var t=0;t<tiers.length;t++){
    var tc=tiers[t],to={detached:true,stdio:"ignore"};
    if(tc[2]==="term"&&cwd)to.cwd=cwd;
    // The tool resolves the app's Exec= (or runs its argv) itself, exactly as
    // the user's own launcher does: it needs the APP PATH. The tool itself is
    // absolute (_toolCmd; tiers hold only tools that were found). URL opening
    // (_launchDetached) differs: xdg-open picks helper tools by name, not an
    // app the user asked for, so it keeps the TOOL PATH.
    if(AE)to.env=AE;
    globalThis.__cdbDiag("[claude-cu] openApp: launching argv "+JSON.stringify([tc[0]].concat(tc[1])));
    var tr=await _spawnWait(tc[0],tc[1],to,tc[2]==="term"?"direct":"tool");
    if(tr.ok)return{via:tc[0]};
    reasons.push(tr.reason);
  }
  throw new Error("Could not launch "+label+": "+reasons.join("; "));
}
function _desktopId(){return(process.env.XDG_CURRENT_DESKTOP||"").toLowerCase()}
// ydotool usable (installed, and ydotoold running or its socket present). Like
// _toolCmd: true is kept for good, false for MISS_TTL_MS only, so installing
// ydotool or starting ydotoold while the app runs is seen a few seconds later
// without a restart. Re-checked only when a caller asks (at most one pgrep per
// MISS_TTL_MS), never on a timer.
var _ydotoolOk=null,_ydotoolNoAt=0,_ydotoolSaid=!1;
function _checkYdotool(){if(_tgt)return false;if(_ydotoolOk===true||_ydotoolOk===false&&Date.now()-_ydotoolNoAt<MISS_TTL_MS)return _ydotoolOk;_ydotoolOk=false;if(_hasCmd("ydotool")){try{_cp.execFileSync(_toolCmd("pgrep")||"pgrep",["-x","ydotoold"],{timeout:2000,stdio:"pipe"});_ydotoolOk=true}catch(e){var sock=(process.env.YDOTOOL_SOCKET||"")||((process.env.XDG_RUNTIME_DIR||"/tmp")+"/.ydotool_socket");try{_fs.accessSync(sock);_ydotoolOk=true}catch(se){if(!_ydotoolSaid){_ydotoolSaid=!0;globalThis.__cdbDiag("[claude-cu] ydotool found but ydotoold not running - falling back to x11-bridge (XWayland)")}}}}_ydotoolNoAt=Date.now();return _ydotoolOk}
// ── x11-bridge: first-party X11/XWayland backend (replaces xdotool/scrot/import/wmctrl) ──
// The binary is resolved in cu_mode_preamble.js into globalThis.__cuX11BridgeBin.
function _x11BridgeBin(){if(_tgt)return _tgt.kind==="x11"?_tgt.bin:null;return process.env.X11_BRIDGE_BIN||globalThis.__cuX11BridgeBin}
// Why a bridge is unavailable. cu_mode_preamble.js records a bridge that is
// present but cannot run (foreign ELF loader, glibc/PipeWire older than the
// bridge floor, wrong arch, hang) in __cuBridgeFail with the real cause and a
// hint. Only a bridge that is genuinely missing gets the reinstall advice.
function _bridgeWhy(name,envVar){var f=globalThis.__cuBridgeFail&&globalThis.__cuBridgeFail[name];if(f)return name+" at "+f.path+" cannot run ("+f.cause+")"+(f.hint?" - "+f.hint:"");return name+" is missing from the package - set "+envVar+" or reinstall the package"}
function _bridgeState(name,bin){if(bin)return"present ("+bin+")";var f=globalThis.__cuBridgeFail&&globalThis.__cuBridgeFail[name];return f?"cannot run ("+f.cause+")":"absent"}
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
  if(_tgt&&_tgt.refuse)throw _tgtErr();
  var bin=_x11BridgeBin();
  if(!bin)throw new Error(_bridgeWhy("x11-bridge","X11_BRIDGE_BIN"));
  var res=_cp.execFileSync(bin,args,_spo({encoding:"utf-8",timeout:15000,maxBuffer:16*1024*1024},bin));
  var out=res.trim();
  return out?_parseBridgeJson("x11-bridge",out):null;
}
// Async twin of _x11Bridge. The SCREENSHOT path is async end to end (issue
// #232) - a hung bridge there must never block the Electron main process.
function _x11BridgeAsync(args,timeoutMs){
  if(_tgt&&_tgt.refuse)return Promise.reject(_tgtErr());
  var bin=_x11BridgeBin();
  if(!bin)return Promise.reject(new Error(_bridgeWhy("x11-bridge","X11_BRIDGE_BIN")));
  return _execFileAsync("x11-bridge",bin,args,timeoutMs||15000);
}
// Bridge-side monitor list (RandR names + root-window geometry). Used to map a
// root-coordinate region to a monitor name + monitor-relative coords for `zoom`.
// ASYNC: only ever reached from _captureRegion, which is async. A non-empty
// list is cached until a zoom answers "display not found" (a monitor was
// unplugged or renamed, see _cuDisplayNotFound); a failed or empty answer is
// not cached but retried after SCREENS_RETRY_MS, so a broken bridge costs the
// timeout once per window, not per shot, and a bridge that recovers is used.
var _x11ScreensCache=null,_x11ScreensRetryAt=0,_x11ScreensGen=0;
function _x11ScreensInvalidate(){_x11ScreensCache=null;_x11ScreensGen++;_x11ScreensRetryAt=0}
async function _x11BridgeScreens(){
  if(_x11ScreensCache!==null)return _x11ScreensCache;
  if(Date.now()<_x11ScreensRetryAt)return [];
  var gen=_x11ScreensGen,s=null,why="";
  try{s=await _x11BridgeAsync(["screens"],SCREENS_TIMEOUT_MS);if(!Array.isArray(s)||!s.length)why="no monitors in the answer"}catch(e){why=e.message||String(e)}
  if(gen!==_x11ScreensGen)return why?[]:s;
  if(why){globalThis.__cdbDiag("[claude-cu] x11-bridge screens failed: "+why+" - retrying in "+Math.round(SCREENS_RETRY_MS/1000)+"s");_x11ScreensRetryAt=Date.now()+SCREENS_RETRY_MS;return []}
  return _x11ScreensCache=s;
}
// A zoom whose --display names a monitor the bridge no longer has: every bridge
// answers "display `<name>` not found" (x11-bridge conn.rs resolve_monitor,
// wlroots-bridge screens.rs resolve_output, gnome-portal-bridge daemon.rs
// pick_screen). The cached monitor list is stale (hotplug, rename): the capture
// path drops it, re-enumerates and retries ONCE.
function _cuDisplayNotFound(e){return /display `[^`\n]*` not found/.test(String(e&&(e.message||e)))}
// ── Generic bridge invoker for the Wayland first-party backends ──
// wlroots-bridge and gnome-portal-bridge mirror x11-bridge's CLI/JSON contract
// (subcommand + --kebab flags, one JSON value on stdout, exit 1 + stderr on
// error). gnome-portal-bridge proxies through a portal session and can be
// slower, so we use a more generous timeout there.
// Bridge CLI contract exit codes (docs/computer-use-bridge-contract.md):
// 3 = the target monitor is not shared in the live portal session, 4 = no live
// session (the session daemon is gone), 5 = the user stopped screen sharing
// (the portal session was closed from the desktop's screen-sharing indicator).
// Consumers switch on these; the text matching below is only the fallback for
// bridges below contract 1.
var _BRIDGE_EXIT_NOT_SHARED=3,_BRIDGE_EXIT_NO_SESSION=4,_BRIDGE_EXIT_STOPPED_BY_USER=5;
// What the model reads after the user stopped screen sharing. Twin:
// STOPPED_BY_USER_MESSAGE in js/executor_linux.js (identical text).
// The block lifts when the task ends (__cuTaskBoundary, or the lock release)
// or after CU_PORTAL_IDLE_MS without Computer Use actions - not "with the next
// session": upstream can hold the CU lock across many turns (cloud Cowork, a
// guided tour). The model still must not retry on its own; the user decides.
var _CU_STOPPED_BY_USER_MSG="Screen sharing was stopped from the desktop (its screen-sharing indicator, or the desktop ended the session). Stop using Computer Use and ask the user whether to continue; do not retry. Computer Use can share the screen again once the task ends or after about 2 minutes without Computer Use actions.";
// Exit status of a failed execFileSync (.status) or execFile (.code; a string
// such as "ENOENT" when the spawn itself failed).
function _bridgeExitCode(e){if(!e)return null;if(typeof e.status==="number")return e.status;if(typeof e.code==="number")return e.code;return null}
// Contract file layout of a bridge with a session: its runtime dir holds
// session.sock, session.pid and, after the user stopped screen sharing,
// stopped-by-user. The one place that spells it out. An empty
// XDG_RUNTIME_DIR counts as unset (/tmp), as in the bridges; a relative one is
// unusable (XDG spec) and gives null.
function _bridgeRuntimeDir(){var d=process.env.XDG_RUNTIME_DIR;if(!d)return"/tmp";return _path.isAbsolute(d)?d:null}
function _bridgeRuntimeFile(bridge,file){var d=_bridgeRuntimeDir();return d===null?null:_path.join(d,bridge,file)}
// A bridge error about a monitor the user did not share in the portal consent
// dialog. The bridge text stays generic (older GNOME bridges append a remedy
// naming their own `forget-session`), but users only have `claude-desktop`, and
// this text is what the model reads: rewrite it into an instruction for the
// user. Keeps the monitor id and the shared list; text that does not parse
// keeps its wording and gets the instruction appended - always on exit 3, and
// on older bridges when it names the condition. Twin: notSharedText in
// js/executor_linux.js.
var _CU_RESET_HINT="Ask the user to run `claude-desktop --reset-screen-sharing`, then share all monitors when the screen-sharing dialog appears.";
function _cuNotSharedText(msg,isNotShared){
  var s=String(msg==null?"":msg);
  var m=s.match(/monitor (\S+) \([^)]*\) is not shared in the portal session \(shared: ([^)]*)\)(?:;[^\n]*?forget-session[^\n]*)?/);
  if(m)return s.slice(0,m.index)+"Monitor "+m[1]+" is not shared with Claude (shared: "+(m[2].trim()||"none")+"). "+_CU_RESET_HINT+s.slice(m.index+m[0].length);
  if(isNotShared||/is not shared in the portal session|forget-session/.test(s)){var t=s.replace(/\s+$/,"");return t+(/[.!?]$/.test(t)?" ":". ")+_CU_RESET_HINT}
  return null;
}
// Classify a failed bridge call in place (keeps code/killed/stderr): a monitor
// that is not shared gets the rewritten text and __cdbNotShared (the capture
// path surfaces it instead of trying other tiers); exit 4 gets __cdbNoSession
// (the portal-command paths recover from it); exit 5 gets __cdbStoppedByUser
// (the portal-command paths latch it and never recover).
function _cuNotSharedError(e){
  if(!e||typeof e!=="object")return e;
  var code=_bridgeExitCode(e);
  var t=_cuNotSharedText(e.message,code===_BRIDGE_EXIT_NOT_SHARED);
  try{
    if(t!==null){e.message=t;e.__cdbNotShared=!0}
    if(code===_BRIDGE_EXIT_NO_SESSION)e.__cdbNoSession=!0;
    if(code===_BRIDGE_EXIT_STOPPED_BY_USER||/screen sharing was stopped|stopped by the user/.test(String(e.message)))e.__cdbStoppedByUser=!0;
  }catch(me){}
  return e;
}
function _bridge(bin,args,timeoutMs){
  if(!bin)throw new Error("bridge binary not available");
  var res;
  try{res=_cp.execFileSync(bin,args,_spo({encoding:"utf-8",timeout:timeoutMs||15000,maxBuffer:16*1024*1024},bin))}catch(e){throw _cuNotSharedError(e)}
  var out=res.trim();
  return out?_parseBridgeJson(bin,out):null;
}
// Shared promisified execFile for every ASYNC bridge call (issue #232). Same
// contract as _bridge/_x11Bridge: one JSON value on stdout, exit 1 + stderr on
// error; label names the bridge in the parse error.
function _execFileAsync(label,bin,args,timeoutMs){
  return new Promise(function(resolve,reject){
    _cp.execFile(bin,args,_spo({encoding:"utf-8",timeout:timeoutMs||15000,maxBuffer:16*1024*1024},bin),function(err,stdout){
      if(err){reject(_cuNotSharedError(err));return}
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
//   GNOME_SESSION_START_MS  async session-start, may wait out a consent dialog;
//                           above the bridge's own 120 s ready wait.
var SCREENS_TIMEOUT_MS=5000;
var GNOME_SYNC_START_MS=8000;
var GNOME_SESSION_START_MS=125000;
// PORTAL FAILURE LATCH. Before this, a failed session-start left no memo: every
// subsequent portal command re-ran the full blocking session-start and then the
// command itself, so one click could block the main process for two minutes and
// every following click did it again. Now a failure is remembered for a cooldown
// and portal commands fail fast (and legibly) until it lapses. A fresh CU lock
// clears it - a new user gesture deserves a real retry, consent dialog included.
var GNOME_PORTAL_COOLDOWN_MS=60000;
// Idle teardown (issue #293): the portal session - and with it the desktop's
// "screen is being shared" indicator - ends this long after the last portal
// command, and a stop-sharing latch lifts after the same idle time. The lock
// alone cannot scope it: upstream holds the remote CU lock across turns (cloud
// Cowork releases it only after a 12 min idle sweep). See _gnomeIdleArm.
var CU_PORTAL_IDLE_MS=120000;
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
// The session daemon can vanish under a held lock: `claude-desktop
// --reset-screen-sharing` (the bridge's forget-session) ends it, or it crashed.
// Older bridges then answer a portal command by opening a one-shot portal
// session per command (a consent dialog each, now that the grant is gone);
// contract-1 bridges exit 4. Either way the stale "active" flag has to go and
// ONE fresh session has to start.
// Gone = no socket, or a pidfile naming a dead process (a SIGKILLed, OOM-killed
// or panicked daemon leaves its socket behind). A socket without a pidfile is
// left alone: bridges before the pidfile never write one. So is a runtime dir
// that cannot be pinned down: XDG_RUNTIME_DIR relative, or set but empty (the
// bridges since the CLI contract read that as /tmp, older ones as a relative
// path) - "no socket" there would restart the session before every command.
// Contract-1 bridges still report a lost session through exit 4.
// A daemon that exited because the USER stopped screen sharing is not "gone":
// it leaves the stopped-by-user marker, and replacing it would re-share the
// screen the user just stopped sharing (see _gnomeStoppedCheck).
function _gnomeDaemonGone(){
  try{
    var d=process.env.XDG_RUNTIME_DIR;
    if(d!==undefined&&(d===""||!_path.isAbsolute(d)))return !1;
    if(_gnomeStoppedMarker())return !1;
    var sock=_bridgeRuntimeFile("gnome-portal-bridge","session.sock");
    if(sock===null)return !1;
    if(!_fs.existsSync(sock))return !0;
    var pidFile=_bridgeRuntimeFile("gnome-portal-bridge","session.pid");
    if(!_fs.existsSync(pidFile))return !1;
    var pid=parseInt(String(_fs.readFileSync(pidFile,"utf8")).trim(),10);
    if(!(pid>1))return !1;
    try{process.kill(pid,0)}catch(ke){return ke&&ke.code==="ESRCH"}
    return !1;
  }catch(e){return !1}
}
// USER STOPPED SCREEN SHARING (bridge exit 5). The user clicked "Stop sharing"
// in the desktop's screen-sharing indicator; the daemon wrote the
// stopped-by-user marker and exited. That is a decision, not a fault: while
// latched no session is started (no _gnomeSessionLost /
// _gnomeRestartAfterReset recovery, no sync backstop, no lazy start), and every
// portal command fails fast with _CU_STOPPED_BY_USER_MSG without spawning the
// bridge. The latch is cleared after a session-end (which also removes the
// marker) on lock release, task end (__cuTaskBoundary) or CU_PORTAL_IDLE_MS
// without a real portal command (_gnomeIdleFire), and when a new lock starts.
// Commands refused by the latch never re-arm the idle timer: a model that keeps
// retrying must not keep the block alive.
var _gnomeStoppedByUser=!1;
// Same runtime-dir rules as _gnomeDaemonGone: an undeterminable dir answers no.
function _gnomeStoppedMarker(){
  try{
    var d=process.env.XDG_RUNTIME_DIR;
    if(d!==undefined&&(d===""||!_path.isAbsolute(d)))return !1;
    var f=_bridgeRuntimeFile("gnome-portal-bridge","stopped-by-user");
    return f!==null&&_fs.existsSync(f);
  }catch(e){return !1}
}
function _gnomeStoppedError(){var err=new Error(_CU_STOPPED_BY_USER_MSG);err.__cdbSurface=!0;err.__cdbStoppedByUser=!0;return err}
// Set the latch. _gnomeDaemonMayExist stays set so the end that clears it still
// sends session-end (which removes the marker). The idle timer counts from here.
function _gnomeLatchStopped(why){
  if(_gnomeStoppedByUser)return;
  _gnomeStoppedByUser=!0;_gnomeSessionActive=!1;_gnomeDaemonMayExist=!0;_gnomeMouseHeld=!1;_wlScreensInvalidate();
  globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge: screen sharing was stopped ("+why+"); no new session until the task ends or "+Math.round(CU_PORTAL_IDLE_MS/1000)+" s pass without Computer Use actions");
  _gnomeIdleArm();_gnomeCheckArm();
  _gnomeShareEnded(why);
}
// STOP SHARING = ABORT THE TURN (maintainer ruling 2026-11-10). The latch alone
// only refused the NEXT action; the turn kept going until the model tried one.
// Upstream's own "user stopped sharing" abort (globalThis.__cdbCuShareEnded,
// sub-patch 17c; it stops the lock holder and every app-mode holder, as its
// Escape does) runs once per lock hold and once per task within a hold (cloud
// Cowork holds one lock across tasks): the watch below and a command's exit 5
// both end up here.
var _gnomeShareFireArmed=!0;
function _gnomeShareEnded(why){
  if(!_gnomeShareFireArmed)return;
  _gnomeShareFireArmed=!1;
  var s=globalThis.__cdbCuShareStop;
  if(s&&typeof s.fire==="function")s.fire("gnome-portal-bridge",why);
}
// The daemon writes the stopped-by-user marker and exits; it is a setsid'd
// grandchild (session-start returns once it is ready), so there is no exit
// event of ours to wait for: watch its runtime dir (js/cu_share_stop.js) from
// the moment a session is up until it ends.
var _gnomeShareWatch=null;
function _gnomeShareWatchArm(){
  if(_gnomeShareWatch)return;
  var s=globalThis.__cdbCuShareStop;if(!s||typeof s.watch!=="function")return;
  _gnomeShareWatch=s.watch("gnome-portal-bridge",function(){
    if(_gnomeSessionActive&&!_gnomeSessionEnding&&!_gnomeStoppedByUser&&_gnomeStoppedMarker())_gnomeMarkStopped("stopped-by-user marker appeared");
  });
}
function _gnomeShareWatchClose(){if(_gnomeShareWatch){_gnomeShareWatch.close();_gnomeShareWatch=null}}
// A portal COMMAND answered exit 5: latch and return the error for the model.
// Not while a start or an end is in flight: those own the flags (a marker left
// from before this lock's session-start is that start's to remove), so the
// error is returned unlatched. A session-start that itself answers exit 5 (the
// new daemon was closed before it became ready) latches in its own catch.
function _gnomeMarkStopped(why){
  if(!_gnomeSessionStarting&&!_gnomeSessionEnding)_gnomeLatchStopped(why);
  return _gnomeStoppedError();
}
function _gnomeStoppedClear(why){
  if(!_gnomeStoppedByUser)return;
  _gnomeStoppedByUser=!1;
  globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge: stopped-by-user latch cleared ("+why+")");
}
// Before a portal command: latched already, or the marker of the session we
// hold (the daemon is gone, so the bridge would only answer exit 5 anyway).
function _gnomeStoppedCheck(){
  if(_gnomeStoppedByUser)return !0;
  if(_gnomeSessionActive&&!_gnomeSessionStarting&&!_gnomeSessionEnding&&_gnomeStoppedMarker()){_gnomeMarkStopped("stopped-by-user marker");return !0}
  return !1;
}
// Clear the flags of a session whose daemon is gone. Not while a start or an
// end is in flight: those own the flags. Returns whether it cleared anything.
function _gnomeSessionLost(why){
  if(!_gnomeSessionActive||_gnomeSessionStarting||_gnomeSessionEnding)return !1;
  _gnomeSessionActive=!1;_gnomeDaemonMayExist=!1;_gnomeMouseHeld=!1;_wlScreensInvalidate();
  globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session daemon is gone ("+why+"; screen sharing reset?); starting a new session");
  return !0;
}
// The sync input path cannot wait out a consent dialog (the grant is gone, so
// one is certain): start the session in the background with its full budget,
// and tell the model to have the user approve it and retry.
function _gnomeRestartAfterReset(){
  try{var p=_gnomeEnsureSession();if(p&&typeof p.catch==="function")p.catch(function(){})}catch(e){}
  var err=new Error("The screen-sharing session was reset (claude-desktop --reset-screen-sharing). Ask the user to approve the screen-sharing dialog, then retry the action.");
  err.__cdbSurface=!0;
  return err;
}
// ── Idle teardown (CU_PORTAL_IDLE_MS) ──
// One unref'd timer, re-armed when a real portal command settles (the bridge
// was spawned for it), when a session comes up and when the stop latch is set.
// Commands refused before the spawn (latch, cooldown) do not touch it. On
// expiry it ends the portal session, or lifts the stop latch, through
// _gnomeSessionEnd - the lock is left alone, and the next portal command
// starts a session again through the lazy (async) or sync-backstop path.
// It never ends what is in use: a start, an end or a portal command in flight,
// or a mouse button held by left_mouse_down without its left_mouse_up, re-arm
// it instead. The held button defers it ONCE: a second expiry with no portal
// command in between ends the session anyway (a model that holds a button for
// 4 min without any action has abandoned it). Any left_mouse_up attempt clears
// the flag, whatever the bridge answers. hold_key needs no flag here: on GNOME it is ONE `hold-key
// --duration-ms` command that releases the key itself, so it is a command in
// flight for as long as the key is down. Lock release / a new lock / a task
// boundary cancel it (_gnomeSessionEnd, __setLockHeld).
// _gnomeQueriesInFlight: portal-free bridge calls (`screens`) in flight. A
// capture enumerates monitors before its zoom; the session must not end in
// between, but a query alone never re-arms the timer (it is not a CU action).
var _gnomeIdleTimer=null,_gnomeCmdsInFlight=0,_gnomeQueriesInFlight=0,_gnomeMouseHeld=!1,_gnomeHeldDeferred=!1;
function _gnomeIdleCancel(){if(_gnomeIdleTimer){clearTimeout(_gnomeIdleTimer);_gnomeIdleTimer=null}}
function _gnomeIdleArm(){
  _gnomeIdleCancel();
  _gnomeIdleTimer=setTimeout(_gnomeIdleFire,CU_PORTAL_IDLE_MS);
  if(_gnomeIdleTimer&&typeof _gnomeIdleTimer.unref==="function")_gnomeIdleTimer.unref();
}
function _gnomeIdleFire(){
  _gnomeIdleTimer=null;
  // These finish by themselves: defer as often as needed. While the stop latch
  // is set the daemon is gone: no command or held button keeps anything alive,
  // only a start or an end owns the flags.
  var latched=_gnomeStoppedByUser;
  var busy=_gnomeSessionStarting?"a session-start":_gnomeSessionEnding?"a session-end":latched?null:_gnomeCmdsInFlight>0?"a portal command":_gnomeQueriesInFlight>0?"a bridge query":null;
  if(busy){globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge: idle timer deferred, "+busy+" is in progress");_gnomeIdleArm();return}
  var secs=Math.round(CU_PORTAL_IDLE_MS/1000);
  if(_gnomeMouseHeld&&!latched){
    if(!_gnomeHeldDeferred){_gnomeHeldDeferred=!0;globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge: idle timer deferred, a held mouse button is in progress");_gnomeIdleArm();return}
    globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge: a mouse button has been held for "+(2*secs)+" s without a Computer Use action, ending the portal session anyway");
    _gnomeMouseHeld=!1;
  }
  if(_gnomeStoppedByUser)globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge: idle for "+secs+" s after screen sharing was stopped, lifting the block");
  else if(_gnomeSessionActive||_gnomeDaemonMayExist)globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge: idle for "+secs+" s, ending the portal session");
  else return;
  _gnomeSessionEnd("idle").catch(function(){});
}
// Bracket the bridge spawn of a portal command (not the ensure before it: a
// start in flight is _gnomeSessionStarting, and the sync one blocks anyway).
// A command that passed its session checks re-arms the timer as it spawns.
function _gnomeCmdBegin(){_gnomeCmdsInFlight++;_gnomeIdleArm();_gnomeCheckArm()}
function _gnomeCmdEnd(sub,ok){
  _gnomeCmdsInFlight--;
  if(ok&&sub==="left-mouse-down")_gnomeMouseHeld=!0;
  _gnomeHeldDeferred=!1;
  _gnomeIdleArm();_gnomeCheckArm();
}
// Any left_mouse_up attempt releases the hold as far as the idle timer is
// concerned, even one refused or failed before the bridge answers.
function _gnomeCmdSeen(sub){if(sub==="left-mouse-up")_gnomeMouseHeld=!1}
// ── Cloud-session check (js/cu_session_check.js, #293) ──
// A cloud Cowork task never tells main that its turn ended, and upstream holds
// the lock for up to 12 min after it. While a portal session is up (or the stop
// latch is set) for a cloud lock holder (session_X / cse_X, from
// __setLockHeld), the shared poller asks upstream's session-state check 10 s
// after the last portal command; an ended session goes through __cuTaskBoundary
// (via __linuxExecutor, so the accessibility tools' wrapper sees it too). Armed
// next to the idle timer, stopped by every session end; the idle timer stays
// the backstop. Busy = what defers the idle end (_gnomeIdleFire), held button
// included; active = a session up or the stop latch set (else it stops). Every
// bridge call touches it, so a reply in flight never ends a session that a
// tool call has just started to use. Hub chats (UUID holders) are never checked.
var _gnomeHolder=null;
function _gnomeCheckBusy(){var l=_gnomeStoppedByUser;return !!(_gnomeSessionStarting||_gnomeSessionEnding||!l&&(_gnomeCmdsInFlight>0||_gnomeQueriesInFlight>0||_gnomeMouseHeld))}
function _gnomeCheckArm(){
  var c=globalThis.__cdbCuSessionCheck,h=_gnomeHolder;
  if(!c||!(_gnomeSessionActive||_gnomeStoppedByUser))return;
  c.arm(h||null,{busy:_gnomeCheckBusy,active:function(){return _gnomeSessionActive||_gnomeStoppedByUser},onEnded:function(){var ex=globalThis.__linuxExecutor;return ex&&typeof ex.__cuTaskBoundary==="function"?ex.__cuTaskBoundary(h,"session-check",h):void 0}});
}
function _gnomeCheckStop(why){var c=globalThis.__cdbCuSessionCheck;if(c)c.stop(why)}
function _gnomeCheckTouch(){var c=globalThis.__cdbCuSessionCheck;if(c&&typeof c.touch==="function")c.touch()}
var _gnomePortalCmds={"zoom":1,"screenshot":1,"pointer-move":1,"pointer-click":1,"pointer-scroll":1,"pointer-drag":1,"left-mouse-down":1,"left-mouse-up":1,"key-sequence":1,"type":1,"hold-key":1};
function _wlBridgeCall(args){
  if(_tgt&&_tgt.refuse)throw _tgtErr();
  var b=_wlBridge();if(!b)throw new Error("no covered Wayland bridge available");
  if(b.name==="gnome-portal-bridge")_gnomeCheckTouch();
  var portalCmd=b.name==="gnome-portal-bridge"&&_gnomePortalCmds[args[0]]===1;
  // A portal command with no portal session behind it can only fail. Running it
  // anyway costs another full blocking timeout, so refuse while latched down.
  if(portalCmd){
    _gnomeCmdSeen(args[0]);
    if(_gnomeStoppedCheck())throw _gnomeStoppedError();
    if(_gnomeSessionActive&&_gnomeDaemonGone()&&_gnomeSessionLost("no session daemon"))throw _gnomeRestartAfterReset();
    if(!_gnomeSessionActive&&_gnomePortalDown())throw _gnomePortalDownError();
    _gnomeEnsureSessionSync();
    if(_gnomeStoppedByUser)throw _gnomeStoppedError();
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
  var ok=!1;
  if(portalCmd)_gnomeCmdBegin();
  try{var r=_bridge(b.bin,args,t);ok=!0;return r}
  catch(e){
    if(portalCmd&&e&&e.__cdbStoppedByUser)throw _gnomeMarkStopped("bridge exit 5");
    if(portalCmd&&e&&e.__cdbNoSession&&_gnomeSessionLost("bridge exit 4"))throw _gnomeRestartAfterReset();
    throw e;
  }
  finally{if(portalCmd)_gnomeCmdEnd(args[0],ok)}
}
// ASYNC twin of _wlBridgeCall, used by the screenshot path (issue #232). Same
// portal rules, but it AWAITS the async session ensure instead of running the
// blocking sync backstop, so a hung portal cannot freeze the main process.
async function _wlBridgeCallAsync(args,timeoutOverrideMs){
  if(_tgt&&_tgt.refuse)throw _tgtErr();
  var b=_wlBridge();if(!b)throw new Error("no covered Wayland bridge available");
  if(b.name==="gnome-portal-bridge")_gnomeCheckTouch();
  var portalCmd=b.name==="gnome-portal-bridge"&&_gnomePortalCmds[args[0]]===1;
  if(portalCmd){
    // This path can await the consent dialog, so a vanished daemon is simply
    // replaced here (one dialog, full budget) instead of failing the call -
    // unless the user stopped sharing, which is never undone behind their back.
    _gnomeCmdSeen(args[0]);
    if(_gnomeStoppedCheck())throw _gnomeStoppedError();
    if(_gnomeSessionActive&&_gnomeDaemonGone())_gnomeSessionLost("no session daemon");
    if(!_gnomeSessionActive&&_gnomePortalDown())throw _gnomePortalDownError();
    await _gnomeEnsureSession();
    if(_gnomeStoppedByUser)throw _gnomeStoppedError();
    if(!_gnomeSessionActive)throw _gnomePortalDownError();
  }
  var t=timeoutOverrideMs||(b.name==="gnome-portal-bridge"&&!portalCmd?15000:b.timeout);
  var ok=!1,query=b.name==="gnome-portal-bridge"&&!portalCmd;
  if(portalCmd)_gnomeCmdBegin();
  if(query)_gnomeQueriesInFlight++;
  try{var r=await _execFileAsync(b.name,b.bin,args,t);ok=!0;return r}
  catch(e){
    if(portalCmd&&e&&e.__cdbStoppedByUser)throw _gnomeMarkStopped("bridge exit 5");
    if(portalCmd&&e&&e.__cdbNoSession&&_gnomeSessionLost("bridge exit 4"))throw _gnomeRestartAfterReset();
    throw e;
  }
  finally{if(portalCmd)_gnomeCmdEnd(args[0],ok);if(query)_gnomeQueriesInFlight--}
}
// Synchronous session-start backstop for the per-call input/capture path: these
// callers run the bridge synchronously and need the portal session up FIRST.
// In normal operation the CU lock hook (__setLockHeld → _gnomeEnsureSession,
// async) has already brought the session up, so this is a no-op. It only does
// the blocking session-start if a portal command runs without the lock hook
// having fired, or after an idle / task-boundary end with the lock still held -
// and by then a consent dialog is expected UX anyway (the user invoked
// Computer Use). A dialog that outlasts GNOME_SYNC_START_MS throws a surfaced
// "approve, then retry" error and continues in the background (see the catch).
function _gnomeEnsureSessionSync(){
  // A teardown in flight owns the session: do not race a second blocking
  // session-start (and a second consent dialog) into it. This path cannot await,
  // so it reports "not up" and the caller fails soft, which is what it already
  // does whenever the portal is not ready.
  if(_gnomeSessionEnding){globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge sync backstop declined: a session-end is in flight");return !1}
  if(_gnomeStoppedByUser)return !1;
  if(_gnomeSessionActive||_gnomeSessionStarting)return _gnomeSessionActive;
  if(_gnomePortalDown())return !1;
  var bin=_gnomeBridgeBin();if(!bin)return !1;
  if(!_gnomeExitHooked){_gnomeExitHooked=!0;process.once("exit",function(){if(_gnomeSessionActive||_gnomeDaemonMayExist){try{_cp.execFileSync(_gnomeBridgeBin(),["session-end"],{timeout:5000,stdio:"ignore"})}catch(e){}}})}
  _gnomeDaemonMayExist=!0;
  try{_bridge(bin,["session-start"],GNOME_SYNC_START_MS);_gnomeSessionActive=!0;_gnomePortalClearDown();_wlScreensInvalidate();_gnomeIdleArm();_gnomeCheckArm();_gnomeShareWatchArm();globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session started (sync backstop)");return !0}
  catch(e){
    if(_gnomeAlreadyActive(e)){_gnomeSessionActive=!0;_gnomePortalClearDown();_wlScreensInvalidate();_gnomeIdleArm();_gnomeCheckArm();_gnomeShareWatchArm();globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session already active (sync backstop); using it");return !0}
    // Closed before it became ready: a stop, not a fault - latch, no cooldown, no retry.
    if(e&&e.__cdbStoppedByUser){_gnomeLatchStopped("sync backstop session-start exit 5");return !1}
    // No restore token (the user left "Remember this selection" unticked, or
    // GNOME < 46): the start after an idle or task-boundary end raises the
    // consent dialog, and 8 s is not enough to answer it. The daemon is still
    // parked on that dialog, so this is not a portal fault: no cooldown. Hand
    // it to the async start (full GNOME_SESSION_START_MS; the bridge's second
    // session-start waits on the daemon already coming up, no second dialog)
    // and tell the model to have the user approve, then retry.
    if(_gnomeSyncStartPending(e)){
      globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session-start did not finish within "+Math.round(GNOME_SYNC_START_MS/1000)+" s (sync backstop; consent dialog open?) - continuing it in the background");
      try{var p=_gnomeEnsureSession();if(p&&typeof p.catch==="function")p.catch(function(){})}catch(ke){}
      var err=new Error("Screen sharing is waiting for approval. Ask the user to approve the screen-sharing dialog, then retry the action.");
      err.__cdbSurface=!0;
      throw err;
    }
    globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session-start failed (sync backstop): "+(e.message||e));_gnomePortalMarkDown("sync backstop session-start failed");return !1}
}
// A failed sync session-start whose daemon may still be waiting on the consent
// dialog: the call hit its timeout (the bridge CLI was killed; the daemon runs
// in its own session and survives it), or the daemon's pidfile names a live
// process. A bridge that failed on its own with no daemon left is a genuine
// portal failure (cooldown, as before). Same runtime-dir rules as
// _gnomeDaemonGone.
function _gnomeSyncStartPending(e){
  if(e&&(e.code==="ETIMEDOUT"||e.killed===!0||(e.signal&&e.status==null)))return !0;
  try{
    var d=process.env.XDG_RUNTIME_DIR;
    if(d!==undefined&&(d===""||!_path.isAbsolute(d)))return !1;
    var pidFile=_bridgeRuntimeFile("gnome-portal-bridge","session.pid");
    if(pidFile===null||!_fs.existsSync(pidFile))return !1;
    var pid=parseInt(String(_fs.readFileSync(pidFile,"utf8")).trim(),10);
    if(!(pid>1))return !1;
    try{process.kill(pid,0);return !0}catch(ke){return ke&&ke.code==="EPERM"}
  }catch(fe){return !1}
}
// Bridge-side monitor list (snake_case screens) for the active Wayland bridge.
// Mirrors _x11BridgeScreens; used to map a global-logical region to a monitor
// name + monitor-relative coords for `zoom --display`.
// A successful list is cached until a GNOME portal session starts or a zoom
// answers "display not found" (_cuDisplayNotFound). A FAILED enumeration is not:
// it is retried after SCREENS_RETRY_MS, so one slow D-Bus reply (or a bridge
// that was still coming up) does not pin every later capture to global
// coordinates for the rest of the session (issue #293).
var SCREENS_RETRY_MS=30000;
// Re-query delay for a GNOME list that came back without is_shared while a
// portal session is up (see _wlScreensAwaitingShare).
var SCREENS_SHARE_RETRY_MS=2000;
var _wlScreensCache=null,_wlScreensRetryAt=0,_wlScreensGen=0;
var _wlScreensSoft=null,_wlScreensSoftUntil=0,_wlScreensSoftLogged=!1;
// Drop the cached list so the next caller re-enumerates. Called on a zoom that
// named a display the bridge no longer has (hotplug), and once per GNOME
// portal session start: while a session daemon runs, `screens` marks the
// streamed monitors with is_shared, and a list fetched before the session (or
// in a previous one, with a different share choice) does not carry that. The
// generation counter keeps a fetch that was already in flight - success or
// failure - from landing its stale answer over the invalidation, and the
// failure retry window is reset: a failure from before this session must not
// hold the fresh session's enumeration back for SCREENS_RETRY_MS.
function _wlScreensInvalidate(){_wlScreensCache=null;_wlScreensGen++;_wlScreensRetryAt=0;_wlScreensSoft=null;_wlScreensSoftUntil=0;_wlScreensSoftLogged=!1}
// The bridge asks the session daemon for is_shared within a short budget and
// omits the field when the daemon does not answer in time (a busy start). A
// list with no is_shared on any entry while the GNOME portal session is up is
// therefore provisional: caching it would pin Electron's primary as the
// default display for the whole session (the #293 wrong-monitor case).
function _wlScreensAwaitingShare(list){
  if(!_isGnomeCovered()||!_gnomeSessionActive||!list.length)return !1;
  for(var i=0;i<list.length;i++){if(list[i]&&Object.prototype.hasOwnProperty.call(list[i],"is_shared"))return !1}
  return !0;
}
async function _wlBridgeScreens(){
  if(_wlScreensCache!==null)return _wlScreensCache;
  if(_wlScreensSoft!==null&&Date.now()<_wlScreensSoftUntil)return _wlScreensSoft;
  if(Date.now()<_wlScreensRetryAt)return [];
  var list,gen=_wlScreensGen;
  try{
    var s=await _wlBridgeCallAsync(["screens"],SCREENS_TIMEOUT_MS);list=Array.isArray(s)?s:[];
    if(gen===_wlScreensGen){
      if(_wlScreensAwaitingShare(list)){
        // Serve it (geometry is valid for zoom mapping) but re-query shortly.
        _wlScreensSoft=list;_wlScreensSoftUntil=Date.now()+SCREENS_SHARE_RETRY_MS;
        if(!_wlScreensSoftLogged){_wlScreensSoftLogged=!0;globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge screens carries no is_shared during a portal session - not cached, re-querying in "+Math.round(SCREENS_SHARE_RETRY_MS/1000)+"s")}
      }else{_wlScreensCache=list;_wlScreensSoft=null}
    }
  }
  catch(e){
    globalThis.__cdbDiag("[claude-cu] "+(_wlBridge()?_wlBridge().name:"bridge")+" screens failed: "+(e.message||e)+(gen===_wlScreensGen?" - retrying in "+Math.round(SCREENS_RETRY_MS/1000)+"s":" (stale request from before a session start - ignored)"));
    if(gen===_wlScreensGen)_wlScreensRetryAt=Date.now()+SCREENS_RETRY_MS;
    list=[];
  }
  // An empty monitor list means the region below is sent in GLOBAL logical
  // coordinates with no --display, which is wrong on any multi-monitor layout.
  // Say so once instead of silently returning a mis-cropped image (issue #232).
  if(!list.length)globalThis.__cdbDiag("[claude-cu] no bridge monitor list - zoom will use global coordinates with no --display (multi-monitor captures will be wrong)");
  return list;
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
// Default display for a GNOME capture that names no display (issue #293).
// The portal ScreenCast session streams only the monitor(s) the user shared in
// the consent dialog (a restore token replays that choice without a dialog).
// Electron's primary need not be one of them, and Mutter and Electron do not
// always agree on which monitor is primary, so defaulting to Electron's primary
// captured and clicked against a monitor the session does not stream. While a
// session daemon runs, `screens` marks the streamed monitors with is_shared:
//   one shared            -> that monitor
//   several shared        -> the Mutter primary among them, else the first
//   none / field absent   -> null (caller keeps Electron's primary; this covers
//                            no daemon yet, a bridge without is_shared, and a
//                            failed enumeration)
// Returns the _getMonitors() displayId (Electron display index) whose
// bounds.x/y equal the shared monitor's geometry.x/y (both global logical), or
// null. GNOME only: wlroots-bridge has no portal share, X11 has no bridge
// session, and KWin runs js/executor_linux.js.
var _lastDefaultDiag=null;
async function _gnomeSharedDefaultDisplayId(){
  if(!_isGnomeCovered()||!_gnomeBridgeBin())return null;
  // COWORK_SCREENSHOT_CMD is the first capture tier in _captureRegion; with it
  // set a screenshot outside a held lock never touched the portal, and this
  // lookup must not start a session (and raise the consent dialog) for it.
  if(process.env.COWORK_SCREENSHOT_CMD)return null;
  // Query AFTER the daemon is up, so is_shared reflects the live session. The
  // capture that follows is a portal command and would bring the session up
  // anyway; normally the CU lock hook already did. A latched-down portal
  // answers null at once and the capture reports the real failure. So does a
  // session the user stopped sharing.
  if(_gnomeStoppedByUser)return null;
  if(!_gnomeSessionActive){
    if(_gnomePortalDown())return null;
    try{await _gnomeEnsureSession()}catch(e){}
    if(!_gnomeSessionActive)return null;
  }
  var screens=await _wlBridgeScreens();
  var shared=[];
  for(var i=0;i<screens.length;i++){if(screens[i]&&screens[i].is_shared===true)shared.push(screens[i])}
  if(!shared.length)return null;
  var pick=null;
  if(shared.length>1){for(var j=0;j<shared.length;j++){if(shared[j].is_primary){pick=shared[j];break}}}
  if(!pick)pick=shared[0];
  var g=pick.geometry||{},mons=_getMonitors(),label=pick.name||pick.id;
  for(var k=0;k<mons.length;k++){
    if(mons[k].originX===g.x&&mons[k].originY===g.y){
      var msg="[claude-cu] default display: shared monitor "+label+" ("+shared.length+" shared) -> Electron display "+mons[k].displayId+" ("+mons[k].label+")";
      if(msg!==_lastDefaultDiag){_lastDefaultDiag=msg;globalThis.__cdbDiag(msg)}
      return mons[k].displayId;
    }
  }
  var miss="[claude-cu] default display: shared monitor "+label+" at "+g.x+","+g.y+" matches no Electron display ["+mons.map(function(m){return m.label+"@"+m.originX+","+m.originY}).join(", ")+"] - using the primary display";
  if(miss!==_lastDefaultDiag){_lastDefaultDiag=miss;globalThis.__cdbDiag(miss)}
  return null;
}
// ── GNOME portal-session daemon lifecycle ──
// gnome-portal-bridge holds ONE portal RemoteDesktop+ScreenCast session per
// tool-use lock (one consent dialog; restore-token dialog-free on GNOME 46+).
// Driven by the CU lock via __setLockHeld (wired from Patches 4b/4b.2 in
// fix_computer_use_linux.nim, which call __linuxExecutor.__setLockHeld in BOTH
// kwin and regular mode), ended early by the task boundary (__cuTaskBoundary)
// and by CU_PORTAL_IDLE_MS without a portal command (_gnomeIdleFire). If no
// session is up we lazy-start on the next PORTAL command (input/capture - see
// _gnomePortalCmds; never for enumeration) and stop on process exit as a
// backstop.
var _gnomeSessionActive=!1,_gnomeExitHooked=!1,_gnomeSessionStarting=null,_gnomeSessionEnding=null,_gnomeSessionWanted=!1;
// True from the moment a session-start is spawned until a session-end succeeds.
// A start that failed or timed out can still leave the bridge daemon parked on
// the consent dialog, which only a session-end removes (mirrors
// bridgeDaemonMayExist in js/executor_linux.js).
var _gnomeDaemonMayExist=!1;
// session-start refuses while a daemon is up ("a portal session is already
// active"): e.g. a start that outlived its sync budget while the user was still
// answering the dialog. That daemon IS the session we asked for (the KWin twin
// passes allowAlreadyActive for the same reason).
function _gnomeAlreadyActive(e){return /already active/i.test(String(e&&(e.message||e)))}
async function _gnomeSessionStart(){
  var bin=_gnomeBridgeBin();if(!bin)return;
  _gnomeDaemonMayExist=!0;
  try{await _bridgeAsync(bin,["session-start"],GNOME_SESSION_START_MS);_gnomeSessionActive=!0;_gnomePortalClearDown();_wlScreensInvalidate();_gnomeIdleArm();_gnomeCheckArm();_gnomeShareWatchArm();globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session started")}
  catch(e){
    if(_gnomeAlreadyActive(e)){_gnomeSessionActive=!0;_gnomePortalClearDown();_wlScreensInvalidate();_gnomeIdleArm();_gnomeCheckArm();_gnomeShareWatchArm();globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session already active; using it");return}
    // The new daemon was closed before it became ready (the user stopped
    // sharing, or the desktop ended the session): latch for this lock instead
    // of the cooldown, so nothing starts it again until the lock ends.
    if(e&&e.__cdbStoppedByUser){_gnomeLatchStopped("session-start exit 5");return}
    globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session-start failed: "+(e.message||e));_gnomePortalMarkDown("session-start failed")}
}
// Stop the portal session. Mirrors stopBridgeSession() in js/executor_linux.js,
// BOTH halves of it: clear the flag synchronously on entry so the last caller
// wins, AND publish _gnomeSessionEnding so the ensure paths serialise against a
// teardown in progress. Without the await, a lock released while session-start
// is still parked on the XDG RemoteDesktop consent dialog (up to
// GNOME_SESSION_START_MS) loses the update: session-end runs first, then the
// start resolves and re-sets _gnomeSessionActive=!0 with no lock held, leaving
// the bridge daemon alive until the process.once("exit") backstop. Without the
// _gnomeSessionEnding latch, the window where both flags are clear (which spans
// two awaits, so up to ~45s) lets _gnomeEnsureSessionSync past its guard and
// start a SECOND session - a blocking session-start on the main process plus a
// second consent dialog - which this teardown would then rip out from under the
// command that asked for it.
// why names the trigger in the latch-cleared line: "lock released" (default),
// "idle" (_gnomeIdleFire) or "task boundary" (__cuTaskBoundary).
async function _gnomeSessionEnd(why){
  // Record the INTENT first, before any early return: a release that lands while
  // a start is only QUEUED behind an earlier teardown must still cancel it. The
  // queued continuation consults this flag, which is how executor_linux.js's
  // bridgeSessionActive makes ensureBridgeSession abort a start that a stop
  // overtook. Without it, end -> queued start -> end ends with the portal session
  // UP and no lock held: a live RemoteDesktop/ScreenCast session while the user
  // believes Computer Use is idle.
  _gnomeSessionWanted=!1;
  // Every end cancels the idle timer and drops a held button (the daemon that
  // pressed it goes away); the next session arms the timer afresh.
  _gnomeIdleCancel();_gnomeMouseHeld=!1;_gnomeHeldDeferred=!1;
  _gnomeCheckStop(why||"lock released");_gnomeShareWatchClose();
  if(_gnomeSessionEnding)return _gnomeSessionEnding;
  var bin=_gnomeBridgeBin();
  // Snapshot BEFORE clearing: the skip below has to ask whether a session was up
  // when this release arrived, not whether it is up after we cleared the flag.
  // Testing the live flag there makes the first conjunct always true, which
  // reduces the skip to `if(!starting)` and silently stops ending the session on
  // the ordinary path (start completed, then released) - the exact leak this
  // function exists to prevent.
  var wasActive=_gnomeSessionActive;
  _gnomeSessionActive=!1;
  if(!bin){_gnomeSessionStarting=null;return}
  var starting=_gnomeSessionStarting;_gnomeSessionStarting=null;
  // Nothing was ever brought up: no session to end. Spawning session-end anyway
  // would hold the teardown latch for the length of a pointless subprocess and
  // widen the window in which the sync backstop refuses.
  // A start that FAILED left neither flag set but may have left a daemon behind.
  // A session the user stopped is still ended: session-end removes the bridge's
  // stopped-by-user marker, so the next lock starts clean.
  if(!wasActive&&!starting&&!_gnomeDaemonMayExist&&!_gnomeStoppedByUser)return;
  _gnomeSessionEnding=(async function(){
    // Log the interesting transition: a release that arrived while the consent
    // dialog was still up. Without this the whole interleaving is invisible in
    // claude-patches.log, which is where a user's report has to be diagnosed.
    if(starting){globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session-end waiting for an in-flight session-start");try{await starting}catch(e){}}
    // A start that resolved while we waited flips the flag back on; clear it
    // again before session-end so the end-state reflects this call, not that
    // start.
    _gnomeSessionActive=!1;
    try{await _bridgeAsync(bin,["session-end"],15000);_gnomeDaemonMayExist=!1}catch(e){}
    _gnomeSessionActive=!1;
    // A start that resolved while we waited armed the timer and the session
    // check; nothing is up now.
    _gnomeIdleCancel();_gnomeCheckStop(why||"lock released");
    // The stop the user made applies no longer: the lock or the task is over,
    // or the idle time passed.
    _gnomeStoppedClear(why||"lock released");
    globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session ended");
  })().then(function(){_gnomeSessionEnding=null},function(){_gnomeSessionEnding=null});
  return _gnomeSessionEnding;
}
// Bring the portal session up without blocking the main process. Returns a
// Promise that resolves once session-start finishes (or immediately if the
// session is already active). Concurrent callers share the in-flight promise.
function _gnomeEnsureSession(){
  // Declare the intent before anything can await, so a release arriving while we
  // are only QUEUED still cancels us (see _gnomeSessionEnd).
  _gnomeSessionWanted=!0;
  // Serialise against a teardown in flight, the way startBridgeSession awaits
  // sessionStopPromise in js/executor_linux.js: bring the session up only once
  // the end has finished, so the two cannot interleave.
  if(_gnomeSessionEnding){
    globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session-start queued behind an in-flight session-end");
    return _gnomeSessionEnding.then(function(){
      if(!_gnomeSessionWanted){
        globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge queued session-start cancelled; the lock was released again");
        return;
      }
      return _gnomeEnsureSession();
    });
  }
  if(_gnomeSessionActive)return Promise.resolve();
  if(_gnomeSessionStarting)return _gnomeSessionStarting;
  // The user stopped sharing: nothing starts a session again until the latch
  // is cleared (lock or task end, idle expiry; a new lock clears it in
  // __setLockHeld first).
  if(_gnomeStoppedByUser){globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge session-start skipped: the user stopped screen sharing");return Promise.resolve()}
  // A fresh lock is a fresh user gesture: give the portal a real retry (consent
  // dialog and all) rather than inheriting the previous session's cooldown.
  _gnomePortalClearDown();
  if(!_gnomeExitHooked){_gnomeExitHooked=!0;process.once("exit",function(){if(_gnomeSessionActive||_gnomeDaemonMayExist){try{_cp.execFileSync(_gnomeBridgeBin(),["session-end"],{timeout:5000,stdio:"ignore"})}catch(e){}}})}
  // Identity-check on settle: clear the slot only if it is still OURS. Without
  // it, an older start settling after the slot was reassigned frees it and lets
  // a third caller launch yet another concurrent session-start.
  var p=_gnomeSessionStart().then(clear,clear);
  function clear(){if(_gnomeSessionStarting===p)_gnomeSessionStarting=null}
  _gnomeSessionStarting=p;
  return p;
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
  if(!pick){
    for(var j=0;j<screens.length;j++){if(screens[j].is_primary){pick=screens[j];break}}
    if(!pick)pick=screens[0];
    _x11DiagOnce("region:"+x+","+y,"x11 capture origin "+x+","+y+" (root px) is on no RandR monitor - using "+(pick.name||pick.id));
  }
  var pg=pick.geometry||{x:0,y:0};
  return{name:pick.name||pick.id,x:x-pg.x,y:y-pg.y};
}
// The bridges' frame-size rule (compute_target_dims in x11/wlroots/gnome/kwin
// bridges): long edge <= 1568 px, total <= 1_150_000 px, keep the aspect ratio,
// never upscale, round each side. The desktopCapturer tier applies the same
// rule, so a screenshot has one size whichever tier captured it.
var CU_MAX_LONG_EDGE=1568,CU_MAX_PIXELS=1150000;
function _cuTargetDims(w,h){
  var pw=Math.max(1,w),ph=Math.max(1,h),s=Math.min(1,CU_MAX_LONG_EDGE/Math.max(pw,ph),Math.sqrt(CU_MAX_PIXELS/(pw*ph)));
  return{width:Math.max(1,Math.round(pw*s)),height:Math.max(1,Math.round(ph*s))};
}
// True when a thumbnail of size sz is what Chromium makes of monitor m's frame:
// it fits the frame inside the requested box keeping the aspect ratio.
function _dcAspectFits(sz,m){
  var k=Math.min(sz.width/m.pw,sz.height/m.ph);
  return Math.abs(Math.round(m.pw*k)-sz.width)<=1&&Math.abs(Math.round(m.ph*k)-sz.height)<=1;
}
var _dcAssumeLogged=!1;
// Electron desktopCapturer last resort (issue #298). Every session type ends
// here when its own tiers fail. Chromium fits each screen's frame inside
// thumbnailSize keeping the aspect ratio, so the thumbnail is requested at the
// full physical size of the monitor that holds the region and the crop is made
// display-relative, scaled by the size Chromium actually returned. The source is
// the one whose display_id names that monitor. Wayland portal sources often
// carry no display_id (and only the screen the user picked), so a source whose
// thumbnail aspect fits exactly one monitor counts as that monitor; failing
// that, the source is taken to show the primary. A source that shows another
// monitor fails the tier instead of returning the wrong screen.
// lx/ly/lw/lh: the logical (DIP) region; xr: the X11 root-pixel rect from
// _x11PxRect, or null. Returns {png, imgW, imgH, via}.
async function _desktopCapturerRegion(lx,ly,lw,lh,displayIdx,xr){
  var mons=_getMonitors(),ds=[],i,j,mon=null;
  try{ds=_electron.screen.getAllDisplays()||[]}catch(e){}
  if(xr&&typeof xr.i==="number")mon=mons[xr.i]||null;
  for(i=0;!mon&&typeof displayIdx==="number"&&i<mons.length;i++){if(mons[i].displayId===displayIdx)mon=mons[i]}
  if(!mon){var _pm=_findMonByPoint(lx,ly);for(i=0;!mon&&_pm&&i<mons.length;i++){if(mons[i].displayId===_pm.displayId)mon=mons[i]}if(!mon)mon=_pm||mons[0]}
  var phys=mons.map(function(m){var s=m.scaleFactor||1;return{m:m,pw:Math.max(1,Math.round(m.width*s)),ph:Math.max(1,Math.round(m.height*s))}});
  var tgt=null;for(i=0;i<phys.length;i++){if(phys[i].m===mon)tgt=phys[i]}
  if(!tgt){var s0=mon.scaleFactor||1;tgt={m:mon,pw:Math.max(1,Math.round(mon.width*s0)),ph:Math.max(1,Math.round(mon.height*s0))}}
  // The region in the monitor's own physical pixels.
  var rx,ry,rw,rh;
  if(xr){rx=xr.x-xr.ox;ry=xr.y-xr.oy;rw=xr.w;rh=xr.h}
  else{var sf=mon.scaleFactor||1;rx=Math.round((lx-mon.originX)*sf);ry=Math.round((ly-mon.originY)*sf);rw=Math.round(lw*sf);rh=Math.round(lh*sf)}
  var sources=await _electron.desktopCapturer.getSources({types:["screen"],thumbnailSize:{width:tgt.pw,height:tgt.ph}});
  if(!sources||!sources.length)throw new Error("no screen sources");
  var tid=ds[mon.displayId]&&ds[mon.displayId].id!=null?String(ds[mon.displayId].id):"",known={};
  for(i=0;i<ds.length;i++){if(ds[i]&&ds[i].id!=null)known[String(ds[i].id)]=1}
  function _thumbOk(s){return s&&s.thumbnail&&!s.thumbnail.isEmpty()}
  function _size(img,dw,dh){var z=img&&typeof img.getSize==="function"?img.getSize():null;return z&&z.width>0&&z.height>0?{width:z.width,height:z.height}:{width:dw,height:dh}}
  var src=null,via="";
  for(i=0;!src&&tid&&i<sources.length;i++){if(_thumbOk(sources[i])&&String(sources[i].display_id||"")===tid){src=sources[i];via="display_id"}}
  if(!src){
    // Sources whose display_id names another monitor show that monitor.
    var rest=[],fits=[];
    for(i=0;i<sources.length;i++){var sd=String(sources[i]&&sources[i].display_id||"");if(_thumbOk(sources[i])&&!(sd&&known[sd]))rest.push(sources[i])}
    for(i=0;i<rest.length;i++){
      var sz=_size(rest[i].thumbnail,tgt.pw,tgt.ph),hit=[];
      for(j=0;j<phys.length;j++){if(_dcAspectFits(sz,phys[j]))hit.push(phys[j].m)}
      fits.push(hit);
      if(!src&&hit.length===1&&hit[0]===mon){src=rest[i];via="aspect match"}
    }
    if(!src){
      // No source identifies the monitor: take the first one that is not
      // identified as another monitor to show the primary.
      var prim=null;for(i=0;i<mons.length;i++){if(mons[i].isPrimary){prim=mons[i];break}}
      if(!prim)prim=mons[0];
      for(i=0;!src&&i<rest.length;i++){if(fits[i].length!==1){src=rest[i];via="assumed primary"}}
      if(!src)throw new Error("no screen source shows "+mon.label+" ("+sources.length+" source(s), none matches by display_id or aspect)");
      if(!_dcAssumeLogged){_dcAssumeLogged=!0;globalThis.__cdbDiag("[claude-cu] desktopCapturer: no screen source names "+mon.label+" by display_id or aspect ("+sources.length+" source(s)) - taking it to show the primary display "+prim.label)}
      if(prim!==mon)throw new Error("the only usable screen source shows the primary display "+prim.label+", not "+mon.label);
    }
  }
  var img=src.thumbnail,isz=_size(img,tgt.pw,tgt.ph),kx=isz.width/tgt.pw,ky=isz.height/tgt.ph;
  var cx=Math.max(0,Math.round(rx*kx)),cy=Math.max(0,Math.round(ry*ky));
  var cx2=Math.min(isz.width,Math.round((rx+rw)*kx)),cy2=Math.min(isz.height,Math.round((ry+rh)*ky));
  if(cx2<=cx||cy2<=cy)throw new Error("region "+rx+","+ry+" "+rw+"x"+rh+" is outside the "+isz.width+"x"+isz.height+" capture of "+mon.label);
  var out=img.crop({x:cx,y:cy,width:cx2-cx,height:cy2-cy}),osz=_size(out,cx2-cx,cy2-cy),t=_cuTargetDims(osz.width,osz.height);
  if(t.width!==osz.width||t.height!==osz.height){out=out.resize({width:t.width,height:t.height,quality:"best"});osz=_size(out,t.width,t.height)}
  return{png:out.toPNG(),imgW:osz.width,imgH:osz.height,via:via};
}
// Returns {base64, imgW, imgH, mimeType} where imgW/imgH are the EMITTED image's
// pixel dimensions (post-downscale) and mimeType is the produced format. Most
// tiers capture the region at native resolution (no downscale) and produce PNG,
// so imgW/imgH == the captured region size (w,h after scaleFactor) and
// mimeType=="image/png". The bridge tiers downscale (long edge <= 1568,
// total <= 1_150_000 px) and produce JPEG, so they override imgW/imgH with the
// bridge's returned width/height and mimeType with "image/jpeg". The
// desktopCapturer tier downscales by the same rule and emits PNG. The handler
// uses imgW/imgH to map model image-pixel coordinates back to root pixels.
// mk (from _maskFor): mask mode - the masking bridge only, never another tier.
async function _captureRegion(x,y,w,h,sf,displayIdx,mk){
  if(!sf){var _m=_findMonByPoint(x,y);sf=_m?_m.scaleFactor:1}
  var _lx0=x,_ly0=y,_lw0=w,_lh0=h;
  // X11: per-display DIP -> root-pixel transform shared with the pointer paths
  // (_x11PxRect); Wayland keeps the plain scale, which its bridge undoes below.
  var _xr=_x11PxRect(x,y,w,h,displayIdx);
  if(_xr){x=_xr.x;y=_xr.y;w=_xr.w;h=_xr.h}
  else if(sf&&sf!==1){x=Math.round(x*sf);y=Math.round(y*sf);w=Math.round(w*sf);h=Math.round(h*sf)}
  var tmp=_path.join(_os.tmpdir(),"claude-cu-"+Date.now()+"-"+Math.random().toString(36).slice(2)+".png");
  if(_tgt&&_tgt.refuse)throw _tgtErr();
  // x11-bridge takes the root-pixel region, wlroots-bridge the logical one.
  if(mk)return mk.be.kind==="x11"?await _captureMasked(mk,x,y,w,h):await _captureMasked(mk,Math.round(_lx0),Math.round(_ly0),Math.round(_lw0),Math.round(_lh0));
  var _de=_desktopId();
  // Native (non-downscaling) tiers crop to exactly w x h at native resolution
  // and emit PNG.
  function _nativePng(b64){return{base64:b64,imgW:w,imgH:h,mimeType:"image/png"}}
  if(process.env.COWORK_SCREENSHOT_CMD){
    // Intentionally shell-evaluated: this is a user-supplied command template
    // from the user's own environment (pipes/redirects are part of the
    // contract). Only {FILE}/{X}/{Y}/{W}/{H} are substituted, all local values.
    // A command the user named: it runs with the APP PATH.
    try{var cmd=process.env.COWORK_SCREENSHOT_CMD.replace(/\{FILE\}/g,tmp).replace(/\{X\}/g,x).replace(/\{Y\}/g,y).replace(/\{W\}/g,w).replace(/\{H\}/g,h);
    var _co={timeout:15000},_ce=_envFor("app");if(_ce)_co.env=_ce;_cp.execSync(cmd,_co);globalThis.__cdbDiag("[claude-cu] screenshot: captured via COWORK_SCREENSHOT_CMD");return _nativePng(_readClean(tmp))}catch(e){globalThis.__cdbDiag("[claude-cu] COWORK_SCREENSHOT_CMD failed: "+e.message)}
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
  if(_isWlrootsCovered()&&!_wlrootsBridgeBin())throw new Error(_bridgeWhy("wlroots-bridge","WLROOTS_BRIDGE_BIN")+" (it is the only backend on a wlroots-Wayland session; ydotool/grim fallbacks were removed).");
  if(_isGnomeCovered()&&!_gnomeBridgeBin())throw new Error(_bridgeWhy("gnome-portal-bridge","GNOME_PORTAL_BRIDGE_BIN")+" (it is the only backend on a GNOME-Wayland session; ydotool/portal-screenshot fallbacks were removed).");
  // Target mode keys this on the target, not the session: an x11 target on a
  // Wayland desktop takes the x11-bridge tier below, a wlroots target this one.
  var _wlb=_tgt||_wayland?_wlBridge():null;
  if(_wlb){
    try{
      var _lx=Math.round(x/(sf||1)),_ly=Math.round(y/(sf||1)),_lw=Math.round(w/(sf||1)),_lh=Math.round(h/(sf||1));
      for(var _wtry=0,_wzr;;_wtry++){
        var _wmr=await _wlMonForRegion(_lx,_ly);
        var _wzargs=["zoom","--x",String(_wmr?_wmr.x:_lx),"--y",String(_wmr?_wmr.y:_ly),"--w",String(_lw),"--h",String(_lh)];
        if(_wmr&&_wmr.name){_wzargs.push("--display",_wmr.name)}
        try{_wzr=await _wlBridgeCallAsync(_wzargs);break}
        catch(ze){if(_wtry||!_wmr||!_wmr.name||!_cuDisplayNotFound(ze))throw ze;globalThis.__cdbDiag("[claude-cu] "+_wlb.name+" zoom: display "+_wmr.name+" not found - monitor list refreshed, retrying once");_wlScreensInvalidate()}
      }
      if(_wzr&&_wzr.base64){globalThis.__cdbDiag("[claude-cu] screenshot: captured via "+_wlb.name);return{base64:_wzr.base64,imgW:_wzr.width||w,imgH:_wzr.height||h,mimeType:"image/jpeg"}}
    }catch(e){
      globalThis.__cdbDiag("[claude-cu] "+_wlb.name+" zoom failed: "+(e.message||e));
      // A monitor the user did not share, or a session that was reset: no
      // other tier can fix that (the desktopCapturer fallback would raise a
      // portal dialog of its own), and the model needs the instruction, not
      // "every tier failed".
      if(e&&(e.__cdbNotShared||e.__cdbSurface))throw e;
    }
    // Covered session with a resolved bridge: do NOT fall through to deleted
    // third-party tools. Last resort is the Electron desktopCapturer tier below.
    globalThis.__cdbDiag("[claude-cu] "+_wlb.name+" screenshot failed on a covered Wayland session — no third-party fallback (set COWORK_SCREENSHOT_CMD to override)");
  }
  if(!_tgt&&_de.indexOf("kde")>=0&&_hasCmd("spectacle")){
    try{var stmp=_path.join(_os.tmpdir(),"claude-cu-spectacle-"+Date.now()+".png");
    _cp.execFileSync(_toolCmd("spectacle")||"spectacle",["-b","-n","-f","-o",stmp],{timeout:10000});
    if(_fs.existsSync(stmp)){try{_cp.execFileSync(_toolCmd("convert")||"convert",[stmp,"-crop",w+"x"+h+"+"+x+"+"+y,"+repage",tmp],{timeout:5000});try{_fs.unlinkSync(stmp)}catch(e){}globalThis.__cdbDiag("[claude-cu] screenshot: captured via spectacle+convert (KDE)");return _nativePng(_readClean(tmp))}catch(ce){try{_fs.renameSync(stmp,tmp)}catch(re){}globalThis.__cdbDiag("[claude-cu] screenshot: captured via spectacle (KDE, uncropped)");return _nativePng(_readClean(tmp))}}
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
        for(var _xtry=0,_zr;;_xtry++){
          var _mr=await _x11MonForRegion(x,y);
          var _zargs=["zoom","--x",String(_mr?_mr.x:x),"--y",String(_mr?_mr.y:y),"--w",String(w),"--h",String(h)];
          if(_mr&&_mr.name){_zargs.push("--display",_mr.name)}
          try{_zr=await _x11BridgeAsync(_zargs);break}
          catch(ze){if(_xtry||!_mr||!_mr.name||!_cuDisplayNotFound(ze))throw ze;globalThis.__cdbDiag("[claude-cu] x11-bridge zoom: display "+_mr.name+" not found - monitor list refreshed, retrying once");_x11ScreensInvalidate()}
        }
        if(_zr&&_zr.base64){globalThis.__cdbDiag("[claude-cu] screenshot: captured via x11-bridge"+(_wayland?" (XWayland)":""));return{base64:_zr.base64,imgW:_zr.width||w,imgH:_zr.height||h,mimeType:"image/jpeg"}}
      }catch(e){globalThis.__cdbDiag("[claude-cu] x11-bridge zoom failed: "+(e.message||e))}
    }else if(!_wayland){
      // X11 session with no bridge: hard fail (no third-party fallback, per design).
      // The Electron desktopCapturer tier below is the only remaining last resort.
      globalThis.__cdbDiag("[claude-cu] no x11-bridge on an X11 session: "+_bridgeWhy("x11-bridge","X11_BRIDGE_BIN"));
    }
  }
  // Target mode: desktopCapturer would capture the user's desktop. Fail here.
  if(_tgt)throw new Error("Screenshot of the background display "+_tgt.display+" failed (details in claude-patches.log).");
  // Electron desktopCapturer last resort: display-relative crop, downscaled by
  // the bridges' rule (see _desktopCapturerRegion).
  try{var _dc=await _desktopCapturerRegion(_lx0,_ly0,_lw0,_lh0,displayIdx,_xr);globalThis.__cdbDiag("[claude-cu] screenshot: captured via desktopCapturer (Electron fallback, source by "+_dc.via+", "+_dc.imgW+"x"+_dc.imgH+")");return{base64:_dc.png.toString("base64"),imgW:_dc.imgW,imgH:_dc.imgH,mimeType:"image/png"}}catch(dce){globalThis.__cdbDiag("[claude-cu] desktopCapturer fallback failed: "+(dce&&dce.message||dce))}
  // Name the cause when it is a bridge that is missing or cannot run; when the
  // bridge is there, the per-tier failures are already in claude-patches.log.
  var _noX11=!_x11BridgeBin()&&(!_wayland||(globalThis.__cuBridgeFail&&globalThis.__cuBridgeFail["x11-bridge"]));
  throw new Error("Screenshot failed - "+(_noX11?_bridgeWhy("x11-bridge","X11_BRIDGE_BIN"):"every capture tier failed (details in claude-patches.log)")+"; or set COWORK_SCREENSHOT_CMD.")
}
try{_tgtSigLast=typeof globalThis.__cuTargetSigSync==="function"?globalThis.__cuTargetSigSync():null}catch(se){}
_tgtLatch("startup");
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
  if(missing.length)globalThis.__cdbDiag("[claude-cu] diagnostics: missing=["+missing.join(", ")+"]"+_toolIgnoredMsg(missing)+" (install for the residual fallback paths)");
  globalThis.__cdbDiag("[claude-cu] diagnostics: x11-bridge="+_bridgeState("x11-bridge",_x11BridgeBin()));
  globalThis.__cdbDiag("[claude-cu] diagnostics: wlroots-bridge="+_bridgeState("wlroots-bridge",_wlrootsBridgeBin()));
  globalThis.__cdbDiag("[claude-cu] diagnostics: gnome-portal-bridge="+_bridgeState("gnome-portal-bridge",_gnomeBridgeBin()));
  // input-backend
  if(_wlrCovered){globalThis.__cdbDiag("[claude-cu] diagnostics: input-backend="+(_wlrok?"wlroots-bridge":"none ("+_bridgeWhy("wlroots-bridge","WLROOTS_BRIDGE_BIN")+")"))}
  else if(_gnomeCovered){globalThis.__cdbDiag("[claude-cu] diagnostics: input-backend="+(_gnok?"gnome-portal-bridge":"none ("+_bridgeWhy("gnome-portal-bridge","GNOME_PORTAL_BRIDGE_BIN")+")"))}
  else if(_wayland){var ydOk=_checkYdotool();globalThis.__cdbDiag("[claude-cu] diagnostics: input-backend="+(ydOk?"ydotool":(_x11ok?"x11-bridge (XWayland fallback)":"none (install ydotool or x11-bridge)")))}
  else{globalThis.__cdbDiag("[claude-cu] diagnostics: input-backend="+(_x11ok?"x11-bridge":"none ("+_bridgeWhy("x11-bridge","X11_BRIDGE_BIN")+")"))}
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
// Target mode: the monitors are the target's, from its bridge `screens` (the
// capture-path cache, primed by _tgtProbe before the first tool runs), mapped
// as executor_linux.js mapRustScreenToDisplay does; displayId = list index.
// Geometry is the bridge's logical space (x11-bridge: root px, scale 1). While
// the cache is dropped (lock acquire, "display not found") the last list
// stands in until the next query lands. Never Electron's screen: those are the
// user's monitors.
function _tgtMonitors(){
  var s=_tgt.kind==="x11"?_x11ScreensCache:_wlScreensCache;
  if(Array.isArray(s)&&s.length&&s!==_tgt.monSrc){
    _tgt.monSrc=s;
    _tgt.mons=s.map(function(m,i){var g=m.geometry||{};return{displayId:i,width:g.width||0,height:g.height||0,originX:g.x||0,originY:g.y||0,scaleFactor:typeof m.scale==="number"&&isFinite(m.scale)&&m.scale>0?m.scale:1,isPrimary:!!m.is_primary,label:m.name||m.id||("display-"+i)}});
    if(!_tgt.mons.some(function(m){return m.isPrimary}))_tgt.mons[0].isPrimary=!0;
  }
  return _tgt.mons||[_defaultMon];
}
// Async entry points call this first, so the sync _getMonitors has the
// target's list even when upstream calls in before our handler's gate.
// A Computer Use ACTION (capture, input, opening an app; not enumeration,
// icons or capability probes, which upstream also runs between turns): the
// Escape watcher (community switch, js/cu_esc_watch.js) re-arms a watcher it
// parked at a cloud turn end. Sync and cheap (a flag check); absent or off =
// nothing.
function _escAct(){try{globalThis.__cdbCuEscWatch?.toolCall?.()}catch(ee){}}
async function _tgtPrime(){var g=_tgtGen;await _tgtSync("tool call");if(_tgtGen!==g)throw _tgtChangedErr();if(!_tgt||_tgt.mons||!_tgt.bin||_tgt.refuse)return;var c=_tgt.kind==="x11"?_x11ScreensCache:_wlScreensCache;if(!(Array.isArray(c)&&c.length))await _tgtProbe(_tgt)}
function _getMonitors(){
  if(_tgt)return _tgtMonitors();
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
    var displays=_tgt?[]:_electron.screen.getAllDisplays();
    for(var i=0;i<displays.length;i++){if(displays[i].id===displayId&&i<mons.length)return mons[i]}
  }
  for(var i=0;i<mons.length;i++){if(mons[i].isPrimary)return mons[i]}
  return mons[0];
}
// X11 HiDPI: Electron reports displays in DIP, but x11-bridge (XTest motion,
// GetImage crop) works in X root PIXELS. Chromium does not lay DIP origins out
// as px/scale: ConvertDisplayBoundsToDips (ui/base/x/x11_display_util.cc)
// scales only the PRIMARY's origin and places every other display next to its
// neighbour, so neither "pass DIP through" (lands short whenever the scale is
// not 1) nor a plain `*sf` (wrong for any monitor off the primary, or a primary
// not at 0,0) reaches the right pixel. Each display carries its own pixel
// origin, Electron's `nativeOrigin` (Chromium sets it from the RandR CRTC
// origin), so map per display exactly as Electron's own screen.dipToScreenPoint
// does on X11 (shell/browser/api/electron_api_screen.cc):
//   px = nativeOrigin + floor((dip - bounds.origin) * scaleFactor)
// on the display nearest the DIP point. Integer DIP at scale 1 with matching
// origins comes out unchanged.
// Bounds come from gfx::ToEnclosingRect, so when pixel size / scale is not an
// integer, neighbouring DIP bounds OVERLAP by one column (2560 px at 1.5 ->
// 0..1707, the next display starts at 1706). "First display containing the
// point" is then ambiguous: a capture names its display explicitly, and a
// point in the shared column prefers the display last screenshotted.
// Applies only where Electron itself runs on X11 AND x11-bridge does the work:
// an X11 session, or a Wayland session the launcher started on XWayland
// (CLAUDE_USE_XWAYLAND=1 -> --ozone-platform=x11) with no covered bridge and no
// ydotool. Everywhere else coordinates pass through as before.
var _x11DiagSeen={},_x11DiagCount={point:0,layout:0};
// Per-point keys (miss:, region:) and layout keys (map:, noorigin:) are capped
// separately so a run of misses cannot starve the mapping line.
function _x11DiagOnce(key,msg){var k=/^(miss|region):/.test(key)?"point":"layout";if(_x11DiagSeen[key]||_x11DiagCount[k]>=16)return;_x11DiagSeen[key]=1;_x11DiagCount[k]++;globalThis.__cdbDiag("[claude-cu] "+msg)}
var _x11OzonePlatform;
function _x11Coords(){
  // Electron's displays are the user's desktop, not the target's.
  if(_tgt)return !1;
  if(!_wayland)return !0;
  if(_useWlBridge()||_checkYdotool())return !1;
  if(_x11OzonePlatform===void 0){_x11OzonePlatform="";try{_x11OzonePlatform=String(_electron.app.commandLine.getSwitchValue("ozone-platform")||"")}catch(e){}}
  return _x11OzonePlatform==="x11";
}
// Display index (in getAllDisplays / _getMonitors order) of the last full
// screenshot; the tie-break for points in a shared DIP column.
var _x11LastShotIdx=null;
function _x11PxDisplays(){
  if(!_x11Coords())return null;
  var ds;try{ds=_electron.screen.getAllDisplays()}catch(e){return null}
  if(!ds||!ds.length)return null;
  var rr=Array.isArray(_x11ScreensCache)?_x11ScreensCache:[];
  return ds.map(function(d,idx){
    var b=d.bounds||{x:0,y:0,width:0,height:0},sf=d.scaleFactor||1,no=d.nativeOrigin,ox,oy;
    if(no&&typeof no.x==="number"&&typeof no.y==="number"){ox=no.x;oy=no.y}
    else{
      // No nativeOrigin (older Electron): the cached x11-bridge RandR monitor
      // nearest bounds.origin*scale with a matching pixel size, else origin*scale.
      ox=Math.round(b.x*sf);oy=Math.round(b.y*sf);var best=null,bd=Infinity;
      for(var i=0;i<rr.length;i++){var g=rr[i].geometry||{},dist=Math.abs(g.x-ox)+Math.abs(g.y-oy);if(Math.abs(g.width-b.width*sf)<=sf+1&&Math.abs(g.height-b.height*sf)<=sf+1&&dist<bd){bd=dist;best=g}}
      if(best){ox=best.x;oy=best.y}
      _x11DiagOnce("noorigin:"+idx,"x11 display "+idx+" has no nativeOrigin - pixel origin "+ox+","+oy+(best?" from the RandR monitor list":" = origin * scale"));
    }
    if(sf!==1)_x11DiagOnce("map:"+idx+":"+b.x+","+b.y+","+b.width+"x"+b.height+"@"+sf+">"+ox+","+oy,"x11 HiDPI: display "+idx+" DIP "+b.x+","+b.y+" "+b.width+"x"+b.height+" scale "+sf+" -> root px origin "+ox+","+oy);
    return{b:b,sf:sf,ox:ox,oy:oy,i:idx};
  });
}
function _x11Contains(m,x,y){var b=m.b;return x>=b.x&&x<b.x+b.width&&y>=b.y&&y<b.y+b.height}
// Display a DIP point maps through: the last-screenshotted display when it
// contains the point, else the first one containing it, else the nearest
// (Chromium's GetDisplayNearestPoint semantics).
function _x11PxDisplayFor(list,x,y){
  var best=null,bd=Infinity,pref=_x11LastShotIdx!=null?list[_x11LastShotIdx]:null;
  if(pref&&_x11Contains(pref,x,y))return pref;
  for(var i=0;i<list.length;i++){
    var b=list[i].b;
    if(x>=b.x&&x<b.x+b.width&&y>=b.y&&y<b.y+b.height)return list[i];
    var dx=x<b.x?b.x-x:(x>=b.x+b.width?x-(b.x+b.width-1):0),dy=y<b.y?b.y-y:(y>=b.y+b.height?y-(b.y+b.height-1):0),dist=dx*dx+dy*dy;
    if(dist<bd){bd=dist;best=list[i]}
  }
  _x11DiagOnce("miss:"+x+","+y,"x11 pointer target "+x+","+y+" (DIP) is on no display - mapped through the nearest one");
  return best;
}
function _x11MapVia(m,x,y){return[m.ox+Math.floor((x-m.b.x)*m.sf),m.oy+Math.floor((y-m.b.y)*m.sf)]}
// DIP point -> integer x11-bridge coordinate (root pixels on X11, unchanged elsewhere).
function _x11Px(x,y){
  var rx=Math.round(x),ry=Math.round(y),list=_x11PxDisplays();
  if(!list)return[rx,ry];
  return _x11MapVia(_x11PxDisplayFor(list,rx,ry),rx,ry);
}
// DIP rect -> root-pixel rect through ONE display's transform, so the
// screenshot crop and the clicks agree. The display: displayIdx when the caller
// names one, else the display whose origin IS the rect's top-left (a
// whole-display capture in an overlapping layout), else as for a point. Null
// when there is nothing to map (see _x11Coords, or no Electron displays).
function _x11PxRect(x,y,w,h,displayIdx){
  var list=_x11PxDisplays();
  if(!list)return null;
  var rx=Math.round(x),ry=Math.round(y),m=typeof displayIdx==="number"?list[displayIdx]:null;
  for(var i=0;!m&&i<list.length;i++){if(list[i].b.x===rx&&list[i].b.y===ry)m=list[i]}
  if(!m)m=_x11PxDisplayFor(list,rx,ry);
  var tl=_x11MapVia(m,rx,ry),br=_x11MapVia(m,rx+Math.round(w),ry+Math.round(h));
  // i/ox/oy: the display used and its root-pixel origin (desktopCapturer
  // crops display-relative).
  return{x:tl[0],y:tl[1],w:br[0]-tl[0],h:br[1]-tl[1],i:m.i,ox:m.ox,oy:m.oy};
}
var _inputLogDone={mouse:false,click:false,key:false,type:false,scroll:false,drag:false,window:false,app:false};
function _logFirstUse(op,backend){if(!_inputLogDone[op]){_inputLogDone[op]=true;globalThis.__cdbDiag("[claude-cu] "+op+": using "+backend)}}
// A model-injected Escape must not trip the user's Escape watcher (js/
// cu_esc_watch.js, community switch "Escape stops Computer Use"): every input
// that can carry one runs inside its suspendAround, which only talks to an
// armed watcher that is not syntheticSafe (KDE kglobalaccel) and else just runs
// it. Other input is never wrapped; without the community patch, or with its
// switch off, fn just runs.
function _escAround(esc,fn,ms){var w=globalThis.__cdbCuEscWatch;return esc&&typeof w?.suspendAround==="function"?w.suspendAround(fn,ms):fn()}
function _escKeys(v){var w=globalThis.__cdbCuEscWatch;return typeof w?.hasEscape==="function"&&w.hasEscape(v)===!0}
// Upstream's own executor marks each key / holdKey whose keys are exactly one
// Escape as expected (sub-patch 17e: globalThis.__cdbCuExpectEscape, a 100 ms
// counter its X11 Escape grab reads), so the grab absorbs the model's Escape
// instead of stopping the turn. Same rule here, called right before the
// injection: one mark per press (a repeated key marks each repetition).
function _escExpect(keys,n){
  try{
    var f=globalThis.__cdbCuExpectEscape;if(typeof f!=="function")return;
    var t=(Array.isArray(keys)?keys:String(keys==null?"":keys).split("+")).filter(function(k){return String(k).length>0});
    if(t.length!==1)return;
    var k=String(t[0]).trim().toLowerCase();
    if(k!=="escape"&&k!=="esc")return;
    for(var i=0,m=Math.max(1,n|0);i<m;i++)f();
  }catch(e){}
}
function _escText(t){return typeof t==="string"&&t.indexOf("\x1b")>=0}
// True when a covered Wayland session (wlroots/GNOME) has a resolved bridge —
// input/screenshot/windows all route through it and the ydotool path is skipped.
function _useWlBridge(){return(_tgt||_wayland)&&!!_wlBridge()}
// Target mode has no Electron cursor: cursor_position and a drag without a
// start use the last position Computer Use moved the pointer to.
function _tgtCursorSet(x,y){if(_tgt)_tgt.cursor={x:Math.round(x),y:Math.round(y)}}
function _tgtCursor(){var c=_tgt&&_tgt.cursor;if(c)return c;var m=_findMon(null)||_defaultMon;return{x:Math.round(m.originX+m.width/2),y:Math.round(m.originY+m.height/2)}}
function _moveMouse(x,y){
  _tgtCursorSet(x,y);
  if(_useWlBridge()){
    _logFirstUse("mouse",_wlBridge().name);_wlBridgeCall(["pointer-move","--x",String(Math.round(x)),"--y",String(Math.round(y))]);return;
  }
  if(_wayland&&_checkYdotool()){
    try{_logFirstUse("mouse","ydotool");_ydotool(["mousemove","--absolute","0","0"]);_cp.execSync("sleep 0.05");_ydotool(["mousemove",String(Math.round(x)),String(Math.round(y))]);return}catch(e){globalThis.__cdbDiag("[claude-cu] ydotool mousemove failed, falling back to x11-bridge: "+e.message)}
  }else{
    if(_wayland&&!_tgt&&!_checkYdotool())globalThis.__cdbDiag("[claude-cu] ydotool not available on Wayland, falling back to x11-bridge via XWayland");
  }
  _logFirstUse("mouse","x11-bridge");
  var _mp=_x11Px(x,y);
  _x11Bridge(["pointer-move","--x",String(_mp[0]),"--y",String(_mp[1])]);
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
async function _screenshotMon(mon,mk){
  var cap=await _captureRegion(mon.originX,mon.originY,mon.width,mon.height,mon.scaleFactor||1,mon.displayId,mk);
  _x11LastShotIdx=mon.displayId;
  var out={base64:cap.base64,imgW:cap.imgW,imgH:cap.imgH,mimeType:cap.mimeType,displayWidth:mon.width,displayHeight:mon.height,originX:mon.originX||0,originY:mon.originY||0};
  if(mk)out.hidden=cap.hidden||[];
  return out;
}
// Wayland window enumeration goes through the covered session's bridge
// (wlroots-bridge: foreign-toplevel protocols; gnome-portal-bridge: best-effort
// GNOME Shell Introspect). The old hyprctl/swaymsg+jq/niri compositor-IPC
// helpers are gone — those compositors are wlroots, i.e. covered by the bridge.
// Window / command output -> {bundleId, displayName} in the canonical id
// scheme (see "App identity" above). displayName: the app's Name when its
// entry is known, else the window title, else the id.
function _bundleIdFromWindow(w){var r=_aWin(w);return r?r.id:null}
function _appRefFromWindow(w){
  var r=_aWin(w);
  if(!r||!r.id)return null;
  var t=typeof w.title==="string"&&w.title.trim()?w.title:"";
  return{bundleId:r.id,displayName:r.rec?r.rec.name:(t||r.id)};
}
// frontmost-app / app-under-point print camelCase {bundleId,displayName} with
// the bridge's raw id (its first window id). A raw id the index knows is
// mapped directly; an unknown one is looked up in the window list (pick =
// the windows it could be) so the process tier sees it too, like
// listRunningApps; nothing there = the raw id, as listRunningApps has it.
function _appRefFromCommand(result,wins,pick){
  if(!result||typeof result!=="object")return null;
  if(typeof result.bundleId!=="string"||typeof result.displayName!=="string"||!result.bundleId.trim())return null;
  var raw=_araw(result.bundleId),r=_arec(_appIndex(),raw);
  if(r)return{bundleId:r.id,displayName:r.name};
  if(typeof wins==="function"){
    var list;try{list=wins()}catch(e){list=null}
    var best=null;
    if(Array.isArray(list)){for(var i=0;i<list.length;i++){var w=list[i];if(!w||_aRawFirst(w)!==raw||(pick&&!pick(w)))continue;if(!best||(w.stacking_order||0)>(best.stacking_order||0))best=w}}
    if(best){var ref=_appRefFromWindow(best);if(ref)return ref}
  }
  return{bundleId:raw,displayName:result.displayName};
}
// The live backend's app-identity capabilities (capabilitiesNow):
//   hitTest     native = appUnderPoint asks the window system (x11-bridge
//               app-under-point; wlroots-bridge with window geometry: a JS
//               hit test of `windows` by stacking_order); none = null
//   frontmost   native = the window system names the focused window
//   windowList  full | partial (XWayland: X clients only) | best-effort (GNOME
//               Introspect, may be []) | none
//   windowPositions  window rects map to the screenshot's displays
function _appBackend(){
  var none={name:"none",hitTest:"none",frontmost:"none",windowList:"none",windowPositions:!1};
  if(_tgt&&(_tgt.refuse||!_tgt.bin)){none.name="none (background display "+(_tgt.display||"?")+" unavailable)";return none}
  if(_useWlBridge()){
    var b=_wlBridge();
    // sway / Hyprland (doctor window_geometry): positions and a JS hit test
    // by stacking_order; niri, river: no positions, no hit test.
    if(b.name==="wlroots-bridge"){var gc=_bcNow(_bcBridge(!0)),geo=!!(gc&&gc.geometry);return{name:"wlroots-bridge"+(_tgt?" (background display "+_tgt.display+")":""),hitTest:geo?"native":"none",frontmost:"native",windowList:"full",windowPositions:geo}}
    return{name:b.name,hitTest:"none",frontmost:"native",windowList:"best-effort",windowPositions:!1};
  }
  if(_wayland&&!_tgt&&_checkYdotool()){none.name="ydotool";return none}
  if(!_x11BridgeBin())return none;
  if(_wayland&&!_tgt)return{name:"x11-bridge (XWayland)",hitTest:"none",frontmost:"none",windowList:"partial",windowPositions:!!_x11PxDisplays()};
  return{name:"x11-bridge"+(_tgt?" (background display "+_tgt.display+")":""),hitTest:"native",frontmost:"native",windowList:"full",windowPositions:!!(_tgt||_x11PxDisplays())};
}
// The window list of the live backend (sync, portal-free), or null.
function _appWins(){
  if(_useWlBridge())return _wlBridgeCall(["windows"]);
  if(_wayland&&!_tgt&&_checkYdotool())return null;
  if(!_x11BridgeBin())return null;
  return _x11Bridge(["windows"]);
}
// ── Display auto-target (js/cu_display_target.js) ──
// The granted apps' windows and the monitors in ONE coordinate space, or
// {why} when this session's bridge reports no window positions. Same window
// source and gating as listRunningApps.
//   x11-bridge, user's desktop (X11, or Electron on XWayland): window geometry
//     is X root pixels, so each display is its root-pixel rect (nativeOrigin +
//     DIP size * scale, the _x11PxDisplays transform the clicks use).
//   x11-bridge, background display: window geometry and the target's monitors
//     (its bridge `screens`) are both that X server's root pixels.
//   wlroots-bridge with doctor `window_geometry` (sway / Hyprland IPC): window
//     geometry and the bridge `screens` are both the compositor's global
//     logical space; each screen maps to the Electron display at the same
//     origin (background display: the target's monitor at the same index),
//     and `output` names the screen of a window.
//   wlroots-bridge without it (niri, river: foreign-toplevel only) and
//     gnome-portal-bridge (Introspect: size only, x/y always 0): no positions -
//     nothing counts.
//   x11-bridge with Electron on native Wayland: XWayland root coordinates do
//     not map to Electron's displays reliably - nothing counts.
async function _dtSource(){
  if(_useWlBridge()){
    var wb=_wlBridge(),wc=wb.name==="wlroots-bridge"?await _bcProbe(_bcBridge(!0)):null;
    if(!wc||!wc.geometry)return{why:wb.name+" reports no window positions"};
    var scr=await _wlBridgeScreens(),lm2=_getMonitors(),wm=[],byOut={};
    for(var si=0;si<scr.length;si++){
      var s=scr[si],g=s&&s.geometry,e2=null;
      if(!g)continue;
      if(_tgt)e2=lm2[si]||null;
      else for(var li=0;!e2&&li<lm2.length;li++)if(lm2[li].originX===g.x&&lm2[li].originY===g.y)e2=lm2[li];
      if(!e2)continue;
      wm.push({displayId:e2.displayId,label:e2.label,isPrimary:!!e2.isPrimary,rect:{x:g.x,y:g.y,width:g.width,height:g.height}});
      if(s.id!=null)byOut[String(s.id)]=e2.displayId;
    }
    if(!wm.length)return{why:"wlroots-bridge screens match none of Electron's displays"};
    var wraw=await _wlBridgeCallAsync(["windows"]);
    return{mons:wm,raw:Array.isArray(wraw)?wraw:[],displayOf:function(w){return w&&w.output!=null&&_hasOwn.call(byOut,String(w.output))?byOut[String(w.output)]:null}};
  }
  if(_wayland&&_checkYdotool())return{why:"no window list on this session"};
  if(_wayland&&!_x11BridgeBin())return{why:"no window list on this session"};
  var mons;
  if(_tgt){
    mons=_getMonitors().map(function(m){return{displayId:m.displayId,label:m.label,isPrimary:m.isPrimary,rect:{x:m.originX||0,y:m.originY||0,width:m.width,height:m.height}}});
  }else{
    var px=_x11PxDisplays();
    if(!px)return{why:"X window positions cannot be mapped to Electron's displays on this session"};
    var lm=_getMonitors();
    mons=px.map(function(m){var e=lm[m.i]||{};return{displayId:m.i,label:e.label,isPrimary:!!e.isPrimary,rect:{x:m.ox,y:m.oy,width:Math.round(m.b.width*m.sf),height:Math.round(m.b.height*m.sf)}}});
  }
  var raw=await _x11BridgeAsync(["windows"]);
  return{mons:mons,raw:Array.isArray(raw)?raw:[]};
}
async function _dtResolve(bundleIds){
  var DT=globalThis.__cdbCuDisplayTarget;
  if(!DT)return{why:"display target helper missing"};
  var src;try{src=await _dtSource()}catch(e){return{why:"window list failed: "+(e&&e.message||e)}}
  if(!src.mons)return src;
  src.wins=DT.normalize(src.raw,bundleIds,function(w){return w.geometry||null},src.displayOf||null);
  return src;
}
// ── Bridge capabilities (doctor) ──
// The live capture bridge's optional doctor keys, asked once per bridge binary
// and display (cached CU_BRIDGE_CAPS_TTL_MS, async, never on a sync path):
//   mask      x11-bridge `capabilities.screenshot_mask`, wlroots-bridge
//             `screenshot_mask` (sway / Hyprland IPC answered): screenshot and
//             zoom take --keep-window / --mask-all.
//   geometry  wlroots-bridge `window_geometry`: windows carry geometry,
//             output, is_visible and stacking_order (x11-bridge always does).
//   gaps      wlroots-bridge `screenshot_mask_gaps`: what the mask cannot cover.
// A bridge that answers without the keys (or exits 2: contract 0) cannot mask:
// {mask:false}. A doctor that fails (timeout, crash, non-JSON) is {error}:
// capture with an allowlist then FAILS CLOSED rather than guess "cannot mask".
// GNOME, ydotool, XWayland-only, COWORK_SCREENSHOT_CMD and the desktopCapturer
// fallback have no masking bridge at all (_bcBridge null).
var CU_BRIDGE_CAPS_TTL_MS=60000,CU_BRIDGE_DOCTOR_MS=8000;
// A failed doctor is asked again on the next capture (_bcProbe), but the sync
// capability reads (_bcNow: capabilitiesNow, the capabilities getter, which
// upstream's supported-features build reads on every call) wait this long
// before they start another one, so a doctor that keeps failing cannot be
// spawned per read.
var CU_BRIDGE_CAPS_FAIL_TTL_MS=30000;
var _bcCache={};
// windows=true: the bridge whose window list is used (COWORK_SCREENSHOT_CMD
// only replaces the capture).
function _bcBridge(windows){
  if(!windows&&process.env.COWORK_SCREENSHOT_CMD)return null;
  if(_tgt&&(_tgt.refuse||!_tgt.bin))return null;
  if(_useWlBridge()){var b=_wlBridge();return b.name==="wlroots-bridge"?{kind:"wlroots",name:b.name,bin:b.bin}:null}
  if(_wayland&&!_tgt)return null;
  var x=_x11BridgeBin();
  return x?{kind:"x11",name:"x11-bridge",bin:x}:null;
}
function _bcKey(be){return be.kind+"\n"+be.bin+"\n"+(_tgt?_tgt.key:"")}
function _bcParse(be,doc){
  if(!doc||typeof doc!=="object"||Array.isArray(doc))return{error:be.name+" doctor answered no JSON object"};
  if(typeof doc.contract!=="number"||doc.contract<1)return{mask:!1,geometry:be.kind==="x11",gaps:[],why:"contract 0"};
  var c=doc.capabilities&&typeof doc.capabilities==="object"?doc.capabilities:{};
  var mask=doc.screenshot_mask===!0||c.screenshot_mask===!0;
  var gaps=Array.isArray(doc.screenshot_mask_gaps)?doc.screenshot_mask_gaps.filter(function(g){return typeof g==="string"}):[];
  return{mask:mask,geometry:be.kind==="x11"||doc.window_geometry===!0,gaps:mask?gaps:[]};
}
// -> Promise<{mask, geometry, gaps} | {error}>, or null without a bridge.
function _bcProbe(be){
  if(!be)return Promise.resolve(null);
  var k=_bcKey(be),c=_bcCache[k];
  if(c&&c.res&&Date.now()-c.at<CU_BRIDGE_CAPS_TTL_MS)return Promise.resolve(c.res);
  if(c&&c.p)return c.p;
  var ent=c||(_bcCache[k]={res:null,at:0,p:null});
  ent.p=_execFileAsync(be.name,be.bin,["doctor"],CU_BRIDGE_DOCTOR_MS).then(function(doc){return _bcParse(be,doc)},function(e){
    if(_bridgeExitCode(e)===2)return{mask:!1,geometry:be.kind==="x11",gaps:[],why:"contract 0"};
    return{error:be.name+" doctor failed: "+(e&&e.message||e)};
  }).then(function(res){
    if(_bcCache[k]!==ent)return res;
    ent.p=null;
    // A failed doctor is asked again on the next capture, not kept a minute.
    if(res.error){ent.res=null;ent.at=0;ent.failAt=Date.now()}else{ent.res=res;ent.at=Date.now();ent.failAt=0}
    var line="[claude-cu] "+be.name+" capabilities: "+(res.error?res.error:"screenshot mask "+(res.mask?"yes"+(res.gaps.length?" (not covered: "+res.gaps.join(", ")+")":""):"no"+(res.why?" ("+res.why+")":""))+", window geometry "+(res.geometry?"yes":"no"));
    if(ent.line!==line){ent.line=line;globalThis.__cdbDiag(line)}
    // The per-app access answer upstream's UI shows may follow the mask
    // (js/cu_consent.js capChanged re-signals the renderer when it changed).
    _cuCapChanged(be.name+" doctor answered");
    return res;
  });
  return ent.p;
}
// Sync view for capabilitiesNow / capabilities: the cached answer (a stale one
// is served while a refresh runs), else null after starting the probe.
function _bcNow(be){
  if(!be)return null;
  var c=_bcCache[_bcKey(be)];
  var recentFail=!!(c&&!c.res&&c.failAt&&Date.now()-c.failAt<CU_BRIDGE_CAPS_FAIL_TTL_MS);
  if(!recentFail&&(!c||!c.res||Date.now()-c.at>=CU_BRIDGE_CAPS_TTL_MS)){try{_bcProbe(be).catch(function(){})}catch(e){}}
  return c&&c.res||null;
}
function _bcWarm(){try{_bcNow(_bcBridge(!0))}catch(e){}}
// Remote device (cloud Cowork / Dispatch): js/cu_mode_preamble.js decides once
// at start whether a first-party bridge is usable on this Wayland session
// (globalThis.__cdbCuWaylandAnnounce, which sub-patch 4g's
// isBridgeComputerUsePlatform follows). A background display turned off or
// broken at run time can leave only paths the preamble reserves for Code
// sessions (XWayland x11-bridge, ydotool, spectacle), so the latch only ever
// moves to false here (exec-free: env, globals and the latched target), with
// one log line; a display turned on later stays refused until a restart.
function _cuAnnounceCheck(why){
  if(globalThis.__cdbCuWaylandAnnounce!==!0)return;
  var ok=_tgt?!_tgt.refuse&&!!_tgt.bin:!!(_wayland&&_useWlBridge());
  if(ok)return;
  globalThis.__cdbCuWaylandAnnounce=!1;
  globalThis.__cdbDiag("[claude-cu] remote device: computer tools withdrawn on Wayland ("+why+"): no first-party bridge usable now - cloud Cowork and Dispatch are refused until a restart");
}
function _cuCapChanged(why){try{var cc=globalThis.__cdbCuConsent;if(cc&&typeof cc.capChanged==="function")cc.capChanged(why)}catch(e){}}
function _bcForget(be){if(be)delete _bcCache[_bcKey(be)]}
function _filteringNow(){var r=_bcNow(_bcBridge());return r&&r.mask?"mask":"none"}
// ── Allowlist mask (screenshot / zoom / resolvePrepareCapture) ──
// allowedBundleIds undefined = legacy unmasked capture: only our own
// Code-session handler sends that, with "Ask before Computer Use controls an
// app" off. Upstream's own dispatch (cloud Cowork, Dispatch, teach) always
// passes its allowlist, so those sessions are masked whatever the switch says.
// An ARRAY (even empty) = mask mode: on a bridge that can mask, only the
// windows of those canonical ids stay visible (never Claude's own), everything
// else is painted over by the bridge; no window of them on screen =
// --mask-all. Mask mode FAILS CLOSED: a doctor that did not answer, any bridge
// error, an old bridge without the flags (exit 2), a result without the
// `mask` report, or (wlroots) a kept window that no longer belongs to an
// allowed app is an error, and no other capture tier (spectacle,
// desktopCapturer, ...) is tried. Unmasked with an allowlist ONLY where the
// backend definitively cannot mask: no capture bridge (GNOME, ydotool,
// XWayland-only, COWORK_SCREENSHOT_CMD, desktopCapturer fallback) or a doctor
// that answered without screenshot_mask. Every capture result says what was
// done: masked (true / false), filtering ("mask" / "none") and maskGaps; the
// last one is kept for the settings status line (__lastCapture).
// x11-bridge kept windows are checked by XID only: the bridge captures under a
// server grab, and an XID is allocated from its client's own id range, so the
// id of a window that vanished between our `windows` and the capture can only
// come back as a window of that same client - not of another app.
function _isHostWin(w){
  if(!w)return !1;
  if(w.pid===process.pid)return !0;
  var r=_aWin(w);
  return !!(r&&(r.host||_akey(r.id)===_akey(_hostId())));
}
function _maskAllowed(ids){
  var out=[],seen={},h=_akey(_hostId());
  (Array.isArray(ids)?ids:[]).forEach(function(b){if(typeof b!=="string"||!b.trim())return;var k=_akey(b);if(!k||seen[k]||k===h)return;seen[k]=1;out.push(b)});
  return out;
}
var _lastCap=null;
function _capNote(res,mk,allowed){
  if(!res||typeof res!=="object")return res;
  var masked=!!mk,gaps=mk&&mk.caps&&Array.isArray(mk.caps.gaps)?mk.caps.gaps.slice():[];
  res.masked=masked;res.filtering=masked?"mask":"none";res.maskGaps=gaps;
  if(Array.isArray(allowed))_lastCap={filtering:res.filtering,gaps:gaps.slice(),at:Date.now()};
  return res;
}
// -> null (capture unmasked) or {be, caps, allowed}; throws when the bridge
// could not say whether it can mask.
async function _maskFor(allowed){
  if(!Array.isArray(allowed))return null;
  var be=_bcBridge();if(!be)return null;
  var caps=await _bcProbe(be);
  if(caps&&caps.error)throw new Error("Screenshot not taken: could not check whether "+be.name+" can hide the apps that are not allowed ("+caps.error+").");
  if(!caps||!caps.mask)return null;
  return{be:be,caps:caps,allowed:_maskAllowed(allowed)};
}
function _maskErr(mk,why){
  var e=new Error("Screenshot not taken: "+mk.be.name+" could not hide the apps that are not allowed ("+why+"). Nothing was captured unmasked; try again, or ask the user.");
  e.__cdbSurface=!0;e.__cdbMask=!0;return e;
}
function _maskWindows(mk){return mk.be.kind==="x11"?_x11BridgeAsync(["windows"]):_wlBridgeCallAsync(["windows"])}
// Canonical ids of masked windows for upstream's "X was hidden" note: no
// Claude, no allowed app, no desktop / panel, nothing unresolvable, deduped.
function _maskHiddenIds(mk,list){
  var out=[],seen={},al={};
  mk.allowed.forEach(function(b){al[_akey(_acanon(b)||b)]=1});
  (list||[]).forEach(function(w){
    if(!w||w.is_dock===!0||w.is_desktop===!0||_isHostWin(w))return;
    var r=_aWin(w);if(!r||!r.id)return;
    var k=_akey(r.id);if(seen[k]||al[k])return;
    for(var i=0;i<mk.allowed.length;i++)if(_aOwns(mk.allowed[i],w))return;
    seen[k]=1;out.push(r.id);
  });
  return out;
}
function _rectsMeet(a,b){return !!a&&!!b&&a.width>0&&a.height>0&&b.width>0&&b.height>0&&a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height}
// Masked capture of a region. x/y/w/h: x11-bridge root pixels, or the wlroots
// global logical region (lx..). Returns {base64, imgW, imgH, mimeType, hidden}.
async function _captureMasked(mk,x,y,w,h){
  if(_tgt&&_tgt.refuse)throw _tgtErr();
  var be=mk.be,wins;
  try{wins=await _maskWindows(mk)}catch(e){throw _maskErr(mk,"window list failed: "+(e&&e.message||e))}
  if(!Array.isArray(wins))throw _maskErr(mk,"the window list is not an array");
  var cand=wins.filter(function(v){return v&&!_isHostWin(v)});
  var keep=mk.allowed.length&&globalThis.__cdbCuAppIds?globalThis.__cdbCuAppIds.windowIds(mk.allowed,cand):[];
  var flags=[];
  if(keep.length)keep.forEach(function(id){flags.push("--keep-window",id)});else flags.push("--mask-all");
  var x11=be.kind==="x11",r=null;
  for(var tr=0;;tr++){
    var mr=x11?await _x11MonForRegion(x,y):await _wlMonForRegion(x,y);
    // Bridge zoom coordinates are relative to --display: never without it.
    if(!mr||!mr.name)throw _maskErr(mk,"no monitor list from the bridge");
    var args=["zoom","--x",String(mr.x),"--y",String(mr.y),"--w",String(w),"--h",String(h),"--display",mr.name].concat(flags);
    try{r=x11?await _x11BridgeAsync(args):await _wlBridgeCallAsync(args);break}
    catch(ze){
      if(!tr&&_cuDisplayNotFound(ze)){globalThis.__cdbDiag("[claude-cu] "+be.name+" masked zoom: display "+mr.name+" not found - monitor list refreshed, retrying once");if(x11)_x11ScreensInvalidate();else _wlScreensInvalidate();continue}
      if(_bridgeExitCode(ze)===2){_bcForget(be);throw _maskErr(mk,"this "+be.name+" does not take --keep-window / --mask-all; update the package")}
      if(ze&&ze.__cdbSurface)throw ze;
      throw _maskErr(mk,(ze&&ze.message||String(ze)).trim());
    }
  }
  var m=r&&r.mask;
  if(!r||typeof r.base64!=="string"||!r.base64||!m||typeof m!=="object"||m.mode!==(keep.length?"keep":"all"))throw _maskErr(mk,"the result carries no mask report");
  var hidden;
  if(x11){
    // x11-bridge: XIDs are stable while it holds the server grab; it reports
    // the masked windows itself (topmost first, client ids as in `windows`).
    var kept=Array.isArray(m.kept)?m.kept.map(String):[];
    for(var ki=0;ki<kept.length;ki++)if(keep.indexOf(kept[ki])<0)throw _maskErr(mk,"it kept window "+kept[ki]+", which was not asked for");
    var byId={};wins.forEach(function(v){if(v&&v.id!=null)byId[String(v.id)]=v});
    hidden=_maskHiddenIds(mk,(Array.isArray(m.masked)?m.masked:[]).map(function(v){var lw=v&&byId[String(v.id)];return lw?lw:null}).filter(Boolean));
  }else{
    // wlroots-bridge ids are per-connection protocol ids that can shift
    // between our `windows` and its capture: every kept entry (the app id and
    // title the bridge resolved at capture time) must be a window we asked
    // for, of an allowed app, and never Claude. A title that changed is fine
    // (terminals, browsers); an app id that is not allowed discards the image.
    var listed={};cand.forEach(function(v){if(v&&v.id!=null)listed[String(v.id)]=v});
    var kl=Array.isArray(m.kept)?m.kept:[];
    if(kl.length!==keep.length)throw _maskErr(mk,"it reported "+kl.length+" kept window(s) for "+keep.length+" asked for");
    for(var wi=0;wi<kl.length;wi++){
      var k=kl[wi]||{},lw2=listed[String(k.id)],aid=typeof k.appId==="string"?k.appId:"";
      // The listed window (pid included) when it still has this app id, else
      // the app id alone.
      var pw=lw2&&aid&&(lw2.desktop_file_name===aid||lw2.resource_class===aid)?lw2:{id:k.id,title:k.title,desktop_file_name:aid||null,resource_class:aid||null,resource_name:null,pid:null};
      var okWin=!!aid&&keep.indexOf(String(k.id))>=0&&!_isHostWin(pw)&&mk.allowed.some(function(b){return _aOwns(b,pw)});
      if(!okWin)throw _maskErr(mk,"kept window "+k.id+" ("+(aid||"no app id")+") is not a window of an allowed app any more - the image was discarded");
    }
    var reg={x:x,y:y,width:w,height:h};
    hidden=_maskHiddenIds(mk,wins.filter(function(v){return v&&keep.indexOf(String(v.id))<0&&v.is_minimized!==!0&&v.is_visible!==!1&&_rectsMeet(v.geometry,reg)}));
  }
  globalThis.__cdbDiag("[claude-cu] screenshot: captured via "+be.name+" (mask "+m.mode+", kept "+keep.length+" window(s)"+(hidden.length?", masked apps "+hidden.join(","):"")+")");
  return{base64:r.base64,imgW:r.width||w,imgH:r.height||h,mimeType:"image/jpeg",hidden:hidden};
}
// wlroots-bridge with window geometry: the app whose window is topmost
// (stacking_order) at logical point (x, y). undefined = cannot tell: a
// non-minimized window without a position could be the one on top.
function _wlHitTest(wins,x,y){
  var best=null;
  for(var i=0;i<(wins||[]).length;i++){
    var w=wins[i];
    if(!w||w.is_minimized===!0||w.is_visible===!1)continue;
    var g=w.geometry;
    if(!g||!(g.width>0&&g.height>0))return void 0;
    if(x>=g.x&&x<g.x+g.width&&y>=g.y&&y<g.y+g.height&&(!best||(w.stacking_order||0)>(best.stacking_order||0)))best=w;
  }
  return best;
}
var _ex=globalThis.__linuxExecutor={
  // Read by upstream's dispatch on every call (platform, hostBundleId,
  // screenshotFiltering, hitTest): request_access's result and the session
  // tools read executor.capabilities.screenshotFiltering live, so it is a
  // getter with capabilitiesNow()'s value ("mask" when the live bridge masks,
  // else "none"; "none" too until its doctor answered once). No hitTest key:
  // it stays as before; the live per-backend values are capabilitiesNow().
  // hostBundleId is Claude's own canonical id (com.anthropic.Claude), the id
  // its windows resolve to.
  capabilities:{get screenshotFiltering(){return _filteringNow()},platform:"linux",get hostBundleId(){return _hostId()}},
  // CU lock lifecycle hook, invoked by the upstream lock holder (Patches 4b/4b.2
  // call __linuxExecutor?.__setLockHeld?.(!0/!1) on every Linux lock transition
  // and chain .catch() — so this MUST return a Promise, hence async). On GNOME
  // this scopes the gnome-portal-bridge portal session (one consent dialog per
  // CU session; dialog-free on GNOME 46+ via restore token) to the lock.
  async __setLockHeld(held,holder){
    // The lock holder names the cloud session the session check asks about
    // (4b passes upstream's exclusiveHolder; 4b.2 releases without one).
    _gnomeHolder=held&&typeof holder==="string"?holder:null;
    globalThis.__cdbDiag?.("[claude-cu] "+(held?"lock taken by "+(_gnomeHolder||"none"):"lock released"));
    if(held)_gnomeShareFireArmed=!0;
    if(!held)_gnomeCheckStop("lock released");
    // The ask-before-control notes ("screenshots are not filtered") are once
    // per session and lock (js/cu_consent.js).
    if(!held){try{var _cc=globalThis.__cdbCuConsent;if(_cc&&typeof _cc.lockReleased==="function")_cc.lockReleased()}catch(ce){}}
    // A notFound holder is checked again on the next lock.
    if(globalThis.__cdbCuSessionCheck&&typeof globalThis.__cdbCuSessionCheck.forget==="function")globalThis.__cdbCuSessionCheck.forget();
    // The background-display setting is re-latched on every lock acquire (a
    // fresh check of the display), and before every tool call (_tgtSync). In
    // target mode a GNOME portal session left from an earlier desktop lock
    // ends now, no new one starts, and the display is checked.
    if(held){
      try{if(typeof globalThis.__cuTargetSig==="function")_tgtSigLast=await globalThis.__cuTargetSig()}catch(se){}
      _tgtSyncAt=Date.now();
      _tgtLatch("lock acquired");
      // Warm the bridge capabilities (async, after the display check) so
      // capabilities / capabilitiesNow() answer from the live bridge by
      // request_access.
      if(_tgt){await _tgtAfterLatch();_bcWarm();return}
      _bcWarm();
    }else if(_tgt)return;
    if(!_isGnomeCovered()||!_gnomeBridgeBin())return;
    // A new lock is a new task: a stop the user made during the previous one
    // no longer applies (its session-start removes the bridge's marker). Both
    // transitions cancel the idle timer; a session that is up for the new lock
    // counts its idle time from here.
    _gnomeIdleCancel();
    if(held){_gnomeStoppedClear("new lock");await _gnomeEnsureSession();if(_gnomeSessionActive&&!_gnomeIdleTimer)_gnomeIdleArm();_gnomeCheckArm()}else await _gnomeSessionEnd();
  },
  // Task-end event: upstream's renderer IPC releaseRemoteCuLock (a cloud
  // session's running->idle edge, Stop, archive, delete), forwarded by
  // fix_computer_use_linux.nim with upstream's current lock holder. Safe to
  // call any time and from any platform (no-op off the GNOME portal path);
  // never touches upstream's lock. Acts when either id is missing or both name
  // the same session - one session has two ids (session_X / cse_X) and one
  // caller lowercases, so they are compared without that prefix and case.
  // Then it does what the idle expiry does: end the portal session and lift a
  // stop-sharing latch. Nothing up: silent, it fires on every turn end.
  async __cuTaskBoundary(id,source,holder){
    // The turn ended: an Escape watcher (community switch) parks until the next action.
    try{globalThis.__cdbCuEscWatch?.taskEnded?.(id,source,holder)}catch(ee){}
    globalThis.__cdbDiag("[claude-cu] task boundary ("+source+"): received id="+id+" holder="+holder+" active="+_gnomeSessionActive+" starting="+_gnomeSessionStarting+" daemonMayExist="+_gnomeDaemonMayExist+" stoppedByUser="+_gnomeStoppedByUser+" gnomeCovered="+_isGnomeCovered());
    if(!_isGnomeCovered()||!_gnomeBridgeBin())return;
    if(!_gnomeSessionActive&&!_gnomeSessionStarting&&!_gnomeDaemonMayExist&&!_gnomeStoppedByUser)return;
    function key(v){return String(v).toLowerCase().replace(/^(?:session_|cse_)/,"")}
    if(id!=null&&holder!=null&&key(id)!==key(holder)){globalThis.__cdbDiag("[claude-cu] task boundary ("+source+"): ignored, it names another session than the Computer Use lock holder");return}
    globalThis.__cdbDiag("[claude-cu] task boundary ("+source+"): ending the portal session");
    _gnomeShareFireArmed=!0;
    _gnomeCheckStop("task boundary");
    await _gnomeSessionEnd("task boundary");
  },
  // Background display gate, awaited by our tool handler (cu_handler_injection.js)
  // before every tool: the refusal text while the target is invalid, its bridge
  // is missing or the display is down (re-checked on each call), the teach
  // refusal for teach tools in target mode, else null.
  async __targetCheck(tool){
    var g=_tgtGen;
    await _tgtSync("tool call",!0);
    if(_tgtBatch>0&&_tgtGen!==g)return _CU_TGT_CHANGED;
    var t=_tgt;if(!t)return null;
    if(t.bin&&(t.probe||t.why==="down"||!t.checked))await _tgtProbe(t);
    if(t.refuse)return t.refuse;
    if(tool==="request_teach_access"||tool==="teach_step"||tool==="teach_batch")return"Teach mode is not available while Computer Use runs on the background display "+t.display+": its overlay would draw on the user's desktop. To use teach mode, "+_CU_TGT_OFF;
    return null;
  },
  // Called by the handler when a tool failed in target mode: a failure can
  // mean the display is gone, so the target is checked again; down -> the
  // not-running refusal for this call (and, via __targetCheck, every following
  // one until it answers). Up -> null, the original error stands.
  async __targetAfterError(err){
    var t=_tgt;if(!t||!t.bin)return t&&t.refuse||null;
    await _tgtProbe(t);
    return t.refuse||null;
  },
  __targetActive(){return !!_tgt},
  // computer_batch brackets its actions with +1 / -1 (cu_handler_injection.js).
  __targetBatch(d){_tgtBatch=Math.max(0,_tgtBatch+d);return !0},
  // Accessibility tools (js/cu_ax_tools.js, issue #306): the bridge their ax-*
  // subcommands run on - the one this executor uses for windows, with the
  // background display's env overlay - or null when none can run.
  // The user stopped GNOME screen sharing for this session (#293 latch):
  // cu_ax_tools.js refuses input-like AX actions until it lifts.
  __stoppedByUser(){return _gnomeStoppedByUser},
  __axBridge(){
    if(_tgt&&(_tgt.refuse||!_tgt.bin))return null;
    if(_useWlBridge()){var b=_wlBridge();return{bin:b.bin,name:b.name,env:_spo({},b.bin).env}}
    var x=_x11BridgeBin();
    return x?{bin:x,name:"x11-bridge",env:_spo({},x).env}:null;
  },
  // The frame the next full screenshot of the monitor holding DIP point (x, y)
  // will have (same monitor list and _cuTargetDims rule the capture uses), so
  // app_ax_find can report positions before any screenshot was taken.
  __axFrameFor(x,y){
    var mons=_getMonitors();if(!mons||!mons.length)return null;
    var m=null;
    for(var i=0;i<mons.length;i++){var c=mons[i];if(x>=c.originX&&x<c.originX+c.width&&y>=c.originY&&y<c.originY+c.height){m=c;break}}
    if(!m){for(var j=0;j<mons.length;j++){if(mons[j].isPrimary){m=mons[j];break}}m=m||mons[0]}
    var sf=m.scaleFactor||1,xr=_x11PxRect(m.originX,m.originY,m.width,m.height,m.displayId);
    var d=_cuTargetDims(xr?xr.w:Math.round(m.width*sf),xr?xr.h:Math.round(m.height*sf));
    return{imgW:d.width,imgH:d.height,dispW:m.width,dispH:m.height,originX:m.originX||0,originY:m.originY||0,displayId:m.displayId,label:m.label,count:mons.length};
  },
  // x11-bridge root pixel -> Electron DIP (inverse of _x11Px), so an element's
  // AT-SPI screen position lands in the screenshot frame on X11 HiDPI.
  // Unchanged wherever _x11Px passes coordinates through.
  __axToDip(x,y){
    var list=_x11PxDisplays();
    if(!list)return[x,y];
    for(var i=0;i<list.length;i++){var m=list[i],w=m.b.width*m.sf,h=m.b.height*m.sf;if(x>=m.ox&&x<m.ox+w&&y>=m.oy&&y<m.oy+h)return[m.b.x+(x-m.ox)/m.sf,m.b.y+(y-m.oy)/m.sf]}
    return[x,y];
  },
  async listDisplays(){await _tgtPrime();return _getMonitors()},
  // Display index a capture with no display selected should use, or null for
  // "Electron's primary". Non-null only on GNOME with a portal share recorded
  // (see _gnomeSharedDefaultDisplayId); read by js/cu_handler_injection.js.
  async __defaultDisplayId(){return _gnomeSharedDefaultDisplayId()},
  async getDisplaySize(displayId){
    await _tgtPrime();
    var m=_findMon(displayId);
    return{width:m.width,height:m.height,scaleFactor:m.scaleFactor,originX:m.originX||0,originY:m.originY||0};
  },
  // opts {displayId, allowedBundleIds, scale}. allowedBundleIds undefined =
  // unmasked; an array = mask mode (see "Allowlist mask"), which throws
  // rather than capture unmasked.
  async screenshot(opts){
    _escAct();
    await _tgtPrime();
    var mon=_findMon(opts&&opts.displayId);
    var al=opts?opts.allowedBundleIds:void 0,mk=await _maskFor(al);
    var shot=await _screenshotMon(mon,mk);
    // {base64, imgW, imgH, mimeType, displayWidth, displayHeight, originX,
    // originY, masked, filtering, maskGaps[, hidden]}
    return _capNote(shot,mk,al);
  },
  // opts {allowedBundleIds, preferredDisplayId, autoResolve, doHide, scale}.
  // With an allowedBundleIds array (upstream always passes one) a failure is
  // returned as captureError, as upstream's own executors do; `hidden` lists
  // the apps the mask painted over (canonical ids), for upstream's "X was
  // hidden ... call request_access" note. Nothing is hidden on screen, so
  // __unhideApps stays a no-op.
  async resolvePrepareCapture(opts){
    if(!opts||!Array.isArray(opts.allowedBundleIds))return _ex.__resolvePrepareCapture(opts);
    try{return await _ex.__resolvePrepareCapture(opts)}
    catch(e){
      var em=e&&e.message||String(e);
      globalThis.__cdbDiag("[claude-cu] resolvePrepareCapture: "+em);
      return{base64:"",width:0,height:0,displayWidth:0,displayHeight:0,displayId:opts.preferredDisplayId!=null?opts.preferredDisplayId:0,originX:0,originY:0,hidden:[],captureError:em};
    }
  },
  async __resolvePrepareCapture(opts){
    _escAct();
    await _tgtPrime();
    var did=opts&&opts.preferredDisplayId;
    if(did==null){var sdid=await _gnomeSharedDefaultDisplayId();if(sdid!=null)did=sdid}
    var mon=_findMon(did);
    // Upstream sets autoResolve when the granted apps changed and the model
    // has not pinned a display (switch_display): capture the display holding
    // most of their windows, as macOS does. The returned displayId is what
    // upstream then keeps as the session's display.
    var apps=opts&&Array.isArray(opts.allowedBundleIds)?opts.allowedBundleIds:[];
    if(opts&&opts.autoResolve===!0&&apps.length){
      var DT=globalThis.__cdbCuDisplayTarget,src=await _dtResolve(apps),mons=_getMonitors(),tag="[claude-cu] display auto-target: apps="+apps.join(",");
      var lbl=function(m){return(m&&m.label)||"?"};
      if(!src.mons)globalThis.__cdbDiag(tag+" kept "+lbl(mon)+" ("+src.why+")");
      else{
        var r=DT.pick(src.wins,src.mons,apps,mon.displayId),pm=null;
        for(var pi=0;r.displayId!=null&&pi<mons.length;pi++)if(mons[pi].displayId===r.displayId)pm=mons[pi];
        if(!pm)globalThis.__cdbDiag(tag+" kept "+lbl(mon)+" ("+r.why+")");
        else{globalThis.__cdbDiag(tag+" -> "+lbl(pm)+" (preferred "+lbl(mon)+(r.why==="tie"?", tie":"")+")");mon=pm}
      }
    }
    var al=opts&&opts.allowedBundleIds,mk=await _maskFor(al);
    var shot=await _screenshotMon(mon,mk);
    return _capNote({base64:shot.base64,mimeType:shot.mimeType,width:shot.imgW,height:shot.imgH,displayWidth:mon.width,displayHeight:mon.height,displayId:mon.displayId,originX:mon.originX,originY:mon.originY,hidden:shot.hidden||[]},mk,al);
  },
  // zoom(rect, allowedBundleIds, displayId, scale[, opts]) - upstream's order.
  // rect {x,y,w,h} in logical px. Upstream's zoom tool passes it relative to
  // displayId's origin (as on macOS); opts.globalCoords (our own handler)
  // says it is already global. No displayId = global. allowedBundleIds:
  // undefined = unmasked, an array = mask mode (throws instead of capturing
  // unmasked). A second argument that is neither (a number: the handler's old
  // (rect, 1, displayId) call) = unmasked, global coordinates, as before.
  // scale is not used: every tier downscales by the bridges' rule.
  async zoom(rect,allowedBundleIds,displayId,scale,opts){
    _escAct();
    await _tgtPrime();
    var legacy=allowedBundleIds!==void 0&&!Array.isArray(allowedBundleIds);
    var mon=displayId!=null?_findMon(displayId):_findMonByPoint(rect.x,rect.y);
    var local=displayId!=null&&!!mon&&!legacy&&!(opts&&opts.globalCoords===!0);
    var rx=rect.x+(local?mon.originX||0:0),ry=rect.y+(local?mon.originY||0:0);
    var sf=mon?mon.scaleFactor:1;
    var mk=legacy?null:await _maskFor(allowedBundleIds);
    globalThis.__cdbDiag("[claude-cu] zoom: rect="+JSON.stringify(rect)+(local?" (display-relative)":"")+" displayId="+displayId+" mon="+((mon&&mon.label)||"?")+" sf="+sf+(mk?" mask "+(mk.allowed.length?mk.allowed.join(","):"all"):Array.isArray(allowedBundleIds)?" unmasked (backend cannot mask)":""));
    var cap=await _captureRegion(rx,ry,rect.w,rect.h,sf,displayId!=null&&mon?mon.displayId:void 0,mk);
    // {base64, imgW, imgH, mimeType, masked, filtering, maskGaps[, hidden]}
    return _capNote(cap,mk,legacy?void 0:allowedBundleIds);
  },
  async prepareForAction(bundleIds,displayId){return[]},
  // Upstream's Linux unhide (sub-patch 4h routes it here): nothing is hidden
  // by this executor yet, so there is nothing to restore.
  async __unhideApps(){},
  async previewHideSet(bundleIds,displayId){return[]},
  // [{bundleId, displayIds}] for request_access's per-app monitor note (upstream
  // asks only with more than one display); apps without a located window are
  // left out.
  async findWindowDisplays(bundleIds){
    await _tgtPrime();
    var ids=Array.isArray(bundleIds)?bundleIds:[];
    if(!ids.length||!globalThis.__cdbCuDisplayTarget)return[];
    var src=await _dtResolve(ids);
    return src.mons?globalThis.__cdbCuDisplayTarget.windowDisplays(src.wins,src.mons,ids):[];
  },
  // One row per app under its canonical id (the desktop file id; a NoDisplay
  // duplicate launcher is folded into its app as an alias), its Name LAST: upstream keys maps on bundleId with the last row winning, so the
  // grant gets the real Name. Before it, one row per alias string that
  // resolves to this app and only to it (_aResolveName), so request_access
  // can name an app by its executable, desktop id, snap / reverse-DNS tail,
  // icon or a distinctive word of its Name. Wrapper names never appear.
  async listInstalledApps(){
    await _tgtPrime();
    var apps=[];
    try{
      // NoDisplay entries first: on a shared Name the visible app's row is last.
      var idx=_appIndex(!0),ord=idx.list.filter(function(q){return q.noDisplay}).concat(idx.list.filter(function(q){return !q.noDisplay}));
      for(var i=0;i<ord.length;i++){
        var r=ord[i],en=r.e,seen={},nl=r.name.toLowerCase();
        seen[nl]=1;
        var cands=r.cand.slice(),ws=r.name.split(/\s+/).filter(Boolean);
        if(ws.length>1){cands.push(ws[0]);cands.push(ws.slice(1).join(" "))}
        for(var c=0;c<cands.length;c++){
          var s1=cands[c],k=s1.toLowerCase();
          if(!k||seen[k])continue;seen[k]=1;
          var hit=_aResolveName(s1);
          if(hit&&hit.bundleId===r.id)apps.push({bundleId:r.id,displayName:s1,path:en.file});
        }
        apps.push({bundleId:r.id,displayName:r.name,path:en.file});
      }
    }catch(e){globalThis.__cdbDiag("[claude-cu] listInstalledApps failed: "+(e&&e.message||e))}
    return apps;
  },
  // Non-minimized windows (any workspace) -> one {bundleId, displayName} per app.
  async listRunningApps(){
    await _tgtPrime();
    var be=_appBackend();
    if(be.windowList==="none")return[];
    try{
      _logFirstUse("app",be.name);
      var wins=_appWins(),apps=[],seen={};
      if(Array.isArray(wins)){
        for(var i=0;i<wins.length;i++){
          var w=wins[i];
          // A window on another workspace (is_visible false, x11-bridge and
          // wlroots-bridge alike) still means the app runs; minimized ones
          // stay out as before.
          if(!w||w.is_minimized===true)continue;
          var ref=_appRefFromWindow(w);
          if(ref&&!seen[ref.bundleId]){seen[ref.bundleId]=true;apps.push(ref)}
        }
      }
      return apps;
    }catch(e){globalThis.__cdbDiag("[claude-cu] "+be.name+" windows failed: "+(e.message||e));return[]}
  },
  // The focused window's app: the window list's active window (all bridges
  // report is_active; wlroots from the foreign-toplevel activated state);
  // x11-bridge without one falls back to its frontmost-app (GetInputFocus on a
  // WM without EWMH). null when the backend cannot know: XWayland (a native
  // Wayland window may have the focus), ydotool, no bridge, no active window
  // (wlroots-bridge's own frontmost-app would pick the first toplevel), or
  // nothing focused. A bridge that FAILED throws (an Error with __cdbFront):
  // "could not tell" is not "nothing in front" - js/cu_consent.js refuses
  // input then, and upstream's own check (cloud Cowork, teach) fails the
  // action, as it does with its own executors.
  async getFrontmostApp(){
    await _tgtPrime();
    var be=_appBackend();
    if(be.frontmost!=="native")return null;
    var wins,act=null;
    try{
      _logFirstUse("window",be.name);
      wins=_appWins();
      if(!Array.isArray(wins))throw new Error("the window list is not an array");
      for(var i=0;i<wins.length;i++){var w=wins[i];if(w&&w.is_active===true&&(!act||(w.stacking_order||0)>(act.stacking_order||0)))act=w}
      if(act)return _appRefFromWindow(act);
      if(_useWlBridge())return null;
      return _appRefFromCommand(_x11Bridge(["frontmost-app"]),function(){return wins},function(w){return w.is_minimized!==true});
    }catch(e){
      var fe=new Error(be.name+": "+String(e&&e.message||e).trim().split("\n").slice(-1)[0]);
      fe.__cdbFront=!0;
      globalThis.__cdbDiag("[claude-cu] getFrontmostApp failed: "+fe.message);
      throw fe;
    }
  },
  // The app owning the window at DIP point (x, y): x11-bridge's
  // app-under-point (X11, or the background display); wlroots-bridge with
  // window geometry (sway / Hyprland): the topmost window there by
  // stacking_order, null while any window has no position. Every other
  // backend has no hit test (niri / river: no geometry; GNOME Introspect: no
  // global origin; XWayland: native Wayland windows are invisible to X) -> null.
  async appUnderPoint(x,y){
    await _tgtPrime();
    if(_useWlBridge()&&_wlBridge().name==="wlroots-bridge"){
      var gc=await _bcProbe(_bcBridge(!0));
      if(!gc||!gc.geometry)return null;
      try{var hw=_wlHitTest(await _wlBridgeCallAsync(["windows"]),x,y);return hw?_appRefFromWindow(hw):null}catch(e){return null}
    }
    if(_appBackend().hitTest!=="native")return null;
    try{
      var _ap=_x11Px(x,y),px=_ap[0],py=_ap[1];
      return _appRefFromCommand(_x11Bridge(["app-under-point","--x",String(px),"--y",String(py)]),function(){return _x11Bridge(["windows"])},function(w){var g=w.geometry;return w.is_minimized!==true&&w.is_visible!==false&&!!g&&px>=g.x&&px<g.x+g.width&&py>=g.y&&py<g.y+g.height});
    }catch(e){return null}
  },
  // Live app-identity capabilities of the current backend (re-evaluated on
  // every call: session, background display and bridge availability). The
  // static `capabilities` above is what upstream reads; this is for our own
  // callers (tool descriptions, request_access forwarding).
  // screenshotFiltering: "mask" when the live capture bridge masks (x11-bridge
  // with doctor capabilities.screenshot_mask, the background display
  // included; wlroots-bridge with doctor screenshot_mask), else "none" -
  // capture stays unmasked there even with an allowlist. Answered from the
  // cached doctor (async probe started on first use and on every lock
  // acquire); capabilitiesAsync() waits for it. screenshotMaskGaps: what the
  // mask does not cover (wlroots-bridge doctor screenshot_mask_gaps).
  capabilitiesNow(){
    var be=_appBackend(),mb=_bcBridge(),mc=_bcNow(mb),mask=!!(mc&&mc.mask);
    return{screenshotFiltering:mask?"mask":"none",screenshotMaskGaps:mask?mc.gaps.slice():[],platform:"linux",hostBundleId:_hostId(),backend:be.name,hitTest:be.hitTest,frontmost:be.frontmost,windowList:be.windowList,windowPositions:be.windowPositions};
  },
  async capabilitiesAsync(){
    try{await _tgtPrime()}catch(e){}
    try{await _bcProbe(_bcBridge())}catch(e){}
    try{await _bcProbe(_bcBridge(!0))}catch(e){}
    return _ex.capabilitiesNow();
  },
  // What the last capture with an allowlist did ({filtering, gaps, at}), or
  // null before one: the settings status line reports it rather than a probe.
  __lastCapture(){return _lastCap?{filtering:_lastCap.filtering,gaps:_lastCap.gaps.slice(),at:_lastCap.at}:null},
  // request_access name -> {bundleId, displayName, path} | null, and the alias
  // strings of a canonical id (see "App identity").
  resolveApp(name){return _aResolveName(name)},
  appAliases(bundleId){return _aAliases(bundleId)},
  async getAppIcon(appPath){return null},
  async openApp(name){
    _escAct();
    await _tgtPrime();
    var _appDirs=_xdgAppDirs();
    // Parse all .desktop entries once (shared parser: [Desktop Entry] group,
    // full Exec argv, TryExec filter) so we can both resolve the launch entry
    // and, on failure, suggest close matches.
    function _allEntries(){return _readDesktopEntries(_appDirs)}
    // Two passes so a name/desktop-id match always beats an exec-basename match
    // ("brave" must not resolve to a Brave web-app entry whose argv0 is brave).
    function _resolveApp(n,entries){
      var nl=n.toLowerCase(),i;
      for(i=0;i<entries.length;i++){
        if(entries[i].name.toLowerCase()===nl||entries[i].dfn.toLowerCase()===nl)return entries[i];
      }
      for(i=0;i<entries.length;i++){
        if(entries[i].base.toLowerCase()===nl)return entries[i];
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
    // Target mode: windows are listed async (never a sync spawn here), and the
    // ids present before the launch are remembered - only a NEW window proves
    // the app opened on the target (B3 handoff detection).
    function _winsAsync(){return _useWlBridge()?_wlBridgeCallAsync(["windows"]):_x11BridgeAsync(["windows"])}
    var _bridgeOk,_tgtBefore=null,_tgtWins=null;
    if(_tgt){
      // The target must answer BEFORE anything is spawned: a launch into a
      // display that is gone opens the app on the user's desktop (measured,
      // issue #300 T10). A failed window list re-checks the display; one that
      // still answers `screens` but cannot list windows launches unverified.
      await _tgtProbe(_tgt);if(_tgt.refuse)throw _tgtErr();
      _bridgeOk=false;
      try{_tgtWins=await _winsAsync();_bridgeOk=Array.isArray(_tgtWins)}catch(wte){if(wte&&wte.__cdbSurface)throw wte;globalThis.__cdbDiag("[claude-cu] openApp: target windows failed: "+(wte.message||wte));await _tgtProbe(_tgt);if(_tgt.refuse)throw _tgtErr()}
      if(_bridgeOk){_tgtBefore={};for(var _bi=0;_bi<_tgtWins.length;_bi++)_tgtBefore[String(_tgtWins[_bi].id)]=1}
    }else if(_useWlBridge()){
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
    // The request naming the window's app by any alias (canonical id scheme,
    // e.g. "org.mozilla.firefox" for WM_CLASS firefox) is an exact match too.
    var _rqIds={};
    function _rqId(nl){if(!_hasOwn.call(_rqIds,nl)){var r=_arec(_appIndex(),nl);_rqIds[nl]=r?r.id:null}return _rqIds[nl]}
    function _matchScore(w,nl){
      if(!nl)return 0;
      var dfn=_norm(w.desktop_file_name),rc=_norm(w.resource_class),rn=_norm(w.resource_name);
      if(dfn===nl||rc===nl||rn===nl)return 3;
      var rq=_rqId(nl);if(rq){var wr=_aWin(w);if(wr&&wr.id===rq)return 3}
      // partial class/name containment (e.g. request "code", class "Code")
      if((dfn&&dfn.indexOf(nl)>=0)||(rc&&rc.indexOf(nl)>=0)||(rn&&rn.indexOf(nl)>=0))return 2;
      var title=typeof w.title==="string"?w.title.trim().toLowerCase():"";
      if(title&&title.indexOf(nl)===0)return 1;
      return 0;
    }
    // wins: a list already fetched (target mode), else the bridge is asked.
    // skip: ids to ignore (the windows from before a target launch).
    function _findWindow(nl,wins,skip){
      if(!wins)try{wins=_winCall(["windows"])}catch(e){globalThis.__cdbDiag("[claude-cu] openApp: bridge windows failed: "+(e.message||e));return null}
      if(!Array.isArray(wins))return null;
      var best=null,bestScore=0;
      for(var i=0;i<wins.length;i++){
        var w=wins[i];
        if(w.is_dock===true||w.is_desktop===true||(skip&&skip[String(w.id)]))continue;
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
      var existing=_findWindow(nl,_tgtWins);
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
    if(!resolved&&_tgt)throw new Error("Opening a file or URL ("+name+") is not available on the background display: xdg-open would open it on the user's desktop. Open the app on the background display instead.");
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
    // Throws a clear error when no launch tier works (no xdg-open-by-name
    // fallback: it never launched an app by name).
    var _launched=await _launchEntry(resolved,name);
    // 3) On the bridge path, poll briefly for a matching new window and activate
    // it. Slow-starting apps that never show a window within the budget are NOT
    // an error — return launch_attempted so the model knows to screenshot.
    // The wait is a timer, not a blocking `sleep` child: the main process stays
    // responsive on both paths.
    if(_tgt&&!_bridgeOk)return{action:"launch_attempted",app:name,note:"the background display cannot list its windows, so the launch cannot be verified"};
    // A new window counts only when it is the app's: its pid is in the
    // launched process tree (setsid makes it a session leader, so descendants
    // keep its session id even after reparenting), or its name/class matches
    // the request or the entry. Anything else keeps the poll going. Cold
    // starts on a software-GL display can take long: TGT_LAUNCH_MS, async.
    if(_tgt){
      var _root=_launched&&_launched.pid,_names=[nl,_norm(resolved.name),_norm(resolved.dfn),_norm(resolved.base)].filter(function(v,i,a){return v&&a.indexOf(v)===i});
      function _inTree(pid){
        if(!_root||!(pid>1))return !1;
        for(var _p=pid,_n=0;_p>1&&_n<64;_n++){
          if(_p===_root)return !0;
          var _st;try{_st=String(_fs.readFileSync("/proc/"+_p+"/stat","utf8"))}catch(pe){return !1}
          var _f=_st.slice(_st.lastIndexOf(")")+2).split(" ");
          if(+_f[3]===_root)return !0;
          _p=+_f[1];
        }
        return !1;
      }
      function _mine(w){if(w.is_dock===true||w.is_desktop===true)return !1;if(_inTree(w.pid))return !0;for(var _k=0;_k<_names.length;_k++){if(_matchScore(w,_names[_k])>0)return !0}return !1}
      var _tdl=Date.now()+TGT_LAUNCH_MS;
      while(Date.now()<_tdl){
        await new Promise(function(r){setTimeout(r,500)});
        var _tw;
        try{_tw=await _winsAsync()}catch(twe){if(twe&&twe.__cdbSurface)throw twe;await _tgtProbe(_tgt);if(_tgt.refuse)throw _tgtErr();continue}
        if(!Array.isArray(_tw))continue;
        var _hit=null;
        for(var _ti=0;!_hit&&_ti<_tw.length;_ti++){var _tc=_tw[_ti];if(!_tgtBefore[String(_tc.id)]&&_mine(_tc))_hit=_tc}
        if(_hit){
          globalThis.__cdbDiag("[claude-cu] openApp: new window on the background display for "+name+" (id "+_hit.id+")");
          try{var _tr=_activate(_hit);_tr.action="launched";return _tr}
          catch(tae){return{action:"launched",app:_bundleIdFromWindow(_hit)||name}}
        }
      }
      globalThis.__cdbDiag("[claude-cu] openApp: no window of "+name+" on the background display "+_tgt.display+" within "+TGT_LAUNCH_MS/1000+" s");
      var _ho=new Error(resolved.name+" did not show a window on the Computer Use display within "+TGT_LAUNCH_MS/1000+" s. It may still be starting, or it is already running on the user's desktop and opened there. Take a screenshot to check; if it is not there, ask the user to close it on their desktop.");
      _ho.__cdbSurface=!0;throw _ho;
    }
    if(_bridgeOk&&nl){
      var _deadline=Date.now()+5000;
      while(Date.now()<_deadline){
        await new Promise(function(r){setTimeout(r,500)});
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
  async moveMouse(x,y){_escAct();await _tgtPrime();_moveMouse(x,y)},
  async click(x,y,button,count,holdKeys){
    _escAct();
    await _tgtPrime();
    _moveMouse(x,y);
    var rep=count||1;
    return _escAround(_escKeys(holdKeys),function(){
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
      var _xp=_x11Px(x,y);
      var _cargs=["pointer-click","--x",String(_xp[0]),"--y",String(_xp[1]),"--button",btnName,"--count",String(rep)];
      if(holdKeys&&holdKeys.length>0){for(var i=0;i<holdKeys.length;i++){_cargs.push("--modifier",holdKeys[i])}}
      _x11Bridge(_cargs);
    }
    });
  },
  async mouseDown(){
    _escAct();
    await _tgtPrime();
    if(_useWlBridge()){_logFirstUse("drag",_wlBridge().name);_wlBridgeCall(["left-mouse-down"])}
    else if(_wayland&&_checkYdotool()){_logFirstUse("drag","ydotool");_ydotool(["click","0x40"])}
    else{_logFirstUse("drag","x11-bridge");_x11Bridge(["left-mouse-down"])}
  },
  async mouseUp(){
    _escAct();
    await _tgtPrime();
    if(_useWlBridge()){_wlBridgeCall(["left-mouse-up"])}
    else if(_wayland&&_checkYdotool()){_ydotool(["click","0x80"])}
    else{_x11Bridge(["left-mouse-up"])}
  },
  async getCursorPosition(){
    await _tgtPrime();
    if(_tgt){
      // x11-bridge knows the real pointer; wlroots-bridge refuses by design.
      if(_tgt.kind==="x11"){try{var q=await _x11BridgeAsync(["cursor-position"],SCREENS_TIMEOUT_MS);if(q&&typeof q.x==="number"&&typeof q.y==="number"){_tgtCursorSet(q.x,q.y);return{x:q.x,y:q.y}}}catch(e){if(e&&e.__cdbSurface)throw e}}
      return _tgtCursor();
    }
    var p=_electron.screen.getCursorScreenPoint();
    return{x:p.x,y:p.y};
  },
  async drag(start,end){
    _escAct();
    await _tgtPrime();
    if(_useWlBridge()){
      _logFirstUse("drag",_wlBridge().name);
      var _wcp=start?null:_tgt?_tgtCursor():_electron.screen.getCursorScreenPoint();
      var _wfx=start?Math.round(start.x):Math.round(_wcp.x);
      var _wfy=start?Math.round(start.y):Math.round(_wcp.y);
      _tgtCursorSet(end.x,end.y);
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
      // Both endpoints are DIP (the cursor too: getCursorScreenPoint is DIP on X11).
      var _cur=start||(_tgt?_tgtCursor():_electron.screen.getCursorScreenPoint()),_from=_x11Px(_cur.x,_cur.y),_to=_x11Px(end.x,end.y);
      _tgtCursorSet(end.x,end.y);
      _x11Bridge(["pointer-drag","--from-x",String(_from[0]),"--from-y",String(_from[1]),"--to-x",String(_to[0]),"--to-y",String(_to[1])]);
    }
  },
  async scroll(x,y,horizontal,vertical){
    _escAct();
    await _tgtPrime();
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
      if(dx!==0||dy!==0){var _sp=_x11Px(x,y);_x11Bridge(["pointer-scroll","--x",String(_sp[0]),"--y",String(_sp[1]),"--dx",String(dx),"--dy",String(dy)])}
    }
  },
  async key(combo,count){
    _escAct();
    await _tgtPrime();
    var n=count||1;
    return _escAround(_escKeys(combo),function(){
    _escExpect(combo,n);
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
    });
  },
  async holdKey(keyName,seconds){
    _escAct();
    await _tgtPrime();
    var secs=Math.min(seconds||0.5,10);
    return _escAround(_escKeys(keyName),function(){
    _escExpect([keyName],1);
    if(_useWlBridge()){
      _logFirstUse("key",_wlBridge().name);
      _wlBridgeCall(["hold-key","--key",keyName,"--duration-ms",String(Math.round(secs*1000))]);
    }else if(_wayland&&_checkYdotool()){
      _logFirstUse("key","ydotool");
      var k=_mapKeyWayland(keyName);
      _ydotool(["key",k+":1"]);
      _cp.execFileSync(_toolCmd("sleep")||"sleep",[String(secs)]);
      _ydotool(["key",k+":0"]);
    }else{
      _logFirstUse("key","x11-bridge");
      _x11Bridge(["hold-key","--key",keyName,"--duration-ms",String(Math.round(secs*1000))]);
    }
    },secs*1000);
  },
  async type(text,opts){
    _escAct();
    await _tgtPrime();
    if(_tgt&&opts&&opts.viaClipboard){
      // Paste through the target's own clipboard (never the desktop's).
      _logFirstUse("type",(_tgt.kind==="x11"?"x11-bridge":"wlroots-bridge")+" (target clipboard)");
      await _tgtClipWrite(text);
      if(_useWlBridge())_wlBridgeCall(["key-sequence","--keys","ctrl+v"]);else _x11Bridge(["key-sequence","--keys","ctrl+v"]);
      return;
    }
    if(_useWlBridge()){
      _logFirstUse("type",_wlBridge().name+(opts&&opts.viaClipboard?" (clipboard)":""));
      if(opts&&opts.viaClipboard){
        await _electron.clipboard.writeText(text,"clipboard");
        _wlBridgeCall(["key-sequence","--keys","ctrl+v"]);
      }else{
        return _escAround(_escText(text),function(){_wlBridgeCall(["type","--text",text])},text.length*12);
      }
    }else if(_wayland&&_checkYdotool()){
      _logFirstUse("type","ydotool"+(opts&&opts.viaClipboard?" (clipboard)":""));
      if(opts&&opts.viaClipboard){
        await _electron.clipboard.writeText(text,"clipboard");
        _ydotool(["key","29:1","47:1","47:0","29:0"]);
      }else{
        return _escAround(_escText(text),function(){_ydotool(["type","--",text])},text.length*12);
      }
    }else{
      _logFirstUse("type","x11-bridge"+(opts&&opts.viaClipboard?" (clipboard)":""));
      if(opts&&opts.viaClipboard){
        await _electron.clipboard.writeText(text,"clipboard");
        _x11Bridge(["key-sequence","--keys","ctrl+v"]);
      }else{
        return _escAround(_escText(text),function(){_x11Bridge(["type","--text",text])},text.length*12);
      }
    }
  },
  // Electron 44 (v1.49585.0+) made clipboard.readText/writeText Promise-returning;
  // awaiting is a no-op on older sync builds and mandatory now (paste must not fire
  // before the write lands, and a rejection must stay inside the try).
  async readClipboard(){
    await _tgtPrime();
    if(_tgt)return _tgtClipRead();
    try{return (await _electron.clipboard.readText("clipboard"))||""}
    catch(e){return""}
  },
  async writeClipboard(text){
    await _tgtPrime();
    if(_tgt)return _tgtClipWrite(text||"");
    await _electron.clipboard.writeText(text||"","clipboard");
  }
};
// Ask the capture bridge's doctor now (async), so the first prompt suffix and
// supported-features answer (js/cu_consent.js) already know whether it masks.
_bcWarm();
})();

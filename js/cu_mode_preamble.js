await (async function(){
// ── diagnostics sink ─────────────────────────────────────────────────────────
// The official .deb build DISCARDS console/process.stdout writes in the main
// process (the fds themselves are healthy - proven 2026-07-06 by writing into
// /proc/<mainpid>/fd/1 from a child while console.log in the same process
// produced nothing). So diagnostics go through __cdbDiag: raw fs.writeSync to
// fd 2 (reaches a terminal launch) plus a tee into userData/logs/
// claude-patches.log (profile/3p-aware, 2 MiB rotation). Never throws.
if(!globalThis.__cdbDiag){globalThis.__cdbDiag=function(){var s="";try{var i,a=[];for(i=0;i<arguments.length;i++){var x=arguments[i];if(typeof x==="string")a.push(x);else{try{a.push(JSON.stringify(x))}catch(e1){a.push(String(x))}}}s=a.join(" ")}catch(e2){}if(!s)return;try{require("fs").writeSync(2,s+"\n")}catch(e3){}try{var p=require("path"),fs=require("fs");if(!globalThis.__cdbDiagDir){globalThis.__cdbDiagDir=p.join(require("electron").app.getPath("userData"),"logs");fs.mkdirSync(globalThis.__cdbDiagDir,{recursive:!0})}var f=p.join(globalThis.__cdbDiagDir,"claude-patches.log");try{if(fs.statSync(f).size>2097152)fs.renameSync(f,f+".old")}catch(e4){}fs.appendFileSync(f,new Date().toISOString()+" "+s+"\n")}catch(e5){}};}
// Bound once: the TPM probe below settles after this preamble returned.
var _cdbLog=globalThis.__cdbDiag;
// ── remote-device decision (sub-patch 4g + Settings -> Extra status panel) ──
// Cloud Cowork and Dispatch reach this screen through the remote-tools device,
// whose announce upstream drops the computer tools from on every Wayland
// session. Sub-patch 4g lifts that term on Linux exactly when this decision
// says a first-party bridge is usable here (announceWayland). Pure function of
// the inputs the preamble collected below; one table, tested by
// scripts/tests/linux/test-cu-wayland-announce.mjs. Input:
//   {env, mode, target: null | {kind,display} | {invalid},
//    bins: {kwin, x11, wlroots, gnome} (path when `--version` ran, else ""),
//    wlrootsSession, gnomeSession}
// A bridge counts only when the executor would use THAT binary: the executors
// take a *_BRIDGE_BIN env value first even when it is not executable, so a set
// override that did not resolve to itself makes the bridge unusable.
// `wayland` is upstream's own rule (XDG_SESSION_TYPE when set, else
// WAYLAND_DISPLAY): it is the session check 4g's term replaces.
globalThis.__cdbCuDecide=function(i){
  i=i||{};
  var env=i.env||{},b=i.bins||{},t=i.target||null,st=env.XDG_SESSION_TYPE;
  var wayland=st?st==="wayland":!!env.WAYLAND_DISPLAY;
  var est=String(st||"").toLowerCase(),execWayland=est==="wayland"?!0:est==="x11"?!1:!!env.WAYLAND_DISPLAY;
  var VAR={"kwin-portal-bridge":"KWIN_PORTAL_BRIDGE_BIN","wlroots-bridge":"WLROOTS_BRIDGE_BIN","gnome-portal-bridge":"GNOME_PORTAL_BRIDGE_BIN","x11-bridge":"X11_BRIDGE_BIN"};
  function use(name,p){var v=env[VAR[name]];p=typeof p==="string"?p:"";return v?(p===v?p:""):p}
  var backend="none",bin="",tg=null;
  if(t&&typeof t.kind!=="string")tg={invalid:String(t.invalid!=null?t.invalid:"invalid setting")};
  else if(t){
    tg={kind:t.kind,display:String(t.display)};
    var tn=t.kind==="x11"?"x11-bridge":t.kind==="wlroots"?"wlroots-bridge":"",tb=tn?use(tn,t.kind==="x11"?b.x11:b.wlroots):"";
    if(tb){backend=tn;bin=tb}
  }
  else if(i.mode==="kwin-wayland"){var kb=use("kwin-portal-bridge",b.kwin);if(kb){backend="kwin-portal-bridge";bin=kb}}
  else{
    var wb=i.wlrootsSession?use("wlroots-bridge",b.wlroots):"",gb=i.gnomeSession?use("gnome-portal-bridge",b.gnome):"",xb=use("x11-bridge",b.x11);
    if(wb){backend="wlroots-bridge";bin=wb}
    else if(gb){backend="gnome-portal-bridge";bin=gb}
    else if(!execWayland){if(xb){backend="x11-bridge";bin=xb}}
    // Wayland without a usable first-party bridge: XWayland x11-bridge,
    // ydotool or spectacle - Code sessions only. A covered session (wlroots,
    // GNOME) has no third-party cascade, so without XWayland nothing is left.
    else backend=xb||!(i.wlrootsSession||i.gnomeSession)?"fallback":"none";
  }
  var ov=bin&&env[VAR[backend]]===bin?VAR[backend]:null;
  // x11-bridge counts only for a background display (its own X server): on the
  // desktop it reaches XWayland windows only.
  var ann=wayland&&!!bin&&(backend!=="x11-bridge"||!!(tg&&tg.kind));
  return Object.freeze({v:1,mode:i.mode==="kwin-wayland"?"kwin-wayland":"regular",wayland:wayland,backend:backend,bin:bin||null,override:ov,target:tg?Object.freeze(tg):null,announceWayland:ann});
};
// Set once per process, never re-assigned; on a Wayland session one log line
// says whether the computer tools are announced.
function _cdbSetDecision(d){
  if(globalThis.__cdbCuDecision!==void 0)return;
  globalThis.__cdbCuDecision=d;
  globalThis.__cdbCuWaylandAnnounce=d.announceWayland===!0;
  if(d.wayland)_cdbLog(d.announceWayland?"[claude-cu] remote device: computer tools announced on Wayland ("+d.backend+")":"[claude-cu] remote device: computer tools not announced on Wayland (no first-party bridge usable on this session)");
}
// ── device key (TPM) at start ────────────────────────────────────────────────
// The remote-tools device is keyed only when the app can open /dev/tpmrm0.
// One access(2) check (honours ACLs), started here and never awaited, so the
// status panel can tell "accessible now" from "accessible since start".
// __cdbTpmAtStart stays undefined until it settles.
try{
  var _tfs=require("fs"),_tc=_tfs.constants||{};
  _tfs.promises.access("/dev/tpmrm0",(_tc.R_OK||4)|(_tc.W_OK||2)).then(function(){
    globalThis.__cdbTpmAtStart=Object.freeze({state:"ok",code:null});
    _cdbLog("[claude-cu] device key: /dev/tpmrm0 ok");
  },function(e){
    var c=e&&e.code?String(e.code):"UNKNOWN";
    var s=c==="ENOENT"?"absent":c==="EACCES"||c==="EPERM"?"denied":"error";
    globalThis.__cdbTpmAtStart=Object.freeze({state:s,code:s==="absent"?null:c});
    _cdbLog(s==="absent"?"[claude-cu] device key: /dev/tpmrm0 absent":"[claude-cu] device key: /dev/tpmrm0 not accessible ("+c+")");
  });
}catch(te0){globalThis.__cdbTpmAtStart=Object.freeze({state:"error",code:te0&&te0.code?String(te0.code):"UNKNOWN"})}
try{
// ── bundled-bridge resolver ──────────────────────────────────────────────────
// All four bridges ship at a FIXED location inside the package - the same
// resources/ dir where upstream keeps its own bundled binaries
// (cowork-linux-helper, smol images, virtiofsd). So resolution is simply:
// <envVar> override (NixOS GNOME native build, debugging) → bundled dir.
// No $PATH scanning - a missing bundled bridge is a packaging bug that must
// fail loud, not be papered over by a stray system binary. The dir is
// process.resourcesPath: the app.asar is exe-adjacent in every install
// (Electron's OnlyLoadAppFromAsar autoload), so Electron resolves it natively.
// WHICH bridge to resolve is decided by SESSION detection below, not here.
//
// ASYNC ON PURPOSE: this preamble is injected at the top of upstream's
// `app.on("ready", async () => {...})` handler and awaited there, so the
// executor branch that follows it sees the final decision. Nothing on this
// path may be synchronous (issue #232: a blocking execFileSync froze the UI).
// All probes run in parallel: the preamble costs one spawn round-trip when the
// bridges work, and at most PROBE_TIMEOUT_MS when one hangs.
  var _cdbBridgeDir=process.resourcesPath;
  var _rfs=require("fs"),_rp=require("path"),_cp=require("child_process");
  var PROBE_TIMEOUT_MS=3000;
  function _cdbResolveBin(name,envVar){
    function _ok(c){try{_rfs.accessSync(c,_rfs.constants.X_OK);return!0}catch(e){return!1}}
    var _x=envVar?process.env[envVar]:"";
    if(_x&&_ok(_x))return _x;
    var _b=_rp.join(_cdbBridgeDir,name);
    return _ok(_b)?_b:"";
  }
  // ── runnable check ─────────────────────────────────────────────────────────
  // X_OK only says the file is there. A bridge that cannot LOAD (NixOS: foreign
  // ELF interpreter; Ubuntu 22.04 / Debian 12 / RHEL 9: PipeWire or glibc older
  // than the gnome/kwin bridge floor) must not be selected, or every CU action
  // fails and the next tier (spectacle on KDE, x11-bridge/XWayland elsewhere)
  // is never reached. Every bridge is a clap binary whose `--version` prints
  // one line and touches nothing else - the cheapest proof that it runs.
  // Cached per process by path: the verdict cannot change while we run.
  var _probeCache=globalThis.__cuBridgeProbeCache||(globalThis.__cuBridgeProbeCache={});
  var _bridgeFail=globalThis.__cuBridgeFail||(globalThis.__cuBridgeFail={});
  function _probe(bin){
    if(_probeCache[bin])return _probeCache[bin];
    return _probeCache[bin]=new Promise(function(resolve){
      var done=!1,err="",child,timer;
      function fin(r){if(done)return;done=!0;clearTimeout(timer);resolve(r)}
      try{child=_cp.spawn(bin,["--version"],{stdio:["ignore","ignore","pipe"]})}catch(e){fin({ok:!1,err:e});return}
      timer=setTimeout(function(){try{child.kill("SIGKILL")}catch(e){}fin({ok:!1,timeout:!0})},PROBE_TIMEOUT_MS);
      if(child.stderr)child.stderr.on("data",function(d){if(err.length<4096)err+=d});
      child.on("error",function(e){fin({ok:!1,err:e})});
      child.on("close",function(code,sig){fin(code===0?{ok:!0}:{ok:!1,code:code,signal:sig,stderr:err})});
    });
  }
  // Turn a failed probe into the real cause plus a hint that points at the
  // actual fix. "Reinstall the package" is only honest when the file is
  // missing, and that case never reaches the probe.
  function _explain(r,envVar){
    var cause,hint="";
    if(r.timeout){cause="no answer to --version within "+PROBE_TIMEOUT_MS/1000+" s";hint="the bridge hangs at startup"}
    else if(r.err){
      var c=r.err.code;
      if(c==="ENOENT"){cause="exec failed with ENOENT although the file exists";hint="its ELF interpreter (dynamic loader) is missing - a binary built for another distro. On NixOS set "+envVar+" to a Nix-built bridge, or enable programs.nix-ld"}
      else if(c==="ENOEXEC"){cause="exec format error";hint="the binary was built for another CPU architecture than this "+process.arch+" system"}
      else if(c==="EACCES"){cause="permission denied";hint="the file system is mounted noexec, or the file is not executable"}
      else cause="spawn failed: "+(r.err.message||c);
    }else if(r.signal)cause="killed by "+r.signal;
    else{
      var se=r.stderr||"",line=(se.split("\n").map(function(s){return s.trim()}).filter(Boolean)[0])||"";
      cause="exit "+r.code+(line?": "+line:"");
      var g=se.match(/GLIBC_(\d+\.\d+)/),lib=se.match(/error while loading shared libraries: ([^:\s]+)/);
      if(/pw_stream_get_nsec|libpipewire/.test(se))hint="needs PipeWire >= 1.0.5 (Ubuntu 24.04+, Fedora 40+, Debian 13+); this system's PipeWire is older or missing";
      else if(g)hint="needs glibc >= "+g[1]+"; this system's glibc is older (the gnome/kwin bridges need Ubuntu 24.04+, Fedora 40+, Debian 13+)";
      else if(lib)hint="missing shared library "+lib[1]+" - install the distro package that provides it";
      else if(/symbol lookup error|undefined symbol/.test(se))hint="a system library is older than the one the bridge was built against";
    }
    return{cause:cause,hint:hint};
  }
  // Resolve + probe one bridge. Resolves to the path when it runs, "" when it
  // is missing or cannot run. A failure is logged and kept in __cuBridgeFail so
  // the executor's error text can name the cause.
  function _runnable(name,envVar,consequence){
    var bin=_cdbResolveBin(name,envVar);
    if(!bin)return Promise.resolve("");
    return _probe(bin).then(function(r){
      if(r.ok)return bin;
      var x=_explain(r,envVar);
      _bridgeFail[name]={path:bin,cause:x.cause,hint:x.hint};
      globalThis.__cdbDiag("[claude-cu] "+name+" at "+bin+" cannot run ("+x.cause+")"+(x.hint?" - "+x.hint:"")+"; "+consequence);
      return "";
    });
  }
  // ── background display (issue #300) ────────────────────────────────────────
  // Settings -> Extra -> Cowork (Linux) -> "Computer Use on a background display":
  // key computerUseBackgroundDisplay in <userData>/claude-desktop-extra.jsonc
  // (wins per key) or .json. __cuTargetRead() -> null (off / key absent),
  // {kind,display,env} (valid), or {invalid:why,display} (on but unusable: CU
  // fails closed). Same rules as the panel's validator (js/extra_settings_main.js),
  // the own-display rule included (spec ruling "T8 review, SEVERITY 1"). Small
  // sync reads; the executor calls it at startup and once per CU lock, never
  // mid-turn.
  // __cuTargetIdentity(kind,display,env): is the target Claude's own display
  // (display 1, never probed, captured or driven)? null = a different display;
  // {own:1}; {down:1} = a wlroots socket that does not exist (yet); {why} =
  // unusable. x11: display NUMBERS compared, own parsed from DISPLAY in any
  // host:N.S form (XWayland on a Wayland desktop counts). wlroots: the target
  // must stat as a socket (symlinks followed); own = Claude's WAYLAND_DISPLAY
  // socket; the same (dev, ino) is own. A relative target name resolves against
  // the env map's XDG_RUNTIME_DIR (what the bridge child uses), else Claude's;
  // Claude's own socket always against Claude's. Not provable (own socket set but
  // unstatable) = refused. stat only, no spawn; the executor re-checks before
  // every `screens` probe.
  if(!globalThis.__cuTargetIdentity)globalThis.__cuTargetIdentity=function(k,d,env){
    var hrt=process.env.XDG_RUNTIME_DIR||"",trt=env&&typeof env.XDG_RUNTIME_DIR==="string"&&env.XDG_RUNTIME_DIR||hrt;
    // The display NUMBER of any host:N.S form ([::1]:0, ::1:0 and host::0 included).
    function xn(s){var m=/:(\d+)(?:\.\d+)?$/.exec(String(s||""));return m?parseInt(m[1],10):null}
    function abs(w,rt){return w.charAt(0)==="/"?w:(rt.charAt(0)==="/"?_rp.join(rt,w):"")}
    var ownX=xn(process.env.DISPLAY),ow=process.env.WAYLAND_DISPLAY||"",op=ow?abs(ow,hrt):"",os=null,osTried=!1;
    function wl(w){
      var p=abs(w,trt),st;
      if(!p)return{why:"XDG_RUNTIME_DIR is not set, so "+w+" cannot be found - use an absolute socket path"};
      try{st=_rfs.statSync(p)}catch(e){return e&&e.code==="ENOENT"?{down:1}:{why:w+" cannot be checked ("+(e&&e.code||e)+")"}}
      if(!st.isSocket())return{why:w+" is not a Wayland socket"};
      if(!osTried){osTried=!0;if(op){try{os=_rfs.statSync(op)}catch(e){}}}
      if(ow&&!os)return{why:"cannot tell whether "+w+" is your own desktop (Claude's own Wayland socket "+ow+" cannot be checked)",unsure:1};
      return os&&os.dev===st.dev&&os.ino===st.ino?{own:1}:null;
    }
    // The env map's other display var reaches every spawn too (the target's
    // own var always wins over the map): the same rule applies to it.
    if(env&&k==="wlroots"&&typeof env.DISPLAY==="string"&&env.DISPLAY&&ownX!==null&&xn(env.DISPLAY)===ownX)return{own:1,via:"env DISPLAY "+env.DISPLAY};
    if(env&&k==="x11"&&typeof env.WAYLAND_DISPLAY==="string"&&env.WAYLAND_DISPLAY){var q=wl(env.WAYLAND_DISPLAY);if(q&&(q.own||q.unsure))return q.own?{own:1,via:"env WAYLAND_DISPLAY "+env.WAYLAND_DISPLAY}:q}
    if(k==="x11")return ownX!==null&&ownX===xn(d)?{own:1}:null;
    return wl(d);
  };
  if(!globalThis.__cuTargetRead)globalThis.__cuTargetRead=function(){
    function strip(s){return String(s).replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,function(m,q){return q?q:""}).replace(/,(\s*[}\]])/g,"$1")}
    // -> the object, null (absent), or {__err, raw} (there but not usable; raw =
    // its text when it could be read, else undefined). No userData (no
    // Electron app yet) = no file.
    function rd(n){var p,raw;try{try{(globalThis.__cdbCfgMigrate||function(){})()}catch(me){}p=_rp.join(require("electron").app.getPath("userData"),n)}catch(pe){return null}try{raw=String(_rfs.readFileSync(p,"utf8"));var t=strip(raw),v=t.trim()?JSON.parse(t):{};return v&&typeof v==="object"&&!Array.isArray(v)?v:{__err:"not a JSON object",raw:raw}}catch(e){return e&&e.code==="ENOENT"?null:{__err:e&&(e.code||e.message)||String(e),raw:raw}}}
    // The human-owned .jsonc wins. One that is there but does not parse while
    // its text names the key fails closed (a typo must not silently move
    // Computer Use back to the desktop). Without the key, or unreadable (its
    // text unknown), it is skipped as before - a broken file must not stop
    // Computer Use for users who never turned this on - with a diagnostics line.
    var K="computerUseBackgroundDisplay",c=rd("claude-desktop-extra.jsonc");
    if(c&&c.__err){
      if(typeof c.raw==="string"&&c.raw.indexOf(K)>=0)return{invalid:"claude-desktop-extra.jsonc cannot be parsed ("+c.__err+")",display:""};
      var dl="[claude-cu] diagnostics: target: claude-desktop-extra.jsonc "+(typeof c.raw==="string"?"does not parse":"cannot be read")+" ("+c.__err+")"+(typeof c.raw==="string"?" and does not mention "+K:"")+" - ignored for the background display setting";
      if(globalThis.__cuTgtJsoncDiag!==dl){globalThis.__cuTgtJsoncDiag=dl;try{globalThis.__cdbDiag(dl)}catch(de){}}
      c=null;
    }
    var o=c&&Object.prototype.hasOwnProperty.call(c,K)?c:rd("claude-desktop-extra.json");
    if(o&&o.__err)o=null;
    var v=o&&o[K];
    if(!v||typeof v!=="object"||v.enabled!==!0)return null;
    var k=v.kind,d=v.display,e=v.env,bad=function(w){return{invalid:w,display:typeof d==="string"?d:""}};
    if(k!=="x11"&&k!=="wlroots")return bad("kind must be \"x11\" or \"wlroots\"");
    if(typeof d!=="string"||!(k==="x11"?/^:(0|[1-9]\d{0,4})$/.test(d):d.length<=255&&(/^wayland-[A-Za-z0-9._-]{1,64}$/.test(d)||(d.charAt(0)==="/"&&d.indexOf("\0")<0&&!/(^|\/)\.\.?(\/|$)/.test(d)))&&!/\.lock$/.test(d)))return bad("display "+JSON.stringify(d)+" is not a valid "+k+" display");
    if(e!==void 0){
      if(!e||typeof e!=="object"||Array.isArray(e))return bad("env must be an object of strings");
      for(var n in e){if(!Object.prototype.hasOwnProperty.call(e,n))continue;if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)||n==="PATH"||n==="CLAUDE_ELECTRON"||/^LD_/.test(n))return bad("env may not set "+n);if(typeof e[n]!=="string")return bad("env value of "+n+" must be a string")}
    }
    // Claude's own display (display 1) is never a target: that is the desktop.
    // A wlroots socket that is not there yet is "not running", decided by the
    // executor's probe (which re-runs this check first).
    var idn=globalThis.__cuTargetIdentity(k,d,e);
    if(idn&&idn.own)return bad((idn.via||d)+" is your own desktop, not a background display");
    if(idn&&idn.why)return bad(idn.why);
    var env={};if(e)for(var m in e){if(Object.prototype.hasOwnProperty.call(e,m))env[m]=e[m]}
    return{kind:k,display:d,env:env};
  };
  // Change detection for the setting, so it can be latched per TOOL CALL
  // (upstream's app-scoped lock, acquireApp, never reaches our lock hook):
  // a signature of both files (ino, size, mtime; "-" = absent). Async stat
  // per call, no read; the sync twin is for module load only.
  if(!globalThis.__cuTargetSig){
    var _sigPaths=function(){try{var u=require("electron").app.getPath("userData");return[_rp.join(u,"claude-desktop-extra.jsonc"),_rp.join(u,"claude-desktop-extra.json")]}catch(e){return null}};
    var _sigOf=function(st){return st?st.ino+":"+st.size+":"+st.mtimeMs:"-"};
    globalThis.__cuTargetSig=function(){var ps=_sigPaths();if(!ps)return Promise.resolve("no-userdata");return Promise.all(ps.map(function(p){return _rfs.promises.stat(p).then(_sigOf,function(e){return e&&e.code==="ENOENT"?"-":"?"+(e&&e.code)})})).then(function(a){return a.join("|")})};
    globalThis.__cuTargetSigSync=function(){var ps=_sigPaths();if(!ps)return"no-userdata";return ps.map(function(p){try{return _sigOf(_rfs.statSync(p))}catch(e){return e&&e.code==="ENOENT"?"-":"?"+(e&&e.code)}}).join("|")};
  }
  var _cuTgt=null;try{_cuTgt=globalThis.__cuTargetRead()}catch(te){}
  var envMode=process.env.CLAUDE_CU_MODE;
  var autoMode="regular";
  var _kwinVer="";
  var _kwinOk=!1;
  // KDE-Wayland detection must match the DOWNSTREAM DE detection in
  // cu_linux_executor.js (XDG_CURRENT_DESKTOP, lowercased substring) or the two
  // disagree: a session whose XDG_CURRENT_DESKTOP contains KDE but whose
  // XDG_SESSION_DESKTOP is "plasma"/unset (SDDM/DM-dependent, unreliable) would
  // route past the kwin-portal-bridge into the "exotic" ydotool/x11-bridge
  // fallback while the diagnostics still say de=kde (issue #194). Key off
  // XDG_CURRENT_DESKTOP (which Plasma reliably sets to "KDE"), case-insensitive
  // substring, and accept WAYLAND_DISPLAY as a Wayland signal since
  // XDG_SESSION_TYPE is not always exported.
  var _curDesk=(process.env.XDG_CURRENT_DESKTOP||"").toLowerCase();
  var _isWaylandSess=process.env.XDG_SESSION_TYPE==="wayland"||!!process.env.WAYLAND_DISPLAY;
  // A background display forces the regular executor: kwin mode drives the
  // live KDE session only, and the executor is chosen once, here. So the
  // kwin probes are skipped; a switch flipped while running takes effect in
  // kwin mode after a restart (executor_linux.js refuses until then).
  var _isKdeWayland=_curDesk.indexOf("kde")>=0&&_isWaylandSess&&!_cuTgt;
  var _resolvedBin="";
  // Session gating for the regular-executor bridges, so we don't probe
  // binaries irrelevant to the running compositor.
  var _sessType=(process.env.XDG_SESSION_TYPE||"").toLowerCase();
  var _sessionCouldNeedX11=_sessType==="x11"||_sessType==="wayland"||!!process.env.WAYLAND_DISPLAY||!!process.env.DISPLAY;
  var _wlSess=_sessType==="wayland"||!!process.env.WAYLAND_DISPLAY;
  var _isWlroots=_wlSess&&(!!process.env.SWAYSOCK||!!process.env.HYPRLAND_INSTANCE_SIGNATURE||!!process.env.NIRI_SOCKET);
  var _isGnome=_wlSess&&_curDesk.indexOf("gnome")>=0;
  var _none=Promise.resolve("");
  var _kwinVerP=_none,_kwinP=_none;
  if(_isKdeWayland){
    _kwinVerP=new Promise(function(resolve){
      try{_cp.execFile("kwin_wayland",["--version"],{encoding:"utf8",timeout:2000},function(e,out){resolve(e?"":String(out||""))})}catch(e){resolve("")}
    });
    _kwinP=_runnable("kwin-portal-bridge","KWIN_PORTAL_BRIDGE_BIN","using the regular executor (spectacle tier) instead");
  }
  // The regular-executor bridges are probed in parallel with the kwin checks;
  // their result is only used when kwin mode is not selected.
  // A valid background display's bridge is probed too (its own display, any
  // session): the remote-device decision needs to know it runs, and a failure
  // lands in __cuBridgeFail, which the executor's target resolver honours.
  var _tgtKind=_cuTgt&&!_cuTgt.invalid?_cuTgt.kind:"";
  var _x11P=_sessionCouldNeedX11||_tgtKind==="x11"?_runnable("x11-bridge","X11_BRIDGE_BIN","X11 input/screenshot + XWayland fallback unavailable"):_none;
  var _wlrP=_isWlroots||_tgtKind==="wlroots"?_runnable("wlroots-bridge","WLROOTS_BRIDGE_BIN","wlroots-Wayland CU input/screenshot unavailable"):_none;
  var _gnP=_isGnome?_runnable("gnome-portal-bridge","GNOME_PORTAL_BRIDGE_BIN","GNOME-Wayland CU input/screenshot unavailable"):_none;
  var _res=await Promise.all([_kwinVerP,_kwinP,_x11P,_wlrP,_gnP]);
  var _m=_res[0].match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if(_m){_kwinVer=_m[0];var _maj=parseInt(_m[1],10),_min=parseInt(_m[2],10);_kwinOk=_maj>6||(_maj===6&&_min>=6)}
  var _kwinBroken=!1;
  if(_kwinOk){
    _resolvedBin=_res[1];
    if(_resolvedBin){autoMode="kwin-wayland";globalThis.__cuKwinBridgeBin=_resolvedBin}
    else _kwinBroken=!!_bridgeFail["kwin-portal-bridge"];
  }
  var _mode=_cuTgt?"regular":envMode||autoMode;
  globalThis.__cuKwinMode=_mode==="kwin-wayland";
  // x11-bridge serves the regular (non-kwin-wayland) executor: X11 sessions,
  // and the XWayland input/screenshot backend on Wayland sessions where ydotool
  // is unavailable. wlroots-bridge (Sway/Hyprland/Niri) and gnome-portal-bridge
  // (GNOME Wayland) are the first-party backends for those session types.
  // Skipped in kwin-wayland mode (that path uses kwin-portal-bridge). A bridge
  // that is present but cannot run was already logged by _runnable.
  if(!globalThis.__cuKwinMode){
    if(_sessionCouldNeedX11){
      var _xbBin=_res[2];
      if(_xbBin){globalThis.__cuX11BridgeBin=_xbBin;globalThis.__cdbDiag("[claude-cu] x11-bridge resolved at "+_xbBin)}
      else if(!_bridgeFail["x11-bridge"])globalThis.__cdbDiag("[claude-cu] x11-bridge not found (X11 input/screenshot + XWayland fallback unavailable)");
    }
    if(_isWlroots){
      var _wlrBin=_res[3];
      if(_wlrBin){globalThis.__cuWlrootsBridgeBin=_wlrBin;globalThis.__cdbDiag("[claude-cu] wlroots-bridge resolved at "+_wlrBin)}
      else if(!_bridgeFail["wlroots-bridge"])globalThis.__cdbDiag("[claude-cu] wlroots-bridge not found (wlroots-Wayland CU input/screenshot unavailable)");
    }
    if(_isGnome){
      var _gnBin=_res[4];
      if(_gnBin){globalThis.__cuGnomeBridgeBin=_gnBin;globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge resolved at "+_gnBin)}
      else if(!_bridgeFail["gnome-portal-bridge"])globalThis.__cdbDiag("[claude-cu] gnome-portal-bridge not found (GNOME-Wayland CU input/screenshot unavailable)");
    }
  }
  var _reason;
  if(_cuTgt)_reason=" (background display "+(_cuTgt.invalid?"setting invalid: "+_cuTgt.invalid:_cuTgt.kind+" "+_cuTgt.display)+")";
  else if(envMode)_reason=" (CLAUDE_CU_MODE set)";
  else if(autoMode==="kwin-wayland")_reason=" (auto: KDE Wayland + kwin-portal-bridge at "+_resolvedBin+", "+_kwinVer+")";
  else if(_kwinBroken)_reason=" (auto: KDE Wayland, KWin "+_kwinVer+", but kwin-portal-bridge cannot run: "+_bridgeFail["kwin-portal-bridge"].cause+")";
  else if(_isKdeWayland&&!_kwinOk)_reason=" (auto: cross-distro fallback; KWin "+(_kwinVer||"unknown")+" < 6.6)";
  else _reason=" (auto: cross-distro fallback)";
  globalThis.__cdbDiag("[claude-cu] mode="+_mode+_reason);
  _cdbSetDecision(globalThis.__cdbCuDecide({env:process.env,mode:_mode,target:_cuTgt,bins:{kwin:_resolvedBin,x11:_res[2],wlroots:_res[3],gnome:_res[4]},wlrootsSession:_isWlroots,gnomeSession:_isGnome}));
}catch(_cdbE){
  // The decision 4g reads must exist even when the preamble fails: nothing is
  // announced on Wayland. The error still reaches upstream's ready handler.
  try{var _cst=process.env.XDG_SESSION_TYPE;_cdbSetDecision(Object.freeze({v:1,mode:globalThis.__cuKwinMode===!0?"kwin-wayland":"regular",wayland:_cst?_cst==="wayland":!!process.env.WAYLAND_DISPLAY,backend:"none",bin:null,override:null,target:null,announceWayland:!1}))}catch(_cdbE2){}
  throw _cdbE;
}
})();

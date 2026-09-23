await (async function(){
// ── diagnostics sink ─────────────────────────────────────────────────────────
// The official .deb build DISCARDS console/process.stdout writes in the main
// process (the fds themselves are healthy - proven 2026-07-06 by writing into
// /proc/<mainpid>/fd/1 from a child while console.log in the same process
// produced nothing). So diagnostics go through __cdbDiag: raw fs.writeSync to
// fd 2 (reaches a terminal launch) plus a tee into userData/logs/
// claude-patches.log (profile/3p-aware, 2 MiB rotation). Never throws.
if(!globalThis.__cdbDiag){globalThis.__cdbDiag=function(){var s="";try{var i,a=[];for(i=0;i<arguments.length;i++){var x=arguments[i];if(typeof x==="string")a.push(x);else{try{a.push(JSON.stringify(x))}catch(e1){a.push(String(x))}}}s=a.join(" ")}catch(e2){}if(!s)return;try{require("fs").writeSync(2,s+"\n")}catch(e3){}try{var p=require("path"),fs=require("fs");if(!globalThis.__cdbDiagDir){globalThis.__cdbDiagDir=p.join(require("electron").app.getPath("userData"),"logs");fs.mkdirSync(globalThis.__cdbDiagDir,{recursive:!0})}var f=p.join(globalThis.__cdbDiagDir,"claude-patches.log");try{if(fs.statSync(f).size>2097152)fs.renameSync(f,f+".old")}catch(e4){}fs.appendFileSync(f,new Date().toISOString()+" "+s+"\n")}catch(e5){}};}
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
  var _isKdeWayland=_curDesk.indexOf("kde")>=0&&_isWaylandSess;
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
  var _x11P=_sessionCouldNeedX11?_runnable("x11-bridge","X11_BRIDGE_BIN","X11 input/screenshot + XWayland fallback unavailable"):_none;
  var _wlrP=_isWlroots?_runnable("wlroots-bridge","WLROOTS_BRIDGE_BIN","wlroots-Wayland CU input/screenshot unavailable"):_none;
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
  var _mode=envMode||autoMode;
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
  if(envMode)_reason=" (CLAUDE_CU_MODE set)";
  else if(autoMode==="kwin-wayland")_reason=" (auto: KDE Wayland + kwin-portal-bridge at "+_resolvedBin+", "+_kwinVer+")";
  else if(_kwinBroken)_reason=" (auto: KDE Wayland, KWin "+_kwinVer+", but kwin-portal-bridge cannot run: "+_bridgeFail["kwin-portal-bridge"].cause+")";
  else if(_isKdeWayland&&!_kwinOk)_reason=" (auto: cross-distro fallback; KWin "+(_kwinVer||"unknown")+" < 6.6)";
  else _reason=" (auto: cross-distro fallback)";
  globalThis.__cdbDiag("[claude-cu] mode="+_mode+_reason);
})();

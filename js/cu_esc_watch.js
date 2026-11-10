(function(){
// ── Computer Use: Escape stops it (issue #323) - COMMUNITY FEATURE ──────────
// Embedded by patches/community/add_feature_cu_escape_abort.nim (17d) next to
// upstream's Escape functions, Linux only; it does nothing until the switch
// Settings -> Extra -> Community Features -> "Escape stops Computer Use"
// (key computerUseEscapeAbort, read through
// globalThis.__cdbCuEscapeAbortEnabled() from js/extra_settings_main.js) is
// on. OFF is the default and keeps upstream exactly: its own register function
// runs (an X11 globalShortcut grab; nothing on Wayland), no bridge process is
// spawned, no heal runs.
//
// ON: upstream's Escape register function (17a) arms the watcher here instead
// of its X11 grab, its unregister function (17b) disarms it. Both follow
// upstream's cuLockChanged, so every session type is covered by upstream's own
// trigger. The switch is read at arm time (no restart). arm() answers false
// when no watcher can run here right now (no watcher for this desktop, bridge
// missing or known not to run, the breaker tripped): 17a then runs upstream's
// own body - on X11 its grab, on Wayland nothing. A watcher that fails later
// on X11 (exit 2, not runnable, breaker) falls back the same way: upstream's
// register function is called again and this time runs its own body.
//
// Turn-scoped: the watcher runs only while the model works. Code tab and local
// Cowork release the lock after each turn (lock-scoped is turn-scoped there).
// Cloud Cowork / Dispatch keep the lock until the idle sweep or Stop: there the
// turn end (taskEnded: upstream's releaseRemoteCuLock IPC and the #293
// session-check poller, both through the executors' __cuTaskBoundary) parks
// the watcher, and the next Computer Use ACTION while the lock is still held
// (toolCall: capture, input, opening an app, accessibility actions - not the
// app list, icons or capability probes upstream also runs between turns) arms
// it again - async, never delaying the action. A cuLockChanged that keeps the
// same exclusive holder (an app-mode holder came or went) keeps the parked
// state. Sessions without a turn-end signal stay lock-scoped.
//
// The watcher is a bridge subcommand, `<bridge> abort-watch` (bridge CLI
// contract v2, the cu-abort-watch crate): JSON lines on stdout
// ({"event":"ready","mechanism","syntheticSafe"}, {"event":"abort"},
// {"event":"ack","cmd"}, {"event":"error","message"}), `suspend` / `resume`
// on stdin, exit on stdin EOF / SIGTERM / parent death (CLAUDE_CU_PARENT_PID).
// Exit 0 = normal, 2 = arming failed (no retry until the next arm), 1 =
// runtime failure (one re-spawn per arm cycle). Anything else - unreadable or
// unknown output, an unknown mechanism, no `ready` within READY_MS - stops the
// watcher; MAX_FAILURES failures of any kind end it for this app run (fail
// towards "no watcher": Computer Use itself is never affected).
//
// Which watcher follows the HOST session (where the user's keyboard is), not
// the input bridge, and the background display does not change it:
//   X11 session (any desktop)        x11-bridge abort-watch (XInput2, passive:
//                                    Escape still reaches the app)
//   Hyprland                         wlroots-bridge abort-watch (non-consuming
//                                    bind: Escape still reaches the app;
//                                    verified on 0.55 and newer)
//   sway                             wlroots-bridge abort-watch (taken while
//                                    armed; an Escape binding in sway's
//                                    default mode keeps it off)
//   KDE Plasma Wayland (any KWin)    kwin-portal-bridge abort-watch (kglobalaccel:
//                                    while armed Escape only stops Computer
//                                    Use - no Overview / menu / launcher
//                                    close, no app; not enabled when another
//                                    global shortcut already uses Escape)
//   GNOME Wayland, niri, other       none: upstream's Escape in Claude's own
//                                    windows, Stop sharing and Stop remain
// The bridge is resolved like js/cu_mode_preamble.js does it (the *_BRIDGE_BIN
// override when executable, else process.resourcesPath/<bridge>; no PATH
// lookup) and must pass the same `--version` runnable check (shared cache).
// Nothing here is per profile: the bridges reference-count compositor-global
// binds, so one Escape stops Computer Use in every profile that holds the lock.
// While armed on KDE, kglobalaccel records the watcher's component name (no
// key) in kglobalshortcutsrc (accepted, maintainer ruling 2026-11-10).
//
// suspendAround(fn): a model-injected Escape (both executors wrap every input
// that can carry one) must not stop the turn. A watcher that is not
// syntheticSafe is told `suspend` first and `resume` after (in a finally,
// once the injecting bridge command has returned), one window at a time;
// otherwise fn just runs. Not syntheticSafe: kglobalaccel (KDE Wayland,
// always), x11-bridge on an XWayland display, and whatever else a watcher
// reports in its `ready` line. The KDE watcher re-grabs
// ~150 ms after `resume` and reports nothing before its ack. If no `resume`
// comes within 5 s it exits with status 1 instead (as the last holder it also
// removes the shortcut). That exit inside an open window is expected: it is
// not a failure, and the watcher is started again only once the injection has
// returned. A window expected to outlast the limit (SUSPEND_LIMIT_MS) stops the
// watcher (orderly) before the injection and starts it again after, instead of
// suspending.
// wlroots-bridge is spawned on sway and Hyprland only (niri is filtered here;
// any other wlroots compositor would answer exit 2 by itself).
if(globalThis.__cdbCuEscWatch)return;
var _cp=require("child_process"),_fs=require("fs"),_path=require("path");
// Disarm is patient: a KDE watcher's orderly cleanup (holder lock up to 10 s,
// several D-Bus calls) can take well over 10 s, and a watcher killed early
// leaves Escape grabbed desktop-wide. stdin EOF first, SIGTERM after GRACE_MS,
// SIGKILL only after KILL_MS more (never on app quit: the watcher also follows
// CLAUDE_CU_PARENT_PID and cleans up once the app is gone).
var GRACE_MS=5000,KILL_MS=30000,CLEANUP_WAIT_MS=15000,READY_MS=5000,PREV_WAIT_MS=4500,MAX_FAILURES=3,SUSPEND_ACK_MS=500,RESUME_ACK_MS=2000,RESPAWN_MS=1000,PROBE_MS=3000;
function diag(s){try{(globalThis.__cdbDiag||function(){})("[claude-cu] esc-watch: "+s)}catch(e){}}
function msgOf(e){return e&&e.message?e.message:String(e)}
var VAR={"x11-bridge":"X11_BRIDGE_BIN","wlroots-bridge":"WLROOTS_BRIDGE_BIN","kwin-portal-bridge":"KWIN_PORTAL_BRIDGE_BIN"};

var MECHANISMS={xi2:1,sway:1,hyprland:1,kglobalaccel:1};
function enabled(){try{var f=globalThis.__cdbCuEscapeAbortEnabled;return typeof f==="function"&&f()===!0}catch(e){return!1}}
// The host session -> {bridge, why}. bridge null = no global Escape here.
// Session rule of the executors: XDG_SESSION_TYPE when it says wayland or x11,
// else WAYLAND_DISPLAY. Compositors as the preamble detects them.
function select(env){
  env=env||process.env;
  var st=String(env.XDG_SESSION_TYPE||"").toLowerCase();
  var wl=st==="wayland"?!0:st==="x11"?!1:!!env.WAYLAND_DISPLAY;
  var desk=String(env.XDG_CURRENT_DESKTOP||"").toLowerCase();
  if(!wl)return env.DISPLAY?{bridge:"x11-bridge",why:"X11 session"}:{bridge:null,why:"no X display"};
  if(env.NIRI_SOCKET)return{bridge:null,why:"niri has no runtime key binding API"};
  if(env.SWAYSOCK)return{bridge:"wlroots-bridge",why:"sway"};
  if(env.HYPRLAND_INSTANCE_SIGNATURE)return{bridge:"wlroots-bridge",why:"Hyprland"};
  if(desk.indexOf("kde")>=0)return{bridge:"kwin-portal-bridge",why:"KDE Plasma Wayland"};
  if(desk.indexOf("gnome")>=0)return{bridge:null,why:"GNOME Wayland has no global Escape for Claude"};
  return{bridge:null,why:"no global Escape on this Wayland compositor"+(desk?" ("+desk+")":"")};
}
function resolveBin(name){
  function ok(p){try{_fs.accessSync(p,_fs.constants.X_OK);return!0}catch(e){return!1}}
  var x=process.env[VAR[name]];
  if(x&&ok(x))return x;
  var base=process.resourcesPath;
  if(typeof base!=="string"||!base)return"";
  var b=_path.join(base,name);
  return ok(b)?b:"";
}
// The preamble's runnable check, through its per-path cache (one probe per
// process for each binary, whoever asks first).
function runnable(name,bin){
  var fail=globalThis.__cuBridgeFail;
  if(fail&&fail[name]&&fail[name].path===bin)return Promise.resolve(!1);
  var cache=globalThis.__cuBridgeProbeCache||(globalThis.__cuBridgeProbeCache={});
  // Same result shape as the preamble's probe (js/cu_mode_preamble.js
  // _probe), stderr included, so whoever reads the shared entry later can
  // still explain a failure.
  if(!cache[bin])cache[bin]=new Promise(function(resolve){
    var done=!1,err="",child,timer;
    function fin(r){if(done)return;done=!0;clearTimeout(timer);resolve(r)}
    try{child=_cp.spawn(bin,["--version"],{stdio:["ignore","ignore","pipe"]})}catch(e){fin({ok:!1,err:e});return}
    timer=setTimeout(function(){try{child.kill("SIGKILL")}catch(e){}fin({ok:!1,timeout:!0})},PROBE_MS);
    if(child.stderr)child.stderr.on("data",function(d){if(err.length<4096)err+=d});
    child.on("error",function(e){fin({ok:!1,err:e})});
    child.on("close",function(code,sig){fin(code===0?{ok:!0}:{ok:!1,code:code,signal:sig,stderr:err})});
  });
  return cache[bin].then(function(r){return!!(r&&r.ok)},function(){return!1});
}

var S={reasons:{},kids:[],window:null,holder:void 0,regFn:null,fallen:!1,hooks:!1,lockHeld:!1,parked:!1,armed:!1,gen:0,handler:null,child:null,ready:null,bridge:null,bin:"",respawned:!1,muted:!1,tail:Promise.resolve(),lastExit:null,spawns:0,stale:null,cleaning:null,cleanups:0,failures:0,dead:!1};

// A watcher that ended abnormally (a signal, our SIGKILL) may have left its
// compositor binding behind. One `<bridge> abort-watch` with stdin closed at
// once arms as first holder (which removes a stale binding) and disarms again.
// Run on the next arm at the latest (awaited, bounded), and at once when no
// watcher is armed.
function cleanup(){
  var st=S.stale;S.stale=null;
  if(!st)return S.cleaning||Promise.resolve();
  S.cleanups++;
  diag("cleanup: running "+st.bridge+" abort-watch once with stdin closed ("+st.why+")");
  var q,p=new Promise(function(resolve){
    var c,done=!1,t;
    function fin(how){if(done)return;done=!0;clearTimeout(t);diag("cleanup "+how);resolve()}
    var env={};for(var k in process.env)env[k]=process.env[k];env.CLAUDE_CU_PARENT_PID=String(process.pid);
    try{c=_cp.spawn(st.bin,["abort-watch"],{stdio:["pipe","ignore","ignore"],env:env})}catch(e){fin("could not start ("+msgOf(e)+")");return}
    if(c.stdin){c.stdin.on("error",function(){});try{c.stdin.end()}catch(e){}}
    c.on("error",function(e){fin("failed ("+msgOf(e)+")")});
    c.on("exit",function(code,sig){fin("done ("+(sig?"signal "+sig:"exit "+code)+")")});
    t=setTimeout(function(){fin("still running after "+CLEANUP_WAIT_MS+" ms; continuing")},CLEANUP_WAIT_MS);
    if(t.unref)t.unref();
  });
  q=S.cleaning=p.then(function(){if(S.cleaning===q)S.cleaning=null});
  return q;
}
// Every failure counts, across arms; MAX_FAILURES end the watcher for this run.
function failed(){
  S.failures++;
  if(S.failures>=MAX_FAILURES&&!S.dead){S.dead=!0;diag("giving up on the Escape watcher for this app run after "+S.failures+" failures - Computer Use keeps working; Escape in Claude's own windows, Stop sharing and Stop remain")}
}

// Is this an X11 session (upstream's own grab is the fallback there)?
function isX11(){return select(process.env).bridge==="x11-bridge"}
// Synchronously knowable "no watcher here now": the reason, or "".
function cannot(){
  if(S.dead)return"the watcher failed "+S.failures+" times in this app run";
  var sel=select(process.env);
  if(!sel.bridge)return sel.why;
  var bin=resolveBin(sel.bridge);
  if(!bin)return sel.bridge+" not found";
  var f=globalThis.__cuBridgeFail;
  if(f&&f[sel.bridge]&&f[sel.bridge].path===bin)return sel.bridge+" at "+bin+" cannot run";
  return"";
}
// The quit hook and the exit hook, installed on the first arm with the switch
// on (nothing is added while the feature stays off). will-quit only: a quit
// cancelled after before-quit must not leave the watcher off for the hold.
function hooks(){
  if(S.hooks)return;S.hooks=!0;
  try{var a=require("electron").app;if(a&&typeof a.on==="function")a.on("will-quit",function(){disarm("app quit")})}catch(e){}
  process.once("exit",function(){S.kids.forEach(function(c){if(!c.__cdbExited){try{c.kill("SIGTERM")}catch(e){}}})});
}

// 17a, upstream's Escape register (cuLockChanged with a holder, switch on):
// arm(handler, exclusive holder, upstream's register function). true = ours
// is (being) armed, upstream's body must not run; false = run upstream's body.
function arm(handler,holder,regFn){
  diag("arm (lock held by "+(holder==null?"?":holder)+")"+(S.lockHeld&&holder===S.holder?(S.parked?", same holder: stays parked until the next action":S.fallen?", same holder: upstream's grab stays":", same holder"):""));
  hooks();
  if(typeof handler==="function")S.handler=handler;
  if(typeof regFn==="function")S.regFn=regFn;
  var same=S.lockHeld&&holder===S.holder;
  if(same&&S.fallen)return!1;
  if(same&&(S.parked||S.armed))return!0;
  var why=cannot();
  if(why){
    if(S.armed||S.child)deactivate(!1);
    S.lockHeld=!1;S.parked=!1;S.holder=void 0;
    diag("no Escape watcher ("+why+"); "+(isX11()?"upstream's own Escape grab is used":"Escape in Claude's own windows, Stop sharing and Stop remain"));
    return!1;
  }
  S.lockHeld=!0;S.parked=!1;S.holder=holder;S.fallen=!1;
  activate();
  return!0;
}
// A watcher of ours cannot run on this X11 session after all: hand the hold
// to upstream's own grab, through upstream's register function (17a sees
// S.fallen and runs upstream's body, which keeps its pJ consistent for its
// unregister). Wayland: nothing to fall back to.
function fallback(why){
  if(!S.lockHeld||S.fallen||!isX11())return;
  S.fallen=!0;
  diag("falling back to upstream's own Escape grab ("+why+")");
  if(S.armed||S.child)deactivate(!1);
  var f=S.regFn;
  if(typeof f==="function"){try{f()}catch(e){diag("upstream's Escape register threw: "+msgOf(e))}}
}
function activate(){
  if(S.armed)return;
  if(S.dead){diag("not armed: the watcher failed "+S.failures+" times in this app run");fallback("the watcher was given up for this app run");return}
  S.armed=!0;S.respawned=!1;
  var g=++S.gen;
  start(g).catch(function(e){S.armed=!1;failed();diag("arming failed: "+msgOf(e)+" - Computer Use keeps working without the Escape watcher");fallback("arming failed")});
}
function deactivate(quitting){
  S.armed=!1;S.gen++;S.muted=!1;
  var c=S.child;
  if(c)stop(c,quitting);
}
// 17b, upstream's Escape unregister (CU lock released), and app quit. A no-op,
// silent, when nothing of ours is armed (the switch is off, or was never on).
function disarm(why){
  if(!S.lockHeld&&!S.armed&&!S.child)return;
  diag("disarm ("+(typeof why==="string"&&why?why:"lock released")+")");
  S.lockHeld=!1;S.parked=!1;S.holder=void 0;S.fallen=!1;
  // App quit: stdin EOF + SIGTERM, never SIGKILL (the watcher finishes its
  // cleanup on its own, and also once our pid is gone).
  deactivate(why==="app quit");
}
// The turn ended while the lock stays held (cloud Cowork): the executors'
// __cuTaskBoundary(id, source, holder). An id naming another session than the
// lock holder is not this turn (one session has two ids: session_X / cse_X).
function taskEnded(id,source,holder){
  if(!S.lockHeld||S.parked||S.fallen)return;
  function key(v){return String(v).toLowerCase().replace(/^(?:session_|cse_)/,"")}
  if(id!=null&&holder!=null&&key(id)!==key(holder))return;
  diag("turn ended ("+(source||"?")+"): watcher off until the next Computer Use action");
  S.parked=!0;
  deactivate(!1);
}
// A Computer Use action (the executors' action entries, the accessibility
// actions). Cheap and sync: only a parked watcher under a held lock is armed
// again, asynchronously.
function toolCall(){
  if(!S.lockHeld||!S.parked)return;
  S.parked=!1;
  if(!enabled()){diag("Computer Use action: the switch is off now, watcher stays off");return}
  diag("Computer Use action under the held lock: watcher on again");
  activate();
}
// Wait (bounded) until previous watchers of ours that are still stopping have
// exited: an orderly KDE disarm can take seconds, and a watcher that starts
// next to it may find the shared holder lock busy.
function prevStopped(){
  var busy=S.kids.filter(function(k){return k.__cdbStopping&&!k.__cdbExited});
  if(!busy.length)return Promise.resolve();
  return Promise.race([Promise.all(busy.map(function(k){return k.__cdbExitP})),new Promise(function(r){var t=setTimeout(r,PREV_WAIT_MS);if(t.unref)t.unref()})]);
}
async function start(g){
  if(S.stale||S.cleaning)await cleanup();
  if(g!==S.gen||!S.armed)return;
  var sel=select(process.env);
  if(!sel.bridge){S.armed=!1;diag("no global Escape watcher ("+sel.why+"); Escape in Claude's own windows, Stop sharing and Stop remain");return}
  var bin=resolveBin(sel.bridge);
  if(!bin){S.armed=!1;diag(sel.bridge+" not found");fallback(sel.bridge+" not found");return}
  var ok=await runnable(sel.bridge,bin);
  if(g!==S.gen||!S.armed)return;
  if(!ok){S.armed=!1;diag(sel.bridge+" at "+bin+" cannot run");fallback(sel.bridge+" cannot run");return}
  S.bridge=sel.bridge;S.bin=bin;
  await prevStopped();
  spawn(g);
}
function spawn(g){
  if(g!==S.gen||!S.armed||S.dead)return;
  var env={};for(var k in process.env)env[k]=process.env[k];
  env.CLAUDE_CU_PARENT_PID=String(process.pid);
  var c;
  try{c=_cp.spawn(S.bin,["abort-watch"],{stdio:["pipe","pipe","pipe"],env:env})}
  catch(e){S.armed=!1;failed();diag(S.bridge+" abort-watch could not start ("+msgOf(e)+"); Computer Use keeps working without it");fallback("the watcher could not start");return}
  S.spawns++;
  c.__cdbGen=g;c.__cdbBridge=S.bridge;c.__cdbBin=S.bin;c.__cdbWaits={};c.__cdbErr="";c.__cdbStopping=!1;c.__cdbExited=!1;
  // Another watcher of ours still running (stopping, past the bounded wait).
  c.__cdbOverlap=S.kids.some(function(k){return!k.__cdbExited});
  c.__cdbExitP=new Promise(function(r){c.__cdbExitR=r});
  c.__cdbReadyP=new Promise(function(r){c.__cdbReadyR=r});
  S.kids.push(c);
  S.child=c;S.ready=null;
  if(c.stdin)c.stdin.on("error",function(){});
  var buf="";
  if(c.stdout){c.stdout.setEncoding("utf8");c.stdout.on("data",function(d){
    buf+=d;var i;
    while((i=buf.indexOf("\n"))>=0){var line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(line)onLine(c,line)}
    if(buf.length>65536){buf="";bad(c,"wrote an over-long line")}
  })}
  if(c.stderr){c.stderr.setEncoding("utf8");c.stderr.on("data",function(d){c.__cdbErr=(c.__cdbErr+d).slice(-2048)})}
  c.on("error",function(e){if(!c.__cdbExited){c.__cdbErr=c.__cdbErr||msgOf(e);onExit(c,null,null,e)}});
  c.on("exit",function(code,sig){onExit(c,code,sig)});
  var rt=setTimeout(function(){if(!c.__cdbExited&&!c.__cdbReady&&!c.__cdbStopping)bad(c,"sent no ready line within "+READY_MS+" ms")},READY_MS);
  if(rt.unref)rt.unref();
  c.__cdbTimers=[rt];
}
// The watcher broke the protocol: stop it (orderly), count a failure, no
// re-spawn in this arm cycle. One line.
function bad(c,why){
  if(c.__cdbBad||c.__cdbExited)return;
  c.__cdbBad=!0;
  diag("watcher "+why+"; stopping it - Computer Use keeps working");
  failed();
  if(S.child===c){S.armed=!1;S.gen++;S.muted=!1}
  stop(c,!1);
  fallback("the watcher misbehaved");
}
function settle(c,cmd,how){var w=c.__cdbWaits[cmd];if(w){c.__cdbWaits[cmd]=null;w(how)}}
function onLine(c,line){
  if(c.__cdbBad)return;
  var o;try{o=JSON.parse(line)}catch(e){bad(c,"wrote unreadable output ("+line.slice(0,80)+")");return}
  if(!o||typeof o!=="object"){bad(c,"wrote unexpected output");return}
  if(o.event==="ready"){
    if(c!==S.child||c.__cdbReady)return;
    if(!MECHANISMS[o.mechanism]||typeof o.syntheticSafe!=="boolean"){bad(c,"reported an unknown mechanism ("+String(o.mechanism).slice(0,40)+")");return}
    c.__cdbReady=!0;
    S.ready={mechanism:o.mechanism,syntheticSafe:o.syntheticSafe};
    if(c.__cdbReadyR)c.__cdbReadyR("ready");
    diag("ready ("+S.bridge+", mechanism "+S.ready.mechanism+", syntheticSafe "+S.ready.syntheticSafe+")");
  }else if(o.event==="abort"){
    if(c!==S.child||!S.armed){diag("abort after disarm ignored");return}
    if(S.muted){diag("abort ignored inside a suspend window (model Escape)");return}
    var h=S.handler;
    diag("abort: the user pressed Escape, stopping Computer Use");
    if(typeof h!=="function")return;
    try{h()}catch(e){diag("upstream's Escape handler threw: "+msgOf(e))}
  }else if(o.event==="ack"){
    // Muted from the ack on, in this same tick: an abort line right behind it
    // in the same chunk is the model's Escape (the watcher never reports one
    // after `ack suspend`, but a late one must not stop the turn either).
    if(o.cmd==="suspend"&&c===S.child&&c.__cdbWaits.suspend)S.muted=!0;
    settle(c,String(o.cmd),"ack");
  }else if(o.event==="error"){
    var m=String(o.message==null?"":o.message);
    c.__cdbLastError=m;
    // Before ready the error explains an arming failure: it goes verbatim
    // into the one exit line instead.
    if(S.ready&&c===S.child)diag("watcher error: "+m.slice(0,300));
    settle(c,"resume","error");
  }else bad(c,"sent an unknown event ("+String(o.event).slice(0,40)+")");
}
function onExit(c,code,sig){
  if(c.__cdbExited)return;
  c.__cdbExited=!0;
  if(c.__cdbExitR)c.__cdbExitR();
  if(c.__cdbReadyR)c.__cdbReadyR("exit");
  S.kids=S.kids.filter(function(k){return k!==c});
  if(c.__cdbTimers)c.__cdbTimers.forEach(clearTimeout);
  settle(c,"suspend","exit");settle(c,"resume","exit");
  var why=(sig?"signal "+sig:"exit "+code)+(c.__cdbLastError?": "+c.__cdbLastError:code!==0&&c.__cdbErr.trim()?": "+c.__cdbErr.trim().split("\n").pop().slice(0,200):"");
  S.lastExit={code:code,signal:sig||null};
  // Killed by a signal (ours or anyone's): its binding may be left behind.
  var abnormal=!!sig||c.__cdbKilled===!0;
  if(abnormal)S.stale={bridge:c.__cdbBridge,bin:c.__cdbBin,why:"the last watcher ended abnormally: "+why};
  var current=S.child===c;
  if(current){S.child=null;S.ready=null;S.muted=!1}
  if(c.__cdbBad){if(abnormal&&!S.armed)cleanup();return}
  if(!current||c.__cdbStopping||!S.armed||c.__cdbGen!==S.gen){
    diag((current?"watcher":"previous watcher")+" stopped ("+why+")");
    if(abnormal&&!S.armed)cleanup();
    return;
  }
  // Ended inside an open suspend window: the KDE watcher's own 5 s limit, by
  // design for a long model Escape. Not a failure; it is started again once
  // the injection has returned (the window's finally), never during it.
  if(S.window&&S.window.c===c){
    S.window.exited=!0;
    diag("watcher ended inside a suspend window ("+why+"), as designed for a long model Escape; armed again after the injection");
    return;
  }
  // Ended on its own while armed: every such end counts as a failure, except
  // an arming failure next to a previous watcher of ours that was still
  // stopping (the shared holder lock was busy): that one is retried at the
  // next action instead.
  S.armed=!1;
  if(code===2&&c.__cdbOverlap){S.parked=S.lockHeld;diag("arming failed while a previous watcher was still stopping ("+why+"); not counted, tried again at the next action");return}
  // A refusal the bridge explains (an `error` line before exit 2: Escape is
  // already a KDE shortcut, a sway binding, no kglobalaccel) is a stable,
  // explained state, not a fault: never counted towards the breaker (the user
  // can free the key; the next arm tries again), and logged once per reason.
  if(code===2&&c.__cdbLastError){
    if(!S.reasons[c.__cdbLastError]){S.reasons[c.__cdbLastError]=1;diag("arming failed ("+why+"); not counted, tried again at the next arm - Computer Use keeps working")}
    fallback("arming failed");
    return;
  }
  failed();
  if(code===2){diag("arming failed ("+why+"); no retry until the next arm - Computer Use keeps working");fallback("arming failed");return}
  if(code===0){diag("watcher ended while armed ("+why+"); not restarted - Computer Use keeps working");fallback("the watcher ended");return}
  if(!S.respawned&&!S.dead){
    S.respawned=!0;S.armed=!0;
    // The re-spawn arms as first holder, which heals a stale binding itself.
    S.stale=null;
    var g=c.__cdbGen;
    diag("watcher failed ("+why+"); restarting it once in "+RESPAWN_MS+" ms");
    var t=setTimeout(function(){prevStopped().then(function(){spawn(g)})},RESPAWN_MS);if(t&&t.unref)t.unref();
    return;
  }
  diag("watcher failed again ("+why+"); giving up for this arm - Computer Use keeps working");
  if(abnormal)cleanup();
  fallback("the watcher failed twice");
}
function stop(c,quitting){
  if(!c||c.__cdbExited)return;
  if(quitting){try{c.stdin&&c.stdin.end()}catch(e){}try{c.kill("SIGTERM")}catch(e){}return}
  if(c.__cdbStopping)return;
  c.__cdbStopping=!0;
  try{c.stdin&&c.stdin.end()}catch(e){}
  c.__cdbTimers=c.__cdbTimers||[];
  var t1=setTimeout(function(){
    if(c.__cdbExited)return;
    diag("watcher still running "+GRACE_MS+" ms after stdin closed; SIGTERM");
    try{c.kill("SIGTERM")}catch(e){}
    var t2=setTimeout(function(){if(!c.__cdbExited){diag("watcher ignored SIGTERM for "+KILL_MS+" ms; SIGKILL (its binding is cleaned up next)");c.__cdbKilled=!0;try{c.kill("SIGKILL")}catch(e){}}},KILL_MS);
    if(t2.unref)t2.unref();
    c.__cdbTimers.push(t2);
  },GRACE_MS);
  if(t1.unref)t1.unref();
  c.__cdbTimers.push(t1);
}

// Write one control line and wait for its ack. Resolves "ack", "error"
// (resume only), "exit", "timeout" or "write".
function send(c,cmd,ms){
  return new Promise(function(resolve){
    if(!c||c.__cdbExited||!c.stdin||c.stdin.destroyed){resolve("exit");return}
    var t=setTimeout(function(){settle(c,cmd,"timeout")},ms);
    c.__cdbWaits[cmd]=function(how){clearTimeout(t);resolve(how)};
    try{c.stdin.write(cmd+"\n")}catch(e){settle(c,cmd,"write")}
  });
}
// The live watcher when a model Escape needs a suspend window, else null.
function needs(){var c=S.child,r=S.ready;return S.armed&&c&&!c.__cdbExited&&!c.__cdbStopping&&r&&r.syntheticSafe===!1?c:null}
// expectMs (optional): how long the injection is expected to take (a hold, a
// long typed text). The KDE watcher ends itself after 5 s suspended; a window
// expected to take longer than SUSPEND_LIMIT_MS stops the watcher before the
// injection (orderly, bounded wait) and starts it again after, instead.
var SUSPEND_LIMIT_MS=4000;
// A watcher spawned but not ready yet (the 100-300 ms while it arms) may
// already hold its grab: wait for its ready line (bounded) before deciding
// whether a window is needed.
var READY_WAIT_MS=1500;
function arming(){var c=S.child;return S.armed&&c&&!c.__cdbExited&&!c.__cdbStopping&&!S.ready?c:null}
function waitReady(c){
  var t;
  return Promise.race([c.__cdbReadyP,new Promise(function(r){t=setTimeout(function(){r("timeout")},READY_WAIT_MS);if(t.unref)t.unref()})]).then(function(how){
    clearTimeout(t);
    if(how==="timeout")diag("a model Escape waited "+READY_WAIT_MS+" ms for the arming watcher's ready line; injecting without a suspend window");
  });
}
function suspendAround(fn,expectMs){
  var pending=arming();
  if(!pending&&!needs())return fn();
  var run=S.tail.then(function(){return pending?waitReady(pending):null}).then(function(){return suspendWindow(fn,expectMs)});
  S.tail=run.then(function(){},function(){});
  return run;
}
// After a window whose watcher ended (or was stopped for it): the same arm
// cycle starts a fresh watcher, once the old one has exited.
function rearm(g){
  if(!S.armed||g!==S.gen||S.child||S.dead)return;
  prevStopped().then(function(){if(!S.child)spawn(g)});
}
async function suspendWindow(fn,expectMs){
  var c=needs();
  if(!c)return fn();
  var g=S.gen;
  if(expectMs>SUSPEND_LIMIT_MS){
    diag("long model Escape (about "+Math.round(expectMs/1000)+" s, over the watcher's 5 s suspend limit): watcher stopped for it, armed again after");
    S.window={c:c,stopped:!0};
    stop(c,!1);
    await Promise.race([c.__cdbExitP,new Promise(function(r){var t=setTimeout(r,PREV_WAIT_MS);if(t.unref)t.unref()})]);
    try{return await fn()}
    finally{S.window=null;rearm(g)}
  }
  diag("suspend: a model-injected Escape ("+S.ready.mechanism+")");
  S.window={c:c};
  var a=await send(c,"suspend",SUSPEND_ACK_MS);
  if(a!=="ack"){S.muted=!1;diag("suspend not acknowledged ("+a+"); injecting anyway")}
  try{return await fn()}
  finally{
    var w=S.window;S.window=null;
    if(S.child===c&&!c.__cdbExited){
      S.muted=!1;
      var r=await send(c,"resume",RESUME_ACK_MS);
      if(r!=="ack")diag("resume not acknowledged ("+r+")"+(r==="error"?"; the watcher restarts":""));
    }else{
      S.muted=!1;
      if(w&&w.exited)rearm(g);
    }
  }
}
// The switch was set (cdb-cu-esc:set in js/extra_settings_main.js): a fresh
// start for the breaker and the once-per-reason log.
function reset(){
  if(S.failures||S.dead)diag("switch set: the watcher's failure count ("+S.failures+(S.dead?", given up":"")+") starts over");
  S.failures=0;S.dead=!1;S.reasons={};
}
function state(){
  var r=S.ready,c=S.child;
  return Object.freeze({fallen:S.fallen,holder:S.holder,window:!!S.window,lockHeld:S.lockHeld,parked:S.parked,failures:S.failures,dead:S.dead,armed:S.armed,running:!!(c&&!c.__cdbExited),pid:c?c.pid:null,bridge:S.bridge,mechanism:r?r.mechanism:null,syntheticSafe:r?r.syntheticSafe:null,suspended:S.muted,respawned:S.respawned,spawns:S.spawns,lastExit:S.lastExit,cleanupPending:!!S.stale,cleanups:S.cleanups});
}
// Does a CU key spec (`ctrl+Escape`, `escape`, a sequence) or typed text carry
// an Escape? Names as the bridges' key maps take them (escape / esc, any
// case), plus the ESC control character.
function hasEscape(v){
  if(Array.isArray(v)){for(var i=0;i<v.length;i++){if(hasEscape(v[i]))return!0}return!1}
  if(typeof v!=="string"||!v)return!1;
  if(v.indexOf("\x1b")>=0)return!0;
  var t=v.toLowerCase().split(/[\s+]+/);
  for(var j=0;j<t.length;j++){if(t[j]==="escape"||t[j]==="esc")return!0}
  return!1;
}
// Heal once at app start, switch on only: a watcher SIGKILLed with the whole
// app (systemd-oomd, a scope stop) left its binding with no later arm to clean
// it. HEAL_DELAY_MS after ready, async, for the host session's bridge only and
// only when it passes the runnable check; skipped when a lock armed a watcher
// meanwhile (arming as first holder heals the same way).
var HEAL_DELAY_MS=4000;
function heal(){
  if(!enabled()||S.dead||S.armed||S.child||S.stale||S.cleaning)return;
  var sel=select(process.env);if(!sel.bridge)return;
  var bin=resolveBin(sel.bridge);if(!bin)return;
  runnable(sel.bridge,bin).then(function(ok){
    if(!ok||S.armed||S.child||S.stale||S.cleaning)return;
    S.stale={bridge:sel.bridge,bin:bin,why:"app start: a binding a killed earlier run may have left"};
    cleanup();
  },function(){});
}
// Module load adds one `ready` listener and nothing else: the heal timer is
// set only when the switch is on at that moment.
try{
  var _app=require("electron").app;
  var _armHeal=function(){if(!enabled())return;var t=setTimeout(heal,HEAL_DELAY_MS);if(t&&t.unref)t.unref()};
  if(_app&&typeof _app.isReady==="function"&&_app.isReady())_armHeal();
  else if(_app&&typeof _app.once==="function")_app.once("ready",_armHeal);
}catch(qe){}
globalThis.__cdbCuEscWatch=Object.freeze({reset:reset,arm:arm,disarm:disarm,taskEnded:taskEnded,toolCall:toolCall,suspendAround:suspendAround,state:state,hasEscape:hasEscape,select:select});
})();

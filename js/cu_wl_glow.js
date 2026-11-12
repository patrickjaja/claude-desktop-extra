(function(){
// ── Computer Use glow on Wayland: the bridge's layer-shell overlay ──────────
// Embedded by patches/linux/fix_computer_use_linux.nim (Patch 1, after the
// executors), Linux only. Upstream draws "Claude is using your computer" (the
// pulsing glow; with GrowthBook flag 1916550538 a thin rim plus a drawn arrow)
// in an Electron overlay window, and never creates that window on a Wayland
// session (its CLICK_THROUGH_WINDOWS constant is !isWayland()). Sub-patches
// 10e-10g hand upstream's glow show / hide / display change to this module
// first; 10h exposes upstream's glide planner (the arc, tilt and lift frames
// its drawn arrow animates) as globalThis.__cdbCuGlidePlan.
//
// Who draws it, per row (the executor's __wlGlowRow decides: js/cu_linux_executor.js,
// or js/executor_linux.js in kwin mode):
//   wlroots Wayland (sway, Hyprland, niri)  wlroots-bridge overlay
//   GNOME Wayland                           gnome-portal-bridge overlay (none
//                                           announces it yet: no glow there)
//   XWayland on either of them              the compositor's row (same bridge)
//   KDE Plasma 6.6+ (kwin mode)             kwin-portal-bridge overlay, when its
//                                           doctor announces capabilities.overlay
//                                           AND session_overlay_opt_out (its
//                                           session daemon then starts no glow
//                                           of its own); otherwise the bridge's
//                                           own session glow (overlay:false
//                                           here, upstream's show stays off
//                                           through the executor's
//                                           __cdbCuGlowOff, sub-patch 10c)
//   KDE < 6.6, exotic Wayland, X11,         nothing (show() answers false, so
//   background display                      upstream's own path runs: on X11
//                                           its Electron glow, on Wayland none)
// A row only gets the overlay when its bridge's `doctor` announces
// capabilities.overlay: true (the executor's cached async doctor; no new
// blocking call). Until then nothing here starts. In kwin mode the decision
// is taken once per lock before its session-start; until it lands, row()
// answers overlay:null and show() waits on __wlGlowProbe().
//
// Lifecycle: `<bridge> overlay` is spawned on the first show inside a
// Computer Use lock, never before. Its stdin takes JSON lines, written
// fire-and-forget (errors swallowed); its stdout is parsed line by line. A
// child that dies while the glow should show is re-spawned once per lock;
// a second failure (or exit 2, "cannot run here") turns the glow off until
// the lock is released, with one "[claude-cu] wl-glow:" line. Hide and lock
// release send `hide`, close stdin (the overlay exits 0 on EOF), SIGTERM after
// 1 s, SIGKILL 1 s after that. The child gets CLAUDE_CU_PARENT_PID. Nothing
// here ever blocks or delays an input action or an enumeration: no sync exec,
// nothing awaits the child.
//
// Coordinates: the overlay takes global logical compositor coordinates. On
// the Wayland rows the executor sends the very numbers it receives (Electron
// DIP) to the bridge's pointer commands (_moveMouse, pointer-click, ...), and
// matches Electron display bounds to the bridge's `screens` geometry 1:1
// (_gnomeSharedDefaultDisplayId, _wlMonForRegion; kwin mode:
// electronDisplayForRustScreen): the same identity mapping is used here, so
// the arrow lands where the real pointer lands. Upstream's
// display (its glow getter) is mapped to an output name by its bounds against
// the overlay's own `ready.outputs`.
//
// globalThis.__cdbCuWlGlow.pointer() is the drawn pointer of an overlay row:
// the same methods and return contracts as globalThis.__cdbCuDrawnPointer
// (sub-patch 10d), so the executor's call sites stay the same. The real
// pointer is never hidden; Wayland cannot query it, so the "real pointer" is
// the last point the executor moved it to.
//
// Protocol v1 (cu-overlay crate), kept in this file only:
//   stdin   {"cmd":"show","output","look":"glow"|"rim","badge","badgeText","reducedMotion","arrow":{x,y}|null}
//           {"cmd":"move","output"} {"cmd":"glide","frames":[[x,y,deg,lift],...],"frameMs"}
//           {"cmd":"jump","x","y"} {"cmd":"press","x","y"} {"cmd":"look","look"}
//           {"cmd":"hide"} {"cmd":"capture","phase":"hide"|"restore","id","scope":"all"|"cursor"}
//   stdout  {"event":"ready","protocol":1,"backend","alphaModifier","fractionalScale","badge":true|false,"captureScopes":["all","cursor"],"outputs":[{name,x,y,width,height,scale}]}
//           {"event":"outputs","outputs":[...]} (layout changed; the output map is
//           kept from ready + outputs only, never queried separately)
//           {"event":"shown","output","scale"} {"event":"hidden"} {"event":"ack","id"}
//           {"event":"error","message","fatal"}
// `show` naming an unknown output is fatal (exit 2, counted as a failure
// here), `move` to one is not (the overlay stays). Exit 0 = stdin EOF / parent death, 2 = cannot run here (no display,
// no layer-shell, unknown output), 1 = lost connection.
// Badge ("Claude is using your computer" pill: flashes in the centre, slides
// to the top-right corner over 6 s, ends invisible; never under reduced
// motion). An overlay that draws it reports `ready.badge: true`; against one
// that reports false or nothing, `show` carries `badge` as upstream passed it
// and nothing else changes. Upstream's glow page flashes it on every show that
// asks for it (showBadge, default true; only watch-record, outside a lock,
// asks for none), and the lock handler shows once per lock acquire, so: the
// run's first `show` (each upstream show call, in fact) carries badge:true,
// and every `show` this module sends for its own reasons (the re-show after a
// respawn or after the compositor took the surfaces away) carries none -
// the overlay restarts the flash at a badge:true show and clears it at a show
// without, so the badge is neither repeated nor cut short on a path of ours.
// `move`, `look`, `glide`, `jump` and `press` leave it alone.
// Captures: the drawn arrow and press ring are kept out of the screenshots
// Claude receives (captureCursor / captureRestore, called by
// js/cu_linux_executor.js around each bridge capture): `capture` with scope
// "cursor", only when `ready.captureScopes` lists it. A scope-less hide is
// never sent (it would blank the rim at every screenshot); the rim stays up.
// While the badge is still up (6 s after the show that started it) the hide
// uses scope "all" instead, since "cursor" leaves the badge in the picture
// (it is centred then and could cover what Claude looks at); in that window
// the rim blanks for the capture too.
// kwin mode never calls them: kwin-portal-bridge sets KWin's excludeFromCapture
// on the overlay's surfaces, so none of it is ever in a screenshot.
var _cp=require("child_process"),_el=require("electron");
var PROTOCOL=1,BADGE_MS=6500,READY_MS=3000,TERM_MS=1000,KILL_MS=1000,ERR_TAIL=300;
var st={trace:!1,held:!1,want:null,dfn:null,child:null,ready:!1,outputs:[],shown:!1,out:null,geo:null,respawns:0,off:!1,reshown:0,arrow:null,glide:null,arriveAt:0,real:null,readySaid:!1,noMatchSaid:!1,capId:0,scopeCursor:!1,badgeOk:!1,badgePending:!1,badgeAt:0,acks:{}};
function traceOn(){try{return process.env.CDB_CU_DEBUG==="1"}catch(e){return !1}}
function diag(m){try{(globalThis.__cdbDiag||function(){})("[claude-cu] wl-glow: "+m)}catch(e){}}
function now(){return typeof performance!=="undefined"&&performance.now?performance.now():Date.now()}
function msg(e){return String(e&&e.message||e)}
function num(v){return typeof v==="number"&&isFinite(v)}
// The executor's input space (identity on every Wayland row, see above).
function pt(p){return p&&num(+p.x)&&num(+p.y)?{x:+p.x,y:+p.y}:null}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
function inside(g,p){return !!(g&&p)&&p.x>=g.x&&p.x<g.x+g.width&&p.y>=g.y&&p.y<g.y+g.height}
function r2(v){return Math.round((+v||0)*100)/100}
// Upstream's own reduced-motion check (systemPreferences, as its glide does).
function reducedMotion(){try{return _el.systemPreferences.getAnimationSettings().prefersReducedMotion===!0}catch(e){return !1}}
function host(){var ex=globalThis.__linuxExecutor;return ex&&typeof ex.__wlGlowRow==="function"?ex:null}
// {name, bin, overlay: true|false|null} for an overlay row, else null.
function row(){
  if(process.platform!=="linux")return null;
  var h=host();if(!h)return null;
  try{var r=h.__wlGlowRow();return r&&typeof r.bin==="string"&&r.bin?r:null}catch(e){return null}
}
function probe(){
  var h=host();if(!h||typeof h.__wlGlowProbe!=="function")return Promise.resolve(null);
  try{return Promise.resolve(h.__wlGlowProbe()).then(null,function(){return null})}catch(e){return Promise.resolve(null)}
}
// Settings -> Extra -> Cowork (Linux) -> Computer Use: the glow switch, and a
// background display (the glow would frame the user's monitor, not Claude's).
function glowOff(){try{var f=globalThis.__cdbCuGlowOff;return typeof f==="function"&&f()===!0}catch(e){return !0}}
function display(){try{var d=typeof st.dfn==="function"?st.dfn():null;return d&&d.bounds?d:null}catch(e){return null}}
function outputFor(b){
  var o=st.outputs,i,c;
  if(!b||!o.length)return null;
  for(i=0;i<o.length;i++){c=o[i];if(c.x===b.x&&c.y===b.y&&c.width===b.width&&c.height===b.height)return c}
  for(i=0;i<o.length;i++){c=o[i];if(c.x===b.x&&c.y===b.y)return c}
  var m={x:b.x+b.width/2,y:b.y+b.height/2};
  for(i=0;i<o.length;i++){if(inside(o[i],m))return o[i]}
  return null;
}
function outputsOf(m){return(Array.isArray(m.outputs)?m.outputs:[]).filter(function(o){return o&&typeof o.name==="string"&&num(o.x)&&num(o.y)&&num(o.width)&&num(o.height)})}
function alive(c){return !!c&&!c.__done&&c.exitCode==null&&c.signalCode==null}
function write(c,obj){
  if(st.trace)trace("send "+traceCmd(obj));
  try{if(c&&c.stdin&&!c.stdin.destroyed&&c.stdin.writable!==!1)c.stdin.write(JSON.stringify(obj)+"\n")}catch(e){}
}
// CDB_CU_DEBUG=1 (the Computer Use debug switch, read at every lock acquire):
// one "[claude-cu] wl-glow trace:" line per overlay command and per real
// pointer command the executor sends on an overlay row, both stamped with the
// same monotonic clock (performance.now(), ms), so a log shows that the arrow
// glided to a target before the real pointer moved there. Off: one boolean
// check per command.
function trace(m){diag("trace: t="+now().toFixed(1)+" "+m)}
function traceCmd(o){
  if(o.cmd==="glide"){var f=o.frames,l=f[f.length-1]||[];return"glide frames="+f.length+" arrive="+Math.round(st.arriveAt-st.glide.at)+" to="+l[0]+","+l[1]}
  if(o.cmd==="show")return"show output="+o.output+" look="+o.look+(o.arrow?" arrow="+o.arrow.x+","+o.arrow.y:"")+(st.badgeOk&&o.badge?" badge":"");
  if(o.cmd==="move")return"move output="+o.output;
  if(o.cmd==="jump"||o.cmd==="press")return o.cmd+" "+o.x+","+o.y;
  if(o.cmd==="capture")return"capture "+o.phase+" id="+o.id+(o.scope?" scope="+o.scope:"");
  return o.cmd;
}
function send(obj){if(st.child&&st.ready)write(st.child,obj)}
function endGlide(){st.glide=null;st.arriveAt=0}
function spawnChild(r){
  var c;
  try{
    var env=Object.assign({},process.env,{CLAUDE_CU_PARENT_PID:String(process.pid)});
    // DIRECT child of the app's main process (no shell, no wrapper, no
    // utility process): the bridges' screenshot mask looks through this
    // overlay's layer only when its surface's pid is the screenshot bridge's
    // parent (this process) or a direct child of it; anything else fails
    // closed and masked screenshots go dark under the overlay.
    c=_cp.spawn(r.bin,["overlay"],{stdio:["pipe","pipe","pipe"],env:env});
  }catch(e){fail(r.name,"could not start ("+msg(e)+")");return}
  st.child=c;st.ready=!1;st.shown=!1;st.out=null;st.geo=null;st.badgeOk=!1;st.badgeAt=0;endGlide();
  c.__name=r.name;c.__buf="";c.__err="";
  try{if(c.stdin&&typeof c.stdin.on==="function")c.stdin.on("error",function(){})}catch(e){}
  try{
    c.stdout.on("data",function(d){
      if(c!==st.child)return;
      c.__buf+=String(d);
      var i;
      while((i=c.__buf.indexOf("\n"))>=0){var line=c.__buf.slice(0,i);c.__buf=c.__buf.slice(i+1);if(line.trim())onLine(c,line)}
      if(c.__buf.length>262144)c.__buf="";
    });
    if(c.stderr)c.stderr.on("data",function(d){c.__err=(c.__err+String(d)).slice(-ERR_TAIL)});
  }catch(e){}
  c.on("error",function(e){gone(c,null,null,msg(e))});
  // "close", not "exit": every stdout line (a fatal error's message) is read first.
  c.on("close",function(code,sig){gone(c,code,sig,null)});
  c.__rt=setTimeout(function(){if(c===st.child&&!st.ready){c.__why="no ready line within "+READY_MS/1000+" s";try{c.kill("SIGKILL")}catch(e){}}},READY_MS);
  if(c.__rt&&c.__rt.unref)c.__rt.unref();
}
function onLine(c,line){
  var m;try{m=JSON.parse(line)}catch(e){return}
  if(!m||typeof m!=="object")return;
  if(m.event==="ready"){
    if(m.protocol!==PROTOCOL){c.__why="protocol "+m.protocol+", expected "+PROTOCOL;try{c.kill("SIGKILL")}catch(e){}return}
    clearTimeout(c.__rt);
    st.ready=!0;
    st.outputs=outputsOf(m);
    st.scopeCursor=Array.isArray(m.captureScopes)&&m.captureScopes.indexOf("cursor")>=0;
    st.badgeOk=m.badge===!0;
    if(!st.readySaid){st.readySaid=!0;diag(c.__name+" overlay ready ("+String(m.backend||"?")+", "+st.outputs.length+" output"+(st.outputs.length===1?"":"s")+")")}
    if(st.want)sendShow();
  }else if(m.event==="outputs"){
    // The layout changed (hotplug, mode, scale): the map follows it, and a
    // shown glow follows its display onto the output that holds it now.
    st.outputs=outputsOf(m);
    if(st.want&&st.ready&&st.child)followDisplay();
  }else if(m.event==="shown"){
    st.shown=!0;if(typeof m.output==="string")st.out=m.output;
  }else if(m.event==="hidden"){
    // The compositor took the surfaces away (an unplugged output): show it
    // once more, on whatever output the display maps to now.
    var was=st.shown;st.shown=!1;st.badgeAt=0;endGlide();
    if(was&&st.want&&st.held&&!st.off&&st.reshown<1){st.reshown++;st.out=null;sendShow()}
  }else if(m.event==="ack"){
    var f=c===st.child&&st.acks[m.id];if(typeof f==="function")f();
  }else if(m.event==="error"){
    if(m.fatal===!0)c.__fatal=String(m.message||"fatal error");
  }
}
function gone(c,code,sig,err){
  if(c.__done)return;
  c.__done=!0;clearTimeout(c.__rt);clearTimeout(c.__t1);clearTimeout(c.__t2);
  if(c!==st.child)return;
  st.child=null;st.ready=!1;st.shown=!1;st.out=null;st.badgeOk=!1;st.badgeAt=0;endGlide();
  if(!st.held||!st.want||st.off)return;
  var why=c.__fatal||c.__why||err||(code!=null?"exit "+code:"signal "+sig);
  var tail=String(c.__err||"").trim().split("\n").pop();
  if(tail&&why.indexOf(tail)<0)why+=": "+tail;
  if(code===2||st.respawns>=1){fail(c.__name,why);return}
  st.respawns++;
  var r=row();
  if(r&&r.overlay===!0)spawnChild(r);
}
function fail(name,why){
  st.off=!0;
  diag((name||"bridge")+" overlay failed ("+why+") - no glow until Computer Use is released; Computer Use itself is not affected");
}
function sendShow(){
  var w=st.want;if(!w||!st.child||!st.ready)return;
  var d=display(),o=outputFor(d&&d.bounds);
  if(!o){
    if(!st.noMatchSaid){st.noMatchSaid=!0;diag("no compositor output matches Claude's display"+(d?" "+JSON.stringify(d.bounds):"")+" (outputs: "+st.outputs.map(function(x){return x.name+" "+x.x+","+x.y+" "+x.width+"x"+x.height}).join(", ")+") - no glow")}
    return;
  }
  st.geo={x:o.x,y:o.y,width:o.width,height:o.height};
  st.arrow=w.look==="rim"&&inside(st.geo,st.real)?{x:st.real.x,y:st.real.y}:null;
  endGlide();
  st.out=o.name;
  // An overlay that draws the badge gets badge:true once per upstream show
  // (never under reduced motion); a show of ours without it clears a running
  // flash, which only follows surfaces the compositor took away anyway.
  var bd=w.badge;
  if(st.badgeOk){
    bd=w.badge&&!w.rm&&st.badgePending;
    st.badgePending=!1;st.badgeAt=bd?now():0;
  }
  send({cmd:"show",output:o.name,look:w.look,badge:bd,reducedMotion:w.rm,arrow:st.arrow});
}
// Hide + stdin EOF; SIGTERM after TERM_MS, SIGKILL KILL_MS later.
function stop(){
  var c=st.child;
  st.child=null;st.ready=!1;st.shown=!1;st.out=null;st.geo=null;st.arrow=null;st.badgeOk=!1;st.badgeAt=0;endGlide();
  if(!c)return;
  c.__ours=!0;
  write(c,{cmd:"hide"});
  try{c.stdin.end()}catch(e){}
  c.__t1=setTimeout(function(){
    if(!alive(c))return;
    try{c.kill("SIGTERM")}catch(e){}
    c.__t2=setTimeout(function(){if(alive(c)){try{c.kill("SIGKILL")}catch(e){}}},KILL_MS);
    if(c.__t2&&c.__t2.unref)c.__t2.unref();
  },TERM_MS);
  if(c.__t1&&c.__t1.unref)c.__t1.unref();
}
// `move` to the output that holds upstream's display now. A `move` the
// overlay cannot follow (an output gone meanwhile) is a non-fatal error there:
// it stays where it is.
function followDisplay(){
  var d=display(),o=outputFor(d&&d.bounds);
  if(!o)return;
  st.geo={x:o.x,y:o.y,width:o.width,height:o.height};
  if(o.name===st.out)return;
  st.out=o.name;endGlide();
  if(st.arrow&&!inside(st.geo,st.arrow))st.arrow=null;
  send({cmd:"move",output:o.name});
}
function live(){return !!(st.child&&st.ready&&st.shown&&st.want&&st.want.look==="rim"&&!st.off)}
function remaining(){return Math.max(0,st.arriveAt-now())}
// Upstream's interpolated arrow position during a glide (its kQa).
function current(){
  var g=st.glide;if(!g)return st.arrow;
  var e=(now()-g.at)/g.fm,t=g.frames[Math.floor(e)],n=g.frames[Math.floor(e)+1];
  if(!t||!n)return st.arrow;
  var r=e%1;return{x:t.x+(n.x-t.x)*r,y:t.y+(n.y-t.y)*r};
}
function frameMs(){try{var G=globalThis.__cdbCuGlidePlan,f=G&&(typeof G.frameMs==="function"?G.frameMs():G.frameMs);return num(f)&&f>0?f:16}catch(e){return 16}}
// Arrow commands only for points on the shown output: a subsurface placed
// outside its layer surface is drawn by wlroots on whatever output lies
// there, away from the rim (cu-overlay does not clip it). The state still
// follows, so the next glide starts from the true position.
function jump(to){st.arrow=to;endGlide();st.arriveAt=now();if(inside(st.geo,to))send({cmd:"jump",x:r2(to.x),y:r2(to.y)})}
// Same methods and return values as upstream's drawn pointer (10d).
var pointer={
  live:live,
  glideTo:function(p){
    if(!live())return 0;
    var to=pt(p);if(!to)return 0;
    if(st.arrow&&dist(st.arrow,to)<.5)return remaining();
    var G=globalThis.__cdbCuGlidePlan,plan=null,from=current();
    if(from&&!reducedMotion()&&inside(st.geo,to)&&inside(st.geo,from)&&G&&typeof G.plan==="function"){try{plan=G.plan(from,to)}catch(e){plan=null}}
    if(!plan||!Array.isArray(plan.frames)||plan.frames.length<2||!(plan.durationMs>0)){jump(to);return 0}
    var fm=frameMs(),arrive=num(plan.arriveMs)?Math.max(0,plan.arriveMs):0;
    st.glide={frames:plan.frames,at:now(),fm:fm};st.arriveAt=st.glide.at+arrive;st.arrow=to;
    send({cmd:"glide",frames:plan.frames.map(function(f){return[r2(f.x),r2(f.y),r2(f.deg),r2(f.lift)]}),frameMs:fm});
    return arrive;
  },
  jumpTo:function(p){if(!live())return;var to=pt(p);if(to)jump(to)},
  press:function(){
    if(!live())return;
    var r=st.real||st.arrow;if(!r)return;
    if(!st.arrow||dist(st.arrow,r)>2||remaining()>0){st.arrow={x:r.x,y:r.y};endGlide();st.arriveAt=now()}
    if(inside(st.geo,r))send({cmd:"press",x:r2(r.x),y:r2(r.y)});
  },
  realPointerGoesTo:function(p){var q=pt(p);if(q)st.real=q}
};
globalThis.__cdbCuWlGlow={
  // Sub-patch 10e, first in upstream's glow show: true = this module owns the
  // glow for this call (an overlay row inside a lock), upstream's body is
  // skipped (on Wayland it would draw nothing anyway). false = upstream's own
  // path runs unchanged. opts: upstream's {showBadge, claudeHasThePointer};
  // dfn: upstream's glow display getter; flagFn: its drawn-cursor flag
  // decision (1916550538), read exactly as upstream's show reads it.
  show:function(opts,dfn,flagFn){
    var r=row();
    if(!r||r.overlay===!1||!st.held)return !1;
    st.dfn=typeof dfn==="function"?dfn:null;
    if(glowOff()){st.want=null;stop();return !0}
    var has=opts==null||opts.claudeHasThePointer==null?!0:opts.claudeHasThePointer,rim=!1;
    try{rim=!!has&&typeof flagFn==="function"&&flagFn()===!0}catch(e){rim=!1}
    st.want={look:rim?"rim":"glow",badge:opts==null||opts.showBadge==null?!0:!!opts.showBadge,rm:reducedMotion()};
    st.badgePending=st.want.badge;
    if(st.off)return !0;
    if(r.overlay===!0){if(!st.child)spawnChild(r);else sendShow();return !0}
    // Not known yet: ask the bridge (cached async doctor) and start on a yes.
    probe().then(function(ok){
      if(ok!==!0||!st.held||!st.want||st.off||st.child)return;
      var rr=row();if(rr&&rr.overlay===!0)spawnChild(rr);
    });
    return !0;
  },
  // Sub-patch 10f, first in upstream's glow hide (upstream's body still runs).
  hide:function(){if(!st.want&&!st.child)return;st.want=null;stop()},
  // Sub-patch 10g, in upstream's glow display setter: follow a display switch.
  display:function(dfn){
    if(typeof dfn!=="function"||!row())return;
    st.dfn=dfn;
    if(!st.want||!st.child||!st.ready)return;
    followDisplay();
  },
  // The executor's __setLockHeld (both edges, before upstream's lock-change
  // event reaches its glow handler).
  lock:function(held){
    if(held)st.trace=traceOn();
    st.held=!!held;st.badgePending=!1;st.respawns=0;st.off=!1;st.reshown=0;st.noMatchSaid=!1;st.want=null;
    stop();
    if(held&&row())probe();
  },
  // The executor's drawn pointer on an overlay row (its _dpObj), else null.
  pointer:function(){var r=row();return r&&r.overlay!==!1?pointer:null},
  // A real pointer command the executor sends on an overlay row (trace only).
  input:function(args){if(st.trace&&st.child&&Array.isArray(args)){var a=function(k){var i=args.indexOf(k);return i>=0?args[i+1]:null};trace("input "+args[0]+(a("--x")!=null?" "+a("--x")+","+a("--y"):"")+(a("--to-x")!=null?" "+a("--from-x")+","+a("--from-y")+"->"+a("--to-x")+","+a("--to-y"):""))}},
  // Every real pointer move of the executor on a Wayland row.
  pointerAt:function(x,y){var q=pt({x:x,y:y});if(q)st.real=q},
  // Around a screenshot (the executor's _withCursorHidden): hide the arrow and
  // the press ring, wait for the overlay's ack (the compositor processed it)
  // at most boundMs, then resolve a token for captureRestore - also when no
  // ack comes (the capture is never held up beyond the bound). null at once
  // when there is nothing to hide: no overlay shown, the classic glow look
  // (no arrow), no arrow placed yet, an overlay without the "cursor" scope.
  // While the badge is up the hide is scope "all" (everything, the badge
  // included) whatever the look, since "cursor" would leave the pill in the
  // picture; after its 6 s it is the cursor hide again.
  captureCursor:function(boundMs){
    if(!st.child||!st.ready||!st.shown||st.off||!st.want)return null;
    var all=st.badgeAt>0&&now()-st.badgeAt<BADGE_MS;
    if(!all&&(st.want.look!=="rim"||!st.arrow||!st.scopeCursor))return null;
    var c=st.child,id=++st.capId,t0=now();
    write(c,{cmd:"capture",phase:"hide",id:id,scope:all?"all":"cursor"});
    return new Promise(function(res){
      var done=!1,tm=setTimeout(function(){fin("none within "+boundMs+" ms")},boundMs);
      st.acks[id]=function(){fin("ack")};
      function fin(why){
        if(done)return;done=!0;clearTimeout(tm);delete st.acks[id];
        if(st.trace)trace("capture hide id="+id+" "+why+" after "+(now()-t0).toFixed(1)+" ms");
        res({id:id,child:c});
      }
    });
  },
  // The restore for a captureCursor token; nothing when that overlay is gone
  // (a re-spawned one never hid anything; the overlay itself also restores
  // after 3 s).
  captureRestore:function(tok){
    if(!tok||!tok.child||tok.child!==st.child||!alive(tok.child))return;
    write(tok.child,{cmd:"capture",phase:"restore",id:++st.capId});
  },
  state:function(){return{held:st.held,running:!!st.child,ready:st.ready,shown:st.shown,look:st.want?st.want.look:null,output:st.out,off:st.off}}
};
})();

(function(){
// ── Computer Use: accessibility elements (AT-SPI) on Linux (issue #306) ──────
// Settings -> Extra -> Cowork (Linux) -> "Computer Use: read app controls
// (accessibility)", read through globalThis.__cdbCuAxElements() (undefined or
// anything but true = off). Adds four tools with upstream's macOS app-scoped
// names and argument shapes - app_list_windows, app_ax_find, app_click,
// app_type - served by the active Computer Use bridge's ax-* subcommands.
//
// Switch off = today's behavior: __cdbAxTools returns [] (tools/list
// unchanged), __cdbAxKey returns "" (tools/list cache key unchanged),
// __cdbAxHandles is false (calls go where they went before), and nothing is
// spawned - except restoring an accessibility switch WE turned on while the
// setting was on (state file below), which is cleanup.
//
// Wiring (patches/linux/fix_computer_use_linux.nim, sub-patches 15a-15d):
//   15a upstream's tool builder appends __cdbAxTools(caps)
//   15b the tools/list cache key appends __cdbAxKey()
//   15c app_ax_find / app_list_windows count as read-only (teach mode)
//   15d upstream's dispatch (kwin mode, where upstream dispatches) calls
//       __cdbAxCall(name, args, {sid, ctx, tier}) before its app_* branch
// Regular mode (x11 / wlroots / gnome / background display) dispatches in
// js/cu_handler_injection.js, which calls __cdbAxCall(name, input, {sid, pin,
// sync}) plus, with "Ask before Computer Use controls an app" on, the
// session's grants as {allowedApps, tier} (js/cu_consent.js axOpts). opts.ctx
// is upstream's dispatch context and only counts in kwin mode (kctx below):
// its lastScreenshot / onDisplayPinned frame is upstream's, never ours.
//
// Lifecycle of the desktop's accessibility switch (org.a11y.Status.IsEnabled):
// the first AX call runs `ax-enable --holder-pid <our pid>` once (the bridge
// leaves the switch alone while a screen reader runs). The bridges' crate keeps
// a lease per holder pid and turns the switch back off only when the last live
// holder leaves, so several profiles and crashed holders are handled there.
// userData/cdb-ax-state.json is our own "this app enabled it" marker. We leave
// (`ax-restore --holder-pid <our pid>`) when the Computer Use lock is
// released, on a task boundary of the lock's session, when the app quits, and
// at the next start when the marker survived a crash.
//
// Logs go to __cdbDiag as "[claude-cu][ax] ..." - never element names, values
// or typed text.
if(process.platform!=="linux"||globalThis.__cdbAxTools)return;
var _cp=require("child_process"),_fs=require("fs"),_path=require("path");
var TIER={app_list_windows:"read",app_ax_find:"read",app_click:"click",app_type:"full"};
var CAP=24*1024,STATE_FILE="cdb-ax-state.json";
function log(m){try{(globalThis.__cdbDiag||function(){})("[claude-cu][ax] "+m)}catch(e){}}
function on(){try{return typeof globalThis.__cdbCuAxElements==="function"&&globalThis.__cdbCuAxElements()===!0}catch(e){return!1}}

// ── tool definitions ─────────────────────────────────────────────────────────
function S(d){return{type:"string",description:d}}
function defs(){
  var app=S("The granted app name (WM_CLASS or desktop id).");
  var win=S("window_id from app_list_windows; default: the window last searched, else the active one.");
  var idx={type:"number",description:"[N] from this window's last app_ax_find."};
  var tgt={type:"string",enum:["focused"],description:"The element with keyboard focus, instead of element_index."};
  var live=" Acts on the live desktop (no background control).";
  return[
    {name:"app_list_windows",description:"List the windows of one application: [{window_id, title, is_main, is_minimized, bounds}] (bounds in desktop coordinates, not screenshot pixels).",inputSchema:{type:"object",properties:{app:app},required:["app"]}},
    {name:"app_ax_find",description:"List the controls of one application window from the desktop accessibility tree (AT-SPI), one per line: [N] AXButton (push button) \"name\" (states) at (x, y). (x, y) is the center in the last screenshot's coordinates (for left_click), or \"position unknown\" where the desktop reports none. Pass N as element_index to app_click / app_type; each call replaces the window's [N] list. Prefer this over a screenshot to find controls by name in GTK, Qt, Firefox and LibreOffice apps; Electron/Chromium apps usually expose nothing, use screenshots there.",inputSchema:{type:"object",properties:{app:app,window_id:win,role:S("AX or AT-SPI role, e.g. \"AXButton\", \"push button\", \"AXTextField\"."),title_contains:S("Case-insensitive substring of the name.")},required:["app"]}},
    {name:"app_click",description:"Press one element through accessibility (its press/activate/toggle action), by element_index or target: \"focused\". No coordinates: for a point use left_click. If the element has no action, the result gives its position for left_click."+live,inputSchema:{type:"object",properties:{app:app,window_id:win,element_index:idx,target:tgt},required:["app"]}},
    {name:"app_type",description:"Set the whole text of one TEXT field through accessibility (no key events), by element_index or target: \"focused\". Refused for non-text controls, and for a field that has text unless overwrite_existing is true. No coordinates; for key presses use key."+live,inputSchema:{type:"object",properties:{app:app,window_id:win,element_index:idx,target:tgt,text:{type:"string"},overwrite_existing:{type:"boolean",description:"Allow replacing the field's text."}},required:["app","text"]}}
  ];
}
// Upstream's builder calls this with its capabilities (t). The remote-devices
// bridge (cloud sessions linked to this computer) builds its computer_* list
// with the same builder and saveToDisk:false: our tools stay out of that list,
// since a cloud server is not known to accept tool names it did not bind.
globalThis.__cdbAxTools=function(t){if(!t||t.platform!=="linux"||t.saveToDisk===!1||!on())return[];return defs()};
globalThis.__cdbAxKey=function(){return on()?":cdb-ax":""};
globalThis.__cdbAxHandles=function(n){return typeof n==="string"&&Object.prototype.hasOwnProperty.call(TIER,n)&&on()};

// ── bridge ───────────────────────────────────────────────────────────────────
// The active Computer Use bridge: kwin-portal-bridge in kwin mode, else what
// the regular executor uses (its __axBridge also carries the background
// display's env overlay). The accessibility bus is per user session, so any
// of the four bridges reaches it.
function bridge(){
  // kwin mode: the executor's own resolution (executor_linux.js), PATH last.
  if(globalThis.__cuKwinMode){return{bin:process.env.KWIN_PORTAL_BRIDGE_BIN||globalThis.__cuKwinBridgeBin||"kwin-portal-bridge",name:"kwin-portal-bridge"}}
  var ex=globalThis.__linuxExecutor;
  try{return ex&&typeof ex.__axBridge==="function"?ex.__axBridge()||null:null}catch(e){return null}
}
// One JSON value on stdout; exit 1 + stderr on a runtime failure. stdin always
// gets closed - set-text writes the text there, never into argv (ps shows argv).
function run(br,args,text,ms){
  return new Promise(function(resolve,reject){
    var c;
    try{
      c=_cp.execFile(br.bin,args,{encoding:"utf8",timeout:ms||10000,maxBuffer:8*1024*1024,env:br.env||void 0},function(err,out,se){
        if(err){
          var why=typeof err.code==="number"?"exit "+err.code:err.killed?"timed out":String(err.code||err.message||err);
          var line=String(se||"").trim().split("\n").pop().slice(0,200);
          // A bridge that explains itself in JSON (unavailable/error) is
          // answered like exit 0; any other non-zero exit (2 = usage, e.g.
          // set-text stdin that is not UTF-8) becomes a clean tool error.
          var jo=null;try{jo=JSON.parse(String(out||"").trim())}catch(je){}
          if(jo&&typeof jo==="object"&&(jo.unavailable||jo.error)){resolve(jo);return}
          var e=new Error(br.name+" "+args[0]+" failed ("+why+")"+(line?": "+line:""));e.axWhy=why;reject(e);return;
        }
        var s=String(out||"").trim();
        if(!s){resolve(null);return}
        try{resolve(JSON.parse(s))}catch(pe){reject(new Error(br.name+" "+args[0]+" returned non-JSON output"))}
      });
    }catch(se){reject(se);return}
    if(c&&c.stdin){c.stdin.on("error",function(){});c.stdin.end(text==null?"":String(text))}
  });
}

// ── accessibility switch: enable once, restore on lock release/quit/start ────
function statePath(){try{return _path.join(require("electron").app.getPath("userData"),STATE_FILE)}catch(e){return null}}
function readState(){var p=statePath();if(!p)return null;try{var o=JSON.parse(_fs.readFileSync(p,"utf8"));return o&&typeof o.previous==="boolean"?{previous:o.previous,changed:o.changed===!0}:null}catch(e){return null}}
function writeState(s){var p=statePath();if(!p)return;try{_fs.writeFileSync(p,JSON.stringify({previous:s.previous,changed:s.changed,at:Date.now()}))}catch(e){log("state file not written ("+(e&&e.code||e)+")")}}
function dropState(){var p=statePath();if(p){try{_fs.unlinkSync(p)}catch(e){}}}
var _st=null;
// One serial queue for every AX tool call, enable and restore: a restore can
// never land between a call's enable and its bridge commands, and a call
// queued behind a restore enables again (_st is null by then).
var _q=Promise.resolve(),_pending=0;
function queue(fn){_pending++;var p=_q.then(fn,fn);_q=p.then(function(){_pending--},function(){_pending--});return p}
// Set by an enable that turned the switch on: Qt and Chromium apps register on
// the bus a moment later, so the next find retries an app_not_found once.
var _fresh=!1;
// Runs inside the queue only.
async function ensureEnabled(br){
  if(_st)return _st;
  var r=await run(br,["ax-enable","--holder-pid",String(process.pid)],null,8000);
  if(!r||typeof r!=="object")throw new Error(br.name+" ax-enable gave no answer");
  if(r.unavailable)return r;
  var s={previous:r.previous===!0,changed:r.changed===!0,screen_reader:r.screen_reader===!0};
  writeState(s);
  _fresh=r.changed===!0;
  _st=s;
  log("enable: previous="+s.previous+" changed="+s.changed+" screen_reader="+s.screen_reader);
  return s;
}
// Idle end of our accessibility use (same 2 min as the portal session's idle
// teardown in cu_linux_executor.js): in kwin mode an AX-only session never
// takes the Computer Use lock, and the task boundary only fires for cloud
// sessions, so without it the switch would stay on until quit. Re-armed by
// every AX call; unref'd, it never keeps the process alive.
var IDLE_MS=120000,_idle=null;
function armIdle(){
  if(_idle)clearTimeout(_idle);
  _idle=setTimeout(function(){_idle=null;if(_st)restore("idle")},IDLE_MS);
  if(_idle&&typeof _idle.unref==="function")_idle.unref();
}
function restore(why){
  if(_idle){clearTimeout(_idle);_idle=null}
  return queue(async function(){
    var s=_st||readState();_st=null;_fresh=!1;
    if(!s)return;
    var br=bridge();
    if(!br){log("restore ("+why+"): no bridge - kept for the next start");return}
    try{
      var r=await run(br,["ax-restore","--holder-pid",String(process.pid)],null,8000);
      dropState();
      log("restore ("+why+"): restored="+(!!r&&r.restored===!0)+(r&&r.reason?" ("+r.reason+")":""));
    }catch(e){log("restore ("+why+") failed: "+(e&&e.axWhy||"error")+" - kept for the next start")}
  });
}
function sessKey(v){return String(v).toLowerCase().replace(/^(?:session_|cse_)/,"")}
// The lock hooks of both executors (Patches 4b.2 and 4e call them on every
// Linux session type) also end our accessibility use.
function hook(){
  var ex=globalThis.__linuxExecutor;
  if(!ex||ex.__cdbAxHooked)return;
  ex.__cdbAxHooked=!0;
  var sl=ex.__setLockHeld,tb=ex.__cuTaskBoundary;
  if(typeof sl==="function")ex.__setLockHeld=function(held){var p=sl.apply(ex,arguments);if(!held&&(_st||_pending>0))restore("lock release");return p};
  if(typeof tb==="function")ex.__cuTaskBoundary=function(id,source,holder){var p=tb.apply(ex,arguments);if((_st||_pending>0)&&(id==null||holder==null||sessKey(id)===sessKey(holder)))restore("task boundary ("+source+")");return p};
}
hook();
process.once("exit",function(){
  var s=_st||readState();if(!s)return;
  var br=bridge();if(!br)return;
  try{_cp.execFileSync(br.bin,["ax-restore","--holder-pid",String(process.pid)],{timeout:3000,stdio:"ignore",env:br.env||void 0});dropState()}catch(e){}
});
(function(){var p=statePath();try{if(p&&_fs.existsSync(p))setTimeout(function(){restore("startup")},0)}catch(e){}})();

// ── windows ──────────────────────────────────────────────────────────────────
function gk(a){return String(a==null?"":a).trim().toLowerCase().replace(/\.desktop$/,"").replace(/[\s_-]+/g,"")}
// Identity keys of a name: the whole id and its last reverse-DNS segment
// ("org.xfce.mousepad" -> "mousepad"), case-insensitive, .desktop stripped.
function seg(x){var t=String(x).trim().replace(/\.desktop$/i,""),i=t.lastIndexOf(".");return i>=0?t.slice(i+1):t}
function keysOf(arr){var k={};for(var i=0;i<arr.length;i++){var x=arr[i];if(typeof x==="string"&&x.trim()){var a=gk(x),b=gk(seg(x));if(a)k[a]=1;if(b)k[b]=1}}return k}
// The `app` argument names a grant: its bundle id, its display name (what
// request_access granted, e.g. "Mousepad"), or either one's last segment.
// The grant list: opts.allowedApps (regular mode, the consent switch), else
// upstream's context (kwin mode).
function kctx(opts){return globalThis.__cuKwinMode&&opts&&opts.ctx?opts.ctx:null}
function grantList(opts){
  if(opts&&Array.isArray(opts.allowedApps))return opts.allowedApps;
  var c=kctx(opts);
  return c&&Array.isArray(c.allowedApps)?c.allowedApps:[];
}
function grantOf(app,opts){
  var list=grantList(opts);
  for(var i=0;i<list.length;i++){if(list[i]&&list[i].bundleId===app)return list[i]}
  var k=gk(app),s=gk(seg(app));
  for(var j=0;j<list.length;j++){var g=list[j];if(!g)continue;var gkk=keysOf([g.bundleId,g.displayName]);if(gkk[k]||gkk[s])return g}
  return null;
}
function strip(x){return String(x).trim().replace(/\.desktop$/i,"")}
// How windows are matched to the app. A full reverse-DNS id (the grant's
// bundle id, else the argument) matches only exactly, so "org.evil.kate" is
// never "org.kde.kate". Bare names ("Mousepad", "kate") also match a window
// id's last segment.
function matcherOf(app,grant){
  var id=strip(grant?grant.bundleId:app);
  if(id.indexOf(".")>=0)return{exact:gk(id),id:id};
  return{bare:keysOf([app,grant&&grant.bundleId,grant&&grant.displayName]),id:id};
}
// Regular mode (js/cu_linux_executor.js): the executor's canonical app ids
// (desktop file id + aliases: StartupWMClass, Exec, flatpak/snap ids, process)
// also decide - a grant of "org.mozilla.firefox" owns the X11 window of class
// "firefox". kwin mode keeps the bridge's own ids.
function idOwns(w,m){
  var a=globalThis.__cdbCuAppIds;
  if(globalThis.__cuKwinMode||!a||typeof a.owns!=="function"||!m.id)return!1;
  try{return a.owns(m.id,w)===!0}catch(e){return!1}
}
// Ownership from the app identity only (desktop file, WM_CLASS / app id),
// never the title: any window can call itself "org.kde.kate". Returns false,
// or {vendor}: the reverse-DNS id a bare name matched through, if any.
function owns(w,m){
  var t=w.transient_for||{},ids=[w.desktop_file_name,w.resource_class,w.resource_name,t.desktop_file_name,t.resource_class,t.resource_name],hit=!1,vendor=null;
  for(var i=0;i<ids.length;i++){
    if(typeof ids[i]!=="string"||!ids[i].trim())continue;
    var id=strip(ids[i]),full=gk(id);
    if(m.exact){if(full===m.exact)return{vendor:null};continue}
    if(m.bare[full]){hit=!0;continue}
    if(id.indexOf(".")>=0&&m.bare[gk(seg(id))]){hit=!0;vendor=vendor||id.toLowerCase()}
  }
  if(hit)return{vendor:vendor};
  return idOwns(w,m)?{vendor:null}:!1;
}
// The same grant -> window match for the display auto-target
// (js/cu_display_target.js): does window w belong to the granted bundle id?
globalThis.__cdbCuWindowOwns=function(bundleId,w){return typeof bundleId==="string"&&!!bundleId.trim()&&!!w&&!!owns(w,matcherOf(bundleId,null))};
// The app's windows. A bare name whose last segment names windows of two
// different reverse-DNS apps is ambiguous: refused, never guessed.
async function windowsOf(br,m){
  var all=await run(br,["windows"],null,15000),out=[],vendors={};
  (Array.isArray(all)?all:[]).forEach(function(w){
    if(!w||w.id==null||w.is_dock===!0||w.is_desktop===!0)return;
    var o=owns(w,m);if(!o)return;
    out.push(w);if(o.vendor)vendors[o.vendor]=1;
  });
  var v=Object.keys(vendors);
  if(v.length>1)out.ambiguous=v;
  return out;
}
function ambiguous(app,wins){return err("\""+app+"\" matches windows of more than one app ("+wins.ambiguous.join(", ")+"). Pass the full app id.")}
function mainWin(wins){
  var v=wins.filter(function(w){return w.is_minimized!==!0&&w.is_visible!==!1});
  for(var i=0;i<v.length;i++){if(v[i].is_active===!0)return v[i]}
  v.sort(function(a,b){return(b.stacking_order||0)-(a.stacking_order||0)});
  return v[0]||wins[0]||null;
}
var _cache=new Map(),_lastWin=new Map();
function remember(m,k,v){m.delete(k);m.set(k,v);if(m.size>64)m.delete(m.keys().next().value)}
function err(t){return{content:[{type:"text",text:t}],isError:!0}}
function bytes(t){return Buffer.byteLength(t,"utf8")}
function ok(t){if(bytes(t)>CAP){while(bytes(t)>CAP-100)t=t.slice(0,Math.floor(t.length*0.9));t+="\n... (result cut at 24 KB; narrow with role or title_contains)"}return{content:[{type:"text",text:t}]}}
// GNOME: Shell Introspect answers only GNOME's own portal backend, so
// gnome-portal-bridge has no window list and no window ids. The bridge finds
// the window inside the granted app's own AT-SPI application (`--app-id`) and
// picks among that app's windows by title (`--title`); window_id is a title.
function isGnome(br){return br&&br.name==="gnome-portal-bridge"}
async function pickWin(br,app,ak,appId,id,sid){
  if(isGnome(br)){
    var t=id!=null&&id!==""?String(id):_lastWin.get(sid+"\n"+gk(app));
    // App id as the executors derive it from a window (desktop id, .desktop
    // stripped); the bridge matches it against its AT-SPI applications.
    return{w:{id:t==null?null:t,title:t==null?"":t,appId:appId,gnome:!0}};
  }
  var wins=await windowsOf(br,ak);
  if(wins.ambiguous)return{e:ambiguous(app,wins)};
  if(id!=null&&id!==""){
    var s=String(id);
    for(var i=0;i<wins.length;i++){if(String(wins[i].id)===s)return{w:wins[i]}}
    return{e:err("window_id "+s+" is not a window of "+app+". Call app_list_windows.")};
  }
  if(!wins.length)return{e:err("No window of "+app+" was found. Call app_list_windows, or open_application first.")};
  var last=_lastWin.get(sid+"\n"+gk(app));
  if(last!=null){for(var j=0;j<wins.length;j++){if(String(wins[j].id)===last)return{w:wins[j]}}}
  return{w:mainWin(wins)};
}

// ── coordinates ──────────────────────────────────────────────────────────────
// rect_screen is global logical px. The model's frame is the last screenshot:
// kwin mode -> upstream's dims (x = ix*displayWidth/frameWidth + originX, so
// the inverse), regular mode -> the handler's __cuLastShot (image -> DIP), via
// the executor's root-pixel -> DIP map on X11 HiDPI.
function frameOf(opts){
  var kc=kctx(opts);
  if(kc){
    var ls=kc.lastScreenshot;
    if(!ls||!(ls.displayWidth>0)||!(ls.displayHeight>0))return null;
    var fw=ls.frameWidth||ls.width,fh=ls.frameHeight||ls.height;
    if(!(fw>0)||!(fh>0))return null;
    return{w:fw,h:fh,map:function(x,y){return[Math.round((x-(ls.originX||0))*fw/ls.displayWidth),Math.round((y-(ls.originY||0))*fh/ls.displayHeight)]}};
  }
  var s=globalThis.__cuLastShot;
  if(!s||!(s.dispW>0)||!(s.dispH>0)||!(s.imgW>0)||!(s.imgH>0))return null;
  var ex=globalThis.__linuxExecutor,dip=ex&&typeof ex.__axToDip==="function"?ex.__axToDip:null;
  return{w:s.imgW,h:s.imgH,map:function(x,y){if(dip){var d=dip.call(ex,x,y);x=d[0];y=d[1]}return[Math.round((x-s.originX)*s.imgW/s.dispW),Math.round((y-s.originY)*s.imgH/s.dispH)]}};
}
// No screenshot yet: the frame the click path will use. Regular mode: the next
// screenshot's frame of the monitor holding the point (executor), installed as
// the handler's __cuLastShot so a left_click before any screenshot maps
// through it too. kwin mode: upstream maps a pre-screenshot coordinate as
// x/scaleFactor + display origin, so report in that frame.
function predict(opts,x,y){
  try{
    if(kctx(opts)){
      var sc=require("electron").screen,d=sc.getDisplayNearestPoint({x:Math.round(x),y:Math.round(y)}),b=d.bounds,sf=d.scaleFactor||1;
      return{w:Math.round(b.width*sf),h:Math.round(b.height*sf),predicted:"kwin",map:function(px,py){return[Math.round((px-b.x)*sf),Math.round((py-b.y)*sf)]}};
    }
    var ex=globalThis.__linuxExecutor;
    if(globalThis.__cuLastShot||!ex||typeof ex.__axFrameFor!=="function")return frameOf(opts);
    var p=typeof ex.__axToDip==="function"?ex.__axToDip(x,y):[x,y],f=ex.__axFrameFor(p[0],p[1]);
    if(!f)return null;
    globalThis.__cuLastShot={imgW:f.imgW,imgH:f.imgH,dispW:f.dispW,dispH:f.dispH,originX:f.originX,originY:f.originY};
    globalThis.__cuActiveOrigin={x:f.originX,y:f.originY};
    log("frame: no screenshot yet - using the next screenshot's frame of display "+f.displayId);
    var fr=frameOf(opts);if(fr)fr.predicted="regular";return fr;
  }catch(e){return null}
}
// The bridges' screenshot size rule (cu_linux_executor.js _cuTargetDims).
function targetDims(w,h){var pw=Math.max(1,w),ph=Math.max(1,h),s=Math.min(1,1568/Math.max(pw,ph),Math.sqrt(1150000/(pw*ph)));return{width:Math.max(1,Math.round(pw*s)),height:Math.max(1,Math.round(ph*s))}}
// app_ax_find on a multi-monitor desktop: the window's display becomes the
// current display the way switch_display makes it current (regular mode: the
// handler's pin, passed as opts.pin; kwin mode: upstream's onDisplayPinned), so
// the next screenshot, zoom and click share the frame the positions are in.
// Returns {fr, note}. One display, or the window already on the current
// display: the existing frame (or the pre-screenshot one), no switch.
async function place(opts,x,y,fr){
  var ex=globalThis.__linuxExecutor;
  var kc=kctx(opts);
  if(kc){
    var ds=null;try{ds=ex&&typeof ex.listDisplays==="function"?await ex.listDisplays():null}catch(e){}
    var D=null;
    if(Array.isArray(ds)&&ds.length>1){for(var i=0;i<ds.length;i++){var c=ds[i];if(x>=c.originX&&x<c.originX+c.width&&y>=c.originY&&y<c.originY+c.height){D=c;break}}}
    var ls=kc.lastScreenshot,cur=ls&&ls.displayId!=null?ls.displayId:kc.selectedDisplayId;
    if(!D||D.displayId===cur||typeof kc.onDisplayPinned!=="function"){
      if(fr)return{fr:fr,note:""};
      var pf=predict(opts,x,y);
      return{fr:pf,note:pf?" No screenshot yet: (x, y) are for left_click now; after a screenshot, call app_ax_find again.":""};
    }
    kc.onDisplayPinned(D.displayId);
    var sf=D.scaleFactor||1,t=targetDims(Math.round(D.width*sf),Math.round(D.height*sf));
    log("display: window on display "+D.displayId+" - made it the current display");
    return{fr:{w:t.width,h:t.height,map:function(px,py){return[Math.round((px-D.originX)*t.width/D.width),Math.round((py-D.originY)*t.height/D.height)]}},
      note:" Positions are in the frame of display "+D.displayId+" ("+(D.label||"display "+D.displayId)+"), now the current display"+(ls?"; the last screenshot showed another display":"")+": take a screenshot before clicking by position."};
  }
  if(!ex||typeof ex.__axFrameFor!=="function")return{fr:fr,note:""};
  var p=typeof ex.__axToDip==="function"?ex.__axToDip(x,y):[x,y],f=ex.__axFrameFor(p[0],p[1]);
  if(!f)return{fr:fr,note:""};
  var multi=f.count>1&&typeof opts.pin==="function",had=globalThis.__cuLastShot;
  if(multi&&globalThis.__cuPinnedDisplay!==f.displayId){
    opts.pin({displayId:f.displayId,originX:f.originX,originY:f.originY});
  }else if(had)return{fr:fr||frameOf(opts),note:""};
  var shot={imgW:f.imgW,imgH:f.imgH,dispW:f.dispW,dispH:f.dispH,originX:f.originX,originY:f.originY};
  globalThis.__cuLastShot=shot;
  globalThis.__cuActiveOrigin={x:f.originX,y:f.originY};
  if(typeof opts.sync==="function"){try{opts.sync({width:shot.imgW,height:shot.imgH,displayWidth:shot.dispW,displayHeight:shot.dispH,displayId:f.displayId,originX:shot.originX,originY:shot.originY})}catch(e){}}
  log("frame: display "+f.displayId+(multi?" (now current)":"")+(had?"":", no screenshot yet"));
  return{fr:frameOf(opts),note:multi?" Positions are in the frame of display "+f.displayId+" ("+(f.label||"display "+f.displayId)+"), now the current display"+(had?"; the last screenshot showed another display, take a screenshot to see this one":"")+".":""};
}
function centerOf(r){return r&&r.width>0&&r.height>0?[r.x+r.width/2,r.y+r.height/2]:null}
function pos(el,coords,fr){
  var r=el&&el.rect_screen;
  if(coords!=="screen"||!r||!(r.width>0)||!(r.height>0))return"position unknown - take a screenshot to click it";
  if(!fr)return"position unknown until a screenshot is taken (then app_ax_find again)";
  var p=fr.map(r.x+r.width/2,r.y+r.height/2);
  if(p[0]<0||p[1]<0||p[0]>=fr.w||p[1]>=fr.h)return"outside the last screenshot";
  return"at ("+p[0]+", "+p[1]+")";
}
var NOISE={enabled:1,sensitive:1,showing:1,visible:1,opaque:1};
function line(el,coords,fr){
  var st=(Array.isArray(el.states)?el.states:[]).filter(function(s){return!NOISE[s]});
  var name=String(el.name||el.description||"").replace(/\s+/g," ").trim();if(name.length>100)name=name.slice(0,100)+"...";
  var v="";
  if(el.value_redacted)v=" value hidden";
  else if(typeof el.value==="string"&&el.value!==""){var vv=el.value.replace(/\s+/g," ");v=" value "+JSON.stringify(vv.length>80?vv.slice(0,80)+"...":vv)}
  return"["+el.index+"] "+(el.ax_role||"AXUnknown")+" ("+(el.role||"unknown")+") "+JSON.stringify(name)+(st.length?" ("+st.join(", ")+")":"")+v+" "+pos(el,coords,fr);
}
function unavail(r){return err("unavailable: "+r.unavailable+(r.hint?" - "+r.hint:"")+(Array.isArray(r.candidates)&&r.candidates.length?" Candidates: "+r.candidates.slice(0,10).map(function(c){return JSON.stringify(String(c))}).join(", "):""))}

// ── tools ────────────────────────────────────────────────────────────────────
async function find(br,w,input){
  var a=w.gnome?["ax-find","--app-id",w.appId].concat(w.id!=null?["--title",String(w.id)]:[]):["ax-find","--window",String(w.id)];
  if(typeof input.role==="string"&&input.role.trim())a.push("--role",input.role.trim());
  if(typeof input.title_contains==="string"&&input.title_contains!=="")a.push("--title-contains",input.title_contains);
  if(input.__all)a.push("--all");
  // wlroots: toplevel ids are per bridge connection, so `windows` and
  // `ax-find` (two processes) may mean different windows. The bridge checks the
  // window it resolves against what we picked and answers window_changed.
  if(br.name==="wlroots-bridge"&&!w.gnome){
    var wid=[w.desktop_file_name,w.resource_class,w.resource_name].filter(function(x){return typeof x==="string"&&x.trim()})[0];
    if(wid)a.push("--expect-app-id",wid.replace(/\.desktop$/i,""));
    a.push("--expect-title",String(w.title||""));
  }
  var r=await run(br,a,null,15000),fresh=_fresh;
  _fresh=!1;
  if(fresh&&r&&r.unavailable==="app_not_found"){
    log("find: app_not_found right after enable - retrying once");
    await new Promise(function(res){setTimeout(res,500)});
    r=await run(br,a,null,15000);
  }
  // kwin mode enforces upstream's grants: when KWin named the window's pid,
  // a tree found by name alone may belong to another app.
  if(globalThis.__cuKwinMode&&r&&!r.unavailable&&typeof w.pid==="number"&&r.matched_by==="name"){
    log("find: window="+String(w.id)+" refused (pid known, matched by name)");
    return{unavailable:"app_not_confirmed",hint:"The accessible app for this window was matched by name only, so it could not be confirmed as the granted app. Use screenshots for this window."};
  }
  if(r&&r.unavailable==="window_changed")return{unavailable:"window_changed",hint:"The window changed since it was listed. Call app_list_windows again and pick the window from the new list."};
  // Every bridge: when the window manager named the window's process, the
  // accessible application found must be that process.
  if(r&&!r.unavailable&&typeof w.pid==="number"&&r.app&&typeof r.app.pid==="number"&&r.app.pid!==w.pid){
    log("find: window="+String(w.id)+" refused (accessible app pid differs from the window's)");
    return{unavailable:"app_not_confirmed",hint:"The accessible application found is another process than this window's, so it was not used. Call app_list_windows again, or use screenshots for this window."};
  }
  return r;
}
function store(sid,w,app,r){
  var els=new Map(),list=Array.isArray(r.elements)?r.elements:[];
  for(var i=0;i<list.length;i++){var e=list[i];if(e&&typeof e.index==="number"&&typeof e.ref==="string")els.set(e.index,e)}
  remember(_cache,sid+"\n"+String(w.id),{els:els,coords:r.coords,scope:r.scope});
  remember(_lastWin,sid+"\n"+gk(app),String(w.id));
  return list;
}
// The element a click/type targets: element_index from this window's last
// find, or the focused element of a fresh full walk.
async function target(br,w,input,sid,label){
  if(input.coordinate!==void 0)return{e:err(label+" takes no coordinates. Pass element_index from app_ax_find or target: \"focused\"; for a point use left_click.")};
  var key=sid+"\n"+String(w.id);
  if(input.target==="focused"){
    var r=await find(br,w,{__all:!0});
    if(r&&r.unavailable)return{e:unavail(r)};
    var list=Array.isArray(r&&r.elements)?r.elements:[],hit=null;
    for(var i=0;i<list.length;i++){if(list[i]&&Array.isArray(list[i].states)&&list[i].states.indexOf("focused")>=0&&typeof list[i].ref==="string")hit=list[i]}
    if(!hit)return{e:err("No element reports keyboard focus in this window. Use element_index from app_ax_find.")};
    return{el:hit,coords:r.coords,scope:r.scope,key:key};
  }
  if(typeof input.element_index!=="number")return{e:err("Pass element_index (from app_ax_find) or target: \"focused\".")};
  var c=_cache.get(key),el=c&&c.els.get(input.element_index);
  if(!el)return{e:err("No element ["+input.element_index+"] from the last app_ax_find of this window. Call app_ax_find again.")};
  return{el:el,coords:c.coords,scope:c.scope,key:key};
}
function actResult(r,t,label,fr,what){
  var el=t.el;
  if(!r||typeof r!=="object")return err(label+": no answer from the bridge.");
  var u=r.unavailable||r.error;
  if(u==="stale_element"||u==="out_of_scope"){_cache.delete(t.key);return err("Element ["+el.index+"] is gone (the window changed). Call app_ax_find again.")}
  if(u){
    var m=label+" refused: "+u+(r.hint?" - "+r.hint:"");
    if(label==="app_click"){var p=pos(el,t.coords,fr);if(p.indexOf("at (")===0)m+=". Its center is "+p+" in the last screenshot: left_click there instead."}
    return err(m);
  }
  if(r.ok===null)return ok((what==="Pressed"?"Click":"Text")+" sent to ["+el.index+"] "+(el.ax_role||"AXUnknown")+", result unknown: take a screenshot or app_ax_find to check. Do not repeat it blindly.");
  if(r.ok!==!0)return err(label+": the app did not accept the "+(r.action||"action")+(r.method?" ("+r.method+")":"")+".");
  var post=r.post&&typeof r.post==="object"?r.post:null,ps=[];
  if(post){if(post.focused===!0)ps.push("focused");if(post.checked===!0)ps.push("checked");else if(post.checked===!1)ps.push("not checked")}
  return ok(what+" ["+el.index+"] "+(el.ax_role||"AXUnknown")+" ("+(el.role||"unknown")+")"+(ps.length?"; now "+ps.join(", "):"")+". Check the result with app_ax_find or a screenshot.");
}
var TEXT_AX={AXTextField:1,AXTextArea:1,AXSearchField:1,AXComboBox:1,AXSecureTextField:1};
async function call(name,input,opts){
  input=input&&typeof input==="object"?input:{};
  var app=input.app,sid=String(opts&&opts.sid!=null?opts.sid:"(no-session)");
  if(typeof app!=="string"||!app.trim())return err("app is required.");
  // Grants: upstream's tier check where upstream dispatches (kwin mode); in
  // regular mode the consent switch's check (opts.tier, opts.allowedApps),
  // else every app at tier full (cu_handler_injection.js).
  var grant=grantOf(app,opts);
  if(opts&&typeof opts.tier==="function"){var g=opts.tier(grant?grant.bundleId:app,TIER[name]);if(g&&g.error)return g.error}
  var ak=matcherOf(app,grant),appId=String(grant?grant.bundleId:app).trim().replace(/\.desktop$/i,"");
  var br=bridge();
  if(!br)return err("Accessibility tools need a Computer Use bridge, and none is available in this session.");
  if(name==="app_list_windows"&&isGnome(br)){
    var ge=await ensureEnabled(br);
    if(ge&&ge.unavailable)return unavail(ge);
    var gr=await find(br,{gnome:!0,appId:appId,id:null},{});
    var note=" GNOME lists windows by title only: pass a title as window_id.";
    if(gr&&gr.unavailable==="ambiguous_window"&&Array.isArray(gr.candidates))return ok(JSON.stringify(gr.candidates.map(function(c){return{window_id:String(c),title:String(c),is_main:!1,is_minimized:!1}}))+note);
    if(!gr||typeof gr!=="object")return err("app_list_windows: no answer from the bridge.");
    if(gr.unavailable)return unavail(gr);
    var gt=String(gr.window&&gr.window.title||"");
    return ok(JSON.stringify([{window_id:gt,title:gt,is_main:!0,is_minimized:!1}])+note);
  }
  if(name==="app_list_windows"){
    var wins=await windowsOf(br,ak);
    if(wins.ambiguous)return ambiguous(app,wins);
    var mw=mainWin(wins);
    if(!wins.length)return err("No window of "+app+" was found. Is it running? open_application starts it.");
    return ok(JSON.stringify(wins.map(function(x){var gm=x.geometry;return{window_id:String(x.id),title:typeof x.title==="string"?x.title:"",is_main:x===mw,is_minimized:x.is_minimized===!0,bounds:gm&&gm.width>0&&gm.height>0?{x:gm.x,y:gm.y,width:gm.width,height:gm.height}:void 0}})));
  }
  var pw=await pickWin(br,app,ak,appId,input.window_id,sid);
  if(pw.e)return pw.e;
  var w=pw.w;
  var en=await ensureEnabled(br);
  if(en&&en.unavailable)return unavail(en);
  var fr=frameOf(opts);
  if(name==="app_ax_find"){
    var r=await find(br,w,input);
    if(!r||typeof r!=="object")return err("app_ax_find: no answer from the bridge.");
    if(r.unavailable)return unavail(r);
    // GNOME: the window is known by the title the bridge matched.
    if(w.gnome&&r.window&&typeof r.window.title==="string"&&r.window.title)w={id:r.window.title,title:r.window.title,appId:appId,gnome:!0};
    var list=store(sid,w,app,r),coords=r.coords;
    log("find: window="+String(w.id)+" elements="+list.length+" coords="+coords+(r.truncated?" truncated="+(r.truncated_reason||"yes"):""));
    var head=list.length+" element(s) in window "+JSON.stringify(String(w.title||""))+" (window_id "+String(w.id)+")"+(r.truncated?"; walk truncated ("+(r.truncated_reason||"limit")+"): narrow with role or title_contains":"")+".";
    if(coords!=="screen")head+=" This desktop does not report element positions; app_click and app_type work by element_index.";
    else{
      var c0=centerOf(r.window&&r.window.rect_screen);
      for(var ci=0;!c0&&ci<list.length;ci++)c0=centerOf(list[ci].rect_screen);
      if(c0){var pl=await place(opts||{},c0[0],c0[1],fr);fr=pl.fr;head+=pl.note}
    }
    if(!list.length)head+=input.role||input.title_contains?" Nothing matched the filter.":" The app exposes no controls here (Electron/Chromium apps usually do not): use screenshots.";
    var out=head,shown=0,nb=bytes(head);
    for(var i=0;i<list.length;i++){var l="\n"+line(list[i],coords,fr),lb=bytes(l);if(nb+lb>CAP-200)break;out+=l;nb+=lb;shown++}
    if(shown<list.length)out+="\n... "+(list.length-shown)+" more element(s) not shown (24 KB cap): narrow with role or title_contains.";
    return ok(out);
  }
  // Screen sharing stopped by the user (#293): clicks and typing are input,
  // so they stay off for the rest of the session; reading still works.
  var sx=globalThis.__linuxExecutor;
  try{if(sx&&typeof sx.__stoppedByUser==="function"&&sx.__stoppedByUser())return err("The user stopped screen sharing for this Computer Use session, so app_click and app_type are off until this task ends. app_ax_find and app_list_windows still work.")}catch(se){}
  if(w.id!=null)remember(_lastWin,sid+"\n"+gk(app),String(w.id));
  var t=await target(br,w,input,sid,name);
  if(t.e)return t.e;
  if(name==="app_click"){
    var rc=await run(br,["ax-action","--scope",String(t.scope||""),"--ref",t.el.ref,"--action","click"],null,10000);
    log("click: window="+String(w.id)+" "+(rc&&rc.ok===!0?"ok":rc&&rc.ok===null?"dispatched":"refused ("+(rc&&(rc.unavailable||rc.error)||"not ok")+")"));
    if(!fr&&t.coords==="screen"){var c1=centerOf(t.el.rect_screen);if(c1)fr=predict(opts,c1[0],c1[1])}
    return actResult(rc,t,name,fr,"Pressed");
  }
  if(name==="app_type"){
    if(typeof input.text!=="string")return err("text is required.");
    var el=t.el,stt=Array.isArray(el.states)?el.states:[];
    if(stt.indexOf("editable")<0&&!TEXT_AX[el.ax_role])return err("Only target TEXT fields: ["+el.index+"] is "+(el.ax_role||"AXUnknown")+" ("+(el.role||"unknown")+"), not editable text.");
    if(input.overwrite_existing!==!0&&(el.value_redacted===!0||typeof el.value==="string"&&el.value!==""))return err("["+el.index+"] already has text, and app_type replaces ALL of it. Pass overwrite_existing: true to replace it.");
    var rt=await run(br,["ax-action","--scope",String(t.scope||""),"--ref",el.ref,"--action","set-text"],input.text,10000);
    log("set-text: window="+String(w.id)+" chars="+input.text.length+" "+(rt&&rt.ok===!0?"ok":rt&&rt.ok===null?"dispatched":"refused ("+(rt&&(rt.unavailable||rt.error)||"not ok")+")"));
    return actResult(rt,t,name,fr,"Set the text of");
  }
  return err("Unknown tool: "+name);
}
globalThis.__cdbAxCall=function(name,input,opts){
  // An accessibility action is a Computer Use action: the Escape watcher
  // (community switch, js/cu_esc_watch.js) re-arms a watcher it parked at a
  // cloud turn end. Sync and cheap; absent or off = nothing.
  try{globalThis.__cdbCuEscWatch?.toolCall?.()}catch(ee){}
  return queue(async function(){
    try{return await call(name,input,opts)}
    catch(e){log(name+" failed: "+(e&&e.axWhy||"error"));return err(name+" failed: "+(e&&e.message||e))}
    finally{if(_st)armIdle()}
  });
};
})();

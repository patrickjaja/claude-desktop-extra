// Computer Use display auto-target: which monitor holds the granted apps.
// Injected by fix_computer_use_linux.nim (Patch 1) before both executors at app
// ready, Linux only. Plain script: no import/export.
//
// Upstream's screenshot handler (cloud Cowork, Dispatch, kwin-mode sessions)
// asks the executor's resolvePrepareCapture({allowedBundleIds, autoResolve})
// for the display to capture, and request_access asks findWindowDisplays to
// tell the model which monitor each granted app is on. On macOS the native
// executor answers both from the windows' frames; this is the Linux answer,
// shared by js/cu_linux_executor.js and js/executor_linux.js.
//
// Bridge-agnostic: each executor normalizes its bridge's window list and its
// monitor list into ONE coordinate space and hands them here. A window whose
// bridge reports no position (wlroots foreign-toplevel, GNOME Introspect) has
// rect null and, without a displayId, simply does not count - never guessed.
//
//   mons: [{displayId, label, isPrimary, rect:{x,y,width,height}}]
//   wins: [{bundleId, rect:{x,y,width,height}|null, displayId?, minimized}]
//         one entry per (window, granted bundle id it belongs to)
//
// pick(wins, mons, bundleIds, preferredId) -> {displayId|null, why, areas}
//   The display with the most visible window area of the granted apps. A tie
//   goes to the preferred display, then the primary, then the first in mons
//   order. displayId null = nothing to go on (keep the preferred display).
// windowDisplays(wins, mons, bundleIds) -> [{bundleId, displayIds}]
//   Per app, the displays its windows are mostly on (each window counts on the
//   display holding most of it), largest total area first; apps with no
//   located window are left out (upstream filters them out too).
// owns(bundleId, rawWindow) -> bool
//   The grant -> window identity match, delegated to the accessibility tools'
//   matcher (js/cu_ax_tools.js, globalThis.__cdbCuWindowOwns), the one the
//   app_* tools use. Without it nothing matches.
(function(){
if(process.platform!=="linux"||globalThis.__cdbCuDisplayTarget)return;
function num(v){return typeof v==="number"&&isFinite(v)}
function okRect(r){return!!r&&num(r.x)&&num(r.y)&&num(r.width)&&num(r.height)&&r.width>0&&r.height>0}
function inter(a,b){
  var w=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x),h=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);
  return w>0&&h>0?w*h:0;
}
// Per window: {displayId: area}. A window with no usable rect but a known
// display (a bridge that names the output only) counts 1 there.
function areasOf(w,mons){
  var out={};
  if(okRect(w.rect)){for(var i=0;i<mons.length;i++){var a=okRect(mons[i].rect)?inter(w.rect,mons[i].rect):0;if(a>0)out[mons[i].displayId]=a}}
  else if(w.displayId!=null){for(var j=0;j<mons.length;j++){if(mons[j].displayId===w.displayId){out[w.displayId]=1;break}}}
  return out;
}
function want(bundleIds){var s={};(bundleIds||[]).forEach(function(b){if(typeof b==="string"&&b)s[b]=1});return s}
function usable(w,set){return!!w&&set[w.bundleId]===1&&w.minimized!==!0}
function pick(wins,mons,bundleIds,preferredId){
  var set=want(bundleIds),tot={},seen=0;
  mons=Array.isArray(mons)?mons:[];
  if(!Object.keys(set).length)return{displayId:null,why:"no granted apps",areas:tot};
  if(mons.length<2)return{displayId:null,why:"only one display",areas:tot};
  (Array.isArray(wins)?wins:[]).forEach(function(w){
    if(!usable(w,set))return;
    var a=areasOf(w,mons),k;
    for(k in a){tot[k]=(tot[k]||0)+a[k];seen=1}
  });
  if(!seen)return{displayId:null,why:"no visible window of the granted apps with a known position",areas:tot};
  var best=-1,tied=[];
  mons.forEach(function(m){var a=tot[m.displayId]||0;if(a>best){best=a;tied=[m]}else if(a===best)tied.push(m)});
  var win=null;
  for(var i=0;!win&&i<tied.length;i++)if(tied[i].displayId===preferredId)win=tied[i];
  for(var j=0;!win&&j<tied.length;j++)if(tied[j].isPrimary)win=tied[j];
  win=win||tied[0];
  return{displayId:win.displayId,why:tied.length>1?"tie":"most window area",areas:tot};
}
function windowDisplays(wins,mons,bundleIds){
  var set=want(bundleIds),per={};
  mons=Array.isArray(mons)?mons:[];
  (Array.isArray(wins)?wins:[]).forEach(function(w){
    if(!usable(w,set))return;
    var a=areasOf(w,mons),bestId=null,bestA=0;
    // mons order breaks a tie, so the result does not depend on key order.
    for(var i=0;i<mons.length;i++){var v=a[mons[i].displayId]||0;if(v>bestA){bestA=v;bestId=mons[i].displayId}}
    if(bestId==null)return;
    var p=per[w.bundleId]||(per[w.bundleId]={});
    p[bestId]=(p[bestId]||0)+bestA;
  });
  var out=[];
  Object.keys(set).forEach(function(b){
    var p=per[b];if(!p)return;
    var ids=mons.map(function(m){return m.displayId}).filter(function(id){return p[id]>0});
    ids.sort(function(x,y){return p[y]-p[x]});
    if(ids.length)out.push({bundleId:b,displayIds:ids});
  });
  return out;
}
function owns(bundleId,w){
  var f=globalThis.__cdbCuWindowOwns;
  if(typeof f!=="function"||!w||w.is_dock===!0||w.is_desktop===!0)return!1;
  try{return f(bundleId,w)===!0}catch(e){return!1}
}
// Raw bridge windows -> normalized entries, one per granted app a window
// belongs to. rectOf(w) returns the window's rect in the monitors' space or
// null (no position); displayOf(w) an optional displayId (the bridge's output).
function normalize(raw,bundleIds,rectOf,displayOf){
  var out=[],ids=Object.keys(want(bundleIds));
  (Array.isArray(raw)?raw:[]).forEach(function(w){
    if(!w||w.is_visible===!1)return;
    var r=null,d=null,done=!1;
    for(var i=0;i<ids.length;i++){
      if(!owns(ids[i],w))continue;
      if(!done){done=!0;r=rectOf?rectOf(w):null;d=displayOf?displayOf(w):null}
      out.push({bundleId:ids[i],rect:okRect(r)?r:null,displayId:d==null?void 0:d,minimized:w.is_minimized===!0});
    }
  });
  return out;
}
function label(mons,id){for(var i=0;i<mons.length;i++)if(mons[i].displayId===id)return mons[i].label||String(id);return id==null?"(default)":String(id)}
globalThis.__cdbCuDisplayTarget={pick:pick,windowDisplays:windowDisplays,normalize:normalize,owns:owns,label:label};
})();

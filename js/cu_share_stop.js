(function(){
// ── Computer Use: Stop sharing stops the running turn (issue #323) ──────────
// Injected by fix_computer_use_linux.nim (Patch 1) before the executors at app
// ready, Linux only. Plain script: no import/export. Always on: our portal
// bridges follow upstream's own design here (maintainer ruling 2026-11-10).
//
// When the user clicks "Stop sharing" in the desktop's screen-sharing
// indicator, the gnome-portal-bridge / kwin-portal-bridge session daemon writes
// $XDG_RUNTIME_DIR/<bridge>/stopped-by-user and exits. The daemon is a setsid'd
// grandchild (session-start returns once it is ready), so there is no exit
// event of ours to wait for: watch() puts an fs.watch on that dir while a
// session is up. The executors latch the stop as before and call fire(), which
// runs upstream's own "user stopped sharing" abort (globalThis.__cdbCuShareEnded,
// exposed by sub-patch 17c: it stops the lock holder and every app-mode holder,
// as upstream's Escape does).
if(globalThis.__cdbCuShareStop)return;
var _fs=require("fs"),_path=require("path");
function diag(s){try{(globalThis.__cdbDiag||function(){})("[claude-cu] stop-sharing: "+s)}catch(e){}}
function msgOf(e){return e&&e.message?e.message:String(e)}
// watch(bridge, onMarker): fs.watch on $XDG_RUNTIME_DIR/<bridge>/ (unset ->
// /tmp, as the bridges do; empty or relative -> no watch, as the executors'
// own marker check). onMarker() runs when stopped-by-user exists after an
// event in that dir; the caller re-checks its own session state. Returns
// {close, check} or null (dir not there yet: the caller arms again after its
// next session start). Only a real directory (not a symlink) owned by this
// user that no other account can write into is watched: anywhere else (a
// shared /tmp/<bridge> another account created) a planted marker could stop
// the turn, so that case is not watched (one log line per directory) and a
// stop is noticed on the next action as before.
// A bridge dir that is group/other-writable only because the desktop session
// runs with umask 0002 (Ubuntu's GNOME: the bridge creates it 0775) is
// tightened to 0700 and watched, but only when ALL of these hold:
//   - it is a real directory (lstat, not a symlink) owned by this uid;
//   - its parent is $XDG_RUNTIME_DIR itself (set and absolute, never the /tmp
//     default), a real directory owned by this uid with no group/other access
//     at all (mode & 077 == 0, the 0700 pam_systemd / the XDG spec give it).
// Why that is enough against another local (non-root) user planting
// stopped-by-user: to create or rename anything in <bridge>/ they must first
// traverse its parent, and a 0700 parent owned by us denies them search
// permission, so the group/other write bit on <bridge>/ was never usable by
// them; for the same reason they cannot swap <bridge>/ for their own dir or a
// symlink between our lstat and the chmod. The chmod is defence in depth, and
// the dir is checked again after it. root is out of scope (it can write the
// marker anywhere).
var _refused={};
function _uid(){return typeof process.getuid==="function"?process.getuid():null}
function safeDir(dir){
  var st;
  try{st=_fs.lstatSync(dir)}catch(e){return e&&e.code==="ENOENT"?"absent":"unreadable ("+(e&&e.code||msgOf(e))+")"}
  if(!st.isDirectory())return"not a directory";
  var uid=_uid();
  if(uid!==null&&st.uid!==uid)return"owned by uid "+st.uid;
  if(st.mode&18)return"writable by group or others (mode "+(st.mode&511).toString(8)+")";
  return"";
}
// "" when base is our own private $XDG_RUNTIME_DIR, else why not.
function privateParent(base){
  var d=process.env.XDG_RUNTIME_DIR;
  if(!d||!_path.isAbsolute(d)||_path.resolve(d)!==_path.resolve(base))return"its parent is not $XDG_RUNTIME_DIR";
  var st;
  try{st=_fs.lstatSync(base)}catch(e){return"its parent is unreadable ("+(e&&e.code||msgOf(e))+")"}
  if(!st.isDirectory())return"its parent is not a directory";
  var uid=_uid();
  if(uid===null)return"the user id is unknown";
  if(st.uid!==uid)return"its parent is owned by uid "+st.uid;
  if(st.mode&63)return"its parent is open to group or others (mode "+(st.mode&511).toString(8)+")";
  return"";
}
// safeDir, tightening a group/other-writable dir inside our private runtime dir.
function trustDir(base,dir){
  var bad=safeDir(dir);
  if(bad.indexOf("writable by group or others")!==0)return bad;
  var why=privateParent(base);
  if(why)return bad+" and "+why;
  try{_fs.chmodSync(dir,448)}catch(e){return bad+" and chmod 0700 failed ("+(e&&e.code||msgOf(e))+")"}
  var again=safeDir(dir);
  if(!again&&!_refused["tight:"+dir]){_refused["tight:"+dir]=1;var m=/mode (\d+)/.exec(bad);diag(dir+" had mode "+(m?m[1]:"?")+" (session umask); set to 0700 (it sits in the private "+base+") and watched")}
  return again;
}
function watch(bridge,onMarker){
  var d=process.env.XDG_RUNTIME_DIR,base=d===void 0?"/tmp":d;
  if(!base||!_path.isAbsolute(base))return null;
  var dir=_path.join(base,bridge),file=_path.join(dir,"stopped-by-user"),closed=!1,w;
  var bad=trustDir(base,dir);
  if(bad==="absent")return null;
  if(bad){if(!_refused[dir]){_refused[dir]=1;diag("not watching "+dir+": "+bad+"; a stop is noticed on the next action")}return null}
  function check(){if(closed)return;_fs.lstat(file,function(err){if(err||closed)return;try{onMarker()}catch(e){diag("handler threw: "+msgOf(e))}})}
  try{w=_fs.watch(dir,{persistent:!1},function(ev,name){if(name!=null&&String(name)!=="stopped-by-user")return;check()})}
  catch(e){if(!e||e.code!=="ENOENT")diag("cannot watch "+dir+" ("+(e&&e.code||msgOf(e))+"); a stop is noticed on the next action");return null}
  w.on("error",function(){close()});
  function close(){if(closed)return;closed=!0;try{w.close()}catch(e){}}
  return{close:close,check:check};
}
// fire(bridge, why): upstream's "user stopped sharing" abort, one log line.
// The executors decide when (once per lock hold, and once per task in a hold).
function fire(bridge,why){
  var f=globalThis.__cdbCuShareEnded;
  diag(bridge+": screen sharing was stopped ("+why+"), stopping the Computer Use turn"+(typeof f==="function"?"":" - upstream's abort is not available"));
  if(typeof f!=="function")return!1;
  try{f();return!0}catch(e){diag("upstream's stop-sharing abort threw: "+msgOf(e));return!1}
}
globalThis.__cdbCuShareStop=Object.freeze({watch:watch,fire:fire});
})();

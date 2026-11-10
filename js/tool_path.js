;(function __cdbToolPathInit(){
// The one lookup for the tools our main-process patches run themselves.
// Embedded at the head of index.js by patches/core/add_tool_path_resolver.nim,
// ahead of upstream's main code; consumers in other patches read
// globalThis.__cdbToolPath at call time and keep their old bare-name code when
// it is missing (non-Linux, or a build without this patch).
//
// Upstream (v4.23118) narrows process.env.PATH in index.pre.js, before any of
// our code loads, to a fixed list of system dirs (/usr/local/bin and
// /usr/local/sbin only when root-owned and read-only, then /usr/bin:/bin:
// /usr/sbin:/sbin:/snap/bin:/run/current-system/sw/bin:
// /run/current-system/profile/bin). It keeps the narrowed PATH in
// CLAUDE_DESKTOP_NARROWED_PATH and the PATH the app was started with in
// CLAUDE_DESKTOP_STARTED_PATH, so a tool the app runs by itself never comes
// from a folder the user - or anything running as the user - can write. Its
// remote flag 1358805273 can put the started PATH back at run time, so
// everything here reads the env per call, never at load. process.env.PATH
// itself is never written here: upstream and its flag own it.
//
// Two PATHs, by purpose (the same split as js/cu_linux_executor.js, whose own
// copy of these helpers is pinned to this one by shared test vectors,
// scripts/tests/lib/tool-path-vectors.mjs):
//   TOOL PATH - a tool WE choose to run (xdg-mime, xdg-open, git, hyprctl,
//     qemu, ...): the narrowed dirs, then the started dirs that pass upstream's
//     trust rule along the whole entry as written (root-owned, not writable,
//     every symlink hop root-owned). That keeps root-managed dirs outside the
//     fixed list: a NixOS wrapper's /nix/store/<hash>/bin dirs,
//     /etc/profiles/per-user/<user>/bin, the rpm's qemu-shim dir. A tool is
//     spawned by the absolute path found, so the PATH a child inherits never
//     picks the binary. ~/.local/bin, ~/.nix-profile/bin and other folders
//     the user owns are not used for these tools.
//   APP PATH - something the user named (a command in a setting, a recipe the
//     user runs in a shell): the started PATH, absolute entries only, then the
//     narrowed dirs.
// Narrowing not in effect (an upstream without it, or the flag restored the
// started PATH): process.env.PATH for both, as before.
//
// API (globalThis.__cdbToolPath, frozen; Linux only):
//   which(bin, {fresh})  absolute path of bin on the TOOL PATH (on
//                        process.env.PATH when narrowing is off), or null.
//   cmd(bin, fresh)      what to spawn: the absolute path while narrowing, the
//                        bare name when not (as before), null when missing.
//   appWhich(bin)        absolute path of bin on the APP PATH (the started
//                        PATH first; process.env.PATH when narrowing is off),
//                        or null - for a program treated as the user's own.
//   toolPath()           the TOOL PATH string.
//   toolEnv(base)        a copy of base (default process.env) with PATH = TOOL
//                        PATH, or null when narrowing is off (inherit).
//   appPath()            the APP PATH string, or null when narrowing is off.
//   appEnv(base)         a copy of base with PATH = APP PATH, or null.
//   ignored(bin)         the user-writable dir a copy of bin was found in and
//                        ignored by the last lookup, else null (for messages).
//   startedPath()        the started PATH while narrowing is in effect, else null.
//   trusted(dir, fresh)  the real dir a started-PATH entry leads to when the
//                        entry is trustworthy all the way, else null.
// Diagnostics (claude-patches.log): one line the first time a tool resolves
// through a trusted started dir, one when a copy in a user-writable dir is
// ignored - once per tool and dir.
if(typeof process==="undefined"||process.platform!=="linux")return;
if(globalThis.__cdbToolPath)return; // first definition wins
var _fs=require("fs"),_path=require("path");
var TAG="[tool-path] ";
var queue=[],hooked=false;
function emit(line){try{(globalThis.__cdbDiag||console.log)(line)}catch(e){}}
function flush(){var q=queue;queue=null;for(var i=0;q&&i<q.length;i++)emit(q[i])}
// __cdbDiag only exists once upstream's "ready" handler ran, and console.log is
// discarded by the official build: queue until then. Electron is reached only
// when a line has to wait, never at load.
function log(m){
  var line=TAG+m;
  if(queue&&typeof globalThis.__cdbDiag!=="function"){
    queue.push(line);
    if(!hooked){hooked=true;try{require("electron").app.whenReady().then(function(){setTimeout(flush,0)},function(){})}catch(e){try{setTimeout(flush,0)}catch(e2){}}}
    return;
  }
  flush();emit(line);
}
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
// only root can change where the entry leads.
function _chainReal(p){
  if(!_trustRule("/"))return null;
  var cur="/",q=p.split("/").filter(Boolean),hops=0;
  while(q.length){
    var n=q.shift();if(n===".")continue;
    if(n===".."){cur=_path.dirname(cur);continue}
    var nx=_path.join(cur,n),st;try{st=_fs.lstatSync(nx)}catch(e){return null}
    if(st.isSymbolicLink()){
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
// and an untrusted verdict can only be stale on the safe side. fresh walks the
// chain again, so a link repointed since is seen.
var _dirTrust={};
function _dirTrusted(d,fresh){
  if(fresh||!Object.prototype.hasOwnProperty.call(_dirTrust,d))_dirTrust[d]=_chainReal(d);
  return _dirTrust[d];
}
// TOOL PATH: the narrowed dirs, then the trusted started dirs (real paths).
function _toolPath(){
  var s=_startedRaw(),P=process.env.PATH||"";if(s===null)return P;
  var out=_absDirs(P);
  _absDirs(s).forEach(function(d){if(out.indexOf(d)>=0)return;var r=_dirTrusted(d);if(r&&out.indexOf(r)<0)out.push(r)});
  return out.join(":");
}
// A tool we run -> what to spawn: its absolute path while upstream narrows
// PATH (narrowed dirs first, then trusted started dirs), its bare name when it
// does not (as before), null when it is missing. Cached per (PATH, started
// PATH, tool): a hit for good, a miss for MISS_TTL_MS only, so a tool
// installed while the app runs is seen a few seconds later without a restart
// (the old bare-name spawn saw it at once). fresh bypasses the cache.
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
    if(r&&!_toolSaid[bin+"\0"+r]&&P.split(":").indexOf(_path.dirname(r))<0){_toolSaid[bin+"\0"+r]=1;log(bin+" -> "+r+" (a root-owned read-only folder on the PATH Claude Desktop was started with)")}
    if(r)delete _toolIgn[bin];
    else if(ign){_toolIgn[bin]=ign;if(!_toolSaid[bin+"\0"+ign]){_toolSaid[bin+"\0"+ign]=1;log(bin+" found only in "+ign+", a user-writable folder - ignored (Claude Desktop runs the tools it picks itself only from system folders; install "+bin+" system-wide)")}}
  }
  _toolCache[ck]=r;if(r===null)_toolMissAt[ck]=Date.now();return r;
}
function _okName(bin){return typeof bin==="string"&&bin!==""&&bin.indexOf("/")<0&&bin!=="."&&bin!==".."}
function which(bin,opts){
  if(!_okName(bin))return null;
  var fresh=opts===true||!!(opts&&opts.fresh);
  if(_startedRaw()===null)return _walk((process.env.PATH||"").split(":"),bin);
  return _toolCmd(bin,fresh);
}
function cmd(bin,fresh){return _okName(bin)?_toolCmd(bin,!!fresh):null}
// A program looked up the way the user's own shell would: on the APP PATH
// (started PATH first) while narrowing, on process.env.PATH otherwise.
// Absolute path or null. Not cached.
function appWhich(bin){
  if(!_okName(bin))return null;
  return _walk((_startedPath()||process.env.PATH||"").split(":"),bin);
}
function _envWith(P,base){
  var e={},k,src=base||process.env;for(k in src)if(Object.prototype.hasOwnProperty.call(src,k))e[k]=src[k];
  if(typeof P==="string")e.PATH=P;else delete e.PATH;
  return e;
}
function toolEnv(base){return _startedRaw()===null?null:_envWith(_toolPath(),base)}
function appEnv(base){var p=_startedPath();return p===null?null:_envWith(p,base)}
function ignored(bin){return Object.prototype.hasOwnProperty.call(_toolIgn,bin)?_toolIgn[bin]:null}
// Non-writable, non-configurable binding: "first definition wins" holds for
// the global itself, not only for this script (a later assignment is ignored
// in sloppy code and throws in strict code; consumers only read it).
Object.defineProperty(globalThis, "__cdbToolPath", { value: Object.freeze({
  which:which,cmd:cmd,appWhich:appWhich,toolPath:_toolPath,toolEnv:toolEnv,appPath:_startedPath,appEnv:appEnv,
  ignored:ignored,startedPath:_startedRaw,trusted:function(d,fresh){return typeof d==="string"&&d.charAt(0)==="/"?_dirTrusted(d,!!fresh):null}
}), writable: false, configurable: false, enumerable: true });
})();

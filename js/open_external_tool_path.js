;(function __cdbOpenExternalToolPath(){
// Links, "Open in ..." and SSO keep working when xdg-open is only in a
// root-managed folder outside upstream's narrowed PATH. Embedded at the head
// of index.js by patches/linux/fix_open_external_tool_path.nim.
//
// Since 4.23118 upstream narrows process.env.PATH at startup to fixed system
// dirs. On Linux Electron's shell.openExternal(url) and shell.openPath(path)
// execvp `xdg-open` from the live process.env.PATH, synchronously inside the
// call (measured with Electron 44: a PATH set right before the call and
// restored on the next line is the one the launch uses, and the one xdg-open
// inherits), and a failed launch is silent. So where xdg-open is not
// installed in a system folder but only in a root-managed one on the PATH the
// app was started with (as with the Nix package's wrapper, which carries its own
// xdg-utils), every link did nothing; where xdg-open is in a system folder (on
// NixOS: the system profile), nothing changes.
//
// Only in that situation - narrowing in effect, xdg-open NOT on the narrowed
// process.env.PATH, and the shared resolver (globalThis.__cdbToolPath,
// patches/core/add_tool_path_resolver.nim) finding it in a root-owned
// read-only folder of the started PATH - the synchronous part of the call runs
// with process.env.PATH = the resolver's TOOL PATH (system folders plus those
// root-managed folders; never a user-writable one), restored in `finally` on
// the same tick. Every other call (xdg-open on the narrowed PATH: every
// mainstream distro; narrowing off; resolver missing) goes to the original
// untouched. Non-Linux: nothing is wrapped. shell.showItemInFolder is left
// alone: it asks the file manager over D-Bus, and its xdg-open fallback runs
// later, outside any synchronous window.
//
// Composes with the other openExternal wrappers (fix_profile_url_routing,
// update_check_own_releases): `this`, the arguments and the return value are
// passed through, whichever wraps first.
if(typeof process==="undefined"||process.platform!=="linux")return;
var TAG="[tool-path] ";
var queue=[],hooked=false;
function emit(line){try{(globalThis.__cdbDiag||console.log)(line)}catch(e){}}
function flush(){var q=queue;queue=null;for(var i=0;q&&i<q.length;i++)emit(q[i])}
function log(m){
  var line=TAG+m;
  if(queue&&typeof globalThis.__cdbDiag!=="function"){
    queue.push(line);
    if(!hooked){hooked=true;try{require("electron").app.whenReady().then(function(){setTimeout(flush,0)},function(){})}catch(e){setTimeout(flush,0)}}
    return;
  }
  flush();emit(line);
}
var _fs=require("fs"),_path=require("path");
var _X_OK=(_fs.constants&&_fs.constants.X_OK)||1;
// xdg-open on a PATH string? Cached per PATH for 30 s: a click costs no stat
// calls, and a newly installed xdg-open is seen soon after.
var _onPath={};
function onPath(P){
  var c=_onPath[P],now=Date.now();
  if(c&&now-c.at<30000)return c.v;
  var v=false,d=String(P||"").split(":");
  for(var i=0;!v&&i<d.length;i++){
    if(d[i].charAt(0)!=="/")continue;
    var f=_path.join(d[i],"xdg-open");
    try{_fs.accessSync(f,_X_OK);v=!_fs.statSync(f).isDirectory()}catch(e){}
  }
  _onPath[P]={at:now,v:v};
  return v;
}
// The TOOL PATH to run the call with, or null = call the original untouched.
function widened(){
  var t=globalThis.__cdbToolPath;
  if(!t||typeof t.which!=="function"||t.startedPath()===null)return null;
  var P=process.env.PATH;
  if(typeof P!=="string"||onPath(P))return null;
  var x=t.which("xdg-open");
  if(!x)return null;
  var tp=t.toolPath();
  return typeof tp==="string"&&tp!==P&&tp.split(":").indexOf(_path.dirname(x))>=0?{path:tp,bin:x}:null;
}
var _said={};
function wrap(shell,name){
  var orig=shell[name];
  if(typeof orig!=="function"||orig.__cdbToolPathWrapped)return;
  var w=function(){
    var wp=null;
    try{wp=widened()}catch(e){wp=null}
    if(!wp)return orig.apply(this,arguments);
    if(!_said[name]){_said[name]=1;log(name+": xdg-open -> "+wp.bin+" (not on the narrowed PATH; the call runs with the system folders plus root-owned read-only folders)")}
    var had=Object.prototype.hasOwnProperty.call(process.env,"PATH"),saved=process.env.PATH;
    process.env.PATH=wp.path;
    try{return orig.apply(this,arguments)}
    finally{if(had)process.env.PATH=saved;else delete process.env.PATH}
  };
  w.__cdbToolPathWrapped=true;
  shell[name]=w;
}
try{
  var shell=require("electron").shell;
  if(shell){wrap(shell,"openExternal");wrap(shell,"openPath")}
}catch(e){log("openExternal hook failed: "+(e&&e.message))}
})();

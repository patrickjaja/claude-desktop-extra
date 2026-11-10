;(function __cdbProfileAppIdentity(){
// Per-profile window identity (issue #319). Embedded at the head of index.js by
// patches/core/fix_profile_app_identity.nim; runs before upstream's main code.
//
// Electron sets CHROME_DESKTOP from package.json `desktopName` before this
// script and reads it at every window construction (Wayland app_id / X11
// WM_CLASS = value minus ".desktop") and in app.{is,set,remove}As-
// DefaultProtocolClient. A named profile whose own .desktop file exists gets
// "<base>-<profile>.desktop", so taskbars group its windows under that file;
// the protocol-client calls keep running with the base name, so a named
// profile never takes over the system claude:// handler.
//
// The default profile (CLAUDE_PROFILE unset or "default"), invalid names and
// non-Linux return here before anything is required, replaced or written.
if(typeof process==="undefined"||process.platform!=="linux")return;
var profile=process.env.CLAUDE_PROFILE;
// Same charset the launcher enforces; "default" is the launcher's alias for unset.
if(typeof profile!=="string"||profile==="default"||!/^[A-Za-z0-9_-]+$/.test(profile))return;
var TAG="[profile-identity] ";
var queue=[];
function emit(line){try{(globalThis.__cdbDiag||console.log)(line)}catch(e){}}
function flush(){var q=queue;queue=null;for(var i=0;q&&i<q.length;i++)emit(q[i])}
// __cdbDiag (claude-patches.log) only exists once upstream's "ready" handler
// ran, and console.log is discarded by the official build: queue until then.
function log(m){var line=TAG+m;if(queue&&typeof globalThis.__cdbDiag!=="function"){queue.push(line);return}flush();emit(line)}
try{
var electron=require("electron"),app=electron.app;
try{app.whenReady().then(function(){setTimeout(flush,0)},function(){})}catch(e){setTimeout(flush,0)}
var base=process.env.CHROME_DESKTOP;
log("named profile '"+profile+"', CHROME_DESKTOP="+base);
if(typeof base!=="string"||!/^[A-Za-z0-9._-]+\.desktop$/.test(base)||typeof app.setDesktopName!=="function"){
log("bad base desktop name "+JSON.stringify(base)+" - identity unchanged");return}
var want=base.slice(0,-8)+"-"+profile+".desktop";
var fs=require("fs"),path=require("path"),os=require("os");
// Desktop entry spec: Hidden=true means "deleted"; desktops ignore the file and
// it masks same-id files in later dirs. Read at most 64 KiB; on any read error
// the file counts as present (visible).
function isHidden(f){var fd=null;try{fd=fs.openSync(f,"r");var b=Buffer.alloc(65536);
var n=fs.readSync(fd,b,0,b.length,0);return /^\s*Hidden\s*=\s*true\s*$/m.test(b.toString("utf8",0,n))}
catch(e){return false}finally{if(fd!==null)try{fs.closeSync(fd)}catch(e){}}}
// XDG spec: an unset, empty or relative XDG_DATA_HOME is invalid and the default applies.
var dataHome=process.env.XDG_DATA_HOME;
if(!dataHome||!path.isAbsolute(dataHome))dataHome=path.join(process.env.HOME||os.homedir(),".local","share");
var dirs=[dataHome].concat((process.env.XDG_DATA_DIRS||"/usr/local/share:/usr/share").split(":"));
var found=null,hidden=null;
for(var i=0;i<dirs.length&&!found&&!hidden;i++){
var d=dirs[i];if(!d||!path.isAbsolute(d))continue;
var f=path.join(d,"applications",want);
try{if(fs.statSync(f).isFile()){if(isHidden(f))hidden=f;else found=f}}catch(e){}}
if(!found){log("no "+want+" in XDG applications dirs - identity unchanged ("+base+")"+
(hidden?"; "+hidden+" has Hidden=true (entry deleted in a menu editor), which masks later dirs":""));return}
var setName=app.setDesktopName;
function setTo(v){
if(v===undefined)delete process.env.CHROME_DESKTOP;else process.env.CHROME_DESKTOP=v;
if(v!==undefined)setName.call(app,v)}
["isDefaultProtocolClient","setAsDefaultProtocolClient","removeAsDefaultProtocolClient"].forEach(function(k){
var orig=app[k];if(typeof orig!=="function")return;
app[k]=function(){
var prev=process.env.CHROME_DESKTOP;
setTo(base);
try{return orig.apply(this,arguments)}finally{setTo(prev)}}});
setTo(want);
log("switched to "+want+" ("+found+"); protocol-client calls keep "+base);
}catch(e){log("init failed: "+(e&&e.message))}
})();

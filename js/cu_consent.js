(function(){
// ── Computer Use: ask before controlling an app (regular-mode Linux) ─────────
// Settings -> Extra -> Cowork (Linux) -> "Ask before Computer Use controls an
// app", read through globalThis.__cdbCuAskBeforeControl() (js/
// extra_settings_main.js; on by default, only an explicit false is off).
//
// Scope: the Code-session tool handler of the regular executor mode (x11 /
// wlroots / gnome / background display), js/cu_handler_injection.js. Sessions
// that upstream dispatches itself - kwin mode, cloud Cowork / Dispatch, teach
// mode - are upstream's consent: upstream passes its own allowlist to the
// executor there, and the executor masks screenshots by it whatever this
// switch says (js/cu_linux_executor.js "Allowlist mask"). Sub-patch 6b
// (upstream's grants at level "full" in regular mode) also applies whatever
// this switch says, teach mode's grants included.
//
// Switch on, every Code session in regular mode:
//   - request_access and list_granted_applications fall through to upstream's
//     own handleToolCall (js/cu_handler_injection.js): the approval card, the
//     grants stored on the session, the teach-mode and scheduled-run refusals,
//     and upstream's "not wired with a permission handler" refusal for a
//     session without a card (then every other tool is refused here too:
//     nothing is granted). 6c lets upstream's terminal / file-manager warnings
//     see our canonical app ids.
//   - every other tool is checked here against the session's grants with
//     upstream's rules (gate() below): nothing before a grant; on a session
//     with a hit test (capabilitiesNow().hitTest "native": X11, an X11
//     background display, sway / Hyprland) the app under the pointer and the
//     app in front; on the others only the app in front, where the backend can
//     tell it. A held left button (left_mouse_down) makes every pointer move a
//     drag, checked like a click. Apps are matched by canonical id only.
//   - screenshot and zoom always carry the approved ids to the executor, which
//     decides: masked, refused (it could not tell or could not mask), or the
//     whole screen where the backend cannot mask at all; the result says which
//     (masked / filtering) and the model is told when it was the whole screen.
// Switch off, and kwin mode (upstream dispatches there): nothing here
// applies - active() is false, text() and key() are "".
//
// Tool descriptions (fix_computer_use_linux.nim 13a/13b/13b.linux/13e/13f/13g)
// read text(k), and the tools/list cache key (15b) appends key(), so a flip of
// the switch or of the session's capabilities rebuilds the list. The list is
// shared by every session, which is why active() does not depend on the
// session: the descriptions hold for every Code session.
if(process.platform!=="linux"||globalThis.__cdbCuConsent)return;
var SCREEN="com.anthropic.cu.screen";
function ex(){return globalThis.__linuxExecutor||null}
function switchOn(){try{var f=globalThis.__cdbCuAskBeforeControl;return typeof f==="function"?f()!==!1:!0}catch(e){return!0}}
function on(){return!globalThis.__cuKwinMode&&switchOn()}
function active(s){return on()}
// The live executor's capabilities, reduced to what the rules and texts use.
function caps(){
  var c=null,e=ex();
  try{c=e&&typeof e.capabilitiesNow==="function"?e.capabilitiesNow():null}catch(err){c=null}
  c=c||{};
  var gaps=c.screenshotFiltering==="mask"&&Array.isArray(c.screenshotMaskGaps)?c.screenshotMaskGaps.filter(function(g){return typeof g==="string"&&g}):[];
  return{filtering:c.screenshotFiltering==="mask"?"mask":"none",gaps:gaps,hitTest:c.hitTest==="native"?"native":"none",frontmost:c.frontmost==="native"?"native":"none",host:typeof c.hostBundleId==="string"?c.hostBundleId:"",backend:typeof c.backend==="string"?c.backend:""};
}
function mode(){var c=caps();return{consent:on(),filtering:c.filtering,gaps:c.gaps,hitTest:c.hitTest,frontmost:c.frontmost,backend:c.backend}}
function key(){var m=mode();return m.consent?"cu-ask:"+m.filtering+":"+m.hitTest+":"+m.frontmost+(m.gaps.length?":"+m.gaps.join(","):""):""}
// What the mask does not cover (wlroots-bridge doctor screenshot_mask_gaps).
var GAP_NAMES={popups:"popup menus",layer_shell_top_overlay:"panels and overlays",xwayland_unmanaged:"XWayland menus and tooltips"};
function gapText(g){return g.map(function(x){return GAP_NAMES[x]||x.replace(/_/g," ")}).join(", ")}
function gapSentence(m){return m.gaps.length?"The covering is approximate here: "+gapText(m.gaps)+" can still show over or next to the approved windows. ":""}
function shotSentence(m){
  return m.filtering==="mask"
    ?"Screenshots show only the approved apps' windows: everything else is covered by solid rectangles. "+gapSentence(m)
    :"On this session screenshots are not filtered: they show the whole screen, including apps the user did not approve. Leave those apps alone. ";
}
function inputSentence(m){
  if(m.hitTest==="native")return"Clicks, scrolls and drags on a window of an app that is not approved are refused, and so are typing and key presses while such an app is in front: bring an approved app forward with open_application first. ";
  if(m.frontmost==="native")return"This session cannot tell which window is under a point: clicks and keystrokes go to whatever is there, and they are refused while an app that is not approved is in front. Bring an approved app forward with open_application first. ";
  return"This session cannot tell which window is under a point or in front: clicks and keystrokes go to whatever is there, so keep to the approved apps. ";
}
// Description texts, "" when the switch does not apply (the patched site then
// keeps its switch-off text).
function text(k){
  var m=mode();
  if(!m.consent)return"";
  switch(k){
    case"access":return"The user approves the apps you name in request_access in an approval card; each approved app can be fully controlled (clicks, typing, key presses). "+shotSentence(m)+inputSentence(m);
    case"prefix":return"This computer is running Linux. The user approves the apps you name in request_access in an approval card. The file manager depends on the desktop environment (e.g. Nautilus on GNOME, Dolphin on KDE, Thunar on XFCE). ";
    case"input":
      if(m.hitTest==="native")return"The app under the pointer (for clicks) and the app in front (for typing and keys) must be approved for this session, or this tool returns an error and does nothing.";
      if(m.frontmost==="native")return"The app in front must be approved for this session, or this tool returns an error and does nothing; typing is refused while one of Claude's own windows has keyboard focus.";
      return"At least one app must be approved for this session, or this tool returns an error and does nothing.";
    case"screenshot":return m.filtering==="mask"
      ?"Take a screenshot of the primary display. Apps the user did not approve are covered by solid rectangles - their content is hidden, the rectangle only shows where the window is."+(m.gaps.length?" "+gapSentence(m).trim():"")
      :"Take a screenshot of the primary display. On this session screenshots are not filtered: all open windows are visible, including apps the user did not approve - do not act in those.";
    case"shotSuffix":return" Returns an error until the user has approved at least one app. The returned image is what subsequent click coordinates are relative to.";
    case"openApp":return"The app must be one the user approved for this session - call request_access first.";
  }
  return"";
}
// The session's grants (the screen pseudo-app dropped) and grant flags.
function grants(s){var g=[];try{g=s&&typeof s.getCuAllowedApps==="function"?s.getCuAllowedApps()||[]:[]}catch(e){g=[]}return(Array.isArray(g)?g:[]).filter(function(a){return a&&typeof a.bundleId==="string"&&a.bundleId!==SCREEN})}
function flags(s){var f=null;try{f=s&&typeof s.getCuGrantFlags==="function"?s.getCuGrantFlags():null}catch(e){f=null}return f&&typeof f==="object"?f:{}}
function norm(x){return String(x==null?"":x).trim().toLowerCase().replace(/\.desktop$/,"")}
function canon(x){try{var ids=globalThis.__cdbCuAppIds;var c=ids&&typeof ids.canon==="function"?ids.canon(x):null;return norm(c||x)}catch(e){return norm(x)}}
// The grant covering an app id (canonical, or an alias the app-id helper folds
// to it), or null. Never a display name or a window title: any window can
// call itself "Firefox".
function grantFor(id,list){
  if(typeof id!=="string"||!id.trim())return null;
  var c=canon(id),n=norm(id);
  for(var i=0;i<list.length;i++){var g=list[i];if(canon(g.bundleId)===c||norm(g.bundleId)===n)return g}
  return null;
}
function ids(s){var g=grants(s),out=[];for(var i=0;i<g.length;i++)if(out.indexOf(g[i].bundleId)<0)out.push(g[i].bundleId);return out}
function err(t){return{isError:!0,content:[{type:"text",text:t}]}}
function name(a){return a&&(a.displayName||a.bundleId)||"this app"}
function isHost(a,c){if(!a||!a.bundleId)return!1;if(c.host&&canon(a.bundleId)===canon(c.host))return!0;try{var h=globalThis.__cdbCuAppIds&&globalThis.__cdbCuAppIds.hostId&&globalThis.__cdbCuAppIds.hostId();return!!h&&canon(a.bundleId)===canon(h)}catch(e){return!1}}
var NONE_GRANTED="No applications are granted for this session. Call request_access first.";
// Tools that work before the first grant (upstream's own exemptions).
var FREE={request_access:1,request_teach_access:1,list_granted_applications:1,list_apps:1,app_release:1,request_full_control:1,release_full_control:1,teach_step:1,teach_batch:1};
// ── System key combos (the systemKeyCombos grant flag) ──
// Upstream's Linux list and its matcher (the bundle's FMr.linux set and JMr:
// a modifier with a non-printable key, the modifiers alone, every key with
// all modifiers, every key with the modifiers pressed before it), on tokens
// normalized the way the bridges and the ydotool path read a key spec
// (x11-bridge / wlroots-bridge DESIGN.md "Key-spec grammar"): case-insensitive,
// `_` dropped, an X `XK_` prefix dropped, keysym and evdev modifier names
// (Super_L, Meta_R, Hyper_L, leftmeta, Control_R, ...) folded to the four
// modifiers. On top of upstream's list: any XF86 keysym (power, sleep,
// launchers), SysRq, a numeric token (a raw evdev code on the ydotool path),
// and Super pressed with no other key (opens the launcher / overview).
var SYS=(function(){
  var s=["alt+f11","meta","ctrl+alt+delete","ctrl+alt+backspace","meta+l","ctrl+alt+l","shift+meta+e","alt+f4","ctrl+q","shift+meta+q","ctrl+alt+escape","alt+tab","alt+shift+tab","meta+tab","shift+meta+tab","alt+escape","alt+shift+escape","ctrl+alt+tab","ctrl+alt+shift+tab","meta+a","meta+s","meta+w","meta+g","meta+v","meta+m","meta+n","meta+d","ctrl+alt+d","ctrl+escape","meta+home","meta+end","alt+f2","alt+space","alt+f1","alt+f3","meta+space","meta+r","ctrl+alt+t","meta+enter","meta+return","meta+e"],i;
  for(i=1;i<=12;i++){s.push("ctrl+alt+f"+i);s.push("ctrl+f"+i)}
  ["left","right","up","down"].forEach(function(k){s.push("ctrl+alt+"+k,"ctrl+alt+shift+"+k)});
  ["left","right","pageup","pagedown"].forEach(function(k){s.push("meta+"+k,"shift+meta+"+k)});
  for(i=0;i<10;i++){s.push("meta+"+i,"shift+meta+"+i)}
  var o=Object.create(null);s.forEach(function(k){o[k]=1});return o;
})();
// Upstream's modifier names, then the keysym / evdev / xdotool spellings (after
// `_` is dropped: super_l -> superl).
var MODS={meta:"meta",super:"meta",command:"meta",cmd:"meta",windows:"meta",win:"meta",ctrl:"ctrl",control:"ctrl",lctrl:"ctrl",lcontrol:"ctrl",rctrl:"ctrl",rcontrol:"ctrl",shift:"shift",lshift:"shift",rshift:"shift",alt:"alt",option:"alt",
  superl:"meta",superr:"meta",metal:"meta",metar:"meta",hyper:"meta",hyperl:"meta",hyperr:"meta",lwin:"meta",rwin:"meta",lsuper:"meta",rsuper:"meta",lmeta:"meta",rmeta:"meta",leftmeta:"meta",rightmeta:"meta",leftsuper:"meta",rightsuper:"meta",mod4:"meta",
  controll:"ctrl",controlr:"ctrl",ctrll:"ctrl",ctrlr:"ctrl",leftctrl:"ctrl",rightctrl:"ctrl",leftcontrol:"ctrl",rightcontrol:"ctrl",
  altl:"alt",altr:"alt",lalt:"alt",ralt:"alt",leftalt:"alt",rightalt:"alt",mod1:"alt",opt:"alt",
  shiftl:"shift",shiftr:"shift",leftshift:"shift",rightshift:"shift"};
// Upstream's key names, then the bridges' aliases (page_up, Prior, ...).
var KEYS={esc:"escape",del:"delete"," ":"space","\t":"tab","\x1b":"escape","\x7f":"delete","\r":"enter","\b":"backspace",
  prior:"pageup",next:"pagedown",pgup:"pageup",pgdn:"pagedown",pgdown:"pagedown",kpenter:"enter",kpdelete:"delete",kpdel:"delete",kphome:"home",kpend:"end",kpprior:"pageup",kpnext:"pagedown",kppageup:"pageup",kppagedown:"pagedown",kpup:"up",kpdown:"down",kpleft:"left",kpright:"right",kptab:"tab",kpspace:"space",backspace:"backspace",linefeed:"enter",sysreq:"sysrq",printscreen:"print"};
var ORDER=["ctrl","alt","shift","meta"];
function normTok(e){
  if(e.length<2)return e;
  var t=e.replace(/^xk_/,"");
  return t.length>1?t.replace(/[_\s]/g,""):t;
}
function sortMods(m){var o=[];m.forEach(function(x){if(o.indexOf(x)<0)o.push(x)});return o.sort(function(a,b){return ORDER.indexOf(a)-ORDER.indexOf(b)})}
// Upstream's BK: {mods, keys, ordered} of one chord.
function parse(c){
  var ord=[];
  String(c).toLowerCase().split("+").forEach(function(n){
    var e=n.trim();
    if(e===""){if(n.length===1)e=n;else return}
    var k=normTok(e),m=MODS[k];
    if(m===void 0)ord.push({name:KEYS[k]||KEYS[e]||k,isMod:!1});else ord.push({name:m,isMod:!0});
  });
  return{mods:sortMods(ord.filter(function(t){return t.isMod}).map(function(t){return t.name})),keys:ord.filter(function(t){return!t.isMod}).map(function(t){return t.name}),ordered:ord};
}
function nonPrintable(k){return!/^[\x21-\x7e]+$/.test(k)}
function sysKey(k){return/^xf86/.test(k)||k==="sysrq"||/^[0-9]{2,}$/.test(k)}
function chordIsSystem(c){
  var p=parse(c),mods=p.mods,keys=p.keys,i;
  if(keys.some(sysKey))return!0;
  if(mods.length>0&&keys.some(nonPrintable))return!0;
  if(keys.length===0)return mods.indexOf("meta")>=0||SYS[mods.join("+")]===1;
  var pre=mods.length?mods.join("+")+"+":"";
  for(i=0;i<keys.length;i++)if(SYS[pre+keys[i]]===1)return!0;
  var held=[];
  for(i=0;i<p.ordered.length;i++){var t=p.ordered[i];if(t.isMod)held.push(t.name);else{var hm=sortMods(held);if(SYS[(hm.length?hm.join("+")+"+":"")+t.name]===1)return!0}}
  return!1;
}
// The whole text as one chord (the bridges trim around "+": "ctrl+alt+ delete"
// is ctrl+alt+delete) and each whitespace-separated chord (xdotool style).
function systemCombo(text){
  var s=String(text==null?"":text);
  if(!s.trim())return!1;
  if(chordIsSystem(s))return!0;
  return s.trim().split(/\s+/).some(function(c){return!!c&&chordIsSystem(c)});
}
// The app in front: refused unless approved; Claude's own window refuses
// keystrokes. null = nothing focused - allowed, as upstream does (U: no
// frontmost app = no app to protect; a key then reaches no client, and the
// system combos are checked on their own).
function refuseFront(o,kind,c,list){
  if(!o)return null;
  if(grantFor(o.bundleId,list))return null;
  if(isHost(o,c)){
    if(kind==="keyboard")return err("Claude's own window still has keyboard focus, so the keystrokes would land in it. Click on the target application first.");
    return null;
  }
  return err("\""+name(o)+"\" is not in the allowed applications and is currently in front. To work in this app, call request_access with \""+name(o)+"\" in the apps array. Otherwise, bring a granted app forward with open_application, or ask the user to close this app's window.");
}
// The app under a point. With a hit test, a click on Claude's own window is
// refused too (nothing of Claude's is ever a target).
function refusePoint(a,c,list){
  if(a===null)return err("The click would land on the desktop (panels, docks, desktop icons or the background), which is not an approved app and can launch other applications. Bring an approved app forward with open_application, or ask the user.");
  if(grantFor(a.bundleId,list))return null;
  if(isHost(a,c))return err("Could not verify the click target - the Claude window is at these coordinates. Bring an approved app forward and retry.");
  return err("Click at these coordinates would land on \""+name(a)+"\", which is not in the allowed applications. To work in this app, call request_access with \""+name(a)+"\" in the apps array. Otherwise, bring the app you meant to click forward with open_application.");
}
// The input gate. kind: "pointer" (points: root/screen pixels), "keyboard",
// "move". null = allowed, else a tool result to return.
async function gate(s,kind,points,opts){
  var list=grants(s);
  if(!list.length)return err(NONE_GRANTED);
  if(kind==="move")return null;
  var e=ex(),c=caps();
  if(!e)return null;
  if(kind==="keyboard"&&opts&&typeof opts.chord==="string"&&systemCombo(opts.chord)&&!flags(s).systemKeyCombos)
    return err("\""+opts.chord+"\" is a system-level shortcut. Request the `systemKeyCombos` grant via request_access to use it.");
  // A failed frontmost read is not "nothing in front": refuse (upstream's
  // check throws there too).
  var front=null;
  if(typeof e.getFrontmostApp==="function"){
    try{front=await e.getFrontmostApp()}
    catch(er){return err("Could not tell which app is in front ("+String(er&&er.message||er).trim().slice(0,200)+"), so nothing was sent. Take a screenshot and retry.")}
  }
  // No hit test: the host in front stands for the shared screen, which any grant covers.
  if(kind==="pointer"&&c.hitTest!=="native"&&isHost(front,c))front=null;
  var r=refuseFront(front,kind,c,list);
  if(r)return r;
  if(kind!=="pointer"||c.hitTest!=="native"||typeof e.appUnderPoint!=="function")return null;
  for(var i=0;i<(points||[]).length;i++){
    var p=points[i],a=null;
    try{a=await e.appUnderPoint(p[0],p[1])}catch(er){return err("Could not tell which app is at these coordinates, so nothing was sent. Take a screenshot and retry.")}
    r=refusePoint(a,c,list);
    if(r)return r;
  }
  return null;
}
function clipboard(s,which){
  var list=grants(s);
  if(!list.length)return err(NONE_GRANTED);
  var n=which==="read"?"clipboardRead":"clipboardWrite";
  return flags(s)[n]?null:err("Clipboard "+which+" is not granted. Request `"+n+"` via request_access.");
}
// open_application: the name resolved to its canonical id must be granted.
function openApp(s,app){
  var list=grants(s);
  if(!list.length)return err(NONE_GRANTED);
  var e=ex(),r=null;
  try{r=e&&typeof e.resolveApp==="function"?e.resolveApp(app):null}catch(er){r=null}
  if(grantFor(app,list)||(r&&grantFor(r.bundleId,list)))return null;
  return err("\""+app+"\" is not in the allowed applications. The target must already be granted - call request_access with \""+app+"\" in the apps array first.");
}
// The tool needs a grant first (upstream's empty-allowlist refusal)?
function needsGrant(s,tool){return FREE[tool]===1||grants(s).length?null:err(NONE_GRANTED)}
// Screenshot / zoom ids for the executor: always the approved ids (an array,
// even empty) - the executor decides whether it can mask, and says so on the
// result.
function shotIds(s){return ids(s)}
// One note per session and Computer Use lock, on the first capture the
// executor did not mask (result.masked !== true). Cleared when the lock is
// released (lockReleased, called by the executor), capped as a backstop.
var _noted=new Set(),NOTED_MAX=256;
function shotNote(s,res){
  if(res&&res.masked===!0)return null;
  var id=s&&s.sessionId!=null?String(s.sessionId):"";
  if(_noted.has(id))return null;
  if(_noted.size>=NOTED_MAX)_noted.clear();
  _noted.add(id);
  var names=grants(s).map(name);
  return"Note: screenshots on this session are not filtered - this one shows the whole screen, including apps the user did not approve. Act only in the approved apps"+(names.length?": "+names.join(", "):"")+".";
}
function lockReleased(){_noted.clear()}
// The accessibility tools' grant check (js/cu_ax_tools.js opts.allowedApps /
// opts.tier). Not opts.ctx: that is upstream's dispatch context (kwin mode).
function axOpts(s){
  var list=grants(s);
  return{allowedApps:list,tier:function(id){return grantFor(id,list)?null:{error:err("\""+id+"\" is not in the allowed applications. Call request_access with it in the apps array first.")}}};
}
function diag(m){try{var d=globalThis.__cdbDiag;if(typeof d==="function")d(m)}catch(e){}}
// ── What upstream tells the model and the UI about per-app access ──
// Upstream describes its own Wayland portal executor: one shared screen, the
// most permissive tier for all of it, screenshots of everything, and refusals
// while one of its dialogs is open. Our bridges differ per backend, so two of
// its answers come from here (fix_computer_use_linux.nim 16a / 16b / 16d):
//   spSuffix()   the system-prompt suffix after the tier rules (local Cowork
//                computer_use / cu_only sections, the session server's
//                request_access result, the canUseTool deny message), on every
//                Linux session in regular mode: "" in kwin mode (per-app,
//                upstream's own rules hold), else what the live backend does.
//   __cdbCuSharedScreen()  true = upstream's "shares the whole screen" answer
//                (computerUsePerAppAccess unsupported, the "Entire screen"
//                pseudo-grant). False in kwin mode; else true unless "Ask
//                before Computer Use controls an app" is on AND the capture
//                bridge masks (mask with gaps counts). Exec-free: it runs on
//                every supported-features build (#184), so it reads the
//                executor's capabilities getter (cached doctor), never
//                capabilitiesNow() (which may run pgrep).
var SP_OFF="\n\nOn this system (Linux) the apps you name are not checked before you act: screenshots show the whole screen, including apps the user did not ask for, and clicks and keystrokes go to whatever is under them. Act only in the apps the user asked for and leave everything else alone.";
function spSuffix(){
  var kw=!!globalThis.__cuKwinMode,m=kw?null:mode(),s;
  if(kw)s="";
  else if(!m.consent)s=SP_OFF;
  else s=("\n\nOn this system (Linux) every app the user approves is granted at tier \"full\", whatever its category. "+shotSentence(m)+inputSentence(m)).replace(/\s+$/,"");
  diag("[claude-cu] prompt suffix: "+(kw?"kwin mode (upstream's per-app rules, no suffix)":!m.consent?"ask-before-control off (apps not checked)":"screenshots "+(m.filtering==="mask"?"masked"+(m.gaps.length?" (gaps: "+m.gaps.join(",")+")":""):"unfiltered")+", hit test "+m.hitTest+", frontmost "+m.frontmost+(m.backend?" ("+m.backend+")":"")));
  return s;
}
function waylandEnv(){var st=String(process.env.XDG_SESSION_TYPE||"");return st?st==="wayland":!!process.env.WAYLAND_DISPLAY}
function sharedScreen(){
  try{
    if(globalThis.__cuKwinMode)return!1;
    var e=ex(),f=e&&e.capabilities?e.capabilities.screenshotFiltering:"none";
    return!(switchOn()&&f==="mask");
  }catch(err){return waylandEnv()}
}
// The answer last handed to upstream (undefined before the first features
// build) and the last one logged. A change after that first build re-signals
// the renderer through upstream's own supported-features broadcast (16c,
// globalThis.__cdbCuFeaturesChanged), so the UI does not keep the answer from
// before the doctor replied or the background display / switch changed.
var _ssLast,_ssLogged;
globalThis.__cdbCuSharedScreen=function(){
  var v=sharedScreen();
  _ssLast=v;
  if(v!==_ssLogged){_ssLogged=v;diag("[claude-cu] per-app access: "+(v?"whole shared screen (unsupported)":"per app (supported)"))}
  return v;
};
// "Entire screen" pseudo-grant (16d): upstream adds it on Wayland, at the most
// permissive tier of the grants, as if the whole screen were one app. Left out
// (true here) in kwin mode (per app) and whenever "Ask before Computer Use
// controls an app" is on in regular mode: our gate refuses unapproved apps, so
// a listed whole-screen grant would mislead the model. This only removes the
// pseudo-grant; with the switch off upstream's own rule decides.
var _ngLogged;
globalThis.__cdbCuNoScreenGrant=function(){
  var v;
  try{v=!!globalThis.__cuKwinMode||switchOn()}catch(e){v=!1}
  if(v!==_ngLogged){_ngLogged=v;diag("[claude-cu] \"Entire screen\" grant: "+(v?"left out (per-app rules apply)":"upstream's rule"))}
  return v;
};
function capChanged(why){
  diag("[claude-cu] per-app access check ("+why+")");
  if(_ssLast===void 0)return!1;
  var v=sharedScreen();
  if(v===_ssLast)return!1;
  var f=globalThis.__cdbCuFeaturesChanged;
  if(typeof f!=="function"){diag("[claude-cu] per-app access changed to "+(v?"unsupported":"supported")+" ("+why+"), but upstream's features broadcast is not captured");return!1}
  _ssLast=v;
  diag("[claude-cu] per-app access changed to "+(v?"unsupported":"supported")+" ("+why+") - re-signalling the renderer");
  try{f()}catch(err){diag("[claude-cu] features re-signal failed: "+(err&&err.message||err));return!1}
  return!0;
}
globalThis.__cdbCuConsent={active:active,mode:mode,key:key,text:text,grants:grants,ids:ids,grantFor:grantFor,gate:gate,clipboard:clipboard,openApp:openApp,needsGrant:needsGrant,shotIds:shotIds,shotNote:shotNote,lockReleased:lockReleased,axOpts:axOpts,systemCombo:systemCombo,spSuffix:spSuffix,capChanged:capChanged,_notedSize:function(){return _noted.size}};
})();

if(process.platform==="linux"){__cdbLx:{
// Per-call compliance deny (parity with upstream's handleToolCall preamble, which this Linux
// block returns before). Patch 11 publishes the captured HIPAA gate; unset (older shapes) = no check.
if(typeof globalThis.__cdbCuHipaa==="function"&&globalThis.__cdbCuHipaa()){(globalThis.__cdbDiag||console.log)("[claude-cu] tool call denied: organization compliance settings");return{isError:!0,content:[{type:"text",text:"Computer Use isn't available under your organization's compliance settings. If you recently switched organizations, restart the app."}]}}
// Background display (issue #300): while its setting is invalid or the display
// is down every tool returns the executor's refusal (never the user's desktop);
// teach mode is refused there (its overlay draws on the desktop).
if(globalThis.__linuxExecutor&&typeof globalThis.__linuxExecutor.__targetCheck==="function"){var __tgm=await globalThis.__linuxExecutor.__targetCheck(__TOOL_NAME__);if(__tgm){(globalThis.__cdbDiag||console.log)("[claude-cu] tool call refused ("+__TOOL_NAME__+"): "+__tgm);return{isError:!0,content:[{type:"text",text:__tgm}]}}}
var __lxTeachTools=["request_teach_access","teach_step","teach_batch"];
if(__lxTeachTools.indexOf(__TOOL_NAME__)>=0){const __n=__MAKE_DISPATCH__;const{save_to_disk:__sd,...__s}=__INPUT__;return await __n(__TOOL_NAME__,__s)}
// "Ask before Computer Use controls an app" (js/cu_consent.js; on by default):
// request_access and list_granted_applications leave this block (break) and
// run upstream's own handleToolCall below it - its approval card, its stored
// grants, its teach-mode and scheduled-run refusals (and its "not wired with a
// permission handler" refusal for a session without a card). Every other tool
// is checked against those grants. Off: __ask is false and everything below
// is as before for this Code-session path (upstream's own dispatch - teach,
// cloud Cowork - passes its allowlist to the executor whatever the switch).
var __cc=globalThis.__cdbCuConsent,__ask=!!(__cc&&typeof __cc.active==="function"&&__cc.active(__SESSION__));
if(__ask&&(__TOOL_NAME__==="request_access"||__TOOL_NAME__==="list_granted_applications"))break __cdbLx;
if(__ask){var __ng=__cc.needsGrant(__SESSION__,__TOOL_NAME__);if(__ng)return __ng}
// Upstream refuses an ungranted clipboard or app before it looks at the lock;
// so does this block (both checks are pure).
if(__ask){var __pg=__TOOL_NAME__==="read_clipboard"?__cc.clipboard(__SESSION__,"read"):__TOOL_NAME__==="write_clipboard"?__cc.clipboard(__SESSION__,"write"):__TOOL_NAME__==="open_application"?__cc.openApp(__SESSION__,__INPUT__.app||__INPUT__.application||""):null;if(__pg)return __pg}
// The exclusive Computer Use lock, checked and taken the way upstream's own
// dispatcher does it (this block returns before that dispatcher runs). Another
// session holding it refuses every tool here; the first tool that upstream does
// not exempt takes it; the session's turn end releases it (upstream). The lock
// change starts what follows it: the GNOME portal session, the Escape stop key,
// the glow, the side panel. Exempt: the access tools, wait, switch_display and
// a batch of only those two. The app-scoped tools (here: the accessibility
// tools) only check for another holder, as upstream's own do. A sub-action of
// our computer_batch runs under the batch's lock (upstream takes it once per
// batch). A session without the lock functions is not locked (as upstream).
// The texts are upstream's (pinned by scripts/tests/linux/test-cu-code-tab-lock.mjs).
var __lkS=__SESSION__,__lkSubs=globalThis.__cdbCuBatchSubs||(globalThis.__cdbCuBatchSubs=new WeakSet());
if(__lkS&&typeof __lkS.checkCuLock==="function"&&!(__INPUT__&&typeof __INPUT__==="object"&&__lkSubs.has(__INPUT__))){
  var __LK_HELD="Another Claude session is currently using the computer. Wait for the user to acknowledge it is finished (stop button in the Claude window), or find a non-computer-use approach if one is readily apparent.";
  var __LK_LOST="Another Claude session is currently using the computer. Wait for that session to finish, or find a non-computer-use approach.";
  var __lkAppTools=["app_release","request_full_control","release_full_control","app_list_windows","app_screenshot","app_zoom","app_ax_find","app_click","app_scroll","app_drag","app_type","app_key","app_menu","app_batch","app_bring_to_current_space","app_focus"];
  var __lkFree=["request_access","request_teach_access","list_granted_applications","list_apps","wait","switch_display"];
  var __lkActs=__INPUT__&&__INPUT__.actions;
  var __lkReadOnlyBatch=__TOOL_NAME__==="computer_batch"&&Array.isArray(__lkActs)&&__lkActs.length>0&&__lkActs.every(function(a){return a&&typeof a==="object"&&(a.action==="wait"||a.action==="switch_display")});
  var __lkR=await(typeof __lkS.checkCuExclusiveLock==="function"?__lkS.checkCuExclusiveLock():__lkS.checkCuLock());
  var __lkApp=__lkAppTools.indexOf(__TOOL_NAME__)>=0;
  if(__lkR&&__lkR.holder!==void 0&&!__lkR.isSelf&&!(__lkApp&&__TOOL_NAME__==="app_release")){(globalThis.__cdbDiag||console.log)("[claude-cu] tool call refused ("+__TOOL_NAME__+"): the Computer Use lock is held by another session");return{isError:!0,content:[{type:"text",text:__LK_HELD}]}}
  if(!__lkApp){
    if(__lkR&&__lkR.holder===void 0&&!(__lkFree.indexOf(__TOOL_NAME__)>=0||__lkReadOnlyBatch)){
      // A turn that already ended (Stop, or a call arriving after the turn's
      // result) never takes the lock: no turn end would release it again.
      // Synchronous with the acquire below (both sessions' acquires are), so a
      // Stop cannot land in between. Upstream's own "stopped" test and wording.
      if(typeof __lkS.isAborted==="function"&&__lkS.isAborted()===!0){(globalThis.__cdbDiag||console.log)("[claude-cu] tool call refused ("+__TOOL_NAME__+"): the turn has ended, the Computer Use lock is not taken");return{isError:!0,content:[{type:"text",text:__TOOL_NAME__+" aborted (user interrupt)."}]}}
      if(typeof __lkS.acquireCuLock==="function")await __lkS.acquireCuLock();
      var __lkE=await __lkS.checkCuLock();
      if(!__lkE||!__lkE.isSelf)return{isError:!0,content:[{type:"text",text:__lkE&&__lkE.holder!==void 0?__LK_HELD:__LK_LOST}]};
      // Upstream releases a held mouse button at a lock change (only acted on
      // with the ask-before-control switch on, like every held-button step here).
      if(__ask&&globalThis.__cuMouseHeld===!0){try{await globalThis.__linuxExecutor.mouseUp();globalThis.__cuMouseHeld=!1}catch(__me){(globalThis.__cdbDiag||console.log)("[claude-cu] could not release the held mouse button at the lock change: "+(__me&&__me.message||__me))}}
      // The executor's lock hook (portal session start, background display
      // latch) settles before the turn's first action runs.
      try{var __lkX=globalThis.__linuxExecutor;if(__lkX&&typeof __lkX.__lockSettled==="function")await __lkX.__lockSettled()}catch(__le){}
      // The turn ended while that ran (a GNOME consent dialog can take long):
      // the action does not run. The lock was held when the turn ended, so the
      // turn end released it (upstream releases this session's hold there).
      if(typeof __lkS.isAborted==="function"&&__lkS.isAborted()===!0)return{isError:!0,content:[{type:"text",text:__TOOL_NAME__+" aborted (user interrupt)."}]};
    }
  }
}
if(__TOOL_NAME__==="request_access"){var __apps=__INPUT__.apps||[];
  // Dedup grants by a normalized key so multiple spellings of one app
  // (e.g. "Sublime Text" and "sublime_text") collapse to a single grant.
  // Normalize the way our window bundle_id derivation does (lowercase, strip a
  // trailing ".desktop") plus collapse space/underscore/hyphen runs so the two
  // spellings map together. First occurrence wins — its original string is kept
  // as bundleId/displayName so list_granted_applications and open_application
  // matching stay consistent with what the model was told.
  function __grantKey(a){return String(a==null?"":a).trim().toLowerCase().replace(/\.desktop$/,"").replace(/[\s_-]+/g,"")}
  var __granted=[],__gseen={};
  for(var __gi=0;__gi<__apps.length;__gi++){var __ga=__apps[__gi],__gk=__grantKey(__ga);if(!__gk||__gseen[__gk])continue;__gseen[__gk]=!0;__granted.push({bundleId:__ga,displayName:__ga,grantedAt:Date.now(),tier:"full"})}
  return{content:[{type:"text",text:JSON.stringify({granted:__granted,denied:[],screenshotFiltering:"none"})}]}}
var ex=globalThis.__linuxExecutor;
if(!ex)return{content:[{type:"text",text:"Linux executor not initialized"}],isError:!0};
globalThis.__cuActiveOrigin=globalThis.__cuActiveOrigin||{x:0,y:0};
// __cuLastShot records the geometry of the most recent full-screen screenshot so
// input coordinates (which the CU protocol defines as image pixels relative to
// that screenshot) can be mapped to root/screen pixels, and cursor_position can
// be mapped back. imgW/imgH = emitted (possibly downscaled) image size;
// dispW/dispH = the display's native size; originX/originY = display origin.
// Null until the first screenshot — then transforms fall back to origin-only.
globalThis.__cuLastShot=globalThis.__cuLastShot||null;
// Model image-pixel coord -> root/screen pixel. Uses the last screenshot's
// image:display ratio + origin. Falls back to __cuActiveOrigin (origin only,
// 1:1 scale) when no screenshot has been taken yet.
function __txC(c){
  var ix=c[0]||0,iy=c[1]||0,ls=globalThis.__cuLastShot;
  if(ls&&ls.imgW>0&&ls.imgH>0){
    return[Math.round(ls.originX+ix*(ls.dispW/ls.imgW)),Math.round(ls.originY+iy*(ls.dispH/ls.imgH))];
  }
  var o=globalThis.__cuActiveOrigin;
  return[Math.round(ix+(o?o.x:0)),Math.round(iy+(o?o.y:0))];
}
// Root/screen pixel -> model image-pixel coord (inverse of __txC), for
// cursor_position, which the schema says returns image-pixel coordinates.
function __untxC(x,y){
  var rx=x||0,ry=y||0,ls=globalThis.__cuLastShot;
  if(ls&&ls.dispW>0&&ls.dispH>0){
    return[Math.round((rx-ls.originX)*(ls.imgW/ls.dispW)),Math.round((ry-ls.originY)*(ls.imgH/ls.dispH))];
  }
  var o=globalThis.__cuActiveOrigin;
  return[Math.round(rx-(o?o.x:0)),Math.round(ry-(o?o.y:0))];
}
// Teach mode (teach_step/teach_batch) is NOT handled here — the top-of-handler
// __lxTeachTools branch forwards it to upstream's dispatch, which maps the
// anchor (and each step's action coordinates) with its own Eq() transform:
//   pixels-mode -> {x: round(ix*(displayWidth/width))+originX, ...}
// keyed on the session's lastScreenshot dims. Those dims are recorded ONLY when
// upstream itself takes a screenshot (onScreenshotCaptured). On Linux regular
// mode WE serve the screenshot (below), so upstream never sees the dims and Eq
// silently falls back to `ix/scaleFactor+originX` — no downsample compensation,
// so with our 1.15MP downscale every teach tooltip lands off by the scale ratio.
// __syncUpstreamShotDims feeds our screenshot geometry into that session state
// via the raw session's onCuScreenshotDimsUpdated setter (mapped to
// getLastScreenshotDims), so Eq's pixels branch reproduces __txC exactly:
// displayWidth/width == dispW/imgW, originX == originX. This makes teach anchors
// and teach action coordinates land identically to our click path.
// switch_display's pin, shared with the accessibility tools (app_ax_find makes
// the display holding the searched window current): the next screenshot, zoom
// and click use display d; the old screenshot geometry is dropped.
function __pinDisplay(d){globalThis.__cuPinnedDisplay=d.displayId;globalThis.__cuActiveOrigin={x:d.originX||0,y:d.originY||0};globalThis.__cuLastShot=null;__syncUpstreamShotDims(void 0)}
function __syncUpstreamShotDims(dims){
  try{if(__SESSION__&&typeof __SESSION__.onCuScreenshotDimsUpdated==="function")__SESSION__.onCuScreenshotDimsUpdated(dims)}catch(e){}
}
// The grant gate for one input action (null = allowed). kind: "pointer" with
// root/screen points, "keyboard" (opts.chord for key combos), "move".
async function __gate(kind,pts,opts){return __ask?await __cc.gate(__SESSION__,kind,pts,opts):null}
async function __cursorPt(){var __cu=await ex.getCursorPosition();return[__cu.x,__cu.y]}
// The held left button (left_mouse_down .. left_mouse_up), process-wide like
// upstream's own flag: the pointer is one device. Tracked whatever the switch
// says; only acted on with it on. While held, a mouse_move drags whatever is
// under the pointer, so it is checked like a click at its target; the release
// is checked at the cursor and the button is released even when refused (as
// upstream does). A click or a drag releases a held button first (upstream).
function __held(){return globalThis.__cuMouseHeld===!0}
function __setHeld(v){globalThis.__cuMouseHeld=v===!0}
async function __relHeld(){if(__ask&&__held()){try{await ex.mouseUp()}catch(e){}__setHeld(!1)}}
var __actionTools=new Set(["left_click","right_click","double_click","triple_click","middle_click","left_click_drag","mouse_move","scroll","key","type","hold_key","left_mouse_down","left_mouse_up","computer_batch"]);
// Background display: a failed tool may mean the display went away - the
// executor re-checks it and, when down, the not-running refusal replaces the
// raw bridge error (and refuses every following call until it answers).
async function __tgtErr(err){try{if(ex.__targetAfterError){var m=await ex.__targetAfterError(err);if(m){(globalThis.__cdbDiag||console.log)("[claude-cu] tool call refused ("+__TOOL_NAME__+"): "+m);return{isError:!0,content:[{type:"text",text:m}]}}}}catch(e){}return null}
// X11 with a hit test (x11-bridge): Claude's windows stay clickable for the
// user (Stop in the docked panel) and the model's pointer input that would land
// on one is refused instead, with upstream's own refusal for that case (its
// click gate does the same for cloud sessions). The hit test looks through
// Claude's click-through overlays (glow, teach). Elsewhere (Wayland, X11
// without a hit test) Claude's windows are made click-through around the
// action as before; its overlays (not focusable) are click-through already and
// are left alone.
function __x11Hit(){var st=String(process.env.XDG_SESSION_TYPE||"").toLowerCase(),wl=st==="wayland"?!0:st==="x11"?!1:!!process.env.WAYLAND_DISPLAY;var c=ex.capabilities;return !wl&&!(ex.__targetActive&&ex.__targetActive())&&!!c&&c.hitTest!=="none"&&typeof ex.appUnderPoint==="function"}
async function __selfHit(pts){if(!__x11Hit())return null;var host=ex.capabilities.hostBundleId;for(var __si=0;__si<pts.length;__si++){var __sp=pts[__si];if(!__sp)continue;var __sa=null;try{__sa=await ex.appUnderPoint(__sp[0],__sp[1])}catch(__se){__sa=null}if(__sa&&host&&__sa.bundleId===host){(globalThis.__cdbDiag||console.log)("[claude-cu] tool call refused ("+__TOOL_NAME__+"): the target is a Claude window");return{isError:!0,content:[{type:"text",text:"Could not verify the click target \u2014 the Claude overlay intercepted the hit test. Retry."}]}}}return null}
async function __hideWindows(fn){if(ex.__targetActive&&ex.__targetActive())return await fn();if(__x11Hit())return await fn();var __bws=require("electron").BrowserWindow.getAllWindows().filter(function(w){return!w.isDestroyed()&&(typeof w.isFocusable!=="function"||w.isFocusable())});for(var __i=0;__i<__bws.length;__i++)__bws[__i].setIgnoreMouseEvents(true);try{await new Promise(function(r){setTimeout(r,50)});return await fn()}finally{for(var __i=0;__i<__bws.length;__i++){if(!__bws[__i].isDestroyed())__bws[__i].setIgnoreMouseEvents(false)}}}
// Accessibility tools (issue #306, js/cu_ax_tools.js): only while their switch
// is on (__cdbAxHandles), otherwise these names fall through as before.
if(typeof globalThis.__cdbAxHandles==="function"&&globalThis.__cdbAxHandles(__TOOL_NAME__)){try{return await globalThis.__cdbAxCall(__TOOL_NAME__,__INPUT__,Object.assign({sid:__SESSION__&&__SESSION__.sessionId,pin:__pinDisplay,sync:__syncUpstreamShotDims},__ask?__cc.axOpts(__SESSION__):{}))}catch(err){return(await __tgtErr(err))||{content:[{type:"text",text:"Error: "+(err&&err.message||err)}],isError:!0}}}
if(__actionTools.has(__TOOL_NAME__)){try{return await __hideWindows(async function(){switch(__TOOL_NAME__){
case"left_click":{await __relHeld();var __lc=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]),__g=await __selfHit([__lc])||await __gate("pointer",[__lc]);if(__g)return __g;await ex.click(__lc[0],__lc[1],"left",1);return{content:[{type:"text",text:"Clicked at ("+__lc[0]+","+__lc[1]+")"}]}}
case"right_click":{await __relHeld();var __rc=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]),__g=await __selfHit([__rc])||await __gate("pointer",[__rc]);if(__g)return __g;await ex.click(__rc[0],__rc[1],"right",1);return{content:[{type:"text",text:"Right clicked"}]}}
case"double_click":{await __relHeld();var __dc=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]),__g=await __selfHit([__dc])||await __gate("pointer",[__dc]);if(__g)return __g;await ex.click(__dc[0],__dc[1],"left",2);return{content:[{type:"text",text:"Double clicked"}]}}
case"triple_click":{await __relHeld();var __tc=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]),__g=await __selfHit([__tc])||await __gate("pointer",[__tc]);if(__g)return __g;await ex.click(__tc[0],__tc[1],"left",3);return{content:[{type:"text",text:"Triple clicked"}]}}
case"middle_click":{await __relHeld();var __mc=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]),__g=await __selfHit([__mc])||await __gate("pointer",[__mc]);if(__g)return __g;await ex.click(__mc[0],__mc[1],"middle",1);return{content:[{type:"text",text:"Middle clicked"}]}}
case"type":{var __g=await __gate("keyboard");if(__g)return __g;await ex.type(__INPUT__.text||"",{viaClipboard:!1});return{content:[{type:"text",text:"Typed text"}]}}
case"key":{var __kc=__INPUT__.text||__INPUT__.key||"",__krep=__INPUT__.repeat||__INPUT__.count||1,__g=await __gate("keyboard",null,{chord:__kc});if(__g)return __g;await ex.key(__kc,__krep);return{content:[{type:"text",text:"Pressed key: "+__kc}]}}
case"scroll":{var __sc=__txC(__INPUT__.coordinate||[__INPUT__.x||0,__INPUT__.y||0]),__dir=__INPUT__.scroll_direction||__INPUT__.direction||"down",__amt=__INPUT__.scroll_amount!=null?__INPUT__.scroll_amount:(__INPUT__.amount!=null?__INPUT__.amount:3),__sv=__dir==="down"?__amt:__dir==="up"?-__amt:0,__sh=__dir==="right"?__amt:__dir==="left"?-__amt:0,__g=await __selfHit([__sc])||await __gate("pointer",[__sc]);if(__g)return __g;await ex.scroll(__sc[0],__sc[1],__sh,__sv);return{content:[{type:"text",text:"Scrolled "+__dir}]}}
case"left_click_drag":{await __relHeld();var __dsc=__INPUT__.start_coordinate?__txC(__INPUT__.start_coordinate):null,__den=__txC(__INPUT__.coordinate),__dsh=await __selfHit([__dsc||(__x11Hit()?await __cursorPt():null),__den]);if(__dsh)return __dsh;if(__ask){var __g=await __gate("pointer",[__dsc||await __cursorPt(),__den]);if(__g)return __g}await ex.drag(__dsc?{x:__dsc[0],y:__dsc[1]}:void 0,{x:__den[0],y:__den[1]});__setHeld(!1);return{content:[{type:"text",text:"Dragged"}]}}
case"mouse_move":{var __mv=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]),__g=(__held()?await __selfHit([__mv]):null)||await __gate(__held()?"pointer":"move",[__mv]);if(__g)return __g;await ex.moveMouse(__mv[0],__mv[1]);return{content:[{type:"text",text:"Moved to ("+__mv[0]+","+__mv[1]+")"}]}}
case"hold_key":{var __g=await __gate("keyboard",null,{chord:String(__INPUT__.text||__INPUT__.key||"")});if(__g)return __g;await ex.holdKey(__INPUT__.text||__INPUT__.key||"",__INPUT__.duration||.5);return{content:[{type:"text",text:"Held key"}]}}
case"left_mouse_down":{if(__x11Hit()){var __dsh2=await __selfHit([await __cursorPt()]);if(__dsh2)return __dsh2}if(__ask){if(__held())return{content:[{type:"text",text:"mouse button already held, call left_mouse_up first"}],isError:!0};var __g=await __gate("pointer",[await __cursorPt()]);if(__g)return __g}await ex.mouseDown();__setHeld(!0);return{content:[{type:"text",text:"Mouse down"}]}}
case"left_mouse_up":{if(__ask){var __ug;try{__ug=await __gate("pointer",[await __cursorPt()])}catch(__ue){__ug={content:[{type:"text",text:"Could not check the app under the pointer ("+(__ue&&__ue.message||__ue)+"); the mouse button was released."}],isError:!0}}if(__ug){try{await ex.mouseUp()}finally{__setHeld(!1)}return __ug}}await ex.mouseUp();__setHeld(!1);return{content:[{type:"text",text:"Mouse up"}]}}
case"computer_batch":{
  // Mirrors upstream's LXi/r6e: run sub-actions sequentially, stop on first
  // error, and build a FLAT content array of interleaved text + image blocks.
  // Each sub-action contributes [text block] + [its image blocks] (images
  // omitted for the failing action). Screenshot/zoom images become top-level
  // image blocks — never serialized into text — so a screenshot inside a batch
  // never blows the token cap.
  var __actions=__INPUT__.actions||[],__total=__actions.length,__done=[],__failIdx=-1;
  // Background display: the batch runs on the display its gate latched; a
  // setting change mid-batch refuses the remaining action (executor gate).
  var __tgB=typeof ex.__targetBatch==="function"&&ex.__targetBatch(1);
  try{
  for(var __bi=0;__bi<__actions.length;__bi++){
    // A stopped turn (Stop, Escape, Stop sharing) ends the batch, as upstream's does.
    if(__SESSION__&&typeof __SESSION__.isAborted==="function"&&__SESSION__.isAborted()===!0){await __relHeld();return{content:[{type:"text",text:"Batch aborted after "+__done.length+" of "+__total+" actions (user interrupt)."}],isError:!0}}
    var __ba=__actions[__bi],__bact=__ba.action||__ba.type;
    var __br;
    var __bsub=__ba&&typeof __ba==="object";
    if(__bsub)__lkSubs.add(__ba);
    try{__br=await __SELF__.handleToolCall(__STATE__,__bact,__ba,__SESSION__)}
    catch(__be){__br={content:[{type:"text",text:__bact+" threw: "+(__be&&__be.message||__be)}],isError:!0}}
    finally{if(__bsub)__lkSubs.delete(__ba)}
    __done.push({action:__bact,inner:__br||{content:[]}});
    if(__br&&__br.isError){__failIdx=__bi;break}
  }
  }finally{if(__tgB)ex.__targetBatch(-1)}
  function __fmtAct(idx,total,entry,errCtx){
    var inner=entry.inner||{},blocks=Array.isArray(inner.content)?inner.content:[];
    var texts=blocks.filter(function(b){return b.type==="text"}).map(function(b){return(b.text||"").trim()}).filter(function(t){return t.length>0});
    var imgs=blocks.filter(function(b){return b.type==="image"});
    var pfx=inner.isError?"FAILED — ":"";
    var body=texts.length>0?texts.join("\n"):"ok";
    var omit=errCtx&&imgs.length>0?" [Image omitted due to error]":"";
    var out=[{type:"text",text:"["+(idx+1)+"/"+total+"] "+entry.action+": "+pfx+body+omit}];
    if(!errCtx)out=out.concat(imgs);
    return out;
  }
  if(__failIdx>=0){
    var __remaining=__total-__done.length;
    var __content=[];
    for(var __di=0;__di<__done.length;__di++){__content=__content.concat(__fmtAct(__di,__total,__done[__di],!0))}
    __content.push({type:"text",text:"Batch stopped at actions["+__failIdx+"] ("+__done[__done.length-1].action+"). "+(__done.length-1)+" completed, "+__remaining+" remaining."});
    return{content:__content,isError:!0};
  }
  var __ok=[];
  for(var __oi=0;__oi<__done.length;__oi++){__ok=__ok.concat(__fmtAct(__oi,__total,__done[__oi],!1))}
  return{content:__ok};
}
default:return{content:[{type:"text",text:"Unknown action tool: "+__TOOL_NAME__}],isError:!0}
}})}catch(err){return(await __tgtErr(err))||{content:[{type:"text",text:"Error: "+(err&&err.message||err)}],isError:!0}}}
// screenshot display: a pinned display (switch_display) wins, then an explicit
// display_number / display_id (0 is a real display, hence the typeof checks),
// then the executor's default (on GNOME the monitor shared in the portal
// dialog), then Electron's primary.
try{switch(__TOOL_NAME__){
case"screenshot":{var __dlist=await ex.listDisplays();var __primaryIdx=0;for(var __pi=0;__pi<__dlist.length;__pi++){if(__dlist[__pi].isPrimary){__primaryIdx=__dlist[__pi].displayId;break}}var __did;if(globalThis.__cuPinnedDisplay!==void 0)__did=globalThis.__cuPinnedDisplay;else if(typeof __INPUT__.display_number==="number")__did=__INPUT__.display_number;else if(typeof __INPUT__.display_id==="number")__did=__INPUT__.display_id;else{var __sdid=typeof ex.__defaultDisplayId==="function"?await ex.__defaultDisplayId():null;__did=typeof __sdid==="number"?__sdid:__primaryIdx}var __actMon=__dlist.find(function(d){return d.displayId===__did})||__dlist[0]||{originX:0,originY:0};globalThis.__cuActiveOrigin={x:__actMon.originX||0,y:__actMon.originY||0};var __ss=await ex.screenshot({displayId:__did,allowedBundleIds:__ask?__cc.shotIds(__SESSION__):void 0});if(__ss&&__ss.captureError)return{content:[{type:"text",text:"Screenshot failed: "+__ss.captureError}],isError:!0};globalThis.__cuLastShot={imgW:__ss.imgW||__ss.displayWidth||(__actMon.width||0),imgH:__ss.imgH||__ss.displayHeight||(__actMon.height||0),dispW:__ss.displayWidth||__actMon.width||0,dispH:__ss.displayHeight||__actMon.height||0,originX:__ss.originX!=null?__ss.originX:(__actMon.originX||0),originY:__ss.originY!=null?__ss.originY:(__actMon.originY||0)};__syncUpstreamShotDims({width:globalThis.__cuLastShot.imgW,height:globalThis.__cuLastShot.imgH,displayWidth:globalThis.__cuLastShot.dispW,displayHeight:globalThis.__cuLastShot.dispH,displayId:__did,originX:globalThis.__cuLastShot.originX,originY:globalThis.__cuLastShot.originY});var __sn=__ask?__cc.shotNote(__SESSION__,__ss):null;return{content:[{type:"image",data:__ss.base64,mimeType:__ss.mimeType||"image/jpeg"}].concat(__sn?[{type:"text",text:__sn}]:[])}}
case"zoom":{
  // region=[x0,y0,x1,y1] corner pairs in the coordinate space of the last
  // full-screen screenshot (image pixels). Map both corners to root pixels via
  // __txC, then capture that root region at native resolution — so the zoom
  // delivers higher detail than the downscaled full screenshot.
  var __zdid=globalThis.__cuPinnedDisplay!==void 0?globalThis.__cuPinnedDisplay:null;
  // zoom(rect, allowedBundleIds, displayId, scale, {globalCoords}): the rect is
  // root/screen pixels (globalCoords); the approved ids with the switch on
  // (the executor masks, refuses, or - where it cannot mask - says so on the
  // result), else undefined (unmasked, as before).
  var __reg=__INPUT__.region,__zr,__zids=__ask?__cc.shotIds(__SESSION__):void 0;
  if(Array.isArray(__reg)&&__reg.length===4){
    var __c0=__txC([__reg[0],__reg[1]]),__c1=__txC([__reg[2],__reg[3]]);
    var __rx=Math.min(__c0[0],__c1[0]),__ry=Math.min(__c0[1],__c1[1]);
    var __rw=Math.max(1,Math.abs(__c1[0]-__c0[0])),__rh=Math.max(1,Math.abs(__c1[1]-__c0[1]));
    __zr=await ex.zoom({x:__rx,y:__ry,w:__rw,h:__rh},__zids,__zdid,void 0,{globalCoords:!0});
  }else{
    // Legacy fallback: coordinate + size (center + square). Coordinate is image
    // pixels; map via __txC before capturing.
    var __zc=__txC(__INPUT__.coordinate||[960,540]),__sz=__INPUT__.size||400,__hf=Math.floor(__sz/2);
    __zr=await ex.zoom({x:Math.max(0,__zc[0]-__hf),y:Math.max(0,__zc[1]-__hf),w:__sz,h:__sz},__zids,__zdid,void 0,{globalCoords:!0});
  }
  var __zn=__ask?__cc.shotNote(__SESSION__,__zr):null;
  return{content:[{type:"image",data:__zr.base64,mimeType:__zr.mimeType||"image/jpeg"}].concat(__zn?[{type:"text",text:__zn}]:[])}
}
case"cursor_position":{var __cp=await ex.getCursorPosition();var __cpr=__untxC(__cp.x,__cp.y);return{content:[{type:"text",text:"("+__cpr[0]+", "+__cpr[1]+")"}]}}
case"wait":{var __ws=Math.min(__INPUT__.duration||__INPUT__.seconds||1,30);await new Promise(function(__rv){setTimeout(__rv,__ws*1000)});return{content:[{type:"text",text:"Waited "+__ws+"s"}]}}
case"open_application":{var __oaName=__INPUT__.app||__INPUT__.application||"";var __oa=await ex.openApp(__oaName);
  if(__oa&&__oa.isError){var __sug=(__oa.suggestions&&__oa.suggestions.length)?" Did you mean: "+__oa.suggestions.join(", ")+"?":"";return{content:[{type:"text",text:"No application matching '"+(__oa.app||__oaName)+"' was found."+__sug}],isError:!0}}
  if(__oa&&__oa.action==="activated")return{content:[{type:"text",text:"Activated existing window: "+(__oa.windowTitle||__oa.app||__oaName)}]};
  if(__oa&&__oa.action==="launched")return{content:[{type:"text",text:"Launched "+(__oa.app||__oaName)+"; window '"+(__oa.windowTitle||__oa.app||__oaName)+"' is now frontmost"}]};
  if(__oa&&__oa.action==="launch_attempted")return{content:[{type:"text",text:"Launch attempted for '"+(__oa.app||__oaName)+"'; no window appeared yet - take a screenshot to verify"}]};
  // action "opened" = Wayland-native/non-bridge launch-only, or an xdg-open of a
  // path/URL. Byte-for-byte the pre-feature text so non-X11 sessions are unchanged.
  return{content:[{type:"text",text:"Opened app"}]}}
case"switch_display":{var __displays=await ex.listDisplays();var __target=__INPUT__.display;if(__target==="auto"||!__target){globalThis.__cuPinnedDisplay=void 0;globalThis.__cuLastShot=null;__syncUpstreamShotDims(void 0);return{content:[{type:"text",text:"Display mode set to auto (follows cursor). Available: "+__displays.map(function(d){return d.label+" ("+d.width+"x"+d.height+")"}).join(", ")}]}}var __found=__displays.find(function(d){return d.label===__target||String(d.displayId)===String(__target)});if(__found){__pinDisplay(__found);return{content:[{type:"text",text:"Switched to display: "+__found.label+" ("+__found.width+"x"+__found.height+"). Take a screenshot to refresh coordinates."}]}}return{content:[{type:"text",text:"Display '"+__target+"' not found. Available: "+__displays.map(function(d){return d.label}).join(", ")}]}}
case"list_granted_applications":{return{content:[{type:"text",text:"All applications are accessible on Linux (no grants needed)"}]}}
case"read_clipboard":{var cb=await ex.readClipboard();return{content:[{type:"text",text:cb}]}}
case"write_clipboard":{await ex.writeClipboard(__INPUT__.text||"");return{content:[{type:"text",text:"Written to clipboard"}]}}
default:return{content:[{type:"text",text:"Unknown tool: "+__TOOL_NAME__}],isError:!0}
}}catch(err){return(await __tgtErr(err))||{content:[{type:"text",text:"Error: "+err.message}],isError:!0}}
}}

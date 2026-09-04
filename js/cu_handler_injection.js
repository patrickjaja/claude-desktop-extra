if(process.platform==="linux"){
// Per-call compliance deny (parity with upstream's handleToolCall preamble, which this Linux
// block returns before). Patch 11 publishes the captured HIPAA gate; unset (older shapes) = no check.
if(typeof globalThis.__cdbCuHipaa==="function"&&globalThis.__cdbCuHipaa()){(globalThis.__cdbDiag||console.log)("[claude-cu] tool call denied: organization compliance settings");return{isError:!0,content:[{type:"text",text:"Computer Use isn't available under your organization's compliance settings. If you recently switched organizations, restart the app."}]}}
var __lxTeachTools=["request_teach_access","teach_step","teach_batch"];
if(__lxTeachTools.indexOf(__TOOL_NAME__)>=0){const __n=__DISPATCHER__(__SESSION__);const{save_to_disk:__sd,...__s}=__INPUT__;return await __n(__TOOL_NAME__,__s)}
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
function __syncUpstreamShotDims(dims){
  try{if(__SESSION__&&typeof __SESSION__.onCuScreenshotDimsUpdated==="function")__SESSION__.onCuScreenshotDimsUpdated(dims)}catch(e){}
}
var __actionTools=new Set(["left_click","right_click","double_click","triple_click","middle_click","left_click_drag","mouse_move","scroll","key","type","hold_key","left_mouse_down","left_mouse_up","computer_batch"]);
async function __hideWindows(fn){var __bws=require("electron").BrowserWindow.getAllWindows().filter(function(w){return!w.isDestroyed()});for(var __i=0;__i<__bws.length;__i++)__bws[__i].setIgnoreMouseEvents(true);try{await new Promise(function(r){setTimeout(r,50)});return await fn()}finally{for(var __i=0;__i<__bws.length;__i++){if(!__bws[__i].isDestroyed())__bws[__i].setIgnoreMouseEvents(false)}}}
if(__actionTools.has(__TOOL_NAME__)){try{return await __hideWindows(async function(){switch(__TOOL_NAME__){
case"left_click":{var __lc=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]);await ex.click(__lc[0],__lc[1],"left",1);return{content:[{type:"text",text:"Clicked at ("+__lc[0]+","+__lc[1]+")"}]}}
case"right_click":{var __rc=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]);await ex.click(__rc[0],__rc[1],"right",1);return{content:[{type:"text",text:"Right clicked"}]}}
case"double_click":{var __dc=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]);await ex.click(__dc[0],__dc[1],"left",2);return{content:[{type:"text",text:"Double clicked"}]}}
case"triple_click":{var __tc=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]);await ex.click(__tc[0],__tc[1],"left",3);return{content:[{type:"text",text:"Triple clicked"}]}}
case"middle_click":{var __mc=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]);await ex.click(__mc[0],__mc[1],"middle",1);return{content:[{type:"text",text:"Middle clicked"}]}}
case"type":{await ex.type(__INPUT__.text||"",{viaClipboard:!1});return{content:[{type:"text",text:"Typed text"}]}}
case"key":{var __kc=__INPUT__.text||__INPUT__.key||"",__krep=__INPUT__.repeat||__INPUT__.count||1;await ex.key(__kc,__krep);return{content:[{type:"text",text:"Pressed key: "+__kc}]}}
case"scroll":{var __sc=__txC(__INPUT__.coordinate||[__INPUT__.x||0,__INPUT__.y||0]),__dir=__INPUT__.scroll_direction||__INPUT__.direction||"down",__amt=__INPUT__.scroll_amount!=null?__INPUT__.scroll_amount:(__INPUT__.amount!=null?__INPUT__.amount:3),__sv=__dir==="down"?__amt:__dir==="up"?-__amt:0,__sh=__dir==="right"?__amt:__dir==="left"?-__amt:0;await ex.scroll(__sc[0],__sc[1],__sh,__sv);return{content:[{type:"text",text:"Scrolled "+__dir}]}}
case"left_click_drag":{var __dsc=__INPUT__.start_coordinate?__txC(__INPUT__.start_coordinate):null,__den=__txC(__INPUT__.coordinate);await ex.drag(__dsc?{x:__dsc[0],y:__dsc[1]}:void 0,{x:__den[0],y:__den[1]});return{content:[{type:"text",text:"Dragged"}]}}
case"mouse_move":{var __mv=__txC(__INPUT__.coordinate||[__INPUT__.x,__INPUT__.y]);await ex.moveMouse(__mv[0],__mv[1]);return{content:[{type:"text",text:"Moved to ("+__mv[0]+","+__mv[1]+")"}]}}
case"hold_key":{await ex.holdKey(__INPUT__.text||__INPUT__.key||"",__INPUT__.duration||.5);return{content:[{type:"text",text:"Held key"}]}}
case"left_mouse_down":{await ex.mouseDown();return{content:[{type:"text",text:"Mouse down"}]}}
case"left_mouse_up":{await ex.mouseUp();return{content:[{type:"text",text:"Mouse up"}]}}
case"computer_batch":{
  // Mirrors upstream's LXi/r6e: run sub-actions sequentially, stop on first
  // error, and build a FLAT content array of interleaved text + image blocks.
  // Each sub-action contributes [text block] + [its image blocks] (images
  // omitted for the failing action). Screenshot/zoom images become top-level
  // image blocks — never serialized into text — so a screenshot inside a batch
  // never blows the token cap.
  var __actions=__INPUT__.actions||[],__total=__actions.length,__done=[],__failIdx=-1;
  for(var __bi=0;__bi<__actions.length;__bi++){
    var __ba=__actions[__bi],__bact=__ba.action||__ba.type;
    var __br;
    try{__br=await __SELF__.handleToolCall(__bact,__ba,__SESSION__)}
    catch(__be){__br={content:[{type:"text",text:__bact+" threw: "+(__be&&__be.message||__be)}],isError:!0}}
    __done.push({action:__bact,inner:__br||{content:[]}});
    if(__br&&__br.isError){__failIdx=__bi;break}
  }
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
}})}catch(err){return{content:[{type:"text",text:"Error: "+(err&&err.message||err)}],isError:!0}}}
try{switch(__TOOL_NAME__){
case"screenshot":{var __dlist=await ex.listDisplays();var __primaryIdx=0;for(var __pi=0;__pi<__dlist.length;__pi++){if(__dlist[__pi].isPrimary){__primaryIdx=__dlist[__pi].displayId;break}}var __did=globalThis.__cuPinnedDisplay!==void 0?globalThis.__cuPinnedDisplay:(__INPUT__.display_number||__INPUT__.display_id||__primaryIdx);var __actMon=__dlist.find(function(d){return d.displayId===__did})||__dlist[0]||{originX:0,originY:0};globalThis.__cuActiveOrigin={x:__actMon.originX||0,y:__actMon.originY||0};var __ss=await ex.screenshot({displayId:__did});globalThis.__cuLastShot={imgW:__ss.imgW||__ss.displayWidth||(__actMon.width||0),imgH:__ss.imgH||__ss.displayHeight||(__actMon.height||0),dispW:__ss.displayWidth||__actMon.width||0,dispH:__ss.displayHeight||__actMon.height||0,originX:__ss.originX!=null?__ss.originX:(__actMon.originX||0),originY:__ss.originY!=null?__ss.originY:(__actMon.originY||0)};__syncUpstreamShotDims({width:globalThis.__cuLastShot.imgW,height:globalThis.__cuLastShot.imgH,displayWidth:globalThis.__cuLastShot.dispW,displayHeight:globalThis.__cuLastShot.dispH,displayId:__did,originX:globalThis.__cuLastShot.originX,originY:globalThis.__cuLastShot.originY});return{content:[{type:"image",data:__ss.base64,mimeType:__ss.mimeType||"image/jpeg"}]}}
case"zoom":{
  // region=[x0,y0,x1,y1] corner pairs in the coordinate space of the last
  // full-screen screenshot (image pixels). Map both corners to root pixels via
  // __txC, then capture that root region at native resolution — so the zoom
  // delivers higher detail than the downscaled full screenshot.
  var __zdid=globalThis.__cuPinnedDisplay!==void 0?globalThis.__cuPinnedDisplay:null;
  var __reg=__INPUT__.region,__zr;
  if(Array.isArray(__reg)&&__reg.length===4){
    var __c0=__txC([__reg[0],__reg[1]]),__c1=__txC([__reg[2],__reg[3]]);
    var __rx=Math.min(__c0[0],__c1[0]),__ry=Math.min(__c0[1],__c1[1]);
    var __rw=Math.max(1,Math.abs(__c1[0]-__c0[0])),__rh=Math.max(1,Math.abs(__c1[1]-__c0[1]));
    __zr=await ex.zoom({x:__rx,y:__ry,w:__rw,h:__rh},1,__zdid);
  }else{
    // Legacy fallback: coordinate + size (center + square). Coordinate is image
    // pixels; map via __txC before capturing.
    var __zc=__txC(__INPUT__.coordinate||[960,540]),__sz=__INPUT__.size||400,__hf=Math.floor(__sz/2);
    __zr=await ex.zoom({x:Math.max(0,__zc[0]-__hf),y:Math.max(0,__zc[1]-__hf),w:__sz,h:__sz},1,__zdid);
  }
  return{content:[{type:"image",data:__zr.base64,mimeType:__zr.mimeType||"image/jpeg"}]}
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
case"switch_display":{var __displays=await ex.listDisplays();var __target=__INPUT__.display;if(__target==="auto"||!__target){globalThis.__cuPinnedDisplay=void 0;globalThis.__cuLastShot=null;__syncUpstreamShotDims(void 0);return{content:[{type:"text",text:"Display mode set to auto (follows cursor). Available: "+__displays.map(function(d){return d.label+" ("+d.width+"x"+d.height+")"}).join(", ")}]}}var __found=__displays.find(function(d){return d.label===__target||String(d.displayId)===String(__target)});if(__found){globalThis.__cuPinnedDisplay=__found.displayId;globalThis.__cuActiveOrigin={x:__found.originX||0,y:__found.originY||0};globalThis.__cuLastShot=null;__syncUpstreamShotDims(void 0);return{content:[{type:"text",text:"Switched to display: "+__found.label+" ("+__found.width+"x"+__found.height+"). Take a screenshot to refresh coordinates."}]}}return{content:[{type:"text",text:"Display '"+__target+"' not found. Available: "+__displays.map(function(d){return d.label}).join(", ")}]}}
case"list_granted_applications":{return{content:[{type:"text",text:"All applications are accessible on Linux (no grants needed)"}]}}
case"read_clipboard":{var cb=await ex.readClipboard();return{content:[{type:"text",text:cb}]}}
case"write_clipboard":{await ex.writeClipboard(__INPUT__.text||"");return{content:[{type:"text",text:"Written to clipboard"}]}}
default:return{content:[{type:"text",text:"Unknown tool: "+__TOOL_NAME__}],isError:!0}
}}catch(err){return{content:[{type:"text",text:"Error: "+err.message}],isError:!0}}
}

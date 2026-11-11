#!/usr/bin/env node
// Main-view renderer recovery: a clean-exit nobody asked for (issue #287) must
// reach upstream's reload path, and a renderer whose whole process is stalled,
// so the unresponsive watchdog's crash request never runs (issue #299), must
// still die and be reloaded.
//
// WHY THIS EXISTS
// ---------------
// Upstream's main-webview render-process-gone handler runs every death
// through a reason filter that returns a verdict. Without a pending "we
// crashed it ourselves" token a `clean-exit` is "teardown" unconditionally; on
// Linux the main view's renderer can exit with reason clean-exit / exitCode 0
// on its own, and the window then stays blank (#287). With a token every
// reason is "own kill", which the handler hands to the watchdog's post-kill
// reload. The unresponsive watchdog adds a token per kill attempt, reloads 1 s
// after its crash request when no death was reported, and arms a 30 s re-check
// that reloads again when no page committed. On Linux its
// forcefullyCrashRenderer() asks the renderer to crash itself on its IO
// thread: that works while only the main thread is hung, and does nothing when
// the whole renderer process is stalled; every reload then goes to the same
// stalled renderer and upstream ends on its Restart-only error card (#299).
//
// patches/linux/fix_renderer_clean_exit_reload:
//   A. the filter's clean-exit term asks __cdbCleanExitRecoverable
//   B. the 300 ms `killed` grace also covers clean-exit
//   D. __cdbHungKillEscalate(e) runs before e.forcefullyCrashRenderer() in the
//      hang-kill helper: it SIGKILLs the renderer pid 5 s later unless the view
//      recovered (a liveness probe at the deadline that answers also counts as
//      recovered). The `killed` that follows carries upstream's token, so the
//      handler calls it an own kill and upstream's post-kill reload runs.
// (both helpers in js/renderer_clean_exit.js; sub-patch C, which handed a
// tokened death straight to the reload path, is retired). Everything after
// the filter is upstream's own path.
//
// This harness runs the compiled patch against the v5.1231.0 shapes it targets
// (filter and its expiring tokens, quitting predicate, reload helper, and the
// whole function holding the unresponsive watchdog and the handler, verbatim)
// and then drives the PATCHED code with a stubbed WebContents:
//
//   [1]  apply on pristine, idempotent 2nd run (positive [OK] lines), node --check,
//        retired C helper absent
//   [2]  clean-exit, app idle            -> reload
//   [3]  clean-exit while quitting        -> suppressed
//   [4]  clean-exit, view destroyed in grace -> suppressed
//   [5]  4th clean-exit within 10 min     -> suppressed (upstream behavior)
//   [6]  no token: crashed / killed keep upstream's verdicts
//   [7]  token pending, no kill attempt in flight -> dropped (upstream)
//   [8]  a death from elsewhere during a kill attempt -> upstream's post-kill
//        reload, D stands down
//   [9]  watchdog: SIGKILL only while unresponsive with an unchanged pid
//   [9b] ...and only when a 2 s liveness probe at the deadline gets no answer
//   [9c] upstream's own spare check runs first: a spared renderer never arms it
//   [10] watchdog -> 1 s reload into the stalled renderer -> SIGKILL -> `killed`
//        handed to upstream's post-kill reload
//   [11] refusals: absorbed filter, missing anchors, foreign or stale end-state -> exit 1
//   [12] fix_renderer_gone_suppressed_log composes, in both orders

import { readFileSync, writeFileSync, mkdirSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const SKIP_EXIT = 3;
const PATCH_BIN = join(repo, "patches", "linux", "fix_renderer_clean_exit_reload");
const LOG_PATCH_BIN = join(repo, "patches", "linux", "fix_renderer_gone_suppressed_log");

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${actual}`);
    pass++;
  } else {
    console.log(`  FAIL ${label} -> got ${actual}, expected ${expected}`);
    failures.push(label);
  }
}

// Upstream shapes, copied verbatim from the v5.1231.0 bundle
// (index.chunk-4DJuDgNS.js). Nothing inside the pieces is invented: STUBS only
// stubs the helpers they call (logger, Sentry, telemetry, overlay, print-call
// guard, navigation bookkeeping, CPU sampling) so they can run outside
// Electron. ZNR is the whole function that registers the main view's watchdog
// and handlers; Fnr (the responsive tracker) is stubbed to return __hang so a
// case can feed upstream's hang-kill spare check.
const FN_FN =
  "function fN(e){return e.isDestroyed()||e.isCrashed()||e.getOSProcessId()===0}";
const RNR =
  "function Rnr(e){setImmediate((()=>{e.isDestroyed()||e.reload()}))}";
const XER =
  "function xer(e,t){return!1}";
const INR =
  "function Inr(e){return typeof e==\"number\"&&e>0?Math.min(Math.floor(e),Otr):0}";
const MNR =
  "var jnr=120;function Mnr(e){return e.screen_locked===!0?\"the screen is locked\":(e.seconds_since_resume??1/0)<jnr?\"the computer woke under 2 minutes ago\":void 0}";
const CNR =
  "async function Cnr(e){let t;await Promise.race([e.catch((()=>void 0)),new Promise((e=>{t=setTimeout(e,vtr)}))]),clearTimeout(t)}";
const LNR =
  "function Lnr(e,t){return new Promise((n=>{let r=t=>{clearTimeout(s),e.removeListener(\"responsive\",i),e.removeListener(\"did-start-navigation\",a),e.removeListener(\"render-process-gone\",o),e.removeListener(\"destroyed\",o),n(t)},i=()=>r(\"responsive\"),a=e=>{e.isMainFrame&&!e.isSameDocument&&setImmediate((()=>r(\"navigation\")))},o=()=>void setImmediate((()=>r(\"renderer_gone\"))),s=setTimeout((()=>r(\"timed_out\")),t);e.on(\"responsive\",i),e.on(\"did-start-navigation\",a),e.on(\"render-process-gone\",o),e.on(\"destroyed\",o)}))}";
const FILTER_BLOCK =
  "var FN=[],htr=[],gtr=1e4,_tr=1e4,vtr=2e3,ytr=300,btr=3,xtr=3e5,Str=[1e3,5e3,2e4],Ctr=3e4,wtr=1e3,Ttr=1e3,Etr=500,Dtr=3e5,Otr=6e4;function ktr(){Ntr().push(1/0)}function Atr(){let e=FN.indexOf(1/0);e!==-1&&FN.splice(e,1)}function jtr(){let e=Date.now()+_tr;FN=FN.map((t=>Math.min(t,e)))}function Mtr(){return Ntr().shift()!==void 0}function Ntr(){let e=LN===void 0?0:xtr,t=Date.now();return FN=FN.filter((n=>n+e>t)),FN}function Ptr(){let e=Date.now();return htr=htr.filter((t=>t>e)),htr}function Ftr(){Ptr().push(Date.now()+gtr)}function Itr(){return Ptr().shift()!==void 0}function Ltr(e){return Mtr()?((e.reason===\"crashed\"||e.reason===\"killed\")&&Ftr(),\"own kill\"):e.reason===\"clean-exit\"||e.reason===\"killed\"&&eI()?\"teardown\":\"needs recovery\"}var IN=!1;function Rtr(){return IN}var LN,RN,ztr=18e4,Btr=[0,15e3,3e4],Vtr=.2,Htr=1e3,Utr=1e4,Wtr=6e4,Gtr=3,zN,BN=0,Ktr=0,qtr=0,Jtr=0,Ytr=\"load_failed\",Xtr=0,VN=!1,HN,Ztr,Qtr=!1;";
const ZNR =
  "function znr(e,t={}){IN=!1,AN(),LN=void 0,RN=void 0,zN=e,dnr=t.offersOfflineGame??(()=>!1),fnr=t.offersOrganizationSignIn??(()=>!1),pnr=t.offersClaudeApiSignIn??(()=>!1);let n=t.printCallGuardEnabled??(()=>!1),r=t.hangKillSpareEnabled??(()=>!1),i=t.hangKillGraceMs??(()=>0),a=t.msixUpdateCheck??(()=>\"none\"),o=t.hangKillSkipDumpEnabled??(()=>!1),s=t.hangKillCapEnabled??(()=>!0);Ger(e),nnr();let c=0,l=0,u=0,d=0,f,p=()=>{let e=f!==void 0;return clearTimeout(f),f=void 0,e},m,h=()=>{clearTimeout(m),m=void 0},g=!1,_=-1/0,v=!1,y=!1,b,x,S=()=>{clearTimeout(x?.fallback),x=void 0},C=()=>{x&&(clearTimeout(x.fallback),x.isHeld=!0)},w=t=>{let n=x;if(!n||(clearTimeout(n.fallback),t===\"death notice\"&&(x=void 0),n.isHeld)||n.pageHasCommitted&&!fN(e))return;AN();let r=Math.round(performance.now()-n.killedAt);t!==\"no death notice\"&&n.isRunsFirstKill&&b&&(b.deathNoticeMs??=r),!(n.hasReloaded&&Eo||eI()||e.isDestroyed())&&(P.info(\"Reloading after the hang kill: %s, %d ms after it\",t,r),n.hasReloaded=!0,ne(),v=n.isCounted||l>=btr,Rnr(e))},T=t=>{t===\"loaded\"&&(y=!0),t===\"loaded\"&&x?x.pageHasCommitted=!0:S(),h(),LN===e&&(LN=void 0),RN?.view===e&&(RN=void 0);let n=b;if(b=void 0,!n)return;let r=Date.now()-n.startedAt;P.info(\"Main webview's recovery from the hang kill ended: %s after %d load(s) in %d ms\",t,n.loads,r),Q(\"desktop_main_view_hang_recovery\",{recovery_outcome:t,surface:n.surface,loads:n.loads,loads_hidden:n.loadsHidden,elapsed_ms:r,window_visible:qN().window_visible,window_visible_at_kill:n.visibleAtKill,death_notice_ms:n.deathNoticeMs,network_service_gone:vp()}).then(CF)},ee=()=>{let e=Date.now();e-d>xtr&&(l=0,u=0),d=e},te=0,ne=(t=!0)=>{t&&b&&(b.loads++,qN().window_visible===!1&&b.loadsHidden++),LN=e,y=!1,v=!1,RN?.view===e&&(RN=void 0),te=performance.now(),re(Ctr)},re=t=>{clearTimeout(m),m=setTimeout((()=>{if(m=void 0,e.isDestroyed()||eI()){T(\"abandoned\");return}if(Eo){T(\"error_card\");return}let t=e.isLoading(),n=t&&e.isWaitingForResponse();if(P.info(\"Main webview committed no page within %d s of its recovery reload (%s)\",Math.round((performance.now()-te)/1e3),n?\"no response yet\":t?\"loading\":\"not loading\"),t&&e.stop(),n){GN(\"load_failed\",{errorCode:-7,errorDescription:\"ERR_TIMED_OUT\"}),T(\"error_card\");return}ee(),ae(void 0,v)}),t)},ie=(t,n)=>{if(n)return!0;if(l<btr)return l++,!0;P.info(\"Recovery reload cap reached; not reloading again\"),T(\"gave_up\");let r=t&&u>1?H7n(t):U7n(y),i=qN().window_visible===!1;return Do(i?void 0:r),i&&(RN={view:e,card:r}),!1},ae=(t,n)=>{if(!ie(t,n))return;let r=l-1;if(t?.reason!==\"launch-failed\"){ne(),Rnr(e);return}let i=Str[Math.min(r,Str.length-1)];P.info(\"Renderer failed to launch; reloading in %ds\",i/1e3),f=setTimeout((()=>{if(f=void 0,e.isDestroyed()){T(\"abandoned\");return}ne(),e.reload()}),i)};Ge(T9n(\"crash-dump-filter\",\"keep\",(e=>n9n(e,Itr))));let oe=!1,se=Fnr(e,(()=>oe));e.on(\"did-start-navigation\",(t=>{if(t.isMainFrame&&!t.isSameDocument){if(g=!0,kN(\"navigation_start\"),p())ne();else if(m!==void 0){let e=te+2*Ctr-performance.now();re(Math.max(0,Math.min(Ctr,e)))}qer(e)}})),e.on(\"did-stop-loading\",(()=>{g=!1,kN(\"navigation_stop\")})),e.on(\"did-fail-load\",((e,t,n,r,i)=>{i&&t!==-3&&(AN(),P.info(`Failed to load URL: ${zpe(r)} %o`,{errorCode:t,errorDescription:n}),GN(\"load_failed\",{errorCode:t,errorDescription:n}),Q(\"desktop_main_view_load_failed\",{error_code:t,error_description:n,is_claude_host:vN(_N(r)?.host??\"\")}))})),e.on(\"did-navigate\",((t,n,r,i)=>{if(g=!1,_=performance.now(),jer(),p()&&ne(),Ker(e),r>=400&&r<600){AN(),P.info(`Navigation to ${zpe(n)} failed with status code ${r}: ${i}`),GN(\"http_error\",{errorCode:r,errorDescription:i}),T(\"error_card\");let t=vN(new URL(n).host);Q(\"desktop_main_view_http_error\",{http_status:r,http_status_text:i,is_claude_host:t}),!t&&c<3&&(c++,P.info(`Navigating back to ${dj()}`),e.loadURL(dj()))}else r<400&&n!==\"about:blank\"?(IN||e.navigationHistory.getEntryAtIndex(0)?.url===\"about:blank\"&&e.navigationHistory.removeEntryAtIndex(0),IN=!0,T(\"loaded\"),c=0,BN>0&&(P.info(\"Main view load recovered after %d failed attempt(s)\",BN),Q(\"desktop_main_view_load_recovered\",rnr())),nnr(),Do(void 0)):n===\"about:blank\"?AN():T(\"loaded\")})),e.on(\"did-frame-navigate\",(async(t,n,r,i,a)=>{if(!(a||!Eo)&&await mtr(e)){P.info(\"Turnstile iframe detected. Removing error overlay.\"),Do(void 0);return}}));let ce=-1/0,le=async(t,n,i)=>{let a=null,o=e=>({outcome:e,pageAnswerMs:a});try{if(t!==\"none\")return o(\"print_call\");if(!i)return o(\"no_responsive_event\");if(LN===e)return o(\"reload_pending\");if(performance.now()-ce<Dtr)return o(\"spared_recently\");if(!r())return o(\"spare_switch_off\");await ea(Ttr);let s=performance.now(),c=await Ia(e.executeJavaScript(\"true\"),Etr,!1);return a=Math.round(performance.now()-s),c===!0?fN(e)?o(\"renderer_gone\"):se()===n?o(\"spared\"):o(\"hung_again\"):o(\"no_answer\")}catch{return o(\"error\")}},ue=(t,n,i)=>i===0||t!==\"none\"||!n||n.responsive?\"none\":LN===e?\"reload_pending\":performance.now()-ce<Dtr?\"spared_recently\":r()?fN(e)?\"renderer_gone\":g||_>n.at?\"navigation\":void 0:\"spare_switch_off\",de=async(t,n,r,i)=>{try{let a=ue(t,n,r);if(a)return{end:a,waitedMs:0};let o=performance.now(),s=await Lnr(e,i===\"none\"?r:Otr),c=Math.round(performance.now()-o);return P.info(\"Main webview's hang kill waited %d ms for the page to respond, result: %s\",c,s),{end:s,waitedMs:c}}catch{return{end:\"error\",waitedMs:0}}finally{oe=!1}},fe=()=>{let t=performance.now(),n=xer(e,o);e.forcefullyCrashRenderer();let r=Math.round(performance.now()-t);return P.info(\"The hang kill blocked the main process for %d ms (crash dump skipped: %s)\",r,n),{kill_ms:r,kill_dump_skipped:n}},pe=!1,me=async e=>{pe=!0;try{await he(e)}finally{pe=!1,jtr()}},he=async t=>{Ker(e),ktr(),h();let n=x?.isCounted===!0&&!x.hasReloaded&&!x.pageHasCommitted&&!x.reusedSlot;C();let r=cN(e.getURL()),o=PN(e),c=qN(),u=Anr(),d=wnr(),f=performance.now(),p=se(),m=0,g=\"none\";try{g=a(),m=Inr(i())}catch{}oe=m>0;let _=null;await Cnr(Q(\"desktop_main_view_unresponsive\",{surface:r,web_commit_hash:o,main_rss_bytes:process.memoryUsage().rss,...c,...u,...d,main_view_document_age_seconds:Mer(),print_call:t,hang_kill_grace_flag_ms:m}).then((()=>(_=xnr(e),CF()))));let v=Math.round(performance.now()-f),y=Snr(_,xnr(e)),S=await de(t,p,m,g),te=p?.responsive,re=s9n;bnr()&&t===\"none\"&&(re=te===void 0?await u9n(e):c9n);let{outcome:ae,pageAnswerMs:ue}=await le(t,p,te!==void 0);if(e.isDestroyed()){T(\"abandoned\");return}let pe={surface:r,web_commit_hash:o,print_call:t,window_visible:c.window_visible,window_minimized:c.window_minimized,wait_ms:v,...te??Pnr,electron_version:process.versions.electron,page_answer_ms:ue,...y,...re,kill_outcome:ae,hang_kill_grace_flag_ms:m,msix_update_check:g,hang_kill_grace_end:S.end,hang_kill_grace_waited_ms:S.waitedMs};if(ae===\"spared\"){ce=performance.now(),Atr(),x&&(x.isHeld=!1),P.info(\"Main webview is responsive again (answered a script in %d ms), hang kill called off\",ue),Q(\"desktop_main_view_hang_kill_wait\",{...pe,reload_attempt:null});return}AN();let me=b===void 0;b??={startedAt:Date.now(),surface:r,visibleAtKill:c.window_visible,loads:0,loadsHidden:0,deathNoticeMs:null};let he=!0;try{he=s()}catch{}let ge=he?Mnr(u):\"the cap on hang kills is switched off remotely\";ge?P.info(\"Not counting this hang toward the reload cap: %s\",ge):ee();let _e={...pe,reload_attempt:ge?null:Math.max(0,l-+!!n)};if(!ge&&!n&&l>=btr){let e=fe();Q(\"desktop_main_view_hang_kill_wait\",{..._e,...e}),ie(void 0,!1);return}ge||ie(void 0,n),ne(!1),x={killedAt:performance.now(),isRunsFirstKill:me,isCounted:!ge||n,reusedSlot:n,fallback:setTimeout((()=>w(\"no death notice\")),wtr),hasReloaded:!1,pageHasCommitted:!1,isHeld:!1};let ve=fN(e),ye=fe();ve&&w(\"renderer already dead\"),Q(\"desktop_main_view_hang_kill_wait\",{..._e,...ye})},ge=async()=>{e.isDestroyed()||(P.info(\"Main webview's print() call is still in progress %d minutes after it began and a kill was skipped for it, will kill it\",Her/6e4),await me(\"deadline\"))};e.on(\"unresponsive\",(async()=>{if(pe)return;let t=Zer(e,n,(()=>void ge()));if(t.skipKill){P.info(\"Main webview is unresponsive during a print() call (started %d ms ago), not killing%s\",t.printCallAgeMs,t.firstSkip?\"; logging desktop_main_view_unresponsive_kill_skipped\":\"\"),t.firstSkip&&Q(\"desktop_main_view_unresponsive_kill_skipped\",{surface:cN(e.getURL()),web_commit_hash:PN(e),print_call_age_ms:t.printCallAgeMs});return}P.info(\"Main webview is unresponsive, will kill it\"),await me(t.printCall)})),e.on(\"render-process-gone\",(async(t,n)=>{Ker(e);let r=Date.now(),i=Ner(r),a=Ltr(n);if(a!==\"needs recovery\"){a===\"own kill\"&&w(\"death notice\");return}AN(),h(),S();let o=p(),s=PN(e),c=qN(),d=C9n(),f={...Anr(r),...Fer(r),renderer_age_ms:i};if(n.reason===\"killed\"&&(await new Promise((e=>setTimeout(e,ytr))),e.isDestroyed()||eI())){T(\"abandoned\");return}if(e.isDestroyed()){T(\"abandoned\");return}P.info(\"Main webview render process gone: %o\",n),ee(),u++,kN(\"prior_death\",r);let m=Ier(r);qe(\"Main webview render process gone\",{level:\"error\",tags:{event:\"webview-render-process-gone\",reason:n.reason,accessibility_support:oN(c.accessibility_support_enabled)},extra:{exitCode:n.exitCode,...f,...m}}),await Cnr(Promise.all([Q(\"desktop_main_view_render_process_gone\",{surface:cN(e.getURL()),web_commit_hash:s,reason:n.reason,exit_code:n.exitCode,reload_attempt:l,main_rss_bytes:process.memoryUsage().rss,...c,...f,...m},{mainViewHeap:d}).then(CF),Je(vtr)])),p()&&(o=!0),ae(n,o)}))}";

const QUIT_DECL = "var qF=!1,JF=!1,YF=!1;var eI=()=>qF||JF||YF";
const STUBS =
  "var __log=[],__overlay=[],__hang=void 0,P={info:(...a)=>__log.push(a[0]),debug(){},warn(){}},qe=()=>{},Q=async()=>{},CF=()=>{},Je=()=>{},Do=x=>__overlay.push(x),H7n=n=>({reason:n.reason}),U7n=()=>({}),cN=()=>\"\",oN=()=>\"\",Ker=()=>{},Ger=()=>{},qer=()=>{},jer=()=>{},PN=()=>null,qN=()=>({}),Anr=()=>({}),wnr=()=>({}),Ner=()=>0,Fer=()=>({}),Ier=()=>({}),C9n=()=>null,Mer=()=>0,Pnr={},Her=6e5,Zer=()=>({skipKill:!1,printCall:\"none\"}),Fnr=()=>()=>__hang,ea=async()=>{},Ia=(p,ms,d)=>Promise.race([p,new Promise(r=>setTimeout(()=>r(d),ms))]),vp=()=>!1,nnr=()=>{},Ge=()=>{},T9n=()=>{},n9n=()=>{},kN=()=>{},AN=()=>{},rnr=()=>({}),GN=()=>{},vN=()=>!1,_N=()=>null,dj=()=>\"\",zpe=x=>x,mtr=async()=>!1,bnr=()=>!1,xnr=()=>null,Snr=()=>({}),s9n={},c9n={},u9n=async()=>({}),Eo,dnr,fnr,pnr;";
const INSTALL = ZNR + "function install(e,t){znr(e,t)}";
const FIXTURE = [
  '"use strict";',
  STUBS,
  QUIT_DECL,
  FILTER_BLOCK,
  FN_FN,
  XER,
  INR,
  MNR,
  CNR,
  LNR,
  RNR,
  INSTALL,
  "",
].join("\n");

const UPSTREAM_FILTER =
  'function Ltr(e){return Mtr()?((e.reason==="crashed"||e.reason==="killed")&&Ftr(),"own kill"):e.reason==="clean-exit"||e.reason==="killed"&&eI()?"teardown":"needs recovery"}';
const PATCHED_FILTER =
  'function Ltr(e){return Mtr()?((e.reason==="crashed"||e.reason==="killed")&&Ftr(),"own kill"):e.reason==="clean-exit"&&!globalThis.__cdbCleanExitRecoverable(e,eI)||e.reason==="killed"&&eI()?"teardown":"needs recovery"}';
// A v2-style end-state with retired sub-patch C, which the patch must refuse.
const RETIRED = "__cdbWatchdogKillRecoverable";
const PATCHED_FILTER_V2 =
  'function Ltr(e){return Mtr()?((e.reason==="crashed"||e.reason==="killed")&&Ftr(),globalThis.__cdbWatchdogKillRecoverable(e,eI)):e.reason==="clean-exit"&&!globalThis.__cdbCleanExitRecoverable(e,eI)||e.reason==="killed"&&eI()?"teardown":"needs recovery"}';
const UPSTREAM_GRACE =
  'if(n.reason==="killed"&&(await new Promise((e=>setTimeout(e,ytr))),e.isDestroyed()||eI())){T("abandoned");return}';
const PATCHED_GRACE =
  'if((n.reason==="killed"||n.reason==="clean-exit")&&(await new Promise((e=>setTimeout(e,ytr))),e.isDestroyed()||eI())){T("abandoned");return}';
const HANDLER_HEAD =
  '(async(t,n)=>{Ker(e);let r=Date.now(),i=Ner(r),a=Ltr(n);if(a!=="needs recovery"){a==="own kill"&&w("death notice");return}';
const UPSTREAM_KILL = "e.forcefullyCrashRenderer();let r=";
const PATCHED_KILL = "globalThis.__cdbHungKillEscalate(e),e.forcefullyCrashRenderer();let r=";
// The hang-kill helper's timing log that follows the crash request.
const KILL_TIMING = ';let r=Math.round(performance.now()-t);return P.info("The hang kill blocked the main process for %d ms';
const OWN_KILL = 'a==="own kill"&&w("death notice");';
const MARKER = "__cdb_clean_exit_reload_v3__";

function runPatch(bin, file) {
  const r = spawnSync(bin, [file], { encoding: "utf8" });
  return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}

// The helper's SIGKILL fallback waits 5 s, then gives a liveness probe 2 s.
// Timers of exactly those lengths run after ESCALATE_TEST_MS / PROBE_TEST_MS
// instead (and are recorded), so the watchdog cases do not take 7 s each;
// every other timer (the 300 ms grace) keeps its length.
const ESCALATE_MS = 5000;
const ESCALATE_TEST_MS = 60;
const PROBE_MS = 2000;
const PROBE_TEST_MS = 40;
// Long enough for arm -> deadline -> probe timeout -> kill.
const SETTLE = ESCALATE_TEST_MS + PROBE_TEST_MS + 60;
// Upstream's own recovery timers. RECOVERY_COMMIT_MS (Ctr): 30 s after each
// recovery reload it checks that a page committed and reloads again if not.
// NO_DEATH_MS (wtr): 1 s after a kill attempt with no death reported, it
// reloads the view. No case here waits that long for either; they are
// recorded and unref'd so they never hold the process open, and
// fireRecovery() / fireNoDeath() run the armed one on demand.
const RECOVERY_COMMIT_MS = 30000;
const NO_DEATH_MS = 1000;

// Load the (patched) fixture into a fresh context and return knobs to drive it.
function load(src, { platform = "linux", killThrows = false } = {}) {
  const diag = [];
  const kills = [];
  const escalateDelays = [];
  const probeDelays = [];
  const recoveryTimers = [];
  const noDeathTimers = [];
  const record = (list, fn, ms, a) => {
    const r = { fn, args: a, t: null, done: false };
    r.t = setTimeout(() => {
      r.done = true;
      fn(...a);
    }, ms);
    r.t.unref();
    list.push(r);
    return r.t;
  };
  const fireLatest = async (list) => {
    const r = [...list].reverse().find((x) => !x.done);
    if (!r) return false;
    r.done = true;
    clearTimeout(r.t);
    r.fn(...r.args);
    await new Promise((res) => setImmediate(res));
    return true;
  };
  const sandbox = {
    setImmediate,
    setTimeout: (fn, ms, ...a) => {
      if (ms === ESCALATE_MS) {
        escalateDelays.push(ms);
        return setTimeout(fn, ESCALATE_TEST_MS, ...a);
      }
      if (ms === PROBE_MS) {
        probeDelays.push(ms);
        return setTimeout(fn, PROBE_TEST_MS, ...a);
      }
      if (ms === RECOVERY_COMMIT_MS) return record(recoveryTimers, fn, ms, a);
      if (ms === NO_DEATH_MS) return record(noDeathTimers, fn, ms, a);
      return setTimeout(fn, ms, ...a);
    },
    clearTimeout: (t) => {
      for (const r of recoveryTimers) if (r.t === t) r.done = true;
      for (const r of noDeathTimers) if (r.t === t) r.done = true;
      clearTimeout(t);
    },
    Date,
    Promise,
    Math,
    WeakSet,
    WeakMap,
    URL,
    console,
    performance,
    process: {
      platform,
      versions: { electron: "45.2.1" },
      memoryUsage: () => ({ rss: 0 }),
      kill: (pid, sig) => {
        if (killThrows) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        kills.push([pid, sig]);
      },
    },
    __cdbDiag: (s) => diag.push(s),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    sandbox,
    diag,
    kills,
    escalateDelays,
    probeDelays,
    recoveryTimers,
    install: (wc, opts) => vm.runInContext("install", sandbox)(wc, opts),
    setQuitting: (v) => vm.runInContext(`JF=${v ? "!0" : "!1"}`, sandbox),
    // A token as the watchdog leaves it once its kill attempt is over (ktr, then jtr).
    addToken: () => vm.runInContext("FN.push(Date.now()+_tr)", sandbox),
    tokens: () => vm.runInContext("FN.length", sandbox),
    expectedDumps: () => vm.runInContext("htr.length", sandbox),
    setHang: (v) => vm.runInContext(`__hang=${JSON.stringify(v)}`, sandbox),
    log: () => vm.runInContext("__log", sandbox),
    // Upstream's 30 s "committed no page" re-checks still armed.
    pendingRecovery: () => recoveryTimers.filter((r) => !r.done).length,
    // Upstream's 1 s "no death notice" reloads still armed.
    pendingNoDeath: () => noDeathTimers.filter((r) => !r.done).length,
    // Run the latest armed timer now (as if its time had passed).
    fireRecovery: () => fireLatest(recoveryTimers),
    fireNoDeath: () => fireLatest(noDeathTimers),
    overlays: () => vm.runInContext("__overlay.length", sandbox),
  };
}

function makeWc({ pid = 4242 } = {}) {
  const handlers = {};
  const wc = {
    destroyed: false,
    crashed: false,
    pid,
    pidCalls: 0,
    reloads: 0,
    crashRequests: 0,
    on(name, fn) {
      (handlers[name] ||= []).push(fn);
      return wc;
    },
    removeListener(name, fn) {
      handlers[name] = (handlers[name] || []).filter((f) => f !== fn);
      return wc;
    },
    listeners: (name) => (handlers[name] || []).length,
    isDestroyed() {
      return wc.destroyed;
    },
    isCrashed() {
      return wc.crashed;
    },
    getOSProcessId() {
      // pidThrows: upstream's own pre-kill liveness check (one call) still
      // gets the pid; every later call throws.
      if (wc.pidThrows && wc.pidCalls++ >= 1) throw new Error("no process");
      return wc.pid;
    },
    forcefullyCrashRenderer() {
      wc.crashRequests++; /* Linux: served on the renderer IO thread, which a whole-process stall never runs */
    },
    // Liveness probe target. "hang" (default): a hung renderer never answers;
    // "answer": resolves; "reject": rejects like a disposed frame.
    probeMode: "hang",
    probes: [],
    onProbe: null,
    mainFrame: {
      executeJavaScript(code, gesture) {
        wc.probes.push([code, gesture, "mainFrame"]);
        if (wc.onProbe) wc.onProbe();
        if (wc.probeMode === "answer") return Promise.resolve(1);
        if (wc.probeMode === "reject")
          return Promise.reject(new Error("Render frame was disposed before WebFrameMain could be accessed"));
        return new Promise(() => {});
      },
    },
    executeJavaScript(code, gesture) {
      wc.probes.push([code, gesture, "webContents"]);
      /* upstream's hang-kill spare check evaluates `true` */
      return wc.probeMode === "answer" ? Promise.resolve(code === "true" ? true : 1) : new Promise(() => {});
    },
    reload() {
      wc.reloads++;
    },
    // Upstream's re-check asks these; a killed renderer has no load in flight.
    loading: false,
    isLoading: () => wc.loading,
    isWaitingForResponse: () => false,
    stop() {},
    getURL: () => "https://claude.ai/new",
  };
  const fire = async (name, ...args) => {
    for (const fn of handlers[name] || []) await fn(...args);
  };
  wc.emit = async (details) => {
    await fire("render-process-gone", {}, details);
    // Rnr reloads on setImmediate; give it one macrotask.
    await new Promise((r) => setImmediate(r));
  };
  wc.unresponsive = async () => {
    await fire("unresponsive");
    await new Promise((r) => setImmediate(r));
  };
  wc.responsive = () => fire("responsive");
  return wc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = join(tmpdir(), `cdb-renderer-clean-exit-${process.pid}`);
const rendererLines = (ctx) => ctx.diag.filter((l) => l.startsWith("[cdb-renderer] "));
const POST_KILL_RELOAD = "Reloading after the hang kill: %s, %d ms after it";

try {
  mkdirSync(scratch, { recursive: true });
  let patchMissing = false;
  try {
    accessSync(PATCH_BIN, constants.X_OK);
  } catch {
    patchMissing = true;
    console.log(
      "  SKIP patches/linux/fix_renderer_clean_exit_reload is not compiled " +
        "(run: make -C patches linux/fix_renderer_clean_exit_reload)"
    );
  }
  if (patchMissing) {
    console.log(`${pass} checks passed; everything SKIPPED`);
    process.exit(SKIP_EXIT);
  }

  console.log("\n[1] the compiled patch applies to the v5.1231.0 shapes, idempotently");
  const pristineFile = join(scratch, "index-pristine.js");
  writeFileSync(pristineFile, FIXTURE);
  let pristineOk = true;
  try {
    execFileSync("node", ["--check", pristineFile], { stdio: "pipe" });
  } catch {
    pristineOk = false;
  }
  check("verbatim upstream fixture passes node --check", pristineOk, true);
  check("fixture carries the verbatim upstream filter", FIXTURE.includes(UPSTREAM_FILTER), true);
  check("fixture carries the verbatim handler head", FIXTURE.includes(HANDLER_HEAD), true);
  const file = join(scratch, "index.js");
  writeFileSync(file, FIXTURE);
  const r1 = runPatch(PATCH_BIN, file);
  check("first run exits 0", r1.status, 0);
  check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
  check("no 'already' line on pristine input", /already/i.test(r1.out), false);
  check("A applied", r1.out.includes("[OK] A: clean-exit term of Ltr now consults __cdbCleanExitRecoverable (quitting=eI)"), true);
  check("B applied", r1.out.includes("[OK] B: 300 ms grace now covers clean-exit (details=n quitting=eI)"), true);
  check("no C line (sub-patch C retired)", /\bC:/.test(r1.out), false);
  check("D applied", r1.out.includes("[OK] D: SIGKILL fallback armed before e.forcefullyCrashRenderer() (hang-kill helper)"), true);
  check("3/3 reported", r1.out.includes("3/3 patches applied"), true);
  const patched = readFileSync(file, "utf8");
  check("filter rewritten (A only, token branch still upstream's \"own kill\")", patched.includes(PATCHED_FILTER), true);
  check(`retired ${RETIRED} absent from the patched output`, patched.includes(RETIRED), false);
  check("upstream filter gone", patched.includes(UPSTREAM_FILTER), false);
  check("grace widened", patched.includes(PATCHED_GRACE), true);
  check("upstream grace gone", patched.includes(UPSTREAM_GRACE), false);
  check("hang-kill helper escalates before forcefullyCrashRenderer", patched.includes(PATCHED_KILL), true);
  check("forcefullyCrashRenderer still called once", patched.split(".forcefullyCrashRenderer(").length - 1, 1);
  check("helper inlined right in front of the filter", patched.includes("})();" + PATCHED_FILTER), true);
  check("marker injected once", patched.split(MARKER).length - 1, 1);
  check("v1/v2 markers absent", /__cdb_clean_exit_reload_v[12]__/.test(patched), false);
  check("handler head untouched", patched.includes(HANDLER_HEAD), true);
  let syntaxOk = true;
  try {
    execFileSync("node", ["--check", file], { stdio: "pipe" });
  } catch {
    syntaxOk = false;
  }
  check("patched fixture passes node --check", syntaxOk, true);
  const r2 = runPatch(PATCH_BIN, file);
  check("second run exits 0", r2.status, 0);
  check("second run reports A already applied", r2.out.includes("[OK] A: clean-exit term already consults __cdbCleanExitRecoverable (" + MARKER + ")"), true);
  check("second run reports B already applied", r2.out.includes("[OK] B: 300 ms grace already covers clean-exit"), true);
  check("second run: no C line", /\bC:/.test(r2.out), false);
  check("second run reports D already applied", r2.out.includes("[OK] D: SIGKILL fallback already armed before forcefullyCrashRenderer (" + MARKER + ")"), true);
  check("second run leaves the file byte-identical", readFileSync(file, "utf8") === patched, true);

  console.log("\n[2] clean-exit while the app is idle -> the main view reloads");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("reload() called once", wc.reloads, 1);
    check("upstream's own log line follows", ctx.log().includes("Main webview render process gone: %o"), true);
    check("one [cdb-renderer] decision line", rendererLines(ctx).length, 1);
    check("...saying it was handed on", ctx.diag[0].includes("handing it to the reload path (1/3"), true);
  }
  {
    const ctx = load(FIXTURE);
    const wc = makeWc();
    ctx.install(wc);
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("unpatched upstream: the same clean-exit is dropped (the bug)", wc.reloads, 0);
  }

  console.log("\n[3] clean-exit while the app quits -> suppressed, as before");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    ctx.setQuitting(true);
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("no reload", wc.reloads, 0);
    check("no upstream log line", ctx.log().includes("Main webview render process gone: %o"), false);
    check("decision logged as quitting", ctx.diag.some((l) => l.includes("app is quitting, leaving it suppressed")), true);
  }
  {
    // before-quit landing a moment after the renderer exit: the grace catches it.
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    const p = wc.emit({ reason: "clean-exit", exitCode: 0 });
    await sleep(50);
    ctx.setQuitting(true);
    await p;
    check("quit within the 300 ms grace: no reload", wc.reloads, 0);
  }

  console.log("\n[4] clean-exit of a view that is destroyed within the grace -> suppressed");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    const p = wc.emit({ reason: "clean-exit", exitCode: 0 });
    await sleep(50);
    wc.destroyed = true;
    await p;
    check("no reload", wc.reloads, 0);
    check("no upstream log line", ctx.log().includes("Main webview render process gone: %o"), false);
  }

  console.log("\n[5] a clean-exit loop falls back to upstream behavior after 3 reloads in 10 min");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    for (let k = 0; k < 3; k++) await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("three reloads handed on", wc.reloads, 3);
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("4th within the window: still three", wc.reloads, 3);
    check("...and logged as capped", ctx.diag.some((l) => l.includes("3 reloads in the last 10 min, leaving it suppressed")), true);
    // Age our window out: timestamps older than 10 min are forgotten and the
    // next clean-exit is handed on again. Upstream's own cap (3 reloads per 5
    // minutes since the last event) then still holds in this run - the second
    // layer that bounds a loop even if ours let everything through.
    const arr = ctx.sandbox.__cdbCleanExitReloads;
    for (let k = 0; k < arr.length; k++) arr[k] -= 11 * 60 * 1000;
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check(
      "after our window passed: handed on again (1/3)",
      ctx.diag[ctx.diag.length - 1].includes("handing it to the reload path (1/3"),
      true
    );
    check("...and upstream's own 5-minute cap takes over", ctx.log().includes("Recovery reload cap reached; not reloading again"), true);
    check("...so still three reloads", wc.reloads, 3);
  }
  {
    const ctx = load(patched, { platform: "darwin" });
    const wc = makeWc();
    ctx.install(wc);
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("non-Linux platform keeps upstream's verdict (no reload)", wc.reloads, 0);
  }

  console.log("\n[6] no token pending: other reasons keep upstream's verdicts");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.emit({ reason: "crashed", exitCode: 132 });
    check("crashed -> reload (unchanged)", wc.reloads, 1);
    check("no [cdb-renderer] line for crashed", ctx.diag.length, 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    ctx.setQuitting(true);
    await wc.emit({ reason: "killed", exitCode: 15 });
    check("killed while quitting -> suppressed (unchanged)", wc.reloads, 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.emit({ reason: "killed", exitCode: 9 });
    check("killed while idle -> reload (unchanged)", wc.reloads, 1);
    check("no [cdb-renderer] line for an untokened kill", ctx.diag.length, 0);
  }

  console.log("\n[7] a token pending but no kill attempt in flight: the death is dropped, as upstream does (C retired)");
  for (const reason of ["killed", "crashed", "clean-exit"]) {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    ctx.addToken();
    await wc.emit({ reason, exitCode: reason === "killed" ? 9 : reason === "crashed" ? 11 : 0 });
    check(`token + ${reason} -> dropped, no reload`, wc.reloads, 0);
    check(`token + ${reason}: token consumed`, ctx.tokens(), 0);
    check(`token + ${reason}: Ftr notes an expected crash dump only for killed/crashed`, ctx.expectedDumps(), reason === "clean-exit" ? 0 : 1);
    check(`token + ${reason}: no upstream death line`, ctx.log().includes("Main webview render process gone: %o"), false);
    check(`token + ${reason}: no [cdb-renderer] line`, ctx.diag.length, 0);
  }

  console.log("\n[8] a death from elsewhere during a kill attempt: upstream's post-kill reload, D stands down");
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 800 });
    ctx.install(wc);
    await wc.unresponsive();
    check("no reload right after the crash request", wc.reloads, 0);
    check("upstream armed its 1 s no-death-notice reload", ctx.pendingNoDeath(), 1);
    // The OOM killer (or the user) kills the stalled renderer before our deadline.
    wc.crashed = true;
    await wc.emit({ reason: "killed", exitCode: 9 });
    check("the `killed` is an own kill: upstream reloads once", wc.reloads, 1);
    check("...with upstream's post-kill log line", ctx.log().includes(POST_KILL_RELOAD), true);
    check("...token consumed", ctx.tokens(), 0);
    check("...no upstream death line", ctx.log().includes("Main webview render process gone: %o"), false);
    check("...the 1 s fallback is cancelled", ctx.pendingNoDeath(), 0);
    await sleep(SETTLE);
    check("D stands down: no SIGKILL", ctx.kills.length, 0);
    check("...logged", ctx.diag.some((l) => l.includes("renderer 800 already gone, SIGKILL fallback not needed")), true);
    check("...no error card", ctx.overlays(), 0);
  }

  console.log("\n[9] watchdog: SIGKILL fallback only while the renderer stays hung");
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 5151 });
    ctx.install(wc);
    await wc.unresponsive();
    check("upstream asked forcefullyCrashRenderer()", wc.crashRequests, 1);
    check("token added by upstream", ctx.tokens(), 1);
    check("armed with a 5 s delay", ctx.escalateDelays.join(","), "5000");
    check("arm logged", ctx.diag.some((l) => l.includes("renderer 5151 hung, forcefullyCrashRenderer() requested; SIGKILL in 5 s")), true);
    check("one responsive listener", wc.listeners("responsive"), 1);
    await wc.unresponsive();
    await wc.unresponsive();
    check("repeated unresponsive: still one responsive listener", wc.listeners("responsive"), 1);
    check("repeated unresponsive: first deadline kept (one timer)", ctx.escalateDelays.length, 1);
    check("not killed before the deadline", ctx.kills.length, 0);
    await sleep(SETTLE);
    check("killed once after the deadline", ctx.kills.length, 1);
    check("...with SIGKILL to the recorded pid", JSON.stringify(ctx.kills[0]), JSON.stringify([5151, "SIGKILL"]));
    check("one liveness probe, main frame, evaluating 1, no user gesture", JSON.stringify(wc.probes), JSON.stringify([["1", false, "mainFrame"]]));
    // 2 s timers: upstream's telemetry race (Cnr, vtr) once per attempt, plus our one probe timeout.
    check("probe raced against a 2 s timeout (next to upstream's 3 telemetry races)", ctx.probeDelays.length, 4);
    check(
      "escalation logged",
      ctx.diag.some((l) =>
        l.includes("renderer 5151 still hung after forcefullyCrashRenderer() (5 s, then liveness probe: no answer in 2 s), escalating to SIGKILL")
      ),
      true
    );
    check("three tokens left by the three attempts", ctx.tokens(), 3);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.unresponsive();
    await wc.responsive();
    await sleep(SETTLE);
    check("responsive in time -> no kill", ctx.kills.length, 0);
    check("cancel logged", ctx.diag.some((l) => l.includes("is responsive again, SIGKILL fallback cancelled")), true);
    // A later hang arms again.
    await wc.unresponsive();
    await sleep(SETTLE);
    check("a later hang arms and kills again", ctx.kills.length, 1);
    check("...still one responsive listener", wc.listeners("responsive"), 1);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.unresponsive();
    wc.destroyed = true;
    await sleep(SETTLE);
    check("destroyed before the deadline -> no kill", ctx.kills.length, 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.unresponsive();
    wc.crashed = true;
    await sleep(SETTLE);
    check("crashed before the deadline -> no kill", ctx.kills.length, 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 100 });
    ctx.install(wc);
    await wc.unresponsive();
    wc.pid = 101;
    await sleep(SETTLE);
    check("pid changed before the deadline -> no kill", ctx.kills.length, 0);
    check("...logged", ctx.diag.some((l) => l.includes("renderer changed (100 -> 101)")), true);
  }
  {
    // The user (or the OOM killer) kills the hung renderer first; the reloaded
    // renderer reports responsive and cancels the pending fallback.
    const ctx = load(patched);
    const wc = makeWc({ pid: 200 });
    ctx.install(wc);
    await wc.unresponsive();
    wc.pid = 201;
    await wc.responsive();
    await sleep(SETTLE);
    check("new renderer responsive -> no kill", ctx.kills.length, 0);
    check("...logged with the pid change", ctx.diag.some((l) => l.includes("responsive on a new renderer (200 -> 201), SIGKILL fallback cancelled")), true);
  }
  {
    // Seen live: Electron emits `responsive` as the killed renderer goes away,
    // before a new one exists (getOSProcessId() is 0 then).
    const ctx = load(patched);
    const wc = makeWc({ pid: 300 });
    ctx.install(wc);
    await wc.unresponsive();
    wc.pid = 0;
    await wc.responsive();
    await sleep(SETTLE);
    check("renderer gone, responsive -> no kill", ctx.kills.length, 0);
    check("...logged as gone", ctx.diag.some((l) => l.includes("renderer 300 is gone (hang monitor reset), SIGKILL fallback cancelled")), true);
  }
  {
    const ctx = load(patched, { platform: "darwin" });
    const wc = makeWc();
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("non-Linux: upstream still asks forcefullyCrashRenderer()", wc.crashRequests, 1);
    check("non-Linux: not armed, no kill", ctx.kills.length + ctx.escalateDelays.length, 0);
    check("non-Linux: no responsive listener of ours", wc.listeners("responsive"), 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    wc.pidThrows = true;
    ctx.install(wc);
    let threw = false;
    try {
      await wc.unresponsive();
    } catch {
      threw = true;
    }
    check("getOSProcessId throwing in our helper never breaks the watchdog", threw, false);
    check("...forcefullyCrashRenderer still requested", wc.crashRequests, 1);
    check("...logged as not armed", ctx.diag.some((l) => l.includes("SIGKILL fallback not armed")), true);
  }
  {
    const ctx = load(patched, { killThrows: true });
    const wc = makeWc();
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("process.kill throwing is caught and logged", ctx.diag.some((l) => l.includes("SIGKILL fallback failed: kill ESRCH")), true);
  }

  console.log("\n[9b] watchdog: the liveness probe decides at the deadline");
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 610 });
    wc.probeMode = "answer";
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("probe answers -> no kill", ctx.kills.length, 0);
    check("...one probe", wc.probes.length, 1);
    check("...cancel logged", ctx.diag.some((l) => l.includes("renderer 610 answered a liveness probe 5 s after forcefullyCrashRenderer(), SIGKILL cancelled")), true);
    // The slot is free again: a later hang arms and probes anew.
    wc.probeMode = "hang";
    await wc.unresponsive();
    await sleep(SETTLE);
    check("...a later real hang still gets killed", ctx.kills.length, 1);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 620 });
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(ESCALATE_TEST_MS + 10);
    check("probe in flight: not killed yet", ctx.kills.length, 0);
    check("probe in flight: one probe", wc.probes.length, 1);
    await wc.unresponsive();
    check("probe in flight: another unresponsive arms nothing", ctx.escalateDelays.length, 1);
    await sleep(SETTLE);
    check("probe times out -> kill", JSON.stringify(ctx.kills), JSON.stringify([[620, "SIGKILL"]]));
    check("...still one probe in total", wc.probes.length, 1);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 630 });
    wc.probeMode = "reject";
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("probe rejects -> kill", JSON.stringify(ctx.kills), JSON.stringify([[630, "SIGKILL"]]));
    check("...reason logged", ctx.diag.some((l) => l.includes("liveness probe: probe rejected: Render frame was disposed")), true);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 640 });
    wc.onProbe = () => {
      wc.pid = 641;
    };
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("pid changes during the probe -> no kill", ctx.kills.length, 0);
    check("...logged", ctx.diag.some((l) => l.includes("renderer changed (640 -> 641), SIGKILL fallback skipped")), true);
  }
  for (const [label, act] of [
    ["crashed", (wc) => (wc.crashed = true)],
    ["destroyed", (wc) => (wc.destroyed = true)],
  ]) {
    const ctx = load(patched);
    const wc = makeWc();
    wc.onProbe = () => act(wc);
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check(`${label} during the probe -> no kill`, ctx.kills.length, 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 650 });
    let fired = null;
    wc.onProbe = () => {
      fired = wc.responsive();
    };
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    await fired;
    check("responsive during the probe -> no kill", ctx.kills.length, 0);
    check("...one cancel line", ctx.diag.filter((l) => l.includes("SIGKILL fallback cancelled")).length, 1);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 660 });
    wc.mainFrame = null;
    wc.probeMode = "answer";
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("no mainFrame: falls back to webContents.executeJavaScript", JSON.stringify(wc.probes), JSON.stringify([["1", false, "webContents"]]));
    check("...and its answer cancels", ctx.kills.length, 0);
  }

  console.log("\n[9c] upstream's hang-kill spare check runs first; a spared renderer never arms the fallback");
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 710 });
    wc.probeMode = "answer";
    ctx.install(wc, { hangKillSpareEnabled: () => true });
    ctx.setHang({ responsive: { responsive_arrived: true } });
    await wc.unresponsive();
    await sleep(SETTLE);
    check("spared: no crash request", wc.crashRequests, 0);
    check("spared: fallback never armed", ctx.escalateDelays.length, 0);
    check("spared: no kill", ctx.kills.length, 0);
    check("spared: no reload", wc.reloads, 0);
    check("spared: upstream dropped its pending token", ctx.tokens(), 0);
    check("spared: upstream logged the call-off", ctx.log().some((l) => String(l).includes("hang kill called off")), true);
  }
  {
    // Spare check on, but the page does not answer within upstream's 500 ms.
    const ctx = load(patched);
    const wc = makeWc({ pid: 720 });
    ctx.install(wc, { hangKillSpareEnabled: () => true });
    ctx.setHang({ responsive: { responsive_arrived: true } });
    await wc.unresponsive();
    check("no answer: upstream asks forcefullyCrashRenderer()", wc.crashRequests, 1);
    check("...the fallback is armed", ctx.escalateDelays.join(","), "5000");
    check("...upstream started its 30 s recovery check", ctx.recoveryTimers.length, 1);
    await sleep(SETTLE);
    check("...and fires", JSON.stringify(ctx.kills), JSON.stringify([[720, "SIGKILL"]]));
  }

  console.log("\n[10] end to end: stalled renderer -> watchdog -> 1 s reload into the same renderer -> SIGKILL -> upstream's post-kill reload");
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 7000 });
    ctx.install(wc);
    for (let k = 0; k < 4; k++) await wc.unresponsive(); // the 4 attempts seen in the repro
    check("no reload yet: the stalled renderer never reported a death", wc.reloads, 0);
    check("upstream's 1 s no-death-notice reload is armed", await ctx.fireNoDeath(), true);
    check("...and reloads the view (same, stalled renderer)", wc.reloads, 1);
    check("...with upstream's post-kill log line", ctx.log().includes(POST_KILL_RELOAD), true);
    await sleep(SETTLE);
    check("one SIGKILL to the stalled renderer", JSON.stringify(ctx.kills), JSON.stringify([[7000, "SIGKILL"]]));
    // Electron reports the SIGKILLed renderer:
    wc.crashed = true;
    await wc.emit({ reason: "killed", exitCode: 9 });
    check("the `killed` is an own kill: upstream reloads into a new renderer", wc.reloads, 2);
    check("...one of the four tokens consumed", ctx.tokens(), 3);
    check("...upstream did not log a death", ctx.log().includes("Main webview render process gone: %o"), false);
    check("...no hand-on decision of ours", ctx.diag.some((l) => l.includes("handing it to")), false);
    check("...no error card", ctx.overlays(), 0);
  }
  {
    const ctx = load(FIXTURE);
    const wc = makeWc({ pid: 7100 });
    ctx.install(wc);
    await wc.unresponsive();
    await ctx.fireNoDeath();
    await sleep(SETTLE);
    check("unpatched upstream: the stalled renderer is never killed (the bug)", ctx.kills.length, 0);
    check("...its only reload went to the stalled renderer", wc.reloads, 1);
  }

  console.log("\n[11] refusals: exit 1, file untouched");
  const refusal = (label, src, needle) => {
    const f = join(scratch, `index-${label.replace(/\W+/g, "-")}.js`);
    writeFileSync(f, src);
    const r = runPatch(PATCH_BIN, f);
    check(`${label}: exit 1`, r.status, 1);
    if (needle) check(`${label}: names the problem`, r.out.includes(needle), true);
    check(`${label}: file untouched`, readFileSync(f, "utf8") === src, true);
  };
  // D counts `.forcefullyCrashRenderer(` after the helper is inlined, so the helper must never carry it.
  check(
    "helper js/renderer_clean_exit.js never contains the literal `.forcefullyCrashRenderer(`",
    readFileSync(join(repo, "js", "renderer_clean_exit.js"), "utf8").includes(".forcefullyCrashRenderer("),
    false
  );
  refusal(
    "upstream already reloads after clean-exit (absorbed)",
    FIXTURE.replace('e.reason==="clean-exit"||e.reason==="killed"&&eI()?"teardown"', 'e.reason==="killed"&&eI()?"teardown"'),
    "re-audit whether sub-patch A is absorbed and drop it (Rule 4)"
  );
  refusal(
    "token branch no longer an own kill",
    FIXTURE.replace('&&Ftr(),"own kill"):', '&&Ftr(),"teardown"):'),
    "[FAIL] A: reason filter"
  );
  refusal(
    "handler no longer returns early on the verdict",
    FIXTURE.replace('if(a!=="needs recovery"){', 'if(a==="teardown"){'),
    'guard(s) found, expected 1'
  );
  const NO_TIMING = ';let r=0;return P.info("killed in %d ms';
  refusal(
    "hang-kill helper reshaped (no timing log after the crash request)",
    FIXTURE.replace(KILL_TIMING, NO_TIMING),
    "[FAIL] D: the hang-kill helper's"
  );
  refusal(
    "watchdog crash request duplicated",
    FIXTURE.replace(UPSTREAM_KILL, "e.forcefullyCrashRenderer();" + UPSTREAM_KILL),
    "[FAIL] D: the hang-kill helper's"
  );
  refusal(
    "own kill no longer handed to the post-kill reload",
    FIXTURE.replace(OWN_KILL, 'a==="own kill";'),
    "[FAIL] D: the hang-kill helper's"
  );
  refusal("grace missing", FIXTURE.replace(UPSTREAM_GRACE, "if(e.isDestroyed())return;"), "[FAIL] B:");
  refusal(
    "patched calls present but the v3 helper missing (no false [OK])",
    patched.replace(MARKER, "__cdb_clean_exit_reload_v2__"),
    "[FAIL] A: reason filter"
  );
  refusal(
    "stale v2-style output with retired sub-patch C (no false [OK])",
    patched.replace(PATCHED_FILTER, PATCHED_FILTER_V2).replace(MARKER, "__cdb_clean_exit_reload_v2__"),
    "[FAIL] A: reason filter"
  );
  refusal(
    `v3 output plus the retired ${RETIRED} helper (no false [OK])`,
    patched.replace(PATCHED_FILTER, `globalThis.${RETIRED} ||= function(){return !0};` + PATCHED_FILTER),
    `retired ${RETIRED} 1`
  );
  refusal(
    "applied, plus a stray __cdbHungKillEscalate call elsewhere (no false [OK])",
    patched.replace(PATCHED_FILTER, "globalThis.__cdbHungKillEscalate(x);" + PATCHED_FILTER),
    "[FAIL] D: 1 __cdbHungKillEscalate call(s) in front of the hang-kill helper's crash request, 2 in total"
  );
  refusal(
    "filter patched but the watchdog call missing and the helper reshaped (no false [OK])",
    patched.replace(PATCHED_KILL, UPSTREAM_KILL).replace(KILL_TIMING, NO_TIMING),
    "[FAIL] D:"
  );

  console.log("\n[12] fix_renderer_gone_suppressed_log composes with this patch, in both orders");
  let logMissing = false;
  try {
    accessSync(LOG_PATCH_BIN, constants.X_OK);
  } catch {
    logMissing = true;
    console.log("  SKIP patches/linux/fix_renderer_gone_suppressed_log is not compiled");
  }
  if (!logMissing) {
    // Basename order (what scripts/apply_patches.py runs): ours, then the log patch.
    const r = runPatch(LOG_PATCH_BIN, file);
    check("suppressed-log patch applies after ours", r.status, 0);
    check("...with its one match", r.out.includes("[OK] suppressed renderer-gone log: 1 match"), true);
    const both = readFileSync(file, "utf8");
    check("our grace survives its rewrite", both.includes('if((n.reason==="killed"||n.reason==="clean-exit")&&(await new Promise('), true);
    check("our filter survives its rewrite", both.includes(PATCHED_FILTER), true);
    check("our watchdog call survives its rewrite", both.includes(PATCHED_KILL), true);
    const r3 = runPatch(PATCH_BIN, file);
    check("ours is still idempotent on the combined output", r3.status, 0);
    check("combined output byte-identical after our re-run", readFileSync(file, "utf8") === both, true);
    const r4 = runPatch(LOG_PATCH_BIN, file);
    check("the log patch is idempotent on the combined output", r4.status === 0 && r4.out.includes("already applied (3 early returns logged)"), true);
    check("...byte-identical", readFileSync(file, "utf8") === both, true);
    // Reverse order: the log patch first, then ours.
    const rev = join(scratch, "index-reverse.js");
    writeFileSync(rev, FIXTURE);
    check("reverse order: log patch first", runPatch(LOG_PATCH_BIN, rev).status, 0);
    const rr = runPatch(PATCH_BIN, rev);
    check("reverse order: ours applies 3/3", rr.status === 0 && rr.out.includes("3/3 patches applied"), true);
    check("reverse order: byte-identical to basename order", readFileSync(rev, "utf8") === both, true);
    let bothOk = true;
    try {
      execFileSync("node", ["--check", file], { stdio: "pipe" });
    } catch {
      bothOk = false;
    }
    check("combined output passes node --check", bothOk, true);
    check("combined: all three early returns of the handler log", both.split("Main webview render process gone (suppressed): %o").length - 1, 3);
    {
      const ctx = load(both);
      const wc = makeWc();
      ctx.install(wc);
      const p = wc.emit({ reason: "killed", exitCode: 9 });
      await sleep(50);
      wc.destroyed = true;
      await p;
      check("combined: killed, view destroyed within the grace -> logged as suppressed", ctx.log().includes("Main webview render process gone (suppressed): %o"), true);
      check("combined: ...and not reloaded", wc.reloads, 0);
    }
    {
      const ctx = load(both);
      const wc = makeWc();
      ctx.install(wc);
      wc.destroyed = true;
      await wc.emit({ reason: "crashed", exitCode: 11 });
      check("combined: crashed on a destroyed view -> logged as suppressed", ctx.log().includes("Main webview render process gone (suppressed): %o"), true);
      check("combined: ...and not reloaded", wc.reloads, 0);
    }
    {
      const ctx = load(both);
      const wc = makeWc();
      ctx.install(wc);
      await wc.emit({ reason: "clean-exit", exitCode: 0 });
      check("combined: clean-exit while idle still reloads", wc.reloads, 1);
      ctx.setQuitting(true);
      await wc.emit({ reason: "clean-exit", exitCode: 0 });
      check("combined: clean-exit while quitting is logged as suppressed", ctx.log().includes("Main webview render process gone (suppressed): %o"), true);
      check("combined: ...and not reloaded", wc.reloads, 1);
    }
    {
      const ctx = load(both);
      const wc = makeWc({ pid: 9000 });
      ctx.install(wc);
      await wc.unresponsive();
      await sleep(SETTLE);
      check("combined: watchdog escalates to SIGKILL", ctx.kills.length, 1);
      wc.crashed = true;
      const suppressed = () => ctx.log().filter((l) => l === "Main webview render process gone (suppressed): %o").length;
      await wc.emit({ reason: "killed", exitCode: 9 });
      check("combined: the own-kill `killed` is logged as suppressed by the handler", suppressed(), 1);
      check("combined: ...and reloaded by upstream's post-kill reload", wc.reloads, 1);
      ctx.addToken();
      ctx.setQuitting(true);
      await wc.emit({ reason: "killed", exitCode: 9 });
      check("combined: token + killed while quitting is logged as suppressed", suppressed(), 2);
      check("combined: ...and not reloaded", wc.reloads, 1);
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("ALL " + pass + " CHECKS PASSED");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

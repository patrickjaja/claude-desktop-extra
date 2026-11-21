#!/usr/bin/env node
// enable_local_agent_mode's feature-merger override must carry every key the
// claude.ai SPA reads to show a Linux-provided feature.
//
// WHY THIS EXISTS
// ---------------
// Computer Use is a two-sided feature: the main process registers and announces
// the computer_* tools (forced on Linux by fix_computer_use_linux), and the
// claude.ai SPA decides from the desktop's FEATURES object whether to show the
// feature and bind the tools to a chat. Until 2026-10-21 the override forced
// `computerUse` only. The SPA, however, reads `computerUseRollout` for that
// decision (v3.1623.0, ion-dist shared-26, verbatim):
//
//   function cD(e,t){return t==="supported"||t==="unavailable"&&e}
//   function lD({complianceBlocked:e,osTooOld:t,webGateOn:n,rolloutStatus:r,tier:i,selfServe:a}){...}
//
// i.e. the tools are bound only when the desktop reports the rollout as
// "supported", or as "unavailable" while the account's own web `chicago` gate
// is on. Upstream's registry entry (`lMr()`) is "supported" only through the
// Linux rollout flag 3676943315, otherwise "unsupported"/not_enabled or
// "unavailable" - so on a Team or Enterprise account (web gate off) every tool
// was announced over the bridge and hidden in the chat. The override now also
// forces `computerUseRollout:{status:"supported"}`.
//
// This harness runs the compiled patches/linux/enable_local_agent_mode against
// the v3.1623.0 registry + merger shapes (verbatim from
// .vite/build/index.chunk-6Ku8p4x3.js) and pins:
//   [1] the override run lands once, last in the merger, with the new key;
//   [2] a second run is a byte-identical no-op reported as idempotent;
//   [3] the pre-2026-10-21 six-key run is NOT taken for the patched end-state
//       (AGENTS.md Rule 6): the patch fails loud and leaves the file alone;
//   [4] the SPA's decision, evaluated verbatim, binds the tools with the
//       override and still refuses under an org compliance lock.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdirSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const PATCH_BIN = join(repo, "patches", "linux", "enable_local_agent_mode");
const SKIP_EXIT = 3;

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

// --- fixtures (v3.1623.0, verbatim) -----------------------------------------
// The static feature registry dW(): the patch verifies the merger's spread
// callee by finding `quietPenguin:` inside its body.
const REGISTRY = "function dW(){let e=Wjr();return{launch:tW,coworkBrowser:mMr(),artifactsPane:uW(),nativeQuickEntry:djr(),quickEntryDictation:eW(),quickEntryGlobalShortcut:fjr(),trayIcon:tW,customQuickEntryDictationShortcut:tW,ultrareviewErrorCategories:tW,spawnTaskPendingPop:tW,spawnTaskInFlightIds:tW,folderWorktrees:tW,folderWorktreesRemote:tW,folderWorktreesListedDiscard:tW,sableOtter:{status:\"unavailable\"},telescopeBridge:{status:\"unavailable\"},mcpFinishInApp:{status:\"unavailable\"},copperLarkA:gjr(),copperLarkB:gjr(),copperLarkC:{status:\"unavailable\"},copperLarkD:{status:\"unavailable\"},copperLarkH:{status:\"unavailable\"},quietPenguin:$U(iMr),rubberDuck:fMr(),chillingSlothFeat:nW(),chillingSlothSshShell:nW(),terminalShellReported:tW,sshBrowserPane:{status:\"unavailable\"},chillingSlothSshWorktreeLocation:yjr(),chillingSlothSshPuttyKeyConversion:{status:\"unavailable\"},chillingSlothRemoteFilePreview:nW(),chillingSlothEnterprise:_jr(),chillingSlothLocal:bjr(),yukonSilver:e,yukonSilverGems:e,yukonSilverGemsCache:e,wakeScheduler:$U(SMr),keepAwake:$H()?tW:{status:\"unavailable\"},codeSessionKeepAwake:DU()?tW:{status:\"unavailable\"},ccdPromptSuggestionsSetting:hW(\"ccdPromptSuggestionsSetting\",(()=>uy(\"2120747855\")?.on===!0))?tW:{status:\"unavailable\"},ccdLandingTools:hW(\"ccdLandingTools\",vjr)?tW:{status:\"unavailable\"},ccdMcpVerbsMidTurn:tW,ccdMcpTurnOnSshHost:tW,ccdRestartRemoteClaudeCode:tW,ccdSshStartsWithoutBlockedPlugins:tW,openWithConsentAnyLanding:tW,desktopTopBar:oMr(),ccdPlugins:tW,ccdPluginSourceRouting:tW,computerUse:cMr(),computerUseRollout:lMr(),computerUseComplianceGate:tW,computerUseAppScoped:fW(),computerUsePerAppAccess:rA()?{status:\"unsupported\",reason:\"A Wayland session shares the whole screen\",unsupportedCode:\"unknown\"}:tW,coworkWatchRecord:uMr(AV),coworkCopperHeron:uMr(jV),coworkWatchers:{status:\"unavailable\"},coworkKappa:CMr(),coworkArtifacts:wMr(),trustedFolderSettingsConsent:{status:\"unavailable\"},coworkAutoModeAlwaysAllowOverride:{status:\"unavailable\"},framebufferPreview:pMr(),iosSimulator:vMr(),androidEmulator:yMr(),iosSimulatorH264:vMr(),iosSimulatorAccessibilityReader:vMr(),iosSimulatorDuo:{status:\"unavailable\"},simulatorScreenshotEditor:{status:\"unavailable\"},simulatorMiniView:{status:\"unavailable\"},grandPrix:bMr(),chromeExtensionInstall:{status:\"unsupported\",reason:\"No per-user Chrome extension install mechanism\",unsupportedCode:\"unsupported_platform\"},ccdGitEngine:{status:\"unavailable\"},sessionPrOwnership:{status:\"unavailable\"},sessionFolderFileAccess:tW,conversationFolderGrants:tW,localSessionsWithoutGit:tW,tearOffHalo:_Mr(),coworkArtifactPopout:tW,sidePanePopoutNativeViews:tW,simulatorNativeViewPopout:tW,simulatorPopoutShortcuts:tW,simulatorNativeViewPerPane:tW,popoutZoom:tW,popoutTitleBarOverlay:gMr(),filePreviewNativeViewRouting:tW,claudeDesignWindow:tW,coworkRemoteSessionSpaces:tW,spaceMemoryBridge:my(\"1197768857\")?tW:{status:\"unavailable\"},multiAccount:!K().authentication.disableMultiAccount&&my(\"96101707\")?tW:{status:\"unavailable\"},grandPrixRequest:xMr(),bootPlaceholder:tW,coworkBranchSession:tW,coworkScheduledTaskProjects:tW,coworkLocalSessionProjects:tW,coworkScheduledTaskRepoint:tW,sshAttachmentTransport:tW,coworkSeededSummon:tW,seededKind:tW,coworkTextNotTyped:{status:\"unavailable\"},sendNowEscalation:tW,steerDetachField:tW,sessionMentions:tW,inlinePastes:tW,turnDiscardedEvent:tW,turnBoxAtReplies:tW,wslForkSession:{status:\"unavailable\"},wslTerminal:{status:\"unavailable\"},wslMcp:{status:\"unavailable\"},wslPreview:{status:\"unavailable\"},wslLocalFiles:{status:\"unavailable\"},wslRoutines:{status:\"unavailable\"},humbleSky:{status:\"unavailable\"},violinBow:{status:\"unavailable\"},violinBowHomeSettings:{status:\"unavailable\"},coworkThinkingInSend:tW,bootstrapConfig:tW,chatIn3p:tW,chatTab:dPe(K())&&mC(\"chat\",sW).allows(\"device\")?tW:{status:\"unavailable\"},selfHostedSessions:vC(sW)?tW:{status:\"unavailable\"},selfHostedCowork:cW()?tW:{status:\"unavailable\"},desktopHome:PMe(K())===void 0?{status:\"unavailable\"}:tW,chatCodeExecution:qjr()?tW:{status:\"unavailable\"},mcpPersistentAlwaysAllow:G().type===\"3p\"&&!mNe(K())?{status:\"unavailable\"}:tW,mcpScheduledTaskAlwaysAllow:G().type===\"3p\"&&!xEr()?{status:\"unavailable\"}:tW,mcpScheduledTaskApprovalLifetime:G().type===\"3p\"&&CEr()?tW:{status:\"unavailable\"},epitaxyMcpApps:tW,sideSessionProposalPicks:tW,sideSessionProposalWorktreePick:tW,sideSessionOfferCloudStart:tW,sideSessions:H7n()?tW:{status:\"unavailable\"},btwChildSessions:{status:\"unavailable\"},nestedArchiveKeepsFamily:{status:\"unavailable\"},epitaxyMcpAppPane:{status:\"unavailable\"},ccdConnectorTools:{status:\"unavailable\"},ccdTeleportSnapshot:{status:\"unavailable\"}}}";
// The async feature merger WMr(e), ending in the anchor `return{...dW(),...me}}`.
const MERGER = "async function WMr(e){let[t,n,r,i,a,o,s,c,l,u,d,f,p,m,h,g,_,v,y,b,x,S,C,w,T,ee,te,ne,re,ie,ae,oe,se,ce,le,ue,de,fe,pe]=await Promise.all([sMr(),TMr((()=>my(\"123929380\"))),TMr((()=>my(\"2940196192\"))),TMr((()=>my(\"4200321681\"))),vW((()=>hW(\"sideSessions\",(()=>my(\"2371478310\"))))),vW((()=>hW(\"btwChildSessions\",nOr))),vW((()=>hW(\"nestedArchiveKeepsFamily\",lOr))),vW((()=>hW(\"epitaxyMcpAppPane\",tOr))),dMr(AV),dMr(jV),MMr(),vW(pU),vW(fkr),DMr(),kMr(),OMr(),FMr(),vW(eU),vW(AOr),vW((()=>hW(\"wslTerminal\",UTr))),vW((()=>hW(\"wslMcp\",jOr))),vW((()=>hW(\"wslPreview\",NOr))),vW((()=>hW(\"wslLocalFiles\",HTr))),vW((()=>hW(\"wslRoutines\",ADr))),vW(NDr),vW((()=>hW(\"ccdTeleportSnapshot\",FOr))),AMr(),jMr(),aMr(),UMr(e?.webContents),Promise.resolve(void 0),Promise.resolve(void 0),pjr(),vW((()=>hW(\"iosSimulatorDuo\",Wkr))),vW((()=>hW(\"trustedFolderSettingsConsent\",NEr))),vW((()=>hW(\"simulatorScreenshotEditor\",bAr))),vW((()=>hW(\"simulatorMiniView\",SAr))),Promise.resolve(void 0),Promise.resolve(void 0),iW(),e?.primeManagedPreviewPolicy?cN():void 0,e?.primeManagedPreviewPolicy?qDr():void 0]),me={telescopeBridge:v,louderPenguin:t,coworkKappa:n,coworkArtifacts:r,coworkAutoModeAlwaysAllowOverride:i,sideSessions:a,btwChildSessions:o,nestedArchiveKeepsFamily:s,epitaxyMcpAppPane:c,coworkWatchRecord:l,coworkCopperHeron:u,coworkWatchers:d,ccdGitEngine:f,sessionPrOwnership:f,violinBow:p,violinBowHomeSettings:m,coworkTextNotTyped:g,sableOtter:re,computerUseAppScoped:_,wslForkSession:y,wslTerminal:b,wslMcp:x,wslPreview:S,sshBrowserPane:hW(\"sshBrowserPane\",_N)?tW:{status:\"unavailable\"},wslLocalFiles:C,wslRoutines:w,ccdConnectorTools:T,ccdTeleportSnapshot:ee,chillingSlothSshPuttyKeyConversion:te,humbleSky:ne,mcpFinishInApp:ie,trayIcon:se,iosSimulatorDuo:ce,trustedFolderSettingsConsent:le,simulatorScreenshotEditor:ue,simulatorMiniView:de};return{...dW(),...me}}";
// The preferences defaults line Patch 4 flips.
const PREFS = 'var prefs={sableOtterTerms:[],quietPenguinEnabled:!1,louderPenguinEnabled:!1,rubberDuckEnabled:!1};';

const FIXTURE = REGISTRY + "\n" + MERGER + "\n" + PREFS + "\n";

const OVERRIDES =
  ',quietPenguin:{status:"supported"},louderPenguin:{status:"supported"},chillingSlothFeat:{status:"supported"},chillingSlothLocal:{status:"supported"},ccdPlugins:{status:"supported"},computerUse:{status:"supported"},computerUseRollout:{status:"supported"}';
const LEGACY_OVERRIDES =
  ',quietPenguin:{status:"supported"},louderPenguin:{status:"supported"},chillingSlothFeat:{status:"supported"},chillingSlothLocal:{status:"supported"},ccdPlugins:{status:"supported"},computerUse:{status:"supported"}';
const ANCHOR = "return{...dW(),...me}}";

// The SPA's availability decision (ion-dist assets/v1/shared-26-e5-eVUgi.js,
// v3.1623.0, verbatim). `oD` maps the tier: raven -> organization.
const SPA_DECISION =
  'function oD(e){return e==="raven"?"organization":"account"}' +
  'function cD(e,t){return t==="supported"||t==="unavailable"&&e}' +
  'function lD({complianceBlocked:e,osTooOld:t,webGateOn:n,rolloutStatus:r,tier:i,selfServe:a}){let o=r==="unsupported";return e?{kind:"compliance",rolloutOff:o}:t?{kind:"os_version",rolloutOff:o}:cD(n,r)?null:i==="free"&&a?{kind:"plan",rolloutOff:o}:{kind:oD(i),rolloutOff:o}}' +
  "return{cD,lD}";

function runPatch(file) {
  const r = spawnSync(PATCH_BIN, [file], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

const scratch = join(tmpdir(), `cdb-local-agent-mode-${process.pid}`);
mkdirSync(scratch, { recursive: true });
try {
  check("fixture holds the merger anchor once", count(FIXTURE, ANCHOR), 1);
  check("fixture registry lists quietPenguin: once", count(REGISTRY, "quietPenguin:"), 1);
  check("fixture registry has upstream's computerUseRollout entry", count(REGISTRY, "computerUseRollout:lMr()"), 1);

  let patchMissing = false;
  try {
    accessSync(PATCH_BIN, constants.X_OK);
  } catch {
    patchMissing = true;
    console.log(
      "  SKIP patches/linux/enable_local_agent_mode is not compiled " +
        "(run: make -C patches linux/enable_local_agent_mode)"
    );
  }

  let patched = null;
  if (!patchMissing) {
    console.log("\n[1] first run: the override run lands once, last in the merger");
    const file = join(scratch, "index.js");
    writeFileSync(file, FIXTURE);
    const r1 = runPatch(file);
    check("exit 0", r1.status, 0);
    check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
    check(
      "merger override reported via dW() with 7 keys",
      r1.out.includes("[OK] feature merger via dW(): 7 features overridden (1 match)"),
      true
    );
    check(
      "preference defaults flipped",
      r1.out.includes("[OK] Preferences defaults: quietPenguinEnabled + louderPenguinEnabled -> true (1 match)"),
      true
    );
    patched = readFileSync(file, "utf8");
    check("override run present exactly once", count(patched, OVERRIDES), 1);
    check(
      "override run sits last in the merger return",
      count(patched, "return{...dW(),...me" + OVERRIDES + "}}"),
      1
    );
    check("computerUseRollout forced once", count(patched, 'computerUseRollout:{status:"supported"}'), 1);
    check("upstream anchor no longer present verbatim", patched.includes(ANCHOR), false);
    check(
      "preference defaults now true",
      count(patched, "quietPenguinEnabled:!0,louderPenguinEnabled:!0"),
      1
    );
    check(
      "registry untouched (upstream computerUseRollout:lMr() still there)",
      count(patched, "computerUseRollout:lMr()"),
      1
    );
    let syntaxOk = true;
    try {
      execFileSync("node", ["--check", file], { stdio: "pipe" });
    } catch {
      syntaxOk = false;
    }
    check("patched fixture passes node --check", syntaxOk, true);

    console.log("\n[2] second run: idempotent, byte-identical");
    const r2 = runPatch(file);
    check("exit 0", r2.status, 0);
    check(
      "reports overrides already present",
      r2.out.includes("[OK] feature merger: overrides already present (idempotent)"),
      true
    );
    check("reports preference defaults already true", r2.out.includes("[OK] Preferences defaults: already true (idempotent)"), true);
    check("file byte-identical", readFileSync(file, "utf8") === patched, true);

    console.log("\n[3] the pre-2026-10-21 six-key run is stale input, not success");
    const legacyFile = join(scratch, "index-legacy.js");
    const legacyFixture = FIXTURE.replace(ANCHOR, "return{...dW(),...me" + LEGACY_OVERRIDES + "}}");
    check("legacy fixture carries the six-key run", count(legacyFixture, LEGACY_OVERRIDES), 1);
    check("...and not the seven-key run", count(legacyFixture, OVERRIDES), 0);
    writeFileSync(legacyFile, legacyFixture);
    const r3 = runPatch(legacyFile);
    check("exit 1", r3.status, 1);
    check(
      "names the stale six-key run",
      r3.out.includes("[FAIL] feature merger: pre-2026-10-21 override run found without computerUseRollout"),
      true
    );
    check("does not claim idempotency", r3.out.includes("already present (idempotent)"), false);
    check("file left untouched", readFileSync(legacyFile, "utf8") === legacyFixture, true);

    // v6.28899.2: the merger no longer ends `return{...REG(),...LOCALS}}` - the
    // return is a comma sequence that re-reads the remote-download policy first
    // (verbatim tail from .vite/build/index.chunk-CMMDcOF6.js). A decoy spread
    // whose callee is NOT the registry must be ignored by the registry check.
    console.log("\n[5] v6.28899.2 merger tail: `return await X(),...,{...Cz(),...we}}`");
    const V6_REGISTRY =
      'function Cz(){let e=Ayi();return{launch:yz,trayIcon:yz,quietPenguin:Kvi(Kyi),chillingSlothFeat:tyi(),chillingSlothLocal:iyi(),ccdPlugins:yz,computerUse:Xyi(),computerUseRollout:Zyi("computerUseRollout")}}';
    const V6_DECOY = "function W(){return{...H(),...x}}function H(){return{turns:0}}";
    const V6_TAIL =
      "async function Ybi(e){let[t]=await Promise.all([Yyi()]),we={louderPenguin:t},Te=KR();return await _mi(),KR()!==Te&&Tz()&&Ez(),{...Cz(),...we}}";
    const v6File = join(scratch, "index-v6.js");
    const v6Fixture = V6_DECOY + "\n" + V6_REGISTRY + "\n" + V6_TAIL + "\n" + PREFS + "\n";
    writeFileSync(v6File, v6Fixture);
    const r5 = runPatch(v6File);
    check("exit 0", r5.status, 0);
    check("reported via Cz()", r5.out.includes("[OK] feature merger via Cz(): 7 features overridden (1 match)"), true);
    const v6Patched = readFileSync(v6File, "utf8");
    check("override run sits last in the v6 merger", count(v6Patched, "{...Cz(),...we" + OVERRIDES + "}}"), 1);
    check("decoy spread untouched", count(v6Patched, "return{...H(),...x}}"), 1);
    let v6SyntaxOk = true;
    try {
      execFileSync("node", ["--check", v6File], { stdio: "pipe" });
    } catch {
      v6SyntaxOk = false;
    }
    check("patched v6 fixture passes node --check", v6SyntaxOk, true);
    const r5b = runPatch(v6File);
    check("second run exit 0", r5b.status, 0);
    check("second run byte-identical", readFileSync(v6File, "utf8") === v6Patched, true);
  }

  console.log("\n[4] the SPA's decision (verbatim) with the override vs upstream's Linux value");
  const { cD, lD } = new Function(SPA_DECISION)();
  const base = { complianceBlocked: false, osTooOld: false, webGateOn: false, tier: "raven", selfServe: false };
  check(
    "Team/Enterprise, web gate off, upstream not_enabled -> hidden as organization",
    JSON.stringify(lD({ ...base, rolloutStatus: "unsupported" })),
    '{"kind":"organization","rolloutOff":true}'
  );
  check(
    "Team/Enterprise, web gate off, upstream unavailable -> hidden as organization",
    JSON.stringify(lD({ ...base, rolloutStatus: "unavailable" })),
    '{"kind":"organization","rolloutOff":false}'
  );
  check("override supported, web gate off -> shown (null reason)", lD({ ...base, rolloutStatus: "supported" }), null);
  check("tool binding predicate with the override", cD(false, "supported"), true);
  check("tool binding predicate with upstream's not_enabled", cD(false, "unsupported"), false);
  check(
    "org compliance lock still wins over the override",
    JSON.stringify(lD({ ...base, complianceBlocked: true, rolloutStatus: "supported" })),
    '{"kind":"compliance","rolloutOff":false}'
  );
  check(
    "free account without self-serve: plan message, override does not lift it",
    JSON.stringify(lD({ ...base, tier: "free", selfServe: true, rolloutStatus: "unavailable" })),
    '{"kind":"plan","rolloutOff":false}'
  );

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  if (patchMissing) {
    console.log(`${pass} checks passed; patch sections SKIPPED`);
    process.exit(SKIP_EXIT);
  }
  console.log("ALL " + pass + " CHECKS PASSED");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

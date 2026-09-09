#!/usr/bin/env node
// The three Linux titlebar modes emitted by patches/linux/fix_native_frame.nim.
//
// WHY THIS EXISTS
// ---------------
// One patched asar serves all three modes, because the patch does not bake a
// decision into the bundle - it emits runtime expressions and lets Electron
// resolve them per launch:
//
//   mode        | condition
//   ------------+--------------------------------------------------------------
//   native      | linux && NATIVE_ON
//   bare        | linux && !NATIVE_ON && BARE_ON
//   integrated  | linux && !NATIVE_ON && !BARE_ON                    (default)
//
// Precedence (native wins) lives only in this patch - which is why bare tests
// !NATIVE_ON and not merely BARE_ON. The injected readers stay dumb and each
// answers only "is my mode requested", so BARE_ON is deliberately still true
// when native is also on.
//
// A green patch run only proves the regexes matched. What it cannot prove is
// that the emitted ternaries RESOLVE to the right BrowserWindow options - and
// the option values are the whole feature. So this harness runs the real
// compiled patch binary over a fixture built from the live upstream shapes
// (v1.49585.0), then evaluates the patched main-window options object once per
// mode-request combination with process/electron/readers shimmed, and asserts
// the resulting values.
//
// THE INVARIANT THIS EXISTS TO PROTECT: bare mode must set BOTH
// titleBarOverlay:false AND hasShadow:false. Chromium (Electron 44.3.0) decides
// whether to paint its own window border with
//
//   wants_frame_ = !IsTranslucent() && (HasShadow() || IsWindowControlsOverlayEnabled())
//
// so a frameless window keeps a 4px painted border on xfwm4 / i3 / Awesome
// unless WCO is off AND the shadow is off. Turning WCO off on its own is not
// enough - measured 2026-09-09. A future refactor that drops `hasShadow:false`
// as "redundant" would silently restore that border, which is exactly the bug
// bare mode was added to remove. See section [3].
//
// TWO SURFACES. Each mode is requested either by a persisted config key (the
// Settings toggles) or by the launcher's env var, and the patch resolves both at
// window-construction time through a reader the community patch injects:
//
//   (globalThis.__cdbNativeTb ? !!globalThis.__cdbNativeTb() : process.env.CLAUDE_NATIVE_TITLEBAR==="1")
//
// The reader ORs the config key with the env var, so when it is present it is
// the single authority and the `: process.env...` arm is not consulted. Sections
// [1]-[6] run with the readers ABSENT - the degradation path. Sections [9]-[10]
// run with them present, which is the path users actually hit. Section [0b]
// pins the guard that makes the absent case degrade instead of crash, and runs
// first so a lost guard is reported by name rather than crashing [1].
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_BIN = join(ROOT, "patches", "linux", "fix_native_frame");
const SKIP_EXIT = 3;

// ---------------------------------------------------------------- reporting
let pass = 0;
const failures = [];

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${fmt(actual)}`);
    pass++;
    return;
  }
  console.log(`  FAIL ${label} -> got ${fmt(actual)}, expected ${fmt(expected)}`);
  failures.push(label);
}

function fmt(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function section(title) {
  console.log("\n" + title);
}

// ---------------------------------------------------------------- fixture
// A minimal script carrying the two sites fix_native_frame targets, copied from
// the live bundle so the minified shapes are upstream's own rather than
// invented. Identifiers are upstream's (v1.49585.0, index.chunk-EgDgo76G.js);
// the patch captures them by wildcard, so the exact spellings do not matter -
// what matters is the SHAPE around them.
//
//   1. the titleBarOverlay style helper (patch 2's target), whose declarator
//      chain ends `;return <electron>.nativeTheme.shouldUseDarkColors?{color:`
//   2. the main-window options object (patch 1's target), reached here through
//      a function that RETURNS the options instead of constructing a window, so
//      the emitted expressions can be evaluated in place with real scoping.
//
// Upstream's own `icon:` key sits AFTER titleBarOverlay in the real object and
// is kept here for faithfulness - see the closing NOTE.
function fixture(overlaySlot) {
  return `"use strict";
function p5t(e){let t=e==="main"&&Q8t,n=e==="main"&&e5t,r=t?d5t:e==="main"?B8t:V8t,i=n?u5t(yP()):yP();return o.nativeTheme.shouldUseDarkColors?{color:t?"#f9f8f4":i,symbolColor:t?"#000":"#c2c0b6",height:r}:{color:t?"#141412":i,symbolColor:t?"#fff":"#3d3d3a",height:r}}
function w_e(e){return e}
function __cdbFixtureOptions(){let r=!0,u=!1,i={earlyWindowShow:!1},a={x:0,y:0,width:1200,height:800},n={default:{join:(...s)=>s.join("/")}};return w_e({x:a.x,y:a.y,width:a.width,height:a.height,minWidth:600,minHeight:400,titleBarStyle:"hidden",titleBarOverlay:${overlaySlot},trafficLightPosition:U9t(),show:r&&!u,backgroundColor:yP(),opacity:+!!i.earlyWindowShow,icon:n.default.join(p3r(),"icon.png"),webPreferences:{preload:"mainWindow.js"}})}
`;
}

// The sentinel stubs the patched expressions run against. Distinguishable
// values so a wrong branch is visible rather than coincidentally equal.
const WINDOW_BG = "#WINDOW-BG";
const BLENDED = (x) => "#BLENDED(" + x + ")";
const UPSTREAM_OVERLAY_SENTINEL = { __upstreamOverlayValue: true };

// Each mode is requested over TWO surfaces and the patch reads both:
//
//   (globalThis.__cdbNativeTb ? !!globalThis.__cdbNativeTb() : process.env.CLAUDE_NATIVE_TITLEBAR==="1")
//   (globalThis.__cdbNoWinCtl ? !!globalThis.__cdbNoWinCtl() : process.env.CLAUDE_NO_WINDOW_CONTROLS==="1")
//
// `nativeTb` / `noWinCtl` install those readers (a function, or any value - the
// patch coerces with !!). Passing undefined leaves the global genuinely ABSENT,
// which is the fallback path sections [1]-[6] exercise.
function evalFixture(src, { platform, env, dark = true, nativeTb, noWinCtl } = {}) {
  const sandbox = {
    console,
    process: { platform, env },
    // patch 2's helper environment (upstream identifiers)
    Q8t: false,        // not the special "main" look -> the ternary takes `i`
    e5t: true,         // the alpha-blend path IS active, i.e. the grey-strip value
    d5t: 40,
    B8t: 36,
    V8t: 30,
    u5t: BLENDED,
    yP: () => WINDOW_BG,
    o: { nativeTheme: { shouldUseDarkColors: dark } },
    // main-window options environment
    U9t: () => ({ x: 0, y: 0 }),
    p3r: () => "/opt/claude/resources",
    eKi: UPSTREAM_OVERLAY_SENTINEL,
  };
  // Assigned conditionally so "no reader" means the property does not exist,
  // not that it exists holding undefined - the patch's guard is a truthiness
  // test on the property, so the difference is the whole point.
  if (nativeTb !== undefined) sandbox.__cdbNativeTb = nativeTb;
  if (noWinCtl !== undefined) sandbox.__cdbNoWinCtl = noWinCtl;
  vm.runInNewContext(
    src + "\n;globalThis.__OPTS=__cdbFixtureOptions;globalThis.__OVERLAY=p5t;",
    vm.createContext(sandbox)
  );
  return { opts: sandbox.__OPTS(), overlayMain: sandbox.__OVERLAY("main") };
}

// Readers as the community patch injects them: memoized zero-arg functions.
// Their internals (config file parsing, memoization) are the community patch's
// own coverage - here they are stubs, and only what THIS patch does with their
// answer is asserted.
const READER = (v) => () => v;

// ---------------------------------------------------------------- run the patch
function runPatch(dir, name, src) {
  const file = join(dir, name);
  writeFileSync(file, src);
  const out = execFileSync(PATCH_BIN, [file], { encoding: "utf8" });
  return { file, out, patched: readFileSync(file, "utf8") };
}

// Same, but for the runs that MUST fail. Returns the exit status and the
// combined output instead of throwing.
function runPatchExpectingFailure(dir, name, src) {
  const file = join(dir, name);
  writeFileSync(file, src);
  try {
    const out = execFileSync(PATCH_BIN, [file], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, out };
  } catch (e) {
    return {
      status: typeof e.status === "number" ? e.status : -1,
      out: String(e.stdout || "") + String(e.stderr || ""),
    };
  }
}

// The injection the TWO-mode patch used to emit, reconstructed. `frame` and
// `titleBarStyle` look right, so nothing downstream would notice - the only
// thing missing is the bare-mode arm. It carries no CLAUDE_NO_WINDOW_CONTROLS,
// which is precisely why the marker moved to that name: see section [8].
const NATIVE_GATE =
  'process.platform==="linux"&&process.env.CLAUDE_NATIVE_TITLEBAR==="1"';
const FRAMELESS_GATE =
  'process.platform==="linux"&&process.env.CLAUDE_NATIVE_TITLEBAR!=="1"';
function oldTwoModeInjection() {
  return fixture("!0").replace(
    'titleBarStyle:"hidden",titleBarOverlay:!0',
    `titleBarStyle:${NATIVE_GATE}?"default":"hidden",titleBarOverlay:(${FRAMELESS_GATE})?` +
      '{color:yP(),symbolColor:o.nativeTheme.shouldUseDarkColors?"#fff":"#000",height:36}' +
      `:!0,frame:!(${FRAMELESS_GATE}),autoHideMenuBar:process.platform==="linux",` +
      'icon:process.platform==="linux"?"/usr/share/icons/hicolor/256x256/apps/claude-desktop.png":void 0'
  );
}

try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  console.error(
    "SKIP: patches/linux/fix_native_frame is not compiled " +
      "(run: make -C patches linux/fix_native_frame)"
  );
  process.exit(SKIP_EXIT);
}

const scratch = mkdtempSync(join(tmpdir(), "cdb-titlebar-modes-"));

try {
  // ---------------------------------------------------------------- [0] patch
  section("[0] the compiled patch applies to the upstream shapes");
  const boolSlot = runPatch(scratch, "index-bool.js", fixture("!0"));
  check(
    "the binary reports no failure",
    /\[OK\] main window options: 1/.test(boolSlot.out) &&
      /\[OK\] overlay background/.test(boolSlot.out) &&
      !/\[FAIL\]/.test(boolSlot.out),
    true
  );
  execFileSync("node", ["--check", boolSlot.file]);
  check("the patched bundle passes node --check", true, true);
  check(
    "the emitted code gates on CLAUDE_NATIVE_TITLEBAR",
    boolSlot.patched.includes("CLAUDE_NATIVE_TITLEBAR"),
    true
  );
  check(
    "the emitted code gates on CLAUDE_NO_WINDOW_CONTROLS",
    boolSlot.patched.includes("CLAUDE_NO_WINDOW_CONTROLS"),
    true
  );
  check(
    "the options object gains a hasShadow key",
    /[,{]hasShadow:/.test(boolSlot.patched),
    true
  );
  check(
    "the options object gains a frame key",
    /[,{]frame:/.test(boolSlot.patched),
    true
  );
  check(
    "autoHideMenuBar is Linux-conditional",
    boolSlot.patched.includes('autoHideMenuBar:process.platform==="linux"'),
    true
  );
  // The patch deliberately injects NO icon. Upstream passes its own `icon:`
  // LATER in the same options object and the last key wins, so an injected one
  // was dead code from the day it was written - and upstream's resources/icon.png
  // ships in the tree we repackage, so there was never anything to fix. Section
  // [12] is the guard that makes this class of shadowing loud instead of silent.
  check(
    "the patch injects no icon: key of its own",
    countOf(boolSlot.patched, "icon:"),
    countOf(fixture("!0"), "icon:")
  );
  check(
    "and no hicolor path is written into the bundle",
    /\/usr\/share\/icons\/hicolor/.test(boolSlot.patched),
    false
  );
  // Idempotency: the patch keys off CLAUDE_NATIVE_TITLEBAR being present, so a
  // second run must be a no-op rather than a double-splice.
  {
    const again = join(scratch, "index-again.js");
    writeFileSync(again, boolSlot.patched);
    const out = execFileSync(PATCH_BIN, [again], { encoding: "utf8" });
    check("a second run reports already patched", /already patched/.test(out), true);
    check(
      "and leaves the bundle byte-identical",
      readFileSync(again, "utf8") === boolSlot.patched,
      true
    );
  }

  // ------------------------------------ [0b] the defensive guard is required
  // RUNS BEFORE THE MODE MATRIX ON PURPOSE. Sections [1]-[6] evaluate the
  // options with the readers absent, so a lost guard makes THEM throw and the
  // run dies as a generic HARNESS ERROR that names nothing. Checking it first
  // means a guard regression is reported by name, as the thing it is.
  section("[0b] the reader guard is load-bearing: absent readers must not throw");
  {
    // DO NOT SIMPLIFY the emitted `globalThis.__cdbX ? !!globalThis.__cdbX() : env`
    // into a bare `__cdbX()`. The readers come from a DIFFERENT patch
    // (patches/community/add_feature_window_controls.nim). If that injection is
    // ever missing, reordered, or fails, a bare call throws a TypeError while
    // the main-window options object is being built - which means NO WINDOW AT
    // ALL, not a broken titlebar. The guard degrades to flag-only control
    // instead. This is the only assertion standing between that refactor and a
    // ship-blocking crash, so it is named rather than implied.
    check(
      "the emitted native gate keeps its defensive guard",
      boolSlot.patched.includes(
        'globalThis.__cdbNativeTb?!!globalThis.__cdbNativeTb():process.env.CLAUDE_NATIVE_TITLEBAR==="1"'
      ),
      true
    );
    check(
      "the emitted bare gate keeps its defensive guard",
      boolSlot.patched.includes(
        'globalThis.__cdbNoWinCtl?!!globalThis.__cdbNoWinCtl():process.env.CLAUDE_NO_WINDOW_CONTROLS==="1"'
      ),
      true
    );
    let threw = null;
    try {
      evalFixture(boolSlot.patched, { platform: "linux", env: {} });
    } catch (e) {
      threw = e;
    }
    check(
      "GUARD building the options with BOTH readers absent does not throw " +
        "(a bare call would mean no window at all)",
      threw === null,
      true
    );
    // Half-installed is the likelier failure than none-installed: the two
    // readers are injected together, but a partial apply must degrade too.
    for (const [label, extra] of [
      ["only __cdbNativeTb present", { nativeTb: READER(false) }],
      ["only __cdbNoWinCtl present", { noWinCtl: READER(false) }],
    ]) {
      let t = null;
      try {
        evalFixture(boolSlot.patched, { platform: "linux", env: {}, ...extra });
      } catch (e) {
        t = e;
      }
      check("GUARD " + label + " does not throw either", t === null, true);
    }
  }


  // ---------------------------------------------------------------- [1] integrated
  section(
    "[1] FALLBACK PATH (readers absent): integrated mode - the Linux default"
  );
  {
    const { opts, overlayMain } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: {},
    });
    check("titleBarStyle", opts.titleBarStyle, "hidden");
    check("frame (Electron draws no frame; the web content owns the bar)", opts.frame, false);
    check("hasShadow (the compositor shadow stays)", opts.hasShadow, true);
    check(
      "titleBarOverlay is a style object",
      !!opts.titleBarOverlay && typeof opts.titleBarOverlay === "object",
      true
    );
    check(
      "titleBarOverlay carries a height (WCO is really configured)",
      typeof (opts.titleBarOverlay || {}).height === "number",
      true
    );
    check(
      "titleBarOverlay.color is the plain window background, not the blended value",
      (opts.titleBarOverlay || {}).color,
      WINDOW_BG
    );
    check("autoHideMenuBar", opts.autoHideMenuBar, true);
    // Patch 2: the theme-update helper must agree with the options object, or
    // the bar recolors to the grey alpha-blended strip on the first theme push.
    check(
      "the theme-update helper returns the plain background too (patch 2)",
      overlayMain.color,
      WINDOW_BG
    );
  }
  {
    // Only the literal "1" opts in; anything else is the default.
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: { CLAUDE_NO_WINDOW_CONTROLS: "0", CLAUDE_NATIVE_TITLEBAR: "0" },
    });
    check('env vars set to "0" stay integrated: frame', opts.frame, false);
    check(
      'env vars set to "0" stay integrated: titleBarOverlay is an object',
      !!opts.titleBarOverlay && typeof opts.titleBarOverlay === "object",
      true
    );
  }

  // ---------------------------------------------------------------- [2] bare
  section(
    "[2] FALLBACK PATH: bare mode via CLAUDE_NO_WINDOW_CONTROLS=1"
  );
  {
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: { CLAUDE_NO_WINDOW_CONTROLS: "1" },
    });
    check("titleBarStyle", opts.titleBarStyle, "hidden");
    check("frame", opts.frame, false);
    check("titleBarOverlay is off (no WCO buttons)", opts.titleBarOverlay, false);
    check("hasShadow", opts.hasShadow, false);
    check("autoHideMenuBar", opts.autoHideMenuBar, true);
  }

  // ---------------------------------------------------------------- [3] invariant
  section("[3] THE INVARIANT: bare mode needs hasShadow:false AND WCO off");
  {
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: { CLAUDE_NO_WINDOW_CONTROLS: "1" },
    });
    // Chromium: wants_frame_ = !IsTranslucent() && (HasShadow() || IsWindowControlsOverlayEnabled())
    //
    // The window is not translucent (transparent:true would kill the WCO
    // buttons in integrated mode, so we never set it). That leaves the OR: the
    // 4px painted border clears only when BOTH disjuncts are false. Dropping
    // either half of this assertion - in particular `hasShadow:false`, which
    // reads redundant next to a frameless window - silently brings the border
    // back on xfwm4 / i3 / Awesome, with no build or patch failure to show it.
    check(
      "INVARIANT bare mode disables the shadow (hasShadow:false)",
      opts.hasShadow === false,
      true
    );
    check(
      "INVARIANT bare mode disables window controls overlay (titleBarOverlay:false)",
      opts.titleBarOverlay === false,
      true
    );
    check(
      "INVARIANT both Chromium disjuncts are false, so wants_frame_ is false " +
        "(no 4px painted border)",
      opts.hasShadow === false && opts.titleBarOverlay === false,
      true
    );
    check(
      "INVARIANT the window is never translucent (transparent would kill WCO)",
      opts.transparent === undefined || opts.transparent === false,
      true
    );
  }

  // ---------------------------------------------------------------- [4] native
  section(
    "[4] FALLBACK PATH: native mode via CLAUDE_NATIVE_TITLEBAR=1 - the GTK frame is back"
  );
  {
    const { opts, overlayMain } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: { CLAUDE_NATIVE_TITLEBAR: "1" },
    });
    check("titleBarStyle", opts.titleBarStyle, "default");
    check("frame (the window manager draws the titlebar)", opts.frame, true);
    check(
      "titleBarOverlay falls back to upstream's value",
      opts.titleBarOverlay,
      true
    );
    check("hasShadow (the shadow is untouched outside bare mode)", opts.hasShadow, true);
    check("autoHideMenuBar is still on (Alt reveals the menu bar)", opts.autoHideMenuBar, true);
    check(
      "the theme-update helper keeps upstream's blended value (patch 2 is integrated-only)",
      overlayMain.color,
      BLENDED(WINDOW_BG)
    );
  }

  section(
    "[5] FALLBACK PATH precedence: CLAUDE_NATIVE_TITLEBAR wins over " +
      "CLAUDE_NO_WINDOW_CONTROLS"
  );
  {
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: { CLAUDE_NATIVE_TITLEBAR: "1", CLAUDE_NO_WINDOW_CONTROLS: "1" },
    });
    check("both vars set to 1 resolves to native: frame", opts.frame, true);
    check("both vars set to 1 resolves to native: titleBarStyle", opts.titleBarStyle, "default");
    check("bare mode does not leak its shadow suppression into native", opts.hasShadow, true);
  }

  // ---------------------------------------------------------------- [6] non-Linux
  section("[6] non-Linux is untouched - every mode is Linux-gated");
  {
    const { opts, overlayMain } = evalFixture(boolSlot.patched, {
      platform: "win32",
      env: {},
    });
    check("frame", opts.frame, true);
    // Upstream-preserving: the win32 build has always opened with the hidden
    // titlebar plus its own WCO, so "hidden" here is correct, not a leak.
    check("titleBarStyle stays upstream's hidden", opts.titleBarStyle, "hidden");
    check("upstream's titleBarOverlay value is preserved (!0)", opts.titleBarOverlay, true);
    check("hasShadow", opts.hasShadow, true);
    check("autoHideMenuBar is not forced", opts.autoHideMenuBar, false);
    // Nothing of ours touches icon, so the fixture's own value must survive
    // verbatim - on every platform, Linux included.
    check("upstream's own icon survives untouched", opts.icon, "/opt/claude/resources/icon.png");
    check(
      "the theme-update helper keeps upstream's blended value",
      overlayMain.color,
      BLENDED(WINDOW_BG)
    );
  }
  {
    // Even with both env vars set, a non-Linux platform must not shift mode -
    // the vars are ours and mean nothing on win32/darwin.
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "darwin",
      env: { CLAUDE_NATIVE_TITLEBAR: "1", CLAUDE_NO_WINDOW_CONTROLS: "1" },
    });
    check("darwin with both vars set: frame", opts.frame, true);
    check("darwin with both vars set: titleBarStyle", opts.titleBarStyle, "hidden");
    check("darwin with both vars set: titleBarOverlay", opts.titleBarOverlay, true);
    check("darwin with both vars set: hasShadow", opts.hasShadow, true);
  }

  // ---------------------------------------------------------------- [7] value slot
  section("[7] the titleBarOverlay value slot also accepts an identifier");
  {
    // Upstream constant-folded this to `!0` at v1.26832.0, but carried a
    // win32-only variable before that and may again. The patch's value slot
    // matches `!\d|<identifier chain>`; this pins that the non-Linux fallback
    // preserves the IDENTIFIER's value, not a re-derived boolean.
    const idSlot = runPatch(scratch, "index-ident.js", fixture("eKi"));
    check(
      "the binary applies to an identifier value slot",
      /\[OK\] main window options: 1/.test(idSlot.out) && !/\[FAIL\]/.test(idSlot.out),
      true
    );
    execFileSync("node", ["--check", idSlot.file]);
    check("and the result passes node --check", true, true);
    const win = evalFixture(idSlot.patched, { platform: "win32", env: {} });
    check(
      "non-Linux keeps upstream's identifier value verbatim",
      win.opts.titleBarOverlay === UPSTREAM_OVERLAY_SENTINEL,
      true
    );
    const nat = evalFixture(idSlot.patched, {
      platform: "linux",
      env: { CLAUDE_NATIVE_TITLEBAR: "1" },
    });
    check(
      "native mode keeps upstream's identifier value verbatim",
      nat.opts.titleBarOverlay === UPSTREAM_OVERLAY_SENTINEL,
      true
    );
    const bare = evalFixture(idSlot.patched, {
      platform: "linux",
      env: { CLAUDE_NO_WINDOW_CONTROLS: "1" },
    });
    check(
      "bare mode overrides it with an explicit false, it does not fall back",
      bare.opts.titleBarOverlay,
      false
    );
  }

  // ------------------------------------------------- [8] idempotency marker
  section("[8] a bundle carrying only the OLD two-mode injection fails loudly");
  {
    // The marker is __CDB_NATIVE_FRAME__, which this patch emits itself, so it
    // asserts its NEWEST end-state rather than merely that the pre-patch shape
    // is gone (AGENTS.md rule 6). Keying off anything the two-mode injection
    // also carried would report a false "[INFO] already patched" over a bundle
    // that has integrated and native but no bare mode - the build would go
    // green and bare mode would silently not exist. The old injection has no
    // marker and no plain `titleBarStyle:"hidden",titleBarOverlay:...` left to
    // match, so the run must abort on the strict count instead.
    const old = oldTwoModeInjection();
    check(
      "precondition: the reconstructed old injection carries the native gate " +
        "but not the bare one",
      old.includes("CLAUDE_NATIVE_TITLEBAR") &&
        !old.includes("CLAUDE_NO_WINDOW_CONTROLS"),
      true
    );
    const r = runPatchExpectingFailure(scratch, "index-old.js", old);
    check("the patch exits non-zero", r.status !== 0, true);
    check(
      "and names the strict count it could not meet (main window pattern: 0/1)",
      /main window pattern: 0\/1/.test(r.out),
      true
    );
    check(
      "it does NOT report a false 'already patched'",
      /already patched/.test(r.out),
      false
    );
  }

  // ------------------------------------------------- [9] config-driven modes
  section("[9] CONFIG PATH (readers present): the modes users actually reach");
  {
    // Both toggles off. The readers answer, the env arm is not reached.
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: {},
      nativeTb: READER(false),
      noWinCtl: READER(false),
    });
    check("both readers false -> integrated: titleBarStyle", opts.titleBarStyle, "hidden");
    check("both readers false -> integrated: frame", opts.frame, false);
    check("both readers false -> integrated: hasShadow", opts.hasShadow, true);
    check(
      "both readers false -> integrated: titleBarOverlay is a style object",
      !!opts.titleBarOverlay && typeof opts.titleBarOverlay === "object",
      true
    );
  }
  {
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: {},
      nativeTb: READER(false),
      noWinCtl: READER(true),
    });
    check("__cdbNoWinCtl true -> bare: titleBarStyle", opts.titleBarStyle, "hidden");
    check("__cdbNoWinCtl true -> bare: frame", opts.frame, false);
    check("__cdbNoWinCtl true -> bare: hasShadow", opts.hasShadow, false);
    check("__cdbNoWinCtl true -> bare: titleBarOverlay", opts.titleBarOverlay, false);
    check(
      "__cdbNoWinCtl true -> bare: the Chromium border invariant holds on the " +
        "config path too",
      opts.hasShadow === false && opts.titleBarOverlay === false,
      true
    );
  }
  {
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: {},
      nativeTb: READER(true),
      noWinCtl: READER(false),
    });
    check("__cdbNativeTb true -> native: titleBarStyle", opts.titleBarStyle, "default");
    check("__cdbNativeTb true -> native: frame", opts.frame, true);
    check("__cdbNativeTb true -> native: hasShadow", opts.hasShadow, true);
    check("__cdbNativeTb true -> native: titleBarOverlay", opts.titleBarOverlay, true);
  }
  {
    // The readers are dumb by design: __cdbNoWinCtl() still says true while
    // native is on. Precedence is this patch's job, so BOTH true must resolve
    // to native - if it resolved to bare, a user toggling both would get a
    // frameless window with no controls and no titlebar, i.e. no way to move
    // or close it.
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: {},
      nativeTb: READER(true),
      noWinCtl: READER(true),
    });
    check("both readers true -> native wins: titleBarStyle", opts.titleBarStyle, "default");
    check("both readers true -> native wins: frame", opts.frame, true);
    check("both readers true -> native wins: hasShadow is not suppressed", opts.hasShadow, true);
    check("both readers true -> native wins: titleBarOverlay", opts.titleBarOverlay, true);
  }
  {
    // !! coercion: the readers are only contracted to answer truthily, so a
    // non-boolean must still land on a real boolean option value.
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: {},
      nativeTb: READER(0),
      noWinCtl: READER("yes"),
    });
    check("a truthy non-boolean reader answer is coerced: hasShadow", opts.hasShadow, false);
    check("a truthy non-boolean reader answer is coerced: titleBarOverlay", opts.titleBarOverlay, false);
    check("a falsy non-boolean reader answer is coerced: frame", opts.frame, false);
  }

  // -------------------------------------------- [10] cross-surface precedence
  section("[10] precedence holds ACROSS surfaces, not just within one");
  {
    // The config toggle asks for native while the launcher flag asks for bare.
    // Native must win regardless of which surface each request arrived on.
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: { CLAUDE_NO_WINDOW_CONTROLS: "1" },
      nativeTb: READER(true),
    });
    check("config native + env bare -> native: titleBarStyle", opts.titleBarStyle, "default");
    check("config native + env bare -> native: frame", opts.frame, true);
    check("config native + env bare -> native: hasShadow is not suppressed", opts.hasShadow, true);
    check("config native + env bare -> native: titleBarOverlay", opts.titleBarOverlay, true);
  }
  {
    // The mirror case: the flag asks for native while the config reader for
    // bare is present and false. With __cdbNativeTb ABSENT the env arm is what
    // answers, so native still wins over the present-and-true bare reader.
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: { CLAUDE_NATIVE_TITLEBAR: "1" },
      noWinCtl: READER(true),
    });
    check("env native + config bare -> native: titleBarStyle", opts.titleBarStyle, "default");
    check("env native + config bare -> native: frame", opts.frame, true);
    check("env native + config bare -> native: hasShadow is not suppressed", opts.hasShadow, true);
  }
  {
    // When a reader IS present it is the single authority and the `: process.env`
    // arm is not consulted - because the reader already ORs the env var inside
    // itself. Pinned so nobody later "fixes" this by ORing the env var again
    // here: that would make the toggle unable to turn a mode back OFF for a
    // user whose launcher still exports the flag.
    const { opts } = evalFixture(boolSlot.patched, {
      platform: "linux",
      env: { CLAUDE_NATIVE_TITLEBAR: "1", CLAUDE_NO_WINDOW_CONTROLS: "1" },
      nativeTb: READER(false),
      noWinCtl: READER(false),
    });
    check(
      "a present reader answering false wins over its own env var: frame",
      opts.frame,
      false
    );
    check(
      "a present reader answering false wins over its own env var: titleBarStyle",
      opts.titleBarStyle,
      "hidden"
    );
    check(
      "a present reader answering false wins over its own env var: hasShadow",
      opts.hasShadow,
      true
    );
  }

  // --------------------------------- [11] the marker must be OURS, not a peer's
  section("[11] the idempotency marker must be a token THIS patch emits");
  {
    // THE BUG THIS EXISTS TO PREVENT - it shipped, and a green build hid it.
    //
    // The marker was briefly `__cdbNoWinCtl`. But that global is DEFINED by
    // patches/community/add_feature_window_controls.nim, and the orchestrator
    // applies patches in basename order, where add_feature_* sorts BEFORE
    // fix_*. So on a real build the community patch injected the token first,
    // fix_native_frame found it, reported "[INFO] already patched", exited 0,
    // and left the main window entirely unpatched: upstream's own titlebar, no
    // frameless window, no overlay - with a green build and no warning.
    //
    // THE RULE: the idempotency check may only key off a token the patch emits
    // ITSELF. Keying off any token another patch can emit turns "already
    // patched" into "somebody else got here first", which is silent breakage
    // rather than a loud failure - and the patch strictness rules exist
    // precisely to make that impossible. `__cdbNativeTb` / `__cdbNoWinCtl` are
    // tokens this patch CONSUMES, never emits, so neither may ever be a marker.
    const MARKER = "__CDB_NATIVE_FRAME__";
    const CONSUMED_GLOBALS = ["__cdbNoWinCtl", "__cdbNativeTb"];

    // Generalised: for EVERY global this patch merely consumes, a bundle where
    // a peer patch has already injected it must still be patched in full.
    for (const token of CONSUMED_GLOBALS) {
      const pre = `globalThis.${token}=function(){return!1};\n`;
      const src = pre + fixture("!0");
      check(
        `precondition: the bundle already carries ${token} but no marker`,
        src.includes(token) && !src.includes(MARKER),
        true
      );
      const r = runPatchExpectingFailure(scratch, `index-collide-${token}.js`, src);
      check(`a peer patch's ${token} does NOT trigger "already patched"`,
        /already patched/.test(r.out), false);
      check(`and the patch still applies over it (exit 0)`, r.status, 0);
      const patched = readFileSync(join(scratch, `index-collide-${token}.js`), "utf8");
      check(`${token} collision: the marker is emitted`, patched.includes(MARKER), true);
      check(`${token} collision: hasShadow is emitted`, patched.includes("hasShadow:!("), true);
      execFileSync("node", ["--check", join(scratch, `index-collide-${token}.js`)]);
      // The options must really resolve, not merely contain the right strings.
      // The prepended reader answers false, so this is integrated mode.
      const { opts } = evalFixture(patched, { platform: "linux", env: {} });
      check(`${token} collision: frame resolves`, opts.frame, false);
      check(`${token} collision: hasShadow resolves`, opts.hasShadow, true);
      check(
        `${token} collision: titleBarOverlay resolves to a style object`,
        !!opts.titleBarOverlay && typeof opts.titleBarOverlay === "object",
        true
      );
    }
    {
      // The same collision, with the peer's reader answering TRUE - the mode
      // that would have been silently lost on the shipped build.
      const src = "globalThis.__cdbNoWinCtl=function(){return!0};\n" + fixture("!0");
      const r = runPatchExpectingFailure(scratch, "index-collide-bare.js", src);
      check("collision + bare requested: the patch applies", r.status, 0);
      const patched = readFileSync(join(scratch, "index-collide-bare.js"), "utf8");
      const { opts } = evalFixture(patched, { platform: "linux", env: {} });
      check("collision + bare requested: hasShadow resolves to false", opts.hasShadow, false);
      check("collision + bare requested: titleBarOverlay resolves to false", opts.titleBarOverlay, false);
      check("collision + bare requested: frame resolves to false", opts.frame, false);
    }

    // The invariant itself: whatever token the idempotency check keys off must
    // appear in the patch's OWN output on a clean bundle. If it does not, the
    // check is keying off something this patch does not produce - i.e. a peer's
    // token, or nothing at all - which is the bug above.
    check(
      "INVARIANT the marker appears in the patch's own output on a clean bundle",
      boolSlot.patched.includes(MARKER),
      true
    );
    check(
      "INVARIANT the marker is not a global this patch merely consumes",
      CONSUMED_GLOBALS.some((t) => MARKER.includes(t)),
      false
    );
    check(
      "INVARIANT a re-run over that output is correctly detected as patched",
      /already patched/.test(
        runPatchExpectingFailure(scratch, "index-marker-rerun.js", boolSlot.patched).out
      ),
      true
    );
    check(
      "the marker appears exactly once after a single application " +
        "(a double injection would be visible here)",
      boolSlot.patched.split(MARKER).length - 1,
      1
    );
  }

  // --------------------------- [12] the duplicate-key shadowing guard
  section("[12] the shadowing guard: an upstream duplicate must fail the build");
  {
    // WHY THIS GUARD EXISTS. Upstream's options object continues past our
    // splice point, and in a JS object literal the LAST key wins. `icon` is the
    // proof this hazard is real rather than theoretical: upstream passes its
    // own after us, so the icon the patch used to inject was discarded from the
    // day it was written, silently, for years of releases. If a future release
    // starts passing `frame` or `hasShadow` after us the same way, the window
    // opens in the wrong mode with a green build and no runtime error - the
    // worst failure shape available. The guard delimits the object (our marker
    // to the first webPreferences: within 3000 chars) and requires each of our
    // five keys to appear exactly once.
    check(
      "a clean apply reports the guard held",
      /\[OK\] no upstream duplicate shadows our injected options/.test(boolSlot.out),
      true
    );

    // The class, not one instance: a later duplicate of ANY guarded key must
    // fail loud and name the key.
    for (const key of ["hasShadow", "frame", "titleBarStyle"]) {
      const dup = key === "titleBarStyle" ? 'titleBarStyle:"default",' : key + ":!0,";
      // Inserted before webPreferences:, i.e. AFTER our splice point and still
      // inside the object - exactly where an upstream addition would land.
      const src = fixture("!0").replace("webPreferences:", dup + "webPreferences:");
      check(
        `precondition: the ${key} duplicate sits after our splice point`,
        src.indexOf(dup) > src.indexOf("titleBarOverlay:"),
        true
      );
      const r = runPatchExpectingFailure(scratch, `index-dup-${key}.js`, src);
      check(`a later duplicate ${key}: makes the patch exit non-zero`, r.status !== 0, true);
      check(
        `and names the offending key with its count`,
        new RegExp("option " + key + ": appears 2x").test(r.out),
        true
      );
      check(
        `${key} duplicate: it does not report success`,
        /\[OK\] no upstream duplicate/.test(r.out),
        false
      );
    }

    // The guard's own blind spot: if it cannot delimit the object it must say
    // so, not silently scan nothing and pass. Without this, an upstream
    // refactor that moves webPreferences out of range would disable the guard
    // while leaving the build green - the same silent-failure shape the guard
    // exists to remove.
    {
      const src = fixture("!0").replace(',webPreferences:{preload:"mainWindow.js"}', "");
      check(
        "precondition: the fixture now has no webPreferences: to delimit on",
        src.includes("webPreferences:"),
        false
      );
      const r = runPatchExpectingFailure(scratch, "index-nowp.js", src);
      check("an undelimitable options object exits non-zero", r.status !== 0, true);
      check(
        "and says the guard cannot delimit the object",
        /shadowing guard cannot delimit the object/.test(r.out),
        true
      );
      check(
        "it does not pass vacuously",
        /\[OK\] no upstream duplicate/.test(r.out),
        false
      );
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} CHECK(S) FAILED:`);
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  console.log("ALL " + pass + " CHECKS PASSED");
} catch (e) {
  console.error("\nHARNESS ERROR: " + (e && e.stack ? e.stack : e));
  process.exit(1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

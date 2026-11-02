#!/usr/bin/env node
// Computer Use tool descriptions on an X11 session: what the model is told
// about screenshots and grants must match what the bridge does.
//
// WHY THIS EXISTS
// ---------------
// The `computer-use` session MCP server and the Cowork chat's remote-devices
// computer_* tools build their tool definitions from one builder, fed by the
// STATIC preset `PLATFORM_CAPABILITIES = isWayland() ? LINUX_WAYLAND : LINUX`
// (v3.1623.0: `Hvr=rA()?vV:Vvr`). The live executor's capabilities never reach
// the builder. LINUX is `{screenshotFiltering:"native"}`, so on X11 the model
// read upstream's "The image is composed from the granted apps' windows only
// ... everything else ... is blank" and refused to take a screenshot on its
// own, while our X11 bridge captures the whole display. Sub-patch 13f (the
// "none" arm) never engaged on X11, and sub-patch 13b's darwin literal is keyed
// by `[t.platform]`, so on Linux the `linux:` key is what the model sees.
//
// fix_computer_use_linux.nim now:
//   2b        routes the X11 arm of the preset to `{screenshotFiltering:"none",
//             platform:"linux"}` (no hitTest key: the input gate keeps the
//             "frontmost" arm that 13a blanks);
//   13b.linux wraps the `linux:` key's Wayland sentence so it is chosen only on
//             a Wayland session and X11 gets a whole-display sentence.
// Grant semantics are untouched: the request_access / resolve_access consent
// flow (claude.ai's consent card) stays upstream's.
//
// Section [1] evaluates the VERBATIM v3.1623.0 excerpts (pristine) and pins the
// defect: on X11 the builder resolved to the "granted apps' windows only" text.
// Sections [2]-[6] stage the real extract under tmp/app.asar.contents/ exactly as
// the orchestrator does, run the compiled patch binary on it (twice), splice the
// patched preset, selector and request_access prefix out of the result and
// evaluate them with process.platform / XDG_SESSION_TYPE controlled. The full
// patch cannot run on a partial fixture (40+ sub-patches, executor injection at
// app ready), which is why the real bundle is used. Those sections SKIP when the
// binary or the extract is missing - the build job is the authoritative gate.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
  accessSync,
  constants,
} from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const SKIP_EXIT = 3;
const PATCH_BIN = join(repo, "patches", "linux", "fix_computer_use_linux");
const BUILD_DIR = join(
  process.env.CDB_BUNDLE_DIR || join(repo, "tmp", "app.asar.contents"),
  ".vite",
  "build"
);
// Read from the patch source, so a sub-patch added there does not fail this
// harness on the counter alone.
const EXPECTED_PATCHES = Number(
  /const EXPECTED_PATCHES = (\d+)/.exec(
    readFileSync(join(repo, "patches", "linux", "fix_computer_use_linux.nim"), "utf8")
  )[1]
);

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
const count = (hay, needle) => hay.split(needle).length - 1;

// --- verbatim v3.1623.0 excerpts (pristine) ----------------------------------
// The preset (`Vvr` ... `Uvr`), the screenshot description selector (`_=...,v=...`)
// and the request_access prefix object of the tool-definition builder `Ne(t,...)`.
const PRESET_PRISTINE = String.raw`Vvr={screenshotFiltering:"native",platform:"linux"},vV={screenshotFiltering:"none",platform:"linux",hitTest:"none"},Hvr=rA()?vV:Vvr,Uvr=!rA()`;
const SELECTOR_PRISTINE = String.raw`_={darwin:"Take a screenshot of the primary display. Applications not in the session allowlist are excluded at the compositor level \u2014 only granted apps and the desktop are visible.",win32:"Take a screenshot of the primary display. Applications not in the session allowlist are excluded at the compositor level \u2014 only granted apps and the desktop are visible.",linux:"Take a screenshot of the primary display. The image is composed from the granted apps' windows only \u2014 everything else, including the desktop and other apps, is blank."}[t.platform],v=t.screenshotFiltering==="native"?_:t.screenshotFiltering==="mask"?"Take a screenshot of the primary display. Applications not in the session allowlist are masked with a solid rectangle \u2014 their content is hidden from you, but the rectangle's position shows where the window is.":"Take a screenshot of the primary display. On this platform, screenshots are NOT filtered \u2014 all open windows are visible."+(t.hitTest==="none"?" That includes this assistant's own window; input aimed at it is discarded.":" Input actions targeting apps not in the session allowlist are rejected.")`;
const ACCESS_PRISTINE = String.raw`{win32:'This computer is running Windows. The file manager is "File Explorer" (not Finder). Elevated processes \u2014 Task Manager, UAC prompts, installers running as administrator \u2014 cannot be controlled even when granted: Windows UIPI blocks input from lower-integrity processes. If one appears, ask the user to handle it manually. ',linux:'This computer is running Linux. The file manager is usually listed as "Files" (not Finder). '+(t.screenshotFiltering==="none"?"This is a Wayland session, so access is to the entire screen rather than to individual apps: still list the apps you intend to use in request_access (the user sees them, and open_application can launch them), and once the user allows, screenshots show everything on the shared screen and clicks and keystrokes go to whatever is under them. Apps the user denied, and apps you did not ask for, are on that screen too: leave them alone. Other apps cannot be raised or hidden for you; if a window covers the one you need, click a visible part of it or ask the user to bring it forward. ":"The desktop shell (panels, docks, the Activities overview) cannot be granted; use open_application to bring apps forward. "),darwin:'This computer is running macOS. The file manager is "Finder". '}[t.platform]`;
const SHOT_PRISTINE = String.raw`v+" Returns an error if the allowlist is empty. The returned image is what subsequent click coordinates are relative to."`;
// The preset's five names are re-minified every release (Vvr/vV/Hvr/rA/Uvr in
// v3.1623.0, NCr/YG/PCr/zj/FCr in v3.6556.2), so the drift check matches its
// shape with those names wildcarded; [1] keeps evaluating the verbatim excerpt.
const PRESET_SHAPE_RE = new RegExp(
  ["Vvr", "vV", "Hvr", "rA", "Uvr"].reduce(
    (src, name) => src.replace(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "g"), "[\\w$]+"),
    PRESET_PRISTINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ),
  "g",
);

const VVR_LITERAL = '{screenshotFiltering:"native",platform:"linux"}';
const VV_LITERAL = '{screenshotFiltering:"none",platform:"linux",hitTest:"none"}';
const UPSTREAM_X11_SHOT = "The image is composed from the granted apps' windows only";
const UPSTREAM_WAYLAND_ACCESS = "This is a Wayland session, so access is to the entire screen";
const OUR_SHOT = "All open windows are visible";
const OUR_SHOT_SUFFIX = " The returned image is what subsequent click coordinates are relative to.";
const OUR_X11_ACCESS = "Screenshots capture the whole primary display";
const PRESET_MARKER = ':process.platform==="linux"?{screenshotFiltering:"none",platform:"linux"}:';

// Evaluate a preset declaration list and return the PLATFORM_CAPABILITIES
// object. `isWayland` stands in for upstream's env check (`rA` in v3.1623.0).
function evalPreset(decls, { presetName, waylandFnName, platform, env }) {
  const sandbox = {
    process: { platform, env },
    [waylandFnName]: () => env.XDG_SESSION_TYPE === "wayland",
  };
  sandbox.globalThis = sandbox;
  return vm.runInNewContext(`var ${decls};${presetName}`, vm.createContext(sandbox));
}

// Evaluate the builder's description selector for one capabilities object and
// return the screenshot tool description and the request_access prefix.
function evalDescriptions({ tName, selector, shot, access }, caps, { platform, env, kwin = false }) {
  const sandbox = { process: { platform, env } };
  if (kwin) sandbox.__cuKwinMode = true;
  sandbox.globalThis = sandbox;
  const src = `(function(${tName}){let ${selector};return {screenshot:${shot},access:${access}}})`;
  return vm.runInNewContext(src, vm.createContext(sandbox))(caps);
}

const X11_ENV = { XDG_SESSION_TYPE: "x11" };
const UNSET_ENV = {};
const WAYLAND_ENV = { XDG_SESSION_TYPE: "wayland" };

// --- [1] the pristine shapes: why the patch exists ----------------------------
console.log("\n[1] pristine v3.1623.0 shapes: X11 resolves to the 'granted apps only' text");
{
  const pristine = { tName: "t", selector: SELECTOR_PRISTINE, shot: SHOT_PRISTINE, access: ACCESS_PRISTINE };
  const presetOpts = { presetName: "Hvr", waylandFnName: "rA" };
  const capsX11 = evalPreset(PRESET_PRISTINE, { ...presetOpts, platform: "linux", env: UNSET_ENV });
  check("pristine preset on X11 is the native-filtering LINUX preset", capsX11.screenshotFiltering, "native");
  const x11 = evalDescriptions(pristine, capsX11, { platform: "linux", env: UNSET_ENV });
  check("pristine X11 screenshot text claims granted apps' windows only", x11.screenshot.includes(UPSTREAM_X11_SHOT), true);
  check("pristine X11 request_access prefix is the 'desktop shell cannot be granted' arm", x11.access.includes("The desktop shell (panels, docks, the Activities overview) cannot be granted"), true);
  const capsWl = evalPreset(PRESET_PRISTINE, { ...presetOpts, platform: "linux", env: WAYLAND_ENV });
  check("pristine preset on Wayland is the none-filtering preset", capsWl.screenshotFiltering, "none");
  const wl = evalDescriptions(pristine, capsWl, { platform: "linux", env: WAYLAND_ENV });
  check("pristine Wayland request_access prefix carries upstream's Wayland sentence", wl.access.includes(UPSTREAM_WAYLAND_ACCESS), true);
}

// --- [2]..[6] the real bundle through the compiled patch ----------------------
let skipped = false;
let patchMissing = false;
try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  patchMissing = true;
}
const stub = join(BUILD_DIR, "index.js");
if (patchMissing || !existsSync(stub)) {
  skipped = true;
  console.log(
    "\n  SKIP real-bundle sections: " +
      (patchMissing
        ? "patches/linux/fix_computer_use_linux is not compiled (run: make -C patches linux/fix_computer_use_linux)"
        : "no extract under tmp/app.asar.contents/ (set CDB_BUNDLE_DIR to point at one)")
  );
} else {
  const scratch = mkdtempSync(join(tmpdir(), "cdb-cu-x11-desc-"));
  try {
    // Stage exactly as the orchestrator does: stub + every index*.chunk-*
    // sibling as ONE file, each sibling preceded by its boundary marker.
    const chunks = readdirSync(BUILD_DIR)
      .filter((d) => /^index.*\.chunk-.*\.js$/.test(d))
      .sort();
    const originals = new Map([["index.js", readFileSync(stub, "utf8")]]);
    let blob = originals.get("index.js");
    for (const c of chunks) {
      const body = readFileSync(join(BUILD_DIR, c), "utf8");
      originals.set(c, body);
      blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + body;
    }
    const staged = join(scratch, "staged_index.js");
    writeFileSync(staged, blob);

    console.log("\n[2] the pristine excerpts are still verbatim in the extract (anchor drift)");
    check("preset line present once", (blob.match(PRESET_SHAPE_RE) || []).length, 1);
    check("screenshot selector present once", count(blob, SELECTOR_PRISTINE), 1);
    check("request_access prefix present once", count(blob, ACCESS_PRISTINE), 1);
    check("screenshot suffix present once", count(blob, SHOT_PRISTINE), 1);

    console.log("\n[3] the compiled patch applies with the full counter, then is idempotent");
    const run = () => {
      const r = spawnSync(PATCH_BIN, [staged], { encoding: "utf8" });
      return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
    };
    const r1 = run();
    check("first run exits 0", r1.status, 0);
    check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
    check(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} reported`, r1.out.includes(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} sub-patches applied`), true);
    check("2b reported [OK]", /\[OK\] 2b PLATFORM_CAPABILITIES \([\w$]+\/[\w$]+\): X11 uses the none-filtering preset \(1 match\)/.test(r1.out), true);
    check("13b.linux reported [OK]", r1.out.includes("[OK] 13b.linux request_access: Wayland sentence only on Wayland, X11 gets the whole-display sentence"), true);
    if (r1.status !== 0) console.log(r1.out);
    const patched = readFileSync(staged, "utf8");
    const r2 = run();
    check("second run exits 0", r2.status, 0);
    check("second run reports every end-state marker present", /\[OK\] all \d+ end-state markers already present \(idempotent, no change\)/.test(r2.out), true);
    check("second run leaves the file byte-identical", readFileSync(staged, "utf8") === patched, true);

    console.log("\n[4] every changed chunk still parses (node --check)");
    const parts = patched.split(/\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/);
    const names = ["index.js"];
    const bodies = [parts[0]];
    for (let i = 1; i < parts.length; i += 2) {
      names.push(parts[i]);
      bodies.push(parts[i + 1]);
    }
    check("split back into the staged chunk count", names.length, chunks.length + 1);
    let changed = 0;
    let syntaxFailures = 0;
    for (let i = 0; i < names.length; i++) {
      if (bodies[i] === originals.get(names[i])) continue;
      changed++;
      const f = join(scratch, names[i]);
      writeFileSync(f, bodies[i]);
      try {
        execFileSync("node", ["--check", f], { stdio: "pipe" });
      } catch {
        syntaxFailures++;
        console.log("  node --check failed for " + names[i]);
      }
    }
    check("at least one chunk changed", changed > 0, true);
    check(`node --check failures across ${changed} changed chunk(s)`, syntaxFailures, 0);

    console.log("\n[5] the patched preset, selector and request_access prefix resolve per session");
    check("preset marker lands exactly once", count(patched, PRESET_MARKER), 1);
    check("our X11 request_access sentence lands exactly once", count(patched, OUR_X11_ACCESS), 1);
    check("the 13f else-arm still carries the clean screenshot text",
      /=([\w$]+)\.screenshotFiltering==="native"\?[\w$]+:\1\.screenshotFiltering==="mask"\?"[^"]*":\(process\.platform==="linux"\?"Take a screenshot of the primary display\. All open windows are visible\.":/.test(patched),
      true);

    const presetRe = /(?<![\w$.])([\w$]+)=\{screenshotFiltering:"native",platform:"linux"\},([\w$]+)=\{screenshotFiltering:"none",platform:"linux",hitTest:"none"\},([\w$]+)=([\w$]+)\(\)\?\2:process\.platform==="linux"\?\{screenshotFiltering:"none",platform:"linux"\}:\1,([\w$]+)=!\4\(\)/;
    const pm = presetRe.exec(patched);
    check("patched preset is extractable", !!pm, true);

    const selStart = patched.indexOf('={darwin:"Take a screenshot of the primary display.');
    const retIdx = selStart === -1 ? -1 : patched.indexOf(';return[{name:"request_access",description:', selStart);
    const accEnd = retIdx === -1 ? -1 : patched.indexOf('+"Request user permission', retIdx);
    check("patched selector region is locatable", selStart !== -1 && retIdx !== -1 && accEnd !== -1, true);

    if (pm && selStart !== -1 && retIdx !== -1 && accEnd !== -1) {
      let b = selStart;
      while (!/[,;{ ]/.test(patched[b - 1])) b--;
      const selector = patched.slice(b, retIdx);
      const accessExpr = patched.slice(retIdx + ';return[{name:"request_access",description:'.length, accEnd);
      const tm = /\}\[([\w$]+)\.platform\]$/.exec(accessExpr);
      check("builder parameter name is recoverable from the prefix object", !!tm, true);
      const shotM = /\{name:"screenshot",description:([\w$]+\+\(process\.platform==="linux"\?"[^"]*":"[^"]*"\))/.exec(patched.slice(accEnd, accEnd + 40000));
      check("patched screenshot tool description is extractable", !!shotM, true);
      if (tm && shotM) {
        const tName = tm[1];
        const shapes = { tName, selector, shot: shotM[1], access: accessExpr };
        const presetOpts = { presetName: pm[3], waylandFnName: pm[4] };
        const decls = pm[0];

        // X11 (XDG_SESSION_TYPE unset, and set to x11)
        for (const [label, env] of [["unset", UNSET_ENV], ["x11", X11_ENV]]) {
          const caps = evalPreset(decls, { ...presetOpts, platform: "linux", env });
          check(`X11 (${label}) preset is none-filtering`, caps.screenshotFiltering, "none");
          check(`X11 (${label}) preset carries no hitTest key`, Object.prototype.hasOwnProperty.call(caps, "hitTest"), false);
          const d = evalDescriptions(shapes, caps, { platform: "linux", env });
          check(`X11 (${label}) screenshot says all open windows are visible`, d.screenshot.includes(OUR_SHOT), true);
          check(`X11 (${label}) screenshot ends with the 13g suffix`, d.screenshot.endsWith(OUR_SHOT_SUFFIX), true);
          check(`X11 (${label}) screenshot no longer claims granted apps only`, d.screenshot.includes(UPSTREAM_X11_SHOT), false);
          check(`X11 (${label}) screenshot has no allowlist-empty error`, d.screenshot.includes("Returns an error if the allowlist is empty"), false);
          check(`X11 (${label}) request_access carries the whole-display sentence`, d.access.includes(OUR_X11_ACCESS), true);
          check(`X11 (${label}) request_access keeps upstream's Linux file-manager sentence`, d.access.startsWith('This computer is running Linux. The file manager is usually listed as "Files" (not Finder). '), true);
          check(`X11 (${label}) request_access does not claim a Wayland session`, d.access.includes(UPSTREAM_WAYLAND_ACCESS), false);
        }

        // Wayland
        {
          const caps = evalPreset(decls, { ...presetOpts, platform: "linux", env: WAYLAND_ENV });
          check("Wayland preset is upstream's LINUX_WAYLAND object", caps.screenshotFiltering === "none" && caps.hitTest === "none", true);
          const d = evalDescriptions(shapes, caps, { platform: "linux", env: WAYLAND_ENV });
          check("Wayland request_access carries upstream's Wayland sentence", d.access.includes(UPSTREAM_WAYLAND_ACCESS), true);
          check("Wayland request_access has no X11 sentence", d.access.includes(OUR_X11_ACCESS), false);
          check("Wayland screenshot says all open windows are visible", d.screenshot.includes(OUR_SHOT), true);
        }

        // KDE Wayland (kwin mode) with the env unset still reads as Wayland
        {
          const caps = evalPreset(decls, { ...presetOpts, platform: "linux", env: UNSET_ENV });
          const d = evalDescriptions(shapes, caps, { platform: "linux", env: UNSET_ENV, kwin: true });
          check("kwin mode request_access carries upstream's Wayland sentence", d.access.includes(UPSTREAM_WAYLAND_ACCESS), true);
        }

        // Not Linux: the preset falls back to upstream's own object
        {
          const caps = evalPreset(decls, { ...presetOpts, platform: "darwin", env: UNSET_ENV });
          check("off Linux the non-Wayland arm is upstream's LINUX object", caps.screenshotFiltering === "native" && caps.platform === "linux", true);
        }
      }
    }

    console.log("\n[6] upstream's own preset objects are untouched");
    check("LINUX literal count unchanged", count(patched, VVR_LITERAL), count(blob, VVR_LITERAL));
    check("LINUX literal present exactly once", count(patched, VVR_LITERAL), 1);
    check("LINUX_WAYLAND literal count unchanged", count(patched, VV_LITERAL), count(blob, VV_LITERAL));
    check("the Wayland sentence still occurs exactly once", count(patched, UPSTREAM_WAYLAND_ACCESS), 1);
    check("the allowlist_empty refusal is untouched", count(patched, "allowlist_empty"), count(blob, "allowlist_empty"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
if (skipped) {
  console.log(`${pass} checks passed; real-bundle sections SKIPPED`);
  process.exit(SKIP_EXIT);
}
console.log("ALL " + pass + " CHECKS PASSED");

#!/usr/bin/env node
// Local builds must not bundle a Computer Use bridge that is above its glibc floor.
//
// WHY THIS EXISTS
// ---------------
// scripts/build-local.sh used to bundle ../computer-use/<bridge>/target/release/*
// without looking at it. Built on a rolling host (Arch, glibc 2.44) the kwin
// bridge needed GLIBC_2.44; on Fedora 43 (2.42) it did not start and the app
// fell back to another screenshot path with no error. scripts/bridge-glibc.sh
// now checks every bundled bridge against its floor, rebuilds an over-floor
// dynamic bridge in ubuntu:24.04 (docker) with a cache, and warns (or fails
// under --strict-bridges) when it cannot.
//
// This harness sources the real helper and drives it with stub `objdump` and
// `docker` programs on PATH: no docker, network or compiler needed.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync,
         existsSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const helper = join(repo, "scripts", "bridge-glibc.sh");

let failures = 0;
const check = (name, cond, extra = "") => {
    console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${cond ? "" : extra ? "  -> " + extra : ""}`);
    if (!cond) failures++;
};

if (spawnSync("bash", ["-c", "command -v git sha256sum"]).status !== 0) {
    console.log("SKIP: git or sha256sum missing");
    process.exit(3);
}

check("scripts/bridge-glibc.sh exists", existsSync(helper));
if (!existsSync(helper)) process.exit(1);

const tmp = mkdtempSync(join(tmpdir(), "bridge-glibc-"));
const stubs = join(tmp, "stubs");
const bare = join(tmp, "bare");   // tools without docker
mkdirSync(stubs); mkdirSync(bare);

const stub = (name, body) => {
    writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(stubs, name), 0o755);
};
// objdump -T FILE prints the fake table kept in FILE.objdump, else fails like a non-ELF.
stub("objdump", `[ -f "\${2}.objdump" ] || exit 1; cat "\${2}.objdump"`);
// docker: "info" succeeds; "run" fakes the container build: out dir from the -v ...:/out
// mount, writes a binary needing $FAKE_DOCKER_GLIBC, counts invocations.
stub("docker", `
if [ "$1" = info ]; then exit 0; fi
echo run >> "$DOCKER_COUNT"
[ "\${FAKE_DOCKER_FAIL:-0}" = 1 ] && exit 1
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = -v ]; then case "$2" in *:/out) out="\${2%:/out}";; esac; fi
  if [ "$1" = -e ]; then case "$2" in NAME=*) name="\${2#NAME=}";; esac; fi
  shift
done
echo bin > "$out/$name"
printf 'x  DF *UND*  0 (GLIBC_%s) sym\\n' "$FAKE_DOCKER_GLIBC" > "$out/$name.objdump"
`);
for (const t of ["bash", "git", "sort", "grep", "sed", "tail", "cut", "sha256sum", "xargs",
                 "cat", "mkdir", "rm", "printf", "id", "dirname", "env"]) {
    const w = spawnSync("bash", ["-c", `command -v ${t}`]).stdout.toString().trim();
    if (w) symlinkSync(w, join(bare, t));
}
symlinkSync(join(stubs, "objdump"), join(bare, "objdump"));

const objdumpFor = (bin, ...vers) =>
    writeFileSync(bin + ".objdump", vers.map(v => `0000 g DF *UND* 0 (GLIBC_${v}) sym`).join("\n") + "\n");
const mkBin = (path, ...vers) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "elf\n");
    objdumpFor(path, ...vers);
    return path;
};

// A bridge checkout (git repo) so the cache key has a HEAD.
const co = join(tmp, "computer-use");
const kwin = join(co, "kwin-portal-bridge");
mkdirSync(kwin, { recursive: true });
writeFileSync(join(kwin, "Cargo.toml"), "x\n");
spawnSync("bash", ["-c", "git init -q . && git add . && git -c user.email=a@b -c user.name=n commit -qm i"], { cwd: kwin });

const run = (script, { path, env = {} } = {}) => {
    const r = spawnSync("bash", ["-c", `source "${helper}"; ${script}`], {
        env: { PATH: path ?? `${stubs}:${process.env.PATH}`, HOME: tmp,
               DOCKER_COUNT: join(tmp, "docker.count"), ...env },
        encoding: "utf8",
    });
    return { rc: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const dockerRuns = () => existsSync(join(tmp, "docker.count"))
    ? readFileSync(join(tmp, "docker.count"), "utf8").trim().split("\n").length : 0;

try {
    console.log("floor verdicts");
    const f = join(tmp, "fb");
    const verdict = (floor, ...vers) => {
        const b = mkBin(join(f, `b${Math.random()}`), ...vers);
        return run(`cdb_bridge_check "${b}" ${floor}; echo $?`).out.trim().split("\n").pop();
    };
    check("2.44 vs floor 2.39 fails", verdict("2.39", "2.34", "2.44") === "1");
    check("2.39 vs floor 2.39 passes", verdict("2.39", "2.17", "2.39") === "0");
    check("2.9 vs floor 2.39 passes (version sort, not lexical)", verdict("2.39", "2.9", "2.4") === "0");
    check("2.10 vs floor 2.9 fails (version sort)", verdict("2.9", "2.10") === "1");
    check("static (no GLIBC symbols) passes the static floor", verdict("static") === "0");
    check("a GLIBC symbol in a 'static' bridge fails", verdict("static", "2.17") === "1");
    check("bridge floors come from one table",
          run(`for b in x11-bridge wlroots-bridge gnome-portal-bridge kwin-portal-bridge; do printf '%s ' "$(cdb_bridge_floor $b)"; done`)
              .out.trim() === "static static 2.39 2.39");

    console.log("pre-built within floor is bundled as is");
    const okBin = mkBin(join(kwin, "target", "release", "kwin-portal-bridge"), "2.34", "2.39");
    let r = run(`cdb_resolve_bridge kwin-portal-bridge "${kwin}" "${okBin}" KWIN_PORTAL_BRIDGE_BIN; echo "BIN=$KWIN_PORTAL_BRIDGE_BIN"`);
    check("pre-built used", r.out.includes(`BIN=${okBin}`) && r.out.includes("pre-built (glibc 2.39 <= 2.39)"), r.out);
    check("no docker run", dockerRuns() === 0);

    console.log("pre-built above floor, docker usable: container build, then cache");
    const badBin = mkBin(join(kwin, "target", "release", "kwin-portal-bridge"), "2.44");
    const dEnv = { FAKE_DOCKER_GLIBC: "2.39" };
    r = run(`cdb_resolve_bridge kwin-portal-bridge "${kwin}" "${badBin}" KWIN_PORTAL_BRIDGE_BIN; echo "BIN=$KWIN_PORTAL_BRIDGE_BIN"`, { env: dEnv });
    const built = join(kwin, "target", "glibc-2.39", "kwin-portal-bridge");
    check("container-built binary is bundled", r.out.includes(`BIN=${built}`) && r.out.includes("container build (glibc <= 2.39)"), r.out);
    check("docker ran once", dockerRuns() === 1);
    check("host target/release binary untouched", readFileSync(badBin, "utf8") === "elf\n");
    r = run(`cdb_resolve_bridge kwin-portal-bridge "${kwin}" "${badBin}" KWIN_PORTAL_BRIDGE_BIN; echo "BIN=$KWIN_PORTAL_BRIDGE_BIN"`, { env: dEnv });
    check("second run is a cache hit", r.out.includes("container build, cached") && dockerRuns() === 1, r.out);
    writeFileSync(join(kwin, "Cargo.toml"), "changed\n");
    r = run(`cdb_resolve_bridge kwin-portal-bridge "${kwin}" "${badBin}" KWIN_PORTAL_BRIDGE_BIN`, { env: dEnv });
    check("a dirty checkout invalidates the cache", dockerRuns() === 2, r.out);

    console.log("container result above the floor is rejected");
    writeFileSync(join(kwin, "Cargo.toml"), "changed again\n");
    r = run(`cdb_resolve_bridge kwin-portal-bridge "${kwin}" "${badBin}" KWIN_PORTAL_BRIDGE_BIN; echo "rc=$? BIN=$KWIN_PORTAL_BRIDGE_BIN"`, { env: { FAKE_DOCKER_GLIBC: "2.41" } });
    check("falls back to the warning path, host binary", /\[warn\].*glibc >= 2\.44/.test(r.out) && r.out.includes(`BIN=${badBin}`) && r.out.includes("rc=0"), r.out);

    console.log("docker unavailable");
    r = run(`cdb_resolve_bridge kwin-portal-bridge "${kwin}" "${badBin}" KWIN_PORTAL_BRIDGE_BIN; echo "rc=$? BIN=$KWIN_PORTAL_BRIDGE_BIN"`, { path: bare });
    check("warns naming bridge, requirement, floor, consequence",
          /\[warn\] kwin-portal-bridge:.*2\.44.*floor 2\.39.*docker is not usable.*glibc >= 2\.44.*not for copying elsewhere/.test(r.out), r.out);
    check("still bundles the host binary and succeeds", r.out.includes("rc=0") && r.out.includes(`BIN=${badBin}`), r.out);
    r = run(`CDB_STRICT_BRIDGES=1 cdb_resolve_bridge kwin-portal-bridge "${kwin}" "${badBin}" KWIN_PORTAL_BRIDGE_BIN; echo "rc=$? BIN=$KWIN_PORTAL_BRIDGE_BIN"`, { path: bare });
    check("--strict-bridges turns it into an error and bundles nothing", /\[error\]/.test(r.out) && r.out.includes("rc=1") && r.out.includes("BIN=\n") || /rc=1 BIN=$/.test(r.out.trim()), r.out);

    console.log("container build failure");
    r = run(`cdb_resolve_bridge kwin-portal-bridge "${kwin}" "${badBin}" KWIN_PORTAL_BRIDGE_BIN; echo "rc=$?"`, { env: { FAKE_DOCKER_FAIL: "1" } });
    check("failed container build only warns", /container build failed/.test(r.out) && r.out.includes("rc=0"), r.out);

    console.log("static bridges");
    const xb = mkBin(join(co, "x11-bridge", "target", "x", "x11-bridge"));
    r = run(`cdb_resolve_bridge x11-bridge "${join(co, "x11-bridge")}" "${xb}" X11_BRIDGE_BIN; echo "BIN=$X11_BRIDGE_BIN"`);
    check("static pre-built is bundled with its source line", r.out.includes("x11-bridge: pre-built static") && r.out.includes(`BIN=${xb}`), r.out);

    console.log("build-local.sh wiring");
    const bl = readFileSync(join(repo, "scripts", "build-local.sh"), "utf8");
    check("sources the helper", /source "\$SCRIPT_DIR\/bridge-glibc\.sh"/.test(bl));
    for (const [b, v] of [["x11-bridge", "X11_BRIDGE_BIN"], ["wlroots-bridge", "WLROOTS_BRIDGE_BIN"],
                          ["gnome-portal-bridge", "GNOME_PORTAL_BRIDGE_BIN"], ["kwin-portal-bridge", "KWIN_PORTAL_BRIDGE_BIN"]])
        check(`resolves ${b}`, new RegExp(`cdb_resolve_bridge ${b} [\\s\\S]*?${v}`).test(bl));
    check("--strict-bridges option", /--strict-bridges\)\s+export CDB_STRICT_BRIDGES=1/.test(bl));
    check("no unchecked 'Using pre-built' branches left", !/Using pre-built (gnome|kwin)-portal-bridge/.test(bl));
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\nFAIL: ${failures} check(s)` : "\nPASS");
process.exit(failures ? 1 : 0);

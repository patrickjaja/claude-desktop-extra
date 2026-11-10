# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Make Cowork's "install QEMU" hint name the host distro's own packages.
#
# Upstream's Cowork support determiner reports `virtualization_tools_missing`
# ("Cowork requires QEMU. Install it with '{installCommand}', then restart
# Claude.") whenever the QEMU binary, the UEFI firmware or virtiofsd is missing.
# The command is built with no distro detection at all:
#
#   installCommand:["sudo apt install",
#     ...process.arch==="arm64"?["qemu-system-arm","qemu-efi-aarch64"]
#                              :["qemu-system-x86","ovmf"],
#     ...t.virtiofsdPath?[]:["virtiofsd"]].join(" ")
#
# so Fedora, RHEL, Arch, openSUSE and NixOS users are told to run apt. The
# string is a plain ICU argument built in the main bundle (the settings SPA only
# shows the ready-made reason), so wrapping that one expression is enough:
#
#   installCommand:(function(u){...})([...].join(" "))
#
# The wrapper receives upstream's own string `u` and returns it unchanged for
# Debian/Ubuntu and every unrecognised or unreadable os-release. Otherwise it
# rebuilds the command for the family named by /etc/os-release ID, then
# ID_LIKE (first known token wins, so Rocky's `rhel centos fedora` is RHEL):
#
#   fedora       sudo dnf install qemu-system-x86 edk2-ovmf [virtiofsd]
#                (aarch64: qemu-system-aarch64 edk2-aarch64)
#   rhel family  sudo dnf install qemu-kvm edk2-ovmf [virtiofsd]
#                (aarch64: qemu-kvm edk2-aarch64; our rpm's qemu-shim maps
#                 /usr/libexec/qemu-kvm to qemu-system-<arch>)
#   arch family  sudo pacman -S qemu-system-x86 edk2-ovmf [virtiofsd]
#                (aarch64: qemu-system-aarch64 edk2-aarch64)
#   openSUSE     sudo zypper install qemu-x86 qemu-ovmf-x86_64 [virtiofsd]
#                (aarch64: qemu-arm qemu-uefi-aarch64)
#   NixOS        no command: "add qemu, OVMF[, virtiofsd] to environment.systemPackages"
#
# virtiofsd is listed exactly when upstream's string lists it. Never throws
# into upstream: any failure returns upstream's string.
#
# os-release is read from /etc/os-release, else /usr/lib/os-release (the
# os-release(5) fallback). An image-based (ostree) system - an OSTREE_VERSION
# key, or VARIANT_ID silverblue / kinoite / sericea / onyx / iot / coreos /
# bazzite* - keeps upstream's text: dnf cannot install into its read-only base.
#
# The KVM / vhost_vsock hints are distro-neutral and untouched.

import std/[os, strformat, strutils]
import regex

const MARKER* = "__cdbCwHintFam"

# One line of JS, no backticks, no template literals (the bundle is minified and
# its own quoting varies; ours stays double-quoted).
const WRAPPER* =
  "(function(u){try{var g=globalThis,k=\"__cdbCwHintFam\",F=g[k];" &
  "if(F===void 0){F=\"\";try{var r=require(\"fs\"),t;" &
  "try{t=r.readFileSync(\"/etc/os-release\",\"utf8\")}catch(e1){t=r.readFileSync(\"/usr/lib/os-release\",\"utf8\")}" &
  "var a=/^ID=(.*)$/m.exec(t),b=/^ID_LIKE=(.*)$/m.exec(t),c=/^VARIANT_ID=(.*)$/m.exec(t)," &
  "o=/^OSTREE_VERSION=/m.test(t)||/^[\"']?(silverblue|kinoite|sericea|onyx|iot|coreos|bazzite)/.test(c?c[1].toLowerCase():\"\");" &
  "F=o?\"\":((a?a[1]:\"\")+\" \"+(b?b[1]:\"\")).replace(/[\"']/g,\"\").toLowerCase().trim()}catch(e){}g[k]=F}" &
  "var T=F.split(/\\s+/),f=\"\",i,x;" & "for(i=0;i<T.length&&!f;i++){x=T[i];" &
  "f=x===\"debian\"||x===\"ubuntu\"?\"deb\":" &
  "x===\"rhel\"||x===\"centos\"||x===\"rocky\"||x===\"almalinux\"||x===\"ol\"?\"rhel\":" &
  "x===\"fedora\"?\"fed\":" &
  "x===\"arch\"||x===\"manjaro\"||x===\"endeavouros\"?\"arch\":" &
  "x===\"suse\"||x===\"sles\"||x.indexOf(\"opensuse\")===0?\"suse\":" &
  "x===\"nixos\"?\"nix\":\"\"}" &
  "var m=process.arch===\"arm64\",v=/ virtiofsd$/.test(u),z=v?\" virtiofsd\":\"\";" &
  "return f===\"fed\"?\"sudo dnf install \"+(m?\"qemu-system-aarch64 edk2-aarch64\":\"qemu-system-x86 edk2-ovmf\")+z:" &
  "f===\"rhel\"?\"sudo dnf install \"+(m?\"qemu-kvm edk2-aarch64\":\"qemu-kvm edk2-ovmf\")+z:" &
  "f===\"arch\"?\"sudo pacman -S \"+(m?\"qemu-system-aarch64 edk2-aarch64\":\"qemu-system-x86 edk2-ovmf\")+z:" &
  "f===\"suse\"?\"sudo zypper install \"+(m?\"qemu-arm qemu-uefi-aarch64\":\"qemu-x86 qemu-ovmf-x86_64\")+z:" &
  "f===\"nix\"?\"add qemu, OVMF\"+(v?\", virtiofsd\":\"\")+\" to environment.systemPackages\":u}catch(e){return u}})"

let reOld* = re2(
  "installCommand:(\\[[\"`]sudo apt install[\"`],\\.\\.\\.process\\.arch===[\"`]arm64[\"`]\\?" &
    "\\[[\"`]qemu-system-arm[\"`],[\"`]qemu-efi-aarch64[\"`]\\]:\\[[\"`]qemu-system-x86[\"`],[\"`]ovmf[\"`]\\]," &
    "\\.\\.\\.[\\w$]+\\.virtiofsdPath\\?\\[\\]:\\[[\"`]virtiofsd[\"`]\\]\\]\\.join\\([\"`] [\"`]\\))"
)

const EXPECTED_PATCHES = 1

proc apply*(input: string): string =
  result = input
  var applied = 0
  let injected = result.count("installCommand:" & WRAPPER & "(")
  if injected == 1 and result.count(MARKER) == 1:
    echo "  [OK] install hint wrapper already present (idempotent)"
    inc applied
  elif injected != 0 or result.count(MARKER) != 0:
    echo &"  [FAIL] half-patched: {injected} wrapper(s), {result.count(MARKER)} marker(s)"
  else:
    let sites = result.findAll(reOld).len
    if sites != 1:
      echo &"  [FAIL] expected exactly 1 installCommand site, found {sites}"
    else:
      result = result.replace(
        reOld,
        proc(m: RegexMatch2, s: string): string =
          "installCommand:" & WRAPPER & "(" & s[m.group(0)] & ")",
      )
      if result.count("installCommand:" & WRAPPER & "(") == 1:
        echo "  [OK] installCommand wrapped (1 site)"
        inc applied
      else:
        echo "  [FAIL] wrapper not present after rewrite"
  if applied < EXPECTED_PATCHES:
    raise newException(
      ValueError,
      &"fix_cowork_install_hint_linux: only {applied}/{EXPECTED_PATCHES} sub-patches applied",
    )

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_cowork_install_hint_linux <path_to_index.js>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_cowork_install_hint_linux ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  var output: string
  try:
    output = apply(input)
  except ValueError as e:
    echo &"  [FAIL] {e.msg}"
    quit(1)
  if output != input:
    writeFile(file, output)
    echo "  [PASS] Cowork install hint follows the distro"
  else:
    echo "  [PASS] Cowork install hint already present (idempotent)"

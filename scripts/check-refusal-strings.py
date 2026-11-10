#!/usr/bin/env python3
"""Every platform/session refusal string in the main-process bundle must be pinned.

WHY THIS EXISTS
---------------
Issue #323 reached users as a model-facing refusal - "Computer use over the
device bridge is not supported on this platform (on Linux it needs an Xorg
session ...)" - that no gate looked at: the string sat behind a predicate
consumer our patch had missed. Upstream refusal wording is the most stable
fingerprint such a guard leaves, so this check lists every string in
.vite/build/index*.js that names a topic (Wayland, Xorg/X11/X server/display
server, portal, Linux, macOS, this platform / device / computer / system,
unsupported platform, session type, Computer Use) AND reads like a refusal
(not supported / available, unavailable, requires, cannot, unable to, only
on/for, ...; for the device/computer/system topics only support wording
counts), and compares it with baseline/refusal-strings.json:

FAIL (exit 1), because the release may now refuse a Linux user:
  * a NEW string naming a STRONG topic (Linux, Wayland, Xorg / X11 / X server
    / display server, portal, session type, this platform / unsupported
    platform, Computer Use);
  * a `neutralised` pin whose `verify` injection (regex + count over the
    bundle) no longer matches - the patch that made it true regressed;
  * a `neutralised` or `unreachable` pin printed at a different number of
    sites than pinned (a new site has not been reasoned about);
  * a missing or malformed baseline (exit 2).
WARN (printed as [WARN] lines, exit 0), because it is wording drift the next
/update refreshes:
  * a NEW string matched only by a WEAK topic (this device / computer /
    system, macOS, "only available on", "not supported on");
  * a stale pin (upstream no longer ships the string);
  * an `accepted` pin printed at a different number of sites.
`--strict` turns every warning into a failure (manual audits, /update).

Strings are found keyword-first: each topic hit is mapped to its enclosing
literal by a structural lexer (scripts/census_lex.py), so template literals
with nested `${...}` are read whole, and a `"a"+x+"b"` concatenation chain is
read as one text. Template expressions become `${}` in the key, but refusal
wording inside them still qualifies a short text. Texts longer than 300
characters (prompts) are keyed per sentence. Key: the first 12 hex digits of
sha1(normalised text).

Our own strings are not upstream's: everything our js/ sources inject is left
out (count-based, so an upstream string we duplicate still counts), and a
string a .nim patch writes inline is pinned with status 'accepted' and an
"ours:" reason.

WHAT IT CANNOT SEE: the ion-dist.asar SPA and the remote claude.ai web code
(not in .vite/build/index*.js); refusals assembled from computed pieces
(arrays joined at run time, i18n catalogue ids); wording that names none of
the topics.

Usage:
  scripts/check-refusal-strings.py [--baseline FILE] [--list] [--strict] [--js-dir DIR] <tree>
    <tree>  the PATCHED app.asar.contents/ (or its .vite/build/), as the build runs it
    --list  print every matching string with its key (to review a new release)
    --strict  warnings fail too
Exit: 0 = no failures (warnings may be printed), 1 = failures, 2 = cannot run.

The baseline is edited by hand on purpose; there is no --update mode. A new
entry with status 'accepted' loosens the gate: it needs @patrickjaja in the commit.
"""

import argparse
import glob
import hashlib
import json
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import census_lex as L  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BASELINE = REPO / "baseline" / "refusal-strings.json"
STATUSES = {"neutralised", "unreachable", "accepted"}

# Topic words, matched case-insensitively anywhere in a string (template expressions included).
# STRONG topics are the Linux / session / Computer Use ones: a NEW string naming one fails the
# build. WEAK topics name the device or another platform; a new string matched only by them is
# a warning (it is mostly product wording drift), and so is a stale pin.
STRONG_TOPICS = (b"wayland", b"xorg", b"x11", b"x server", b"display server", b"portal", b"this platform",
                 b"unsupported platform", b"on linux", b"linux", b"session type", b"computer use",
                 b"computer-use")
WEAK_REFUSAL_TOPICS = (b"macos", b"only available on", b"not supported on")
# "this device / computer / system" also names admin policy and connectivity limits; with
# those topics only support wording ("not supported", "unavailable", ...) qualifies
WEAK_TOPICS = (b"this device", b"this computer", b"this system")
TOPIC_WORDS = STRONG_TOPICS + WEAK_REFUSAL_TOPICS + WEAK_TOPICS
SUPPORT = re.compile(
    r"(?i)not supported|unsupported|not available|unavailable|isn't available|only available|not yet supported|"
    r"not currently supported|doesn't support|does not support|isn't supported|no support|\bonly (?:on|for)\b")
REFUSAL = re.compile(
    r"(?i)not supported|not available|unavailable|unsupported|\bneeds? (?:an? |the )|\brequires?\b|\brequired\b|"
    r"only available|cannot|can't|can not|can only|not starting|not enabled|disabled|refus|"
    r"only works|doesn't work|does not work|isn't supported|is not supported|won't work|isn't available|"
    r"is not available|not yet supported|not currently supported|doesn't support|does not support|unable to|"
    r"\bonly (?:on|for)\b|not possible|won't run|will not work|no support")
LONG = 300  # longer texts (prompts) are keyed per sentence
# `"a"+x+"b"`: the gap between two literals of one concatenation chain
_CONCAT_GAP = re.compile(rb"\s*\+\s*(?:(?:[\w$.?!]|\((?:[^()\"'`;{}]|\([^()\"'`;{}]*\))*\))+\s*\+\s*)?")


def die(msg):
    print(f"[ERROR] {msg}", file=sys.stderr)
    sys.exit(2)


def find_build_dir(tree):
    p = Path(tree)
    for cand in (p / ".vite" / "build", p / "app.asar.contents" / ".vite" / "build", p):
        if (cand / "index.js").is_file() or glob.glob(str(cand / "index.chunk-*.js")):
            return cand
    die(f"no .vite/build/index*.js under {tree}")


def _lit_text(ch, lit):
    """(normalised text, raw text with template expressions kept) of one literal."""
    a, b, kind = lit
    s = ch.s
    if kind == "template":
        parts, cur = [], a + 1
        for ea, eb in ch.tpl_expr.get(a, ()):
            parts.append(s[cur:ea - 2])
            parts.append(b"${}")
            cur = eb + 1
        parts.append(s[cur:b - 1])
        norm = b"".join(parts)
    else:
        norm = s[a + 1:b - 1]
    return norm, s[a + 1:b - 1]


def _strings(ch):
    """Top-level string/template literals (not the ones nested in a template's
    `${...}`), sorted: the candidates for `+` chains."""
    if not hasattr(ch, "_str_idx"):
        out, tpl_end = [], -1
        for x in ch.lit:
            if x[0] < tpl_end:
                continue
            if x[2] in ("string", "template"):
                out.append(x)
                if x[2] == "template":
                    tpl_end = x[1]
        ch._str_idx = out
        ch._str_starts = [x[0] for x in out]
    return ch._str_idx, ch._str_starts


def chain_of(ch, lit, with_members=False):
    """The `"a"+x+"b"` concatenation chain around a literal: (first literal start,
    normalised text, raw text). Operands become `${}`."""
    import bisect
    lits, starts = _strings(ch)
    i = bisect.bisect_left(starts, lit[0])
    s = ch.s
    if i >= len(lits) or lits[i][0] != lit[0]:
        # a literal nested in a template expression: read on its own
        n_, r_ = _lit_text(ch, lit)
        dec1 = " ".join(n_.decode("utf-8", "replace").split())
        rr = " ".join(r_.decode("utf-8", "replace").split())
        return (lit[0], dec1, rr, {lit[0]}) if with_members else (lit[0], dec1, rr)
    lo = hi = i
    while lo > 0:
        g = _CONCAT_GAP.fullmatch(s, lits[lo - 1][1], lits[lo][0])
        if not g or lits[lo - 1][1] > lits[lo][0]:
            break
        lo -= 1
    while hi + 1 < len(lits):
        g = _CONCAT_GAP.fullmatch(s, lits[hi][1], lits[hi + 1][0])
        if not g or lits[hi][1] > lits[hi + 1][0]:
            break
        hi += 1
    norm, raw = [], []
    for k in range(lo, hi + 1):
        n_, r_ = _lit_text(ch, lits[k])
        if k > lo:
            gap = s[lits[k - 1][1]:lits[k][0]]
            if gap.strip() != b"+":
                norm.append(b"${}")
                raw.append(b"${}")
        norm.append(n_)
        raw.append(r_)
    dec = lambda b: " ".join(b"".join(b).decode("utf-8", "replace").split())
    if with_members:
        return lits[lo][0], dec(norm), dec(raw), {lits[k][0] for k in range(lo, hi + 1)}
    return lits[lo][0], dec(norm), dec(raw)


def units(text, raw):
    """What gets pinned: the whole text, or for long texts each sentence."""
    if len(text) <= LONG:
        return [(text, raw)]
    parts = re.split(r"(?<=[.!?])\s+|\\n", text)
    return [(p.strip(), p.strip()) for p in parts if p.strip()]



def key_of(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def _collapse(t):
    return " ".join(t.split())


def _js_unescape(t):
    return re.sub(r"\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)", lambda m: (
        chr(int(m.group(1)[1:], 16)) if m.group(1)[0] in "ux" and len(m.group(1)) > 1 else
        {"n": "\n", "t": "\t", "r": "\r"}.get(m.group(1), m.group(1))), t)



def qualifies(t):
    """None, or "strong" / "weak": names a topic and reads like a refusal (support
    wording only for the device/computer/system topics)."""
    tl = t.lower().encode("utf-8", "replace")
    if any(k in tl for k in STRONG_TOPICS) and REFUSAL.search(t):
        return "strong"
    if any(k in tl for k in WEAK_REFUSAL_TOPICS) and REFUSAL.search(t):
        return "weak"
    if any(k in tl for k in WEAK_TOPICS) and SUPPORT.search(t):
        return "weak"
    return None


def our_strings(js_dir):
    """What our own js/ sources put into the bundle: a Counter of pinned-unit texts,
    and the collapsed head of each file (a page script is embedded whole as one
    string literal)."""
    texts, heads = Counter(), []
    for f in sorted(glob.glob(os.path.join(js_dir, "*.js"))):
        with open(f, "rb") as fh:
            data = fh.read()
        heads.append(_collapse(data.decode("utf-8", "replace"))[:240])
        try:
            ch = L.Chunk(os.path.basename(f), data, literals_only=True)
        except L.LexError:
            continue  # an unlexable source only means less is subtracted: fails loud, never silent
        seen = set()
        for lit in _strings(ch)[0]:
            start, text, raw = chain_of(ch, lit)
            if start in seen:
                continue
            seen.add(start)
            for u, _ in units(text, raw):
                texts[u] += 1
    return texts, heads


def scan(build_dir, ours=None):
    """{key: {"text", "sites": [(chunk, offset)]}} for every refusal-like topic string.

    Each topic hit is mapped to its enclosing literal and that literal's whole
    `+` concatenation chain; texts longer than LONG are keyed per sentence. A
    text qualifies when it (or, for a short text, its template expressions)
    names a topic and reads like a refusal. With `ours` (from our_strings), our
    own injected strings are left out: a text's site count is reduced by how
    often our js/ sources carry it, and a literal that is one of our js files
    embedded whole is skipped."""
    found = {}
    own_texts, own_heads = ours if ours else ({}, [])
    for f in sorted(glob.glob(os.path.join(build_dir, "index*.js"))):
        with open(f, "rb") as fh:
            data = fh.read()
        low = data.lower()
        hits = []
        for kw in TOPIC_WORDS:
            i = low.find(kw)
            while i != -1:
                hits.append(i)
                i = low.find(kw, i + 1)
        if not hits:
            continue
        hits.sort()
        ch = L.Chunk(os.path.basename(f), data, literals_only=True)
        seen = set()
        for h in hits:
            lit = ch.literal_at(h)
            if lit is None or lit[2] not in ("string", "template") or lit[0] in seen:
                continue
            start, text, raw, members = chain_of(ch, lit, with_members=True)
            seen.update(members)
            if len(text) > 1000 and own_heads:
                flat = _collapse(_js_unescape(text))
                if any(hh and hh in flat for hh in own_heads):
                    continue  # one of our js/ files embedded whole
            for u, ur in units(text, raw):
                if len(u) < 12:
                    continue
                q = [qualifies(u)] + ([qualifies(ur)] if len(text) <= LONG else [])
                if not any(q):
                    continue
                k = key_of(u)
                ent = found.setdefault(k, {"text": u, "sites": [], "strong": False})
                ent["strong"] = ent["strong"] or "strong" in q
                ent["sites"].append((ch.name, start))
    for k in list(found):
        n = own_texts.get(found[k]["text"], 0)
        if n:
            found[k]["sites"] = found[k]["sites"][:max(0, len(found[k]["sites"]) - n)]
            if not found[k]["sites"]:
                del found[k]
    return found


MIN_PINS = 20  # the bundle has ~160; an emptied list must not pass


def main():
    ap = argparse.ArgumentParser(
        description="Fail when the bundle carries a new Linux/session/Computer Use refusal string that is not "
                    "pinned in baseline/refusal-strings.json, a 'neutralised' pin lost the injection that makes it "
                    "true, or a neutralised/unreachable pin changed its site count. New weak-topic strings, stale "
                    "pins and site-count changes of accepted pins are warnings (--strict fails on them too).",
        epilog="Exit 0 = no failures (warnings may be printed), 1 = failures, 2 = cannot run. New 'accepted' "
               "entries need @patrickjaja in the commit.")
    ap.add_argument("tree", help="PATCHED app.asar.contents/ (or its .vite/build/)")
    ap.add_argument("--baseline", default=str(DEFAULT_BASELINE), help="pinned strings JSON")
    ap.add_argument("--list", action="store_true", help="print every matching string with its key and sites")
    ap.add_argument("--js-dir", default=str(REPO / "js"),
                    help="our injected sources, whose strings are not upstream's (default: the repo's js/); "
                         "'' to subtract nothing")
    ap.add_argument("--strict", action="store_true",
                    help="treat every warning (stale pin, new weak-topic string, recounted accepted pin) as a "
                         "failure - for manual audits and the /update skill")
    ap.add_argument("--fixture", action="store_true", help=argparse.SUPPRESS)  # test harness: small pin lists
    args = ap.parse_args()
    t0 = time.time()

    try:
        with open(args.baseline, "rb") as fh:
            base = json.loads(fh.read())
    except (OSError, ValueError) as e:
        die(f"cannot read baseline {args.baseline}: {e}")
    pinned = {}
    strings = base.get("strings", [])
    if len(strings) < MIN_PINS and not args.fixture:
        die(f"baseline pins only {len(strings)} strings (minimum {MIN_PINS}) - an emptied list is not a pass")
    for i, e in enumerate(strings):
        for f in ("id", "text", "status", "sites", "reason"):
            if f not in e:
                die(f"strings[{i}] lacks '{f}'")
        if e["status"] not in STATUSES:
            die(f"strings[{i}] status {e['status']!r} not one of {sorted(STATUSES)}")
        if e["status"] == "neutralised" and not (isinstance(e.get("verify"), dict) and e["verify"].get("regex")
                                                 and isinstance(e["verify"].get("count"), int)):
            die(f"strings[{i}] is 'neutralised' without verify {{regex, count}} naming the injection that makes it true")
        if key_of(e["text"]) != e["id"]:
            die(f"strings[{i}] id {e['id']} does not match its text (expected {key_of(e['text'])}) - "
                f"edit the text and the id together")
        if e["id"] in pinned:
            die(f"strings[{i}] duplicates id {e['id']}")
        pinned[e["id"]] = e

    build = find_build_dir(args.tree)
    try:
        found = scan(build, our_strings(args.js_dir) if args.js_dir else None)
    except L.LexError as e:
        die(f"lexer: {e}")

    new = sorted(k for k in found if k not in pinned)
    stale = sorted(k for k in pinned if k not in found)
    recount = sorted(k for k in found if k in pinned and len(found[k]["sites"]) != pinned[k]["sites"])
    unverified = []
    bundle_text = None
    for k, e in pinned.items():
        if e["status"] != "neutralised" or k not in found:
            continue
        if bundle_text is None:
            bundle_text = [open(f, "rb").read() for f in sorted(glob.glob(os.path.join(build, "index*.js")))]
        rx = re.compile(e["verify"]["regex"].encode())
        n = sum(len(rx.findall(t)) for t in bundle_text)
        if n != e["verify"]["count"]:
            unverified.append((k, n))

    if args.list:
        for k, ent in sorted(found.items(), key=lambda kv: kv[1]["text"].lower()):
            st = pinned[k]["status"] if k in pinned else "NEW"
            sites = ", ".join(f"{c}@{o}" for c, o in ent["sites"])
            print(f"{k}  {st:<11} {ent['text'][:150]}")
            print(f"              {'strong' if ent['strong'] else 'weak  '}  {sites}")

    # policy: what breaks the build, what is reported for the next /update
    fails, warns = [], []

    def snip(k):
        c, o = found[k]["sites"][0]
        with open(os.path.join(build, c), "rb") as fh:
            return c, o, L.snippet(fh.read(), o)

    for k in new:
        ent = found[k]
        c, o, sn = snip(k)
        msg = (f"new refusal string {k} ({'strong' if ent['strong'] else 'weak'} topic, {len(ent['sites'])} "
               f"site(s), first {c} at byte {o}):\n       text:    {ent['text'][:300]}\n       snippet: {sn}")
        (fails if ent["strong"] else warns).append(msg)
    for k in recount:
        sites = ", ".join(f"{c}@{o}" for c, o in found[k]["sites"])
        msg = (f"pinned string {k} ({pinned[k]['status']}) now printed at {len(found[k]['sites'])} site(s), pinned "
               f"{pinned[k]['sites']} ({sites}) - review the new site: {pinned[k]['text'][:160]}")
        (warns if pinned[k]["status"] == "accepted" else fails).append(msg)
    for k, n in unverified:
        fails.append(f"neutralised string {k} is no longer backed by its injection (verify regex matched {n}x, "
                     f"pinned {pinned[k]['verify']['count']}x) - the patch that makes it true regressed or moved: "
                     f"{pinned[k]['text'][:160]}")
    for k in stale:
        warns.append(f"stale pin {k} ({pinned[k]['status']}): upstream no longer ships this string - re-audit what "
                     f"replaced it, then drop the entry: {pinned[k]['text'][:200]}")
    if args.strict:
        fails, warns = fails + warns, []

    tally = Counter(pinned[k]["status"] for k in found if k in pinned)
    print(f"[refusal-strings] {len(found)} refusal strings on platform/session topics: "
          + ", ".join(f"{s} {n}" for s, n in sorted(tally.items()))
          + f"; new {len(new)}, stale pins {len(stale)}, site-count changes {len(recount)}, "
          + f"unverified neutralised {len(unverified)}; {len(fails)} failure(s), {len(warns)} warning(s)"
          + (" (strict)" if args.strict else "") + f"  ({time.time() - t0:.1f}s)")
    review = [pinned[k] for k in found if k in pinned and "needs review" in pinned[k]["reason"]]
    if review:
        print(f"[refusal-strings] {len(review)} pinned string(s) still marked 'needs review'")

    if warns:
        print("")
        for w in warns:
            print(f"[WARN] {w}")
        print("[WARN] refresh these pins in baseline/refusal-strings.json during the next /update "
              "(`check-refusal-strings.py --strict` lists them as failures).")
    if not fails:
        print("[refusal-strings] OK" + (" (with warnings)" if warns else ""))
        return 0
    print("")
    for f_ in fails:
        print(f"[FAIL] {f_}")
    print("")
    print("What to do: for a NEW string, find the guard in front of it and decide whether it can reach a Linux "
          "user while our features are active. Patch that guard (preferably at the predicate's definition; "
          "scripts/check-predicate-consumers.py lists its consumers), then pin the string as 'neutralised' "
          "(with verify) or 'unreachable' with the reason; or pin it 'accepted' when upstream's refusal is right "
          "on Linux. Copy the key, the exact normalised text and the site count above into "
          "baseline/refusal-strings.json. A new 'accepted' entry loosens this gate and needs @patrickjaja "
          "in the commit.")
    return 1

if __name__ == "__main__":
    sys.exit(main())

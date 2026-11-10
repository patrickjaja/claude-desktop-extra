#!/usr/bin/env python3
"""Every consumer of an upstream Linux-session predicate must be covered or listed.

WHY THIS EXISTS
---------------
Issue #323: our patch rewrote ONE call site of upstream's
`isBridgeComputerUsePlatform` (= "not a Wayland session") while two more
consumers stayed unpatched - one through a chunk export alias (`e.EF()` in a
lazy chunk, the "needs an Xorg session" refusal), one through a destructured
namespace member (`{isBridgeComputerUsePlatform:i}`, the approval card's app
icons). Every existing gate was green: each patch only checks its own anchors.

This check enumerates EVERY consumer of each tracked predicate in the PATCHED
main-process bundle (.vite/build/index*.js), through every alias the
code-split bundle uses, and requires each one to be

  covered     the predicate's definition matches one of OUR injected shapes
              (`definitionShape` in the baseline), or its body only calls
              covered tracked predicates and `transitiveIgnore` callees; or the
              consumer sits inside one of OUR injected shapes listed in
              `coveredSites` (a regex with `@@` where the consumer's reference
              must be - this proves our term decides, unlike "a marker somewhere
              in the statement"; an entry with `decides: "opt-in"` is reported
              as opt-in-site: our term decides only while a user switch is on);
              or the consumer is inside another tracked
              predicate's definition (that predicate is checked in turn);
  derived     the consumer is the whole value of a chunk-level `NAME=<expr>` or
              the single `return <expr>` of a chunk-level function: NAME becomes
              a derived predicate and ITS consumers are enumerated with the same
              rules (`Z=!isWayland()` then `if(!Z)...` is caught);
  listed      matched by an `allowlist` entry keyed by a stable anchor (string
              literal, log tag or un-minified namespace name) inside the
              consumer's function, with a pinned consumer count, a verdict and
              a reason. Verdict `open` fails unless the entry names an `issue`.

It also fails on: a stale allowlist / coveredSites / envSites entry, a
predicate that resolves to 0 or more definitions than pinned, an unexplained
use of a tracked export key in a chunk that loads the defining chunk, and any
occurrence of the raw session tests (XDG_SESSION_TYPE, WAYLAND_DISPLAY,
XDG_CURRENT_DESKTOP, ozone-platform) outside a tracked definition, our own
injected code and the pinned `envSites` list - an inline copy of the test
would otherwise escape every predicate.

Aliases followed: local references in the defining chunk (shadowing by
parameters, let/const/var, for-let, catch and destructuring is respected);
export getters used through module bindings in other chunks -
`b=require("./D")`, `b=x.__toESM(require("./D"))`, function-local
`m=await Promise.resolve().then(()=>require("./D"))` / `await import("./D")`,
`{K:z}=require("./D")`, lazy `.then((e=>e.K))` / `((e)=>e.K)` /
`(function(e){return e.K})`, `require("./D").K`, `b.K`, `b?.K`, `b["K"]`;
namespace members by their un-minified name anywhere (`.m`, `["m"]`,
`{m:alias}` + every use of alias) and namespace re-exports.

WHAT IT CANNOT SEE: the ion-dist.asar SPA and the remote claude.ai web code
(neither is in .vite/build/index*.js); calls through a computed property
whose name is not a literal (`ns[k]()`); values passed through function
arguments (`f(b)` then `b.K` inside f is reported only when the receiver is
a binding of the defining chunk).

Usage:
  scripts/check-predicate-consumers.py [--baseline FILE] [--quiet] [--js-dir D] [--patches-dir D] <tree>
    <tree>  a PATCHED bundle: app.asar.contents/ (or its .vite/build/)
Exit: 0 = clean, 1 = failure, 2 = cannot run.

Allowlist, coveredSites, envSites and transitiveIgnore entries loosen this
gate: adding or widening one needs @patrickjaja in the commit. The baseline is
edited by hand on purpose; there is no --update mode.
"""

import argparse
import glob
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
DEFAULT_BASELINE = REPO / "baseline" / "predicate-consumers.json"
ID = rb"[\w$]+"
VERDICTS = {"intentional", "upstream-ok", "open"}
# The tracked set is part of the gate, not of the data: an emptied baseline fails.
REQUIRED_PREDICATES = {
    "isWaylandSession", "isOzoneWayland", "desktopEnvironment", "isBridgeComputerUsePlatform",
    "hasComputerUseExecutor", "isCuSupportedPlatform", "isComputerUseEnabled",
}
ENV_TOKENS = (b"XDG_SESSION_TYPE", b"WAYLAND_DISPLAY", b"XDG_CURRENT_DESKTOP", b"ozone-platform")
MAX_DERIVATION_DEPTH = 4
Q = rb"[\"'`]"
_ARROW_OR_FN = re.compile(rb"\(|async\b|function\b|[\w$]+=>")
_KEYWORDS = {b"if", b"for", b"while", b"switch", b"catch", b"return", b"typeof", b"function", b"new",
             b"await", b"void", b"delete", b"in", b"of", b"instanceof", b"do", b"else", b"with", b"yield"}


def die(msg):
    print(f"[ERROR] {msg}", file=sys.stderr)
    sys.exit(2)


def find_build_dir(tree):
    p = Path(tree)
    for cand in (p / ".vite" / "build", p / "app.asar.contents" / ".vite" / "build", p):
        if (cand / "index.js").is_file() or glob.glob(str(cand / "index.chunk-*.js")):
            return cand
    die(f"no .vite/build/index*.js under {tree}")


class Bundle:
    def __init__(self, build_dir):
        self.raw = {}
        for f in sorted(glob.glob(os.path.join(build_dir, "index*.js"))):
            with open(f, "rb") as fh:
                self.raw[os.path.basename(f)] = fh.read()
        if not self.raw:
            die(f"no index*.js in {build_dir}")
        self._lexed = {}
        self._req = {}
        self._scopes = {}
        self._mod = {}

    def lex(self, fn):
        c = self._lexed.get(fn)
        if c is None:
            c = L.Chunk(fn, self.raw[fn])
            self._lexed[fn] = c
        return c

    def requires(self, fn):
        """{target chunk: [names]} for chunk-level `X=require("./<chunk>")` (also
        wrapped once, e.g. `X=e.__toESM(require(...))`) in fn."""
        r = self._req.get(fn)
        if r is None:
            r = {}
            t = self.raw[fn]
            for m in _CHUNK_BIND.finditer(t):
                r.setdefault(m.group(2).decode(), set()).add(m.group(1))
            r = {k: sorted(v) for k, v in r.items()}
            self._req[fn] = r
        return r

    def chunk_of_binding(self, fn, bind):
        hits = [k for k, v in self.requires(fn).items() if bind in v]
        return hits[0] if len(hits) == 1 else None

    def export_getter_local(self, fn, key):
        pat = re.compile(rb'Object\.defineProperty\(exports,["`]' + re.escape(key) +
                         rb'["`],\{enumerable:!0,get:function\(\)\{return (' + ID + rb")\}\}\)")
        hits = {m.group(1) for m in pat.finditer(self.raw[fn])}
        return hits.pop() if len(hits) == 1 else None

    def export_keys(self, fn, local):
        pat = re.compile(rb'Object\.defineProperty\(exports,["`](' + ID +
                         rb')["`],\{enumerable:!0,get:function\(\)\{return ' + re.escape(local) + rb"\}\}\)")
        return [m.group(1) for m in pat.finditer(self.raw[fn])]


_CHUNK_BIND = re.compile(rb"(?<![\w$.])(" + ID + rb")=(?:[\w$.]+\()?require\(" + Q + rb"\./(index[^\"'`]*\.js)" + Q + rb"\)")


# ---------------------------------------------------------------- scoping
def scope_map(bundle, ch, bt):
    """Names declared by the function whose body `{` is token bt:
    {name: [(lo, hi)]} with the byte range where each declaration is visible."""
    key = (ch.name, bt)
    if key in bundle._scopes:
        return bundle._scopes[key]
    s = ch.s
    lo, hi = ch.block_span(bt)
    out = {}

    def add(names, a, b):
        for n in names:
            out.setdefault(n, []).append((a, b))

    info = ch.function_info(bt)
    if info:
        add(L.params_names(s[info[0]:info[1]]), info[0], hi)
    for kw in (b"let", b"const", b"var", b"function", b"class", b"catch"):
        i = s.find(kw, lo, hi)
        while i != -1:
            e = i + len(kw)
            ok = (s[i - 1] not in L._IDCH and s[i - 1] != 46) and (s[e:e + 1] in (b" ", b"{", b"[", b"("))
            if ok and not ch.in_literal(i):
                ef = ch.enclosing_function(i)
                if ef and ef[0] == bt:
                    _declare(ch, kw, i, e, bt, hi, add)
            i = s.find(kw, i + 1, hi)
    bundle._scopes[key] = out
    return out


def _declare(ch, kw, i, e, bt, fn_hi, add):
    s = ch.s
    if kw == b"catch":
        if s[e:e + 1] != b"(":
            return
        t = ch.tok_at(e)
        if t < 0:
            return
        close = ch.tpos[ch.match[t]]
        blk = ch.tok_at(close + 1)
        if blk >= 0:
            add(L.binding_names(s[e + 1:close]), e, ch.block_span(blk)[1])
        return
    if kw in (b"function", b"class"):
        m = re.match(rb" (" + ID + rb")", s[e:e + 80])
        if m:
            inner = next(iter(ch.enclosing_blocks(i)), None)
            a, b = ch.block_span(inner) if inner is not None else (0, len(s))
            add({m.group(1)}, a, b)
        return
    # let / const / var: declarator list
    end, commas = ch.list_end(e)
    parts, cur = [], e
    for c in commas:
        parts.append(s[cur:c])
        cur = c + 1
    parts.append(s[cur:end])
    names = set()
    for p in parts:
        p = re.split(rb" (?:of|in) ", p, maxsplit=1)[0]
        names |= L.binding_names(p)
    if kw == b"var":
        add(names, ch.block_span(bt)[0], fn_hi)
        return
    par = ch.enclosing_paren(i, bt)
    if par >= 0 and ch.paren_keyword(par) == "for":
        body_start = ch.after_group(par)
        bstart = body_start
        while bstart < len(s) and s[bstart] in b" \n\t":
            bstart += 1
        bt2 = ch.tok_at(bstart)
        hi = ch.block_span(bt2)[1] if bt2 >= 0 and s[bstart] == 123 else ch.statement_span(bstart)[1]
        add(names, ch.tpos[par], hi)
        return
    inner = next(iter(ch.enclosing_blocks(i)), None)
    a, b = ch.block_span(inner) if inner is not None else (0, len(s))
    add(names, a, b)


def is_shadowed(bundle, ch, pos, name):
    """True when `name` at pos resolves to a parameter or local declaration of an
    enclosing function (or concise arrow) rather than the chunk-level binding."""
    for bt, _ in ch.enclosing_functions(pos):
        for a, b in scope_map(bundle, ch, bt).get(name, ()):
            if a <= pos < b:
                return True
    # concise arrows `x=>...x...` / `(a,{x})=>...` have no block of their own
    a, _ = ch.statement_span(pos)
    seg = ch.s[a:pos]
    for m in re.finditer(rb"(?:\(([^()]*)\)|(?<![\w$.])(" + ID + rb"))=>(?!\{)", seg):
        if ch.in_literal(a + m.start()):
            continue
        params = m.group(1) if m.group(1) is not None else m.group(2)
        if name in L.params_names(params) and ch.statement_span(a + m.end())[1] >= pos:
            return True
    return False


# ---------------------------------------------------------------- predicates
class Pred:
    def __init__(self, spec, root=None):
        self.spec = spec
        self.id = spec["id"]
        self.root = root or self
        self.label = self.id
        f = spec.get("find", {})
        self.ns_key = f.get("namespaceKey")
        self.body_re = f.get("bodyRegex")
        self.prefilter = f.get("prefilter")
        self.expect = int(spec.get("expectDefinitions", 1))
        self.shapes = [re.compile(x.encode(), re.S) for x in spec.get("definitionShape", [])]
        self.tignore = [re.compile(x["calleeBody"].encode(), re.S) for x in spec.get("transitiveIgnore", [])]
        self.chunk = self.local = None
        self.def_at = None
        self.body = None
        self.error = None
        self.members = {}
        self.consumers = []
        self.direct = False
        self.covered = False
        self.deps = set()
        self.depth = 0
        self.derived = False


def validate_spec(spec):
    pid = spec.get("id")
    f = spec.get("find", {})
    if bool(f.get("namespaceKey")) == bool(f.get("bodyRegex")):
        die(f"predicate {pid}: give exactly one of find.namespaceKey / find.bodyRegex")
    if f.get("bodyRegex") and not f.get("prefilter"):
        die(f"predicate {pid}: find.bodyRegex needs find.prefilter")
    for x in spec.get("definitionShape", []):
        if not x.strip():
            die(f"predicate {pid}: empty definitionShape")
    for x in spec.get("transitiveIgnore", []):
        if not x.get("calleeBody", "").strip() or len(x.get("reason", "")) < 10:
            die(f"predicate {pid}: transitiveIgnore entries need calleeBody + reason")


def resolve_ns_ref(bundle, fn, ref):
    if b"." not in ref:
        return fn, ref
    b, k = ref.split(b".", 1)
    target = bundle.chunk_of_binding(fn, b)
    if not target or target not in bundle.raw:
        return None
    local = bundle.export_getter_local(target, k)
    return (target, local) if local else None


def def_location(bundle, fn, local):
    s = bundle.raw[fn]
    ch = bundle.lex(fn)
    hits = []
    for i in L.iter_ident(s, local):
        if s.startswith(b"function ", i - 9) and (i < 10 or s[i - 10] not in L._IDCH):
            if s.startswith(b"(", i + len(local)):
                hits.append(i - 9)
            continue
        e = i + len(local)
        if s[e:e + 1] == b"=" and s[i - 1:i] not in (b"=", b"!", b"<", b">") and _ARROW_OR_FN.match(s, e + 1):
            hits.append(i)
    hits = sorted({h for h in hits if not ch.in_literal(h)})
    if len(hits) != 1:
        return None, f"{len(hits)} definition sites for {local.decode()} in {fn}"
    return hits[0], None


def def_body_span(ch, at):
    """(start, end, body_start) of a definition at byte `at`; body_start is the
    `{` of a block body or the first byte of a concise arrow body."""
    s = ch.s
    m = re.compile(rb"function " + ID + rb"\(|" + ID + rb"=(?:async )?(?:function\b[^(]*\(|\(|(" + ID + rb")=>)").match(s, at)
    if not m:
        return None
    if m.group(1) is not None:
        p = m.end()
    else:
        t = ch.tok_at(m.end() - 1)
        if t < 0:
            return None
        p = ch.tpos[ch.match[t]] + 1
        if s.startswith(b"=>", p):
            p += 2
    while p < len(s) and s[p] in b" \t\n":
        p += 1
    if s[p:p + 1] == b"{":
        t = ch.tok_at(p)
        return (at, ch.tpos[ch.match[t]] + 1, p)
    return (at, ch.statement_span(p)[1], p)


def resolve(bundle, p):
    sites = set()
    if p.body_re:
        rx = re.compile(p.body_re.encode())
        pre = p.prefilter.encode()
        for fn, s in bundle.raw.items():
            i = s.find(pre)
            while i != -1:
                for m in rx.finditer(s, max(0, i - 400), i + 400):
                    sites.add((fn, m.group("name")))
                i = s.find(pre, i + 1)
    else:
        key = p.ns_key.encode()
        tail = re.compile(rb":\(\)=>(" + ID + rb"(?:\." + ID + rb")?)(?=[,}])")
        for fn, s in bundle.raw.items():
            if key not in s:
                continue
            ch = None
            for a in L.iter_ident(s, key):
                m = tail.match(s, a + len(key))
                if not m or s[a - 1:a] not in (b"{", b","):
                    continue
                ch = ch or bundle.lex(fn)
                if ch.in_literal(a):
                    continue
                r = resolve_ns_ref(bundle, fn, m.group(1))
                sites.add(r if r else (fn, b"?unresolved:" + m.group(1)))
        p.members[key] = "namespaceKey"
    if len(sites) != p.expect:
        p.error = (f"resolved {len(sites)} definitions {sorted((f, n.decode()) for f, n in sites)} - expected "
                   f"{p.expect}; re-audit the predicate (find / expectDefinitions in the baseline)")
        return [p]
    out = []
    for fn, local in sorted(sites):
        q = Pred(p.spec)
        q.members = dict(p.members)
        if p.expect > 1:
            q.label = f"{p.id}#{fn}"
        q.chunk, q.local = fn, local
        out.append(q)
        if local.startswith(b"?unresolved:"):
            q.error = f"namespace entry points at {local[12:].decode()} which does not resolve to an export"
            continue
        at, err = def_location(bundle, fn, local)
        if err:
            q.error = err
            continue
        q.def_at = at
        q.body = def_body_span(bundle.lex(fn), at)
        if not q.body:
            q.error = f"cannot delimit the definition body of {local.decode()} in {fn}@{at}"
    return out


def exported_as(data, name):
    """Un-minified namespace members that export the chunk-level `name`."""
    out = []
    tail = b":()=>" + name
    i = data.find(tail)
    while i != -1:
        e = i + len(tail)
        if data[e:e + 1] in (b",", b"}"):
            j = i
            while j > 0 and data[j - 1] in L._IDCH:
                j -= 1
            if data[j - 1:j] in (b"{", b","):
                out.append(data[j:i])
        i = data.find(tail, i + 1)
    return out


# ---------------------------------------------------------------- consumers
class Consumer:
    def __init__(self, pred, fn, pos, kind):
        self.pred, self.fn, self.pos, self.kind = pred, fn, pos, kind
        self.status = None
        self.entry = None


def module_regexes(target):
    t = re.escape(target)
    req = rb"(?:require|import)\(" + Q + rb"\./" + t + Q + rb"\)"
    mod = rb"(?:await )?(?:[\w$.]+\()?(?:Promise\.resolve\(\)\.then\(\(?\(\)=>)?" + req + rb"\)*"
    return {
        "req": re.compile(req),
        "mod": re.compile(mod),
        "bind": re.compile(rb"^(?:(?:const|let|var) )?(" + ID + rb")=" + mod + rb"$"),
        "destr": re.compile(rb"^(?:(?:const|let|var) )?\{([^{}]*)\}=" + mod + rb"$"),
        "inline": re.compile(req + rb"(?:\?\.|\.)(" + ID + rb")"),
    }


_LAZY_PARAM = re.compile(rb"\)*\.then\(\(?(?:\(?(" + ID + rb")\)?=>|function\((" + ID + rb")\)\{)")


def module_uses(bundle, fn, target_chunk):
    """How chunk fn holds the module object of target_chunk. A list of
    ("bind", name, lo, hi, chunk_level) - every `name.K` in [lo, hi) is a use;
    ("await", name, key, lo, hi) - `name=await <...>.then(m=>m.key)`: uses of name;
    ("destr", key, alias, after, lo, hi, chunk_level, site);
    ("inline", key, keypos, site); ("unknown", site). Cached."""
    ck = (fn, target_chunk)
    if ck in bundle._mod:
        return bundle._mod[ck]
    out = []
    t = bundle.raw[fn]
    target = target_chunk.encode()
    rx = module_regexes(target)
    c = None
    for mm in rx["req"].finditer(t):
        r = mm.start()
        c = c or bundle.lex(fn)
        if c.in_literal(r):
            continue
        a, b = c.statement_span(r)
        T = t[a:b]
        ef = c.enclosing_function(r)
        lo, hi = c.block_span(ef[0]) if ef else (0, len(t))
        chunk_level = ef is None
        lp = _LAZY_PARAM.match(t, mm.end())
        if lp:
            param = lp.group(1) or lp.group(2)
            bs = lp.end()
            if lp.group(2) is not None:
                bt = c.tok_at(bs - 1)
                blo, bhi = c.block_span(bt)
            else:
                while t[bs:bs + 1] in (b" ", b"("):
                    if t[bs:bs + 1] == b"(":
                        break
                    bs += 1
                if t[bs:bs + 1] == b"{":
                    blo, bhi = c.block_span(c.tok_at(bs))
                else:
                    blo, bhi = bs, c.statement_span(bs)[1]
            out.append(("bind", param, blo, bhi, False))
            body = t[blo:bhi].strip(b"{} ")
            if lp.group(2) is not None:
                body = re.sub(rb"^return ", b"", body).rstrip(b";")
            bm = re.fullmatch(re.escape(param) + rb"\.(" + ID + rb")", body)
            am = re.match(rb"^(?:(?:const|let|var) )?(" + ID + rb")=await ", T)
            if bm and am:
                out.append(("await", am.group(1), bm.group(1), b, hi))
            continue
        im = rx["inline"].match(t, r)
        if im:
            out.append(("inline", im.group(1), im.start(1), r))
            continue
        bm = rx["bind"].match(T)
        if bm:
            out.append(("bind", bm.group(1), lo, hi, chunk_level))
            continue
        dm = rx["destr"].match(T)
        if dm:
            for prop in L._split_top(dm.group(1), 44):
                kv = L._split_top(prop.strip(), 58)
                for alias in sorted(L.binding_names(b":".join(kv[1:]) if len(kv) > 1 else kv[0])):
                    out.append(("destr", kv[0].strip(), alias, b, lo, hi, chunk_level, a))
            continue
        if rx["mod"].fullmatch(T.strip()):
            # bare side-effect require, or an element of Promise.all([...]) destructured by position
            arr = c.enclosing_paren(r)
            j = c._tok_before(r)
            # find an enclosing `[` at this level: Promise.all([ ... ])
            k = j
            while k >= 0 and c.tch[k] not in (91, 123, 59):
                if c.tch[k] in L.CLOSERS:
                    k = c.match[k] - 1
                    continue
                k -= 1
            if k >= 0 and c.tch[k] == 91 and t[max(0, c.tpos[k] - 12):c.tpos[k]].endswith(b"Promise.all("):
                idx = sum(1 for q in range(k + 1, j + 1) if c.tch[q] == 44 and _same_level(c, k, q))
                sa, sb = c.statement_span(c.tpos[k] - 12)
                dm2 = re.match(rb"^(?:(?:const|let|var) ?)?\[([^\[\]]*)\]=await Promise\.all\(", t[sa:sb])
                if dm2:
                    names = L._split_top(dm2.group(1), 44)
                    if idx < len(names):
                        el = L._strip_default(names[idx].strip())
                        if el[:1] == b"{":
                            for prop in L._split_top(el[1:-1], 44):
                                kv = L._split_top(prop.strip(), 58)
                                for alias in sorted(L.binding_names(b":".join(kv[1:]) if len(kv) > 1 else kv[0])):
                                    out.append(("destr", kv[0].strip(), alias, sb, lo, hi, chunk_level, r))
                        else:
                            for nm in sorted(L.binding_names(el)):
                                out.append(("bind", nm, max(lo, sb), hi, chunk_level))
                    continue
                out.append(("unknown", r))
                continue
            continue
        out.append(("unknown", r))
    bundle._mod[ck] = out
    return out


def _same_level(c, open_tok, q):
    """True when token q sits directly inside the group opened at open_tok."""
    j = q - 1
    while j > open_tok:
        if c.tch[j] in L.CLOSERS:
            j = c.match[j] - 1
            continue
        if c.tch[j] in L.OPENERS:
            return False
        j -= 1
    return True


def module_object_check(bundle, target_chunk, problems):
    """Every require/import of a defining chunk must be a form the census follows."""
    target = target_chunk.encode()
    for fn, t in bundle.raw.items():
        if fn == target_chunk or target not in t:
            continue
        rx = module_regexes(target)
        if all(_simple_req(t, m) or _LAZY_PARAM.match(t, m.end()) for m in rx["req"].finditer(t)):
            continue
        for u in module_uses(bundle, fn, target_chunk):
            if u[0] == "unknown":
                problems.append(f"module object of {target_chunk} reaches code the census does not follow in {fn} "
                                f"at byte {u[1]}: {L.snippet(t, u[1])} - teach the census this form")


_SIMPLE_BEFORE = re.compile(rb"(?:^|[;,{}]|(?:const|let|var) )(?:" + ID + rb"=(?:[\w$.]+\()?)?$")
_LAZY_BEFORE = re.compile(rb"(?:^|[;,{}(\[]|(?:const|let|var) |return )(?:" + ID +
                          rb"=)?(?:await )?Promise\.resolve\(\)\.then\(\(?\(\)=>$")


def _simple_req(t, m):
    """`X=require("./D")` / `X=e.__toESM(require("./D"))` / bare `require("./D")` at statement level."""
    before = t[max(0, m.start() - 64):m.start()]
    after = t[m.end():m.end() + 2]
    if _SIMPLE_BEFORE.search(before) and (after[:1] in (b";", b",") or after in (b");", b"),")):
        return True
    # `X=await Promise.resolve().then(()=>require("./D"))` or one element of Promise.all([...])
    tail = t[m.end():m.end() + 4]
    return bool(_LAZY_BEFORE.search(before)) and re.match(rb"\)\)?\)?[;,\]]", tail) is not None and _lazy_target_ok(t, m)


def _lazy_target_ok(t, m):
    """The lazily loaded module object is bound to a plain name, or is a Promise.all element
    whose destructuring module_uses resolves; anything else goes through the full check."""
    before = t[max(0, m.start() - 80):m.start()]
    return bool(re.search(rb"(?:^|[;,{}]|(?:const|let|var) )" + ID + rb"=await Promise\.resolve", before))


def _namespace_object(c, pos):
    """True when pos sits in an object literal passed straight to a call
    (`X.r({name:()=>LOCAL,...})`, the bundler's namespace helper) - a plain object
    `{allowed:()=>W}` is a value someone may call dynamically, so it is a consumer."""
    blk = next(iter(c.enclosing_blocks(pos)), None)
    if blk is None:
        return False
    k = c._prev_sig(c.tpos[blk])
    return k >= 0 and c.s[k] == 40 and k > 0 and (c.s[k - 1] in L._IDCH)


def collect(bundle, p, keys_seen):
    """Enumerate p's consumers. keys_seen collects (chunk, key) explained uses for the backstop."""
    s = bundle.raw[p.chunk]
    ch = bundle.lex(p.chunk)
    out = []
    seen = set()

    def add(fn, pos, kind):
        if (fn, pos) not in seen:
            seen.add((fn, pos))
            out.append(Consumer(p, fn, pos, kind))

    keys = set(bundle.export_keys(p.chunk, p.local))
    p.keys = sorted(keys)
    for m in exported_as(s, p.local):
        p.members.setdefault(m, "namespace export")

    def classify_ref(fn, c, pos, ref_len, kind):
        src = c.s
        before = src[max(0, pos - 80):pos]
        m = re.search(rb"(?<=[{,])(" + ID + rb"):\(\)=>$", before)
        if m and src[pos + ref_len:pos + ref_len + 1] in (b",", b"}") and _namespace_object(c, pos):
            p.members.setdefault(m.group(1), f"namespace entry in {fn}")
            return
        if before.endswith(b"get:function(){return ") and src.startswith(b"}})", pos + ref_len):
            return
        add(fn, pos, kind)

    def alias_uses(fn, c, alias, after, scope_bt, kind, lo=None, hi=None, check_shadow=None):
        t = c.s
        if lo is None:
            lo, hi = c.block_span(scope_bt) if scope_bt is not None else (0, len(t))
        if check_shadow is None:
            check_shadow = scope_bt is None
        found = False
        for u in L.iter_ident(t, alias, lo=max(lo, after), hi=hi):
            if t[u + len(alias):u + len(alias) + 1] == b":" and t[u - 1:u] in (b"{", b","):
                continue
            if c.in_literal(u):
                continue
            if check_shadow and is_shadowed(bundle, c, u, alias):
                continue
            add(fn, u, kind)
            found = True
        return found

    # a. local references in the defining chunk
    for a in L.iter_ident(s, p.local):
        if p.def_at <= a < p.def_at + len(b"function ") + len(p.local):
            continue
        if ch.in_literal(a):
            continue
        e = a + len(p.local)
        if s[e:e + 1] == b":" and s[a - 1:a] in (b"{", b","):
            continue
        if is_shadowed(bundle, ch, a, p.local):
            continue
        classify_ref(p.chunk, ch, a, len(p.local), "local")

    # b. module bindings of the defining chunk in other chunks
    target = p.chunk.encode()
    for fn, t in bundle.raw.items():
        if fn == p.chunk or target not in t or not any(
                (b"." + k) in t or (b"[\"" + k) in t or (b"['" + k) in t or (b"[`" + k) in t or
                (b"{" + k) in t or (b"," + k) in t for k in keys):
            continue
        c = bundle.lex(fn)
        for u in module_uses(bundle, fn, p.chunk):
            if u[0] == "bind":
                _, b_name, lo, hi, chunk_level = u
                for k in sorted(keys):
                    for form in (b_name + b"." + k, b_name + b"?." + k, b_name + b"[\"" + k + b"\"]",
                                 b_name + b"['" + k + b"']", b_name + b"[`" + k + b"`]"):
                        i = t.find(form, lo, hi)
                        while i != -1:
                            e = i + len(form)
                            pre_ok = i == 0 or t[i - 1] not in L._IDCH and (t[i - 1] != 46 or t[i - 3:i] == b"...")
                            post_ok = form.endswith(b"]") or e >= len(t) or t[e] not in L._IDCH
                            if pre_ok and post_ok and not c.in_literal(i) and \
                                    not (chunk_level and is_shadowed(bundle, c, i, b_name)):
                                keys_seen.add((fn, e - len(k) - (2 if form.endswith(b"]") else 0)))
                                if form.endswith(b"]"):
                                    add(fn, i, "export alias (bracket)")
                                else:
                                    classify_ref(fn, c, i, len(form), "export alias")
                            i = t.find(form, i + 1, hi)
            elif u[0] == "await":
                _, name, k, lo, hi = u
                if k in keys:
                    alias_uses(fn, c, name, lo, None, f"lazy alias {name.decode()}", lo=lo, hi=hi,
                               check_shadow=False)
            elif u[0] == "inline":
                _, k, kp, site = u
                keys_seen.add((fn, kp))
                if k in keys:
                    add(fn, site, "inline require alias")
            elif u[0] == "destr":
                _, k, alias, after, lo, hi, chunk_level, site = u
                if k in keys:
                    if not alias_uses(fn, c, alias, after, None, f"destructured require {alias.decode()}",
                                      lo=lo, hi=hi, check_shadow=chunk_level):
                        add(fn, site, "destructured require (alias unused)")

    # c./d. namespace members by un-minified name (iterated: re-exports add members)
    done = set()
    while True:
        pending = sorted(k for k in p.members if k not in done)
        if not pending:
            break
        for member in pending:
            done.add(member)
            for fn, t in bundle.raw.items():
                if member not in t:
                    continue
                c = None
                for qch in (b'"', b"'", b"`"):
                    form = b"[" + qch + member + qch + b"]"
                    i = t.find(form)
                    while i != -1:
                        c = c or bundle.lex(fn)
                        if not c.in_literal(i):
                            add(fn, i, "namespace member (bracket)")
                        i = t.find(form, i + 1)
                for a in L.iter_ident(t, member, allow_member=True):
                    mend = a + len(member)
                    c = c or bundle.lex(fn)
                    if c.in_literal(a):
                        continue
                    after = t[mend:mend + 160]
                    prv = t[a - 1:a]
                    if after.startswith(b":()=>"):
                        ref = re.match(rb":\(\)=>(" + ID + rb"(?:\." + ID + rb")?)", after).group(1)
                        r = resolve_ns_ref(bundle, fn, ref)
                        if r != (p.chunk, p.local):
                            add(fn, a, "namespace entry pointing elsewhere")
                        continue
                    if prv == b".":
                        add(fn, a, "namespace member")
                        continue
                    al = re.match(rb":(" + ID + rb")(?=[,}=])", after)
                    if al and prv in (b"{", b","):
                        alias = al.group(1)
                        ef = c.enclosing_function(a)
                        if not alias_uses(fn, c, alias, mend + 1 + len(alias), ef[0] if ef else None,
                                          f"destructured alias {alias.decode()}"):
                            add(fn, a, "destructured (alias unused)")
                        continue
                    if fn == p.chunk and a == p.def_at:
                        continue
                    add(fn, a, "member name")
    p.consumers = out


# ---------------------------------------------------------------- derivation
def derive(bundle, c):
    """If consumer c is the whole value of a chunk-level `NAME=<expr>` or the single
    `return <expr>` of a chunk-level function, return (name, def_at, body)."""
    ch = bundle.lex(c.fn)
    s = ch.s
    a, b = ch.statement_span(c.pos)
    ef = ch.enclosing_function(c.pos)
    if _in_call_args(ch, c.pos, a):
        return None  # passed to another function: its result is not ours to follow
    m0 = re.match(rb"[\w$]+(?:\??\.[\w$]+)?", s[c.pos:c.pos + 120])
    after = s[c.pos + (m0.end() if m0 else 0):c.pos + (m0.end() if m0 else 0) + 2]
    called = after[:1] == b"(" or after == b"?." or getattr(c.pred, "is_value", False)
    if not called:
        # a bare reference is followed only as a pure alias: `NAME=<ref>`
        if not (ef is None and re.fullmatch(rb"(?:(?:var|let|const) )?" + ID + rb"=[\w$]+(?:\??\.[\w$]+)?", s[a:b])):
            return None
    if ef is None:
        m = re.match(rb"(?:(?:var|let|const) )?(" + ID + rb")=(?![=>])", s[a:b])
        if m and c.pos >= a + m.end():
            return m.group(1), a + m.start(1), (a + m.start(1), b, a + m.end())
        return None
    bt, info = ef
    lo, hi = ch.block_span(bt)
    if not s.startswith(b"return", lo + 1) or ch.enclosing_function(lo) is not None:
        return None
    sa, sb = ch.statement_span(lo + 7)
    if sa != lo + 1 or sb != hi - 1 or ch.statement_span(c.pos) != (sa, sb):
        return None  # not the single `return <expr>`, or the consumer is nested in an object/array/argument
    head = s[max(0, info[0] - 80):info[0] - 1]
    m = re.search(rb"(?:function (" + ID + rb")|(?<![\w$.])(" + ID + rb")=(?:async ?)?(?:function)?)$", head)
    if not m:
        return None
    name = m.group(1) or m.group(2)
    start = info[0] - 1 - len(head) + m.start()
    return name, (start if m.group(1) else start), (start, hi, lo)


def _in_call_args(ch, pos, stmt_start):
    """True when pos is inside the argument list of a call (an unmatched `(` right
    after an identifier, `)` or `]`) within its statement."""
    j = ch._tok_before(pos)
    while j >= 0 and ch.tpos[j] >= stmt_start:
        c = ch.tch[j]
        if c in L.CLOSERS:
            j = ch.match[j] - 1
            continue
        if c == 40:
            k = ch._prev_sig(ch.tpos[j])
            if k >= 0 and (ch.s[k] in L._IDCH or ch.s[k] in (41, 93)):
                w = re.search(rb"[\w$]+$", ch.s[max(0, k - 12):k + 1])
                if not (w and w.group(0) in (b"return", b"typeof", b"void", b"await", b"in", b"of", b"case")):
                    return True
        j -= 1
    return False


# ---------------------------------------------------------------- main
def load_baseline(path, fixture=False):
    try:
        with open(path, "rb") as fh:
            base = json.loads(fh.read())
    except (OSError, ValueError) as e:
        die(f"cannot read baseline {path}: {e}")
    specs = base.get("predicates", [])
    ids = {x.get("id") for x in specs}
    missing = REQUIRED_PREDICATES - ids
    if missing and not fixture:
        die(f"baseline lacks required predicate(s) {sorted(missing)} - the tracked set is part of the gate")
    for x in specs:
        validate_spec(x)
    for i, e in enumerate(base.get("allowlist", [])):
        for f in ("predicate", "consumers", "verdict", "reason"):
            if f not in e:
                die(f"allowlist[{i}] lacks '{f}'")
        if ("anchor" in e) == ("anchorRegex" in e):
            die(f"allowlist[{i}] needs exactly one of 'anchor' / 'anchorRegex'")
        if not (e.get("anchor") or e.get("anchorRegex") or "").strip():
            die(f"allowlist[{i}] has an empty anchor")
        if e["predicate"] not in ids:
            die(f"allowlist[{i}] names unknown predicate {e['predicate']!r}")
        if e["verdict"] not in VERDICTS:
            die(f"allowlist[{i}] verdict {e['verdict']!r} not one of {sorted(VERDICTS)}")
        if e.get("scope", "function") not in ("function", "statement"):
            die(f"allowlist[{i}] scope must be function|statement")
        e["_label"] = (e.get("anchor") or "re:" + e["anchorRegex"]) + (f" via {e['via']}" if e.get("via") else "")
        e["_rx"] = re.compile(e["anchorRegex"].encode()) if "anchorRegex" in e else None
    for i, e in enumerate(base.get("coveredSites", [])):
        for f in ("predicate", "shape", "consumers", "reason"):
            if f not in e:
                die(f"coveredSites[{i}] lacks '{f}'")
        if e["shape"].count("@@") != 1:
            die(f"coveredSites[{i}] shape must contain '@@' (the consumer's reference) exactly once")
        if e["predicate"] not in ids:
            die(f"coveredSites[{i}] names unknown predicate {e['predicate']!r}")
        if e.get("decides", "always") not in ("always", "opt-in"):
            die(f"coveredSites[{i}] decides must be 'always' or 'opt-in'")
        pre, post = e["shape"].split("@@")
        e["_rx"] = re.compile(pre.encode() + rb"(?P<site>[\w$]+(?:\??\.[\w$]+)?)" + post.encode(), re.S)
    for i, e in enumerate(base.get("envSites", [])):
        for f in ("token", "count", "reason"):
            if f not in e:
                die(f"envSites[{i}] lacks '{f}'")
        if ("anchor" in e) == ("anchorRegex" in e):
            die(f"envSites[{i}] needs exactly one of 'anchor' / 'anchorRegex'")
        e["_label"] = e.get("anchor") or "re:" + e["anchorRegex"]
        e["_rx"] = re.compile(e["anchorRegex"].encode()) if "anchorRegex" in e else None
    return base


def via_matches(e, p):
    """An entry without `via` lists the root predicate's own consumers; `via: "derived"`
    any derived value's consumers; `via: "<NAME>"` those of the derived value exported
    under that un-minified name."""
    via = e.get("via")
    if via is None:
        return not p.derived
    if via == "derived":
        return p.derived
    return p.derived and p.label.rsplit(">", 1)[-1] == via


def scope_text(ch, pos, scope):
    """Anchor search text for pos: its function (or statement at chunk level),
    plus the un-minified namespace names of the chunk-level declarator / named
    function holding it."""
    s = ch.s
    a, b = ch.statement_span(pos)
    ef = ch.enclosing_function(pos)
    if scope == "statement":
        lo, hi = a, b
    elif ef:
        lo, hi = ch.block_span(ef[0])
    else:
        lo, hi = ch.top_statement(pos)  # chunk level: the whole `;` statement
    nm = None
    if not ef:
        dm = re.match(rb"(?:(?:var|let|const) )?(" + ID + rb")=", s[a:b])
        nm = dm.group(1) if dm else None
    else:
        head = s[max(0, ef[1][0] - 80):ef[1][0] - 1]
        dm = re.search(rb"(?:function (" + ID + rb")|(?<![\w$.])(" + ID + rb")=(?:async ?)?)$", head)
        if dm:
            nm = dm.group(1) or dm.group(2)
    text = s[lo:hi]
    if nm:
        exp = exported_as(s, nm)
        if exp:
            text += b"\0" + b"\0".join(exp)
    return text


def main():
    ap = argparse.ArgumentParser(
        description="Fail when an upstream Linux-session predicate has a consumer that our patches "
                    "neither cover nor list in the allowlist (issue #323 class).",
        epilog="Exit 0 = clean, 1 = failure, 2 = cannot run. Allowlist / coveredSites / envSites / "
               "transitiveIgnore entries need @patrickjaja in the commit.")
    ap.add_argument("tree", help="PATCHED app.asar.contents/ (or its .vite/build/)")
    ap.add_argument("--baseline", default=str(DEFAULT_BASELINE), help="pinned predicates + allowlist JSON")
    ap.add_argument("--quiet", action="store_true", help="print only failures and the summary")
    ap.add_argument("--js-dir", default=str(REPO / "js"), help="our injected js/ sources ('' for none)")
    ap.add_argument("--patches-dir", default=str(REPO / "patches"), help="our .nim patches ('' for none)")
    ap.add_argument("--fixture", action="store_true", help=argparse.SUPPRESS)  # test harness: partial predicate set
    args = ap.parse_args()
    t0 = time.time()

    base = load_baseline(args.baseline, args.fixture)
    allow = base.get("allowlist", [])
    covered_sites = base.get("coveredSites", [])
    env_sites = base.get("envSites", [])
    specs = [Pred(x) for x in base["predicates"]]
    problems = []
    keys_seen = set()

    bundle = Bundle(find_build_dir(args.tree))
    try:
        preds = [q for p in specs for q in resolve(bundle, p)]
        live = [p for p in preds if not p.error]
        for p in live:
            collect(bundle, p, keys_seen)
    except L.LexError as e:
        die(f"lexer: {e}")

    # direct coverage: the definition matches one of OUR injected shapes
    for p in live:
        body = bundle.raw[p.chunk][p.body[2]:p.body[1]]
        p.direct = any(r.match(body) for r in p.shapes)
    # consumers inside another tracked predicate's definition
    for p in live:
        for c in p.consumers:
            for q in live:
                if q is not p and c.fn == q.chunk and q.body[0] <= c.pos < q.body[1]:
                    c.status = f"inside:{q.label}"
                    q.deps.add(p.label)
    # transitive: every call in the body is a covered tracked predicate or an ignored callee
    by_local = {(p.chunk, p.local): p for p in live}
    for p in live:
        p.covered = p.direct
    changed = True
    while changed:
        changed = False
        for p in live:
            if p.covered or not p.deps:
                continue
            ch = bundle.lex(p.chunk)
            body = ch.s[p.body[2]:p.body[1]]
            ok, any_cov = True, False
            if re.search(rb"[\w$)\]]\??\.(" + ID + rb")\(", body):
                ok = False  # a member call: not a pure predicate composition
            for m in re.finditer(rb"(?<![\w$.])(" + ID + rb")\(", body):
                nm = m.group(1)
                if nm in _KEYWORDS:
                    continue
                q = by_local.get((p.chunk, nm))
                if q is not None and q is not p:
                    if q.covered:
                        any_cov = True
                        continue
                    ok = False
                    break
                at, err = def_location(bundle, p.chunk, nm)
                cb = def_body_span(ch, at) if at is not None else None
                cbody = ch.s[cb[2]:cb[1]] if cb else b""
                if not (cb and any(r.match(cbody) for r in p.tignore)):
                    ok = False
                    break
            if ok and any_cov:
                # nothing but those calls and boolean operators may decide the result
                rest = re.sub(rb"(?<![\w$.])" + ID + rb"\((?:[^()]|\([^()]*\))*\)", b"", body)
                if not re.fullmatch(rb"\{?\s*(?:return)?[\s!&|()]*;?\s*\}?", rest):
                    ok = False
            if ok and any_cov:
                p.covered = True
                changed = True

    # per-consumer verdicts, following derived values
    entry_hits = {i: [] for i in range(len(allow))}
    site_hits = {i: [] for i in range(len(covered_sites))}
    visited = {(p.chunk, p.local) for p in live}
    work = list(live)
    all_preds = list(live)
    while work:
        p = work.pop(0)
        for c in p.consumers:
            if c.status:
                continue
            if p.covered:
                c.status = "covered-def"
                continue
            ch = bundle.lex(c.fn)
            ef = ch.enclosing_function(c.pos)
            lo, hi = ch.block_span(ef[0]) if ef else ch.statement_span(c.pos)
            hit = None
            for i, e in enumerate(covered_sites):
                if e["predicate"] != p.root.id:
                    continue
                for m in e["_rx"].finditer(ch.s, max(0, lo - 200), hi):
                    if m.start("site") == c.pos:
                        hit = i
                        break
                if hit is not None:
                    break
            if hit is not None:
                # `decides: opt-in`: our term decides only while a user switch is on; with it off
                # upstream's own path runs by design - pinned to our exact shape, but not "covered"
                c.status = "opt-in-site" if covered_sites[hit].get("decides") == "opt-in" else "covered-site"
                c.entry = ("site", hit)
                site_hits[hit].append(c)
                continue
            d = derive(bundle, c)
            if d:
                name, def_at, body = d
                key = (c.fn, name)
                c.status = "derived"
                if key in visited:
                    c.status = "derived (seen)"
                    continue
                visited.add(key)
                if p.depth + 1 > MAX_DERIVATION_DEPTH:
                    c.status = "FAIL"
                    c.kind += f"; derivation deeper than {MAX_DERIVATION_DEPTH}"
                    continue
                q = Pred(p.root.spec, root=p.root)
                q.derived = True
                q.depth = p.depth + 1
                q.chunk, q.local, q.def_at, q.body = c.fn, name, def_at, body
                # a value (`Z=!W()`), not a function: reading it is using it
                q.is_value = not re.match(rb"(?:async )?(?:function\b|\([^()]*\)=>|[\w$]+=>)",
                                          bundle.raw[c.fn][body[2]:body[2] + 200]) and \
                    not bundle.raw[c.fn].startswith(b"function ", def_at) and \
                    bundle.raw[c.fn][body[2]:body[2] + 1] != b"{"
                exp = exported_as(bundle.raw[c.fn], name)
                q.label = f"{p.label}>{(exp[0] if exp else name).decode()}"
                collect(bundle, q, keys_seen)
                if q.consumers:
                    c.status = f"derived:{q.label}"
                    for cc in q.consumers:
                        for t in live:
                            if cc.fn == t.chunk and t.body[0] <= cc.pos < t.body[1]:
                                cc.status = f"inside:{t.label}"
                    all_preds.append(q)
                    work.append(q)
                    continue
                # nothing reads the derived value: the site itself must be covered or listed
                visited.discard(key)
                c.status = None
            for i, e in enumerate(allow):
                if e["predicate"] != p.root.id or not via_matches(e, p):
                    continue
                text = scope_text(ch, c.pos, e.get("scope", "function"))
                ok = e["_rx"].search(text) if e["_rx"] else e["anchor"].encode() in text
                if ok:
                    c.status = "allow:" + e["verdict"]
                    c.entry = ("allow", i)
                    entry_hits[i].append(c)
                    break
            else:
                c.status = "FAIL"

    for i, e in enumerate(allow):
        n = len(entry_hits[i])
        if n == 0:
            problems.append(f"stale allowlist entry [{e['predicate']}] anchor {e['_label']!r}: matches no consumer "
                            f"- the site moved or was removed; re-audit and fix or drop the entry")
        elif n != e["consumers"]:
            sites = ", ".join(f"{c.fn}@{c.pos}" for c in entry_hits[i])
            problems.append(f"allowlist entry [{e['predicate']}] anchor {e['_label']!r} pins {e['consumers']} "
                            f"consumer(s) but matches {n} ({sites}) - a consumer was added or removed there; re-audit")
        if e["verdict"] == "open" and not str(e.get("issue", "")).strip():
            problems.append(f"allowlist entry [{e['predicate']}] anchor {e['_label']!r} is verdict 'open' without "
                            f"an 'issue' - decide it (intentional / upstream-ok, or patch it), or track it in an issue")
    for i, e in enumerate(covered_sites):
        n = len(site_hits[i])
        if n != e["consumers"]:
            problems.append(f"coveredSites entry [{e['predicate']}] shape {e['shape'][:80]!r} pins {e['consumers']} "
                            f"consumer(s) but covers {n} - our injection moved or the site changed; re-audit")

    for dchunk in sorted({p.chunk for p in all_preds}):
        module_object_check(bundle, dchunk, problems)

    # backstop: every use of a tracked export key in a chunk that loads its chunk is explained
    consumer_pos = {(c.fn, c.pos) for p in all_preds for c in p.consumers}
    for p in all_preds:
        target = p.chunk.encode()
        for fn, t in bundle.raw.items():
            if fn == p.chunk or target not in t:
                continue
            if not any((b"." + k) in t or (b"['" + k) in t or (b'["' + k) in t for k in getattr(p, "keys", [])):
                continue
            c = bundle.lex(fn)
            other = {b for k, v in bundle.requires(fn).items() if k != p.chunk for b in v}
            for k in getattr(p, "keys", []):
                for form in (b"." + k, b'["' + k + b'"]', b"['" + k + b"']"):
                    i = t.find(form)
                    while i != -1:
                        e = i + len(form)
                        kpos = i + (1 if form[0] == 46 else 2)
                        if (form[0] != 46 or e >= len(t) or t[e] not in L._IDCH) and not c.in_literal(i) \
                                and not t[i - 2:i + 1] == b"...":
                            j = i - (1 if t[i - 1:i] == b"?" else 0)
                            r0 = j
                            while r0 > 0 and t[r0 - 1] in L._IDCH:
                                r0 -= 1
                            recv = t[r0:j]
                            explained = (fn, kpos) in keys_seen or (fn, r0) in consumer_pos or \
                                (recv in other and not is_shadowed(bundle, c, r0, recv)) or \
                                (recv and is_shadowed(bundle, c, r0, recv))  # a local of that name, not a module
                            if not explained:
                                problems.append(f"unexplained use of export key {k.decode()} (of {p.label}) in {fn} at "
                                                f"byte {i}: {L.snippet(t, i)} - an alias form this census does not "
                                                f"follow; teach it, or patch the predicate at its definition")
                        i = t.find(form, i + 1)

    # session-test census: raw env/switch tests outside tracked definitions
    ours = L.OurSources(args.js_dir or None, args.patches_dir or None)
    env_hits = {i: [] for i in range(len(env_sites))}
    defs = [(p.chunk, p.body[0], p.body[1]) for p in live]
    n_ours = 0
    for fn, t in bundle.raw.items():
        for tok in ENV_TOKENS:
            i = t.find(tok)
            while i != -1:
                if any(fn == f and a <= i < b for f, a, b in defs):
                    i = t.find(tok, i + 1)
                    continue
                if ours.owns(t, i, len(tok)):
                    n_ours += 1
                    i = t.find(tok, i + 1)
                    continue
                ch = bundle.lex(fn)
                matched = False
                for k, e in enumerate(env_sites):
                    if e["token"].encode() != tok:
                        continue
                    text = scope_text(ch, i, e.get("scope", "function"))
                    if (e["_rx"].search(text) if e["_rx"] else e["anchor"].encode() in text):
                        env_hits[k].append((fn, i))
                        matched = True
                        break
                if not matched:
                    problems.append(f"raw session test {tok.decode()} outside every tracked predicate in {fn} at byte "
                                    f"{i}: {L.snippet(t, i)} - an inline copy of the test escapes the census; track "
                                    f"it as a predicate, patch it, or pin it in envSites with a reason")
                i = t.find(tok, i + 1)
    for k, e in enumerate(env_sites):
        if len(env_hits[k]) != e["count"]:
            problems.append(f"envSites entry {e['token']} {e['_label']!r} pins {e['count']} occurrence(s) but "
                            f"matches {len(env_hits[k])} - re-audit")

    # ------------------------------------------------------------ report
    def row(c):
        name = c.status
        if c.entry:
            kind, i = c.entry
            name += f" [{allow[i]['_label'] if kind == 'allow' else 'site#' + str(i)}]"
        return f"   {name:<46} {c.fn}@{c.pos} ({c.kind})"

    fails = []
    for p in preds + [q for q in all_preds if q.derived]:
        if p.error:
            problems.append(f"predicate {p.label}: {p.error}")
            print(f"=== {p.label}: UNRESOLVED - {p.error}")
            continue
        if p.derived:
            cov = "derived value"
        else:
            cov = "direct" if p.direct else ("transitive via " + ",".join(sorted(p.deps)) if p.covered else "no")
        keys = ",".join(k.decode() for k in getattr(p, "keys", [])) or "-"
        mem = ",".join(sorted(m.decode() for m in p.members)) or "-"
        print(f"=== {p.label}: {p.local.decode()} in {p.chunk}@{p.def_at}; definition covered: {cov}; "
              f"export keys: {keys}; namespace members: {mem}; consumers: {len(p.consumers)}")
        for c in sorted(p.consumers, key=lambda c: (c.fn, c.pos)):
            if c.status == "FAIL":
                fails.append(c)
            if not args.quiet or c.status == "FAIL":
                print(row(c))
                if not args.quiet:
                    print(f"        {L.snippet(bundle.raw[c.fn], c.pos)}")

    tally = Counter(c.status.split(":")[0] if c.status.startswith(("inside", "derived")) else c.status
                    for p in all_preds for c in p.consumers)
    total = sum(len(p.consumers) for p in all_preds)
    print("")
    print(f"[predicate-census] {len(live)} definitions of {len(specs)} predicates, "
          f"{len(all_preds) - len(live)} derived values, {total} consumers: "
          + ", ".join(f"{k} {v}" for k, v in sorted(tally.items()))
          + f"; raw session tests: {sum(len(v) for v in env_hits.values())} pinned, {n_ours} ours"
          + f"  ({time.time() - t0:.1f}s)")

    if fails or problems:
        print("")
        for c in fails:
            print(f"[FAIL] {c.pred.label}: uncovered consumer in {c.fn} at byte {c.pos} ({c.kind}):")
            print(f"       {L.snippet(bundle.raw[c.fn], c.pos)}")
        for msg in problems:
            print(f"[FAIL] {msg}")
        print("")
        print("What to do: patch the predicate at its DEFINITION (preferred; covers every alias) and pin that shape "
              "in definitionShape; or pin our exact injection around the consumer in coveredSites; or - if "
              "upstream's behaviour is right on Linux - add an allowlist entry keyed by a stable string near the "
              "site, with verdict + reason, in baseline/predicate-consumers.json. A new or widened entry loosens "
              "this gate and needs @patrickjaja in the commit.")
        return 1
    print("[predicate-census] OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

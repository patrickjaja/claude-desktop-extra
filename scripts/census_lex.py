"""Minimal structural lexer for the minified main-process bundle chunks.

Shared by scripts/check-predicate-consumers.py and scripts/check-refusal-strings.py.
It does not parse JavaScript. It finds, in one pass over a chunk's bytes:

  * the structural tokens  ( ) [ ] { } ; ,  outside literals, each with the
    index of its matching bracket, plus `${` template-expression openers ("$");
  * every literal span: "..." / '...' strings, whole `...` template literals
    (with their `${...}` expression spans), regex literals and comments.

That is enough to answer "which statement / function / literal encloses byte
offset X" without loose character windows. A chunk whose brackets do not
balance at EOF means the lexer lost sync (a regex literal mistaken for a
division or the reverse); that raises LexError so the calling check fails
loud instead of reporting on a misread chunk.

Python stdlib only; operates on bytes.
"""

import bisect
import re

_SIG = re.compile(rb"[\"'`/{}()\[\];,]")
_SIG_LIT = re.compile(rb"[\"'`/{}()]")
_STR_D = re.compile(rb'"(?:[^"\\\n]|\\.)*"', re.S)
_STR_S = re.compile(rb"'(?:[^'\\\n]|\\.)*'", re.S)
_TPL = re.compile(rb"(?:[^`\\$]|\\.|\$(?!\{))*", re.S)
_RX = re.compile(rb"/(?:[^/\\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+/[A-Za-z]*")
_WORD_BEFORE = re.compile(rb"[\w$]+$")
_RX_KEYWORDS = {
    b"return", b"typeof", b"case", b"in", b"of", b"void", b"delete", b"throw",
    b"new", b"else", b"do", b"instanceof", b"yield", b"await",
}
_RX_PREV = frozenset(b"(,=:[!&|?{};+-*%<>~^")
_WS = frozenset(b" \t\r\n")
CONTROL_KEYWORDS = {b"if", b"for", b"while", b"switch", b"catch", b"with"}
_REGEX_AFTER_PAREN = {b"if", b"for", b"while", b"with"}

OPENERS = frozenset(b"([{$")
CLOSERS = frozenset(b")]}")


class LexError(Exception):
    pass


class Chunk:
    """Lexed view of one chunk file."""

    def __init__(self, name, data, literals_only=False):
        """literals_only: record literal spans only (no structural tokens) -
        about twice as fast; enough for literal_at()/in_literal()."""
        self.name = name
        self.s = data
        self.tpos = []    # token byte offsets
        self.tch = []     # token chars (ints); ord("$") marks a `${` opener
        self.match = []   # partner token index for brackets, -1 otherwise
        self.lit = []     # literal spans (start, end, kind) sorted by start
        self.tpl_expr = {}  # template literal start -> [(expr_start, expr_end)]
        if literals_only:
            self._lex_literals()
        else:
            self._lex()
        self._build_segments()

    def _regex_at(self, p, open_of_close):
        """True when the `/` at p starts a regex literal, judged by the previous
        significant token. open_of_close(k) gives the offset of the `(` that
        matches the `)` at k (or -1), so `if(a)/re/` is a regex while
        `f(a)/2` is a division."""
        s = self.s
        k = p - 1
        while k >= 0 and s[k] in _WS:
            k -= 1
        prev = s[k] if k >= 0 else 59
        if prev == 41:  # `)`
            o = open_of_close(k)
            if o < 0:
                return False
            q = o - 1
            while q >= 0 and s[q] in _WS:
                q -= 1
            w = _WORD_BEFORE.search(s, max(0, q - 12), q + 1) if q >= 0 else None
            return bool(w) and w.group(0) in _REGEX_AFTER_PAREN and (w.start() == 0 or s[w.start() - 1] != 46)
        if prev in (43, 45) and k > 0 and s[k - 1] == prev:
            # `++` / `--`: postfix after an operand (division follows), prefix otherwise
            q = k - 2
            while q >= 0 and s[q] in _WS:
                q -= 1
            return not (q >= 0 and (s[q] in _IDCH or s[q] in (41, 93)))
        if prev in _RX_PREV:
            return True
        if prev in _IDCH:
            w = _WORD_BEFORE.search(s, max(0, k - 12), k + 1)
            if not w or w.group(0) not in _RX_KEYWORDS:
                return False
            # `x.return/2`: a property named like a keyword is an operand
            return w.start() == 0 or s[w.start() - 1] != 46
        return False

    def _lex_literals(self):
        s = self.s
        n = len(s)
        lit = self.lit
        sig = _SIG_LIT
        stack = []   # 0 = plain `{`, else template start offset + 1 for a `${`
        parens = []  # open-paren offsets
        last_close = [-1, -1]  # offset of the latest `)` and of its `(`

        def scan_template(j, start):
            while True:
                m = _TPL.match(s, j)
                j = m.end()
                if j >= n:
                    raise LexError(f"{self.name}: unterminated template literal at {start}")
                if s[j] == 96:
                    lit.append((start, j + 1, "template"))
                    return j + 1
                stack.append(start + 1)
                self.tpl_expr.setdefault(start, []).append([j + 2, -1])
                return j + 2

        i = 0
        while True:
            m = sig.search(s, i)
            if not m:
                break
            p = m.start()
            c = s[p]
            if c == 34 or c == 39:
                mm = (_STR_D if c == 34 else _STR_S).match(s, p)
                if not mm:
                    raise LexError(f"{self.name}: unterminated string at {p}")
                lit.append((p, mm.end(), "string"))
                i = mm.end()
            elif c == 96:
                i = scan_template(p + 1, p)
            elif c == 47:
                nx = s[p + 1] if p + 1 < n else 0
                if nx == 47:
                    e = s.find(b"\n", p)
                    e = n if e < 0 else e
                    lit.append((p, e, "comment"))
                    i = e
                elif nx == 42:
                    e = s.find(b"*/", p + 2)
                    e = n if e < 0 else e + 2
                    lit.append((p, e, "comment"))
                    i = e
                else:
                    mm = _RX.match(s, p) if self._regex_at(p, lambda k: last_close[1] if last_close[0] == k else -1) else None
                    if mm:
                        lit.append((p, mm.end(), "regex"))
                        i = mm.end()
                    else:
                        i = p + 1
            elif c == 40:
                parens.append(p)
                i = p + 1
            elif c == 41:
                if not parens:
                    raise LexError(f"{self.name}: unbalanced ')' at {p}")
                last_close[0] = p
                last_close[1] = parens.pop()
                i = p + 1
            elif c == 123:
                stack.append(0)
                i = p + 1
            else:  # 125
                if not stack:
                    raise LexError(f"{self.name}: unbalanced '}}' at {p}")
                top = stack.pop()
                if top:
                    start = top - 1
                    self.tpl_expr[start][-1][1] = p
                    i = scan_template(p + 1, start)
                else:
                    i = p + 1
        if stack or parens:
            raise LexError(f"{self.name}: {len(stack)} unclosed brace(s), {len(parens)} paren(s) - lexer lost sync")
        lit.sort()

    # ------------------------------------------------------------ lexing
    def _lex(self):
        s = self.s
        n = len(s)
        tpos, tch, match, lit = self.tpos, self.tch, self.match, self.lit
        stack = []        # token indices of open brackets
        tpl_stack = []    # template literal start offsets, parallel to "$" openers
        i = 0

        def open_of_close(k):
            if tpos and tpos[-1] == k and match[-1] >= 0:
                return tpos[match[-1]]
            return -1

        def scan_template(j, start):
            # j points just after a backtick or a closing `}` of `${`
            while True:
                m = _TPL.match(s, j)
                j = m.end()
                if j >= n:
                    raise LexError(f"{self.name}: unterminated template literal at {start}")
                if s[j] == 96:  # closing backtick
                    lit.append((start, j + 1, "template"))
                    return j + 1
                # `${`
                k = len(tpos)
                tpos.append(j)
                tch.append(36)
                match.append(-1)
                stack.append(k)
                tpl_stack.append(start)
                self.tpl_expr.setdefault(start, []).append([j + 2, -1])
                return j + 2

        while True:
            m = _SIG.search(s, i)
            if not m:
                break
            p = m.start()
            c = s[p]
            if c == 34 or c == 39:
                mm = (_STR_D if c == 34 else _STR_S).match(s, p)
                if not mm:
                    raise LexError(f"{self.name}: unterminated string at {p}")
                lit.append((p, mm.end(), "string"))
                i = mm.end()
                continue
            if c == 96:
                i = scan_template(p + 1, p)
                continue
            if c == 47:  # '/'
                nx = s[p + 1] if p + 1 < n else 0
                if nx == 47:
                    e = s.find(b"\n", p)
                    e = n if e < 0 else e
                    lit.append((p, e, "comment"))
                    i = e
                    continue
                if nx == 42:
                    e = s.find(b"*/", p + 2)
                    e = n if e < 0 else e + 2
                    lit.append((p, e, "comment"))
                    i = e
                    continue
                is_rx = self._regex_at(p, open_of_close)
                if is_rx:
                    mm = _RX.match(s, p)
                    if mm:
                        lit.append((p, mm.end(), "regex"))
                        i = mm.end()
                        continue
                i = p + 1
                continue
            if c == 125 and stack and tch[stack[-1]] == 36:
                # end of a `${...}` template expression
                o = stack.pop()
                k = len(tpos)
                tpos.append(p)
                tch.append(c)
                match.append(o)
                match[o] = k
                start = tpl_stack.pop()
                self.tpl_expr[start][-1][1] = p
                i = scan_template(p + 1, start)
                continue
            k = len(tpos)
            tpos.append(p)
            tch.append(c)
            match.append(-1)
            if c in (40, 91, 123):
                stack.append(k)
            elif c in (41, 93, 125):
                if not stack:
                    raise LexError(f"{self.name}: unbalanced '{chr(c)}' at {p}")
                o = stack.pop()
                match[o] = k
                match[k] = o
            i = p + 1
        if stack:
            raise LexError(f"{self.name}: {len(stack)} unclosed bracket(s), first at "
                           f"{tpos[stack[0]]} - lexer lost sync")
        lit.sort()

    # ------------------------------------------------------------ queries
    def _build_segments(self):
        """Flatten literals into non-overlapping text segments, each pointing at its
        owning literal (a template's `${...}` expressions are code, not text)."""
        segs = []
        for idx, (a, b, kind) in enumerate(self.lit):
            if kind == "template" and a in self.tpl_expr:
                cur = a
                for ea, eb in self.tpl_expr[a]:
                    segs.append((cur, ea, idx))
                    cur = eb
                segs.append((cur, b, idx))
            else:
                segs.append((a, b, idx))
        segs.sort()
        self._segs = segs
        self._seg_starts = [x[0] for x in segs]

    def literal_at(self, pos):
        """(start, end, kind) of the literal whose text contains pos, else None."""
        k = bisect.bisect_right(self._seg_starts, pos) - 1
        if k >= 0:
            a, b, idx = self._segs[k]
            if a <= pos < b:
                return self.lit[idx]
        return None

    def in_literal(self, pos):
        return self.literal_at(pos) is not None

    def _tok_before(self, pos):
        return bisect.bisect_left(self.tpos, pos) - 1

    def _tok_from(self, pos):
        return bisect.bisect_left(self.tpos, pos)

    def _paren_keyword(self, open_tok):
        """The control keyword (if/while/for/switch/catch/with) owning a `(`, else None."""
        q = self._prev_sig(self.tpos[open_tok])
        if q < 0:
            return None
        w = _WORD_BEFORE.search(self.s, max(0, q - 16), q + 1)
        if w and w.group(0) in CONTROL_KEYWORDS and (w.start() == 0 or self.s[w.start() - 1] != 46):
            return w.group(0)
        return None

    def _is_block_brace(self, open_tok):
        """True for a `{` that opens a statement/function body (after `)`, `=>`,
        `else`, `try`, `finally`, `do`), not an object literal."""
        q = self._prev_sig(self.tpos[open_tok])
        if q < 0:
            return True
        c = self.s[q]
        if c == 41:
            return True
        if c == 62 and q > 0 and self.s[q - 1] == 61:
            return True
        w = _WORD_BEFORE.search(self.s, max(0, q - 16), q + 1)
        return bool(w) and w.group(0) in (b"else", b"try", b"finally", b"do", b"catch")

    def statement_span(self, pos):
        """The statement or expression element around pos.

        Bounded by `;` or `,` at its own level, or by an unmatched `[`, `{` or
        `${`. Parentheses are expression grouping or call arguments, so an
        unmatched `(` is left outward - except a control-statement condition
        (`if(...)`, `while(...)`, ...), which bounds the span on its own: an
        injection inside the guarded block does not change the condition.
        Balanced groups in between are skipped whole; a statement body block
        (`if(..){..}`, a function body) ends the span on either side."""
        tch, match, tpos = self.tch, self.match, self.tpos
        n = len(tpos)
        j = self._tok_before(pos)
        start = 0
        stop_at_close = None
        while j >= 0:
            c = tch[j]
            if c in CLOSERS:
                if c == 125 and self._is_block_brace(match[j]):
                    start = tpos[j] + 1  # a statement body ended right before us
                    break
                j = match[j] - 1
                continue
            if c == 40:
                if self._paren_keyword(j):
                    start = tpos[j] + 1
                    stop_at_close = match[j]
                    break
                j -= 1  # leave the group outward
                continue
            if c in OPENERS:
                start = tpos[j] + (2 if c == 36 else 1)
                break
            if c == 59 or c == 44:
                start = tpos[j] + 1
                break
            j -= 1
        j = self._tok_from(pos)
        end = len(self.s)
        while j < n:
            if j == stop_at_close:
                end = tpos[j]
                break
            c = tch[j]
            if c in OPENERS:
                if c == 123 and self._is_block_brace(j):
                    end = tpos[match[j]] + 1
                    break
                j = match[j] + 1
                continue
            if c == 41:
                j += 1  # unmatched `)`: leave the group outward
                continue
            if c in CLOSERS or c == 59 or c == 44:
                end = tpos[j]
                break
            j += 1
        return start, end

    def enclosing_blocks(self, pos):
        """Yield token indices of the unmatched `{` openers around pos, innermost first."""
        tch, match = self.tch, self.match
        j = self._tok_before(pos)
        while j >= 0:
            c = tch[j]
            if c in CLOSERS:
                j = match[j] - 1
                continue
            if c == 123:
                yield j
            j -= 1

    def _prev_sig(self, p):
        k = p - 1
        while k >= 0 and self.s[k] in _WS:
            k -= 1
        return k

    def function_info(self, brace_tok):
        """If the `{` at token index brace_tok opens a function body, return
        (params_start, params_end) byte span of its parameter text; else None."""
        s = self.s
        p = self.tpos[brace_tok]
        k = self._prev_sig(p)
        if k < 0:
            return None
        if s[k] == 62 and k > 0 and s[k - 1] == 61:  # `=>{`
            q = self._prev_sig(k - 1)
            if q >= 0 and s[q] == 41:  # (params)=>{
                ti = self._tok_before(q + 1)
                o = self.match[ti]
                return (self.tpos[o] + 1, q)
            w = _WORD_BEFORE.search(s, max(0, q - 64), q + 1)
            if w:
                return (w.start(), w.end())
            return None
        if s[k] == 41:  # `){` - function / method body or control block
            ti = self._tok_before(k + 1)
            o = self.match[ti]
            if o < 0:
                return None
            op = self.tpos[o]
            q = self._prev_sig(op)
            w = _WORD_BEFORE.search(s, max(0, q - 64), q + 1) if q >= 0 else None
            if w and w.group(0) in CONTROL_KEYWORDS:
                return None
            return (op + 1, k)
        return None

    def enclosing_function(self, pos):
        """(body_open_tok, params_span) of the innermost function body around pos, else None."""
        for bt in self.enclosing_blocks(pos):
            info = self.function_info(bt)
            if info is not None:
                return bt, info
        return None

    def enclosing_functions(self, pos):
        for bt in self.enclosing_blocks(pos):
            info = self.function_info(bt)
            if info is not None:
                yield bt, info

    def block_span(self, brace_tok):
        """(start, end) bytes of a `{...}` group including both braces."""
        return self.tpos[brace_tok], self.tpos[self.match[brace_tok]] + 1

    def group_end_tok(self, tok):
        return self.match[tok]

    def tok_at(self, pos):
        """Token index whose offset is exactly pos, else -1."""
        k = bisect.bisect_left(self.tpos, pos)
        return k if k < len(self.tpos) and self.tpos[k] == pos else -1

    def list_end(self, pos):
        """From pos, walk the current level to the end of a declaration list:
        (end offset, [offsets of top-level commas]). Ends at `;` or an unmatched
        closer; balanced groups are skipped whole."""
        tch, match, tpos = self.tch, self.match, self.tpos
        n = len(tpos)
        j = self._tok_from(pos)
        commas = []
        while j < n:
            c = tch[j]
            if c in OPENERS:
                j = match[j] + 1
                continue
            if c == 44:
                commas.append(tpos[j])
            elif c == 59 or c in CLOSERS:
                return tpos[j], commas
            j += 1
        return len(self.s), commas

    def top_statement(self, pos):
        """The whole `;`-delimited statement around pos at its block level
        (commas do not split it)."""
        tch, match, tpos = self.tch, self.match, self.tpos
        j = self._tok_before(pos)
        start = 0
        while j >= 0:
            c = tch[j]
            if c in CLOSERS:
                if c == 125 and self._is_block_brace(match[j]):
                    start = tpos[j] + 1
                    break
                j = match[j] - 1
                continue
            if c == 59 or c in OPENERS:
                start = tpos[j] + (2 if c == 36 else 1)
                break
            j -= 1
        return start, self.list_end(pos)[0]

    def enclosing_paren(self, pos, stop_tok=-1):
        """Token index of the unmatched `(` around pos inside the block whose `{`
        is stop_tok, or -1."""
        tch, match = self.tch, self.match
        j = self._tok_before(pos)
        while j > stop_tok:
            c = tch[j]
            if c in CLOSERS:
                j = match[j] - 1
                continue
            if c == 40:
                return j
            if c in OPENERS:
                return -1
            j -= 1
        return -1

    def paren_keyword(self, open_tok):
        k = self._paren_keyword(open_tok)
        return k.decode() if k else None

    def after_group(self, open_tok):
        """Offset just after the group opened at open_tok."""
        return self.tpos[self.match[open_tok]] + 1


_IDCH = frozenset(b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$")


def iter_ident(data, name, allow_member=False, lo=0, hi=None):
    """Offsets of `name` as a whole identifier in data[lo:hi] (bytes.find based:
    much faster than a lookbehind regex on multi-MB chunks). With
    allow_member=False a preceding `.` (member access) is skipped too."""
    hi = len(data) if hi is None else hi
    n = len(name)
    i = data.find(name, lo, hi)
    while i != -1:
        b = data[i - 1] if i > 0 else 32
        e = data[i + n] if i + n < len(data) else 32
        if b not in _IDCH and e not in _IDCH and (allow_member or b != 46):
            yield i
        i = data.find(name, i + 1, hi)


def _split_top(text, sep):
    """Split bytes at top-level `sep` (a single byte value), respecting
    brackets and quotes."""
    out, depth, cur, i, n = [], 0, 0, 0, len(text)
    while i < n:
        c = text[i]
        if c in (34, 39, 96):
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == 92 else 1
            i = j + 1
            continue
        if c in (40, 91, 123):
            depth += 1
        elif c in (41, 93, 125):
            depth -= 1
        elif c == sep and depth == 0:
            out.append(text[cur:i])
            cur = i + 1
        i += 1
    out.append(text[cur:])
    return out


def _strip_default(text):
    """`pat=default` -> `pat` (top-level `=` that is not `==`, `=>`, `<=` ...)."""
    depth, i, n = 0, 0, len(text)
    while i < n:
        c = text[i]
        if c in (34, 39, 96):
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == 92 else 1
            i = j + 1
            continue
        if c in (40, 91, 123):
            depth += 1
        elif c in (41, 93, 125):
            depth -= 1
        elif c == 61 and depth == 0:
            nx = text[i + 1:i + 2]
            pv = text[i - 1:i]
            if nx not in (b"=", b">") and pv not in (b"=", b"!", b"<", b">"):
                return text[:i]
        i += 1
    return text


_IDENT_RE = re.compile(rb"^[A-Za-z_$][\w$]*$")


def binding_names(text):
    """Names a binding pattern declares: `a`, `a=1`, `{k:a,b,...c}`, `[a,,b=2]`,
    `...r`. Object-pattern keys and default values are not bindings."""
    t = _strip_default(text.strip()).strip()
    if t.startswith(b"..."):
        t = t[3:].strip()
    if not t:
        return set()
    if t[:1] == b"{" and t[-1:] == b"}":
        names = set()
        for prop in _split_top(t[1:-1], 44):
            prop = prop.strip()
            if not prop:
                continue
            if prop.startswith(b"..."):
                names |= binding_names(prop)
                continue
            kv = _split_top(prop, 58)  # key:pattern
            if len(kv) > 1:
                names |= binding_names(b":".join(kv[1:]))
            else:
                names |= binding_names(prop)
        return names
    if t[:1] == b"[" and t[-1:] == b"]":
        names = set()
        for el in _split_top(t[1:-1], 44):
            names |= binding_names(el)
        return names
    return {t} if _IDENT_RE.match(t) else set()


def params_names(text):
    names = set()
    for p in _split_top(text, 44):
        names |= binding_names(p)
    return names


def snippet(data, pos, width=160):
    a = max(0, pos - width // 2)
    t = data[a:a + width].decode("utf-8", "replace")
    return "".join(ch if ch.isprintable() else " " for ch in t)


_NIM_LIT = re.compile(rb'([A-Za-z0-9_]*)(?:"""(.*?)"""|"((?:[^"\\\n]|\\.)*)")', re.S)
_NIM_PATTERN_PREFIX = {b"re", b"re2", b"rex", b"r", b"peg"}
_NIM_PATTERN_CALL = re.compile(rb"(?:\bre2?|\brex|escapeRe|find|rfind|contains|count|startsWith|endsWith|"
                               rb"findIter|findAll|match|matches|multiReplace)\(\s*$")


def _nim_strings(src):
    """The JS a .nim patch WRITES: its string literals in order, `"a" & "b"`
    joined, any non-literal operand (`"a" & w & "b"`) as a NUL, Nim escapes
    undone. Literals that are match patterns - regex literals (re"..",
    re2"..", r"..") and the first argument of re()/find()/contains()/count()
    and friends - are left out, so a patch quoting upstream text as an anchor
    never makes that upstream text look like ours."""
    out, last_end = [], None
    for m in _NIM_LIT.finditer(src):
        prefix = m.group(1)
        pattern = prefix in _NIM_PATTERN_PREFIX or (
            not prefix and _NIM_PATTERN_CALL.search(src, max(0, m.start() - 40), m.start()) is not None)
        if prefix and prefix not in _NIM_PATTERN_PREFIX:
            # an identifier glued to a quote (fmt&"..") is still a string literal
            pattern = False
        if pattern:
            out.append(b"\0")
            last_end = None
            continue
        if last_end is not None:
            gap = src[last_end:m.start()]
            out.append(b"" if re.fullmatch(rb"\s*&\s*", gap) else b"\0")
        if m.group(2) is not None:
            out.append(m.group(2))
        else:
            out.append(m.group(3).replace(b'\\"', b'"').replace(b"\\n", b"\n").replace(b"\\\\", b"\\"))
        last_end = m.end()
    return b"".join(out)


class OurSources:
    """Text our patches inject: js/*.js (raw and JSON-escaped, the way page
    scripts are embedded) and the string contents of patches/*/*.nim (with the
    Nim escapes `\\"` and `\\\\` undone). Used to tell our own code in the
    PATCHED bundle from upstream's by the bytes around an occurrence."""

    def __init__(self, js_dir, patches_dir):
        import glob
        import json
        import os
        corpus = []
        for f in sorted(glob.glob(os.path.join(js_dir, "*.js"))) if js_dir else []:
            with open(f, "rb") as fh:
                raw = fh.read()
            corpus.append(raw)
            corpus.append(json.dumps(raw.decode("utf-8", "replace"))[1:-1].encode("utf-8"))
        for f in sorted(glob.glob(os.path.join(patches_dir, "*", "*.nim"))) if patches_dir else []:
            with open(f, "rb") as fh:
                corpus.append(_nim_strings(fh.read()))
        self.corpus = corpus

    def owns(self, data, pos, length, ctx=24):
        """True when the occurrence together with ctx bytes on BOTH sides appears
        verbatim in our sources. A one-sided match would let upstream text that
        merely starts or ends like a line of ours (e.g. a new inline
        `app.commandLine.getSwitchValue("ozone-platform")` test) pass as ours."""
        win = data[max(0, pos - ctx):pos + length + ctx]
        return any(win in c for c in self.corpus)
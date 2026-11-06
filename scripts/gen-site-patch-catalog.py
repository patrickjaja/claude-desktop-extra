#!/usr/bin/env python3
"""Render the landing page's patch catalogue from docs/patches.md.

WHY: site/index.html lets visitors browse and search every patch before they
install. docs/patches.md is the catalogue we maintain (one table per patches/
subdirectory); the page must show exactly that, never a hand-copied version
that drifts. This script parses the three tables, turns each description's
inline markdown into safe HTML, and writes the result between the
`<!-- patch-catalog:start -->` / `<!-- patch-catalog:end -->` markers in
site/index.html. The block is generated: do not edit it by hand.

It also fails when the tables and patches/<dir>/*.nim disagree (a patch with
no row, a row naming a file that does not exist, a patches/ directory this
script does not know), since the page promises "every patch"; when a
description holds raw HTML other than <kbd>/<br> outside backticks (it would
be dropped silently); and when a relative link points at a missing file.

The hand-written counts elsewhere on the page are tagged `data-count="KEY"`
(total, core, community, linux, coreplumbing) and the community-features
filter carries `data-count-placeholder="features"`. --write rewrites them from
the real counts (features = render*Row entries in FEATURE_GROUPS of
js/extra_settings_page.js, which must also equal the page's community rows);
--check fails when one is stale.

Usage (stdlib only):
  python3 -I scripts/gen-site-patch-catalog.py --write   # regenerate the block
  python3 -I scripts/gen-site-patch-catalog.py --check   # exit 1 on drift (CI)
"""

import difflib
import html
import os
import posixpath
import re
import sys
from typing import NoReturn

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOC = os.path.join(REPO, "docs", "patches.md")
PAGE = os.path.join(REPO, "site", "index.html")
FEATURES_JS = os.path.join(REPO, "js", "extra_settings_page.js")
DOC_DIR = "docs"  # links in docs/patches.md are relative to this directory
GH = "https://github.com/patrickjaja/claude-desktop-extra"
START = "<!-- patch-catalog:start -->"
END = "<!-- patch-catalog:end -->"

# Doc order. (heading, patches/ dir, tier, badge text, badge class, page id, blurb)
SECTIONS = [
    ("Community features", "community", "community", "Community", "badge-exp",
     "pc-community",
     "Improvements and features, each behind its own switch in Settings -> Extra -> Community."),
    ("Core infrastructure", "core", "core", "Core: plumbing", "badge-core",
     "pc-core",
     "Always on: the shared plumbing the features build on."),
    ("Linux compatibility", "linux", "core", "Core: Linux fix", "badge-default",
     "pc-linux",
     "Always on: where Anthropic lacks compatibility on Linux."),
]

Meta = tuple[str, str, str, str, str, str, str]
Parsed = list[tuple[Meta, list[tuple[str, str]]]]


def fail(msg: str) -> NoReturn:
    print(f"[site-catalog] ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def split_row(line: str) -> list[str]:
    """Split a markdown table row on `|` outside code spans."""
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    cells: list[str] = []
    cur: list[str] = []
    in_code, i = False, 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            cur.append("|")
            i += 2
            continue
        if c == "`":
            in_code = not in_code
        if c == "|" and not in_code:
            cells.append("".join(cur).strip())
            cur = []
        else:
            cur.append(c)
        i += 1
    cells.append("".join(cur).strip())
    return cells


def parse_doc(text: str) -> Parsed:
    if "\x00" in text:
        fail("docs/patches.md contains a NUL byte")
    lines = text.split("\n")
    out: Parsed = []
    for heading, d, tier, badge, bcls, gid, blurb in SECTIONS:
        if "## " + heading not in lines:
            fail(f"heading '## {heading}' not found in docs/patches.md")
        i = lines.index("## " + heading) + 1
        while i < len(lines) and not lines[i].startswith("## "):
            if lines[i].startswith("| Patch |"):
                break
            i += 1
        if i >= len(lines) or not lines[i].startswith("| Patch |"):
            fail(f"no '| Patch |' table under '## {heading}'")
        i += 2  # header + separator
        rows: list[tuple[str, str]] = []
        while i < len(lines) and lines[i].startswith("|"):
            cells = split_row(lines[i])
            if len(cells) != 2:
                fail(f"docs/patches.md:{i + 1}: expected 2 cells, got {len(cells)}")
            m = re.fullmatch(r"\[`([\w.-]+\.nim)`\]\(\.\./patches/([\w-]+)/([\w.-]+\.nim)\)", cells[0])
            if m is None or m.group(1) != m.group(3):
                fail(f"docs/patches.md:{i + 1}: patch cell is not [`x.nim`](../patches/<dir>/x.nim): {cells[0]}")
            if m.group(2) != d:
                fail(f"docs/patches.md:{i + 1}: {m.group(1)} links patches/{m.group(2)}/ but sits in '{heading}' (patches/{d}/)")
            rows.append((m.group(1), cells[1]))
            i += 1
        if not rows:
            fail(f"table under '## {heading}' has no rows")
        out.append(((heading, d, tier, badge, bcls, gid, blurb), rows))
    return out


def check_coverage(parsed: Parsed) -> None:
    known = {meta[1] for meta, _ in parsed}
    pdirs = os.path.join(REPO, "patches")
    for d in sorted(os.listdir(pdirs)):
        full = os.path.join(pdirs, d)
        if os.path.isdir(full) and d not in known and any(f.endswith(".nim") for f in os.listdir(full)):
            fail(f"patches/{d}/ holds .nim files but has no section in SECTIONS of "
                 "scripts/gen-site-patch-catalog.py (and no table in docs/patches.md?)")
    for (heading, d, *_), rows in parsed:
        pdir = os.path.join(REPO, "patches", d)
        on_disk = sorted(f for f in os.listdir(pdir) if f.endswith(".nim"))
        named = [r[0] for r in rows]
        dup = sorted({n for n in named if named.count(n) > 1})
        missing = sorted(set(on_disk) - set(named))
        extra = sorted(set(named) - set(on_disk))
        if dup or missing or extra:
            fail(f"'{heading}' table vs patches/{d}/*.nim: "
                 f"duplicate rows {dup}, no row for {missing}, row without file {extra}")


def resolve_url(url: str, where: str) -> str | None:
    """Rewrite a docs/-relative link to GitHub; keep absolute http(s) links."""
    if re.match(r"https?://", url):
        return url
    if re.match(r"[a-zA-Z][\w+.-]*:", url):
        return None  # other schemes (javascript:, data:, mailto:) are dropped
    path, _, frag = url.partition("#")
    frag = "#" + frag if frag else ""
    if not path:
        for heading, _d, _t, _b, _c, gid, _bl in SECTIONS:
            if frag == "#" + re.sub(r"[^\w-]", "", heading.lower().replace(" ", "-")):
                return "#" + gid
        return f"{GH}/blob/master/docs/patches.md{frag}"
    rel = posixpath.normpath(posixpath.join(DOC_DIR, path))
    if rel.startswith("..") or rel.startswith("/"):
        fail(f"{where}: link leaves the repo: {url}")
    full = os.path.join(REPO, rel)
    if not os.path.exists(full):
        fail(f"{where}: link target does not exist (would 404 on the page): {url} -> {rel}")
    kind = "tree" if os.path.isdir(full) or path.endswith("/") else "blob"
    return f"{GH}/{kind}/master/{rel}{frag}"


def md_inline(src: str, where: str) -> str:
    """Inline markdown -> safe HTML. Escape first, then convert known shapes."""
    if "\x00" in src:
        fail(f"{where}: NUL byte in the description")
    s = html.escape(src, quote=True)
    stash: list[str] = []

    def keep(fragment: str) -> str:
        stash.append(fragment)
        return f"\x00{len(stash) - 1}\x00"

    # Code spans first, so nothing inside them is converted further.
    s = re.sub(r"`([^`]+)`", lambda m: keep(f"<code>{m.group(1)}</code>"), s)
    # The only raw HTML kept: <kbd>..</kbd> and <br>. Any other tag is dropped.
    s = re.sub(r"&lt;kbd&gt;(.*?)&lt;/kbd&gt;", lambda m: keep(f"<kbd>{m.group(1)}</kbd>"), s)
    s = re.sub(r"&lt;br\s*/?&gt;", lambda m: keep("<br>"), s)
    raw = re.search(r"&lt;/?[a-zA-Z][\w-]*(?:\s[^<>]*?)?/?&gt;", s)
    if raw:
        fail(f"{where}: raw HTML {html.unescape(raw.group(0))} outside backticks; only <kbd> and <br> "
             "are rendered - put it in backticks (`...`) or drop it")

    def link(m: re.Match[str]) -> str:
        text, url = m.group(1), html.unescape(m.group(2))
        target = resolve_url(url, where)
        if target is None:
            return text
        return f'<a href="{html.escape(target, quote=True)}">{text}</a>'

    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    while "\x00" in s:
        s = re.sub(r"\x00(\d+)\x00", lambda m: stash[int(m.group(1))], s)
    return s


def render(parsed: Parsed) -> str:
    total = sum(len(r) for _, r in parsed)
    core = sum(len(r) for (meta, r) in parsed if meta[2] == "core")
    comm = total - core
    o: list[str] = []
    o.append(START)
    o.append("  <!-- Generated by scripts/gen-site-patch-catalog.py from docs/patches.md - do not edit by hand. -->")
    o.append('  <div class="pc-controls" id="pc-controls" hidden>')
    o.append('    <div class="cf-search">')
    o.append(f'      <input type="search" id="pc-filter" placeholder="Filter {total} patches by name or description" aria-label="Filter patches" autocomplete="off">')
    o.append('      <button type="button" class="cf-clear" id="pc-clear" aria-label="Clear filter" hidden>&times;</button>')
    o.append("    </div>")
    o.append('    <div class="pc-tiers" role="group" aria-label="Patch tier">')
    o.append(f'      <button type="button" class="pc-tier active" data-tier="all" aria-pressed="true">All ({total})</button>')
    o.append(f'      <button type="button" class="pc-tier" data-tier="core" aria-pressed="false">Core ({core})</button>')
    o.append(f'      <button type="button" class="pc-tier" data-tier="community" aria-pressed="false">Community ({comm})</button>')
    o.append("    </div>")
    o.append("  </div>")
    o.append('  <div id="pc-groups">')
    for (heading, d, tier, badge, bcls, gid, blurb), rows in parsed:
        o.append(f'    <div class="cf-group pc-group" id="{gid}" data-tier="{tier}">')
        o.append(f'      <h3 class="pc-group-h">{html.escape(heading)} <span class="pc-group-n">{len(rows)}</span></h3>')
        o.append(f'      <div class="cf-group-sub">{html.escape(blurb)} <code>patches/{d}/</code></div>')
        o.append('      <div class="cf-list">')
        for name, desc in rows:
            stem = name[:-4]
            href = f"{GH}/blob/master/patches/{d}/{name}"
            o.append(f'        <div class="cf-row pc-row" id="patch-{stem}" data-tier="{tier}">')
            o.append(f'          <div class="cf-title"><a class="pc-name" href="{href}">{html.escape(name)}</a> <span class="cf-hint {bcls}">{html.escape(badge)}</span></div>')
            o.append(f'          <div class="cf-note">{md_inline(desc, name)}</div>')
            o.append("        </div>")
        o.append("      </div>")
        o.append("    </div>")
    o.append('    <div class="cf-empty" id="pc-empty" hidden>No patch matches that filter.</div>')
    o.append("  </div>")
    o.append("  " + END)
    return "\n".join(o)


def feature_count() -> int:
    """Rows in Settings -> Extra -> Community: render*Row entries of FEATURE_GROUPS."""
    with open(FEATURES_JS, encoding="utf-8") as f:
        js = f.read()
    m = re.search(r"var FEATURE_GROUPS = \[(.*?)\n  \];", js, re.S)
    if m is None:
        fail("FEATURE_GROUPS not found in js/extra_settings_page.js")
    n = len(re.findall(r"\brender\w+Row\b", m.group(1)))
    if n == 0:
        fail("FEATURE_GROUPS in js/extra_settings_page.js lists no render*Row entries")
    return n


COUNT_RE = re.compile(r'(<(\w+)\b[^<>]*\bdata-count="(\w+)"[^<>]*>)(\d+)(</\2>)')
PLACEHOLDER_RE = re.compile(r'(<input\b[^<>]*\bdata-count-placeholder="(\w+)"[^<>]*\bplaceholder="Filter )(\d+)( )')


def sync_counts(outside: str, counts: dict[str, int]) -> tuple[str, list[str]]:
    """Rewrite tagged counts outside the block; answer the new text and what was stale."""
    stale: list[str] = []
    seen: set[str] = set()

    def fix(key: str, num: str) -> str:
        if key not in counts:
            fail(f'site/index.html: unknown data-count key "{key}" (known: {", ".join(sorted(counts))})')
        seen.add(key)
        if int(num) != counts[key]:
            stale.append(f"{key}: page says {num}, real count is {counts[key]}")
        return str(counts[key])

    out = COUNT_RE.sub(lambda m: m.group(1) + fix(m.group(3), m.group(4)) + m.group(5), outside)
    out = PLACEHOLDER_RE.sub(lambda m: m.group(1) + fix(m.group(2), m.group(3)) + m.group(4), out)
    missing = sorted({"total", "core", "community", "linux", "coreplumbing", "features"} - seen)
    if missing:
        fail(f"site/index.html: no data-count element for {missing} - the tags beside the catalogue were removed?")
    return out, stale


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    if mode not in ("--check", "--write") or len(sys.argv) > 2:
        print("usage: python3 -I scripts/gen-site-patch-catalog.py [--check | --write]", file=sys.stderr)
        sys.exit(2)
    with open(DOC, encoding="utf-8") as f:
        parsed = parse_doc(f.read())
    check_coverage(parsed)
    block = render(parsed)
    with open(PAGE, encoding="utf-8") as f:
        page = f.read()
    if page.count(START) != 1 or page.count(END) != 1:
        fail(f"site/index.html must contain exactly one '{START}' and one '{END}'")
    a = page.index(START)
    b = page.index(END) + len(END)
    if b < a:
        fail("end marker comes before start marker in site/index.html")
    head, current, tail = page[:a], page[a:b], page[b:]

    # Generated ids must not collide with the hand-written page around the block.
    outside_ids = set(re.findall(r'\bid="([^"]+)"', head + tail))
    clash = sorted(set(re.findall(r'\bid="([^"]+)"', block)) & outside_ids)
    if clash:
        fail(f"generated ids collide with ids elsewhere in site/index.html: {clash}")

    by_dir = {meta[1]: len(r) for meta, r in parsed}
    core = sum(len(r) for meta, r in parsed if meta[2] == "core")
    features = feature_count()
    cf_rows = len(re.findall(r'class="cf-row"', head + tail))
    if cf_rows != features:
        fail(f"site/index.html community-features list has {cf_rows} rows, but FEATURE_GROUPS in "
             f"js/extra_settings_page.js has {features} - update the #community section by hand")
    counts = {"total": sum(by_dir.values()), "core": core, "community": by_dir["community"],
              "linux": by_dir["linux"], "coreplumbing": by_dir["core"], "features": features}
    # One pass over everything outside the block; the block itself stands in as a sentinel.
    synced, stale = sync_counts(head + START + tail, counts)
    head2, tail2 = synced.split(START, 1)

    summary = ", ".join(f"{k} {v}" for k, v in counts.items())
    new_page = head2 + block + tail2
    if mode == "--write":
        if new_page != page:
            with open(PAGE, "w", encoding="utf-8") as f:
                _ = f.write(new_page)
            print(f"[site-catalog] wrote site/index.html ({summary})")
            for line in stale:
                print(f"[site-catalog]   fixed count {line}")
        else:
            print(f"[site-catalog] site/index.html already up to date ({summary})")
        return
    ok = True
    if stale:
        ok = False
        print("::error::site/index.html has stale patch/feature counts beside the catalogue")
        for line in stale:
            print(f"  {line}")
    if current != block:
        ok = False
        print("::error::site/index.html patch catalogue is out of sync with docs/patches.md")
        print("--- diff (page vs generated, first 60 lines) ---")
        diff = list(difflib.unified_diff(current.split("\n"), block.split("\n"),
                                         "site/index.html", "generated", lineterm=""))
        print("\n".join(diff[:60]))
    if not ok:
        print("Regenerate it:  bash scripts/check-site-catalog-sync.sh --write   (then commit)")
        sys.exit(1)
    print(f"[site-catalog] site/index.html matches docs/patches.md ({summary})")


if __name__ == "__main__":
    main()

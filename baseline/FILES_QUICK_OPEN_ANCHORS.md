# Files quick open - remote anchors

Measured live over CDP against Claude Desktop **v1.37937.3**, and **re-measured on v1.40609.0**
(both claude.ai/epitaxy) on **2026-08-29**. The page half (`js/files_quick_open_page.js`) keys off
REMOTE claude.ai markup and React fiber props; re-run the recipes below against the live app after an
upstream bump or when a `[cdb-qopen]` warning appears in
`~/.config/Claude/logs/claude.ai-web.log`.

Two rows are NOT remote and can be checked locally with grep instead of the console:
the generic worker-host fork (the last row), which lives in the LOCAL main bundle and is rewritten by
`add_feature_files_quick_open.nim` sub-patch B; and `fetchMentionOptions`, which is a **local eIPC
channel**, not remote markup - the preload (`.vite/build/mainView.js`) exposes it on
`window["claude.web"].Resources`, and main implements it over `FileIndexHost.search` (the very call
site `add_feature_files_quick_open_worker.nim` rewrites). Verified on 1.40609.0. Only the DOM and
fiber rows are genuinely remote.

## Anchors

| Anchor | Used for | Measured value | If it moves |
|---|---|---|---|
| `[data-pane-root][data-perf-screen="file"]` | the Files pane (`PANE_SEL`) | tile id `file` (NOT `browser`, which `baseline/PANEL_TABS_ANCHORS.md` recorded earlier); header text `Files` | modal shows "Open the Files panel first" although the pane is open → update `PANE_SEL` |
| `input[aria-label="Filter files"]` | fiber entry point of last resort (`FILTER_SEL`) | placeholder `Filter files… (? to search contents)`; the walk up from it returned **null** on 1.40609.0 | kept only as a fallback start - it resolves nothing today, so it must never be treated as "the harvest succeeded" |
| `[role="tree"]` / `[role="treeitem"]` | fallback fiber entry points (`TREE_SEL`, `ROW_SEL`) and the tile-root derivation | virtualized: ~46 rows in DOM regardless of tree size. On a COLD render the `[role=tree]` element commits BEFORE its rows, and a pane opened from scratch renders the tree with **0 rows for seconds** - the descent below is what covers both | warning `no-onpreview` |
| `button[aria-label="Show file tree"]` | un-hiding a collapsed tree (`SHOW_TREE_SEL`) | on 1.40609.0 a Files pane can show an open file with the tree collapsed: no `[role=tree]`, no rows, no filter box, and a BFS over 1581 fibers finds NO `onPreview`. The toolbar button carries `aria-pressed="false"`; a real `.click()` renders the tree (46 rows + filter) within ~700 ms and relabels it `Hide file tree` | the page polls the HARVEST for `TREE_WAIT_MS` (3000 ms) and then degrades to `HINT_NO_HANDLER`; warnings `harvest-timeout` / `show-tree-threw`. A relabel (e.g. "Show files") means updating `SHOW_TREE_SEL` |
| fiber component with `memoizedProps.onPreview` | opening a file, and the tile root | `function (path: string, line?: number, findQuery?: string)`. **Found by DESCENDING from the pane root** (breadth-first, depth 10 after ~55 fibers, measured 2026-08-30 on 1.40609.0) - that is the only strategy that works while the tree has rendered NO rows, which is how a freshly opened pane starts and stays for seconds. Walking UP from a `[role="treeitem"]` ROW also reaches it (hop ~12) and is kept as the fallback; walking up from `[role="tree"]` or from `input[aria-label="Filter files"]` returns null. The owning component's props are `{sessionId, root, reveal, listDirectory, scope, remote, scrollEl, navRef, onPreview, prefetcher}`. The owning component's string `root` prop (the tile's folder, NO trailing slash) is the tile root, preferred over the row-derived one. Passing an object to `onPreview` throws `e.startsWith is not a function` | warning `no-onpreview` / `onpreview-threw`; hint "Cannot open files"; a missing `root` prop falls back to the `entry` row below |
| row fiber `memoizedProps.entry` | tile root = `absPath` minus `relativePath` | `{name, absPath, relativePath, isDirectory, positions}` | root falls back to the index's absolute path; MRU disabled; warning `no-entry` |
| `window["claude.web"].Resources.fetchMentionOptions(q, "files")` **(LOCAL, not remote - greppable in the bundle: `mainView.js` wraps the eIPC channel, `index*.chunk-*.js` registers and implements it over `FileIndexHost.search`)** | search | ≤ 50 `{id: "file-<abs>", label: "<rel>", icon, category: "Files", metadata: JSON {path, isDirectory, positions}}`, ~90 ms; rooted at the FOCUSED session cwd | warning `search-*`; hint "Search unavailable" |
| `MENU_SEEDS` → `SESSION_MENU_SEL` → the `Files` entry | creating a Files pane when none is open | The session ⋮ is `button[aria-label^="More options for "]`, but ~76 of those exist (one per sidebar session), and it is **not** a sibling of the `Terminal` / `Diff (uncommitted changes)` / `Browser` toolbar buttons. Measured 2026-08-30 on 1.40609.0: climbing from one of those buttons, the ancestor **2 parents up** holds exactly one - that climb (`MENU_CLIMB_HOPS`, refuses on >1 match) is the anchor. Its menu renders async and its entry reads **`FilesCtrlF`** (label + shortcut, no separator, hence the `/^files/i` prefix test); clicking it mounts the pane in ~900 ms. The entry is a **TOGGLE** - only ever pressed when there is no pane. Upstream's own `Ctrl+F` accelerator is unusable from the page: a synthetic key event is untrusted and does nothing. **Nothing the page can dispatch closes that menu either** (measured 2026-08-30: Escape on body/document/the menu itself, an outside pointerdown, and a second click on the ⋮ all leave it open) - it stays mounted behind our own full-screen overlay and disappears together with it when the modal closes, so no menu is ever left over the app. `dismissMenu()` is a best-effort attempt kept for other builds, not a guarantee | the modal degrades to `HINT_NO_PANE`; warnings `no-files-menu-item` / `session-menu-threw` / `files-item-threw`. A relabelled entry means updating `FILES_ITEM_RE` |
| `Ctrl+P` | hotkey | unbound in upstream's Electron menu (only `CmdOrCtrl+Plus` matches the substring); renderer bindings unknown, hence the capture-phase listener | a conflict shows up as both actions firing - re-check `mainView`/renderer |
| generic worker-host fork (LOCAL bundle) | the `CDB_FILES_QUICK_OPEN` env gate reaches the file-index worker | `utilityProcess.fork(<path>,[],{serviceName:<name>,stdio:"pipe"})` - exactly ONE occurrence in the staged bundle (1.46388.2; the string quotes flip between backtick and double quote across minifier releases, so the patch matches them with a `["\`]` class), the host that `worker:{buildName:"file-index-worker"` uses. `add_feature_files_quick_open.nim` **sub-patch B rewrites it** to add `env:Object.assign({},process.env)`, because Electron hands a `fork()` with no `env` option the browser's INITIAL environment, not main's live `process.env` (measured live: the key was in main's `/proc/<pid>/environ` and in none of the utility processes). Passing main's LIVE env also forwards whatever upstream writes into it after startup - measured on 1.37937.3: `CLAUDE_CODE_SESSION_ACCESS_TOKEN` and `CLAUDE_CONFIG_DIR` - to every worker that host spawns (file-index, transcript-search, heavy-work, stall-sampler), which the initial-env default did not; same user, same app, so an exposure-surface widening rather than a boundary crossing | the patch **fails the build** (strict count: exactly one match required), so this cannot regress silently. If upstream adds its own `env:` there, merge into it instead of prepending a second key |

## The harvest is row-driven, and it retries

`onPreview` is reachable only from a `[role="treeitem"]` row, so the page cannot use the DOM as its
wait condition: on a COLD render (tree hidden since app start) the `[role=tree]` element commits
first and its rows land ~200-700 ms later. Waiting on "a tree or a row exists" therefore harvested
nothing, gave up for good, and Enter opened nothing - the live defect measured on 1.40609.0.

`js/files_quick_open_page.js` polls `findPreviewProps()` itself every `TREE_POLL_MS` (50 ms) up to
`TREE_WAIT_MS` (3000 ms) and finishes the moment it returns non-null. The same retry covers the
non-deferred path (a visible tree with zero rows - an empty folder, or upstream's own filter matched
nothing). A `memoizedProps` accessor that THROWS is final, not "not yet": the retry stops, `open-threw`
is warned once and the hint says the anchor is gone.

## Verifying the `CDB_FILES_QUICK_OPEN` env gate

**`/proc/<pid>/environ` is not a valid probe.** Chromium empties the environ block of its utility
processes - reading it yields `disable-logging` plus NULs regardless of what the process actually
inherited - so it can neither confirm nor refute that the key reached the file-index worker (it
produced a false negative on 2026-08-29). The **behavioural** check is the instrument: with the pref
on, run recipe 3 below with a two-word query,
`window["claude.web"].Resources.fetchMentionOptions("user service", "files")`. Multi-piece hits
(50 results, and the same set for the reversed query) mean the gate is on in the worker; zero hits
mean it is not.

## Console recipes (DevTools on the claude.ai webContents, or CDP `Runtime.evaluate`)

```js
// 1. Pane + tile id
p = document.querySelector('[data-pane-root][data-perf-screen="file"]'); p && p.getAttribute("data-perf-screen")
// 2. onPreview signature, harvested like the page does
f = Object.entries(p.querySelector('[role=treeitem]')).find(([k]) => k.startsWith("__reactFiber$"))[1];
for (i = 0; f && i < 60; i++, f = f.return) if (f.memoizedProps && typeof f.memoizedProps.onPreview === "function") { console.log(f.memoizedProps.onPreview.toString().slice(0, 200)); break; }
// 3. Index shape
window["claude.web"].Resources.fetchMentionOptions("readme", "files").then(r => console.log(r.length, r[0]))
// 4. Is the tree hidden? (then Ctrl+P clicks this button and waits for the tree)
b = p.querySelector('button[aria-label="Show file tree"]'); b && b.getAttribute("aria-pressed")
// 5. The tile root the handler was rendered for
for (i = 0, f = Object.entries(p.querySelector('[role=treeitem]')).find(([k]) => k.startsWith("__reactFiber$"))[1]; f && i < 60; i++, f = f.return) if (f.memoizedProps && typeof f.memoizedProps.onPreview === "function") { console.log(f.memoizedProps.root); break; }
```

## Grep recipe - the generic worker-host fork (env passthrough)

Run in the extracted bundle (`tmp/app.asar.contents*/.vite/build/`). The host that `file-index-worker`
runs on is where sub-patch B injects `env:`; `CDB_FILES_QUICK_OPEN` reaches the worker only because of
that injection (a fork with no `env` option gets the browser's INITIAL environment, so the key we set
at runtime never arrives).

```bash
# 1. Which chunk hosts the file-index worker (quotes flip per minifier release - match both)
grep -alE 'buildName:["`]file-index-worker["`]' index*.js
# 2. Every fork call site - the one with serviceName + stdio is OUR anchor (exactly one)
grep -aoE 'utilityProcess\.fork\([^)]{0,120}\)' index*.js | sort -u
#    1.46388.2, UNPATCHED:
#      utilityProcess.fork(r,[],{serviceName:t,stdio:"pipe"})   <- generic worker host  (sub-patch B rewrites this)
#      utilityProcess.fork(e,t,{...a,env:s})                    <- MCP host             (upstream already passes env)
#      utilityProcess.fork(e,[],{serviceName:"Claude Desktop Shell Environment Extractor"})
#      utilityProcess.fork(t.yS("pty-host","ptyHostWorker.js")  <- pty host
#    FOUR lines, not three. Neither of the last two can collide with our anchor:
#    the pty host's serviceName is a STRING LITERAL, not the [\w$]+ identifier the
#    regex requires, and the shell extractor has no stdio key.
#    Use grep -a: the bundle contains NUL bytes and rg returns nothing on it.
# 3. After patching, the anchor reads (quote char preserved as captured):
#      utilityProcess.fork(r,[],{serviceName:t,stdio:"pipe",env:Object.assign({},process.env)})
```

If the anchor shape changes, the patch fails the build with `expected exactly 1 generic worker-host
fork site` - fix the pattern rather than dropping the sub-patch, or the spaces fix goes silently dead.

## Warning keys → anchor

`no-onpreview` (the harvest ran out of retries: no row fiber carries `onPreview`), `harvest-timeout` (same event, from the poll itself - no handler appeared within `TREE_WAIT_MS`; the two fire together), `onpreview-threw` (signature changed), `no-entry` (rows render but none carries `entry.absPath`/`relativePath` - tile root unknown, MRU disabled), `open-threw` (a fiber walk threw while harvesting; the retry stops there), `show-tree-threw` (clicking "Show file tree" threw), `no-files-menu-item` (the session menu opened but has no Files entry), `session-menu-threw` / `files-item-threw` (driving the menu threw), `search-bridge` / `search-threw` / `search-shape` / `search-rejected` (`fetchMentionOptions` moved or changed), `pref-threw` / `pref-shape` (our own bridge, not upstream).

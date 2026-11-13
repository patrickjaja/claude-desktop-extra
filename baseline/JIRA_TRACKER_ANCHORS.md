# Jira tracker anchors (upstream 5.1231.2, re-checked on 5.11492.0)

`patches/community/add_feature_jira_tracker.nim` and `js/jira_tracker_*.js` depend on the facts below. Minified names and offsets apply to the version named next to them (both Electron 45.2.1). Re-run the census after every upstream update. On 5.11492.0 (2026-11-13) every count matched 5.1231.2 except the informational C registry shape, and the Jira patch and its pristine-release test passed unchanged.

## Census

Run from the repository root on a pristine extract (Python stdlib only):

```bash
python3 -I - tmp/app.asar.contents/.vite/build <<'EOF'
import re, sys, glob, os
d = sys.argv[1]
parts = [os.path.join(d, "index.js")] + sorted(glob.glob(os.path.join(d, "index*.chunk-*.js")))
s = "".join(open(p, encoding="utf-8", errors="replace").read() for p in parts)
for name, pat in [
    ("B export key", r'getClaudeCodeSessionManager:\(\)=>[\w$]+'),
    ("B accessor shape", r'async function [\w$]+\(\)\{if\([\w$]+\)return [\w$]+;let\{claudeCodeSessionManager:[\w$]+\}=await '),
    ("C export key", r'onNativeViewAttached:\(\)=>[\w$]+'),
    ("C registry shape (any name)", r'function [\w$]+\([\w$]+\)\{return [\w$]+\.add\([\w$]+\),\(\)=>\{[\w$]+\.delete\([\w$]+\)\}\}'),
    ("startSession", r'async startSession\([\w$]+,[\w$]+\)\{this\.normalizeStartOptionsAtIngress\('),
    ("worktree setup call", r'ensureSessionWorktree\(\{sessionId:[\w$]+,options:[\w$]+,'),
    ("worktree flag", r'let [\w$]+=[\w$]+\.useWorktree===!0&&![\w$]+\.[\w$]+\('),
    ("unattended rule", r'unattended:[\w$]+\?\.sideSessionAuthorized!==!0&&\('),
    ("origin makes unattended", r'[\w$]+\?\.origin!==void 0\|\|\([\w$]+\?\.initiator\?\?"user"\)!=="user"'),
    ("person start", r'\{initiator:"scheduled-task",origin:[\w$.]+\}:\{initiator:"user"\}'),
    ("trust check", r'checkWorkspaceTrust\([\w$]+\)\{return this\.workspaceTrustChecks\.checkWorkspaceTrust\('),
    ("trust save", r'saveWorkspaceTrust\([\w$]+,[\w$]+\)\{return this\.workspaceTrustChecks\.saveWorkspaceTrust\('),
    ("renderer saveTrust", r'LocalSessions\.saveTrust: cwd='),
    ("route", r'getSessionRoute\([\w$]+\)\{return [\w$]+\.[\w$]+\([\w$]+\)\}'),
    ("route navigation", r'dispatchNavigate\([\w$]+\.getSessionRoute\('),
    ("default mode", r'async getDefaultPermissionMode\([\w$]+,[\w$]+\)\{return '),
    ("Ctrl+Shift+J", r'Shift\+J|CmdOrCtrl\+Shift\+J|"KeyJ"'),
    ("Navigation interface", r'"Navigation"'),
]:
    print(f"{name}: {len(re.findall(pat, s))}")
EOF
```

| Line | 5.1231.2 | 5.11492.0 | Used by |
|---|---|---|---|
| B export key | 1 | 1 | sub-patch B anchor (`getClaudeCodeSessionManager:()=>TC`) |
| B accessor shape | 1 | 1 | sub-patch B shape check |
| C export key | 1 | 1 | sub-patch C anchor (`onNativeViewAttached:()=>vFi`) |
| C registry shape (any name) | 20 | 22 | why C anchors on the export key, never on the shape |
| startSession | 1 | 1 | send flow |
| worktree setup call | 1 | 1 | gate 2 |
| worktree flag | 1 | 1 | gate 2 |
| unattended rule | 1 | 1 | gate 5 |
| origin makes unattended | 1 | 1 | gate 5 |
| person start | 1 | 1 | gate 5 |
| trust check / trust save | 1 / 1 | 1 / 1 | gate 3 |
| renderer saveTrust | 1 | 1 | gate 3 |
| route / route navigation | 1 / 4 | 1 / 4 | gate 4 |
| default mode | 1 | 1 | send flow `permissionMode` |
| Ctrl+Shift+J | 0 | 0 | gate 7 |
| Navigation interface | 1 | 1 | `__cdbNavigation` (core patch sub-patch C) |

## Sub-patch anchors (Task 11)

| Sub-patch | Anchor (5.1231.2) | Count in index.js + chunks |
|---|---|---|
| A | `"use strict";` at the start of the staged `index.js` | start of file |
| B | `getClaudeCodeSessionManager:()=>TC` (index.chunk-D8I21hzf.js@2451738); `async function TC(){if(wC)return wC;let{claudeCodeSessionManager:e}=await ...` (@2452003) | key 1, `async function TC(){` 1 |
| C | `onNativeViewAttached:()=>vFi` (index.chunk-D8I21hzf.js@4576789); `function vFi(e){return _Fi.add(e),()=>{_Fi.delete(e)}}` (@4577512) | key 1, `function vFi(` 1 |

5.11492.0: B is `getClaudeCodeSessionManager:()=>DC` (index.chunk-DGzL9Hug.js@2476207) with `async function DC(){if(EC)return EC;let{claudeCodeSessionManager:e}...` (@2476472); C is `onNativeViewAttached:()=>GHi` (@4608570) with `function GHi(e){return WHi.add(e),()=>{WHi.delete(e)}}` (@4609293).

5.11492.2 (re-checked 2026-11-13): the B and C anchors moved to `index.chunk-1pEy0mTq.js` at the same offsets and names as 5.11492.0 (`getClaudeCodeSessionManager:()=>DC` @2476207, `async function DC(){` @2476472, `onNativeViewAttached:()=>GHi` @4608570, `function GHi(e){` @4609293); the session manager class (`async startSession(`, `exports.claudeCodeSessionManager=`) is in `index.chunk-CNlrPrcI.js`. Every census count equals the 5.11492.0 column.

`exports.claudeCodeSessionManager=` appears in exactly one chunk (5.1231.2, 5.11492.0 and 5.11492.2).

## Gates (spec section 8)

| # | Static result (5.1231.2, file@offset) | Decision | Constant |
|---|---|---|---|
| 1 | Attach: `onNativeViewAttached:()=>vFi` (index.chunk-D8I21hzf.js@4576789); registry `function vFi(e){return _Fi.add(e),()=>{_Fi.delete(e)}}` (@4577512); upstream's own listener (@4920349) exits its view on `"sibling_mount"`. DOM: not in any build. | Sub-patch C captures the registry; the page closes when an upstream view attaches to its window. DOM anchors: live measurement below. | `ANCHORS` (js/jira_tracker_web_page.js) |
| 2 | `LocalSessionManager.startSession` (index.chunk-Bck8_Vp0.js@2075200) calls `this.sessionWorktreeSetup.ensureSessionWorktree({sessionId:a,options:e,...})` (@2090066); it makes a worktree when `options.useWorktree===!0` (`let E=r.useWorktree===!0&&!t.iP(r,void 0)`, @1689277; lazy when GrowthBook 2464838160 is on and the start is attended, @1690641). | `useWorktree:true` for a git work tree that has a commit. | `WORKTREE_FROM_START` (js/jira_tracker_send.js) |
| 3 | Code-tab trust UI is renderer code. Main: `checkWorkspaceTrust(e)` -> `{trusted}` (Bck8_Vp0@2057265), `saveWorkspaceTrust(e,t)` (@2057996). Renderer `LocalSessions.saveTrust` (index.chunk-C2n-9Qz3.js@101105) calls `saveWorkspaceTrust(n)` without options, then `gitWorktreeManager.pinOriginAtTrust(n)`, which our code cannot reach. | Our native dialog (Trust and start / Cancel); `saveWorkspaceTrust(folder)` only after Trust and start; never `{withoutDialog:true}`. | none |
| 4 | `getSessionRoute(e){return t.Eut(e)}` (Bck8_Vp0@2182852) -> `/epitaxy/<encoded id>` (`ab="/epitaxy"`, D8I21hzf@2147803); upstream's notification click: `getDispatcher(n)?.dispatchNavigate(e.getSessionRoute(t))` (D8I21hzf@6883169). | Navigate with `globalThis.__cdbNavigation.getDispatcher(claudeView).dispatchNavigate(route)`; else a notice "Started <KEY> in <folder>". | `NAVIGATE_TO_SESSION` |
| 5 | No reusable capture (Auto-fix uses `this.sessionManager` inside AutoFixEngine only). Accessor `getClaudeCodeSessionManager:()=>TC` (D8I21hzf@2451738), `async function TC(){...}` (@2452003). `startSession` marks a session unattended when `prewarmHidden` is set, `nobodyAsked` is true, `origin` is set or `initiator` is not "user" (Bck8_Vp0@2092655; `prewarmHidden`/`nobodyAsked` are new since 4.23118.0, and our start passes neither). The person start passes `{initiator:"user"}` (C2n-9Qz3@75005). | Sub-patch B; start with `{initiator:"user"}` and no `origin` (contradicts spec 5.5 step 7, which would make the session unattended); `permissionMode` = `getDefaultPermissionMode(folder)` (Bck8_Vp0@2277731) when it is a string. | `START_ATTENDED` |
| 6 | Needs a real account. | Docs list the measured scopes. | none |
| 7 | 0 hits in the main bundle; our patches use Ctrl+Shift+T and Ctrl+P only. | Keep Ctrl+Shift+J unless 1P binds it. | `SHORTCUT_KEY` (js/jira_tracker_main.js) |

## Run-time anchors (remote claude.ai code, no build sees them)

- Row model: `a[href="/artifacts"]`, else `a[href$="/artifacts"]`, inside `[data-testid="sidebar"]`; the row box is its closest `li`. When no such link exists, the sidebar button whose own label is "Scheduled", else "Artifacts"; with several hits, the one matching `button.w-full.shrink-0`. The live run on 2026-11-13 (5.1231.2) placed the row after "Scheduled", so this path is the one in use.
- Theme: the page copies claude.ai's computed `--cds-*` variables and the page background on open, on focus, on `nativeTheme` "updated" and every 1 s while open (custom themes and claude.ai's appearance switch change CSS with no event).
- Sidebar edge: around the row model, the first of `[data-testid="sidebar"]`, `nav`, `.df-hub-rail`, `.dframe-nav-scroll`.
- Main window's claude.ai view (`mainView()` in js/jira_tracker_main.js): a child `WebContentsView` of a `BrowserWindow` contentView whose webContents is not the window's own, whose URL passes the shared sender guard's origin allowlist and is not the 3P setup page. The structural rule excludes popouts (no claude.ai child view, see the probe log below) and a window's own webContents; it does not exclude artifact popups, which only the origin allowlist keeps out. The 3P setup window is excluded by its URL.
- Page warning keys (claude.ai-web.log and claude-patches.log): `[cdb-jira] anchor:sidebar`, `[cdb-jira] anchor:row-text`, `[cdb-jira] anchor:content`, `[cdb-jira] row:error`.
- Main warning keys (claude-patches.log): `[cdb-jira] hook:native-view missing`, `[cdb-jira] hook:session-manager missing`, `[cdb-jira] navigate: no dispatcher`, `[cdb-jira] send: session manager missing`.

## Live measurements

Measured on 2026-11-11 (UTC) by the user on Ubuntu, 1P (claude.ai) only, with upstream 5.1231.2 and a temporary probe patch (`js/zz_jira_probe.js`, never committed). No 3P run.

### Probe log (gates 1, 2, 4, 5)

`grep -a '\[cdb-jira-probe\]' ~/.config/Claude/logs/claude-patches.log`:

```text
2026-11-11T16:52:25.477Z [cdb-jira-probe] dom-ready https://claude.ai placement=window 0 child 0
2026-11-11T16:52:39.704Z [cdb-jira-probe] t15 window 0 own=about:blank parent=false children=[]
2026-11-11T16:52:39.704Z [cdb-jira-probe] t15 window 1 own=file:///usr/lib/claude-desktop/resources/app.asar/.vite/renderer/main_window/index.html parent=false children=[0:https://claude.ai/epitaxy/local_4bef502e-8a3d-4aef-b83c-9af156c4bab8 preload= bounds={"x":0,"y":0,"width":1925,"height":1066} zoom=1.2]
2026-11-11T16:52:54.753Z [cdb-jira-probe] session-manager chunk: index.chunk-Bck8_Vp0.js
2026-11-11T16:52:54.756Z [cdb-jira-probe] start: trusted=true defaultMode=auto
2026-11-11T16:52:55.318Z [cdb-jira-probe] start: id=local_5943faca-8c11-4635-9bd8-23ab5c7eaf4e route=/epitaxy/local_5943faca-8c11-4635-9bd8-23ab5c7eaf4e
2026-11-11T16:53:09.704Z [cdb-jira-probe] t45 window 0 own=about:blank parent=false children=[]
2026-11-11T16:53:09.704Z [cdb-jira-probe] t45 window 1 own=about:blank parent=false children=[]
2026-11-11T16:53:09.705Z [cdb-jira-probe] t45 window 2 own=file:///usr/lib/claude-desktop/resources/app.asar/.vite/renderer/main_window/index.html parent=false children=[0:https://claude.ai/epitaxy/local_4bef502e-8a3d-4aef-b83c-9af156c4bab8 preload= bounds={"x":0,"y":0,"width":2508,"height":1440} zoom=1.2]
2026-11-11T16:53:15.318Z [cdb-jira-probe] start: worktreePath=/home/deli/Documents/briohr.worktrees/jira-probe/dazzling-hopper-27136b worktreeLazy=undefined branch=claude/dazzling-hopper-27136b
2026-11-11T16:53:15.318Z [cdb-jira-probe] start: navigated=true
```

`git -C /tmp/jira-probe worktree list`:

```text
/tmp/jira-probe                                                         4c09826 [main]
/home/deli/Documents/briohr.worktrees/jira-probe/dazzling-hopper-27136b 4c09826 [claude/dazzling-hopper-27136b]
```

- The main window showed the new "cdb-jira probe" session after the navigation.
- A popout window existed during the run. It never loaded a claude.ai document: the log has one claude.ai `dom-ready` only (the main view), and at t45 the extra window is `own=about:blank children=[]`.

### 1P sidebar DOM (gate 1)

DevTools snippet of Task 1 Step 1, on a new chat, a Cowork task, a Code session (twice) and the Scheduled page:

```text
{"path":"/new","counts":[["[data-testid=\"sidebar\"]",1],["nav",0],[".df-hub-rail",0],[".dframe-nav-scroll",1],[".df-bottom-tray",1],["a[href=\"/artifacts\"]",0],["a[href$=\"/artifacts\"]",0],["a[href=\"/routines\"]",0],["a[href$=\"/routines\"]",0]],"chain":[],"sidebar":null,"inner":[2090,1200],"active":null}
{"path":"/cowork/cse_01VZrxPuVSspmmejKrimrC5i","counts":[["[data-testid=\"sidebar\"]",1],["nav",0],[".df-hub-rail",0],[".dframe-nav-scroll",1],[".df-bottom-tray",1],["a[href=\"/artifacts\"]",0],["a[href$=\"/artifacts\"]",0],["a[href=\"/routines\"]",0],["a[href$=\"/routines\"]",0]],"chain":[],"sidebar":null,"inner":[2090,1200],"active":null}
{"path":"/epitaxy/local_5943faca-8c11-4635-9bd8-23ab5c7eaf4e","counts":[["[data-testid=\"sidebar\"]",1],["nav",1],[".df-hub-rail",0],[".dframe-nav-scroll",1],[".df-bottom-tray",1],["a[href=\"/artifacts\"]",0],["a[href$=\"/artifacts\"]",0],["a[href=\"/routines\"]",0],["a[href$=\"/routines\"]",0]],"chain":[],"sidebar":null,"inner":[2090,1200],"active":null}
{"path":"/epitaxy/local_5943faca-8c11-4635-9bd8-23ab5c7eaf4e","counts":[["[data-testid=\"sidebar\"]",1],["nav",2],[".df-hub-rail",0],[".dframe-nav-scroll",1],[".df-bottom-tray",1],["a[href=\"/artifacts\"]",0],["a[href$=\"/artifacts\"]",0],["a[href=\"/routines\"]",0],["a[href$=\"/routines\"]",0]],"chain":[],"sidebar":null,"inner":[2090,1200],"active":null}
{"path":"/epitaxy/scheduled","counts":[["[data-testid=\"sidebar\"]",1],["nav",0],[".df-hub-rail",0],[".dframe-nav-scroll",1],[".df-bottom-tray",1],["a[href=\"/artifacts\"]",0],["a[href$=\"/artifacts\"]",0],["a[href=\"/routines\"]",0],["a[href$=\"/routines\"]",0]],"chain":[],"sidebar":null,"inner":[2090,1200],"active":null}
```

The 1P sidebar has no `a[href="/artifacts"]` and no `/routines` link. A row listing on `/epitaxy` (sidebar open) showed text-only buttons: no href, no `data-testid`, no `aria-label`, classes `w-full shrink-0 border-none`, x=8 w=259 h=32, in this order: "New" (Ctrl+N), "Search" (Ctrl+Shift+K), "Artifacts" (with a nested "New from a template" button), "Scheduled", "On-call", "Customize". The sidebar root `[data-testid="sidebar"]` measured x=0 y=35.99 w=279.17 h=1164.01 in a 2090x1200 view.

A second listing (four pages, one with the sidebar collapsed) showed:

- Upstream marks the active row with `aria-current="page"` (New on `/new`, Scheduled on `/epitaxy/scheduled`, Artifacts on `/epitaxy/apps`). Row classes change with the state (the active New row is `hit-row-main flex h-full`), so rows are matched by label, with `button.w-full.shrink-0` as a tie-break only.
- Row wrappers differ per page: `div.group.hit-row` holds one row plus a 24x24 control button; `div.-mt-1` holds Scheduled, On-call and Customize together. The Jira row clones the per-row wrapper when one exists, else the button. Control buttons (no label) do not count as rows.
- A collapsed sidebar keeps its full geometry (`[-4,36,280,1164]`), but `elementFromPoint` just inside its right edge hits the content (`div.dframe-pane-scroller`). The sidebar counts as open only when `elementFromPoint(right - 20, top + 60)` is inside it; otherwise the page starts at x=0.
- `main.dframe-content` covers the whole window on every page, so it is not a content edge. The element at the sidebar edge is the resize handle (`div.cds-reset.group/resize`, x=274 w=12); the open page covers part of it.

Settings page: not measured; skipped by user decision 2026-11-12. The Jira row is not needed there, but **Open Jira** in the settings row can open the page on that route: it then starts at the right edge of `[data-testid="sidebar"]` when that sidebar is visible, else it covers the whole view.

### Shortcut (gate 7)

`[gate7] defaultPrevented=false` on every Ctrl+Shift+J press; nothing visible happened.

### Scoped token (gate 6)

The curl table was not run. On 2026-11-12 the user's scoped token with `read:jira-work`, `write:jira-work` and `read:jira-user` worked through the gateway route: `myself`, `project/search`, `search/jql`, `issue/<key>` and `issue/<key>/comment` returned 200 in `claude-patches.log`. Transitions are checked in the Task 13 re-check. The set is sufficient, not proven minimal; the docs link Atlassian's scope list.

### Decisions

| Gate | Result | Constant |
|---|---|---|
| 1 | Main claude.ai view = child 0 of the main window's contentView (zoom 1.2); popouts have no claude.ai child view. Sidebar edge: `[data-testid="sidebar"]`. Row model: no link in 1P, so the text-button fallback finds "Scheduled", else "Artifacts" (English labels only). | `ANCHORS = { row: ['a[href="/artifacts"]', 'a[href$="/artifacts"]'], rowBox: "li", rowButtons: '[data-testid="sidebar"] button', rowClass: "button.w-full.shrink-0", rowText: ["Scheduled", "Artifacts"], sidebar: ['[data-testid="sidebar"]', "nav", ".df-hub-rail", ".dframe-nav-scroll"] }` |
| 2 | `useWorktree:true` made a worktree at start (`worktreePath` set, `worktreeLazy` undefined). | `WORKTREE_FROM_START = true` |
| 4 | `dispatchNavigate(getSessionRoute(id))` showed the session. | `NAVIGATE_TO_SESSION = true` |
| 5 | One session-manager chunk (`index.chunk-Bck8_Vp0.js`); `startSession(..., {initiator:"user"})` succeeded; the user's default mode was `auto`. | `START_ATTENDED = true` |
| 6 | `read:jira-work`, `read:jira-user`, `write:jira-work` work (reads proven 2026-11-12; transitions pending Task 13). | none |
| 7 | Ctrl+Shift+J is free in 1P. | `SHORTCUT_KEY = "j"` |

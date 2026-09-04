# Built-in MCP Servers - Claude Desktop v1.13576.0

> **Roster re-verified against v1.46388.2** (2026-09-04; covers the un-audited v1.40609.0 step too): registration mechanism unchanged - `registerInternalMcpServer` still present with exactly one registration, now exported as `registerInternalMcpServer:()=>Kge` in `index.chunk-DrnJEXHK.js` (v1.40609.0: `index.chunk-Ci77nY41.js`). **Roster grew for the first time since v1.8555.2 - two new backend servers and new tools on three existing ones, none with a platform check, all available on Linux:** (1) **`ccd_pr`** (#23 below) - 5 tools `get_status`, `set_monitor`, `set_auto_merge`, `bind_pr`, `unbind_pr`; `isEnabled:e=>e.sessionType==="ccd"&&qi()` with `qi(){return t.aD("1776348311")}` (GrowthBook). (2) **`ccd_sidebar`** (#24) - 9 tools `list_groups`, `create_group`, `rename_group`, `delete_group`, `move_sessions`, `set_pinned`, `set_unread`, `mark_completed`, `set_view`; `isEnabled:e=>e.sessionType==="ccd"&&ro()` with `ro(){return t.aD("2365358358")}`. (3) `ccd_session` gained **`start_session`** and **`hand_off_to_session`** (flag `2371478310`, built as ``mcp__${fs}__${gs}`` template literals). (4) `ccd_directory` gained **`propose_branch`** (surfaced to the model only when `setupTools===!0`). (5) `scheduled-tasks` now has flat literals `mcp__scheduled-tasks__create_scheduled_task` / `update_scheduled_task` (1 each; the tools themselves were already listed in #11). The known-server-name enum array grew **16 -> 19** (`+ccd_session`, `+ccd_pr`, `+ccd_sidebar`), now ``["claude_in_chrome","claude_browser","claude_preview","claude_code_ios_simulator","claude_code_android_emulator","computer_use","framebuffer","plugins","skills","mcp_registry","scheduled_tasks","cowork","session_info","dispatch","remote_devices","ccd_directory","ccd_session","ccd_pr","ccd_sidebar"]``. No server or tool was removed or renamed. Server-name literal counts identical for 22/29 roster names; the drifters are the new servers (`ccd_pr` 0 -> 1 as a server literal, `ccd_sidebar` 0 -> 1, `ccd_session` 1 -> 2 for the enum entry) plus non-registration call sites (`terminal` 40 -> 43, `skills` 28 -> 33, `cowork` 119 -> 126, `workspace` 19 -> 20, `computer-use` 5 -> 4 / `computer_use` 3 -> 4). Two grep notes: the minifier is back to **double-quoted** string literals (0 backtick hits in v1.46388.2; v1.26832.0 .. v1.40609.0 were backtick), so keep the ``[`"]`` quote class; and the **`index2.chunk-*` family is gone** - 158 `index.chunk-*` files, `index*.js` still globs everything. The bundled Microsoft 365 server is **byte-identical to v1.40609.0** (`office365-mcp.mjs` 7,322,713 B; it had grown from 7,320,850 B in v1.37937.0 with `pdfExtractorProcess.mjs` 425,295 B and `pdf.worker.mjs` 1,089,813 B unchanged). Chunk stats: `index.chunk-*` 85 -> 158, `index2.chunk-*` 52 -> 0, `index.pre.js` 846,690 -> 891,104 B, packaged `app.asar` 33,718,534 -> 36,619,584 B; `@anthropic-ai/claude-agent-sdk` 0.3.247 -> 0.3.260.
>
> **Counting method (v1.46388.2).** Audit concat = `cat .vite/build/index*.js` (160 files: `index.pre.js` + `index.js` + 158 chunks; 139 on v1.40609.0 with both families). Use GNU `grep -a` or python - the bundles contain NUL bytes and `rg -a` can silently return nothing:
>
> - `grep -aoF 'serverName:' "$CONCAT" | wc -l` -> **119** on v1.46388.2 (**116** on v1.40609.0 and v1.37937.0). The +3 are the `ccd_pr` and `ccd_sidebar` registrations plus one further per-session server-builder call site.
> - `grep -aoE 'mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+' "$CONCAT" | wc -l` -> **76** (63 on v1.40609.0); `| sort -u | wc -l` -> **49 unique** (42 on v1.40609.0). The +7 unique are `mcp__ccd_session__start_session`, `mcp__ccd_session__hand_off_to_session`, `mcp__ccd_session_mgmt__get_session`, `mcp__ccd_session_mgmt__send_message`, `mcp__remote-devices__computer_` (a prefix test in the tool-classifier, not a tool), `mcp__scheduled-tasks__create_scheduled_task`, `mcp__scheduled-tasks__update_scheduled_task`. The `ccd_pr` / `ccd_sidebar` tool ids are template literals and do NOT appear here - the server-name literal count and the enum array are what flag new servers, so run all three checks.
> - The "17 unique" recorded for v1.37937.0 below could not be reproduced: the same command yields 42 on v1.40609.0. Method mismatch again, not a regression - trust the commands above.
>
> **Roster re-verified against v1.37937.0** (2026-08-26): registration mechanism unchanged - `registerInternalMcpServer` still present with exactly one registration, now exported as `registerInternalMcpServer:()=>Mo`. The known-server-name enum array is **byte-identical** at 16 entries (`claude_in_chrome`, `claude_browser`, `claude_preview`, `claude_code_ios_simulator`, `claude_code_android_emulator`, `computer_use`, `framebuffer`, `plugins`, `skills`, `mcp_registry`, `scheduled_tasks`, `cowork`, `session_info`, `dispatch`, `remote_devices`, `ccd_directory`) - **no server added, removed, or renamed.** **One roster change:** the `plugins` server gained a tool, **`search_connectors`** (`mcp__plugins__search_connectors`) - ``{name:`search_connectors`,description:`Search the user's organization plugin library for connectors (MCP servers) bundled inside plugins...`}``, dispatched by ``if(e===`search_connectors`&&t.r_().type===`3p`){...}``. It is gated on **3p mode only, with no platform check**, so it is available on Linux. Server-name literal counts are identical for 15/21 roster names; the six that drifted are all non-registration call sites (`terminal` 33 -> 37, `skills` 21 -> 23, `dispatch` 6 -> 8, `cowork` 102 -> 112, `workspace` 15 -> 16, `scheduled_tasks` 3 -> 4). The bundled Microsoft 365 server grew slightly - `office365-mcp.mjs` 7,320,090 -> 7,320,850 B - with **`pdfExtractorProcess.mjs` byte-identical** and `pdf.worker.mjs` shrinking 2,056,364 -> 1,089,813 B; its **tool-name inventory is unchanged** (``diff <(rg -ao 'name:"[a-z0-9_]+"' OLD/resources/office365-mcp/office365-mcp.mjs|sort -u) <(rg -ao 'name:"[a-z0-9_]+"' NEW/.../office365-mcp.mjs|sort -u)`` is empty). Chunk stats: `index.chunk-*` 74 -> 75, `index2.chunk-*` 48 -> 52, `index.pre.js` 792,064 -> 821,513 B, packaged `app.asar` 32,952,736 B.
>
> **Counting method for the two roster counts (record the command with the number).** Every count in this paragraph comes from the audit concat `cat .vite/build/index*.js` (which globs `index.pre.js` + `index.js` + both `index.chunk-*` and `index2.chunk-*` families - 129 files on v1.37937.0, 124 on v1.34493.1):
>
> - `rg -ao 'serverName:' "$CONCAT" | wc -l` -> **116** on v1.37937.0 **and 116 on v1.34493.1** (unchanged).
> - `rg -ao 'mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+' "$CONCAT" | wc -l` -> **63** (was 61); piping the same through `| sort -u | wc -l` -> **17 unique** (was 16). The whole delta is the two occurrences of the one new `mcp__plugins__search_connectors` literal.
>
> The figures recorded in the v1.34493.1 note below (`serverName:` 135; "124 literals" / 41 unique) **could not be reproduced by those commands on either release** - they return 116 and 61/16 on the v1.34493.1 bundle too. That is a **method mismatch, not a regression**: the earlier numbers were produced by some other scope or pattern that was never written down. Trust the commands above, and keep writing the command next to the number so the next audit can reproduce it.
>
> **Roster re-verified against v1.34493.1** (2026-08-22): registration mechanism unchanged - `registerInternalMcpServer` still present with exactly one registration, now exported as `registerInternalMcpServer:()=>hhe` in `index.chunk-RiH_RK8u.js`. **One roster change:** the `ccd_directory` server gained a second tool, `change_directory` (`mcp__ccd_directory__change_directory`) - see #20 below. No servers added, removed, or renamed; `serverName:` occurrences hold at 135. Because the two `ccd_directory` tool ids are built as template literals (`` mcp__${cn}__${ln} ``), the flat `mcp__<server>__<tool>` literal set is unchanged (124 literals across `index*.js`) and would NOT have caught this - the server-name literal count is what flagged it, so run that check, not only the literal-set diff. Server-name literal counts identical for 19/22 roster names; the three that drifted are all non-registration call sites (`ccd_directory` 1 -> 2: the new tool; `workspace` 13 -> 15: two more `open(…,"workspace")` filesystem-scope call sites; `cowork` 101 -> 102: a telemetry surface validator `e==="chat"||e==="cowork"||e==="code"?e:null`). The known-server-name enum array also gained `ccd_directory` (16 entries, was 15: `claude_in_chrome`, `claude_browser`, `claude_preview`, `claude_code_ios_simulator`, `claude_code_android_emulator`, `computer_use`, `framebuffer`, `plugins`, `skills`, `mcp_registry`, `scheduled_tasks`, `cowork`, `session_info`, `dispatch`, `remote_devices`, `ccd_directory`). The bundled Microsoft 365 server is byte-identical to v1.32885.1 (`office365-mcp.mjs` 7,320,090 B, `pdfExtractorProcess.mjs` and `pdf.worker.mjs` unchanged). Chunk stats: `index.chunk-*` stays 74, `index2.chunk-*` 39 -> 48, `index.pre.js` 789,604 -> 792,064 B.
>
> **Prior roster note - verified unchanged through v1.32885.1** (2026-08-19): `registerInternalMcpServer` still present (exactly one registration, now exported as `registerInternalMcpServer:()=>po` in `index.chunk-CdfeLm1B.js`), and the full `mcp__<server>__<tool>` literal set is byte-identical to v1.32352.1 (41 unique literals) - no servers or tools added, removed, or renamed. Server-name literal counts identical for 18/21 roster names; the three that drifted are all non-registration call sites (terminal 31 -> 33: OAuth token-refresh error paths; dispatch 5 -> 6: a generic event-dispatcher helper; cowork 100 -> 101: a session-count telemetry filter). The bundled Microsoft 365 server is NOT byte-identical this release - `office365-mcp.mjs` grew 7,284,722 -> 7,320,090 bytes (with `pdfExtractorProcess.mjs` also changed, `pdf.worker.mjs` identical): a security hardening that strips excerpts from `sharepoint_search`/`sharepoint_folder_search` results and logs a `sharepoint_search_excerpts_stripped` security event; its tool-name inventory is unchanged. Chunk stats: `index.chunk-*` stays 74, `index2.chunk-*` 38 -> 39, `index.pre.js` ~0.79 MB.
>
> **Prior roster note - verified unchanged through v1.32352.1** (2026-08-18): `registerInternalMcpServer` still present (exactly one registration, exported as `registerInternalMcpServer:()=>Yve` in `index.chunk-BFWQf1ai.js`), every server-name literal from the roster below keeps a count identical to v1.30096.1, and the full `mcp__<server>__<tool>` literal set is byte-identical between the two versions - no servers or tools added or removed. The bundled Microsoft 365 server (`office365-mcp.mjs`) still ships in app.asar, byte-identical.
>
> Note when re-running the roster grep on v1.32352.1: the bundler switched to Rolldown (the `heavy-work-worker/esm-*.js` helper became `rolldown-runtime-*.js`). Two output changes affect greps: all non-ASCII characters in string literals are now `\uXXXX`-escaped (raw em-dashes/arrows no longer appear as bytes), and function expressions/arrows passed as call arguments are parenthesized (`.on(x,(e=>{...}))`). The `index2` chunk family re-split 30 -> 38 (104 -> 112 chunks total) and `index.pre.js` shrank 4.67 -> 0.78 MB with the code moving into the chunks - grep across `.vite/build/index*.js`, never a single file.
>
> **Prior roster note - verified unchanged through v1.30096.1** (2026-08-14): `registerInternalMcpServer` still present (1 call in the code-split main bundle) and every server-name literal from the roster below still registers exactly once (computer-use, terminal, visualize, Claude Preview, skills, radar, dispatch, cowork, Framebuffer, Window Halo, ccd_session, ccd_directory, ccd_session_mgmt, mcp-registry, Claude in Chrome, cowork-onboarding, dev-debug, scheduled-tasks, session_info, workspace, plugins). The full `mcp__<server>__<tool>` literal set is byte-identical between v1.28929.0 and v1.30096.1 - no servers or tools added or removed. The bundled Microsoft 365 server (`office365-mcp.mjs`) still ships in app.asar.
>
> Note when re-running the roster grep on v1.30096.1: rollup re-chunked the main bundle, consolidating it from 339 chunks to 104 (`index.chunk-*` 209 -> 74, `index2.chunk-*` 130 -> 30). Roughly 4.3 MB of code moved from the `index2` family into the `index` family, so the two stems are no longer split the way they were. The logical bundle the orchestrator stages (`index.js` + both chunk families) is essentially unchanged in size: 11.68 -> 11.63 MB. Grep across `.vite/build/index*.js` - both stems - or a server that merely moved stems will read as removed.
>
> **Prior roster note - verified unchanged through v1.28929.0** (2026-08-12): `registerInternalMcpServer` still present (1 call in the code-split main bundle) and every server-name literal from the roster below still appears with counts identical to v1.26832.0. The full `mcp__<server>__<tool>` literal set is byte-identical between v1.26832.0 and v1.28929.0 - no servers or tools added or removed.
>
> **Prior roster note - verified unchanged through v1.26832.0** (2026-08-08): `registerInternalMcpServer` still present (1 call) and every server-name literal from the v1.18286.0 roster still registers (computer-use, terminal, visualize, Claude Preview, skills, radar, dispatch, cowork, Framebuffer, Window Halo, ccd_session, mcp-registry, Claude in Chrome). Note: since v1.26832.0 the minifier emits BACKTICK string literals, so anchor greps must use a quote-tolerant class, e.g. ``rg -a 'name:[`"]computer-use[`"]'``. The bundled Microsoft 365 server (`office365-mcp.mjs`) still ships in app.asar.
>
> **Prior roster note - verified unchanged through v1.18286.0** (2026-07-03): `registerInternalMcpServer` present (1 call), all server-name literals stable with identical counts vs v1.17377.1 (computer-use, terminal, visualize, Claude Preview, skills, radar, dispatch, cowork, Framebuffer, Window Halo, ccd_session, mcp-registry, Claude in Chrome). No servers added or removed. The tool tables below still describe v1.13576.0 minified names.
>
> **Prior roster note (v1.13576.0, 2026-06-17):** No internal servers added/removed since v1.8555.2. The minified registration names shifted again (full re-minify v1.12603.1 -> v1.13576.0); `registerInternalMcpServer` is still present and the renderer-facing registration fn is still resolvable (the v1.12603.0 name `iAe()` will have shifted - re-anchor on `registerInternalMcpServer` or the server-UUID map). Server-name strings and the tool tables remain accurate. The bundled 3P **Microsoft 365** MCP server (`office365-mcp`) still ships inside `app.asar` (see the dedicated section below).

Claude Desktop registers internal MCP servers via a two-layer architecture:

1. **Renderer-facing layer (`iAe()` in v1.12603.0, was `KqA()` in v1.11847.5, `uqA()` in v1.11187.4, `LYA()` in v1.8555.2)** - servers accessible from the BrowserView via Electron `MessageChannelMain` ports
2. **Backend/session layer** - servers providing tools to CCD/Cowork sessions

A server may appear in both layers (e.g., Chrome, mcp-registry) or only one.

## Registration System

```
iAe(serverName, displayLabel, factoryFn)   // v1.12603.0 (was KqA() in v1.11847.5, uqA() in v1.11187.4, LYA() in v1.8555.2, jHA() in v1.9659.4, lrA() in v1.8089.1, unchanged since v1.7196.0 before that; was BrA() in v1.6608.2, qwA() in v1.5354.0, gpA() in v1.3561.0, DfA() in v1.3109.0, kce() in v1.3036.0)
```

- Lazy singleton factory per server name; stored in `YL` (registry, v1.12603.0; was `CT` in v1.11847.5, `sT` in v1.11187.4, `QN` before) + `jVA` (display labels, v1.12603.0; was `TUA` in v1.11847.5, `cUA` in v1.11187.4, `pkA` before)
- UUID display label sent to renderer for identification
- `s9()` (v1.12603.0; was `J3()` in v1.11847.5, `b3()` in v1.11187.4, `k4()` before) enumerates registered server names via `Object.keys(YL)`
- Signature unchanged: `(serverName, displayLabel, factoryFn)`

## Renderer-Facing Servers (via `LYA()`)

### 1. Claude in Chrome

| Field | Value |
|-------|-------|
| Server name | `"Claude in Chrome"` |
| Platform | All (socket path adapts per OS) |
| Gating | `chromeExtensionEnabled` preference (default: `true`) |

Communicates with the Chrome browser extension via Unix socket at `/tmp/claude-mcp-browser-bridge-<username>/0.sock`.

**Tools (22):**

| Tool | Description |
|------|-------------|
| `javascript_tool` | Execute JS in page context |
| `read_page` | Accessibility tree of page elements |
| `find` | Find elements by natural language |
| `form_input` | Set form element values by ref |
| `computer` | Mouse/keyboard + screenshots (browser-level) |
| `navigate` | Navigate to URL or go back/forward |
| `resize_window` | Resize browser window |
| `gif_creator` | Record and export browser action GIFs |
| `upload_image` | Upload screenshot/image to file input or drop target |
| `get_page_text` | Extract raw text from page |
| `read_console_messages` | Read browser console messages |
| `read_network_requests` | Read HTTP network requests |
| `shortcuts_list` | List available shortcuts/workflows |
| `shortcuts_execute` | Execute a shortcut/workflow |
| `file_upload` | Upload local files to file input |
| `switch_browser` | Switch which Chrome to control (only with bridge config) |
| `tabs_context_mcp` | Get tab group context and tab IDs |
| `tabs_create_mcp` | Create new tab in MCP tab group |
| `tabs_close_mcp` | Close a tab in MCP tab group |
| `browser_batch` | Execute a sequence of browser tool calls in one round trip |
| `list_connected_browsers` | List all Chrome browsers connected to this account |
| `select_browser` | Select a specific Chrome browser by deviceId |

### 2. MCP Registry

| Field | Value |
|-------|-------|
| Server name | `"mcp-registry"` |
| Platform | All |
| Gating | Always enabled |

The `LYA()` registration is a **stub returning no tools**. Actual tools are provided via the backend session layer.

**Tools (via P8t):**

| Tool | Description |
|------|-------------|
| `search_mcp_registry` | Search for available connectors by keywords |
| `suggest_connectors` | Display connector suggestions with Connect buttons |
| `list_connectors` | Lists installed connectors as interactive card |

### 3. Office Add-in

| Field | Value |
|-------|-------|
| Server name | `"office-addin"` |
| Status | **Removed as MCP server in v1.8555.2** - moved to IPC bridge |

No longer registered via `LYA()` and no longer in the backend server array. The `office_addin_run` and `office_addin_task` MCP tools are gone. Functionality has moved to an IPC-only bridge pattern using handlers like `focusOfficeDocument`, `focusBrowserTab`, etc.

Previously (v1.8089.0-v1.8089.1): used listener/dispatcher pattern (`initOfficeAddinBridgeListener`) with 2 tools (`office_addin_run`, `office_addin_task`). Before that (pre-v1.8089.0): had 5 tools and was platform-gated to macOS/Windows.

## Backend-Only Servers (not registered via `LYA()`)

These are accessible to CCD/Cowork sessions but not directly from the renderer.

### 4. Plugins

| Field | Value |
|-------|-------|
| Server name | `"plugins"` |
| Gating | Always enabled |

| Tool | Description |
|------|-------------|
| `suggest_plugin_install` | Suggest plugins for the user to install |
| `search_plugins` | Search available plugins |
| `list_plugins` | Lists installed plugins as interactive card |

### 5. Visualize (Imagine)

| Field | Value |
|-------|-------|
| Server name | `"visualize"` (constant `oCr`) |
| Factory | `sCr()` via `getImagineServerDef` |
| Gating | GrowthBook flag `3444158716` + (Cowork session OR CCD session with flag `2204227020`) |
| Platform | All (no platform gate) |
| Linux status | Follows Anthropic's server rollout (no platform gate); opt-in via `claude-desktop-bin.jsonc` `growthbookOverrides` `"3444158716": true` (+ `"3516166472": true` for CCD) |
| Resource URI | `ui://imagine/show-widget.html` |

Renders inline SVG graphics, HTML diagrams, charts, mockups, data visualizations, and elicitation forms directly in the chat UI. Uses a sandboxed iframe renderer with CSP allowing `esm.sh`, `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`.

| Tool | Description |
|------|-------------|
| `show_widget` | Render SVG or HTML content inline. Input: `{loading_messages: string[], title: string, widget_code: string}`. Returns static confirmation text. `widget_code` can be raw SVG (starts with `<svg>`) or HTML (no DOCTYPE/html/head/body). CSS variables available for theming. Scripts run after streaming completes. |
| `read_me` | Returns CSS variables, colors, typography, layout rules, and module-specific guidance for widget rendering. Input: `{modules?: ["diagram"|"mockup"|"interactive"|"data_viz"|"art"|"chart"|"elicitation"][]}`. Read-only (`annotations:{readOnlyHint:true}`). |

**Modules:** diagram (SVG flowcharts/graphs), mockup (UI layouts), interactive (dynamic widgets), data_viz (Chart.js + D3 choropleths), art (illustrations), chart (data charts), elicitation (forms with `.elicit-*` classes, pills, file upload).

**System prompt:** The `imagineSystemPrompt` field comes from the claude.ai backend during session creation. When present AND the flag is enabled, it's injected into the cowork session system prompt. If the backend doesn't send it (depends on account tier/rollout), the tools still appear and work - the model just doesn't get the specialized rendering instructions.

**`sendPrompt(text)`:** Global JS function available inside widgets that sends a message to chat as if the user typed it.

### 6. Claude Preview

| Field | Value |
|-------|-------|
| Server name | `"Claude Preview"` (constant `ToA`) |
| Gating | Server flag `2976814254` + CCD session + `launchEnabled` preference (default: `true`) |
| Platform | All (no platform gate) |
| Linux status | **Not implemented** - server flag `2976814254` is not force-enabled by our patches. The feature works architecturally (no platform blocks), but is waiting for Anthropic to enable the flag server-side. |

Local dev server manager + browser inspector. Lets the model start dev servers, take screenshots, inspect DOM elements, fill forms, click buttons, run JS, and monitor logs/network - all without the user switching windows.

**How it works:**

1. **Configuration:** User creates `.claude/launch.json` in the project root:
   ```json
   {
     "version": "0.0.1",
     "configurations": [
       {
         "name": "frontend",
         "runtimeExecutable": "npm",
         "runtimeArgs": ["run", "dev"],
         "port": 3000,
         "autoPort": true
       }
     ]
   }
   ```
2. **Activation:** When `launchEnabled` is on and the server flag is active, the session system prompt gets a `<preview_tools>` block injected telling the model to use `preview_*` tools instead of Bash for running servers.
3. **Model calls `preview_start`:** Desktop reads `.claude/launch.json`, spawns the configured command as a child process, polls the port until HTTP responds.
4. **Preview panel:** An Electron `WebContentsView` (sandboxed, localhost-only) loads `http://localhost:<port>`. Chrome DevTools Protocol (CDP) is connected for automation.
5. **Feedback loop:** Model edits source code, reloads via `preview_eval`, verifies changes via screenshot/snapshot/inspect, reports back with visual proof.

The preview panel blocks all navigation to non-localhost URLs.

**Tools (13):**

Server management (no timeout):

| Tool | Description |
|------|-------------|
| `preview_start` | Start a dev server by name from `.claude/launch.json`. Reuses if already running |
| `preview_stop` | Stop a running server |
| `preview_list` | List running servers and their IDs |
| `preview_logs` | Server stdout/stderr output (build errors, debug). Filterable by level/search |
| `preview_console_logs` | Browser console output (log/warn/error). Filterable by level |

Browser interaction (30-second timeout each):

| Tool | Description |
|------|-------------|
| `preview_screenshot` | Take JPEG screenshot of the page (layout check, not precise style verification) |
| `preview_snapshot` | Accessibility tree snapshot - text content, roles, element UIDs. Preferred over screenshot |
| `preview_inspect` | Inspect DOM element by CSS selector - computed styles, bounding box, className |
| `preview_click` | Click element by CSS selector. Supports double-click |
| `preview_fill` | Fill input/textarea/select by CSS selector and value |
| `preview_eval` | Execute JS in page context - debugging/inspection only, not for UI changes |
| `preview_network` | List network requests or inspect a response body by requestId |
| `preview_resize` | Resize viewport - presets (mobile/tablet/desktop), custom dimensions, dark mode emulation |

### 7. Terminal

| Field | Value |
|-------|-------|
| Server name | `"terminal"` (constant `gCr`) |
| Factory | `ECr()` via `getTerminalServerDef` |
| Platform | **All** (macOS, Windows, Linux) - upstream **dropped** the old `pj` (darwin\|\|win32) platform gate; `isEnabled` is now `sessionType==="ccd"&&!isSSH` with no platform check |
| Gating | `t.sessionType === "ccd"` AND `!t.isSSH` AND server flag `397125142` (no platform gate as of v1.17377) |
| Session types | **CCD only** - NOT available in Cowork sessions. The `sessionType==="ccd"` check is hardcoded in `isEnabled` |
| Backend | `node-pty` - spawns a PTY shell, streams output to xterm.js terminal panel in the UI. node-pty ships pre-built for Linux in the official `.deb` |
| Linux status | **Works natively** - no platform gate remains; the old `fix_dispatch_linux.nim` `pj` patch is removed (patch deleted; Dispatch/terminal upstream-native on Linux) |

| Tool | Description |
|------|-------------|
| `read_terminal` | Read the last ~200 lines of the integrated terminal panel (ANSI codes stripped). Use when the user references test output, errors, or logs visible in their terminal. Returns error if terminal panel is not open |

**Why not in Cowork?** In Cowork sessions, the model has `mcp__workspace__bash` which runs shell commands directly on the host (on Linux - no sandbox). This is strictly more powerful than `read_terminal` (which can only *read* the terminal panel, not execute commands). The terminal server is designed for CCD sessions where the model observes a user-controlled terminal rather than running its own commands.

**node-pty dependency:** The terminal backend requires `node-pty` to spawn PTY processes. Upstream ships only Windows PE32+ binaries. The build script rebuilds node-pty from npm source against Electron headers via `@electron/rebuild`. If the rebuild fails (logged as warning), the terminal panel and `read_terminal` tool are unavailable but Claude Desktop runs normally.

### 8. Cowork Onboarding

| Field | Value |
|-------|-------|
| Server name | `"cowork-onboarding"` |
| Gating | Cowork session + GrowthBook flag `2114777685` |
| Added in | v1.1062.0 |

Renders an interactive role-picker UI during Cowork onboarding so the user can select their job function and get a matching plugin installed.

| Tool | Description |
|------|-------------|
| `show_onboarding_role_picker` | Render a clickable role-picker chip row during Cowork onboarding. Call this when asking the user what kind of work they do so they can pick their role and get a matching plugin installed. The role list is hardcoded in the frontend - call with no args. |

**Restrictions:** Added to `BRIDGE_DISALLOWED_TOOLS` (disabled in dispatch-child sessions) and disabled for scheduled tasks.

### 9. Dev Debug

| Field | Value |
|-------|-------|
| Server name | `"dev-debug"` |
| Gating | Cowork session only |

| Tool | Description |
|------|-------------|
| `get_roots` | Get MCP roots |

### 10. Radar

| Field | Value |
|-------|-------|
| Server name | `"radar"` |
| Gating | Dynamically enabled per-session via `YKt` Map; server registration has `isEnabled:()=>!1` (disabled at MCP level) |
| Platform | All (no platform gate) |
| Added in | v1.1617.0 |

An AI-powered inbox scanner that reads from user's remote MCP servers (Gmail, Slack, GitHub, Linear, etc.) and extracts actionable items directed at the user. Currently **not activatable** - the session creation mechanism lives in the renderer/web layer, and the server-level `isEnabled` returns false.

| Tool | Description |
|------|-------------|
| `record_card` | Record one actionable item pointed at the user. Call once per item - an @-mention waiting on a reply, a review request, a direct ask. The `source_ref` must be the stable upstream identifier (Gmail thread ID, Slack message ts, GitHub owner/repo#N) so re-runs map to the same card. |
| `retire_card` | Retire a previously-surfaced card whose upstream item is no longer actionable |

**`record_card` input schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Short headline naming the ask |
| `context` | string | Yes | Two or three sentences. Who, what, when it landed |
| `source` | string | Yes | Connector name: gmail, slack, github, linear, ... |
| `source_ref` | string | Yes | Stable upstream identifier - thread ID, message ts, issue/PR ref. Dedup key |
| `prompt` | string | Yes | First message for the spawned Cowork session. Self-contained - the new session has not seen this run |
| `urgency` | enum | Yes | `"high"`, `"medium"`, or `"low"` |
| `external_url` | string | No | Direct link to the source item |

**Session type:** `radar` sessions get restricted tool access - only `mcp__radar__record_card` plus remote MCP server tools. All other tools are stripped. Permission requests are auto-denied (`"${tool} requires approval and radar sessions can't prompt - skipped."`). Radar sessions are hidden from the user (classified alongside `agent` and `dispatch_child` in `jL()`).

### 11. Scheduled Tasks

| Field | Value |
|-------|-------|
| Server name | `"scheduled-tasks"` (constant `iJA`, hyphenated) |
| Registration | `createScheduledTasksServer()` (aliased `DHt`), injected per-session into CCD and Cowork session managers |
| Tool prefix | `mcp__scheduled-tasks__` |

| Tool | Description |
|------|-------------|
| `list_scheduled_tasks` | List scheduled tasks |
| `create_scheduled_task` | Create a new scheduled task |
| `update_scheduled_task` | Update an existing scheduled task |

### 12. CCD Session

| Field | Value |
|-------|-------|
| Server name | `"ccd_session"` |
| Gating | CCD session; `start_session` / `hand_off_to_session` additionally behind GrowthBook `2371478310` (v1.46388.2; the old `1585356617` gate literal is gone from the bundle) |
| Platform | All - no platform check |

**New in v1.1.9134.** Allows the model to spawn a parallel task into its own separate CCD session.

| Tool | Description |
|------|-------------|
| `spawn_task` | Spin off a parallel task into a separate Claude Code Desktop session |
| `dismiss_task` | Dismiss a spawned task (present since at least v1.40609.0; was missing from this table) |
| `mark_chapter` | Flag an out-of-scope issue for a separate background task |
| `start_session` | **New in v1.46388.2.** Start a separate Claude Code session for a task while staying with the user; `initiation` says who wants it (`user_asked` starts it now and returns its id). Flag `2371478310` |
| `hand_off_to_session` | **New in v1.46388.2.** Hand the current conversation off to another session. Flag `2371478310` |

The `spawn_task` tool requires desktop approval card injection - cannot be auto-approved by hooks or permission rules.

### 18. Skills

| Field | Value |
|-------|-------|
| Server name | `"skills"` (constant `I6e`) |
| Gating | Cowork session + `skillsEnabled !== false` |
| Added in | v1.6259.1 |

| Tool | Description |
|------|-------------|
| `list_skills` | Render the user's slash-menu skills as an interactive widget |
| `search_skills` | Search available skills |
| `suggest_skills` | Renders widget of skills the user can add |

### 19. Framebuffer

| Field | Value |
|-------|-------|
| Server name | `"Framebuffer"` |
| Platform | All (no platform gate) |
| Gating | **Hardcoded disabled** (`isEnabled: () => false`) |
| Added in | ≤v1.6608.0 (documented in v1.6608.2) |

Infrastructure for future remote display/VM framebuffer control. Currently disabled - `isEnabled` returns `false` unconditionally. Backend/session-level.

| Tool | Description |
|------|-------------|
| `framebuffer_attach` | Attach to a framebuffer |
| `framebuffer_batch` | Execute a sequence of framebuffer actions |
| `framebuffer_click` | Click at coordinates in framebuffer |
| `framebuffer_cursor_position` | Get cursor position in framebuffer |
| `framebuffer_drag` | Drag within framebuffer |
| `framebuffer_hold_key` | Hold a key in framebuffer context |
| `framebuffer_key` | Press a key in framebuffer context |
| `framebuffer_list` | List available framebuffers |
| `framebuffer_move` | Move cursor in framebuffer |
| `framebuffer_screenshot` | Take a framebuffer screenshot |
| `framebuffer_scroll` | Scroll in framebuffer |
| `framebuffer_type` | Type text in framebuffer context |
| `framebuffer_zoom` | Zoom into a framebuffer region |

### 20. CCD Directory

| Field | Value |
|-------|-------|
| Server name | `"ccd_directory"` |
| Gating | Non-SSH CCD sessions (`isEnabled: e=>e.sessionType==="ccd"&&!e.isSSH` - no platform gate, works on Linux) |
| Added in | ≤v1.6608.0 (documented in v1.6608.2) |

| Tool | Description |
|------|-------------|
| `request_directory` | Grant access to a directory outside the working directory. With `path` the user approves that exact folder; without it a native folder picker opens |
| `change_directory` | **New in v1.34493.1.** Move the session to a different project directory. `path` is required. Access is granted immediately; the working directory (Bash, relative paths, project settings) moves at the end of the current turn. Refused for sessions in an isolated worktree or on a remote host |
| `propose_branch` | **New in v1.46388.2.** Offered only when the session's `setupTools` is on: once the session is in a Git repository and right before the first file edit, propose a short branch name; the user sees a card and answers. Ids `mcp__ccd_directory__propose_branch`; the two older tools stay in the always-allowed set (`Mn=new Set([On,kn])`), `propose_branch` does not |

### 21. CCD Session Management

| Field | Value |
|-------|-------|
| Server name | `"ccd_session_mgmt"` |
| Gating | CCD sessions |
| Added in | ≤v1.6608.0 (documented in v1.6608.2) |

| Tool | Description |
|------|-------------|
| `list_sessions` | List the user's other CCD sessions (active and optionally archived) |
| `get_session` | Read one session's metadata (flat literal `mcp__ccd_session_mgmt__get_session` since v1.46388.2) |
| `search_session_transcripts` | Search across CCD session transcripts |
| `list_events` | List a session's events |
| `archive_session` | Archive a CCD session |
| `set_session_title` | Rename a session (emits `ccdSessionRenamed`) |
| `send_message` | Deliver a message to another session (flat literal `mcp__ccd_session_mgmt__send_message` since v1.46388.2; 7 tools total, all present since at least v1.40609.0) |

### 22. Window Halo

| Field | Value |
|-------|-------|
| Server name | `"Window Halo"` |
| Platform | macOS only - returns error on non-darwin |
| Gating | `isEnabled:()=>process.platform==="darwin"&&!1` - hardcoded disabled even on macOS |
| Added in | v1.8555.2 |

Draws a colored glow effect behind the macOS application window to visually indicate when the model has control. Currently **not activatable** - `isEnabled` returns `false` unconditionally (hardcoded `&&!1`).

Backend: `@ant/claude-swift` `.sessionHalo` module.

| Tool | Description |
|------|-------------|
| `halo_attach` | Draw colored glow behind macOS app window to indicate model control |
| `halo_detach` | Remove the halo |

### 23. CCD PR

| Field | Value |
|-------|-------|
| Server name | `"ccd_pr"` (constant `H` in v1.46388.2, `index.chunk-CG6yIyHG.js`) |
| Gating | `isEnabled:e=>e.sessionType==="ccd"&&qi()` with `function qi(){return t.aD("1776348311")}` (GrowthBook) - **no platform check**, works on Linux |
| Added in | v1.46388.2 (v1.40609.0 only had the `desktop_ccd_pr_bar_*` telemetry names) |

Lets a Code session drive the PR bar: bind a pull request, switch its CI monitor on or off, toggle GitHub auto-merge. The mutating tools (`set_monitor`, `set_auto_merge`, `bind_pr`, `unbind_pr`) sit in a dedicated approval set (`Ki=new Set([Hi,Ui,Wi,Gi])`); `get_status` is read-only.

| Tool | Description |
|------|-------------|
| `get_status` | Report the bound PR (URL, state, CI/monitor status) |
| `set_monitor` | Turn the session's CI monitor switches on or off for its bound, open PR (the CI popover's checkboxes): wake on CI failures, merge conflicts and review comments |
| `set_auto_merge` | Enable or disable GitHub auto-merge on the bound PR at `url` (github.com only) |
| `bind_pr` | Bind a pull request URL to this session's PR bar |
| `unbind_pr` | Dismiss the bound PR from this session's PR bar; the monitor stops watching it, `bind_pr` restores |

### 24. CCD Sidebar

| Field | Value |
|-------|-------|
| Server name | `"ccd_sidebar"` (constant `Ia` in v1.46388.2, `index.chunk-CG6yIyHG.js`) |
| Gating | `isEnabled:e=>e.sessionType==="ccd"&&ro()` with `function ro(){return t.aD("2365358358")}` (GrowthBook) - **no platform check**, works on Linux |
| Added in | v1.46388.2 |

Lets a Code session organise the sessions sidebar. Tool ids are built as ``q=e=>`mcp__${Ia}__${e}` `` (template literals - invisible to the flat `mcp__` grep). `list_groups`, `create_group` and `set_view` are the read/low-risk set (`eo`), `rename_group`/`move_sessions`/`set_pinned`/`set_unread`/`mark_completed` the approval set (`to`), `delete_group` stands alone.

| Tool | Description |
|------|-------------|
| `list_groups` | List sidebar groups |
| `create_group` | Create a sidebar group (`name`, 1 to `io` characters) |
| `rename_group` | Rename a group |
| `delete_group` | Delete a group |
| `move_sessions` | Move sessions between groups |
| `set_pinned` | Pin or unpin sessions |
| `set_unread` | Set or clear the unread marker |
| `mark_completed` | Mark sessions completed |
| `set_view` | Switch the sidebar view |

## Per-Session Dynamic MCP Servers (SDK-type)

Claude Desktop creates 4 additional MCP servers **dynamically per cowork/dispatch session**. These are NOT registered via `LYA()` - they are created inline in the session manager and passed to the Claude Code CLI via `sdkMcpServers` in `--mcp-config`.

**Communication:** SDK-type servers use `MessagePort` bridges. On Mac/Windows, the VM SDK daemon (`nodeHost.js`) provides this bridge via vsock. On Linux native, `cowork-svc-linux` now **passes `--mcp-config` through unchanged** (since commit `d1dfc3b`). The CLI sends `control_request` messages on stdout, which flow through the event stream to Claude Desktop. Desktop's session manager intercepts them and sends `control_response` back via writeStdin - identical to VM mode on Mac/Windows.

### 13. Dispatch

| Field | Value |
|-------|-------|
| Server name | `"dispatch"` (constant `Of`) |
| Tool prefix | `mcp__dispatch__` |
| Session type | Agent (dispatch parent) sessions only |
| Registration | Dynamic via `f6t()` factory |
| Linux status | **Available** - via `control_request`/`control_response` proxy over event stream (since cowork-svc commit `d1dfc3b`) |

| Tool | Variable | Description |
|------|----------|-------------|
| `start_task` | `Hdt` | Start a new isolated cowork task session. Takes `{prompt, title, space_id?}` |
| `start_code_task` | `gRe` | Start a Claude Code session on host filesystem. Takes `{cwd, prompt, title}` |
| `send_message` | `Vdt` | Send a follow-up message to an existing session. Takes `{session_id, message}` |
| `set_agent_name` | `Wdt` | Set the agent's display name. Gated by flag `3558849738` |
| `list_code_workspaces` | `Gdt` | List available code workspaces. Gated by flag `3723845789` |
| `list_projects` | `Kdt` | List available projects |

**Important:** `mcp__dispatch__send_message` is **NOT** a replacement for the built-in `SendUserMessage` CLI tool - they serve completely different purposes. `send_message` sends a follow-up message **to another session** (inter-session communication, takes `{session_id, message}`). `SendUserMessage` sends a response **to the human user** (renders on phone, takes `{message, attachments?}`). Historically `SendUserMessage` was broken ([anthropics/claude-code#35076](https://github.com/anthropics/claude-code/issues/35076), confirmed on v2.1.85) and an older `fix_dispatch_linux` sub-patch ("Patch I") compensated by transforming plain-text assistant messages into synthetic `SendUserMessage` tool_use blocks. **That is no longer needed:** the bundled Claude Code is now v2.1.197 and Dispatch responses render on phone natively (live-tested v1.17377). The entire `fix_dispatch_linux` patch has been removed - Dispatch is upstream-native on Linux.

### 14. Cowork

| Field | Value |
|-------|-------|
| Server name | `"cowork"` (constant `lA`) |
| Tool prefix | `mcp__cowork__` |
| Session type | All cowork sessions |
| Registration | Dynamic via `l6t()` factory |
| Linux status | **Available** - via `control_request`/`control_response` proxy over event stream (since cowork-svc commit `d1dfc3b`) |

| Tool | Variable | Description |
|------|----------|-------------|
| `present_files` | `_Re` | Present files to user with interactive cards. Takes `{files: [{file_path}]}`. Handler returns file paths as text content |
| `request_cowork_directory` | `h0` | Request access to a host directory. Opens native folder picker (local sessions) or resolves path (remote). Denied in headless/dispatch-child without explicit `path` |
| `allow_cowork_file_delete` | `uR` | Allow deletion of files in cowork directory. Enriches input with `_folderName` for permission UI |
| `launch_code_session` | - | Launch a Claude Code session from within cowork. Conditional on `canLaunchCodeSession` |
| `create_artifact` | - | Create a self-contained HTML artifact (inline CSS/JS, data: URLs for images). Conditional on GrowthBook flag `2940196192` (**new in v1.1348.0**) |
| `update_artifact` | - | Update an existing artifact. Same constraints as `create_artifact`. Conditional on GrowthBook flag `2940196192` (**new in v1.1348.0**) |
| `save_skill` | - | Save a reusable skill to the user's account. Conditional on `canSaveSkill` (**new in v1.1348.0**) |
| `propose_skills` | - | Propose skills for the user to save |
| `list_artifacts` | - | List existing artifacts (used before `update_artifact`). **New in v1.8555.2** |
| `read_widget_context` | - | Read context from a rendered widget. **New in v1.8555.2** |

**Note:** `present_files`, `allow_cowork_file_delete`, `launch_code_session`, `create_artifact`, and `update_artifact` are added to `disallowedTools` for bridge/dispatch-child sessions. On Linux native, `cowork-svc-linux` removes `present_files` from `disallowedTools` as a workaround for file sharing.

### 15. Session Info

| Field | Value |
|-------|-------|
| Server name | `"session_info"` (constant `Lx`) |
| Tool prefix | `mcp__session_info__` |
| Session type | All except dispatch-child sessions |
| Registration | Dynamic via `p1e()` factory |
| Linux status | **Available** - via `control_request`/`control_response` proxy over event stream (since cowork-svc commit `d1dfc3b`) |

| Tool | Variable | Description |
|------|----------|-------------|
| `list_sessions` | `qdt` | List child sessions and all sessions |
| `read_transcript` | `zdt` | Read transcript of a session |

### 16. Workspace

| Field | Value |
|-------|-------|
| Server name | `"workspace"` (constant `J_`) |
| Tool prefix | `mcp__workspace__` |
| Session type | Cowork sessions |
| Registration | Dynamic per-session |
| Linux status | **Available** - via `control_request`/`control_response` proxy over event stream (since cowork-svc commit `d1dfc3b`) |

| Tool | Variable | Description |
|------|----------|-------------|
| `bash` | `Jdt` | Run bash commands in workspace context |
| `web_fetch` | `Xdt` | Fetch web resources |

**Bash tool description (Edn function):** The tool description is constructed dynamically via string concatenation: `"Run a shell command in the session's isolated Linux workspace. Your connected folders are mounted under /sessions/" + t.vmProcessName + "/mnt/ - ..."`. This is now accurate on Linux too: the official `.deb` runs Cowork in a real VM (the bundled QEMU/OVMF backend), so shell commands do execute in an isolated Linux workspace with `/sessions/.../mnt/` mounts. The old `fix_cowork_sandbox_refs.nim` (Patch A) - which rewrote this to "no VM, runs on the host" for the MSIX-era native Go backend - was **removed** in the `.deb` pivot; the upstream text is correct as-is.

**System prompt sandbox references:** The upstream cowork system prompt tells the model it runs in "a lightweight Linux VM (Ubuntu 22) ... secure sandbox". On the official `.deb` this is true (Cowork runs in the bundled VM), so the old host-accurate rewrite (`fix_cowork_sandbox_refs.nim` Patches B-D) was **removed** in the pivot - the upstream sandbox text now matches reality.

### SDK Server Architecture

```
Mac/Windows (VM):
  Claude Desktop main process
    ├─ creates dispatch/cowork/session_info/workspace server instances
    ├─ passes via sdkMcpServers in --mcp-config to VM
    ├─ VM SDK daemon (nodeHost.js) creates MessagePort bridges
    └─ Claude Code CLI connects via MessagePort → tool calls route back to Desktop

Linux native (current, since cowork-svc commit d1dfc3b):
  Claude Desktop main process
    ├─ creates same server instances
    ├─ passes via sdkMcpServers in --mcp-config to cowork-svc
    ├─ cowork-svc passes --mcp-config through unchanged
    ├─ Claude Code CLI sends control_request on stdout for MCP tool calls
    ├─ cowork-svc forwards via event stream to Desktop session manager
    ├─ Desktop sends control_response back via writeStdin
    └─ SDK MCP tools available (identical to VM mode)
       → Patch I still needed: SendUserMessage CLI built-in is broken
         (anthropics/claude-code#35076), sessions API only renders
         SendUserMessage blocks on phone
```

### Dynamic Per-Artifact MCP Servers (`cowork-artifact-<id>`)

When a Cowork session creates artifacts, Claude Desktop registers **dynamic** MCP servers named `cowork-artifact-<uuid>` for each artifact. These are NOT statically registered via `LYA()` - they are created inline per artifact. The `cowork-artifact` string also serves as an Electron custom protocol scheme (`cowork-artifact:`) for rendering artifact content in the UI.

**Not a static server** - no tools to document. Not registered via `LYA()`. Calls route via `callRemoteTool("cowork-artifact-<id>", ...)`.

### Bundled 3P "builtin" MCP Server: Microsoft 365 (`office365-mcp`)

| Field | Value |
|-------|-------|
| Connector server id | `"microsoft365"` (connector directory entry `{name:"Microsoft 365",kind:"builtin",item:{name:"Microsoft 365",server:"microsoft365"}}`) |
| MCP server name (inside bundle) | `mcp-ms-graph` |
| Bundle location | `app.asar` -> `resources/office365-mcp/office365-mcp.mjs` (6.5 MB) + `pdfExtractorProcess.mjs` + `pdf.worker.mjs`. Resolved via `app.getAppPath()/resources/office365-mcp/office365-mcp.mjs` |
| Shipped since | **v1.12603.0** - the loader code existed in v1.11847.5 but the bundle was absent (`"the bundled Microsoft 365 server is not included in this build"`) |
| Transport | Spawned child process (stdio), spawn timeout 30s (60s on win32), per-server stderr log via `getBuiltinMcpServerLogger("office365-builtin")` |
| Auth | MSAL delegated OAuth. Cache at `<userData>/builtin-mcp-auth/<server>/...`; encrypted `msal-cache.enc` via Electron `safeStorage` when available; legacy plaintext `~/.mcp-office365/msal-cache.json` is wiped |
| Cloud environments | `["global","us-gov-high","us-gov-dod"]` with per-environment `authority`/`graph` hosts (v1.12603.0; v1.11847.5 had a flat `login.microsoftonline.com/.us` -> graph host map) |
| Write scopes | On public (packaged) builds, write scopes `["Mail.Send","Mail.ReadWrite","Calendars.ReadWrite"]` are withheld; granted scopes passed to the child via `MCP_GRANTED_DELEGATED_SCOPES` env (new in v1.12603.0) |
| Platform | All - no platform gate. Works on Linux unpatched (verify `safeStorage` falls back cleanly without a keyring) |

This is NOT an internal MCP server (not registered via `iAe()`), but a 3P connector of `kind:"builtin"` whose MCP server binary is bundled with the app instead of being remote. Tool inventory (from the bundle, Microsoft Graph): Outlook mail/drafts/calendar (`outlook_email_search`, `outlook_send_mail`, `outlook_create_event`, ...), OneDrive (`onedrive_drive`, `onedrive_file`), SharePoint (`sharepoint_search`, `sharepoint_site`, `sharepoint_site_page`, `sharepoint_folder_search`), Teams chat (`chat_message_search`, `chat_message`), plus PDF text extraction via a dedicated worker process.

### Anthropic API Built-in Tool: `web_search`

| Field | Value |
|-------|-------|
| Type | `web_search_20250305` (Anthropic API built-in, like `computer_use`) |
| Name | `web_search` |
| Gating | `enable_web_search` feature flag |

This is NOT a custom MCP tool - it's an Anthropic API built-in tool type passed directly in the API request as `{type:"web_search_20250305",name:"web_search"}`. Referenced in the `Nzn` exclusion set alongside compute tools.

### AllowedTools for Dispatch Sessions

Claude Desktop constructs the `allowedTools` array per session type:

```javascript
// For agent (dispatch parent) sessions:
allowedTools: [
  /* CLI built-ins: */ "Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", ...
  /* Always allowed: */ "mcp__cowork__present_files",
  /* Dispatch-only: */ "SendUserMessage", "mcp__dispatch__start_task",
                        "mcp__dispatch__send_message", "mcp__dispatch__list_projects",
  /* Conditional: */   "mcp__dispatch__set_agent_name",       // flag 3558849738
                        "mcp__dispatch__list_code_workspaces", // flag 3723845789
]

// disallowedTools for bridge/dispatch-child:
disallowedTools: ["AskUserQuestion", "mcp__cowork__allow_cowork_file_delete",
                   "mcp__cowork__present_files", "mcp__cowork__launch_code_session"]
```

### 17. Computer Use

| Field | Value |
|-------|-------|
| Server name | `"computer-use"` (constant `c9e`, was `l5e` in v1.7196.0, `p6t` pre-v1.6608.0) |
| Tool prefix | `mcp__computer-use__` |
| Platform | macOS (native), **Linux (patched)** |
| Gating (macOS/Windows) | Set-based: `uoA()` checks `BoA = new Set(["darwin","win32"])` + `chicagoEnabled` preference (was `QoA`/`qDA` in earlier versions) |
| Gating (Linux) | Enabled via Set modification (add "linux" to `BoA`) + feature flag and preference bypassed |
| Internal codename | "chicago" |

**Background:** Computer-use was previously a separate `computer-use-server.js` file in the app root (removed in v1.1.7714). As of v1.1.8359, it's fully integrated into `index.js` as an internal MCP server. In v1.1.9134, 5 new tools were added (multi-monitor, batch actions, teach mode).

**Feature flag (v1.3561.0):** Computer-use has a **triple gate**: (1) `BoA` Set platform check (`QoA()`), (2) static registry `computerUse` flag (`status` key), and (3) runtime enabled check (reading GrowthBook `chicago_config.enabled` + `chicagoEnabled` preference). Our patches bypass all three: `fix_computer_use_linux.nim` adds "linux" to `BoA` (gate 1), forces registration gate true on Linux, and forces runtime gate true on Linux (bypasses both GrowthBook and the `chicagoEnabled` preference). `enable_local_agent_mode.nim` Patch 3 overrides `computerUse` to `{status:"supported"}` (gate 2). The Settings toggle for CU is rendered server-side by claude.ai's web UI and hidden on Linux - runtime bypass means no toggle is needed.

**Tools (27):**

Tool definitions are built by `V7r()` with platform-dependent descriptions. On Linux, sub-patch 13 overrides key descriptions to remove macOS-specific references (Finder, bundle identifiers, allowlist gates). Below are the **upstream descriptions** (verbatim from v1.569.0 `index.js`), with platform-variant notes.

**Shared suffix (`Lf`):** Most action tools append: *"The frontmost application must be in the session allowlist at the time of this call, or this tool returns an error and does nothing."* - on Linux this is set to empty string (sub-patch 13a) since the allowlist is bypassed.

| Tool | Upstream description (verbatim, v1.569.0) |
|------|-------------|
| `request_access` | **Platform-dependent prefix:** macOS: *"This computer is running macOS. The file manager is 'Finder'."* / Windows: *"This computer is running Windows. The file manager is 'File Explorer' (not Finder). Elevated processes - Task Manager, UAC prompts, installers running as administrator - cannot be controlled even when granted: Windows UIPI blocks input from lower-integrity processes. If one appears, ask the user to handle it manually."* / **Linux (patched):** *"This computer is running Linux. On Linux, ALL applications are automatically accessible at full tier without explicit permission grants. You do NOT need to call request_access before using other tools. If called, it returns synthetic grant confirmations. The file manager depends on the desktop environment (e.g. Nautilus on GNOME, Dolphin on KDE, Thunar on XFCE)."* **Suffix (all platforms):** *"Request user permission to control a set of applications for this session. Must be called before any other tool in this server. The user sees a single dialog listing all requested apps and either allows the whole set or denies it. Call this again mid-session to add more apps; previously granted apps remain granted. Returns the granted apps, denied apps, and screenshot filtering capability."* |
| `screenshot` | **Platform-dependent (via `screenshotFiltering`):** native: *"Take a screenshot of the primary display. Applications not in the session allowlist are excluded at the compositor level - only granted apps and the desktop are visible."* / mask: *"...masked with a solid rectangle - their content is hidden from you, but the rectangle's position shows where the window is."* / none (**Linux**): *"Take a screenshot of the primary display. All open windows are visible."* (patched; upstream adds *"...Input actions targeting apps not in the session allowlist are rejected."*) **Suffix:** *"Returns an error if the allowlist is empty. The returned image is what subsequent click coordinates are relative to."* (on Linux, patched to remove allowlist-empty error) |
| `left_click` | *"Left-click at the given coordinates. `${Lf}`"* |
| `right_click` | *"Right-click at the given coordinates. Opens a context menu in most applications. `${Lf}`"* |
| `double_click` | *"Double-click at the given coordinates. Selects a word in most text editors. `${Lf}`"* |
| `triple_click` | *"Triple-click at the given coordinates. Selects a line in most text editors. `${Lf}`"* |
| `middle_click` | *"Middle-click (scroll-wheel click) at the given coordinates. `${Lf}`"* |
| `type` | *"Type text into whatever currently has keyboard focus. `${Lf}` Newlines are supported. For keyboard shortcuts use `key` instead."* |
| `key` | *"Press a key or key combination (e.g. 'return', 'escape', 'cmd+a', 'ctrl+shift+tab'). `${Lf}` System-level combos (quit app, switch app, lock screen) require the `systemKeyCombos` grant - without it they return an error. All other combos work."* |
| `scroll` | *"Scroll at the given coordinates. `${Lf}`"* |
| `left_click_drag` | *"Press, move to target, and release. `${Lf}`"* |
| `mouse_move` | *"Move the mouse cursor without clicking. Useful for triggering hover states. `${Lf}`"* |
| `hold_key` | *"Press and hold a key or key combination for the specified duration, then release. `${Lf}` System-level combos require the `systemKeyCombos` grant."* |
| `left_mouse_down` | *"Press the left mouse button at the current cursor position and leave it held. `${Lf}` Use mouse_move first to position the cursor. Call left_mouse_up to release. Errors if the button is already held."* |
| `left_mouse_up` | *"Release the left mouse button at the current cursor position. `${Lf}` Pairs with left_mouse_down. Safe to call even if the button is not currently held."* |
| `cursor_position` | *"Get the current mouse cursor position. Returns image-pixel coordinates relative to the most recent screenshot, or logical points if no screenshot has been taken."* |
| `wait` | *"Wait for a specified duration."* |
| `zoom` | *"Take a higher-resolution screenshot of a specific region of the last full-screen screenshot. Use this liberally to inspect small text, button labels, or fine UI details that are hard to read in the downsampled full-screen image. IMPORTANT: Coordinates in subsequent click calls always refer to the full-screen screenshot, never the zoomed image. This tool is read-only for inspecting detail."* |
| `open_application` | *"Bring an application to the front, launching it if necessary. The target application must already be in the session allowlist - call request_access first."* - **Linux (patched):** *"Bring an application to the front, launching it if necessary. On Linux, all applications are directly accessible."* |
| `list_granted_applications` | *"List the applications currently in the session allowlist, plus the active grant flags and coordinate mode. No side effects."* |
| `read_clipboard` | *"Read the current clipboard contents as text. Requires the `clipboardRead` grant."* |
| `write_clipboard` | *"Write text to the clipboard. Requires the `clipboardWrite` grant."* |
| `switch_display` | *"Switch which monitor subsequent screenshots capture. Use this when the application you need is on a different monitor than the one shown. The screenshot tool tells you which monitor it captured and lists other attached monitors by name - pass one of those names here. After switching, call screenshot to see the new monitor. Pass 'auto' to return to automatic monitor selection."* |
| `computer_batch` | *"Execute a sequence of actions in ONE tool call. Each individual tool call requires a model→API round trip (seconds); batching a predictable sequence eliminates all but one. Use this whenever you can predict the outcome of several actions ahead - e.g. click a field, type into it, press Return. Actions execute sequentially and stop on the first error. `${Lf}` The frontmost check runs before EACH action inside the batch - if an action opens a non-allowed app, the next action's gate fires and the batch stops there. Mid-batch screenshot actions are allowed for inspection but coordinates in subsequent clicks always refer to the PRE-BATCH full-screen screenshot."* |
| `request_teach_access` | *"Request permission to guide the user through a task step-by-step with on-screen tooltips. Use this INSTEAD OF request_access when the user wants to LEARN how to do something (phrases like 'teach me', 'walk me through', 'show me how', 'help me learn'). On approval the main Claude window hides and a fullscreen tooltip overlay appears. You then call teach_step repeatedly; each call shows one tooltip and waits for the user to click Next. Same app-allowlist semantics as request_access, but no clipboard/system-key flags. Teach mode ends automatically when your turn ends."* |
| `teach_step` | *"Show one guided-tour tooltip and wait for the user to click Next. On Next, execute the actions, take a fresh screenshot, and return both - you do NOT need a separate screenshot call between steps. The returned image shows the state after your actions ran; anchor the next teach_step against it. IMPORTANT - the user only sees the tooltip during teach mode. Put ALL narration in `explanation`. Text you emit outside teach_step calls is NOT visible until teach mode ends. Pack as many actions as possible into each step's `actions` array - the user waits through the whole round trip between clicks, so one step that fills a form beats five steps that fill one field each. Returns {exited:true} if the user clicks Exit - do not call teach_step again after that. Take an initial screenshot before your FIRST teach_step to anchor it."* |
| `teach_batch` | *"Queue multiple teach steps in one tool call. Parallels computer_batch: N steps → one model↔API round trip instead of N. Each step still shows a tooltip and waits for the user's Next click, but YOU aren't waiting for a round trip between steps. You can call teach_batch multiple times in one tour - treat each batch as one predictable SEGMENT (typically: all the steps on one page). The returned screenshot shows the state after the batch's final actions; anchor the NEXT teach_batch against it. WITHIN a batch, all anchors and click coordinates refer to the PRE-BATCH screenshot (same invariant as computer_batch) - for steps 2+ in a batch, either omit anchor (centered tooltip) or target elements you know won't have moved. Good pattern: batch 5 tooltips on page A (last step navigates) → read returned screenshot → batch 3 tooltips on page B → done. Returns {exited:true, stepsCompleted:N} if the user clicks Exit - do NOT call again after that; {stepsCompleted, stepFailed, ...} if an action errors mid-batch; otherwise {stepsCompleted, results:[...]} plus a final screenshot. Fall back to individual teach_step calls when you need to react to each intermediate screenshot."* |

#### macOS executor

Uses `createDarwinExecutor()` -> `@ant/claude-swift` native module for screen capture, mouse/keyboard control, app management, and TCC permission grants.

#### Linux executor (`fix_computer_use_linux.nim`)

`fix_computer_use_linux.nim` applies 13 sub-patches + 3 system prompt fixes:

| # | Sub-patch | What it does |
|---|-----------|-------------|
| 1 | Inject `__linuxExecutor` | Linux executor using xdotool/scrot/Electron APIs at `app.on("ready")` |
| 2 | Add "linux" to `BoA` Set | `new Set(["darwin","win32"])` -> `new Set(["darwin","win32","linux"])` - fixes all `QoA()` gates (server push, chicagoEnabled, overlay init) |
| 3 | Patch `createDarwinExecutor` | Return `__linuxExecutor` on Linux instead of throwing |
| 4 | Patch `ensureOsPermissions` | Return `{granted: true}` on Linux (skip macOS TCC checks) |
| 5 | Bypass permission model | Direct tool dispatch on Linux, skip allowlist/tier system |
| 6 | Teach overlay controller | Verify `vee()` gate runs on Linux (handled by Set fix) |
| 7 | Teach overlay mouse polling | Tooltip-bounds polling for Linux (X11 {forward:true} not supported) |
| 8 | Neutralize setIgnoreMouseEvents | Prevent upstream resets from fighting with polling |
| 9 | VM-aware teach transparency | Dark backdrop on VMs, full transparency on native hardware |
| 10 | Force `mVt()` isEnabled on Linux | Bypass GrowthBook `enabled:false` - tools registered for ALL session types (CCD, cowork, dispatch) |
| 11 | Force `rj()` true on Linux | Bypass both GrowthBook `enabled:false` AND `chicagoEnabled` preference - `isDisabled()` returns false, no config entry needed. The Settings toggle is rendered by claude.ai's web UI (server-side, not patchable), so on Linux CU is always enabled |
| 13 | Linux-aware tool descriptions | 7 sub-patches (13a-13g) fix tool descriptions for Linux: (a) `Lf` allowlist gate warning -> empty on Linux, (b) `request_access` says "Linux" not "macOS"/"Finder", (c-d) app identifiers use WM_CLASS not bundle IDs, (e) `open_application` no allowlist needed, (f-g) `screenshot` removes allowlist references. Non-fatal - descriptions don't affect functionality |
| 14 | Linux-aware CU system prompt | 3 sub-patches (14a-14c) fix the CU system prompt injected into CCD/cuOnlyMode sessions: (a) "Separate filesystems" -> "Same filesystem" on Linux (no sandbox - CLI and desktop share the same machine), (b) macOS app names "Finder, Photos, System Settings" -> generic "the file manager, image viewer, terminal emulator, system settings" (works across all distros: Arch, Ubuntu, Fedora, NixOS), (c) file manager name "Finder" -> "Files" on Linux |

**Linux tools used:**

| Tool | Package | Purpose |
|------|---------|---------|
| `xdotool` | `xdotool` | Mouse, keyboard, window info |
| `scrot` | `scrot` | Screenshots (with `-a` for per-monitor capture) |
| `import` | `imagemagick` | Fallback screenshots, zoom/crop |
| `wmctrl` | `wmctrl` | Running application detection |
| Electron `clipboard` | built-in | Clipboard read/write |
| Electron `screen` | built-in | Display/monitor enumeration |
| Electron `desktopCapturer` | built-in | Screenshot fallback (last resort) |

**Key differences from macOS:**
- No TCC permissions - all tools work immediately without `request_access`
- No app tier restrictions - can type into any window (no "click only" for editors)
- No app hiding before screenshots (`screenshotFiltering: "none"`)
- `request_access` returns "granted" immediately (model may still call it)
- X11/XWayland only (native Wayland not yet supported for global input)

**TCC permission queries:** upstream registers a `ComputerUseTcc` implementation on every platform (real TCC on macOS, a `not-supported` fallback elsewhere), so renderer-side permission queries answer natively on Linux. The former `fix_computer_use_tcc.nim` stub patch was removed 2026-08-12 as upstreamed.

## Linux Notes

- **Claude in Chrome**: Works on Linux via `fix_browser_tools_linux.nim` - runs on upstream's bundled `resources/chrome-native-host` (shipped in the .deb since v1.26832.0); our patch adds Chromium/Brave/Vivaldi/Opera browser discovery, installs NativeMessagingHosts manifests for 6 Linux browsers, the extension auto-install path and the DevTools opener. Requires the [Claude in Chrome](https://chromewebstore.google.com/detail/claude-code/fcoeoabgfenejglbffodgkkbkcdhcgfn) extension.
- **Office Add-in**: Removed as MCP server in v1.8555.2 - moved to IPC bridge. Previously platform-gated to macOS/Windows; patched to enable on Linux via `fix_office_addin_linux.nim`.
- **Terminal (`read_terminal`)**: CCD sessions only - `isEnabled` is `sessionType==="ccd"&&!isSSH` (hardcoded, not patchable without changing session semantics). NOT available in Cowork sessions. In Cowork, the model uses `mcp__workspace__bash` instead which runs directly on the host. **No platform gate** - upstream dropped the old `pj` (darwin\|\|win32) check, so it works on Linux natively (the `fix_dispatch_linux` patch that used to flip `pj` is removed). node-pty ships pre-built for Linux in the official `.deb`.
- **Computer Use**: Works on Linux via `fix_computer_use_linux.nim` - uses xdotool/scrot + Electron built-in APIs (clipboard, screen, desktopCapturer) instead of `@ant/claude-swift`. Available in Cowork and Code sessions.
- **Visualize (Imagine)**: No platform gate - follows Anthropic's server rollout on Linux; users can force it via `claude-desktop-bin.jsonc` `growthbookOverrides` (`"3444158716": true`, plus `"3516166472": true` for CCD). Renders SVG/HTML inline in cowork sessions.
- **Radar**: Not yet activatable - server disabled at MCP level, session creation in renderer code. No platform gate. Future feature.
- **MCP Registry / Plugins / Scheduled Tasks**: Cross-platform, work on Linux.
- **Integrated Terminal (node-pty)**: The official `.deb` bundles a pre-built `node-pty` (`pty.node` + `spawn-helper`) for x86_64 and arm64, which the repackage preserves. Enables the integrated terminal panel and `read_terminal` MCP tool on Linux with no source rebuild.
- **Cowork sandbox descriptions**: Upstream system prompts and tool descriptions tell the model it runs in "a lightweight Linux VM (Ubuntu 22)" with "an isolated sandbox". On the official `.deb` this is accurate (Cowork runs in the bundled VM backend), so the old `fix_cowork_sandbox_refs.nim` rewrite was removed in the pivot.

## Operon IPC System (v1.1617.0)

Not an MCP server, but an internal IPC layer introduced in v1.1.8359. In v1.8089.0, Operon references are greatly reduced - the explicit sub-interface registrations appear to have been cleaned up or refactored. Only cache cleanup paths (`operon-skills-cache`, `operon-byoa-skills-cache`, `operon-agents`) and a legacy sidebar mode check remain in the bundle.

Previously (through v1.7196.0), Operon had 120+ endpoints across 33 sub-interfaces:

`OperonAgentConfig`, `OperonAgents`, `OperonAnalytics`, `OperonAnnotations`, `OperonApiKeys`, `OperonArtifactDownloads`, `OperonArtifacts`, `OperonAssembly`, `OperonAttachments`, `OperonBootstrap`, `OperonCloud`, `OperonConversations`, `OperonDesktop`, `OperonEvents`, `OperonExportBundle`, `OperonFolders`, `OperonFrames`, `OperonHostAccess`, `OperonHostAccessProvider`, `OperonImageProvider`, `OperonMcp`, `OperonMcpToolAccessProvider`, `OperonNotes`, `OperonPreferences`, `OperonProjects`, `OperonQuitHandler`, `OperonReplay`, `OperonSDK`, `OperonSecrets`, `OperonServices`, `OperonSessionManager`, `OperonSkills`, `OperonSkillsSync`, `OperonSystem`

Was gated behind GrowthBook flag `1306813456` - currently **unavailable** on all platforms (not enabled server-side). Do NOT force-enable; requires VM infrastructure (Nest).

When active, Operon provided 14 "brain tools" (multi-agent delegation, skills, dashboards, planning), 7 "compute tools" (bash, python, R, artifacts, packages), 1 dynamic tool (`skill`), and 4 internal LLM tools. See [CLAUDE_FEATURE_FLAGS.md - Operon Tool Inventory](CLAUDE_FEATURE_FLAGS.md#operon-tool-inventory-v11348) for the full catalog.

## Version Notes

| Version | Changes |
|---------|---------|
| v1.46388.2 | Registration export `registerInternalMcpServer:()=>Kge` (`index.chunk-DrnJEXHK.js`); minifier back to double-quoted strings; `index2.chunk-*` family gone (158 `index.chunk-*`). **Two new backend servers: `ccd_pr`** (5 tools, flag `1776348311`) **and `ccd_sidebar`** (9 tools, flag `2365358358`), both `sessionType==="ccd"` with no platform check. **New tools:** `start_session` + `hand_off_to_session` on `ccd_session` (flag `2371478310`), `propose_branch` on `ccd_directory` (setup-tools only), flat `create_scheduled_task`/`update_scheduled_task` literals for `scheduled-tasks`. Known-server enum 16 -> 19. `serverName:` 116 -> 119, `mcp__` literals 63/42 -> 76/49 unique. M365 server byte-identical to v1.40609.0. Agent SDK 0.3.247 -> 0.3.260. |
| v1.40609.0 | Auto-released, no manual audit at the time; reconstructed during the v1.46388.2 audit: no roster change vs v1.37937.0 (`serverName:` 116, enum 16 entries), M365 server grew 7,320,850 -> 7,322,713 B with unchanged tool inventory. |
| v1.12603.0 | Registration function renamed `KqA()`->`iAe()` (verified via `registerInternalMcpServer:iAe`, `function iAe(A,e,t){return YL[A]=t,jVA[A]=e,...}`). Registry `CT`->`YL`, display-label map `TUA`->`jVA`, enumerator `J3()`->`s9()`. **No new or removed internal MCP servers or tools** - backend server-name array still 10 entries, server-UUID map byte-identical to v1.11847.5. **Microsoft 365 bundled server now ships**: `resources/office365-mcp/` (office365-mcp.mjs 6.5 MB + pdf extractor) added inside app.asar; loader existed in v1.11847.5 but bundle was missing. New M365 auth behavior: encrypted `msal-cache.enc` via safeStorage, GovCloud environments (`us-gov-high`, `us-gov-dod`), write scopes withheld on public builds (`MCP_GRANTED_DELEGATED_SCOPES`). New tool on the remote-device (DO bridge, codename "shrimp") tool set: `device_request_folder_access` gated by new flag `2745857735` (existing `device_list_dir`/`device_stage_files`/`device_commit_files`/`device_bash` unchanged). Chrome server instructions now recommend preloading `browser_batch`. Bundle embeds a **second copy of @anthropic-ai/claude-agent-sdk** (0.3.167 alongside 0.3.170) - explains most of the +1.4 MB index.js growth. All 50 patches compatible. |
| v1.11847.5 | Registration function renamed `uqA()`->`KqA()` (verified via `registerInternalMcpServer:KqA`, `function KqA(A,e,t){return CT[A]=t,TUA[A]=e,...}`). Registry `sT`->`CT`, display-label map `cUA`->`TUA`, enumerator `b3()`->`J3()`. **No new or removed MCP servers or tools**; roster identical to v1.8555.2 (22 servers + 4 per-session SDK + dynamic per-artifact). `yL` server-UUID map unchanged (21 entries incl. reserved `ios_simulator`/`android_emulator`/`echo`/`office`). `office-addin` remains an IPC bridge only (not an MCP server). All 48 patches compatible without code changes. |
| v1.11187.4 | Registration function renamed `LYA()`/`uqA()` chain; registry `QN`->`sT`, labels `pkA`->`cUA`, enumerator `k4()`->`b3()`. No new or removed MCP servers or tools. |
| v1.9659.1 | Registration function renamed `KPA()`->`HHA()` (verified via `registerInternalMcpServer:HHA`). mcp-registry const `OEA`->`mlA`. **Server roster and tool sets unchanged**: no new or removed servers, no new or removed built-in tools (apparent count bumps per server are all the extra `yL`-map occurrence, +1 each, not new registrations). **New static `yL` server-UUID map** mapping server names to fixed UUIDs, feeding a new `server_uuid` field into the existing internal-tool telemetry (`server_type:"internal"`, `tool_name`, `is_error`, `duration_ms`); in v1.9255.2 these UUIDs were scattered single constants. Three reserved/inactive labels in `yL` with no server implementation yet: `ios_simulator` and `android_emulator` (both new, precursors for future iOS-simulator / Android-emulator MCP servers), plus `echo`. `office` stays in the map but remains an IPC bridge (not an MCP server) since v1.8555.2. Cowork protocol (`control_request`/`control_response` event-stream proxy) unchanged: claude-cowork-service not affected. All 47 patches compatible without code changes. |
| v1.9255.2 | Registration function renamed `LYA()`->`KPA()` (not documented at the time; reconstructed during the v1.9659.1 audit). Webpack re-minify point release on top of v1.9255.0; no new or removed MCP servers or tools vs v1.8555.2. |
| v1.8555.2 | Registration function renamed `lrA()`->`LYA()`. Registry `I_`->`QN`, labels `FSA`->`pkA`, enumerator `h1()`->`k4()`. Backend server array `Xxi`->`Osr` (10->11 entries). **New MCP server: `Window Halo`** (macOS only, hardcoded disabled; `halo_attach`, `halo_detach` tools via `@ant/claude-swift`). **Office-addin removed as MCP server** - no longer registered via `LYA()`, tools `office_addin_run`/`office_addin_task` gone, functionality moved to IPC bridge (`focusOfficeDocument`, `focusBrowserTab`, etc.). **New tools on existing servers:** `list_connectors` (mcp-registry), `list_plugins` (plugins), `suggest_skills` (skills), `list_artifacts` and `read_widget_context` (cowork). |
| v1.8089.0 | Registration function `lrA()` unchanged. Platform gate renamed `OiA`->`pj` (`Lr\|\|Io`). Computer-use Set `BoA`->`NcA`. **No new MCP servers**, no removed servers. Visualize now also enabled for CCD sessions (flag `2204227020`). **Office-addin platform gate removed upstream** - tools refactored from 5 to 2 (`office_addin_run`, `office_addin_task`); architecture changed to listener/dispatcher. Variable renames: terminal `Egi`->`gCr`, Claude Preview `lNe`->`ToA`, skills `k1r`->`I6e`, scheduled-tasks `qBe`->`iJA`. All patches compatible. |
| v1.7196.0 | Registration function reverted `BrA()`->`lrA()`. Labels `xSA`->`FSA`. Registry storage `I_` unchanged. Enumerator `pq()`->`h1()`. Computer-use Set `QoA`->`BoA`. Platform gate combo `OiA` unchanged (`or\|\|fn`). **No new MCP servers**, no removed servers, no new tools. All patches compatible (3 refreshed by @boommasterxd). |
| v1.6608.2 | Registration function renamed `BrA()` (was `lrA()`). Registry storage `MG`->`I_`, labels `VqA`->`xSA`, enumerator `Y7()`->`pq()`. **No new MCP servers** - Framebuffer, ccd_directory, ccd_session_mgmt already present in v1.6608.0; now documented as standalone entries (#19-#21). All patches compatible. |
| v1.6608.0 | Registration function renamed `lrA()` (was `qwA()`). No new MCP servers, no removed servers - same 10 in Xxi array (mcp-registry, plugins, skills, cowork-onboarding, radar, "Claude Preview", dev-debug, ccd_session_mgmt, ccd_directory, ccd_session) plus renderer-facing ("Claude in Chrome", terminal, visualize). No new tools. Webpack re-minify only. All patches compatible. |
| v1.6259.1 | Registration function still `qwA()`, unchanged. Computer-use Set variable `rwA`->`qDA`. Platform gate `bfA`->`BwA` (darwin\|\|win32). **New MCP server: `skills`** (list_skills, search_skills). **New Chrome tools:** `browser_batch`, `list_connected_browsers`, `select_browser`. **Removed Chrome tool:** `update_plan`. New tools: `mark_chapter` (ccd_session), `retire_card` (radar), `propose_skills` (cowork). New Operon tools (NOT MCP): `copy_file_user_to_claude`, `delete_host_files`, `select_relevant_inputs`. Chrome tool count 20->22, office-addin unchanged (5). All patches compatible. |
| v1.5354.0 | Registration function renamed `qwA()` (was `gpA()`). Registry storage `RL`->`MG`, labels `VJA`->`VqA`, enumerator `v7()`->`Y7()`. No new MCP servers, no new tools - same 17 servers (3 renderer-facing + 14 backend). Three patches fixed: `fix_window_bounds` (profile title hook insertion reordering), `fix_dispatch_linux` (gate variable position change), `fix_dispatch_outputs_dir` (new `Tc()` path wrapper in `openPath`). All 44 patches compatible. |
| v1.3561.0 | Registration function renamed `gpA()` (was `DfA()`). Platform gate variables `WhA`->`bfA` (darwin\|\|win32), `en` unchanged (darwin), `ws`->`ys` (win32). Computer-use Set `ele`->`rwA`, checker `Jne()`->`nBA()`. No new MCP servers, no new tools - same 17 servers (3 renderer-facing + 14 backend). Webpack re-minify only. All patches compatible. |
| v1.3109.0 | Registration function renamed `DfA()` (was `kce()`). Platform gate variables `UMe`->`WhA` (darwin\|\|win32), `hi`->`en` (darwin), `xce`->`ws` (win32). No new MCP servers, no new tools - same 17 servers (3 renderer-facing + 14 backend). Webpack re-minify only. All patches compatible. |
| v1.3036.0 | Registration function renamed `kce()` (was `ooe()`). Platform gate variable `r6e`->`UMe`, win32 `vs`->`xce`. No new MCP servers, no new tools - same 17 servers. Variable renames only. All patches compatible. |
| v1.2773.0 | Registration function renamed `ooe()` (was `One()`). Computer-use Set variable `ese`->`ele` with `Jne()` checker (was `Lte()`). Platform gate variable `c3e`->`r6e`. `floatingAtoll` now always supported unconditionally (was preference-gated). No new MCP servers, no new tools. Same 17 servers. Variable renames only. All patches compatible. |
| v1.2.234 | Registration function renamed `One()` (was `Are()`). **Terminal server now natively supports Linux** - `LRe = isDarwin \|\| isWin32 \|\| isLinux`, `fix_read_terminal_linux.py` patch removed. Computer-use platform gate changed to Set-based (`ese = new Set(["darwin","win32"])`) with `vee()` function. No new MCP servers or tools. Variable renames only. |
| v1.1.9669 | Registration function renamed `Are()` (was `Pee()`). **New `computerUse` feature flag** in static registry (`jun()`, darwin-only) - computer use now gated by both MCP server registration AND feature flag. No new MCP servers or tools. `chillingSlothFeat` darwin gate re-introduced (was removed in v1.1.9134). Remote orchestrator (`4201169164`) removed from GrowthBook. Same 3 renderer-facing servers (Chrome, mcp-registry, office-addin) and same backend servers. Variable renames only. |
| v1.1.9493 | Metadata-only re-release of v1.1.9310. JS bundles identical - no new MCP servers, tools, or IPC changes. Async feature merger restructured (`Promise.all` pattern). |
| v1.1.9134 | **New MCP server: `ccd_session`** (`spawn_task` tool for parallel session spawning). **5 new computer-use tools** (`switch_display`, `computer_batch`, `request_teach_access`, `teach_step`, `teach_batch` - 22->27 total). Registration function renamed `IM()`->`Pee()`. Operon expanded from 18->28 sub-interfaces. Computer-use constant renamed `zxt`->`p6t`. |
| v1.1348.0 | **3 new cowork tools:** `create_artifact`, `update_artifact` (flag `2940196192`), `save_skill` (conditional). Terminal server regressed to `z5e` (darwin\|\|win32) - Linux support maintained via `fix_dispatch_linux.py` `z5e` patch. New `Buddy` BLE device pairing IPC. Operon 31->33 sub-interfaces (`OperonDesktop`, `OperonMcpToolAccessProvider`). No new MCP servers. All 34 patches applied cleanly. |
| v1.1617.0 | **New MCP server: `radar`** (disabled, `record_card` tool). Platform gate variable renamed `z5e`->`g5e`. Computer-use Set variable `Hae` with `Lte()` checker. Registration function still `One()`. New renderer windows (`buddy_window/`, `find_in_page/`). New deps: `node-pty`, `ws`. No new tools on existing servers. All 35 patches applied cleanly. |
| v1.1062.0 | Registration function renamed to `One()`. **New: `update_plan` Chrome tool** (20 total Chrome tools). **New: `read_me` widget MCP tool** in Visualize server. Scheduled Tasks server name constant `qBe="scheduled-tasks"` (hyphenated). `cowork-artifact-<id>` dynamic per-artifact servers. `web_search` Anthropic API built-in tool (`web_search_20250305`) gated by `enable_web_search`. Operon expanded to 31 sub-interfaces (3 new: `OperonExportBundle`, `OperonReplay`, `OperonSDK`). Operon tool inventory: 14 brain tools, 7 compute tools, 1 dynamic (`skill`), 4 internal LLM tools. Dashboard tools `render_dashboard`/`patch_dashboard` disabled pending sandbox hardening. |
| v1.1.8359 | Visualize server factory renamed to `p3n()` via `getImagineServerDef` (same interface). Operon IPC system added (not MCP). No new MCP servers - all 14 unchanged. |

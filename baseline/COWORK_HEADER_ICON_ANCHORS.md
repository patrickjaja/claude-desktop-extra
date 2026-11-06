# Cowork device icon in the claude.ai chat header - upstream anchor inventory

**Measured live against Claude Desktop 4.23118.0** (2026-11-06, X11/XFCE, 1P Team account, keyed device,
package v4.23118.0-4) with DevTools in the main view. The keyless store shape is from the 2026-11-03/04
connect logs, not measured in the page.

This covers [`fix_cowork_device_icon_web.nim`](../patches/linux/fix_cowork_device_icon_web.nim), which injects
[`cowork_device_icon_web_main.js`](../js/cowork_device_icon_web_main.js); main inserts the stylesheet and runs
[`cowork_device_icon_web_page.js`](../js/cowork_device_icon_web_page.js) in every https claude.ai / claude.com
page on `dom-ready` (never `app://localhost`). The page installs only where `window.cdbExtra` exists (the main
view's preload), so popups and helper views get nothing.

**None of these anchors ship in the desktop `app.asar`.** They are remote claude.ai code (the same React app
and design system as the ion-dist SPA, whose chunk `c21f11e6d-*` holds the same components), so a green build
says nothing about them. They are checked at run time: a missing anchor logs one `[cdb-cowork-icon] <key>` line
and the page renders the fallback named below.

Desktop-side preconditions: the `cdbExtra` bridge in `.vite/build/mainView.js` (`cuStatusIcon`,
`extraOpenSettings`, `diag`), the `cdb-cu-status:icon` / `cdb-extra:open-settings` / `cdb-extra:diag` handlers in
`js/extra_settings_main.js`, and `window.__cdbExtraOpen(kind, section)` from `js/extra_settings_page.js`
(same main world; it opens Settings -> Extra -> Cowork (Linux) at the `cloud` or `local` section).

## What renders where

| Title row has (any upstream button in the trailing `span.ms-1` counts as its indicator) | Device state | We render |
|---|---|---|
| `cowork-computer-link-indicator` (chat linked to a computer, any `data-status`) | any | nothing in the row; its popover gets a "Linux details" row -> `("cu","cloud")` |
| `cowork-local-session-indicator` (`/cowork/local_<uuid>`, incl. Dispatch-local) | any | nothing in the row; its popover gets the local VM readiness line + "Linux details" -> `("cu","local")` |
| `cowork-computer-link-indicator-slot` (binding not loaded yet) | any | nothing |
| none, cloud session (`/chat/<id>`, `/cowork/<id>` not `local_`) | `idSource` exactly `keyless` or `none` | laptop with X badge, popover "No device key" (Computer Use lost, files and commands still work), "Set up" -> `("cu","cloud")` |
| none, cloud session | `idSource` `keyed` | laptop with amber dot, "Linux details" -> `("cu","cloud")` |
| none, cloud session | no store, no `idSource`, or an unknown value | plain laptop (`neutral`), popover "This computer" + "Linux details" -> `("cu","cloud")`, no claim |
| none, local session (upstream's local icon missing) | any | plain laptop, readiness line, "Linux details" -> `("cu","local")` |
| any other route (`/new`, `/epitaxy/...`, settings, ...) | any | nothing |

Pure state function: `window.__cdbCoworkIconState({upstream, cloud, device})`.

## Mode lines

Every popover we touch carries one mode line (`.cdb-cowork-icon-mode`), from main's cached `cuStatusIcon()` VM state, `textContent` only:

- Linked chat (measured 2026-11-06: a linked cloud chat's shell commands run in this computer's local Cowork VM, `[remote-bash] vmUser=rcw-<id>` in main.log, `[vmOneShot] ... as rcw-<id>` in cowork_vm_node.log, VM started for it): "Runs in the cloud - files and commands on <computer> run in its local Cowork VM (running|ready)", or "Runs in the cloud - <computer> is linked, but its local Cowork VM is not available (<reason>)".
- Local session: "Runs in the local VM on this computer - running|ready|not available (<reason>)".
- Our own icon: title, then "Runs in the cloud", then the variant text, action last. Keyless: title "No device key", text "Cloud tasks can't use Computer Use (screen and input) on this computer. Files and commands still work." (measured: a keyless desktop still links chats and runs their commands; it loses only the computer tools).

Placement: in upstream's cards the mode line joins the status block, right after the last status line (link card: after `cowork-computer-link-status-detail`, else `-status`; local card: after the title block's last span), with that line's classes so the inset matches. The "Linux details" row stays last: a sibling right after "Manage devices" (cloned button only), or in the local card a divider plus our button at the end of the padded column. Without a status block the mode line heads our row.

## Anchors

| Anchor | Where | Measured on 4.23118.0 | If it breaks |
|---|---|---|---|
| Routes `^/(chat\|cowork)/<id>` | page `ROUTE` | cloud chat `/chat/<uuid>`; local / Dispatch-local session `/cowork/local_<uuid>` | Nothing renders on a renamed route (silent); recipe 1 |
| Title row `[data-testid="session-title-split"]` | page `scan` | the title component's row; every header icon sits in it | `no-header` (after 30 scans on a session route without it); nothing renders |
| Trailing slot `span.ms-1` (direct child of the row) | page `place` | the `titleTrailing` slot holding upstream's indicator; absent on plain chats | No warning: we append our own `span.ms-1.cdb-cowork-icon-slot` as the row's last child |
| Title fiber props `{sessionTitle, sessionId, ...}` on an ancestor of the row (40 hops) | page `sessionIdOf` | `{sessionTitle, isChatSession, scheduledTaskId, sessionId, ...}`; `sessionId` = `local_<uuid>` for local sessions | `no-seat` (no such ancestor) / `no-session` (no string `sessionId`); the URL id is used instead |
| `button[data-testid="cowork-computer-link-indicator"]` | page `LINK_IND` | `data-status="connected"`, `aria-label="<computer>, Connected"`, ghost icon Button (`icon:"Laptop"`), Pulse badge `var(--cds-fill-success)`. Rendered only for a chat with `workspaceDeviceBound:true` | A renamed test id still counts if the button sits in `span.ms-1` (no second icon); elsewhere in the row we would render next to it. Recipe 2 |
| `button[data-testid="cowork-local-session-indicator"]` | page `LOCAL_IND` | `aria-label="Only on this computer"`, icon `CloudSlash` | Same fail safe as above. Recipe 2 |
| Placeholder `[data-testid="cowork-computer-link-indicator-slot"]` | page `SLOT` (`cowork-*-slot`) | `span.inline-flex.h-control.w-control` while the binding is unknown | We would render during the load (transient) |
| Popover `[data-cds="PreviewCard"]` in `#portal-root > [data-base-ui-portal] > [data-cds-portal] > [role=presentation]` | page `decorateCards` | `[role=group][aria-labelledby]`, opens on click (trigger gets `data-popup-open`), closes on focus loss | `no-popup` when an indicator is open and no card is in the document |
| `button[data-testid="cowork-computer-link-manage"]` ("Manage devices") | page `MANAGE` | last row of the link card: `div.flex.flex-col.p-1 > [title block, div.flex.flex-col > (divider, ..., manage)]`; ghost `data-cds="Button"` with `w-full justify-start` | `no-popup`; the row goes to the end of the card's padded column, unstyled own button |
| Local card title = the trigger's `aria-label` | page `cardOf` | `div.flex.flex-col.p-1 > div.flex.flex-col.gap-0.5.px-md.py-sm > (span title "Only on this computer", span detail)` | `no-popup` ("no PreviewCard is titled with its aria-label"); no row |
| Link card title `#<aria-labelledby>` (the computer name) and `[data-testid="cowork-computer-link-status-detail"]` classes | page `computerName` / `placeMode` | card `aria-labelledby` -> `span.truncate` with the computer name; status detail span styled `text-footnote ...` | No warning: the name falls back to the indicator's `aria-label` before the comma, then "this computer"; without a status line the mode line heads our row (`px-md py-xs text-footnote text-secondary`) |
| `globalThis["claude.web"].WindowState.deviceLinkStore` | page `deviceState` | `getStateSync()` -> `{appStartedMs, connected:true, idSource:"keyed", presentedDeviceId, recentGaps}`; `onStateChange(cb)` returns an unsubscribe (mainView preload, sync IPC `WindowState_$_deviceLink_$store$_getStateSync`) | `no-device-store`; the neutral plain laptop (no warning) on every unlinked chat |
| `__reactFiber$` expando | page `fiberOf` | React 19 production | `no-seat` |

Our nodes: `button.cdb-cowork-icon[data-cdb-cowork-icon="keyless"|"keyed-unbound"|"neutral"|"local"]`, its popover
`div.cdb-cowork-icon-pop[role=dialog]` (on `document.body`, fixed position, follows scroll/resize, closes on Escape, outside pointerdown and focus leaving it; `aria-labelledby` title, `aria-describedby` text line), and
`div.cdb-cowork-icon-row[data-cdb-cowork-icon="details"]` inside upstream's card. The "Linux details" button in
the link card is a clone of upstream's "Manage devices" button (classes and `data-cds*` attributes, no test id,
no React handlers; its text goes into `span.truncate` or the last non-`data-cds` span, never an icon span). Styling is a sheet main inserts with `insertCSS` (CSP-free), `--cds-*` tokens with neutral
fallbacks. Every write is skipped when the node is already in place; the `MutationObserver` (`childList`,
`subtree`, on `document.body`) ignores text-only records and our own nodes and is debounced to 50 ms.

## Runtime warnings that mean an anchor moved

Once per key per page load, as `console.warn` (lands in `~/.config/Claude/logs/claude.ai-web.log`) and as a
`page: [cdb-cowork-icon] ...` line in `claude-patches.log`. Page text never goes into either.

| Key | Means |
|---|---|
| `no-header` | 30 scans on a `/chat/` or `/cowork/` route found no `[data-testid="session-title-split"]` |
| `no-seat` | the title row has no fiber, or no ancestor fiber with `{sessionTitle, sessionId}` |
| `no-session` | that fiber's `sessionId` is not a non-empty string |
| `no-device-store` | `deviceLinkStore.getStateSync` is missing or threw |
| `no-popup` | an upstream indicator is open but its card (or the manage button in the link card) was not found |
| `no-deeplink` | `window.__cdbExtraOpen` is missing (Extra page not installed); main is asked to open upstream settings only |
| `deeplink-refused` | `window.__cdbExtraOpen("cu", ...)` returned false (unknown panel, or no bridge method; it toasts the manual path); upstream settings are opened |
| `deeplink-error` | `window.__cdbExtraOpen` threw; upstream settings are opened |
| `no-observer` | no document body or `MutationObserver` |

## Console recipes (DevTools in the main view, 1P)

```js
// 1. Is the page module installed, and what does it see?
window.__cdbCoworkIcon.state()
// -> {observing, icons:[{variant, session}], popover, rows, subscribed, warned:[keys]}
location.pathname   // "/chat/<uuid>" or "/cowork/local_<uuid>"

// 2. The title row, its trailing slot and upstream's indicators.
const split = document.querySelector('[data-testid="session-title-split"]');
[...split.children].map(c => c.tagName + "." + c.className);
split.querySelector('[data-testid^="cowork-"]')?.outerHTML.slice(0, 300);

// 3. The title fiber (session id): expect {sessionTitle, isChatSession, scheduledTaskId, sessionId, ...}.
const fib = el => el[Object.keys(el).find(k => k.startsWith("__reactFiber$"))];
for (let f = fib(split), i = 0; f && i < 40; f = f.return, i++)
  if (f.memoizedProps && "sessionTitle" in f.memoizedProps) { console.log(i, Object.keys(f.memoizedProps), f.memoizedProps.sessionId); break; }

// 4. The device store.
globalThis["claude.web"].WindowState.deviceLinkStore.getStateSync()
// -> {appStartedMs, connected, idSource:"keyed"|"keyless"|"none", presentedDeviceId, recentGaps}

// 5. Open upstream's popover (click the icon), then: the card and its manage button.
const card = document.querySelector('[data-cds="PreviewCard"]');
card?.querySelector('[data-testid="cowork-computer-link-manage"]')?.outerHTML;
card?.querySelector(".cdb-cowork-icon-row")?.outerHTML;

// 6. The state table, without touching the page.
window.__cdbCoworkIconState({upstream: "none", cloud: true, device: {connected: true, idSource: "keyless"}})  // "keyless"
```

## Not yet measured live

- A keyless desktop's chat (X icon) and the deep link from it; the local popover with our row; the amber
  variant on a keyed desktop's unlinked chat (option A: shown on every such chat).
- Whether `span.ms-1` exists on a plain chat with no indicator (our own slot covers both).

# Auto-archive delay in the claude.ai Code page - upstream anchor inventory

**Derived statically against Claude Desktop 4.23118.0** (2026-11-06) from the ion-dist chunks
`c96d752d0-*` (hold notice) and `cf74bc599-*` (session rail), which are the same React app claude.ai
serves for the Code tab. **Not yet measured live on claude.ai.**

This covers the 1P half of the PR auto-archive delay's UI:
[`add_feature_auto_archive_grace_web.nim`](../patches/community/add_feature_auto_archive_grace_web.nim)
injects [`auto_archive_grace_web_main.js`](../js/auto_archive_grace_web_main.js), which runs
[`auto_archive_grace_web_page.js`](../js/auto_archive_grace_web_page.js) in the claude.ai page on every
`dom-ready`. The 3P half (ion-dist, compiled into upstream's components) has build-time anchors only and is
not covered here.

**None of these anchors ship in the desktop `app.asar`.** They are remote claude.ai code, so a desktop
version bump cannot move them and a green build says nothing about them. They are checked at run time:
a missing anchor logs one `[archive-grace-ui] <key>` line and the page leaves upstream's UI as it is.

The desktop-side preconditions are the `cdbExtra` bridge in `.vite/build/mainView.js`
(`autoArchiveGraceRead`, `autoArchiveGraceKeep`), the `cdb-archive-grace:read` / `:keep` handlers in
`js/extra_settings_main.js`, and `globalThis.__cdbArchiveGraceStatus` / `__cdbArchiveGraceKeep`, which
`js/auto_archive_grace.js` defines on the archive engine's first sweep. `__cdbArchiveGraceKeep` calls
`engine.sessionManager.setSessionAutoArchiveOnPrClose(id, false)`, the same setter upstream's
`LocalSessions.setSessionAutoArchiveOnPrClose` eIPC handler calls (4.23118.0: the session manager class in
`index.chunk-C1amfmw3.js`, constructed once and passed to `new AutoArchiveEngine(e)`).

## Anchors

| Anchor | Where | Expected on the 4.23118.0 chunks | If it breaks |
|---|---|---|---|
| The Code route: `location.pathname` matches `^/epitaxy(/|$)` | page `ROUTE` | the main bundle routes `"/epitaxy"`; shared with panel tabs | Nothing is scanned and nothing logs (no anchor to test against). Check with recipe 1 |
| Hold notice element: `[role="status"][aria-live="polite"]` | page `findViews` | two shapes from the `{hold,sessionRef}` component: `div[role=status][aria-live=polite][data-find-omitted]` with class `max-w-full text-footnote min-w-0 text-secondary` (most holds), or, for an on-screen hold of a local session, `div[data-find-omitted]` (class `flex min-w-0 max-w-full flex-wrap items-baseline gap-x-1.5 text-footnote`) wrapping `span[role=status][aria-live=polite][aria-atomic=true]` (class `min-w-0 text-secondary`) and an optional "Stop task and archive" button | A role change hides the notice from the scan; any role=status element mentioning "archiv" without the props below logs `notice-props` |
| Fiber props `{hold, sessionRef}` on an ancestor of the notice element, within 40 `return` hops (searched, not counted) | page `ownerWith` / `isNoticeProps` | the notice component destructures `{hold:t,sessionRef:n}=e`; the inner on-screen component has `{sessionRef}` only, so the walk goes past it | `notice-props` |
| The notice root = the first host element under that component | page `hostRoot` | the `div` above (either shape); the line goes right after it as a sibling, outside the live region | `notice-root` |
| `__reactFiber$` expando on the notice element | page `fiberOf` | React 19 production | `no-fiber` |
| Rail: an `aside` with fiber props `{session, pullRequests, outputsSession}` on an ancestor, within 40 hops | page `findViews` / `isRailProps` | `aside{ref,"aria-label":"Session details",tabIndex:-1,...,children:[railHeader, scrollArea]}`, rendered by the component with `{session,pullRequests,plan,artifacts,...,outputsSession,...}`. The keep box goes below the Changes card (next row) | An `aside[aria-label="Session details"]` without those props logs `rail-props`; a renamed label only silences that warning |
| Changes card: a `section` inside that aside whose nearest rail-card fiber (first ancestor with props `id` and `title`) has `id: "pullRequests"` | page `changesSection` | the rail card component (`{id,title,summary,...,keepMounted,children}`) renders a collapsible root whose element is `section[aria-labelledby]` (header with the title "Changes", then the panel with the PR rows). The aside calls it with `id:"pullRequests"`, `keepMounted:!0`. The keep box goes right after that section, before the next card | `rail-changes`; the keep box falls back to the aside's end |
| `sessionRef` / `outputsSession` = `{type:"local", id}` | page `localId` | `t.type==="local"?t.id:void 0` in upstream's own components | A cloud session gets upstream's UI only (same as 3P); a changed shape looks like a cloud session (silent) |

The line and the keep box are plain DOM nodes marked `data-cdb-archive-grace-line` /
`data-cdb-archive-grace-keep`. Every write is skipped when the node is already in place with the same text,
so the page's own `MutationObserver` (`childList`, `subtree`, on `document.body`) settles after one rescan.
A hold change that only rewrites text (no `childList` mutation) is picked up at the next 30-second read.

The first read for a session usually happens while the archive sweep that published the hold is still
running, before it records the start time, so main answers terminal with no deadline ("starts at the next
archive sweep"). A page-triggered read with that answer is repeated once after 3 s; after that only the
30-second poll runs.

Class names used on our nodes (`text-footnote`, `text-muted-as-secondary`, `hover:text-text-primary`,
`flex flex-col gap-1 px-2 py-1`) are cosmetic: if claude.ai's CSS drops one, the line or button renders
unstyled, nothing breaks.

## Runtime warnings that mean an anchor moved

Page-side `console.warn`, prefixed `[archive-grace-ui]`, once per key per page load, so they land in
`~/.config/Claude/logs/claude.ai-web.log` (named profiles: `Claude-<profile>`). They appear only while the
delay is set: at Immediately the page reads the setting once and scans nothing.

| Key | Means |
|---|---|
| `notice-props` | a role=status element mentions archiving, but no ancestor fiber has `{hold, sessionRef}` |
| `notice-root` | the notice component's first host element does not contain its status element |
| `no-fiber` | a notice-like status element has no `__reactFiber$` key |
| `rail-props` | an `aside[aria-label="Session details"]` has no ancestor fiber with `{session, pullRequests, outputsSession}` |
| `rail-changes` | the rail resolved, but no `section` in it belongs to the card with `id: "pullRequests"`; the keep button is at the aside's end instead of below the PR rows |
| `no-bridge` | `window.cdbExtra.autoArchiveGraceRead` is missing (desktop side: mainView preload not patched) |
| `no-observer` | no document body or `MutationObserver` |
| `debug-keep` | the debug hook's keep was clicked; nothing was sent |

Main-process lines go to `claude-patches.log`: `[archive-grace] <id>: kept (...)` after a keep.

## Console recipes (DevTools on the Code tab, 1P)

```js
// 1. Is the page module installed, and what does it see?
window.__cdbArchiveGraceWeb.state()
// -> {on, observing, notices:[ids], rails:[ids], sessions:[{id, snapshot, polling, kept}], lines, keeps, warned}

// 2. The notice anchor: every polite status element, and whether it resolves.
const fib = el => el[Object.keys(el).find(k => k.startsWith("__reactFiber$"))];
const up = (el, test) => { let f = fib(el); for (let i = 0; f && i < 40; i++, f = f.return)
  if (f.memoizedProps && typeof f.memoizedProps === "object" && test(f.memoizedProps)) return [i, f.memoizedProps]; return null; };
[...document.querySelectorAll('[role="status"][aria-live="polite"]')]
  .map(el => [el.textContent.slice(0, 60), up(el, p => "hold" in p && "sessionRef" in p)]);

// 3. The rail anchor.
[...document.querySelectorAll("aside")]
  .map(a => [a.getAttribute("aria-label"), up(a, p => "outputsSession" in p && "pullRequests" in p)]);

// 3b. The Changes card: each section in the rail and the id of its card.
[...document.querySelector('aside[aria-label="Session details"]').querySelectorAll("section")]
  .map(s => up(s, p => "id" in p && "title" in p)?.[1].id);   // expect "pullRequests" among them

// 4. What main reports for the open session (id from recipe 2's sessionRef).
await window.cdbExtra.autoArchiveGraceRead("<session id>")
```

### Forcing the UI without a merged PR

The debug hook exists only when a localStorage flag is set before the page script runs:

```js
localStorage.setItem("cdbArchiveGraceDebug", "1"); location.reload();
// after the reload, open a local Code session whose hold notice is showing
// (for example "...archived automatically after you leave it." with PR auto-archive on), then:
await __cdbArchiveGraceDebug({ deadline: Date.now() + 600000 });  // "about 10 min left" + Keep button
await __cdbArchiveGraceDebug({});                                  // "starts at the next archive sweep"
await __cdbArchiveGraceDebug({ deadline: Date.now() - 1 });        // "has ended"
await __cdbArchiveGraceDebug(null);                                // back to the real status
localStorage.removeItem("cdbArchiveGraceDebug");
```

It works with the delay at Immediately too, and it applies to every local session on screen. The keep button
only logs `debug-keep` unless the fake status says `realKeep: true`, which sends the real
`cdb-archive-grace:keep` (that needs a nonzero delay and turns the session's "Auto-archive on merge or close"
off).

## Re-deriving from the chunks

```bash
f=$(ls tmp/ion-dist/assets/v1/c96d752d0-*.js)   # or grep -l the hold text
grep -ao '.\{40\}{hold:[\w$A-Za-z]*,sessionRef:.\{60\}' "$f"
grep -ao '"div",{role:"status","aria-live":"polite","data-find-omitted":"",className:[^}]*' "$f"
grep -ao 'role:"status","aria-live":"polite","aria-atomic":"true"' "$f"
r=$(grep -l 'outputsSession:' tmp/ion-dist/assets/v1/*.js | xargs grep -l 'id:"pullRequests",title:')
grep -ao '"aside",{ref:[^}]*' $r
```

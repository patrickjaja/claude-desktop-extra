# Custom Shortcuts Runtime Anchors

Anchors relied upon by [`js/custom_shortcuts_page.js`](../js/custom_shortcuts_page.js) (injected by [`patches/community/add_feature_custom_shortcuts.nim`](../patches/community/add_feature_custom_shortcuts.nim)) and verified against **upstream `6.28899.6`** (`ion-dist.asar`; Read Aloud / Voice Mode originally inventoried on `5.11492.5`; the Code tab Read Aloud rows were added on `6.28899.6` and checked live in a Code tab session, issue #359).

Remember: `claude.ai` itself is remote web code and can change independently of a `.deb` release. Every missing anchor in `custom_shortcuts_page.js` degrades to a short toast notice plus a deduped `[cdb-shortcuts]` warning line in DevTools and `claude-patches.log`.

## Page-side anchors (`ion-dist.asar` / `claude.ai`)

| Action | Selector / Fiber Prop | Upstream Source (`5.11492.5`) | Fallback / Guard |
|--------|-----------------------|---------------------------------|------------------|
| **Read Aloud — button** | `[data-testid="action-bar-read-aloud"][data-state]` | `BV` (`shared-36`, `ca2ef848d`) renders `data-state` in `"idle" \| "playing" \| "paused" \| "loading"` | Fiber ancestor check (`onReadAloud` or `messageUuid` + `getText`), then `aria-label` `/^(Read aloud\|Pause\|Resume\|Stop)$/i` (`[cdb-shortcuts] read-aloud-testid-fallback` / `read-aloud-label-fallback`) |
| **Read Aloud — message scope** | `[data-testid="assistant-message"][data-is-streaming]` | Chat turn container (`c71860c77`, `shared-36`) | Prefers newest non-streaming reply; shows `"Wait for Claude to finish responding"` if only a streaming reply exists |
| **Read Aloud - Code tab button** | `[data-testid="epitaxy-read-aloud"]` (no `data-state`; `aria-label` `Read aloud` / `Pause` / `Resume`) | `ZVe` (`cac57de41`, `6.28899.6`) renders `SpeakAction {playing, label, "data-testid":"epitaxy-read-aloud"}` under a wrapper with props `{messageUuid, text}` where `messageUuid` is the turn's entry id (`n.entryId`, `kKe`, `cac57de41`; equal to the turn key in the live sample); the same testid already existed in `5.11492.5` (`c96d752d0`) | Playing state read from the fiber copy (current or `alternate`) whose `label` equals the live `aria-label` (a DOM node can point at a stale fiber); last resort `aria-label` `Pause`. The fiber fallback does NOT accept `{messageUuid, text}`: upstream's general action bar `IZ` (`cac57de41`) has those props without any Read Aloud |
| **Read Aloud - Code tab tail outlet** | `[data-testid="transcript-tail-actions"][data-transcript-last-row-controls]` inside `[data-transcript-tail-turn]` inside `[data-transcript-tail]` (under `[data-testid="transcript-after-rows"]`, sibling of `transcript-rows`) | Turn renderer `Ad` (`c2a04b80d`, `6.28899.6`) renders its `message-actions` inline only when no outlet element is given (`be?null:Fe`), else portals them; `elementFor` (`cac57de41`) returns the outlet only for the newest turn (`isLast && isTurnTail && !synthetic`); `vUe` creates the outlet and `placeIn` appends it to the tail turn (listens for `pointerenter`). Turns whose entry id is in upstream's excluded list get a detached holder instead (`A.includes(t.entryId)?a$e(k.get())`), so their actions are in no DOM and the toast is correct. Present since `5.11492.5` | Ownership is positive: the first `turn.key` and the first `messageUuid` (entry id) found on the fiber chains of the outlet's buttons are collected; the outlet is used only if the reply's `data-turn-key` equals either. If any key was found and none matches, or the reply has no `data-turn-key`, it is refused. Only with no fiber data at all, only the last `assistant-message` of its transcript (`[data-testid="epitaxy-virtual-transcript"]` / `[role="feed"]`) owns it. Deferred hydration also dispatches `pointerenter` on `[data-transcript-tail-turn]` |
| **Read Aloud — deferred actions** | `[data-cds="MessageActions"][data-deferred]`, `[data-testid="message-actions"][data-deferred]` | `S0` defers action buttons until hover/focus or `button.sr-only` (`Show message actions`) click | Dispatches `mouseover`/`pointerover`/`pointerenter`, clicks `.sr-only` while saving/restoring `document.activeElement`, polls up to `18` animation frames |
| **Voice Mode — start** | `button[aria-label="Use voice mode"]`; React fibers `qR` (`state === "idle"` + `onStart`) and `xR` (`items` with `icon: "Phone"` / `icon: "Voice"`) | `OR`, `kR`, `xR`, `qR` (`ca2ef848d`, `c4a9ee384`) | Tries `qR.onStart`, direct button click, `xR` `Phone` item, and finally pins `Voice` radio item and waits `400 ms` past `ER` mistap guard |
| **Voice Mode — mistap guard** | Composer mount / `startsVoice` flip settle delay (`350 ms`) | `ER` (`c4a9ee384`) | `VOICE_MISTAP_SETTLE_MS = 400` in `custom_shortcuts_page.js` checks for active voice bar and retries once if voice stayed idle |
| **Voice Mode — stop** | React fiber `qR` (`state === "active" \| "connecting"`, `onEnd` / `onCancel`) | `qR` (`c4a9ee384`) | DOM fallback looks for visible `Stop` / `Cancel` / `End voice mode` adjacent to microphone mute or held-voice controls (`[cdb-shortcuts] voice-active-dom-fallback`) |
| **New Voice Chat** | `globalThis.__cdbNavigation.getDispatcher(wc).dispatchNavigate("/new")` or `a[href="/new"]` / `[data-testid="new-chat-trigger"]` | `Navigation` plugin (captured by `add_feature_extra_settings.nim`) + sidebar link | Polls until `location.pathname` is `/new` (or `/`) and an idle voice starter renders, waits `400 ms` past mistap guard, then starts Voice Mode |
| **Send Now — queued message** | `button[data-testid="awaiting-turn-send-now"]` (`data-press-renders-now="true"`, `data-transcript-continues-turn=""`, `aria-busy` / `disabled` while sending) | `D` (`cf7fce8a8` in `6.28899.2`), rendered by Code (`ce461fba7`, `chord: false`), Chat (`c04a1223c`, no `chord`), and Cowork (`98e00d40...`) | Picks newest visible enabled button (skips buttons inside Settings dialog; reports busy/disabled cleanly without double-sending). Fallback matches React fiber `onSendNow` paired with `data-press-renders-now`/`data-transcript-continues-turn`/label (`send-now-fiber-fallback`), or visible button text `/^Send(?:\s+\d+)?\s+now$/i` ignoring `<kbd>` hints (`send-now-label-fallback`, also covers held-message banner CTAs in `cc43287c9`) |
| **Shortcut recorder lock** | `[data-keyboard-shortcut-input]` | Upstream shortcut recorder components (`shared-21`, `shared-36`) + Extra Settings `.cdbx-sc-pill` | `focusin`/`focusout` notifies `cdbExtra.customShortcutsRecording(bool)` so `before-input-event` and `globalShortcut` pause during recording |

### Code tab transcript tail (`6.28899.6`)

In the Code tab, when the transcript tail is mounted, the newest completed reply's action bar is not inside its `assistant-message`; it is portaled into the tail outlet above (`P5`, `cac57de41`). Order inside `[data-transcript-tail]` (a `flex-col` container): `transcript-trailing-slot`, then a wrapper holding `[data-transcript-tail-turn]` (`transcript-tail-slot`, then the outlet) and `transcript-tail-chrome` below it. When the trailing slot holds a question card or an in-flow tool card it is moved below the outlet's turn (`has-[.epitaxy-tool-card-in-flow]:order-last has-[.epitaxy-question-card]:order-last`). A busy (streaming) turn is not portaled. Streaming is judged per turn: with item granularity the turn renderer emits one `assistant-message` per item, all with the turn's `data-turn-key`, but only the first/only row carries `data-is-streaming` (`"data-is-streaming":b&&!L?T?"true":"false":void 0`, `b=a==="only"||a==="first"`, `c2a04b80d`). The slots:

- `[data-testid="transcript-before-cards"]` - before-trailing content.
- `[data-testid="transcript-trailing-slot"][data-transcript-cards]` - inline approvals and permission prompts (`[data-inline-approval-slot]` / `[data-approval-cluster-host]`), AskUserQuestion and plan approval cards (`.epitaxy-question-card`), tool cards in flow (`.epitaxy-tool-card-in-flow`).
- `[data-testid="transcript-tail-slot"]` - the live turn box `[data-turn-box]` (wrap-up recap, question and suggested next actions, e.g. the Auto-fix offer); fed by the `mcp__ccd_turn__wrap_up` / `WrapUp` tool (`c5da7eb42`) through `turnBoxSlotEl` (`cf74bc599`).
- `[data-testid="transcript-tail-chrome"]` - status lines.

Settled wrap-ups become their own transcript rows; older replies keep their action bar inline. Matching is by ownership, not position, so any content in these slots is covered.

## `[cdb-shortcuts]` warning keys

Any of these once-per-page lines in DevTools or `logs/claude-patches.log` indicates an upstream selector/fiber drift worth auditing:

- `read-aloud-testid-fallback` — `data-testid="action-bar-read-aloud"` moved; fell back to React fiber props.
- `read-aloud-label-fallback` — both testid and fiber props missed; fell back to `aria-label`.
- `read-aloud-missing-after-hydrate` / `read-aloud-missing` — assistant reply lacked any discoverable Read Aloud trigger.
- `voice-active-dom-fallback` — active voice pill fiber (`state`/`onEnd`) moved; fell back to adjacent mic-button DOM check.
- `voice-button-missing` / `new-voice-button-missing` — no Voice Mode button/fiber found on the active chat route.
- `new-chat-nav-missing` / `new-chat-timeout` — navigating to `/new` failed or timed out waiting for the new-chat voice button.
- `send-now-fiber-fallback` — `data-testid="awaiting-turn-send-now"` moved; fell back to React fiber `onSendNow` + button marker/label.
- `send-now-label-fallback` — matched `"Send now"` / `"Send N now"` via visible button text (testid/fiber absent, or held-message banner CTA).

## DevTools console verification recipes

Run inside a live Claude window with DevTools enabled, once in a Chat conversation AND once in a Code tab session (the Code tab uses a different Read Aloud button and moves the newest reply's actions into the tail outlet):

```js
// 1. Inspect detected DOM & state snapshot
window.__cdbCustomShortcuts.state()

// 2. Dry-check selectors in an open conversation with at least one reply
({
  assistantTurns: document.querySelectorAll('[data-testid="assistant-message"]').length,
  readAloudButtons: document.querySelectorAll('[data-testid="action-bar-read-aloud"], [data-testid="epitaxy-read-aloud"]').length,
  codeTailOutlets: document.querySelectorAll('[data-testid="transcript-tail-actions"]').length,
  codeTailReadAloud: document.querySelectorAll('[data-testid="transcript-tail-actions"] [data-testid="epitaxy-read-aloud"]').length,
  deferredBars: document.querySelectorAll('[data-cds="MessageActions"][data-deferred], [data-testid="message-actions"][data-deferred]').length,
  voiceButtons: document.querySelectorAll('button[aria-label="Use voice mode"]').length,
  sendNowButtons: document.querySelectorAll('button[data-testid="awaiting-turn-send-now"]').length,
  recorders: document.querySelectorAll('[data-keyboard-shortcut-input]').length
})

// 3. Test live trigger (with at least one completed reply or queued message)
await window.__cdbCustomShortcuts.trigger("readAloud")
await window.__cdbCustomShortcuts.trigger("sendNow")
```

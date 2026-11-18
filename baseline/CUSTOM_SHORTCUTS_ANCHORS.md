# Custom Shortcuts Runtime Anchors

Anchors relied upon by [`js/custom_shortcuts_page.js`](../js/custom_shortcuts_page.js) (injected by [`patches/community/add_feature_custom_shortcuts.nim`](../patches/community/add_feature_custom_shortcuts.nim)) and verified against **upstream `5.11492.5`** (`ion-dist.asar`).

Remember: `claude.ai` itself is remote web code and can change independently of a `.deb` release. Every missing anchor in `custom_shortcuts_page.js` degrades to a short toast notice plus a deduped `[cdb-shortcuts]` warning line in DevTools and `claude-patches.log`.

## Page-side anchors (`ion-dist.asar` / `claude.ai`)

| Action | Selector / Fiber Prop | Upstream Source (`5.11492.5`) | Fallback / Guard |
|--------|-----------------------|---------------------------------|------------------|
| **Read Aloud — button** | `[data-testid="action-bar-read-aloud"][data-state]` | `BV` (`shared-36`, `ca2ef848d`) renders `data-state` in `"idle" \| "playing" \| "paused" \| "loading"` | Fiber ancestor check (`onReadAloud` or `messageUuid` + `getText`), then `aria-label` `/^(Read aloud\|Pause\|Resume\|Stop)$/i` (`[cdb-shortcuts] read-aloud-testid-fallback` / `read-aloud-label-fallback`) |
| **Read Aloud — message scope** | `[data-testid="assistant-message"][data-is-streaming]` | Chat turn container (`c71860c77`, `shared-36`) | Prefers newest non-streaming reply; shows `"Wait for Claude to finish responding"` if only a streaming reply exists |
| **Read Aloud — deferred actions** | `[data-cds="MessageActions"][data-deferred]`, `[data-testid="message-actions"][data-deferred]` | `S0` defers action buttons until hover/focus or `button.sr-only` (`Show message actions`) click | Dispatches `mouseover`/`pointerover`/`pointerenter`, clicks `.sr-only` while saving/restoring `document.activeElement`, polls up to `18` animation frames |
| **Voice Mode — start** | `button[aria-label="Use voice mode"]`; React fibers `qR` (`state === "idle"` + `onStart`) and `xR` (`items` with `icon: "Phone"` / `icon: "Voice"`) | `OR`, `kR`, `xR`, `qR` (`ca2ef848d`, `c4a9ee384`) | Tries `qR.onStart`, direct button click, `xR` `Phone` item, and finally pins `Voice` radio item and waits `400 ms` past `ER` mistap guard |
| **Voice Mode — mistap guard** | Composer mount / `startsVoice` flip settle delay (`350 ms`) | `ER` (`c4a9ee384`) | `VOICE_MISTAP_SETTLE_MS = 400` in `custom_shortcuts_page.js` checks for active voice bar and retries once if voice stayed idle |
| **Voice Mode — stop** | React fiber `qR` (`state === "active" \| "connecting"`, `onEnd` / `onCancel`) | `qR` (`c4a9ee384`) | DOM fallback looks for visible `Stop` / `Cancel` / `End voice mode` adjacent to microphone mute or held-voice controls (`[cdb-shortcuts] voice-active-dom-fallback`) |
| **New Voice Chat** | `globalThis.__cdbNavigation.getDispatcher(wc).dispatchNavigate("/new")` or `a[href="/new"]` / `[data-testid="new-chat-trigger"]` | `Navigation` plugin (captured by `add_feature_extra_settings.nim`) + sidebar link | Polls until `location.pathname` is `/new` (or `/`) and an idle voice starter renders, waits `400 ms` past mistap guard, then starts Voice Mode |
| **Shortcut recorder lock** | `[data-keyboard-shortcut-input]` | Upstream shortcut recorder components (`shared-21`, `shared-36`) + Extra Settings `.cdbx-sc-pill` | `focusin`/`focusout` notifies `cdbExtra.customShortcutsRecording(bool)` so `before-input-event` and `globalShortcut` pause during recording |

## `[cdb-shortcuts]` warning keys

Any of these once-per-page lines in DevTools or `logs/claude-patches.log` indicates an upstream selector/fiber drift worth auditing:

- `read-aloud-testid-fallback` — `data-testid="action-bar-read-aloud"` moved; fell back to React fiber props.
- `read-aloud-label-fallback` — both testid and fiber props missed; fell back to `aria-label`.
- `read-aloud-missing-after-hydrate` / `read-aloud-missing` — assistant reply lacked any discoverable Read Aloud trigger.
- `voice-active-dom-fallback` — active voice pill fiber (`state`/`onEnd`) moved; fell back to adjacent mic-button DOM check.
- `voice-button-missing` / `new-voice-button-missing` — no Voice Mode button/fiber found on the active chat route.
- `new-chat-nav-missing` / `new-chat-timeout` — navigating to `/new` failed or timed out waiting for the new-chat voice button.

## DevTools console verification recipes

Run inside a live Claude Chat window with DevTools enabled:

```js
// 1. Inspect detected DOM & state snapshot
window.__cdbCustomShortcuts.state()

// 2. Dry-check selectors in an open conversation with at least one reply
({
  assistantTurns: document.querySelectorAll('[data-testid="assistant-message"]').length,
  readAloudButtons: document.querySelectorAll('[data-testid="action-bar-read-aloud"]').length,
  deferredBars: document.querySelectorAll('[data-cds="MessageActions"][data-deferred], [data-testid="message-actions"][data-deferred]').length,
  voiceButtons: document.querySelectorAll('button[aria-label="Use voice mode"]').length,
  recorders: document.querySelectorAll('[data-keyboard-shortcut-input]').length
})

// 3. Test live trigger (with at least one completed reply)
await window.__cdbCustomShortcuts.trigger("readAloud")
```

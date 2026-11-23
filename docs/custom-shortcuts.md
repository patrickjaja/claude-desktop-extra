# Custom Shortcuts

Assign optional, user-configurable keyboard shortcuts for **Voice mode**, **New voice chat**, **Read aloud**, and **Send queued message now** (issues [#350](https://github.com/patrickjaja/claude-desktop-extra/issues/350) and [#352](https://github.com/patrickjaja/claude-desktop-extra/issues/352)).

To keep upstream and custom behavior cleanly separated, this feature adds its own **Custom Shortcuts** page in **Settings → Extra → Custom Shortcuts** (placed between **Models** and **Anthropic**) plus an opt-in **Custom shortcuts** master switch in **Settings → Extra → Community Features**. Upstream's own **Settings → Desktop app** shortcuts (**Quick Entry** and **Dictation**) are left untouched.

Everything starts **off and unbound** by default. When disabled or unbound, upstream behavior is unchanged.

## Actions

| UI title | Config ID | CLI slug (`--trigger-shortcut`) | Behavior |
|----------|-----------|---------------------------------|----------|
| **Voice mode in current chat** | `voiceMode` | `voice-mode` | Starts Voice mode in the focused chat view (closing Settings if open), or ends/cancels an active/connecting voice session. Shows a notice when invoked on unsupported views such as `/code` or `/cowork`. |
| **New voice chat** | `newVoiceChat` | `new-voice-chat` | Ends any active voice session, navigates to `/new`, waits past the app's composer mistap guard, and starts Voice mode in the new thread. |
| **Read aloud latest reply** | `readAloud` | `read-aloud` | Pauses/resumes an active Read Aloud button if one is playing/loading, otherwise starts Read Aloud on the newest completed Claude reply (hydrating deferred message actions without stealing focus from the composer). Works in Chat and in Code-tab sessions, including when a card sits between the reply and its action bar; a second press pauses it. |
| **Send queued message now** | `sendNow` | `send-now` | Clicks the visible **Send now** (or **Send N now**) button on a queued message in Code, Chat, or Cowork so Claude reads it immediately instead of waiting for the current turn, without stealing focus from the composer. |

## Shortcut recorder rules

Click a shortcut pill in **Settings → Extra → Custom Shortcuts** and press the combination you want:

- **Modifiers:** Requires at least one primary modifier (`Ctrl`, `Alt`, `Super`), unless you bind a standalone function key (`F1`–`F24`). `Shift` alone is rejected so normal typing never breaks.
- **Reserved & conflicting keys:** Standard editing/app shortcuts (`Ctrl+C`, `Ctrl+V`, `Ctrl+X`, `Ctrl+A`, `Ctrl+Z`, `Ctrl+Y`, `Ctrl+W`, `Ctrl+Q`, `Ctrl+N`, `Ctrl+T`, `Ctrl+R`, `Ctrl+F`, `Ctrl+P`, `Ctrl+D`, `Ctrl+,`, `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+Alt+Space`, `Ctrl+Shift+I`, `Ctrl+Alt+I`, `Ctrl+Shift+T`, `Ctrl+Shift+J`, `Ctrl+Shift+P`, `Ctrl+Shift+R`, `Alt+F4`, `F5`, `F11`, `F12`) and `AltGr` are rejected, as are duplicate bindings across the custom actions.
- **Cancel / clear:** Press `Escape` while recording to cancel without changing the binding; press `Backspace`/`Delete` while recording or click the pill's `×` button to clear the binding.
- **Keyboard layouts (QWERTZ / AZERTY / non-Latin):** Latin letters match by produced character on your active layout (e.g. `Z` on German QWERTZ), digits match by `Digit0`–`Digit9` keycode so shifted symbols work cleanly, and non-Latin active XKB groups fall back to physical `Key*` codes. Auto-repeat and IME composition events are ignored, and shortcuts do not fire while any shortcut recorder (`[data-keyboard-shortcut-input]`) is focused.

## Scope & Linux desktop matrix

Each action can be set to **In-app** or **Global**, and all actions can also be triggered over the per-profile Quick Entry Unix socket via `claude-desktop --trigger-shortcut <action>`:

| Session type / DE | In-app shortcut | Global scope (`electron.globalShortcut`) | Recommended global fallback |
|-------------------|----------------|------------------------------------------|-----------------------------|
| **X11** (XFCE, i3, Cinnamon, MATE, GNOME Xorg, Plasma X11) | Works natively via `before-input-event` | Works natively (`electron.globalShortcut`) unless held by another app | Optional: bind `claude-desktop --trigger-shortcut <slug>` in your WM/DE |
| **XWayland** (`CLAUDE_USE_XWAYLAND=1`) | Works natively inside Claude | Reaches X11/XWayland-focused windows | Compositor keybind calling `claude-desktop --trigger-shortcut <slug>` for Wayland-native focus |
| **KDE Plasma Wayland** | Works natively inside Claude | Works via `org.freedesktop.portal.GlobalShortcuts` (`js/kde_global_shortcuts_rebind.js` re-arms registered bindings across restarts) | Same portal or KWin custom shortcut running `claude-desktop --trigger-shortcut <slug>` |
| **GNOME Wayland (48+)** | Works natively inside Claude | Portal available (`org.freedesktop.portal.GlobalShortcuts`); requires approving the desktop portal prompt once | GNOME Settings → Keyboard → Custom Shortcuts → `claude-desktop --trigger-shortcut <slug>` |
| **wlroots / Sway / Niri / River / older GNOME (<48)** | Works natively inside Claude | `xdg-desktop-portal-wlr` exposes no `GlobalShortcuts` portal; Claude detects this dynamically and reports **In-app** + CLI guidance | Bind `claude-desktop --trigger-shortcut <slug>` in `~/.config/sway/config`, `niri`, etc. (~5–25 ms socket roundtrip) |
| **Hyprland** | Works natively inside Claude | Portal behavior varies by `xdg-desktop-portal-hyprland` build | Add `bind = SUPER SHIFT, V, exec, claude-desktop --trigger-shortcut voice-mode` in `hyprland.conf` |

For named profiles (`--profile=NAME`), `--trigger-shortcut` connects to the active profile's socket automatically when `--profile=NAME` or `claude-desktop-NAME` is used.

## Configuration schema (`claude-desktop-extra.json` / `.jsonc`)

Settings are saved per profile under `customShortcuts` in `~/.config/Claude/claude-desktop-extra.json` (or `~/.config/Claude-3p/` / `~/.config/Claude-<profile>/`). Placing values in `claude-desktop-extra.jsonc` overrides and locks those specific keys in the UI:

```jsonc
{
  "customShortcuts": {
    "enabled": true,
    "bindings": {
      "voiceMode": { "accelerator": "Ctrl+Shift+V", "scope": "app" },
      "newVoiceChat": { "accelerator": "Ctrl+Alt+V", "scope": "global" },
      // Shorthand string form defaults to scope "app"
      "readAloud": "Ctrl+Alt+R",
      "sendNow": "Alt+Return"
    }
  }
}
```

- Setting `"customShortcuts": false` in `.jsonc` disables and locks the entire feature and all bindings.
- Setting only `"bindings"` in `.jsonc` locks only those specific action rows while leaving the master switch editable.

## Implementation files

- [`patches/community/add_feature_custom_shortcuts.nim`](../patches/community/add_feature_custom_shortcuts.nim)
- [`js/custom_shortcuts_main.js`](../js/custom_shortcuts_main.js)
- [`js/custom_shortcuts_page.js`](../js/custom_shortcuts_page.js)
- [`patches/core/fix_quick_entry_cli_toggle.nim`](../patches/core/fix_quick_entry_cli_toggle.nim) & [`scripts/claude-desktop-launcher.sh`](../scripts/claude-desktop-launcher.sh) (`shortcut:<slug>` socket & `--trigger-shortcut`)
- [`js/extra_settings_bridge.js`](../js/extra_settings_bridge.js) & [`js/extra_settings_page.js`](../js/extra_settings_page.js) (**Settings → Extra → Custom Shortcuts**)

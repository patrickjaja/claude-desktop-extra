# Feature Flag Overrides (advanced)

Overriding Claude Desktop's server-side GrowthBook flags locally. For the short version, see [Feature Flag Overrides in the README](../README.md#feature-flag-overrides-advanced).

Claude Desktop gates many features behind server-side GrowthBook flags with no built-in local override. This package adds one: **`~/.config/Claude/claude-desktop-extra.jsonc`** (per-profile: the profile's userData dir; auto-created with a commented template on first launch). It is the same config file the [Custom Themes](themes.md) use - one file for both. Config files from the previous package name (`claude-desktop-bin.jsonc`, legacy `claude-desktop-bin.json`) are picked up automatically - the file is migrated to the new name on first launch, nothing to do. Uncomment an entry to activate it - comments are allowed:

```jsonc
{
  "growthbookOverrides": {
    "1129419822": true   // ENABLE_TOOL_SEARCH - tool search in local agent sessions
  }
}
```

The file is re-read on every flag load (startup and each periodic refresh) and overrides win over the server rollout; active overrides are logged to `logs/claude-patches.log`. `true`/`false` for switches, numbers/strings/objects for value flags. Most gated features are wired up while the app starts, so restart after changing a flag.

**Full flag catalog:** the auto-created template lists *every* GrowthBook flag the app reads from its feature store, each commented out with a short description - browse it here: **[docs/claude-desktop-extra.jsonc](claude-desktop-extra.jsonc)**. It reflects the version noted in the file header; CI verifies it stays in sync with the shipped template.

**Or flip them in the app:** Settings → **Extra** → **Anthropic Features** renders the same catalog - all 387 flags - as switches, pre-set to what your account actually gets, and writes your changes to `growthbookOverrides` in `claude-desktop-extra.json` (it offers a Restart now button, for the reason above). Value-carrying flags are shown read-only, and a flag you set by hand in the `.jsonc` stays owned by that file - hand edits win per flag ID and the panel will not overwrite them.

**Scope and caveats:** flag IDs are Anthropic-internal and can vanish or change meaning in any release; this is unsupported expert territory - if the app misbehaves, empty the file first. The Computer Use patch forces its own enable gate directly and doesn't consult this file, and server-side account capabilities can't be overridden locally at all. Hardware Buddy (`2358734848`) is force-enabled on Linux through this same store-override mechanism, so a `"2358734848": false` entry here opts back out.

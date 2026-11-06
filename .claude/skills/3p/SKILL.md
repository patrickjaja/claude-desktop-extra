---
name: 3p
description: Reference for the 3p / enterprise / inference-gateway deployment of Claude Desktop on Linux - how /etc/claude-desktop/managed-settings.json is read, what "3p mode" changes (separate ~/.config/Claude-3p userData, hidden Chat tab, the false VM-download banner), how Cowork still runs under it, which hardcoded paths are safe vs split under the -3p switch, and how to verify it all from logs. Use when working on managed-settings.json, inferenceProvider/gateway/Bedrock/Vertex configs, the 3p setup SPA (ion-dist), the Claude-3p directory, or debugging managed-deployment Cowork.
when_to_use: When the user mentions managed-settings.json (or the old enterprise.json), managed/MDM config, 3p / third-party deployment, inferenceProvider (gateway/bedrock/vertex/foundry/mantle), an inference gateway / LiteLLM, the Claude-3p config dir, the "Download a one-time package" banner, deploymentMode, the 3P setup window, or edits fix_marketplace_linux / fix_ion_dist_linux.
paths: patches/linux/fix_marketplace_linux.nim, patches/linux/fix_ion_dist_linux.nim, baseline/ION.md
---

# 3p / enterprise / inference-gateway deployment on Linux

"3p" = **third-party / managed deployment**: Claude Desktop pointed at a non-Anthropic inference
backend (Bedrock, Vertex, Azure, or a self-hosted **gateway** like LiteLLM) and/or an MDM-managed config.
On Linux it is driven by `/etc/claude-desktop/managed-settings.json`.
Minified names below are version-specific (they churn every release - see `/linux`); anchor on stable
strings. Verified against v1.14271.0.

## managed-settings.json (`/etc/claude-desktop/managed-settings.json`)

The **official Linux build reads `/etc/claude-desktop/managed-settings.json` natively** - it ships a Linux
managed-config reader, so we no longer patch the win32-registry/macOS-plist reader the way the old MSIX
pipeline did. (Historical note: on the MSIX, `fix_enterprise_config_linux.nim` injected a Linux JSON reader
for the old `enterprise.json` path; that patch and path are obsolete now that the official build does it.)
Schema is documented in memory `project_enterprise_json_schema` - the load-bearing facts:
- Top-level **`managedMcpServers`** is an **array** (`name`+`transport`+`url`/`command`), NOT an object-keyed
  `mcpServers` map (that is silently dropped by the schema parser - no warning).
- Inference-gateway keys: `inferenceProvider` (`"gateway"`/`"bedrock"`/`"vertex"`/…), `inferenceGatewayBaseUrl`,
  `inferenceGatewayApiKey`, `inferenceGatewayAuthScheme`, `inferenceModels` (array; first is default),
  `disableDeploymentModeChooser:true`.
- **Any** of `inferenceProvider` / `bootstrapUrl` present + (`disableDeploymentModeChooser` OR persisted
  `deploymentMode!=="1p"`) flips the app into 3p mode.

## What "3p mode" changes (all upstream behavior, not our patches)

| Effect | Why | Our stance |
|---|---|---|
| **userData -> `~/.config/Claude-3p/`** | Upstream `setPath("userData", base+"-3p")` at bootstrap, guarded by `!process.env.CLAUDE_USER_DATA_DIR`. Logs `[custom-3p] ...`. | **Intended** - isolates 1p login from 3p. Keep it. (To collapse: export `CLAUDE_USER_DATA_DIR` in the launcher - it short-circuits the suffix. Not done by default.) |
| **Chat tab hidden** | `chatTabEnabled:A=>A.chatTabEnabled===!0` (strict; default off in 3p). Cowork/Code stay (`!==!1`). | **Intended.** To restore: add `"chatTabEnabled": true` to managed-settings.json (config-only, no patch). |
| **3P setup SPA** at `app://localhost/setup-desktop-3p` | The ion-dist config UI. | `fix_ion_dist_linux` + `fix_marketplace_linux`. Config-key schema in `baseline/ION.md`. |

`[custom-3p]` in `main.log` is **upstream's own** log namespace - do not mistake it for a patch tag.

## Cowork under 3p: works the same as 1p, on the official native backend

Cowork runs on the **official native Cowork VM backend** bundled in the Linux `.deb` (cowork-linux-helper
+ QEMU/OVMF; requires `/dev/kvm` and `/dev/vhost-vsock`) - the same local VM 1p offers optionally (3p has no cloud Cowork; Settings -> Extra -> Cowork (Linux) -> Enable KVM access). There is no separate daemon (the old
`claude-cowork-service` is deprecated). The 3p OAuth bounce (issue #142 / `session_stale_relogin`) only
fires for a genuinely broken token; a logged-in account with credits + valid Anthropic models does **not**
bounce. (Provider model names matter: `inferenceModels` must be Anthropic models or the config-health gate
reports `config_model_rejected`. A `gpt-*` entry, or no credits -> `billing_error`, makes a *turn* fail and
looks like a bounce - it is not.)

The old "Download a one-time package" banner (`getDownloadStatus()` -> `NotDownloaded` because the local
VM-image check never matched on the MSIX build) is no longer ours to patch: the official Linux build ships
the native Cowork VM backend, so the historical `fix_cowork_download_status_linux.nim` patch is obsolete.

## Does the `Claude-3p` split break anything? (hardcoded-path audit, verified)

**No load-bearing path breaks.** State *isolates* between `Claude` (1p) and `Claude-3p` (3p) by design;
nothing crashes or cross-leaks. Rules:
- **Markers/sockets** (quick-entry, SSO-callback) live in `$XDG_RUNTIME_DIR` (+`CLAUDE_PROFILE`),
  not `.config` -> **unaffected** by the userData switch.
- **All Electron userData** (sessions, logs, `claude_desktop_config.json`, custom-themes JSON, screenshot
  restore-token) goes through `app.getPath("userData")`, which **auto-relocates** to `Claude-3p`. So it
  *follows* the split (e.g. a custom-theme set in 1p won't carry into 3p - cosmetic only).
- **CLI config** uses `CLAUDE_CONFIG_DIR` (launcher); **autostart** `.desktop` files live in the XDG
  `~/.config/autostart/` spec dir and are `CLAUDE_PROFILE`-aware - both correctly **not** tied to the
  `-3p` userData.
- **The rule for new patches:** write user state via `app.getPath("userData")` (auto-isolates), never a
  literal `os.homedir()+"/.config/Claude"`. The Python screenshot fallback `~/.config/Claude/...` in
  `js/cu_linux_executor.js` is dead code (the JS always passes the real `getPath` value via
  `CLAUDE_PORTAL_TOKEN_PATH`) - harmless, but don't copy that pattern.

## Verify it loaded / works (logs at `~/.config/Claude-3p/logs/`)

**Note the dir: 3p logs to `~/.config/Claude-3p/`, NOT `~/.config/Claude/`.** Reading the wrong dir gives
stale/1p evidence.
```bash
L=~/.config/Claude-3p/logs/main.log
rg -a 'Enterprise config loaded|custom-3p\] (3P mode active|Credentials loaded|ConfigHealth)' "$L" | tail
# healthy gateway:  [custom-3p] ConfigHealth recomputed { state: 'healthy', provider: 'gateway' }
rg -a 'LocalAgentModeSessions.start|Turn succeeded|cycle_health|session_stale_relogin|config_model_rejected|billing_error' "$L" | tail
# Cowork spawn proof (official native VM backend):
rg -a 'Using Claude VM spawn|Spawn succeeded|vmStarted|Turn succeeded' ~/.config/Claude-3p/logs/cowork_vm_node.log | tail
```

## Related
- `baseline/ION.md` - 3P setup SPA bundle, patched patterns, config-key schema (`inferenceProvider`,
  `deploymentOrganizationUuid`, …) and the `~/.config/Claude-3p/claude_desktop_config.json` path.
- memory `project_enterprise_json_schema` - the exact managed-settings.json shape + how to confirm it loaded.
- memory `issue142_cowork_3p_oauth_regression` - the OAuth-bounce mechanism (only bites a broken token).

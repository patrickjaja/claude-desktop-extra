# Third-Party Inference on Linux

The upstream **Developer → Configure Third-Party Inference** wizard works on Linux as of v1.6259 (after the `ion-dist` packaging fix in #57). This page covers the Linux-specific bits that aren't in the [official Anthropic 3P docs](https://claude.com/docs/cowork/3p/installation) - which only cover macOS and Windows - plus the headless `/etc/claude-desktop/managed-settings.json` route for fleet rollouts and remote/CI machines where the wizard isn't practical.

> **Migrating from `enterprise.json`?** Earlier releases of this package read managed config from `/etc/claude-desktop/enterprise.json`. The official Linux build reads `/etc/claude-desktop/managed-settings.json` natively instead. **Existing deployments must rename the file** (`sudo mv /etc/claude-desktop/enterprise.json /etc/claude-desktop/managed-settings.json`). The schema and keys are unchanged - `managedMcpServers` (array), `inferenceProvider`, `deploymentMode`, etc. all stay exactly as they were; only the filename moved. Drop `betaFeaturesEnabled` while you are at it: the current build no longer knows that key, and one unknown key makes it ignore the whole file.

> **Looking for the full `managed-settings.json` key reference?** This page is the Linux *how-to*. For the complete, authoritative list of every config key, see Anthropic's official docs:
> - [Configuration reference](https://claude.com/docs/cowork/3p/configuration) - every key, all providers, credential helpers, security profiles.
> - [Enterprise configuration for Claude Desktop](https://support.claude.com/en/articles/12622667-enterprise-configuration-for-claude-desktop) - managed-preferences overview.

## Three routes

| Route | When to use |
|---|---|
| **Settings → Extra → Deployment** *(this package)* | Any single-user install, and the only route that also switches **back** to 1P. One switch for the mode, every config key as a toggle or field, no root. Written to your own profile dir, so each [profile](../README.md#multiple-profiles) has its own. |
| **Developer → Configure Third-Party Inference** *(upstream wizard)* | Provider-guided setup with credential probing and sign-in flows (Bedrock SSO, Vertex OAuth, Entra ID). Writes to the same store as the panel above, so the two show each other's values. |
| **`/etc/claude-desktop/managed-settings.json`** | Fleet/MDM rollouts, headless servers, scripted provisioning. Needs root, and while it is valid it replaces everything local. |

All three write the same underlying schema; only the location and who may write it differ.

## Route A: the in-app Deployment panel

**Settings → Extra → Deployment** (added by this package - see [The "Extra" Settings](../README.md#the-extra-settings)).

![Settings → Extra → Deployment: the 1P/3P switch, the active configuration and the third-party config keys](extra/deployment.png)

1. **The mode switch** at the top shows what the running session is and what the next start will use. `1P` persists upstream's `deploymentMode` key, which is what lets a machine that already has a 3P config boot personal again; `3P` switches back. The mode is chosen in the bootstrap before any window exists, so the panel asks for a restart when the two disagree.
2. **Pick a provider** under *Inference & connection*. The provider-specific fields (gateway URL and key, Vertex project and region, Bedrock region and profile, Foundry resource, …) appear once the provider is selected; "Show keys for every provider" reveals the rest.
3. **Everything else is a toggle or a field**, grouped the way upstream's own schema groups it: surfaces and sandbox (Chat/Cowork/Code tabs, workspace folders, egress allowlist, disabled built-in tools), connectors and extensions, plugins, telemetry and updates, usage limits, branding, bootstrap. A key you never touch stays absent from the file, and Claude Desktop uses its own default.
4. **The file itself** is at the bottom - a raw JSON editor for anything the form does not cover, and links that open the config file, the mode file and the policy file in your editor or file manager.

Where it writes (`~/.config/Claude-3p/`, or `~/.config/Claude-<profile>-3p/` for a named profile):

| File | Holds |
|---|---|
| `configLibrary/<id>.json` | The configuration itself, in the same flat schema as `managed-settings.json`. The panel edits the **applied** entry, which is the one upstream's own wizard uses too. |
| `configLibrary/_meta.json` | Which entry is applied (`appliedId`) and the list of stored ones. The panel's *Active configuration* picker switches between them; picking **None** boots 1P and leaves every file on disk. |
| `claude_desktop_config.json` | The persisted `deploymentMode` (`"1p"` / `"3p"`), which is also what `claude-desktop --1p` / `--3p` write. |

Both files are written `0600` in a `0700` directory, because they hold inference credentials. A stored credential is **write-only** in the panel: it can be replaced, never displayed. Two keys stay read-only there and must be deployed through the policy file: `disableDeploymentModeChooser` (it disables claude.ai sign-in, i.e. it is exactly what locks a machine into 3P) and `managedMcpServers` (an entry can start a process).

To promote a working local config to a fleet policy, copy it and restart:

```bash
sudo install -d -m 755 /etc/claude-desktop
sudo install -m 644 ~/.config/Claude-3p/configLibrary/*.json /etc/claude-desktop/managed-settings.json
```

## Route B: upstream's in-app wizard

1. **Enable Developer Mode** (the menu item is hidden otherwise):
   - Click your avatar (bottom-left) → **Settings** → toggle **Developer Mode** on.
   - Restart Claude Desktop.
2. New top-level menu **Developer** appears. Click **Developer → Configure Third-Party Inference**.
3. Pick your provider, fill credentials, save. The wizard writes the same JSON as Route C, into the same store as Route A.

If the menu item opens an empty window, the wizard's pages are missing: they ship as `resources/ion-dist.asar` in the install directory (e.g. `/usr/lib/claude-desktop/resources/ion-dist.asar`), which must be a regular file; `main.log` then reports `the app's bundled web pages (ion-dist.asar) are missing or are not a regular file`. Reinstall the package (builds before v1.6259 did not ship the wizard at all), or use Route A.

## Route C: manual `managed-settings.json`

The app reads `/etc/claude-desktop/managed-settings.json` on every launch. Setting `inferenceProvider` flips the app into 3P mode and bypasses the personal claude.ai sign-in flow.

### Vertex AI (verified)

Tested on Ubuntu 25.10 with v1.6259.1-1, using existing `gcloud auth application-default login` credentials (no service account file).

```bash
# 1. Make sure your gcloud ADC is in place and the project has Vertex AI access:
gcloud auth application-default login
gcloud auth application-default print-access-token   # should print a token
gcloud config get-value project                      # should print your project ID

# 2. Drop the policy file (uses ADC by default; no credential paths needed):
sudo install -d -m 755 /etc/claude-desktop
sudo tee /etc/claude-desktop/managed-settings.json >/dev/null <<'JSON'
{
  "inferenceProvider": "vertex",
  "inferenceVertexProjectId": "your-gcp-project-id",
  "inferenceVertexRegion": "global",
  "inferenceModels": [
    { "name": "claude-opus-4-7", "supports1m": true },
    { "name": "claude-sonnet-4-6", "supports1m": true }
  ],
  "disableDeploymentModeChooser": true
}
JSON

# 3. Fully restart the app - config is read once at startup:
pkill -x claude-desktop 2>/dev/null
nohup claude-desktop >/dev/null 2>&1 &
```

**What each key does:**

- `inferenceProvider: "vertex"` - required. Activates 3P mode. Other valid values: `"gateway"`, `"bedrock"`, `"foundry"`.
- `inferenceVertexProjectId` - required. Your GCP project ID.
- `inferenceVertexRegion` - required. Either a GCP region (`us-east5`, `europe-west1`, …) or `"global"` for Vertex's global endpoint. Validator regex: `^([a-z]+-[a-z]+\d{1,2}|global)$`.
- `inferenceModels` - required when not using bootstrap. List of model entries shown in the picker; **first entry is the default**. Each entry is either a string (`"claude-sonnet-4-6"`) or an object (`{ "name": "claude-opus-4-7", "supports1m": true }` to enable the 1M-token context window for models that support it on Vertex).
- `disableDeploymentModeChooser: true` - optional. Hides the personal claude.ai sign-in option entirely. Recommended for 3P-only setups; omit if you want to be able to switch back.

**Authentication options** (any one):

| Option | How |
|---|---|
| Application Default Credentials *(default)* | Leave `inferenceVertexCredentialsFile` unset. The app picks up `~/.config/gcloud/application_default_credentials.json` from `gcloud auth application-default login`. |
| Service account key file | Set `inferenceVertexCredentialsFile: "/etc/claude/vertex-sa.json"` (any absolute path). |
| Vertex OAuth client (Sign-in with Google) | Set `inferenceVertexOAuthClientId` + `inferenceVertexOAuthClientSecret` + `inferenceVertexOAuthScopes`. |

### Bedrock and Foundry

Same shape as Vertex but with provider-specific keys. The full validator schema lives in `app.asar` - these keys are surfaced in the in-app wizard form, so the path of least resistance is:

1. Set `inferenceProvider: "bedrock"` (or `"foundry"`) plus the bare-minimum required keys.
2. Restart, open **Developer → Configure Third-Party Inference**, fill in the rest interactively.
3. Optionally export the resulting config and redeploy via `managed-settings.json`.

Bedrock keys: `inferenceBedrockRegion`, `inferenceBedrockBearerToken`, `inferenceBedrockProfile`, `inferenceBedrockSso{StartUrl,Region,AccountId,RoleName}`, `inferenceBedrockServiceTier`.

Foundry keys: `inferenceFoundryResource`, `inferenceFoundryApiKey`.

### Gateway (LiteLLM, Portkey, in-house proxy)

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "https://your-gateway.example.com/v1",
  "inferenceGatewayApiKey": "...",
  "inferenceGatewayAuthScheme": "bearer",
  "inferenceModels": [{ "name": "claude-sonnet-4-6" }]
}
```

`inferenceGatewayAuthScheme` accepts `"auto"`, `"x-api-key"`, `"bearer"`, or `"sso"`. For gateways that expose a `/v1/models` endpoint, `inferenceModels` is optional - the picker uses model discovery.

#### 5-minute local quickstart (LiteLLM container)

Want to see Linux 3P working end-to-end before wiring it to your real fleet gateway? Stand up a [LiteLLM](https://github.com/BerriAI/litellm) proxy locally, point Claude Desktop at it, and you'll be running Cowork + Code against your own inference endpoint in a few minutes. This is the exact shape used in production - just trimmed to Anthropic-only so it's copy-paste runnable.

**1. Minimal LiteLLM config** - `litellm_config.yaml` (Anthropic passthrough only; no secrets in the file, the key is read from the environment):

```yaml
model_list:
  # model_name MUST match the IDs in managed-settings.json inferenceModels.
  # Bare aliases (no dated suffix) are valid Anthropic IDs.
  - model_name: claude-opus-4-8
    litellm_params:
      model: anthropic/claude-opus-4-8
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: claude-sonnet-4-6
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

general_settings:
  # The gateway's own bearer token. Clients (Claude Desktop) send this;
  # it is NOT your Anthropic key. Pick any strong string.
  master_key: os.environ/LITELLM_MASTER_KEY

litellm_settings:
  drop_params: true
```

**2. Run the proxy** - one container, two env vars (replace both values; nothing is persisted to the image):

```bash
docker run --rm -p 4000:4000 \
  -v "$(pwd)/litellm_config.yaml:/app/config.yaml:ro" \
  -e ANTHROPIC_API_KEY="sk-ant-…your-anthropic-key…" \
  -e LITELLM_MASTER_KEY="sk-pick-any-strong-gateway-token" \
  ghcr.io/berriai/litellm:main-stable \
  --config /app/config.yaml --port 4000

# sanity check from another terminal - should list claude-opus-4-8 / claude-sonnet-4-6:
curl -s http://127.0.0.1:4000/v1/models \
  -H "Authorization: Bearer sk-pick-any-strong-gateway-token" | python3 -m json.tool
```

**3. Point Claude Desktop at it** - `/etc/claude-desktop/managed-settings.json`. The `inferenceGatewayApiKey` here is the gateway's `master_key` from step 2 (**not** your Anthropic key):

```bash
sudo install -d -m 755 /etc/claude-desktop
sudo tee /etc/claude-desktop/managed-settings.json >/dev/null <<'JSON'
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:4000",
  "inferenceGatewayApiKey": "sk-pick-any-strong-gateway-token",
  "inferenceGatewayAuthScheme": "bearer",
  "inferenceModels": [
    { "name": "claude-opus-4-8" },
    { "name": "claude-sonnet-4-6" }
  ],
  "disableDeploymentModeChooser": true,
  "chatTabEnabled": true,
  "coworkTabEnabled": true
}
JSON
sudo chmod 644 /etc/claude-desktop/managed-settings.json
```

> **Surface toggles** (all `scopes:["3p"]`): `chatTabEnabled` brings back the **Chat** tab (the claude.ai web surface), `coworkTabEnabled` the **Cowork** tab, and `isClaudeCodeForDesktopEnabled` the **Code** tab. Omit one to hide that surface. At least one surface has to stay on - the app re-enables Cowork if you switch them all off. See the [maximum example](#maximum-managed-settingsjson-every-key) below for the full set.

> **Every key in this file must be one the running build knows.** A single unrecognized key makes Claude Desktop discard the **whole** managed file (`[managedConfig] Ignoring …: unrecognized configuration key`) and fall back to no policy at all - so drop keys you copied from an older deployment rather than leaving them in "just in case". `betaFeaturesEnabled` is one of those: it was accepted by builds up to ~v1.14271 and is gone since v1.24012.9 (same in v1.26832.0). The [Deployment panel](#route-a-the-in-app-deployment-panel) renders the current build's key set and refuses to write anything outside it, which is the cheapest way to check a file.

**4. Restart and verify** (see [Verifying it worked](#verifying-it-worked) for the full log signature):

```bash
pkill -x claude-desktop 2>/dev/null
nohup claude-desktop >/dev/null 2>&1 &
tail -f ~/.config/Claude/logs/main.log | grep -E 'custom-3p|account|inference'
```

You should see `[custom-3p] 3P mode active { provider: 'gateway' }` and an identity-changed line within a few seconds. Open a Cowork or Code session and confirm the model picker shows your two models.

> **Don't commit your real values.** `inferenceGatewayApiKey` and `ANTHROPIC_API_KEY` are credentials - keep them in `managed-settings.json` / env only. The redacted placeholders above are intentional. LiteLLM reads every secret from the environment (`os.environ/…`), so the config file itself is safe to check into a repo.

> **Beyond Anthropic:** LiteLLM can front Bedrock, Vertex, Azure, or any OpenAI-/Anthropic-compatible upstream - swap the `model_list` block and keep `managed-settings.json` identical. That's the point of the gateway provider: one stable client config, any backend behind it.

## Maximum `managed-settings.json` (every key)

The quickstart above is intentionally minimal. Below is a **feature-complete** gateway config that turns on every surface and shows the governance, telemetry, sandbox, and plugin knobs an enterprise rollout typically wants. Every key here is a real managed-config setting in v1.26832.0 (`scopes:["3p"]` or `["3p","1p"]`); add only the ones you need - and only ones the running build knows, or the whole file is ignored. Settings → **Extra** → **Deployment** lists this build's full key set with the same grouping. Keys marked **secret** must hold real credentials - keep this file readable only as needed and never commit real values.

```jsonc
{
  // ── Inference backend (pick ONE provider; gateway shown) ────────────────
  "inferenceProvider": "gateway",                 // anthropic | gateway | bedrock | vertex | foundry
  "inferenceGatewayBaseUrl": "http://127.0.0.1:4000",
  "inferenceGatewayApiKey": "sk-your-gateway-token",   // secret
  "inferenceGatewayAuthScheme": "bearer",         // auto | x-api-key | bearer | sso
  "inferenceModels": [
    // For providers with their own model IDs (Bedrock profiles, gateway aliases),
    // set anthropicFamilyTier so the app knows which Claude tier the ID maps to.
    { "name": "claude-opus-4-8",   "anthropicFamilyTier": "opus",   "supports1m": true },
    { "name": "claude-sonnet-4-6", "anthropicFamilyTier": "sonnet", "supports1m": true }
  ],
  "modelDiscoveryEnabled": false,                 // true = pull model list from the gateway's /v1/models
  "inferenceCustomHeaders": { "x-tenant": "acme" },    // extra headers on every inference request
  "disableDeploymentModeChooser": true,           // lock to 3P; hide personal claude.ai sign-in

  // ── Surfaces / tabs ─────────────────────────────────────────────────────
  "chatTabEnabled": true,                         // the Chat tab (claude.ai web surface)
  "coworkTabEnabled": true,                       // the Cowork tab
  "isClaudeCodeForDesktopEnabled": true,          // the Code tab (Claude Code)
  "chatAdvancedFileAnalysisEnabled": true,        // code-execution / advanced file analysis in Chat
  "autoModeEnabled": true,                        // allow Cowork "Auto" mode
  "claudeAiImport": true,                         // allow importing claude.ai data

  // ── MCP, plugins, extensions ────────────────────────────────────────────
  "managedMcpServers": [
    { "name": "atlassian-rovo", "transport": "http", "url": "https://mcp.atlassian.com/v1/mcp/authv2" }
  ],
  "isDesktopExtensionEnabled": true,
  "isDesktopExtensionSignatureRequired": true,    // only load signed extensions

  // ── Sandbox / workspace / egress (governance) ───────────────────────────
  "allowedWorkspaceFolders": ["/home", "/srv/projects"],   // restrict where sessions may operate
  "coworkEgressAllowedHosts": ["api.acme.example", "github.com"],  // network allowlist for Cowork
  "disabledBuiltinTools": [],                     // e.g. ["computer-use"] to block desktop control

  // ── Identity ────────────────────────────────────────────────────────────
  "deploymentOrganizationUuid": "00000000-0000-0000-0000-000000000000",

  // ── Updates ─────────────────────────────────────────────────────────────
  "disableAutoUpdates": false,
  "autoUpdaterEnforcementHours": 72,              // force an update after N hours

  // ── Telemetry (OpenTelemetry; all optional) ─────────────────────────────
  "otlpEndpoint": "https://otel.acme.example:4318",
  "otlpProtocol": "http/protobuf",                // grpc | http/protobuf
  "otlpHeaders": { "authorization": "Bearer <otel-token>" },   // secret
  "otlpResourceAttributes": { "service.name": "claude-desktop", "deployment.environment": "prod" },
  "otlpDesktopLogLevel": "info",

  // ── Usage limits (3P) ───────────────────────────────────────────────────
  "inferenceMaxTokensPerWindow": 2000000,
  "inferenceTokenWindowHours": 24,
  "inferenceSessionLifetimeSec": 28800
}
```

> `jsonc` (comments) is shown for readability - **strip the comments** before deploying; the file must be valid JSON. A few keys are `scopes:["1p"]`-only (claude.ai login deployments) and are therefore **not** valid in a 3P/gateway file: `requireCoworkFullVmSandbox`, `secureVmFeaturesEnabled`, `forceLoginOrgUUID`, `loginSsoOrgDomain`. For provider-specific blocks (Bedrock SSO, Vertex OAuth/workforce, Foundry tenant) and the exact accepted values of every key, see the [official configuration reference](https://claude.com/docs/cowork/3p/configuration).

**Switching the provider block:** keep everything from "Surfaces" down identical and replace only the inference block:

| Provider | Minimum required keys |
|---|---|
| **gateway** | `inferenceGatewayBaseUrl`, `inferenceGatewayApiKey`, `inferenceGatewayAuthScheme` |
| **vertex** | `inferenceVertexProjectId`, `inferenceVertexRegion` (+ ADC or `inferenceVertexCredentialsFile`) |
| **bedrock** | `inferenceBedrockRegion` + one auth: `inferenceBedrockBearerToken` *or* `inferenceBedrockProfile` *or* `inferenceBedrockSso{StartUrl,Region,AccountId,RoleName}` |
| **foundry** | `inferenceFoundryResource`, `inferenceFoundryApiKey` (or `inferenceFoundryTenantId` + `inferenceFoundryClientId`) |
| **anthropic** | `inferenceAnthropicApiKey` (direct to api.anthropic.com) |

For credential rotation without static keys, all providers support an external helper: `inferenceCredentialHelper` (+ `inferenceCredentialHelperTtlSec`, `inferenceCredentialHelperTimeoutSec`, `inferenceCredentialHelperSilentRefreshEnabled`).

## Verifying it worked

After restart, tail the log:

```bash
tail -f ~/.config/Claude/logs/main.log | grep -E 'custom-3p|account|inference'
```

You should see (within a few seconds of launch):

```
[custom-3p] Credentials loaded from enterprise config { provider: 'vertex', mcpServerCount: 0 }
[custom-3p] 3P mode active { provider: 'vertex' }
[custom-3p] Model discovery: not supported by provider; picker = 2 (inferenceModels)
[custom-3p] deploymentMode written { mode: '3p' }
[account] Identity changed (loggedOut: true → false, uuid: <none> → <uuid>)
```

If you see `[oauth] failed to obtain oauth token … Pro or Max subscription`, the policy file didn't load - most likely a JSON parse error. Validate it:

```bash
python3 -c 'import json; json.load(open("/etc/claude-desktop/managed-settings.json"))'
```

## Common gotchas

- **The file must be readable by your user.** `install -m 644` (used above) is correct. `chmod 600` will silently make Claude fall back to the default config.
- **Removing `managed-settings.json` does NOT exit 3P mode by itself.** The bootstrap (validated against v1.18286.0) picks the mode before any window exists, from the first config source that carries an inference block:
  1. `/etc/claude-desktop/managed-settings.json` (managed), otherwise
  2. the *applied* local-settings entry under `~/.config/Claude-3p/configLibrary/` - written by the in-app 3P Setup UI and consulted on every launch, even after the managed file is deleted. **This is the sticky part:** a leftover entry like `{"inferenceProvider": "gateway"}` keeps forcing 3P (degraded - `Credentials read failed … baseUrl: Required`, `inference apiHost=http://custom-3p-unused.invalid`) with no `/etc` file present. The `configLibrary/` is always read from the `-3p` dir (per-profile: `Claude-NAME-3p`), regardless of which userData dir ends up active.

  If the chosen config has an inference block, the app boots 3P and relocates userData to `~/.config/Claude-3p/` - *unless* the persisted `"deploymentMode"` key in `~/.config/Claude-3p/claude_desktop_config.json` is `"1p"`, which forces 1P even while a 3P config is still stored. (Exception: a managed config with `authentication.disableClaudeAiSignIn: true` always wins - enterprise-enforced 3P cannot be overridden.) To switch modes:
  - **In the app (this package):** Settings → **Extra** → **Deployment**, the switch at the top. It writes the same `deploymentMode` key, shows which mode the next start will use and why, and offers the restart. See [Route A](#route-a-the-in-app-deployment-panel).
  - **Launcher flags (this package):** `claude-desktop --1p` or `claude-desktop --3p` persist the `deploymentMode` key for you. Persistent until switched back; takes effect on the next full start, so quit any running instance first. The upstream one-shot flag `--boot-1p-once` from the MSIX-era builds was **removed** in the official `.deb` bundle and is no longer read - the persisted key is the only user-side switch left.
  - **Manual equivalent:**
    ```bash
    python3 - <<'PY'
    import json, pathlib
    p = pathlib.Path.home() / ".config/Claude-3p/claude_desktop_config.json"
    d = json.loads(p.read_text()); d["deploymentMode"] = "1p"   # or "3p"
    p.write_text(json.dumps(d, indent=2))
    print("deploymentMode set")
    PY
    ```
  - **Full reset:** to make 1P the default without relying on the override key, stop any config source from selecting 3P. In the Deployment panel, set *Active configuration* to **None** - that clears `appliedId` and keeps every stored configuration on disk, so returning to 3P is one click. The destructive equivalent is `rm -rf ~/.config/Claude-3p/configLibrary` (you will re-enter provider settings in Setup if you return to 3P).

  Plain `claude-desktop` in 1P mode uses `~/.config/Claude/` again. Re-adding `managed-settings.json` (or `--3p`, if a stored provider config exists) switches back to 3P. (`deploymentMode` and the config sources are upstream Anthropic mechanisms; `--1p`/`--3p` are launcher conveniences added by this package.)
- **`global` region requires Vertex's global endpoint to be enabled** for your project - newer projects have this on by default; older ones may need to be enabled in the Cloud Console under Vertex AI Studio settings.

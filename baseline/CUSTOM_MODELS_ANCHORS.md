# Custom models - anchors

`patches/community/add_feature_custom_models.nim` and its two JS halves
(`js/custom_models_main.js` in the app, `js/custom_models_preload.js` inside the Claude Code CLI)
rest on three kinds of assumptions:

- **Build-time anchors** in the local bundle. Each is matched with an exact count; a move fails the
  build. Nothing to re-check by hand.
- **Local shapes the build does not assert.** Grep the new bundle after an upstream bump.
- **Remote and CLI behavior** that no build can see: the claude.ai bootstrap and model-selection APIs,
  and the internals of the Claude Code binary. These break at run time. The log lines at the end say
  which one moved.

**v4.4212.0** (2026-10-30): sub-patch B re-fitted (the method now forwards to a free function, see its row); A, C (both wraps and both asserts) and D still one hit each as the build asserts them; Claude Code CLI unchanged at 2.1.309, so the local shapes below were not re-measured.

Build-time anchors and local shapes re-measured on **v4.29.0** (2026-10-28; python `re.finditer` over the `index.js` + `index.chunk-*` + `index.pre.js` concat, every anchor below 1 hit; sub-patches B, C (both wraps and both asserts) and D one hit each, in `index.chunk-jeAh2Ty2.js` (B, D, the session manager) and `index.chunk-_m5A1BKv.js` (C, the Agent SDK)). v4.29.0 bundles **Claude Code CLI 2.1.309** (the CLI manifest `JSON.parse('{"version":"2.1.309","manifest":{...')`, Agent SDK 0.3.309, one `CLAUDE_AGENT_SDK_VERSION` copy; v3.6556.2 bundled 2.1.308, v3.1623.0 2.1.304, v2.37337.1 2.1.295). Every CLI row below was last verified on an older CLI and **needs a live check against 2.1.309**. The claude.ai rows were observed live on
2026-09-13 by the feature's author; the CLI rows were checked against **CLI 2.1.266** (2026-09-14/15) and
re-read in **CLI 2.1.281** (2026-09-24) and **CLI 2.1.284** (2026-09-29); routing live-checked on **CLI 2.1.295** (2026-10-09).

## Build-time anchors (strict counts, the build fails if one moves)

| Sub-patch | Anchor (exactly one across the staged bundle) | Rewritten to |
|---|---|---|
| B | `buildSessionEnv(...<a>){return <F>((()=>({…})),...<a>)}` -> `async function <F>(<id>,<id>,<n>,…){let <id>=await <h>(<n>.sessionEnv)` - the Code session manager deriving the session env at every spawn. Since v4.4212.0 the method only forwards to a free function, prepending an identity thunk, so the base config is that function's **3rd** parameter; `<F>` is read from the forwarder (exactly one) and the body matched under that name (exactly one; the argument must be that 3rd parameter; trailing parameters may carry a default, `u=!1`). `<h>` is a cross-chunk helper, `t.hd` in v4.4212.0 (`t.Ad` in v4.29.0, `t.Zy` in v3.1623.0, `t.cy` in v2.37337.1), that applies managed network/proxy env. Up to v4.29.0 the body was the method itself: `async buildSessionEnv(e,n,r,i,a,o,s,c,u=!1){let d=await t.Ad(n.sessionEnv)`. v4.4212.0: `buildSessionEnv(...e){return JO((()=>({organizationUuid:this.currentOrgId,accountUuid:this.currentAccountId})),...e)}` + `async function JO(e,n,r,i,a,o,s,c,l,u=!1){let d=await t.hd(r.sessionEnv)` (both in `index.chunk-kLQCxBgD.js`) | the helper's argument becomes `{...r.sessionEnv,...((globalThis.__cdbCustomModels&&…cliEnv(r.sessionEnv))\|\|{})}`, so managed proxy policy still applies on top |
| C | `appendSystemPrompt:this.initConfig?.appendSystemPrompt` and `agents:this.initConfig?.agents` in the Agent SDK's `Query.initialize` | each wrapped, with `this.transport` passed as the 2nd argument |
| C (assert) | `{this.transport=<id>,this.isSingleUserTurn=` - the Query keeps its transport | nothing (precondition) |
| C (assert) | `updateEnv(<id>){this.options.env?Object.assign(this.options.env,` - the transport keeps the spawn env in `options.env` | nothing (precondition) |
| D | `async configureSSHSpawn(<ids>){` - the Code session manager turning a session into an SSH/WSL one | `remoteSpawn(<first param>)` called first |

`rg` recipes: `grep -ao 'buildSessionEnv([^)]*){.\{0,60\}' index*.js` then `grep -ao 'async function <F>(.\{0,80\}' index*.js`, `rg -o 'subtype:"initialize".{0,600}' index*.js`,
`rg -o 'this\.transport=.{0,60}' index*.js`, `rg -o 'updateEnv\(.{0,80}' index*.js`,
`rg -o 'configureSSHSpawn\(.{0,40}' index*.js` (add `-a`/use `grep -a` if the file has NUL bytes).

## Local shapes (not asserted - grep them)

| Assumption | Where | Measured (v4.29.0) | If it moves |
|---|---|---|---|
| B's site is not the base env builder: `getBaseQueryConfig` memoises `_fetchBaseQueryConfig` for 30 s (`BASE_CONFIG_TTL_MS=3e4`) | `getBaseQueryConfig(e){return this.baseConfigMemo.get(…)}` | as quoted - a splice there reached new sessions up to 30 s late | nothing to do while B stays in `buildSessionEnv`; moving it back means calling `invalidateBaseConfigCache()` on every config change |
| B's helper only touches network variables: it fills managed proxy/CA env the session lacks (`F9e`-style "set if absent") and enforces managed `HTTP(S)_PROXY`/`NO_PROXY` settings | `function <cy>(e){return <G>(e,{label:"[CCD] Code session"})}` -> `async function <G>(e,t){let n=new Set,r=<F>(await <pm>(),e,n);return await <W>(r,n,t.label),r}` (v4.29.0, chunk `index.chunk-Sq9qOqtc.js`: export `Ad` -> `doa(e){return Wra(e,{label:"[CCD] Code session"})}` -> `Wra`, fill-if-absent `Xdt`, managed keys `Hra=new Set(["HTTPS_PROXY","HTTP_PROXY","NO_PROXY"])`; v3.1623.0: `Zy` -> `l5r` -> `W6r`, `Qit`, `H6r`) | as quoted - none of `cliEnv()`'s keys (`BUN_OPTIONS`, `CDB_CUSTOM_MODELS_*`, `CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`) is touched | if the helper starts filtering or rewriting other keys, our additions could be dropped: move the splice after the call (`{...await <h>(…),...cliEnv(…)}`) |
| The SDK copies the session env into the transport options | `…,at=le?{...le}:{...process.env};at.CLAUDE_CODE_ENTRYPOINT\|\|="sdk-ts"` before `new <Transport>({…env:at,…})` | as quoted (v4.29.0: `at=ue?{...ue}:{...process.env};at.CLAUDE_CODE_ENTRYPOINT||="sdk-ts"`, one SDK copy) | `sessionRouted()` sees no marker: sub-agent types and the announce line silently stop (routing is unaffected) |
| The SSH/WSL remote spawner forwards only `CLAUDE_*`, `ANTHROPIC_*`, `DISABLE_*`, `ENABLE_TOOL_SEARCH` and host-authored keys | `function <id>(e){return e.startsWith("CLAUDE_")\|\|e.startsWith("ANTHROPIC_")\|\|e.startsWith("DISABLE_")\|\|e==="ENABLE_TOOL_SEARCH"…}` used by the remote env filter | as quoted (v4.29.0: `Hna(e)` in `index.chunk-Sq9qOqtc.js`): `CDB_*` (the keys) and `BUN_OPTIONS` never reach a remote host; `CLAUDE_CODE_SUBAGENT_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` would, which is why `remoteSpawn()` takes them back | if the filter widens, `remoteSpawn()` still strips everything `cliEnv()` added - nothing to do |
| In subscription mode the app's model validator accepts any id (the blocklist of non-Anthropic names runs in 3P mode only) | the app-side validator behind `setAvailableCodeModels` | author, 2026-09-13 | a session refuses to start on a custom id |

## claude.ai (remote)

| Assumption | Used for | Observed | If it moves |
|---|---|---|---|
| The page fetches `/edge-api/bootstrap/<org>/app_start` (or the `/api/` spelling) and builds the Code picker from `model_selector_config` | `PATTERNS`, `enrichBootstrap()` | surfaces `ccd` (the menu) and `code` (effort options, available ids, persisted state); entry `{id, name, short_name, section, capabilities, thinking:{type:"effort"\|"effort_and_mode", effort_options, mode_options?}, quick_select?}`; labels localised server-side | no `bootstrap enriched` line after a Code-tab reload with the switch on; `CDB_CUSTOM_MODELS_DEBUG=1` logs every `page GET /…` path and the surfaces of each bootstrap |
| The page persists the pick with `PATCH /api/organizations/<org>/model_selector_state/<surface>`, refused with 400 for an id claude.ai does not know | `selectionOutcome()` answers it locally and remembers the pick in `custom-models/selection.json` | answer shape `{id, model, thinking, thinking_by_model:[{id, thinking}]}` | the picker forgets a custom model when the session ends; the log shows no `selection: … kept locally` line |

## Claude Code CLI (not in this bundle)

| Assumption | Used for | Checked (CLI 2.1.266 unless noted; all need a live check against 2.1.309) | If it moves |
|---|---|---|---|
| The compiled Bun binary honours `BUN_OPTIONS=--preload=<file>` and is named `claude` | loading the preload at all | yes | `logs/custom-models.log` gets no `active:` line when a session opens; routing never happens |
| Messages requests go through `globalThis.fetch(string\|URL, {body: string})`, or (2.1.284+, standalone build) through the `fetch` of a `Bun.FetchSession` the CLI creates with `new Bun.FetchSession(opts)`: `var ir=globalThis.fetch` is captured at start and `(r&&n===ir?r:n)(e,s)` picks the session while `globalThis.fetch` is still that value - our hook, captured after the preload ran. A gzip body (`compress:"gzip"`) is still a string | `route()` via `hook()` on both | 2.1.284: live run, CLI + preload + a local fake provider | no `->` line in `logs/custom-models.log` while the session answers "There's an issue with the selected model" (Anthropic's 404 for our id); with `CDB_CUSTOM_MODELS_DEBUG=1`, no `passthrough` line either when the CLI found a new path |
| `/model` and `set_model` accept `^claude-\S+$`; a `[1m]` suffix means a 1M window | the `claude-<id>` aliases, the `context` modes | yes | the picker's choice is refused by the CLI; auto-compaction at 200k for a 1M model |
| Session turns carry `thinking: {type: "enabled", budget_tokens}` (or `"adaptive"`); light work (WebFetch synthesis, the classifier) carries none | `sanitize()` forwards thinking as asked | yes | thinking lost on turns, or forced on cheap calls |
| A model switch is checked with one Messages request of `max_tokens: 1` (`querySource: "model_validation"`), and the switch is cancelled when it fails | `sanitize()` sends `max_tokens` as at least 16 (`MIN_MAX_TOKENS`) | 2.1.295 (`n$({model:r,max_tokens:1,maxRetries:0,querySource:"model_validation",…})`), live switch to OpenRouter's `meta/muse-spark-1.3-contributor` on 2026-10-11 | "Couldn't switch to … HTTP 400" naming `max_output_tokens`, with a `<- … HTTP 400` line in `logs/custom-models.log` for a `stream=false messages=1 tools=0` request |
| Server-side threads ("tether", GrowthBook `tengu_curious_tower`): a request may carry `thread: {type: "create"\|"continue", previous_message_id}` and, on a continue, only the messages after the anchor; a 400 with `error.details.error_code: "thread_unsupported_request"` makes the CLI resend the turn whole and keep that model stateless for the session | the preload refuses every routed request that carries `thread` with that code | 2.1.281 (`fne()`: `YAt(e)==="thread_unsupported_request"` → `unsupported_request` → `[tether] … resending this turn stateless`) | a custom model answers from a truncated conversation; `logs/custom-models.log` shows no `thread request … refused` line while the session loses context |
| The web-search sub-request is one request with exactly one `web_search_*` tool, on the small/fast model or on the session's model (GrowthBook `tengu_plum_vx3`) | `webSearch` routing (resolved before the requested model), the no-tool refusal | 2.1.281: `x("tengu_plum_vx3",!1)?Gy():p.mainLoopModel()` | web searches go to Anthropic's default again |
| `CLAUDE_CODE_SUBAGENT_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` are read verbatim, with no validation | the two app-wide slots | yes | sub-agents / WebFetch on the CLI's defaults |
| `initialize.agents` definitions take any `--model`-valid id; the Agent tool's own `model` is an enum of tiers | sub-agent types, the announce line's wording | yes | `Agent(subagent_type: <type>)` fails to launch |
| Anthropic refuses a `diagnostics.previous_message_id` it did not mint (not `msg_…`) | `foreignPreviousId()` sends null | yes | the first Anthropic turn after a custom-model turn fails with a 400 naming `previous_message_id` |
| A system text block starting `x-anthropic-billing-header:` carries ` cc_entrypoint=<CLAUDE_CODE_ENTRYPOINT>;`; on an API key the API answers `claude-desktop` with a 400 "credit balance too low" | `nativeBody()` rewrites the entrypoint to `cli`, what the CLI sends when it runs interactively on an API key, on the Anthropic API preset | 2.1.293 (`Kso()`), live API on 2026-10-08 | every `(native)` request in `logs/custom-models.log` gets that 400 although the key has credit |

A local check of the CLI half, without the app: run `claude -p hi --model claude-<id>` with
`BUN_OPTIONS=--preload=<userData>/custom-models/preload.js`, `CDB_CUSTOM_MODELS_ROUTES=<userData>/custom-models/routes.json`,
`CDB_CUSTOM_MODELS_LOG=/tmp/cm.log` and `CDB_CUSTOM_MODELS_DEBUG=1`, then read `/tmp/cm.log`.

## Log lines → what moved

In `logs/claude-patches.log` (`[custom-models] …`) unless noted:

| Line | Meaning |
|---|---|
| `debugger attach failed` / `Fetch.enable failed` | the CDP route to the bootstrap is closed (Electron or Chromium change) |
| `bootstrap: not JSON (…) - passing the response through` | the bootstrap is no longer JSON the module can read |
| `bootstrap: <error> - passing the response through` | a CDP command on the paused response failed (`Fetch.getResponseBody` / `Fetch.fulfillRequest`) |
| no `bootstrap enriched: …` after a reload, switch on | the endpoint or the `model_selector_config` shape moved - see the claude.ai table |
| `the SDK query's transport has no options.env - upstream moved it` | the C preconditions hold in the bundle but not at run time; re-audit sub-patch C |
| `remote session: custom models left out …` | expected on every SSH/WSL session start (sub-patch D) |
| `logs/custom-models.log`: no `active:` line for a new session | the preload did not load - `BUN_OPTIONS` or the binary name |
| `logs/custom-models.log`: `refused: … is no longer configured` | expected: a session asked for a model that was removed or switched off |
| `logs/custom-models.log`: `thread request (…) … refused, the CLI resends it whole` | expected, once per model per session where the account has threads on |
| `logs/custom-models.log`: `refused: … redirected to …` | a provider redirected off its host; the key was not sent there |
| `logs/custom-models.log`: `<- … usage: input=… cache_read=0 …` on every turn of a session | the prompt cache never hits: something early in the request changes between turns (tools, system prompt, effort) - diff two consecutive requests |

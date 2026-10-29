;/*__CDB_GB_OVERRIDES__*/(function () {
  "use strict";
  if (typeof process === "undefined" || !process.versions || !process.versions.electron) return;

  var lastRaw = null;
  var lastParsed = null;
  var announced = "";

  // Last feature map the store setter handed us (pre-override) and the map we
  // handed back (post-override). Read through globalThis.__cdbGbFlags by the
  // Extra settings page so its switches can show what the app actually sees.
  var lastServer = null;
  var lastEffective = null;
  var catalogCache = null;

  function diag(msg) {
    try { (globalThis.__cdbDiag || console.log)(msg); } catch (e) {}
  }

  // Both filenames are honored and merged (.jsonc wins per key) so existing
  // plain-JSON configs (themes) keep working; the commented template lives in
  // .jsonc where editors expect comments.
  // __cdbCfgMigrate (installed by the custom-themes patch, the earliest config
  // consumer) copies legacy claude-desktop-bin.{json,jsonc} to the
  // claude-desktop-extra names once; calling it here too covers the case where
  // flags load before any theme read ever happens.
  function configPaths() {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var path = require("path");
    var ud = require("electron").app.getPath("userData");
    return {
      json: path.join(ud, "claude-desktop-extra.json"),
      jsonc: path.join(ud, "claude-desktop-extra.jsonc")
    };
  }

  // JSONC: strip // and /* */ comments outside of strings so the shipped
  // template can list flags commented out and users just uncomment them.
  //
  // Trailing commas are dropped too, and that is load-bearing rather than
  // cosmetic: the template tells the user to uncomment ONE line, and every line
  // ends with a comma, so the result would otherwise be {"123": true,} - invalid
  // JSON, and the whole config would be silently ignored.
  function stripJsonComments(s) {
    var out = "";
    var inStr = false;
    var i = 0;
    while (i < s.length) {
      var c = s[i];
      if (inStr) {
        out += c;
        if (c === "\\" && i + 1 < s.length) { out += s[i + 1]; i++; }
        else if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
      if (c === "/" && s[i + 1] === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; continue; }
      if (c === ",") {
        // Look past whitespace and comments for a closing brace/bracket.
        var j = i + 1;
        while (j < s.length) {
          if (s[j] === " " || s[j] === "\t" || s[j] === "\r" || s[j] === "\n") { j++; continue; }
          if (s[j] === "/" && s[j + 1] === "/") { while (j < s.length && s[j] !== "\n") j++; continue; }
          if (s[j] === "/" && s[j + 1] === "*") { j += 2; while (j < s.length && !(s[j] === "*" && s[j + 1] === "/")) j++; j += 2; continue; }
          break;
        }
        if (s[j] === "}" || s[j] === "]") { i++; continue; }
      }
      out += c;
      i++;
    }
    return out;
  }

  var TEMPLATE = [
    "// claude-desktop-extra - local configuration (custom themes + feature-flag overrides)",
    "//",
    "// This .jsonc file is merged over claude-desktop-extra.json in the same directory",
    "// (per key; .jsonc wins) - an existing .json config keeps working unchanged.",
    "// Comments (// and /* */) are allowed in both files.",
    "//",
    "// activeTheme: pick a theme. The 7 built-ins are mario, sweet, nord,",
    "// catppuccin-mocha, catppuccin-macchiato, catppuccin-frappe, catppuccin-latte;",
    "// you can also name one of the 84 bundled community palette slugs (see",
    "// themes/PALETTES.md), or author your own (see themes/README.md in the repo).",
    "// Hand edits need an app restart; Ctrl+Shift+T and Settings -> Extra -> Themes",
    "// apply immediately.",
    "//",
    "// growthbookOverrides (advanced, unsupported territory):",
    "// The Extra > Features panel in the app's Settings dialog edits the same",
    "// flags with a switch per flag. It writes claude-desktop-extra.json; entries you",
    "// put here win per flag id, and that panel shows those as locked.",
    "// Every GrowthBook flag observed being read from the feature store in Claude",
    "// Desktop v4.29.0 is listed below, commented out. Uncomment a line to force",
    "// it; separate multiple active entries with commas (a trailing comma after the",
    "// last one is fine). true/false for switches; flags marked (value flag)",
    "// carry numbers/strings/objects - a bare true may be meaningless for those.",
    "// This file is re-read on every flag load: startup, the periodic refresh (~1h)",
    "// and account changes. That does NOT make a change take effect on its own -",
    "// most gated features are wired up while the app starts, so restart after",
    "// changing a flag. Overrides win over Anthropic's server rollout.",
    "// Flags force-enabled by claude-desktop-extra's binary patches",
    "// (Code / Cowork / Computer Use enablement) are NOT listed - they bypass this",
    "// file entirely. Active overrides are logged to logs/claude-patches.log.",
    "// Flag IDs are Anthropic-internal and can vanish or change meaning in any",
    "// release (this list reflects v4.29.0). If the app misbehaves, empty this",
    "// file first.",
    "{",
    "  // \"activeTheme\": \"mario\",",
    "",
    "  // transcriptLimits: for long Code sessions, especially ones with many browser",
    "  // screenshots. The app only loads the last 50 MiB of a session's transcript, plus",
    "  // one shared 32 MiB for all of its subagents' transcripts, and hides the rest behind",
    "  // \"This session is too large to load in full\" (the start of the conversation, or",
    "  // some subagent activity). A screenshot returned inline is ~0.4 MB of base64 (stored",
    "  // twice in the main transcript), so 60-80 of them reach a limit. true loads",
    "  // up to 256 MiB of the conversation and 192 MiB of subagent activity instead, at the",
    "  // cost of memory and time when you open a huge session; omit it for Anthropic's own",
    "  // limits. Needs a restart. Settings -> Extra -> Community Features has a switch for",
    "  // this; a value set HERE wins the merge, so that switch shows itself as locked",
    "  // while this line is active.",
    "  // \"transcriptLimits\": true,",
    "",
    "  // transcriptLimitsMainMiB / transcriptLimitsSubagentMiB: what \"true\" allows, in",
    "  // MiB, clamped to 8..1024 (defaults 256 and 192). Large values cost memory and",
    "  // can crash the app on a machine with little RAM, so lower them there. The parse",
    "  // cache is sized from these automatically. Only used while transcriptLimits is",
    "  // true. Hand edits need a restart.",
    "  // \"transcriptLimitsMainMiB\": 512,",
    "  // \"transcriptLimitsSubagentMiB\": 384,",
    "",
    "  // allowNonAnthropicModels: keep a 3P gateway's non-Anthropic models (DeepSeek, Qwen,",
    "  // GLM, ...) in the model list instead of dropping them. Per mode - set it in the",
    "  // 3P config dir (~/.config/Claude-3p). Needs a restart.",
    "  // \"allowNonAnthropicModels\": false,",
    "",
    "  // customModels: models from Anthropic-compatible endpoints (DeepSeek, OpenRouter,",
    "  // a gateway) in the Code tab's model picker, next to Anthropic's. Sessions on",
    "  // them use your key; everything else stays on the subscription. Off by default:",
    "  // \"enabled\": true here turns it on and locks the Settings switch. Providers can",
    "  // also be added in Settings -> Extra -> Models. See docs/custom-models.md.",
    "  // \"customModels\": {",
    "  //   \"enabled\": true,",
    "  //   \"providers\": [{",
    "  //     \"id\": \"deepseek\",",
    "  //     \"baseUrl\": \"https://api.deepseek.com/anthropic\",",
    "  //     \"apiKeyFile\": \"~/.config/deepseek.key\",",
    "  //     \"models\": [{ \"id\": \"deepseek-flash\", \"name\": \"DeepSeek Flash\", \"context\": \"1m\" }]",
    "  //   }]",
    "  // },",
    "",
    "  \"growthbookOverrides\": {",
    "    // \"17519066\": true, // external-browser URL block",
    "    // \"21606909\": true, // app-menu Alt+letter mnemonics - hidden Alt+<initial> accelerators open the matching top-level menu (default ON) (new in v2.2553.0)",
    "    // \"28927217\": true, // launch preview last-frame cache - persists preview JPEG frames under userData (default ON) (new in v1.46388.2)",
    "    // \"30891128\": true, // rc-serve tool-hosts offered gate (toolHostsOffered / wantsGitEntry in the remote-control serve device; quartet with 1183214304/3764441751/1410651677) (new in v1.49585.0)",
    "    // \"36693946\": true, // Computer Use gate-reconcile listener - a flip re-announces the CU bridge alongside 1291166712/2486083521/40173473 (new in v1.34493.1)",
    "    // \"38349251\": true, // Code-session org-scoped credential helper (not with a local credential helper) (new in v2.19675.1)",
    "    // \"40173473\": true, // Computer Use win32 sub-gate - the chicago settings/stub path additionally requires this flag on Windows (new in v1.34493.1)",
    "    // \"49458538\": true, // folder-access request UI mode - card tier (733405693 adds classifier; dialog when off); observed for the folder_access_announce reconcile. Replaces 1421481645 (new in v1.40609.0)",
    "    // \"61799151\": true, // Cowork host-home path mapping - ON matches only a single /sessions/<id>/mnt/.host-home prefix (new in v2.37337.1)",
    "    // \"66187241\": true, // CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES for local-agent sessions",
    "    // \"86137329\": true, // SSH session visibility rule (applies once features are loaded and the flag is OFF); also a 3p remote key (new in v3.1623.0)",
    "    // \"95201993\": true, // Cowork bypass-permissions check: ON (or 3p) skips the managed device setting / org flag read and uses the local setting path (RDa) (new in v4.29.0)",
    "    // \"95495057\": true, // browser-extension bridge account mismatch enforcement (isAccountMismatchEnforced); only an Anthropic server ON rule applies, an override cannot (new in v4.29.0)",
    "    // \"96101707\": true, // multiAccount feature gate - static registry entry, also honours the disableMultiAccount managed key (new in v1.46388.2)",
    "    // \"96832454\": true, // CLI version-floor gate (default ON) - sibling of 2153038254 (new in v1.46388.2)",
    "    // \"98041341\": true, // SSH module gate - sibling of the 816856638/291584251/3946462706 transport family (new in v1.37937.0)",
    "    // \"108465228\": true, // folder-grant post-grant index/upload path - sibling gate of 144158705 (new in v1.37937.0)",
    "    // \"113905462\": true, // Browser pane capture sequencing kill-switch - ON skips waiting for running screenshot captures (afterRunningCaptures) and returns every capture (new in v4.29.0)",
    "    // \"114137935\": true, // iOS/Android simulator device claim - tool notes steer a session away from a booted device another Code session is using (new in v2.26454.0)",
    "    // \"121243793\": true, // OAuth: ON raises the stale-relogin sign-in banner (markDesktopStaleRelogin) when a matching auth error is seen (new in v3.1623.0)",
    "    // \"123886377\": true, // Hardware Buddy session feed - ON keeps the raw message instead of the compacted one (kill-switch) (new in v2.37337.1)",
    "    // \"123929380\": true, // coworkKappa - Cowork shared account-memory dir + consolidate-memory skill availability",
    "    // \"124685897\": true, // prompt template substitution",
    "    // \"126748301\": true, // built-in CLI tool-name list gate, read next to the PreToolUse hook check (default ON) (new in v2.2553.0)",
    "    // \"133902057\": true, // CCD sessions API v2 - routes /v1/code/sessions and the v2 transcript-summary payload (new in v1.37937.0)",
    "    // \"134538538\": true, // side sessions default when the saved preference is unset - also needs epitaxyPrefs.sessionHelpers !== false (default ON); also a 3p remote key (new since v2.37337.1)",
    "    // \"135563052\": true, // Cowork: an internal server's tools are built with saveToDisk (new since v2.37337.1)",
    "    // \"136539590\": true, // session git-root grouping - observed live, re-emits session updates on change (new in v2.19675.1)",
    "    // \"144153584\": true, // browser data import gate - when ON, import waits for the browser_data_import / cowork_browser_pane capability (new in v2.37337.1)",
    "    // \"144158705\": true, // LAM remote folder-access consent network call",
    "    // \"144321860\": true, // local-session file-creation kill-switch (createFileDisabled) - ON refuses creating files in a session; also a 3p remote key (new in v2.31226.0)",
    "    // \"160242894\": true, // SSH connect fast-path gate (CLAUDE_DESKTOP_SSH_CONNECT_FASTPATH module) (new in v1.46388.2)",
    "    // \"162211072\": true, // Prompt suggestions enable",
    "    // \"163170856\": true, // git self-check memo kill-switch - ON re-runs the dubious-ownership / not-a-repository self-check instead of reusing a recent result (new in v2.31226.0)",
    "    // \"177523112\": true, // unresolved-folder kill-switch (isUnresolvedFolderKillswitchOn module); also a 3p remote key (new in v3.1623.0)",
    "    // \"180602792\": true, // midnightOwl (macOS) - live listener",
    "    // \"181357194\": true, // held-send queue: ON skips restoring sends held after an error and the unclosed-read restore (new in v3.1623.0)",
    "    // \"206750215\": true, // connected-folder containment error detail suppressor - ON drops the path hints from the \"not inside a folder connected to Cowork\" refusals (new in v1.40609.0)",
    "    // \"216703866\": true, // Bash/PowerShell stored-approval check: ON drops stored approvals that do not belong to the request's rule (no rule of that tool, or 5+ rules); only an Anthropic server ON rule applies, an override cannot (new in v4.29.0)",
    "    // \"227459766\": true, // documents list config (value flag)",
    "    // \"234780002\": true, // Excel/Office handoff device signing (officeHandoffDeviceSigning, default ON): handoff requests carry a device proof checked against the stamped secret; the async merger exposes it as a feature, static registry unavailable (new in v4.29.0)",
    "    // \"245679952\": true, // suggestSkillsEnabled - model may proactively suggest relevant skills in sessions",
    "    // \"254738541\": true, // proactive dispatch-orchestrator prompt (value flag)",
    "    // \"259215703\": true, // Computer Use denied-apps list, merged into the user's chicagoUserDeniedBundleIds (value flag) (new in v3.1623.0)",
    "    // \"262787483\": true, // OTLP content-capture merge input (3p; value flag) (new in v1.26832.0)",
    "    // \"270847253\": true, // Code-tab session-management MCP tool group - OFF marks that group unavailable (default ON) (new in v2.2553.0)",
    "    // \"275501886\": true, // sentry DWOC drop kill-switch - latched into the sentryDwocDropDisabledLatched preference and observed live (also a 3p defaults-map key) (new in v2.2553.0)",
    "    // \"278625510\": true, // MCP-UI capability advertisement + skill sources from connected MCP servers",
    "    // \"282912933\": true, // git maintenance adds --task=incremental-repack to the loose-objects run (new in v3.1623.0)",
    "    // \"283281522\": true, // browser-pane sibling gate (default ON) next to the 2464731750 request_access tool (new in v1.46388.2)",
    "    // \"285176328\": true, // Desktop extension user settings: saving the userConfig of an extension is blocked while the flag is OFF (Extension settings not saved); only an Anthropic server OFF rule applies, an override cannot (new in v4.29.0)",
    "    // \"286376943\": true, // Plugin skills for system prompt - gates getPluginSkillsForSystemPrompt (new in v1.2278.0)",
    "    // \"292113176\": true, // PR status poll cadence in seconds (default 30), observed live (value flag) (new in v2.26454.0)",
    "    // \"299664339\": true, // conversation asides - passes the inline asides plugin options to sessions (default ON) (new in v2.7032.0)",
    "    // \"305263438\": true, // Browser tools: handoff:true on tabs_select brings this chat's Browser pane to the front for the user; a flip reloads the remote tools device (new in v3.6556.2)",
    "    // \"323247490\": true, // [git] core.hooksPath discovery via git config --list --name-only (default ON) (new in v2.2553.0)",
    "    // \"325676259\": true, // device registry: signed session file copy (uploads folder) kill-switch - ON refuses with proofs_switched_off (new in v2.26454.0)",
    "    // \"341781248\": true, // side-sessions event injection sibling gate, with 3025587613 / 3531612483 (default ON) (new in v2.2553.0)",
    "    // \"346871663\": true, // task file write - ON refuses to write a task file that is hard-linked to another file (new in v2.37337.1)",
    "    // \"348738776\": true, // Claude in Chrome - ON lifts the org latched-off block (admin_off) for 1p accounts; observed live (new in v2.37337.1)",
    "    // \"356538592\": true, // daemon dial check kill-switch (isDaemonDialCheckKillswitchOn module) (new in v2.37337.1)",
    "    // \"371539023\": true, // session transport attestation gate (verification-state routing)",
    "    // \"396417011\": true, // carried routine mode kill-switch - ON (or flags not loaded) stops a routine created from a session inheriting its permission mode; also a 3p remote key (new in v2.31226.0)",
    "    // \"397125142\": true, // Terminal server - gated: sessionType==='ccd'&&!isSSH AND this flag. CCD only, NOT cowork. ",
    "    // \"402890909\": true, // worktree pool spares, together with 1061122496 (new in v3.1623.0)",
    "    // \"416245092\": true, // GPU crash-streak marker file (default ON)",
    "    // \"418268624\": true, // Sentry hold kill-switch - latched into the sentryHoldDisabledLatched preference (new since v2.7032.0)",
    "    // \"434204418\": true, // MCP non-blocking connection",
    "    // \"443705147\": true, // dispatch for enterprise orgs - value object with allowEnterprise (value flag) (new in v2.19675.1)",
    "    // \"451382573\": true, // DISABLE_BRIEF_MODE_STOP_HOOK env var for cowork/LAM sessions",
    "    // \"451826559\": true, // connector file-reference fill kill switch (Drive host fill for remote MCP calls); also treated as on while flags are older than 3h (new in v3.6556.2)",
    "    // \"458990115\": true, // folder-access routine-scoped standing - ON drops the routine grant anchor (session standing only) (new in v1.46388.2)",
    "    // \"469868978\": true, // message buffer trim kill-switch - ON keeps the whole buffer (new since v2.37337.1)",
    "    // \"476513332\": true, // check_interval_ticks config (value flag)",
    "    // \"478602036\": true, // unattended built-in tool trim - part of the fork-session flag snapshot (unattendedBuiltinToolTrim) (new in v2.7032.0)",
    "    // \"480673358\": true, // host worktree write guard (CLAUDE_CODE_HOST_WORKTREE fence) kill-switch - ON disables the guard (new in v2.26454.0)",
    "    // \"500434831\": true, // worktree pool fast-acquire kill-switch - ON disables fast acquisition (new in v2.2553.0)",
    "    // \"513873720\": true, // epitaxyMcpAppPane gate (MCP app pane, async merger; env CLAUDE_E2E_COPPER_HARBOR); 2684344147 adds SSH-host MCP apps on top (new in v2.19675.1)",
    "    // \"517536662\": true, // new-worktree checkout size count kill-switch (free-space check asks for its floor only) (new in v3.1623.0)",
    "    // \"537165055\": true, // readFileContents kill switch - on resolves a file's folder as its parent directory instead of the nearest allowed folder (new in v3.6556.2)",
    "    // \"539375764\": true, // PR author-association module gate, with 846970509 / 599480072 (default ON) (new in v2.2553.0)",
    "    // \"541746109\": true, // [my-access] fetch-failure fallback kill-switch - ON stops serving the degraded access answer after repeated fetch failures (new in v1.40609.0)",
    "    // \"543332958\": true, // offline game on the main window's offline page - observed live (new in v2.19675.1)",
    "    // \"546885144\": true, // app-menu entry, observed for menu rebuild (default ON) (new since v2.37337.1)",
    "    // \"549725139\": true, // user-settings read host gate, pair of 3782147869 (ON restores the host gate) (new in v4.29.0)",
    "    // \"552157343\": true, // plugin add gating (default ON)",
    "    // \"554317356\": true, // timeout ms (value flag)",
    "    // \"562073731\": true, // 'New Session in New Window' menu entry for the Code surface (default ON); observed live for the app menu (new since v2.7032.0)",
    "    // \"568988794\": true, // local-session turn delegation (turnIsDelegated, default ON) (new in v2.7032.0)",
    "    // \"570403704\": true, // device attestation v2 - anthropic-beta header path gate (try/catch read; also on the 3p remote-allowed list) (new in v1.46388.2)",
    "    // \"575160718\": true, // installed-plugins watcher semantic-digest reload kill switch - ON reloads on every registry change (new in v2.7032.0)",
    "    // \"580613960\": true, // Cowork EDR integration kill-switch (absent / on / off, read through readBooleanFeature) (new in v2.19675.1)",
    "    // \"583643792\": true, // host git confined-install kill-switch (hostGitConfinedInstall) (new since v2.37337.1)",
    "    // \"583857784\": true, // transport bridge: route session through the SDK adapter when ON",
    "    // \"592261068\": true, // Code settings: folder picker on the session card (cardFolderPickerOn) (new in v3.6556.2)",
    "    // \"596004596\": true, // simulatorScreenshotEditor feature gate (async merger override); needs the Android emulator gate 1118714395 (iOS variant hardcoded off) (new in v2.37337.1)",
    "    // \"599480072\": true, // PR/CI module sibling gate of 539375764 (default ON) (new in v2.2553.0)",
    "    // \"600735300\": true, // connector (remote MCP) OAuth sign-in finished in the app via claude:// (mcpFinishInApp; off with the disableConnectorSignInInApp managed key or in 3p) (new in v2.26454.0)",
    "    // \"607406988\": true, // isBoundedConnectBudgetKillswitchOn - SSH bounded connect-budget kill-switch (new in v1.40609.0)",
    "    // \"613003975\": true, // transcript reads in a worker thread (new in v1.46388.2)",
    "    // \"624882822\": true, // app-menu: shows Help > View Changelog (default ON); also an app-menu rebuild observer (new in v4.29.0)",
    "    // \"630659907\": true, // worktree overlay-gate kill-switch - ON stops waiting for the overlay before checkout (new in v2.2553.0)",
    "    // \"632367876\": true, // transcript report reads on the session host (off returns Disabled) (new in v3.6556.2)",
    "    // \"642265585\": true, // replyRedeliveryDisabled - held-reply redelivery kill-switch in the remote-tools request path (new in v1.40609.0)",
    "    // \"657187776\": true, // transcript-lease disable - turns off the CCD disk-transcript lease/claim loop (new in v1.34493.1)",
    "    // \"659073223\": true, // previous-profile auto-import (copying earlier sessions) remote switch-off - ON skips the import; also a 3p remote key (new in v2.31226.0)",
    "    // \"700252341\": true, // ccd_turn wrap-up result carries _meta['claude/endTurn'] (default ON) (new in v3.1623.0)",
    "    // \"701229895\": true, // GitHub PR digest of github.com rows (default ON) (new in v3.1623.0)",
    "    // \"706068684\": true, // Code turn-complete notification summary body (default ON) (new in v1.46388.2)",
    "    // \"708237507\": true, // proxied remote MCP tool calls carry tool_use_id (new since v2.37337.1)",
    "    // \"714014285\": true, // CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
    "    // \"714716271\": true, // SSH connections save guard kill-switch - ON allows a save that would drop stored connections; also a 3p remote key (new in v3.1623.0)",
    "    // \"717163759\": true, // isKeepLiveRemoteKillswitchOn - keep-live remote kill-switch (new in v1.37937.0)",
    "    // \"720735283\": true, // Marketplace migration",
    "    // \"721728391\": true, // inference routing via org policy backend (new in v1.28929.0)",
    "    // \"725990316\": true, // credential plugins-scope - adds pluginsScope to the minted token (default ON). Replaces 1689023552 (new in v2.7032.0)",
    "    // \"732695530\": true, // remote-tools-device gate (new in v1.32352.1)",
    "    // \"733405693\": true, // folder-access request UI mode - classifier tier on top of the 49458538 card (new in v1.40609.0)",
    "    // \"743194442\": true, // Google auth deep-link - ON keeps ASWebAuth instead of the /login/app-google-auth handler (new in v1.37937.0)",
    "    // \"762798616\": true, // CCD auto-update nudge + check_interval_ticks config (value flag)",
    "    // \"763725229\": true, // Developer menu label/visibility",
    "    // \"769234850\": true, // transcript append-via-shell kill-switch - ON forces the buffered-cut path for SSH (new in v1.37937.0)",
    "    // \"769947364\": true, // trustedFolderSettingsConsent merger key kill-switch (ON hides remembering a trusted remote folder from Settings) (new since v2.37337.1)",
    "    // \"770138930\": true, // SSH CLI-too-old frame handling kill-switch (new in v2.19675.1)",
    "    // \"770567414\": true, // VM service routing (direct vs persistent pipe)",
    "    // \"776434665\": true, // skills and plugins notice: shows the Desktop skills and plugins are off because settings have not loaded text (together with a signed-in 1p check) (new in v4.29.0)",
    "    // \"790863764\": true, // device_bash - combined gate with yukonSilver VM support",
    "    // \"816856638\": true, // SSH daemon upgrade-deferral disable (isDaemonUpgradeDeferralDisabled) (new in v1.34493.1)",
    "    // \"822840158\": true, // inline Claude-in-Chrome settings write at Code-session launch (default ON) (new since v2.7032.0)",
    "    // \"822923030\": true, // SSH reattach-rounds ledger kill-switch (inverted read next to the 3093186863 reattach kill-switch) (new in v1.40609.0)",
    "    // \"842344209\": true, // message stream coalescing at 250 ms while the session is off screen (default ON) (new in v3.1623.0)",
    "    // \"846970509\": true, // PR/CI module boolean sibling of 539375764 / 599480072 (new in v2.2553.0)",
    "    // \"848696239\": true, // remote outputs sync dry-run - pairs with 2906979861 (new in v1.46388.2)",
    "    // \"850702611\": true, // turn restage-vs-discard on interrupt (ON = restage) (new in v1.26832.0)",
    "    // \"851176674\": true, // simulator deny rule for SSH control roots (denySshControlRoots) (default ON) (new in v3.1623.0)",
    "    // \"857846362\": true, // side-sessions sub-gate, only consulted when side sessions (2371478310) are on (new since v2.7032.0)",
    "    // \"873030668\": true, // sorted-list source config (value flag)",
    "    // \"875864311\": true, // Code session cycle health: record lastTurnCutShort (default ON) (new in v2.37337.1)",
    "    // \"879583975\": true, // notification style gate: banner/badge/off map",
    "    // \"884132720\": true, // OAuth scope passthrough - forwards the OAuth token scope into the CLI session env build: o",
    "    // \"885442848\": true, // hosted Chrome bridge first_party mode - picks the 1p bridge when hybrid detection is off; also a live listener (new in v1.34493.1)",
    "    // \"912981541\": true, // request_cowork_directory card skip kill-switch - ON stops auto-approving a folder that is already attached to the session (new in v2.31226.0)",
    "    // \"919579692\": true, // PreviewOriginPolicy disable - ON skips the credentialed-nav origin-policy check for launch preview (new in v1.32352.1)",
    "    // \"922243720\": true, // read-only tool cwd verification - realpath check of the verified cwd for AWF read-only tools (default ON) (new in v2.7032.0)",
    "    // \"922442190\": true, // session transport attestation gate (paired with 371539023/2023768496)",
    "    // \"933167008\": true, // lazy session worktree tree in the workspace-trust check (default ON) (new in v3.1623.0)",
    "    // \"939257113\": true, // Dispatch child session detection - isRemoteDispatchChild qualifier",
    "    // \"946844604\": true, // Cowork memory remote sync v2 gate - with canSyncCoworkMemoryRemotely() and not HIPAA-restricted; OFF answers refusal flag_off (new in v1.49585.0)",
    "    // \"958249077\": true, // project-scoped browser tab-group reuse kill-switch - ON refuses the tab-group handoff (new since v2.7032.0)",
    "    // \"959099749\": true, // ccdGitEngine - CCD git engine feature (async merger override since v1.28929.0) (new in v1.26832.0)",
    "    // \"975112542\": true, // Cowork memory remote sync - canSyncCoworkMemoryRemotely()",
    "    // \"975160870\": true, // confined host-git install fleet override (hostGitConfinedInstall) - ON forces the confined state (new in v2.26454.0)",
    "    // \"975773474\": true, // usage probe recommendations (default OFF) (new in v3.1623.0)",
    "    // \"976614668\": true, // remote-control-at-startup feature gate - pairs with 2229805612 (new in v1.37937.0)",
    "    // \"982691970\": true, // Cowork plugin host ops gate (dynamic import)",
    "    // \"982984741\": true, // model/max-tokens override object (enabled, model, maxTokens 256..4096) for a helper LLM call (value flag) (new in v2.19675.1)",
    "    // \"994878011\": true, // isSleepRedialKillswitchOn - SSH sleep-redial kill-switch (new in v1.46388.2)",
    "    // \"1004628546\": true, // consolidate-memory skill description overrides (value flag)",
    "    // \"1017541736\": true, // Design window sign-out kill-switch - ON stops a /logout navigation inside a Design window from being treated as a sign-out request (new in v4.29.0)",
    "    // \"1023672235\": true, // device-app simulator probe, read through the iOS/Android simulator helper (value read === true) (new since v2.7032.0)",
    "    // \"1028094019\": true, // daily session-storage inventory telemetry emitter gate (new in v1.46388.2)",
    "    // \"1037176078\": true, // Browser pane tool-point listener for the view surface (observed with 2885273120 for the renderer surface); a flip re-runs the listener gate (new in v4.29.0)",
    "    // \"1058684781\": true, // simulatorMiniView merger key: (iOS gate, hardcoded off || Android emulator gate 1118714395) && flag - the simulator stream's ?view=mini mode (new since v2.37337.1)",
    "    // \"1061122496\": true, // worktree destroy - removeWorktree + deleteWorktreeBranch gate",
    "    // \"1075970588\": true, // lastTurnEdgeAt in session payloads (default ON) (new in v3.1623.0)",
    "    // \"1078033889\": true, // iosSimulatorDuo merger override (value === true, observed) - INERT: its XU() prefix is hardcoded false (new in v2.31226.0)",
    "    // \"1085129406\": true, // session activity ledger collection for attended local sessions (new in v1.46388.2)",
    "    // \"1087396298\": true, // background GrowthBook refresh spread - value object (earlyMaxMinutes 0..30, lateDelayMaxSeconds 0..40) read by the new backgroundRefreshSpread export (value flag) (new in v2.26454.0)",
    "    // \"1088569250\": true, // remote managed settings: SSH computer policy kill-switch, observed (needs features loaded) (new in v3.1623.0)",
    "    // \"1088613064\": true, // /btw child shares its parent's worktree, needs 933167008 (default ON) (new in v3.1623.0)",
    "    // \"1109029378\": true, // macOS tray usage menu",
    "    // \"1111144847\": true, // browser_batch tool enable (default ON) (new in v1.37937.0)",
    "    // \"1118714395\": true, // device-companion platform gate (default OFF; ios variant hardcoded off)",
    "    // \"1126577245\": true, // sync/pull config object (value flag; purpose not catalogued)",
    "    // \"1129419822\": true, // ENABLE_TOOL_SEARCH='auto' env var for LAM sessions",
    "    // \"1130664526\": true, // MCP server connect: honours a condemned connection's pending handshake deadline instead of the fixed timeout (default ON) (new in v4.29.0)",
    "    // \"1130670564\": true, // in-app-browser log persistence for non-Anthropic pages - ON (like 3p) stops persisting them (new in v2.2553.0)",
    "    // \"1143436119\": true, // plugin CLI commands use the install record's plugin name (warns when plugin.json's name differs) and plugins with an invalid name are skipped (default ON) (new in v3.6556.2)",
    "    // \"1143815894\": true, // DO NOT ENABLE: bypasses the Cowork VM service and silently breaks skills/plugins",
    "    // \"1154150157\": true, // session mirrors kill-switch - ON stops a session claiming transcripts mirrored from its SSH/WSL host (new in v2.26454.0)",
    "    // \"1157630614\": true, // observed together with humbleSky 3485864475; a flip only triggers a recheck (new since v2.37337.1)",
    "    // \"1167079793\": true, // wslPreview merger key - WSL preview for Code sessions; Windows-only, inert on Linux (new since v2.37337.1)",
    "    // \"1169442571\": true, // session-host sibling gate, read with default ON next to 1341990989 and observed live; also a remote-allowed key in the 3p rule table (new since v2.7032.0)",
    "    // \"1182589080\": true, // Cowork live-artifact files (cowork_live_artifact): safeHtmlWrites - the artifact folder's HTML writes go through the safe writer (default ON) (new in v4.29.0)",
    "    // \"1183214304\": true, // rc-serve renderer heap-report gate (trio with 3764441751/1410651677) (new in v1.32352.1)",
    "    // \"1195339376\": true, // plugin deep-link kill-switch - ON stops claude:// /customize/plugins/<id> links from opening in-app (new since v2.7032.0)",
    "    // \"1197768857\": true, // spaceMemoryBridge feature gate - registry entry rt('1197768857')?Ed:{status:'unavailable'}",
    "    // \"1209626463\": true, // SSH worktree trust-check kill-switch - ON withholds the remote trust lookup (also a remote-allowed key in the 3p rule table) (new in v2.19675.1)",
    "    // \"1215234211\": true, // SSH policy-retirement sweep runs on every session-monitor tick (otherwise only while flags are more than 2h old); also a 3p forced-ON rule (new in v3.6556.2)",
    "    // \"1221293892\": true, // renderer crash-loop watchdog - app.exit(0) after 20 crashes in 60s (new in v1.26832.0)",
    "    // \"1234686386\": true, // device-companion sub-gate - INERT (its parent check is hardcoded false) (new in v2.7032.0)",
    "    // \"1239409407\": true, // app-menu Open Folder item (Ctrl+Shift+O; default ON); observed for menu rebuild (new in v1.46388.2)",
    "    // \"1240280160\": true, // worktree checkout-mode sibling gate, read with the 1754160972 mode config (new in v2.2553.0)",
    "    // \"1240761070\": true, // SSH failure-remedy kill switch - ON drops the remedies (e.g. review_host_key) a failed SSH session start offers (new in v2.7032.0)",
    "    // \"1263782781\": true, // git operation timeout config - bash/stage/commit default_ms and max_ms (value flag) (new in v1.40609.0)",
    "    // \"1265093829\": true, // Code session manager registration read (t.MS(() => flag)) at manager construction; also a 3p remote key (new since v2.37337.1)",
    "    // \"1265511872\": true, // macOS cloud-placeholder (dataless file) handling in the connected-folders reader (new in v1.37937.0)",
    "    // \"1266796968\": true, // device-app simulator probe, read through the iOS/Android simulator helper (inert: the helper's platform check is hardcoded off) (new in v2.19675.1)",
    "    // \"1278239935\": true, // browser-tools mouse-press guard kill-switch (frame-chain subframe origin grants) (new in v1.32352.1)",
    "    // \"1284392461\": true, // claude-bridge-ws WebSocket transport gate",
    "    // \"1287897741\": true, // isTurnEndSendHoldDisabled - CLI stdin turn-end send-hold kill-switch (new in v1.46388.2)",
    "    // \"1291166712\": true, // chicago (Computer Use) config: enabled/subGates/coordMode/dispatchTtlMs/appScoped (value flag)",
    "    // \"1293892711\": true, // SSH reattach sub-gate (default ON), one of three siblings next to the CLAUDE_DESKTOP_SSH_REATTACH env override (new since v2.7032.0)",
    "    // \"1294982044\": true, // tray poll config pollRequiresTrayOpenWithinHours (value flag) (new in v1.37937.0)",
    "    // \"1308449919\": true, // session activity-ledger collection kill-switch - observed live, ON stops collecting (new in v2.2553.0)",
    "    // \"1310358601\": true, // device-registry server-time sampling gate (clock-skew HEAD probe) (new in v1.32352.1)",
    "    // \"1320159951\": true, // simulator device-kind gate (ios / android / remote), per kind: Pkr(kind) && flag (new in v3.1623.0)",
    "    // \"1328180239\": true, // iOS/Android simulator auto-mode rules - adds simulator allow/deny rules to Code auto mode (value read === true) (new in v2.19675.1)",
    "    // \"1338660703\": true, // wslMcp feature gate (async merger override) - host MCP setup for WSL host sessions; WSL is Windows-only, inert on Linux (new in v2.37337.1)",
    "    // \"1340622498\": true, // isReconnectTimingKillswitchOn - SSH reconnect timing kill-switch (new in v1.40609.0)",
    "    // \"1341990989\": true, // Code-tab MCP tool-set gate, sibling of 270847253 / 2015900644 / 3556866454 (default ON) (new in v2.2553.0)",
    "    // \"1346252221\": true, // worktree tombstone gitfile-gone drop kill-switch (gitfileGoneDropDisabled), sibling of 2716316020 (new in v2.37337.1)",
    "    // \"1346958739\": true, // chicago macOS version floor: major/minor (value flag) (new in v1.28929.0)",
    "    // \"1358149550\": true, // Electron notification action backend probe (default ON, non-macOS) (new in v2.19675.1)",
    "    // \"1361104854\": true, // launch-agent edit preview - opens the preview pane without waiting (new in v2.19675.1)",
    "    // \"1385814901\": true, // org restrictions: value true skips the org allowed-folders list (see 3215533343) (new in v3.1623.0)",
    "    // \"1395094573\": true, // relogin session revive - immediate release-drain gate (new in v1.46388.2)",
    "    // \"1410651677\": true, // rc-serve config object, invalid keys fall back to defaults (value flag) (new in v1.32352.1)",
    "    // \"1412563253\": true, // askUserQuestion preview format ('html')",
    "    // \"1417220597\": true, // SSH engine module gate, sibling of 816856638 / 98041341 / 160242894 / 1855738666; also a 3p remote key (new in v3.1623.0)",
    "    // \"1417542257\": true, // CLI version-gated capability (default ON) for CLI >= 2.1.2xx (new in v2.19675.1)",
    "    // \"1420073448\": true, // app-menu: shows File > New Project (dispatchNewProject); also an app-menu rebuild observer (new in v4.29.0)",
    "    // \"1420990291\": true, // connector tools ask first in attended local Code sessions (no SSH controller, not unattended) (new in v3.1623.0)",
    "    // \"1434290056\": true, // Dispatch code tasks permission mode - bypass-permissions for dispatch sessions (new in v1.",
    "    // \"1439993118\": true, // OAuth v2 cache clear - on a rejected token refresh, clears the cached identity and retries (default ON) (new in v2.7032.0)",
    "    // \"1445006858\": true, // org restrictions: value true keeps auto_updates out of the org off-switch list (see 3215533343) (new in v3.1623.0)",
    "    // \"1447478638\": true, // LAM scheduled-task auto-permission gate (checked with mdmAutoModeDisabled)",
    "    // \"1453979703\": true, // plan / environment-routing tool gate (default ON) (new since v2.7032.0)",
    "    // \"1468130863\": true, // notifications: unless read as off, shows wait while the notifier initializes (holdsShows) (new since v2.37337.1)",
    "    // \"1475601049\": true, // turn-input wake hint when a turn is resumed (default ON); also a 3p remote key (new in v3.1623.0)",
    "    // \"1477483922\": true, // CCD gated-SDK-snapshot gate (chipLevel) - gate change marks session SDK snapshots stale (new in v1.32885.1)",
    "    // \"1479464684\": true, // cowork_spaces_store_recovery - Spaces store recovery on load (new since v2.7032.0)",
    "    // \"1480778051\": true, // render_rss_bytes memory-telemetry suppression (ON = skip emission)",
    "    // \"1486104550\": true, // remote-control session MCP verb gate, sibling of 2300874989 (default ON) (new in v2.2553.0)",
    "    // \"1496761016\": true, // Terminal panel tools - OFF answers \"The Terminal panel tools are turned off for this app or organization\" (default ON) (new in v2.2553.0)",
    "    // \"1517059896\": true, // CLI version-floor gate, third of the 96832454 / 2153038254 family (default ON) (new in v2.2553.0)",
    "    // \"1533587495\": true, // pending-permission re-notify - re-sends a pending approval card only while the context is below the token threshold (new in v2.7032.0)",
    "    // \"1544796833\": true, // session-concurrency limits, e.g. maxConcurrentPerSession (value flag)",
    "    // \"1549258603\": true, // LAM OAuth 401 refresh via resolveSdkOauthToken path",
    "    // \"1550954491\": true, // bare Alt-key tap opens the main menu popup in the main/design window (default ON) (new in v1.49585.0)",
    "    // \"1552109632\": true, // worktree entry-claims kill-switch - ON disables claim entries (new in v2.2553.0)",
    "    // \"1569828280\": true, // Binary-asset-fetch gate - if(!et('1569828280')){...gate_off...skipping binary asset fetch}",
    "    // \"1593661558\": true, // CCD commands/agents list memo kill switch - ON drops stale-while-revalidate and the wait for an installing query (new in v2.7032.0)",
    "    // \"1595132361\": true, // CLAUDE_CODE_QUESTION_EXTENDED env for local-agent sessions (new in v1.46388.2)",
    "    // \"1603637451\": true, // skills folder limits config - skillMdMaxBytes / assetMaxBytes / maxFilesPerSkill / folderBudgetBytes / resendSettleMs (value flag) (new in v1.46388.2)",
    "    // \"1606273333\": true, // scheduled-task MCP tool gate (default ON) (new in v2.2553.0)",
    "    // \"1607913098\": true, // worktree dependency seed (node_modules / .yarn install-state copy into a new worktree) kill-switch - ON skips it (new in v2.26454.0)",
    "    // \"1629866860\": true, // claude_code numeric tuning value (value flag)",
    "    // \"1643353800\": true, // /btw child of a session on an SSH host keeps its remote state (btwChildRemoteKept) (default ON) (new in v3.1623.0)",
    "    // \"1645353060\": true, // decideCliBinaryForSpawn - managed CLI binary selection (default ON, together with 762798616) (new in v1.46388.2)",
    "    // \"1648655587\": true, // scheduled-task active-session caps: perTask/global (value flag)",
    "    // \"1655142490\": true, // web_fetch permission: the allowlist/approval-card branch for sessions in an eligible permission mode (default ON) (new in v4.29.0)",
    "    // \"1669379374\": true, // OTLP content capture for Code sessions, passed into the OTEL env builder (new in v2.19675.1)",
    "    // \"1672337201\": true, // remote (SSH) plugin sync packing - ON uses the plain tar pipeline without the pack-stall watchdog and skips the capability-handshake retry (new in v2.31226.0)",
    "    // \"1675873863\": true, // earlier-sessions import/recovery from the Claude Code CLI (default ON); also a 3p remote-allowed key (new in v2.26454.0)",
    "    // \"1677081600\": true, // dispatch orchestrator base URL override (value flag)",
    "    // \"1696890383\": true, // CLAUDE_COWORK_MEMORY_GUIDE env - passes memory guide to cowork sessions (also in force-ON ",
    "    // \"1699596383\": true, // scheduled-task \"unreachable\" result classification (new in v2.2553.0)",
    "    // \"1701404423\": true, // bridge WebSocket pong-timeout reconnect-reason classification (overloaded / reset_silent / rotated) (new in v1.46388.2)",
    "    // \"1703762832\": true, // onModelRefusalFallback retry - when ON, a refusal response with direction:'retry' in Agent",
    "    // \"1707927936\": true, // size limit tuning, bytes (value flag)",
    "    // \"1710585411\": true, // office-bridge trigger context suppression - ON drops triggerId/orgUuid/accountUuid from the bridge request (new in v1.34493.1)",
    "    // \"1731450842\": true, // SSH login-by-file kill-switch (isSshLoginByFileKillswitchOn module); also a 3p remote key (new in v2.37337.1)",
    "    // \"1743527783\": true, // session quit-interrupt resume gateEnabled (interruptedByQuitAt handling) (new in v1.32352.1)",
    "    // \"1748356779\": true, // prompt template config: system_prompt/user_prompt (value flag)",
    "    // \"1751199319\": true, // own-environment rule kill-switch (isOwnEnvRuleKillswitchOn) - ON turns the own-environment permission rule off (new in v4.29.0)",
    "    // \"1753075645\": true, // artifact roster persistence - persists and re-seeds the per-session artifact roster across sessions (new since v2.7032.0)",
    "    // \"1754160972\": true, // worktree checkout-mode config (value flag) (new in v1.32352.1)",
    "    // \"1775569896\": true, // SSH helper peer check kill-switch (isHelperPeerCheckDisabled) (new in v2.26454.0)",
    "    // \"1776348311\": true, // unattended-session tool availability gate (\"This tool is unavailable in unattended...\") (new in v1.46388.2)",
    "    // \"1781903805\": true, // codeSessionKeepAwake - power-save blocker during Code turns (default ON) (new in v1.46388.2)",
    "    // \"1786315608\": true, // file-access git suffix worker kill-switch (gitSuffixWorkerDisabled) (new in v2.31226.0)",
    "    // \"1789959282\": true, // plugin CLI command op classification: the inverse of this flag is passed to the classifier (mY) as its last argument when a plugin's commands are classified (default ON) (new in v4.29.0)",
    "    // \"1820181386\": true, // Browser tab debugger attach guard (CDP Target.attachedToTarget / detach): ON makes attach and sendCommand refuse a tab whose main frame is an app page (new in v4.29.0)",
    "    // \"1824824999\": true, // consolidate-memory skill v2 - server-configured description/prompt text",
    "    // \"1825995196\": true, // SSH background-readopt candidates kill-switch (new in v1.37937.0)",
    "    // \"1835121223\": true, // CLI version-gated capability (default ON), sibling of 4288313598 / 2153038254 (new since v2.7032.0)",
    "    // \"1836754949\": true, // scheduled-task run report on completion + dispatch prompt-hash stash (new in v1.40609.0)",
    "    // \"1842150282\": true, // present_files scratchpad promotion: OFF stats the source file before promoting it to outputs (default ON) (new in v3.1623.0)",
    "    // \"1846651524\": true, // prompt-asker check kill-switch (isPromptAskerCheckKillswitchOn module) (new in v2.37337.1)",
    "    // \"1847129881\": true, // device Cowork artifact list tool - ON announces the newer list-artifacts tool instead of the 1947305033 one (new in v2.2553.0)",
    "    // \"1849776485\": true, // a session tool that takes a repository argument: OFF marks it alwaysLoad (default ON); also a 3p remote key (new since v2.37337.1)",
    "    // \"1855738666\": true, // SSH engine module gate, sibling of 816856638 / 98041341 / 160242894 / 1417220597; also a 3p remote key (new in v3.1623.0)",
    "    // \"1885697743\": true, // session added-folder links kill-switch (addedFolderLinksDisabled), sibling of 4100354330 (new in v2.26454.0)",
    "    // \"1893165035\": true, // enabled+categories config object (value flag)",
    "    // \"1908184743\": true, // Dispatch local scheduled-task creation switch (read through readBooleanFeature; on refuses creating Dispatch tasks on this computer, 1p only), sibling of 2357012936 (new in v2.31226.0)",
    "    // \"1923867086\": true, // terminal scrollback log + read_terminal tool (live listener) (new in v1.46388.2)",
    "    // \"1924247864\": true, // device-registry gate (Ylt)",
    "    // \"1925932989\": true, // session tool-set gate in the spawn-options module (default ON) (new in v1.46388.2)",
    "    // \"1927384307\": true, // Skill / Workflow / ClaudeInChromeDomain count as always-allowed tools in permission rules; only an Anthropic server OFF rule switches it off, an override cannot (new in v4.29.0)",
    "    // \"1928275548\": true, // framebufferPreview feature - dev-gated (inside MW())",
    "    // \"1932334991\": true, // remote-control bridge restore at launch - max sessions restored (number, default 4) (value flag) (new in v2.26454.0)",
    "    // \"1932607618\": true, // claude_code_web environment lookup kill-switch - ON skips listing cloud environments (new since v2.37337.1)",
    "    // \"1932964967\": true, // substituted-path refusal for git/worktree paths (default ON) (new in v2.19675.1)",
    "    // \"1934308538\": true, // dispatch memory migration - preview / migrate / export Dispatch memory into a project (new in v2.19675.1)",
    "    // \"1934689456\": true, // reused git worktree bootstrap-file verification kill switch (read through readBooleanFeature; off skips the verification) (new in v3.6556.2)",
    "    // \"1936069307\": true, // Code session warm/start re-checks a Desktop-made (non-hook) git worktree at the session folder before spawning (default ON) (new in v3.6556.2)",
    "    // \"1936081873\": true, // system-prompt build-skip",
    "    // \"1942337209\": true, // local MCP client protocol version negotiation kill-switch - ON drops the auto version probe (500ms) (new in v1.30096.1)",
    "    // \"1942781881\": true, // Prompt suggestions in sessions",
    "    // \"1947305033\": true, // augments a tool description",
    "    // \"1953604137\": true, // ccd_directory target step: OFF answers 'paused' (default ON); also a 3p remote key (new since v2.37337.1)",
    "    // \"1959693801\": true, // SSH session MCP servers on the host after a restart (mcpOnHostRestart), next to the CLAUDE_DESKTOP_SSH_REATTACH family (new in v2.31226.0)",
    "    // \"1966121882\": true, // cloud scheduling window (value flag) - start/end minutes used in the Tasks can move to the cloud later text (new in v4.29.0)",
    "    // \"1968338882\": true, // [remote-file] committed-digest dedupe skip - ON stops matching staged files against already committed ones, sibling of 2001396010 / 2096326160 (new in v2.37337.1)",
    "    // \"1970776439\": true, // simulator deny rule for the xcrun cache (denyXcrunCache) (default ON) (new in v3.1623.0)",
    "    // \"1972091654\": true, // askClaude device RPC",
    "    // \"1978029737\": true, // pluginsSyncIntervalMs (value flag)",
    "    // \"1984014873\": true, // skipped-block restore kill-switch (isSkippedBlockRestoreKillswitchOn module) (new in v2.31226.0)",
    "    // \"1985233154\": true, // Code tab: list and tail terminal Claude Code CLI sessions (listCliSessions / openCliTail) (new in v2.37337.1)",
    "    // \"1986048577\": true, // routine sheet late-window ms (resolveRoutineSheetLateWindowMs) - default 7200000, clamped 60000..86400000, <=0 disables (value flag) (new in v1.49585.0)",
    "    // \"1988806793\": true, // plugin restore verifies install paths before reuse (default ON); also a 3p remote key (new in v3.1623.0)",
    "    // \"1991650828\": true, // shell agent-socket kill switch - ON starts shells without the agent socket (isShellAgentSocketKillswitchOn) (new in v2.7032.0)",
    "    // \"1992087837\": true, // chillingSlothPool worktree warm pool - feature left the registry in v1.28929.0, flag still gates warm-pool isEnabled",
    "    // \"2000661115\": true, // kill-switch for CLAUDE_CODE_STARTUP_FAILURE_RESULTS - ON stops setting it for the Code CLI (replaces 3488857202) (new since v2.37337.1)",
    "    // \"2001396010\": true, // [remote-file] outputs commit kill-switch - ON refuses staged file commits with \"disabled\" (new in v2.2553.0)",
    "    // \"2004571505\": true, // LocalMcpServerManager closeServerByName path gate (default ON) (new in v1.37937.0)",
    "    // \"2015900644\": true, // Code-tab MCP tool-set gate, sibling of 270847253 / 1341990989 / 3556866454 (default ON) (new in v2.2553.0)",
    "    // \"2016258596\": true, // device-tool artifact storage/read gate (artifact_read_gate_off telemetry when OFF)",
    "    // \"2018643766\": true, // git source-ref fetch memo / --porcelain fetch kill switch - ON disables both (new in v2.7032.0)",
    "    // \"2023768496\": true, // coworkTrustedDeviceToken read/write gate",
    "    // \"2026670512\": true, // CoworkVMService pipe background-check kill-switch - Windows only, inert on Linux (new in v2.37337.1)",
    "    // \"2037470163\": true, // SSH reconnect - ON stops holding a redial while the machine sleeps (sleepRedialDeferArm) for non-host connections (new in v2.37337.1)",
    "    // \"2048589233\": true, // thinkingSummaryOnDemand in the CCD gated-SDK snapshot, default ON; also in the snapshot-staleness observe list (new in v1.34493.1)",
    "    // \"2049450122\": true, // Session handoff - gates cross-device session activity broadcasting (com.anthropic.claude.s",
    "    // \"2051751800\": true, // Chrome permission-mode skip_all_permission_checks resolver gate",
    "    // \"2051942385\": true, // CIC can-use-tool",
    "    // \"2054689343\": true, // source-branch prefetch for new Code sessions - ON turns it off; also a 3p remote key (new in v3.1623.0)",
    "    // \"2057990550\": true, // ccd_settings MCP tools - get_settings / set_setting over the Code tab preferences (default ON) (new in v2.2553.0)",
    "    // \"2062156710\": true, // SSH lean-reconnect force-on (CLAUDE_DESKTOP_SSH_LEAN_RECONNECT env is the manual switch) (new in v1.40609.0)",
    "    // \"2064610596\": true, // transcript reads: subagent-text inclusion kill-switch - ON leaves subagent text out even when a caller asks for it (new in v2.31226.0)",
    "    // \"2067027393\": true, // canLaunchCodeSession - launch-a-Code-session suggestion tool for the chat agent",
    "    // \"2069870456\": true, // size cap for MCP tool results in transcript uploads, floored at 100000 (value flag) (new since v2.37337.1)",
    "    // \"2071326072\": true, // bridge reconnect backoff kill-switch - ON disables the backoff schedule (new in v1.46388.2)",
    "    // \"2071783254\": true, // isNetworkWaitKillswitchOn - ON disables the network wait (new in v2.2553.0)",
    "    // \"2088149064\": true, // device-companion platform sub-gate, read through the same wrapper as 1118714395 (inert: its tV() prefix is hardcoded false) (new in v2.2553.0)",
    "    // \"2096326160\": true, // remote-file device-path staging lookup skip - sibling of 3783846612 (new in v1.46388.2)",
    "    // \"2114555806\": true, // SSH host MCP rules: managed-only direct pool gate (Code sessions on an SSH host) (new in v2.26454.0)",
    "    // \"2114777685\": true, // cowork onboarding role picker (first-run cowork-onboarding MCP tool)",
    "    // \"2115990222\": true, // artifactsPane feature gate - NEW static registry feature artifactsPane:DPt() where functio",
    "    // \"2120747855\": true, // prompt-suggestions setting gate - part of the CCD gated-SDK snapshot (promptSuggestionsSetting); the keep-awake setting row says 'ignored for now' when off (new since v2.7032.0)",
    "    // \"2122024166\": true, // auto-resume after a rate limit, sibling of 2810334838 (default ON) (new in v3.1623.0)",
    "    // \"2122679090\": true, // SSH sessions: ON stops sending laptop MCP servers to the host (kill-switch); also a 3p remote key (new since v2.37337.1)",
    "    // \"2124129656\": true, // MSIX deployment-log baseline read on a version's first launch (telemetry) - Windows MSIX only, inert on Linux (new in v2.31226.0)",
    "    // \"2137293109\": true, // Cowork protected mounts: folder grants carry the hide/glob protected-subpath list for a known mount (default ON) (new in v4.29.0)",
    "    // \"2140326016\": true, // Author-supplied bin stubs error enforcement",
    "    // \"2143883161\": true, // /code/ route gate",
    "    // \"2152240709\": true, // Windows SSH host probe kill-switch (isWindowsHostProbeKillswitchOn module); also a 3p remote key (new since v2.37337.1)",
    "    // \"2153038254\": true, // CLI version-floor gate (default ON) - sibling of 96832454 (new in v1.46388.2)",
    "    // \"2154436814\": true, // SSH session-scope fence kill-switch - ON lets an SSH session see/change sessions beyond its own connection (new in v2.26454.0)",
    "    // \"2158738188\": true, // session file access - ON stops adding the org/account-scoped roots to the readable-file allowlist (kill-switch) (new in v2.37337.1)",
    "    // \"2161994580\": true, // ccd_view MCP tools - show_pane / close_pane / get_layout (default ON) (new in v2.2553.0)",
    "    // \"2192324205\": true, // tool-result formatting - renders dispatch-child/Code sub-session result blocks in the transcript",
    "    // \"2199259197\": true, // first gate of the launch-preview availability chain (with launchEnabled, the browser pane and 3699048477); 3p forced OFF (new in v3.1623.0)",
    "    // \"2214981414\": true, // device-registry gate, sibling of 1310358601 (new in v1.32352.1)",
    "    // \"2216414644\": true, // Remote session control (Dispatch mobile)",
    "    // \"2216766246\": true, // remote-tools-device interval ms, 0=off (value flag) (new in v1.32352.1)",
    "    // \"2220415149\": true, // seed stable device id into the session's Claude config dir (new in v1.32352.1)",
    "    // \"2222745432\": true, // host worktree write guard: marks the guard known-off (guardKnownOff), as 2393677837 OFF does; also a 3p forced-ON key (new in v2.31226.0)",
    "    // \"2227247507\": true, // remote policy case-fold kill-switch (isRemotePolicyCaseFoldKillswitchOn module); also a 3p remote key (new in v2.37337.1)",
    "    // \"2229805612\": true, // remote_control_at_startup default",
    "    // \"2240013170\": true, // automatic session title check after a turn (new in v2.2553.0)",
    "    // \"2255491096\": true, // main view no-flush bytecode latch (mainViewNoFlushBytecodeLatched) - the flag value is latched into a pref (not 3p); the bytecode cache flag is added at the next start (new in v4.29.0)",
    "    // \"2278171137\": true, // disclaimed-cwd TCC preflight kill-switch - ON skips the preflight (new in v2.2553.0)",
    "    // \"2280348969\": true, // CLI process-group reap gate (new in v2.2553.0)",
    "    // \"2294160313\": true, // plugin sync module gate, default ON - sibling of 4039294468 (value flag) (new in v1.40609.0)",
    "    // \"2300874989\": true, // remote-control session MCP verb gate, sibling of 1486104550 (default ON) (new in v2.2553.0)",
    "    // \"2303338333\": true, // archived-session hints in list results, observed live (default ON) (new in v2.2553.0)",
    "    // \"2307090146\": true, // Plugin OAuth storage gate (also added to force-ON defaults map)",
    "    // \"2323591725\": true, // imported conversation system prompt carry-over (importedPromptProvisional) (default ON); also a 3p remote key (new in v2.37337.1)",
    "    // \"2340532315\": true, // Plugin sync on session start",
    "    // \"2343547264\": true, // chat / pool shared session handoff waits up to 3 min for the other side's pending close (default ON); also a 3p remote key (new in v3.1623.0)",
    "    // \"2345107588\": true, // GrowthBook cache persistence - persist/seed GrowthBook cache from/into sessions (new in v1",
    "    // \"2345515473\": true, // Sessions-bridge account-change reevaluation",
    "    // \"2356766696\": true, // browser consent: select the browser card without a live selection (selectBrowserCardWithoutLiveSelection, default ON) (new in v4.29.0)",
    "    // \"2357012936\": true, // Dispatch scheduled-tasks-off switch (read through readBooleanFeature; on blocks Dispatch scheduled tasks) (new in v2.26454.0)",
    "    // \"2365358358\": true, // ccd_sidebar MCP tools - list/create/rename/delete groups, move sessions, pin, unread, mark completed (new in v1.46388.2)",
    "    // \"2368147223\": true, // org restrictions kill-switch: value true applies no org restriction (see 3215533343) (new in v3.1623.0)",
    "    // \"2369932081\": true, // device_link tool on the remote tools device - returns this computer's registered device key for a cse_ session; off refuses with feature_off (new in v3.6556.2)",
    "    // \"2371478310\": true, // sideSessions - start_session / hand_off_to_session tools + async merger override (new in v1.46388.2)",
    "    // \"2375401243\": true, // shell-quoting heuristic for host-to-VM path rewriting (default ON) (new in v2.2553.0)",
    "    // \"2392971184\": true, // Replay user messages - adds --replay-user-messages to CLI args for session resume; also en",
    "    // \"2393677837\": true, // PreToolUse hook for worktree-aware tool input validation",
    "    // \"2394039067\": true, // git credential posture legacy fallback for read/push/fetch/scrub (new in v1.46388.2)",
    "    // \"2405551282\": true, // stamped-proof check mode - enforce when ON (default), observe-only when off (new in v2.7032.0)",
    "    // \"2418078319\": true, // Code plugin manager keeps manifests out that would drop LSP servers (new in v3.1623.0)",
    "    // \"2419725631\": true, // permission answers: unless read as off, a lasting answer derives its rule from the tool input (default ON) (new in v3.1623.0)",
    "    // \"2426766406\": true, // git drive lookup kill-switch for session-repository fetch/push - ON skips the lookup (new in v2.26454.0)",
    "    // \"2427043945\": true, // numeric rate/threshold (value flag)",
    "    // \"2443135235\": true, // remote directory write-deny kill-switch (isRemoteDirWriteDenyDisabled) - SSH transport block (new in v2.26454.0)",
    "    // \"2464731750\": true, // browser-pane request_access tool - a flip reloads the remote-tools device (new in v1.37937.0)",
    "    // \"2464838160\": true, // lazy worktree start for attended sessions (new in v1.46388.2)",
    "    // \"2486083521\": true, // Computer Use can_use_tool path for sessions (cuCanUseToolEnabled, not for radar sessions) (new since v2.7032.0)",
    "    // \"2487484738\": true, // CLAUDE_CODE_ENABLE_BG_SHELL_PRESSURE_REAP=1 in the local-agent CLI env (new in v2.2553.0)",
    "    // \"2503988833\": true, // auto-mode rule set gate (default ON) (new in v2.19675.1)",
    "    // \"2515400668\": true, // artifact preview for Edit/Write on matching file types (new in v2.19675.1)",
    "    // \"2521146974\": true, // git status-cache warm-up mode - ON reverts core.untrackedcache/feature.manyfiles, off primes them (new in v2.7032.0)",
    "    // \"2526291435\": true, // dispatch-local-history kill-switch - ON disables local dispatch history (eOa returns false) (new in v4.29.0)",
    "    // \"2527375164\": true, // browser preview lookup skips a preview whose tab is gone (new in v3.1623.0)",
    "    // \"2529235968\": true, // shadowRemoteServers - shadow remote plugin MCP servers with local ones (new in v1.37937.0)",
    "    // \"2533965962\": true, // session file placement kill-switch - ON returns no placement (getSessionFilePlacement); also a 3p remote-allowed key (new in v2.26454.0)",
    "    // \"2537760906\": true, // scheduled-task pending-permission auto-deny after the wait budget (new in v1.46388.2)",
    "    // \"2576868839\": true, // isSignalWakeKillswitchOn - SSH signal-wake kill-switch (new in v1.40609.0)",
    "    // \"2595385640\": true, // session-storage inventory telemetry - folder walk allowed (sibling of the 1028094019 emitter gate) (new in v1.49585.0)",
    "    // \"2600626699\": true, // SSH reattach sub-gate (default ON), sibling of 1293892711 / 3538168636 (new since v2.7032.0)",
    "    // \"2605355193\": true, // plugin hot-reload for running sessions (default ON) (new in v1.40609.0)",
    "    // \"2607171605\": true, // main view print-call guard (printCallGuardEnabled) (default ON) (new in v2.31226.0)",
    "    // \"2614807392\": true, // Session feature A",
    "    // \"2620213359\": true, // inverted gate in the dynamic-commands chunk - ON turns its feature off (consumer not resolved) (new in v2.26454.0)",
    "    // \"2631345040\": true, // side-sessions archive-keeps-family (default ON), observed live; needs 2371478310 (new in v2.19675.1)",
    "    // \"2645895612\": true, // Google Drive export allowed while folder access is restricted (read as on) (new since v2.37337.1)",
    "    // \"2654621331\": true, // EventLogging telemetry flush-interval ms - live listener (value flag) (new in v1.32352.1)",
    "    // \"2661075028\": true, // coworkCopperHeron async merger override - requires watch-record first, which is darwin/win32 only, so inert on Linux (new in v2.2553.0)",
    "    // \"2663965347\": true, // effort-gate copy rule for forked sessions; 3p forced OFF (new in v3.1623.0)",
    "    // \"2670549942\": true, // wslLocalFiles merger key - WSL local files; Windows-only, inert on Linux (new since v2.37337.1)",
    "    // \"2675972342\": true, // auto-mode classifier stand-down for force-ask tools (permission_mode_auto path, default ON) (new in v2.7032.0)",
    "    // \"2684344147\": true, // MCP apps from SSH hosts (with 513873720; env CLAUDE_E2E_SSH_HOST_MCP_APPS) (new in v3.6556.2)",
    "    // \"2694357830\": true, // iOS/Android simulator tools always-load by dev intent (alwaysLoadOnDevIntents: ios_app / android_app / react_native_app / flutter_app) (new in v2.26454.0)",
    "    // \"2696933583\": true, // ccd editor MCP tools - open_in_editor / reveal_path / request_keep_awake (default ON) (new in v2.2553.0)",
    "    // \"2706827450\": true, // remote Computer Use: same-identity grant release kill-switch - ON keeps the computer held for other sessions (new in v2.26454.0)",
    "    // \"2711562102\": true, // dev-server preview autoPort retargeting to a free port when autoPort is unset (default ON) (new in v2.37337.1)",
    "    // \"2716316020\": true, // worktree tombstone lane kill switch - ON disables the moved-aside worktree tombstone queue (new in v2.7032.0)",
    "    // \"2719700143\": true, // pop-out pane claimant arbitration between two visible native views (default ON) (new in v1.40609.0)",
    "    // \"2725876754\": true, // Org CLI exec policies - gates reading orgCliExecPolicies for plugin tool permission checks",
    "    // \"2726556121\": true, // INVERTED: ON disables the SSH file-transfer fast-path",
    "    // \"2742800629\": true, // inline visualizations latch-off check (with 3444158716; HIPAA gate still wins) (new in v2.19675.1)",
    "    // \"2745857735\": true, // LAM remote folder-access homeDirectories + remoteFileTools",
    "    // \"2753512555\": true, // teleport-to-cloud handoff tool - also requires claude.ai product features (default ON) (new in v2.2553.0)",
    "    // \"2766090483\": true, // third-party history import: memory category - offered only when ON and the import is allowed by managed configuration (new in v2.31226.0)",
    "    // \"2766542666\": true, // base-branch sync on PR autofix kill switch - ON skips syncSessionWithBaseBranch before an autofix (new in v2.7032.0)",
    "    // \"2767293802\": true, // Edit-menu command claim by pop-out panes (default ON); observed for menu rebuild (new in v1.46388.2)",
    "    // \"2768029720\": true, // terminal tool command check - when the flag reads off, the check runs without its time limit; also a 3p remote key (new in v2.37337.1)",
    "    // \"2768556909\": true, // plugin pack stall guard: ON keeps the pack-stall watchdog; only an Anthropic server OFF rule switches it off, an override cannot (new in v4.29.0)",
    "    // \"2768844978\": true, // Cowork VM image delta-apply download path (applyVmImageDelta)",
    "    // \"2782756997\": true, // artifact view snapshot capture path for parked artifact views (default ON) (new in v2.37337.1)",
    "    // \"2783230213\": true, // Code plugin manager keeps refused manifests out (needs features loaded, default ON); also a 3p remote key (new in v3.1623.0)",
    "    // \"2784298314\": true, // Android simulator probe (via the simulator helper) (new in v2.19675.1)",
    "    // \"2787764107\": true, // held-routine-release device-reconnect config - enabled / minIntervalSeconds / minGapSeconds (value flag) (new in v2.2553.0)",
    "    // \"2795002549\": true, // Projects OAuth scopes",
    "    // \"2795119042\": true, // plugin path lookup on an SSH host (getRemotePluginPathsForHost) (default ON); also a 3p remote key (new in v3.1623.0)",
    "    // \"2795595714\": true, // device-companion secondary gate (default ON; currently inert - co-gate hardcoded off)",
    "    // \"2796650556\": true, // remote control: OFF refuses permission-mode changes while remote control is active (default ON) (new in v3.1623.0)",
    "    // \"2798169495\": true, // batch file-read request gate (invalid / too_large / too_many outcomes) (new in v1.46388.2)",
    "    // \"2806360886\": true, // folder-access request kill-switch - ON disables the remembered/dialog folder-grant path (new in v1.34493.1)",
    "    // \"2810334838\": true, // auto-resume after a rate limit (read as on/off), sibling of 2122024166 (new in v3.1623.0)",
    "    // \"2813075929\": true, // hooks: managed-settings tiers are resolved through realpath with a hop guard (default ON) (new in v3.1623.0)",
    "    // \"2818396951\": true, // OAuth identity re-check on cached tokens (default ON) (new in v2.19675.1)",
    "    // \"2825088777\": true, // [remote-cu] remote computer-use control - longer resolution-cache TTL and lock lease when ON (new in v2.2553.0)",
    "    // \"2833454025\": true, // ccd_turn: the closing message follows the question by default (closingFollowsQuestion, default ON) (new in v3.1623.0)",
    "    // \"2833632524\": true, // keptInputRecoverySwitchedOff - kill-switch for kept-input recovery on dying sessions (new in v1.40609.0)",
    "    // \"2848557028\": true, // delete-permission-requests tool for connected folders (new in v1.37937.0)",
    "    // \"2852146080\": true, // iOS simulator feature behind the iOS gate, hardcoded off - inert (new since v2.37337.1)",
    "    // \"2857785401\": true, // waitingInputPersistSwitchedOff - kill-switch for persisting waiting session input (new in v1.40609.0)",
    "    // \"2860690664\": true, // Cowork confinement telemetry reader (value.on === true): cowork_folder / remote_folder / sandbox_on / launcher_marked events are reported (new in v4.29.0)",
    "    // \"2860753854\": true, // consent text override string (value flag)",
    "    // \"2864556627\": true, // Artifact host-tools capability - advertises the host-tools hostcap and authorizes host-tool calls from the artifact pane (new in v1.34493.1)",
    "    // \"2877254163\": true, // worktree warm mode - off / stubs / full (value flag) (new in v1.46388.2)",
    "    // \"2880068568\": true, // Code tab CLI session discovery: ON reads persisted markers without the default filter (new in v3.1623.0)",
    "    // \"2880683999\": true, // device-app simulator probe (inert: the helper's platform check is hardcoded off) (new in v2.19675.1)",
    "    // \"2885273120\": true, // Browser pane tool-point overlay - forwards where an agent's browser tool acts to the renderer (dispatchPreviewToolPoint) (new in v3.6556.2)",
    "    // \"2893011886\": true, // enabled toggle read via value store",
    "    // \"2897767209\": true, // wslTerminal feature gate (async merger override) - integrated terminal for WSL sessions; WSL is Windows-only, inert on Linux (new in v2.37337.1)",
    "    // \"2902719601\": true, // cowork built-in MCP tool list for non-cowork surfaces (also a remote-allowed key in the 3p rule table) (new in v2.19675.1)",
    "    // \"2906028114\": true, // side-session offer card copy when the user sends a new message instead (default ON) (new in v2.19675.1)",
    "    // \"2906979861\": true, // remote outputs sync enable - pairs with the 848696239 dry-run (new in v1.46388.2)",
    "    // \"2917981554\": true, // UNC path allowance when opening a connected folder in the Cowork VM (also a 3p defaults-map key) (new in v2.2553.0)",
    "    // \"2921739883\": true, // bridge reconnect backoff config - min_ms / max_ms / stable_ms (value flag) (new in v1.46388.2)",
    "    // \"2927833255\": true, // CLI version-gated capability (default ON), sibling of 1835121223 / 2153038254 / 4288313598 (new in v4.29.0)",
    "    // \"2938421209\": true, // updater staged-update tick interval (value flag) (new in v1.37937.0)",
    "    // \"2939838186\": true, // SSH Windows host terminal - shell panes on a Windows OpenSSH host (sshWindowsHost) (new in v2.31226.0)",
    "    // \"2940196192\": true, // coworkArtifacts - Cowork artifacts (list/thumbnails IPC, artifact inference, VM mount)",
    "    // \"2948506237\": true, // auth callback nonce mismatch tolerance - ON accepts a callback whose nonce does not match (new in v2.2553.0)",
    "    // \"2950187366\": true, // scheduled-task sessions: project-config root fence delivery check (default ON) (new in v4.29.0)",
    "    // \"2956369517\": true, // gate helper with no caller found in the v4.29.0 bundle (DBr) - effectively inert (new in v4.29.0)",
    "    // \"2961678273\": true, // [logRetention] transcript-retention sweep kill-switch - ON reports skipped:disabled (new in v2.2553.0)",
    "    // \"2961849615\": true, // revive CCD sessions after relogin",
    "    // \"2974609625\": true, // scheduled-task promotion thresholds - minRunsObserved / minObservedDays and bound variants (value flag) (new in v1.46388.2)",
    "    // \"2978765495\": true, // desktop extensions: report live Node/Python runtime discovery to the extension host (default ON; off uses the cached legacy probe) (new in v3.6556.2)",
    "    // \"2979038612\": true, // Session notifications - queueSessionNotification for model switch, folder access",
    "    // \"3000061192\": true, // legacy shadow-git scan, read with 4286026368 / 630659907 (new in v2.2553.0)",
    "    // \"3014178965\": true, // terminal shell-integration sub-gate (default ON), sibling of 4044603026; also a remote-allowed key in the 3p rule table (new since v2.7032.0)",
    "    // \"3018088575\": true, // local MCP server manager gate, default ON (new in v1.32352.1)",
    "    // \"3019665678\": true, // Code-tab credential re-mint fallback (default ON) (new in v1.46388.2)",
    "    // \"3025587613\": true, // side-sessions event injection (default ON; with 3531612483) (new in v1.46388.2)",
    "    // \"3031066511\": true, // main window hang handling: hangKillSpareEnabled (default ON) (new in v4.29.0)",
    "    // \"3038984622\": true, // session-owns-linked-loopback-port check (sessionOwnsLinkedLoopbackPort) (default ON); also a 3p forced-OFF key (new in v2.31226.0)",
    "    // \"3042392253\": true, // ccdBaseBranchSync tool - brings a session branch up to date with its base, git run on the host (default ON) (new in v2.7032.0)",
    "    // \"3043546415\": true, // [EventLogging] telemetry credential mode - cookie / bearer / off (value flag; peeked at startup + observed) (new in v1.46388.2)",
    "    // \"3045399524\": true, // session config: enabled/alwaysLoad (value flag)",
    "    // \"3046457088\": true, // cowork taskRunFinished permission-resolve routing (new in v1.26832.0)",
    "    // \"3046702961\": true, // app-menu Code entries when the Code surface is enabled (default ON); observed for menu rebuild (new in v1.40609.0)",
    "    // \"3052534774\": true, // window title follows the page title - observed live on the main window (new in v2.19675.1)",
    "    // \"3054372951\": true, // browser pane pinch-zoom range 1x-3x (setVisualZoomLevelLimits) (default ON) (new in v3.1623.0)",
    "    // \"3059213726\": true, // session title suggestions - offers a proposed title and persists titleOffers (new in v2.7032.0)",
    "    // \"3067718716\": true, // permission-card response follow-up for remote-control sessions (default ON) (new since v2.7032.0)",
    "    // \"3076393065\": true, // ccd_window MCP tools - open_session_in / close_split / set_sidebar_collapsed / get_window_layout (split-view layout of Code sessions) (new in v1.49585.0)",
    "    // \"3091959505\": true, // project-thread remote sessions keep their requested permission mode on a trusted device (claude_code_trusted_devices_required) (new in v3.6556.2)",
    "    // \"3093186863\": true, // SSH reattach kill-switch - ON forces reattach off regardless of CLAUDE_DESKTOP_SSH_REATTACH (new in v1.34493.1)",
    "    // \"3093754864\": true, // session auto-archiving decision module gate (default ON) (new in v2.2553.0)",
    "    // \"3098422930\": true, // pane tool permission: with this flag OFF a pane tool asks regardless of the CLI's auto mode; only an Anthropic server OFF rule applies, an override cannot (new in v4.29.0)",
    "    // \"3106428025\": true, // remote control kept live across an update quit (remoteControlLiveAtUpdateQuit), needs 3188054034 (new in v2.31226.0)",
    "    // \"3110215237\": true, // SSH automatic warm from a page - ON stops page-triggered warms going through the managed-settings unattended-use check (new in v2.31226.0)",
    "    // \"3123045134\": true, // resolveCloudBranch - cloud branch resolution (OFF throws Feature disabled) (new in v1.26832.0)",
    "    // \"3126429675\": true, // remote-plugin enabled-state SWR / app-owned roots kill switch - ON disables both (new in v2.7032.0)",
    "    // \"3141359837\": true, // enforce installing a downloaded update while auto-update is disabled by policy and installedUpdateEnforcement is unset (new in v3.6556.2)",
    "    // \"3142047527\": true, // app-menu rebuild observer (new in v1.40609.0)",
    "    // \"3162918178\": true, // CCD folder setup tools (request_directory / change_directory / propose_branch) (default ON) (new in v2.7032.0)",
    "    // \"3163246478\": true, // bridge WebSocket mid-call pong-grace kill-switch (new in v1.40609.0)",
    "    // \"3165386771\": true, // git private index dir for host git commands kill-switch - ON keeps GIT_INDEX_FILE as is (new in v2.26454.0)",
    "    // \"3166359512\": true, // memory-item inventory dispatcher gate (isOn / observe) (new in v1.46388.2)",
    "    // \"3169491220\": true, // fixed 30s reconnect delay instead of exponential backoff (default OFF) (new since v2.7032.0)",
    "    // \"3184956269\": true, // MCP Apps host for host-loop Code sessions (CLAUDE_CODE_MCP_APPS_HOST=1 and app-hosted local MCP servers) (new in v2.37337.1)",
    "    // \"3188054034\": true, // remote control (rc-serve) start gate, together with the org remote-control policy (new in v2.26454.0)",
    "    // \"3215533343\": true, // org restrictions payload {off:[auto_updates|local_mcp|extensions|extension_directory], folders:{mac:{...}}} - honored only when served with GrowthBook source override, so a local override cannot drive it (value flag) (new in v3.1623.0)",
    "    // \"3216202605\": true, // sleep auto-resume offer - with 4044603026, offers to resume a turn interrupted by system sleep (default ON) (new in v2.7032.0)",
    "    // \"3219409785\": true, // GitHub PR merge-queue polling for github.com PRs (default ON) (new in v3.1623.0)",
    "    // \"3223040764\": true, // claude-in-chrome MCP tool set for Cowork VM sessions (default ON) (new in v2.2553.0)",
    "    // \"3229517805\": true, // scheduled-task config: sampleConcurrencyLimit/dataCacheTtlMs (value flag)",
    "    // \"3232490879\": true, // app-worktree trust inheritance re-checks the creation grant (needs features loaded, default ON); 3p forced OFF (new in v3.1623.0)",
    "    // \"3239659229\": true, // quiet-exit handling for idle Claude Code sessions (default ON) (new in v2.19675.1)",
    "    // \"3268860314\": true, // GitHub PR digest: cheap per-host fetch path (default ON) (new in v3.1623.0)",
    "    // \"3271506809\": true, // boolean with default ON in the SSH/side-session gate block (exported, consumer not resolved) (new in v2.26454.0)",
    "    // \"3285376524\": true, // auto-mode escalation kill-switch for unattended / Dispatch-child turns (new in v2.26454.0)",
    "    // \"3300773012\": true, // scheduled-task skill description override (value flag)",
    "    // \"3302457740\": true, // hosts allowlist config (value flag)",
    "    // \"3315523143\": true, // empty-workspace session restore lookup (new in v2.19675.1)",
    "    // \"3324120397\": true, // kill-switch: ON stops honoring the organization's disableSideloadFlags in Code sessions (new since v2.37337.1)",
    "    // \"3337309460\": true, // kill-switch for the CLI turn-boundary hint (cliBeganOwnTurn, CLI >= 2.1.211) (new in v3.1623.0)",
    "    // \"3348825467\": true, // git-shadow repository location under userData (new in v2.19675.1)",
    "    // \"3353561839\": true, // Browser pane shared-use notice - tracks what the user did in a tab shared with the agent (pointer, keyboard, toolbar); a flip re-reads every tab gate (new in v4.29.0)",
    "    // \"3371831021\": true, // cuOnlyMode - computer-use-only session variant",
    "    // \"3372259263\": true, // device attestation v2 mint gate (try/catch read; also on the 3p remote-allowed list) (new in v1.46388.2)",
    "    // \"3373978046\": true, // WSL workspace folders (Windows-only, inert on Linux) (new in v3.6556.2)",
    "    // \"3374559484\": true, // remote device pairing (remoteGrandPrix) probe gate - grandPrix is macOS-only (new since v2.37337.1)",
    "    // \"3377630395\": true, // overlay/window mount toggle",
    "    // \"3397569164\": true, // kill-switch: ON stops the shell tail-read copies (shellTailRead) (new in v3.1623.0)",
    "    // \"3400412699\": true, // app-scoped Computer Use close-background menu (off disables it while the user pref is default); app-scoped CU is macOS 15+ only (new in v2.37337.1)",
    "    // \"3414805749\": true, // worktree sweepUntrackedDirs skip (ON = skip orphan sweep) (new in v1.26832.0)",
    "    // \"3419852220\": true, // relaunch auto-resume switch-off - ON reports switched_off and resumes nothing after a relaunch (new in v2.2553.0)",
    "    // \"3424452980\": true, // Browser pane container localhost (isContainerLocalhostEnabled) - offers the cloud preview tool list instead of the Cowork one (new in v3.6556.2)",
    "    // \"3424551112\": true, // autoMode permission rule sets (environment/soft_deny/allow) merged into non-chat session opts (new in v1.28929.0)",
    "    // \"3424654946\": true, // update channel picker (latest / stable) - INERT: its prefix is hardcoded false (new in v2.31226.0)",
    "    // \"3436441689\": true, // file-access prompt admin-policy interplay (new in v1.26832.0)",
    "    // \"3444158716\": true, // Imagine/Visualize MCP server for cowork+ccd sessions",
    "    // \"3448679706\": true, // session-config enable gate next to the 3045399524 parse (replaces 130970054) (new in v1.28929.0)",
    "    // \"3457044425\": true, // kill-farewell kill-switch (isKillFarewellKillswitchOn module); also a 3p remote key (new in v2.37337.1)",
    "    // \"3459748034\": true, // gate helper with no caller found in the v4.29.0 bundle (ozr, default OFF) - effectively inert (new in v4.29.0)",
    "    // \"3484205914\": true, // built-in tool availability gate, sibling of 2300874989/1486104550 (default ON) (new in v2.7032.0)",
    "    // \"3484395999\": true, // SSH engine module gate next to the lean-reconnect switch; also a 3p remote key (new in v3.1623.0)",
    "    // \"3485864475\": true, // humbleSky - host routines (also forced by CLAUDE_E2E_HUMBLE_SKY), observed live; new humbleSky merger key (new in v2.26454.0)",
    "    // \"3491600236\": true, // bridge WebSocket network-redial watch kill-switch (new in v1.40609.0)",
    "    // \"3496370689\": true, // update-restart lost-work check for unattended sessions at any SSH-reattach record age - ON turns it off (new in v2.31226.0)",
    "    // \"3512519265\": true, // CLI force-end kill-switch on update - ON leaves still-running CLIs alone (new in v2.2553.0)",
    "    // \"3523350481\": true, // worktree index-heal kill-switch - ON disables index healing (new in v2.2553.0)",
    "    // \"3527441323\": true, // Google auth deep-link fallback timer - 60s did-become-active watchdog when claude:// is the handler (new in v1.46388.2)",
    "    // \"3531612483\": true, // side-sessions event injection (default ON; with 3025587613) (new in v1.46388.2)",
    "    // \"3531779070\": true, // agent-mode thinking-display=summarized CLI arg",
    "    // \"3538168636\": true, // SSH reattach sub-gate (default ON), sibling of 1293892711 / 2600626699 (new in v2.19675.1)",
    "    // \"3547093683\": true, // remote-tools JIT poll interval minutes, default 5, 0=off (value flag) (new in v1.28929.0)",
    "    // \"3555657854\": true, // org-scoped plugin-bridge MCP config loading",
    "    // \"3556866454\": true, // Code-tab MCP tool-set gate, sibling of 270847253 / 1341990989 / 2015900644 (default ON) (new in v2.2553.0)",
    "    // \"3558849738\": true, // Dispatch/Spaces gate",
    "    // \"3561271051\": true, // artifact permission: an unattended per-call artifact ask (artifacts_per_call_ask) escalates for the person (default ON) (new in v4.29.0)",
    "    // \"3572572142\": true, // sessions-bridge init - live listener",
    "    // \"3585327779\": true, // session title from the PR the session opened (new in v2.19675.1)",
    "    // \"3586389629\": true, // APe interval ms (value flag)",
    "    // \"3602629573\": true, // JitlessPolicy process kill-switch (live listener; feeds ProcessKillSwitchEngaged)",
    "    // \"3603781487\": true, // session-file folder suggestion kill-switch - ON returns no suggestion (new in v2.19675.1)",
    "    // \"3608536666\": true, // device-companion platform sub-gate, read through the same wrapper as 1118714395 (inert: its tV() prefix is hardcoded false) (new in v2.2553.0)",
    "    // \"3633961296\": true, // plugin enabled-state backfill",
    "    // \"3634338308\": true, // DO NOT ENABLE: ON latches Cowork local tasks OFF (coworkLocalTasksOffLatched pref, yukonSilver reports disabled_by_org_policy); peeked on every network fetch (new in v1.49585.0)",
    "    // \"3636734264\": true, // auto-continuation of interrupted turns (enabled) (default ON); 3p forced OFF (new in v3.1623.0)",
    "    // \"3640318556\": true, // remote-tools bridge WS URL: device-level /bridge vs per-session path (new in v1.32352.1)",
    "    // \"3649943861\": true, // claude:// artifact deep links - opens /artifact/<id> routes from the custom scheme (new in v2.2553.0)",
    "    // \"3650263018\": true, // ccd_session start_session / hand_off_to_session forced to always_ask in the session tool policy (default ON); also a 3p remote key (new in v3.1623.0)",
    "    // \"3656976882\": true, // skills availability gate - tracks the blocked_by_org_admin state per account (new in v2.7032.0)",
    "    // \"3664723602\": true, // Code-session BROWSER shim - routes session browser opens through the ccd-br socket (honours authentication.disableDeepLinks) (new in v2.7032.0)",
    "    // \"3675492805\": true, // Cowork EDR integration vendor list (read as an evaluated value, sibling of 580613960) (value flag); also a 3p remote key (new in v3.1623.0)",
    "    // \"3676943315\": true, // Computer Use on Linux - upstream's own Linux CU gate (status 'not yet enabled for this account' when off). Not needed: fix_computer_use_linux forces the main-process tool registration and enable_local_agent_mode forces the computerUseRollout feature claude.ai reads (new in v2.19675.1)",
    "    // \"3691521536\": true, // Stealth updater - nudge updates when no active sessions",
    "    // \"3699048477\": true, // launch-preview availability chain (ON turns it off) and browser_batch when the CLI runs on an SSH host (new since v2.37337.1)",
    "    // \"3701344212\": true, // remote control auto-enable reconcile after adoption (rcAutoEnable) kill-switch - ON skips it (new in v4.29.0)",
    "    // \"3705360580\": true, // CCD OAuth 401 refresh via readCcdOauthToken path",
    "    // \"3721849379\": true, // CCD OAuth token renew-ahead margin (default ON) (new in v2.2553.0)",
    "    // \"3723845789\": true, // Additional Cowork tools",
    "    // \"3724674924\": true, // wslForkSession feature gate - async merger override, inert on Linux (new in v1.46388.2)",
    "    // \"3728132896\": true, // [artifactPopup] artifact pop-up windows gate - a flip to OFF closes open pop-ups (new in v1.40609.0)",
    "    // \"3736295273\": true, // session path-gone handling kill-switch (pathGoneDisabled), sibling of 1885697743; also a 3p remote key (new in v2.37337.1)",
    "    // \"3758515526\": true, // official plugins repo override (value flag)",
    "    // \"3759548276\": true, // Computer Use mouse-without-activation, unless read as off (new since v2.37337.1)",
    "    // \"3764441751\": true, // rc-serve renderer heap-report gate 2 (trio with 1183214304/1410651677) (new in v1.32352.1)",
    "    // \"3778108436\": true, // plugin download zip policy - ON uses the 'plugin' zip policy instead of 'remotePlugin' (new since v2.7032.0)",
    "    // \"3778159589\": true, // Device-stale-relogin - rt('3778159589')?e():A() selecting the relogin path (markDeviceStal",
    "    // \"3778508830\": true, // parallel git checkout workers - ON uses half the cores (2..8) instead of 2..16 (new in v2.7032.0)",
    "    // \"3780509438\": true, // stop-hold tuning: stops / holdMs (false = no stops) (value flag) (new in v2.19675.1)",
    "    // \"3782147869\": true, // user-settings read host gate (userSettingsReadHost; the pair with 549725139: the gate is on unless this flag is on and 549725139 is off) (new in v4.29.0)",
    "    // \"3787437232\": true, // remote control restore at launch / after sign-in (reports flag_off when OFF), with the 4267904482 kill-switch (new in v2.31226.0)",
    "    // \"3791538283\": true, // Space memory keyless-device path - also requires fresh GrowthBook data for the current account (new in v2.2553.0)",
    "    // \"3796647113\": true, // stall-sampler gate - live listener",
    "    // \"3805388752\": true, // app-menu entry gate, observed for menu rebuild (sibling of 3046702961 / 562073731) (new in v2.37337.1)",
    "    // \"3807767338\": true, // seedPolicyLimitsIntoSession / refreshPolicyLimitsPersist - org policy-limit persistence",
    "    // \"3821473881\": true, // session announcements held until seen (default ON) (new in v3.1623.0)",
    "    // \"3832912485\": true, // browser live-preview socket discovery (default ON) (new in v2.2553.0)",
    "    // \"3835830802\": true, // teleport snapshot (isTeleportSnapshotEnabled, default ON; 3p needs claude.ai product features) (new since v2.7032.0)",
    "    // \"3868149774\": true, // launch preview user agent - ON uses the claude-hosts UA variant instead of the sites one; also a 3p remote key (new in v2.37337.1)",
    "    // \"3873310580\": true, // SSH jump-host list kill-switch (isJumpHostListKillswitchOn module); also a 3p remote key (new in v3.1623.0)",
    "    // \"3875997018\": true, // preview URL private-address classification variant; ON also turns off a preview-module guard (new in v3.1623.0)",
    "    // \"3916121268\": true, // git tracking-ref vetting kill-switch - ON skips the symbolic-ref probe (vetTrackingRef) (new in v2.37337.1)",
    "    // \"3920548810\": true, // hosted-Chrome profile availability gate (new in v1.37937.0)",
    "    // \"3922223025\": true, // UI-surface serving for host-loop (non-chat) sessions, observed live (new in v2.31226.0)",
    "    // \"3931589559\": true, // remote-bash outputs root under userData (outputs + trash) (new in v1.46388.2)",
    "    // \"3934413517\": true, // local session worktree pin kill-switch (worktreePinDisabled); also a 3p remote key (new since v2.37337.1)",
    "    // \"3943711615\": true, // remote Computer Use cross-account/org guard override - ON allows a caller from another org/account (new in v2.26454.0)",
    "    // \"3946462706\": true, // SSH transport: default to OpenSSH when CLAUDE_DESKTOP_SSH_TRANSPORT is unset (new in v1.32352.1)",
    "    // \"3949689394\": true, // Claude in Chrome canUseTool routing (cicCanUseToolEnabled) (default ON) (new in v2.26454.0)",
    "    // \"3950286855\": true, // SSH fork: ON skips the host managed-mcp.json probe (forks keep --strict-mcp-config); also a 3p remote key (new since v2.37337.1)",
    "    // \"3958333548\": true, // in-app browser reuse for a path that is not a live session (default ON) (new in v2.2553.0)",
    "    // \"3961433847\": true, // local MCP server manager gate 2, sibling of 3018088575 (new in v1.32352.1)",
    "    // \"3963759544\": true, // remote plugin sync: shared-plugin cache reads and quick-sync-when-empty skip (new since v2.37337.1)",
    "    // \"3974406784\": true, // SSH allowlist read from remote managed settings kill-switch (isSshAllowlistReadingKillswitchOn) (new in v2.26454.0)",
    "    // \"3975508727\": true, // selects between two prompt-text variants in Code session setup (default ON) (new in v3.1623.0)",
    "    // \"3976799455\": true, // away-recap generation (maybeGenerateAwayRecap)",
    "    // \"3977864451\": true, // agent-emulated viewport reset at turn end (default ON) (new in v2.2553.0)",
    "    // \"3982397363\": true, // stale-model-clear robustness toggle",
    "    // \"3990395613\": true, // branch-deltas feature co-gate (new in v1.26832.0)",
    "    // \"4005099505\": true, // quit/restart prompt: ON drops the separate sessions-with-shells count (new in v3.1623.0)",
    "    // \"4012727013\": true, // plugin path normalization skip (kill-switch) (new since v2.37337.1)",
    "    // \"4018447017\": true, // skill folder mount/upload path gate (per-skill file and byte budget) (new in v2.7032.0)",
    "    // \"4034153053\": true, // isEpitaxyPreviewEnabled (gated on native support probe)",
    "    // \"4036648294\": true, // ccdConnectorTools async merger override - 1p only, not 3p (default ON) (new in v2.2553.0)",
    "    // \"4039294468\": true, // plugin backfill module gate - sibling of 2294160313 (new in v1.46388.2)",
    "    // \"4041267332\": true, // CLI job-cleanup idle timeout ms - default 900000, 0 = off except unattended (value flag) (new in v1.46388.2)",
    "    // \"4044603026\": true, // terminal shell integration (new in v1.46388.2)",
    "    // \"4055864154\": true, // PowerShell on Windows SSH hosts kill-switch - ON drops pwshAllowed (was a 3p remote key only) (new in v2.31226.0)",
    "    // \"4061344840\": true, // session file outside-folder actions kill-switch - ON returns canReveal only and hides the ask-to-read action (new in v4.29.0)",
    "    // \"4066504968\": true, // guided Cowork setup skill description (value flag)",
    "    // \"4074604942\": true, // 1p direct MCP pool gate (pool stays null when OFF)",
    "    // \"4082309721\": true, // git worktree warm-up sub-gate, sibling of 3000061192/630659907 (new in v2.7032.0)",
    "    // \"4092838515\": true, // storage MCP tools - get_storage_usage and the 30/60/90-day inactive-worktree cleanup (default ON) (new in v2.2553.0)",
    "    // \"4100354330\": true, // session link-classification kill-switch - ON disables it (new in v2.2553.0)",
    "    // \"4111642677\": true, // app-menu: Ctrl+Tab / Ctrl+Shift+Tab session switching shortcuts (default ON); also an app-menu rebuild observer (new in v4.29.0)",
    "    // \"4113347374\": true, // SSH engine selection input, observed with 3946462706 / 291584251 to re-send SSH session records (new in v2.37337.1)",
    "    // \"4116586025\": true, // louderPenguin / Code tab master gate",
    "    // \"4122449738\": true, // held-after-error send queue kill-switch (new since v2.37337.1)",
    "    // \"4124451570\": true, // 3p setup: Claude API sign-in allowed for the Anthropic provider (apiSignInAllowed), observed (new in v3.1623.0)",
    "    // \"4141490266\": true, // Framebuffer system prompt injection - adds instructions when Framebuffer server active",
    "    // \"4153934152\": true, // CLAUDE_CODE_SKIP_PRECOMPACT_LOAD",
    "    // \"4156472024\": true, // folder-access plainly-visible-path requirement suppressor (new in v1.37937.0)",
    "    // \"4156848874\": true, // CLI binary-killed-at-exec invalidation kill-switch - ON skips the invalidation (new in v2.19675.1)",
    "    // \"4160352601\": true, // VM heartbeat monitoring",
    "    // \"4162776501\": true, // rapid follow-up preemption for pending turns (default ON) (new in v2.19675.1)",
    "    // \"4175551826\": true, // device-id cookie source for session-key auth (default ON) (new since v2.7032.0)",
    "    // \"4175783504\": true, // cowork auto permission mode kill-switch - ON stops offering auto mode (new in v2.19675.1)",
    "    // \"4185841952\": true, // work-session group summary config (model/maxTokens; value flag) (new in v1.26832.0)",
    "    // \"4192108451\": true, // shadow-git sync writes to the .claude/.cc-writes staging dir: ON writes the files atomically; OFF takes the exclusive-write path (new in v4.29.0)",
    "    // \"4200321681\": true, // coworkAutoModeAlwaysAllowOverride - async merger override + scheduled-task auto-approve permission routing",
    "    // \"4202409342\": true, // tool gate checked with mdmAutoModeDisabled (gateEnabled telemetry) (new in v1.26832.0)",
    "    // \"4234590394\": true, // SSH sessions: withhold laptop MCP servers when the host has Claude Code's managed-mcp.json; also a 3p remote key (new in v3.1623.0)",
    "    // \"4237076858\": true, // spare session prewarm (1p only, not in the sandbox VM) (new in v2.19675.1)",
    "    // \"4255248502\": true, // Code start-target prewarm kill-switch (ccdStartTargets); also a 3p remote key (new since v2.37337.1)",
    "    // \"4255448834\": true, // code project deep link - ON hands claude:// project links to the fallback route (new in v2.2553.0)",
    "    // \"4258078265\": true, // built-in file viewers per extension, {ext: true} map, only without the hardcoded GrowthBook set (value flag) (new in v3.1623.0)",
    "    // \"4261020843\": true, // plugin hooks.json lenient parsing - malformed entries are skipped instead of rejecting the file (default ON) (new in v2.31226.0)",
    "    // \"4267385443\": true, // git hooksPath / worktreeConfig memo kill switch - ON re-runs the git config writes every time (new in v2.7032.0)",
    "    // \"4267904482\": true, // remote control switched_off override - ON stops the rc-serve start even when allowed (new in v2.26454.0)",
    "    // \"4274920779\": true, // sets CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST=1 in the Code CLI env unless 3p, autoUpdate is disabled or the user env already disables updates (default ON) (new in v2.31226.0)",
    "    // \"4276454100\": true, // remote control failed-link-process tracking (failedLinkProcess) kill-switch (new in v2.31226.0)",
    "    // \"4279816466\": true, // media permission requests carry securityOrigin / mediaTypes into the check (default ON) (new in v2.2553.0)",
    "    // \"4282876673\": true, // async module gate (default ON)",
    "    // \"4286026368\": true, // shadow-git fetch-refspec check kill-switch - ON skips the check (new in v2.2553.0)",
    "    // \"4288313598\": true, // CLI version-gated capability (default ON), sibling of 1835121223 / 2153038254 (new since v2.7032.0)",
    "    // \"4293378213\": true, // device-app tools - INERT in v1.20186.1 (hardcoded off after the flag)",
    "  }",
    "}",
    ""
  ].join("\n");

  // The TEMPLATE above is the catalog: one commented-out line per flag observed
  // being read from the feature store, with a human note after it. Parsing it
  // rather than keeping a second copy means the .jsonc template and the Extra
  // settings page can never disagree about which flags exist.
  var CATALOG_RE = /^\s*\/\/\s*"(\d+)"\s*:\s*[^,]*,\s*\/\/\s*(.*)$/;
  var CATALOG_EXPECTED = 672;

  function flagCatalog() {
    if (catalogCache) return catalogCache;
    var out = [];
    var lines = TEMPLATE.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(CATALOG_RE);
      if (!m) continue;
      var note = m[2].replace(/\s+$/, "");
      out.push({
        id: m[1],
        note: note,
        // "(value flag)" carries a number/string/object: a bare true would be
        // meaningless, so the UI renders these read-only.
        valueFlag: note.indexOf("(value flag") >= 0,
        // Non-empty = never offer this as an ordinary toggle.
        warn: /^DO NOT ENABLE/.test(note) ? note : ""
      });
    }
    if (out.length !== CATALOG_EXPECTED) {
      diag("[cdb-flags] flag catalog parsed " + out.length + " entries, expected " +
        CATALOG_EXPECTED + " - the .jsonc template drifted; update CATALOG_EXPECTED in js/growthbook_overrides.js");
    }
    catalogCache = out;
    return out;
  }

  function readFileOrNull(fs, p) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch (e) {
      if (e && e.code !== "ENOENT") diag("[cdb-flags] cannot read " + p + ": " + (e && e.message));
      return null;
    }
  }

  function parseOverrides(raw, p) {
    if (raw === null) return null;
    try {
      var cfg = JSON.parse(stripJsonComments(raw));
      var o = cfg && cfg.growthbookOverrides;
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
      if (o !== undefined && o !== null) diag("[cdb-flags] growthbookOverrides in " + p + " must be an object - ignoring");
      return null;
    } catch (e) {
      diag("[cdb-flags] failed to parse " + p + ": " + (e && e.message) + " - ignored");
      return null;
    }
  }

  function readOverrides() {
    var fs = require("fs");
    var paths = configPaths();
    var rawJ = readFileOrNull(fs, paths.json);
    var rawC = readFileOrNull(fs, paths.jsonc);
    if (rawC === null) {
      try {
        fs.writeFileSync(paths.jsonc, TEMPLATE, { flag: "wx" });
        diag("[cdb-flags] created config template at " + paths.jsonc);
      } catch (e2) {}
    }
    var combined = String(rawJ) + "\0" + String(rawC);
    if (combined === lastRaw) return lastParsed;
    lastRaw = combined;
    var oJ = parseOverrides(rawJ, paths.json);
    var oC = parseOverrides(rawC, paths.jsonc);
    if (!oJ && !oC) { lastParsed = null; return null; }
    var merged = {};
    var k;
    for (k in (oJ || {})) merged[k] = oJ[k];
    for (k in (oC || {})) merged[k] = oC[k];
    lastParsed = merged;
    return merged;
  }

  // Built-in platform forces applied at the STORE level (not just the read site),
  // so the features-store setter sees them as "changed" and fires its
  // onFeatureChange listeners. This is load-bearing for flags whose feature is
  // wired up via onFeatureChange rather than a plain isFeatureEnabled read:
  //   2358734848 (Hardware Buddy / BLE): the Buddy module arms its BLE transport
  //   (registers the select-bluetooth-device handler, sets the internal
  //   "installed" flag so scanDevices actually scans) only from an
  //   onFeatureChange("2358734848", n=>n?.on && ...) callback. Forcing the flag
  //   only at the read site makes the UI appear but never fires that callback,
  //   so the transport is never armed and the in-app scan silently returns [].
  //   Linux is outside Anthropic's rollout, so the store value stays off there;
  //   we set it on. Idle when no device is present (the auto-reconnect loop gates
  //   on a paired-device preference), so this is safe for all Linux users.
  // A user override in claude-desktop-extra.jsonc still wins (readOverrides is
  // merged AFTER these), so "2358734848": false opts back out.
  function builtinForces() {
    var out = {};
    try {
      if (typeof process !== "undefined" && process.platform === "linux") {
        out["2358734848"] = true;
      }
    } catch (e) {}
    return out;
  }

  // Called by the patched features-store setter with the freshly loaded feature
  // map (network / disk cache / deployment-mode). Returns a shallow copy with
  // overrides applied so the caller's raw object (used for the disk cache)
  // stays untouched. Must never throw - flag loading is boot-critical.
  globalThis.__cdbApplyGbOverrides = function (features) {
    try {
      var o = {};
      var bf = builtinForces();
      var uk;
      for (uk in bf) o[uk] = bf[uk];
      var uo = readOverrides();
      for (uk in (uo || {})) o[uk] = uo[uk]; // user override wins over built-in
      if (!features || typeof features !== "object") return features;
      // Snapshot the untouched server/cache map before anything is applied, so
      // the Extra settings page can tell "on for your account" apart from "on
      // because you overrode it".
      lastServer = {};
      for (var sk in features) lastServer[sk] = features[sk];
      var ids = Object.keys(o);
      if (!ids.length) { lastEffective = lastServer; return features; }
      var out = {};
      for (var k in features) out[k] = features[k];
      var applied = [];
      for (var j = 0; j < ids.length; j++) {
        var id = ids[j];
        var v = o[id];
        if (v === null || v === undefined) continue;
        out[id] = typeof v === "boolean"
          ? { on: v, value: v, source: "cdb-override" }
          : { on: true, value: v, source: "cdb-override" };
        applied.push(id + "=" + JSON.stringify(v));
      }
      if (applied.length) {
        var msg = "[cdb-flags] applying " + applied.length + " GrowthBook override(s): " + applied.join(", ");
        if (msg !== announced) { announced = msg; diag(msg); }
      }
      lastEffective = out;
      return out;
    } catch (e) {
      diag("[cdb-flags] override hook error: " + (e && e.message));
      return features;
    }
  };

  // Read lazily by patches/add_feature_extra_settings.nim (which runs BEFORE
  // this IIFE's siblings, hence functions rather than values).
  globalThis.__cdbGbFlags = {
    version: 1,
    catalog: flagCatalog,
    server: function () { return lastServer; },
    effective: function () { return lastEffective; },
    overrides: readOverrides,
    builtins: builtinForces,
    configPath: configPaths
  };
})();

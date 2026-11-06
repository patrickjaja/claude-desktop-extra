#!/usr/bin/env node
/*
 * test-extra-settings-bridge.mjs - js/extra_settings_bridge.js is the only
 * channel between the remote page and the Extra settings handlers, and it
 * re-shapes every argument. A field the panel sends that the bridge drops is
 * a silent no-op in the app (the model form's context never reached main
 * before this test existed). Loads the bridge with a recording ipcRenderer.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

const calls = [];
let exposed = null;
const sandbox = {
  require: (m) => {
    if (m !== "electron") throw new Error("unexpected require " + m);
    return {
      contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api }; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } }
    };
  },
  console
};
vm.runInNewContext(readFileSync(join(ROOT, "js/extra_settings_bridge.js"), "utf8"), vm.createContext(sandbox));
ok(exposed && exposed.name === "cdbExtra", "the bridge exposes cdbExtra");
const api = exposed.api;

calls.length = 0;
api.sessionStartAlwaysAllowRead(); api.sessionStartAlwaysAllowSet("yes"); api.sessionStartAlwaysAllowSet(true); api.sessionStartAlwaysAllowForget();
ok(JSON.stringify(calls) === '[["cdb-session-start:read"],["cdb-session-start:set",false],["cdb-session-start:set",true],["cdb-session-start:revoke"]]',
   "session-start dialog switch: read, boolean-coerced set and forget through fixed channels only");
ok(Object.keys(api).filter(function (k) { return /^sessionStart/.test(k); }).sort().join(",") ===
   "sessionStartAlwaysAllowForget,sessionStartAlwaysAllowRead,sessionStartAlwaysAllowSet",
   "no bridge call can add a remembered session-start approval");

calls.length = 0;
api.autoFixAuthorRead(); api.autoFixAuthorSet(["github.com/my-app[bot]"]); api.autoFixAuthorSet(true);
ok(calls.map(c => c[0]).join(" ") === "cdb-autofix-author:read cdb-autofix-author:set cdb-autofix-author:set", "trusted-author editor uses fixed channels");
ok(calls[1][1][0] === "github.com/my-app[bot]" && calls[2][1] === null, "bridge forwards a list, never translates the legacy boolean into trust");

// --- custom models: every field the panel sends must reach the channel ---------
{
  calls.length = 0;
  api.customModelsModelSet("deepseek", { id: "deepseek-flash", name: "DeepSeek Flash", description: "d", badge: "b",
    thinking: false, vision: false, webSearch: false, context: "both", effortDefault: "low" });
  const [ch, pid, m] = calls[0];
  ok(ch === "cdb-cm:model-set" && pid === "deepseek", "model-set goes to its fixed channel with the provider id");
  ok(m.id === "deepseek-flash" && m.name === "DeepSeek Flash" && m.description === "d" && m.badge === "b" &&
     m.thinking === false && m.vision === false && m.webSearch === false && m.context === "both" && m.effortDefault === "low",
     "every model field is forwarded, context included: " + JSON.stringify(m));
  calls.length = 0;
  api.customModelsModelSet("ds", { id: "x" });
  ok(calls[0][2].context === "" && calls[0][2].thinking === true && calls[0][2].vision === true && calls[0][2].webSearch === true,
     "absent fields become their neutral values (empty context = the provider's)");
  calls.length = 0;
  api.customModelsModelSet("ds", "not an object");
  ok(JSON.stringify(calls[0][2]) === "{}", "a non-object model is sent as {} for main to refuse");
}
{
  calls.length = 0;
  api.customModelsProviderSet({ id: "openrouter", baseUrl: "https://openrouter.ai/api", apiKey: "sk-x", preset: "openrouter",
    modelsUrl: "https://openrouter.ai/api/v1/models", effort: ["low", "max"], secret: "ignored" });
  const p = calls[0][1]; // provider-set takes the provider object as its only argument
  ok(calls[0][0] === "cdb-cm:provider-set" && p.id === "openrouter" && p.apiKey === "sk-x" && p.preset === "openrouter" &&
     p.modelsUrl === "https://openrouter.ai/api/v1/models" && p.effort.join(",") === "low,max" && !("secret" in p),
     "provider-set forwards its fields and nothing else");
  ok(p.userAgent === undefined && p.stripBillingHeader === undefined, "provider-set leaves out userAgent and stripBillingHeader when the page does not send them");
}
{
  calls.length = 0;
  api.customModelsProviderSet({ id: "openrouter", baseUrl: "https://openrouter.ai/api", apiKey: "", userAgent: "MyAgent/1.0", stripBillingHeader: true });
  const p = calls[0][1];
  ok(p.userAgent === "MyAgent/1.0" && p.stripBillingHeader === true, "provider-set forwards userAgent and stripBillingHeader");
  calls.length = 0;
  api.customModelsProviderSet({ id: "openrouter", baseUrl: "https://openrouter.ai/api", apiKey: "", userAgent: "", stripBillingHeader: "yes" });
  ok(calls[0][1].userAgent === "" && calls[0][1].stripBillingHeader === undefined, "an empty userAgent goes (it clears); a non-boolean switch does not");
}
{
  calls.length = 0;
  api.customModelsWebSearchSet(null); api.customModelsSmallFastSet("deepseek-flash");
  api.customModelsProviderDelete("gw"); api.customModelsModelDelete("gw", "m");
  api.customModelsTest("gw"); api.customModelsModelsList("gw"); api.customModelsEffortProbe("gw", "m");
  ok(calls.map((c) => c[0]).join(" ") === "cdb-cm:websearch-set cdb-cm:smallfast-set cdb-cm:provider-delete cdb-cm:model-delete cdb-cm:provider-test cdb-cm:models-list cdb-cm:effort-probe",
     "the other custom-models methods hit their fixed channels");
  ok(calls[0][1] === "" && calls[1][1] === "deepseek-flash" && calls[3][1] === "gw" && calls[3][2] === "m", "arguments are stringified");
}
{
  calls.length = 0;
  api.customModelsSubagentSet(undefined); api.customModelsAnnounceSet("yes");
  api.customModelsModelSet("ds", { id: "m", agent: false, agentName: 12, agentDescription: null, agentPrompt: "p", extra: 1 });
  ok(calls.map((c) => c[0]).join(" ") === "cdb-cm:subagent-set cdb-cm:announce-set cdb-cm:model-set", "the sub-agent methods hit their fixed channels");
  ok(calls[0][1] === "" && calls[1][1] === false, "subagent-set stringifies, announce-set is true only for true");
  const m = calls[2][2];
  ok(m.agent === false && m.agentName === "12" && m.agentDescription === "" && m.agentPrompt === "p" && !("extra" in m),
     "model-set forwards the sub-agent fields as strings and a boolean, nothing else");
}
{
  calls.length = 0;
  api.autoFixMergeReadyRead(); api.autoFixMergeReadySet("yes"); api.autoFixMergeReadySet(true);
  ok(JSON.stringify(calls) === '[["cdb-autofix-merge-ready:read"],["cdb-autofix-merge-ready:set",false],["cdb-autofix-merge-ready:set",true]]',
     "the Auto-fix ready-to-merge methods hit their fixed channels with a boolean only: " + JSON.stringify(calls));
}
{
  // Cowork (Linux): KVM access, the header icon's facts and the settings deep
  // link. Fixed channels, and every page argument is dropped.
  calls.length = 0;
  api.cuStatusKvmEnable("/bin/sh", "-c", "id"); api.cuStatusKvmDisable("x"); api.cuStatusIcon({ a: 1 }); api.extraOpenSettings("/settings/../admin");
  ok(JSON.stringify(calls) === '[["cdb-cu-status:kvm-enable"],["cdb-cu-status:kvm-disable"],["cdb-cu-status:icon"],["cdb-extra:open-settings"]]',
     "KVM access, icon and open-settings hit their fixed channels with no argument: " + JSON.stringify(calls));
}
ok(typeof api.invoke !== "function" && typeof api.send !== "function", "no generic passthrough to arbitrary channels");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

---
name: debug
description: Debug a problem in claude-desktop-extra by pulling the right local evidence - the most recent local-agent-mode session transcript (your last prompt + the model's tool calls/errors) and the Claude Desktop logs - and asking you for anything else worth collecting for the specific issue. Invoke as "/debug <short description of what's broken>".
disable-model-invocation: true
argument-hint: "<what is broken>"
---

# Debug - collect evidence, then diagnose

The issue to debug: **$ARGUMENTS**

You are debugging the patched Claude Desktop. Cowork runs on the `.deb`'s bundled native VM backend (the old `claude-cowork-service` daemon is deprecated). Gather the relevant local evidence below (skip what's clearly irrelevant to "$ARGUMENTS"), form a hypothesis, then ask the user for anything you can't collect yourself. Read `/architecture` for how the pieces fit and `/linux` for session/CU specifics if relevant.

## 0. Resolve the config/log dir FIRST (1p vs 3p) - or you read stale evidence
The runtime dir is **conditional**: 3P mode relocates everything to `~/.config/Claude-3p/`. 3P is active when an
`inferenceProvider` is configured - via `/etc/claude-desktop/managed-settings.json`, Settings -> Extra -> Deployment,
or `--3p`. The `/etc` file merely existing (e.g. only `managedMcpServers`) stays 1P. Resolve once, use `$CFG` below.
```bash
# 1. a running named profile passes its dir explicitly (match the app binary, not shells quoting this text)
CFG=
for p in $(pgrep -f -- '--user-data-dir='); do
  readlink "/proc/$p/exe" 2>/dev/null | grep -q claude-desktop || continue
  CFG=$(tr '\0' '\n' < "/proc/$p/cmdline" | sed -n 's/^--user-data-dir=//p' | head -1); break
done
# 2. else: policy-file provider, or the 3P dir's main.log is the fresher one (Deployment panel / --3p)
if [ -z "$CFG" ]; then
  if grep -qs '"inferenceProvider"' /etc/claude-desktop/managed-settings.json \
     || [ ~/.config/Claude-3p/logs/main.log -nt ~/.config/Claude/logs/main.log ]; then
    CFG=~/.config/Claude-3p; else CFG=~/.config/Claude; fi
fi
grep -a '3P mode active' "$CFG/logs/main.log" | tail -1   # confirms 3P when CFG is Claude-3p
echo "using CFG=$CFG"
```

## 1. Last local-agent-mode session transcript (the single source of truth for Cowork/Dispatch/agent runs)
`audit.jsonl` records exactly what the model saw and did. Find the newest one and read **the user's last prompt + the assistant tool calls + any errors**:
```bash
AUDIT=$(find "$CFG"/local-agent-mode-sessions -name audit.jsonl -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2)
echo "newest audit: $AUDIT"
python3 -c "
import json,sys
p='$AUDIT'
if not p: sys.exit('no audit.jsonl found')
rows=[json.loads(l) for l in open(p) if l.strip()]
# user's first/last prompt
users=[r for r in rows if r.get('type')=='user']
def text(m):
    c=(m or {}).get('content')
    if isinstance(c,str): return c
    if isinstance(c,list): return ' '.join(x.get('text','') for x in c if isinstance(x,dict))
    return str(c)
if users: print('FIRST USER PROMPT:', text(users[0].get('message'))[:500])
if len(users)>1: print('LAST USER PROMPT:', text(users[-1].get('message'))[:500])
# tool calls + errors
for i,r in enumerate(rows):
    t=r.get('type')
    if t=='assistant':
        for c in (r.get('message',{}).get('content') or []):
            if isinstance(c,dict) and c.get('type')=='tool_use': print(f'[{i}] tool_use: {c.get(\"name\")} {str(c.get(\"input\",{}))[:120]}')
    elif t=='user' and ('Error' in str(r) or 'Permission' in str(r) or 'denied' in str(r)):
        print(f'[{i}] error/result: {str(r)[:200]}')
    elif t=='result': print(f'[{i}] RESULT: {str(r.get(\"result\",r))[:200]}')
"
```
If "$ARGUMENTS" is about dispatch/cowork/skills not working, this transcript usually shows the failing tool call, a permission denial, or a wrong path.

Which tools the CLI actually exposed to the model (a missing `SendUserMessage` / `present_files` / `send_message` explains "response never rendered"):
```bash
python3 -c "
import json
for l in open('$AUDIT'):
    d=json.loads(l)
    if d.get('tools') and len(d['tools'])>10:
        names=[t if isinstance(t,str) else t.get('name','?') for t in d['tools']]
        print(f'Tools ({len(names)}):', names)
        for t in ['SendUserMessage','present_files','send_message']:
            print(' ',t,[n for n in names if t in n] or 'MISSING')
        break
"
```
**Key insight:** `audit.jsonl` is what the model saw and did; `main.log` is how the bridge processed the model's output. Check both.

## 2. Claude Desktop logs (whatever exists - globbed, not hardcoded)
```bash
ls -la "$CFG"/logs/ 2>/dev/null
rg -i -a 'error|exception|fatal|denied|ENOENT|EACCES' "$CFG"/logs/ 2>/dev/null | tail -40
```
Known logs (presence varies): `main.log` (Electron main), `cowork_vm_node.log` (Cowork sessions), `mcp.log` + `mcp-server-*.log`, `claude.ai-web.log` (BrowserView), plus others like `ssh.log`, `unknown-window.log`. Tail the one(s) relevant to "$ARGUMENTS". Also check crash reports: `ls -la "$CFG"/crash* 2>/dev/null`. (`$CFG` resolved in step 0 - `Claude-3p` under managed-settings.json, else `Claude`.)

### Dispatch-specific (if relevant)
```bash
grep -a 'DISPATCH-FWD.*PASSING\|DISPATCH-TRANSFORM\|DISPATCH-WRITE' "$CFG"/logs/main.log | tail -20
grep -a 'Permission.*denied' "$CFG"/logs/main.log | tail -10
```

## 3. Cowork backend (if Cowork/Dispatch is implicated)
Cowork runs on the `.deb`'s bundled native VM backend (cowork-linux-helper + virtiofsd + smol-bin + QEMU/OVMF; requires `/dev/kvm`). The old `claude-cowork-service` Go daemon is deprecated - there is no separate socket/systemd unit to poke. The backend's Electron-side lifecycle log is `cowork_vm_node.log`:
```bash
grep -a 'Using Claude VM spawn\|Spawn succeeded\|vmStarted\|disallowedTools\|virtualization_not_available' \
  "$CFG"/logs/cowork_vm_node.log 2>/dev/null | tail -20
```
If Cowork won't start, confirm the host has `/dev/kvm` + `/dev/vhost-vsock` (the backend hard-requires both).

## 4. Ask the user for what you can't collect
Based on "$ARGUMENTS", use `AskUserQuestion` to request anything missing - only ask for what the task actually needs. Examples to consider:
- Exact repro steps + which feature (Chat/Code/Cowork/Dispatch/Computer Use/3P/Quick Entry).
- Session/distro: output of `claude-desktop --diagnose` and the `[claude-cu] diagnostics:` lines from terminal (for Computer Use / Wayland issues).
- Whether to reproduce the issue now while tailing `cowork_vm_node.log` (step 3).
- A screenshot / the exact error text shown in the UI.
- For stale-state bugs: permission to clear `"$CFG"/local-agent-mode-sessions/` (the model can otherwise "remember" past errors; `$CFG` as resolved in step 0).

## 5. Diagnose
State the hypothesis grounded in the evidence (cite the log line / audit record / file:line). If it's a patch/upstream issue, point at the patch and suggest `/fresh-upstream` + `/update`. Propose the fix; apply only if the user asks. Cross-reference memory (`~/.claude/projects/-home-patrickjaja-development-claude-desktop-extra/memory/`, e.g. dispatch-linux-debug, cowork-crash-debug) for prior findings before concluding.

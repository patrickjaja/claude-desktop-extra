import { execFile as execFileCb, spawnSync } from 'node:child_process'
import { screen as electronScreen } from 'electron'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

const DEFAULT_HOST_BUNDLE_ID = 'com.anthropic.claude'

// execFile budgets for kwin-portal-bridge. Each sits above the bridge's own
// bound for that command, so a stuck daemon surfaces as the bridge's error
// (which names its daemon.log) and the kill here is only the backstop; the
// values match the GNOME executor (js/cu_linux_executor.js).
//   session-start  bridge waits up to 120 s for the consent dialog
//   portal         daemon-proxied commands; bridge client budget 25 s
//   local          KWin D-Bus / desktop-file commands, no portal involved
//   session-end    bridge reaps a silent daemon within ~4 s
// type and hold-key take time by design and get it on top (the bridge adds
// the same: per character its delay plus TYPE_PER_CHAR_ALLOWANCE_MS).
// teach-step and teach-wait-event block until the user acts in the overlay,
// so they have no timeout.
const KWIN_SESSION_START_MS = 125000
const KWIN_PORTAL_MS = 30000
const KWIN_LOCAL_MS = 15000
const KWIN_SESSION_END_MS = 15000
const KWIN_EXIT_SESSION_END_MS = 5000
const KWIN_TYPE_DEFAULT_DELAY_MS = 12
const TYPE_PER_CHAR_ALLOWANCE_MS = 5
const KWIN_PORTAL_COMMANDS = new Set([
  'pointer-move', 'pointer-click', 'pointer-scroll', 'pointer-drag',
  'left-mouse-down', 'left-mouse-up', 'key-sequence', 'type', 'hold-key',
  'read-clipboard', 'write-clipboard', 'screenshot', 'zoom',
  'set-overlay-display',
])
const KWIN_UNBOUNDED_COMMANDS = new Set(['teach-step', 'teach-wait-event'])

function bridgeTimeoutMs(command) {
  if (command === 'session-start') return KWIN_SESSION_START_MS
  if (command === 'session-end') return KWIN_SESSION_END_MS
  if (KWIN_UNBOUNDED_COMMANDS.has(command)) return 0
  if (KWIN_PORTAL_COMMANDS.has(command)) return KWIN_PORTAL_MS
  return KWIN_LOCAL_MS
}

function typeTimeoutMs(text, delayMs) {
  const delay = typeof delayMs === 'number' && Number.isFinite(delayMs)
    ? Math.max(0, Math.round(delayMs))
    : KWIN_TYPE_DEFAULT_DELAY_MS
  return KWIN_PORTAL_MS + [...String(text)].length * (delay + TYPE_PER_CHAR_ALLOWANCE_MS)
}

const LINUX_CU_CAPABILITIES = {
  screenshotFiltering: 'native',
  platform: 'linux',
}

let sessionReadyPromise = null
let sessionStopPromise = null
let bridgeSessionActive = false
let exitHookInstalled = false
// True from the first session-start until a session-end succeeds: a
// session-start that failed or timed out can still leave a daemon waiting on
// its consent dialog, which only a session-end removes.
let bridgeDaemonMayExist = false
// The user stopped screen sharing (bridge exit 5). Every later bridge action
// fails fast with STOPPED_BY_USER_MESSAGE and no session is started again
// until the latch clears: on a task boundary (__cuTaskBoundary), after
// CU_PORTAL_IDLE_MS without a bridge command, when the lock is released, or
// when a new lock starts. The session-end sent on the way removes the
// bridge's stopped-by-user marker.
let stoppedByUser = false
// The bridge session ends after this long without a bridge input/capture
// command, with the lock still held (upstream can hold the CU lock across
// tasks for up to 12 min). The next command starts a new session (dialog-free
// with the portal's restore token). The same timer lifts the stop latch.
const CU_PORTAL_IDLE_MS = 120000
let idleTimer = null
// The idle end never runs while one of these is true; it re-arms instead.
let portalCommandsInFlight = 0
let sessionStartInFlight = false
// left-mouse-down without a left-mouse-up attempt. hold-key is a single bridge
// command for its whole duration, so portalCommandsInFlight covers it.
let mouseButtonHeld = false
// A held button defers the idle end once: a second consecutive expiry with no
// command in between ends the session anyway (maintainer ruling 2026-10-26).
let idleHeldDeferred = false
// set-overlay-display is daemon state: a session started after an idle or
// task-boundary end (or a vanished daemon) has lost it. The executor installs
// the re-apply (it knows the last display); a lock acquire sets it itself.
let overlayNeedsReapply = false
let reapplySessionOverlay = null
// Bridge commands that run in the session daemon: they need the session, count
// as activity for the idle timer, and block the idle end while in flight
// (teach-wait-event blocks until the user acts in the overlay).
const KWIN_SESSION_COMMANDS = new Set([
  ...KWIN_PORTAL_COMMANDS,
  'teach-step', 'teach-working', 'teach-hide', 'teach-display', 'teach-wait-event',
])
const legacyDisplayIdToElectronDisplayId = new Map()

const SYNTHETIC_INSTALLED_APPS = [
  {
    bundleId: 'plasmashell',
    displayName: 'Plasma Shell',
    path: '__synthetic__/plasmashell',
  },
]

const PLASMA_SHELL_BUNDLE_IDS = ['plasmashell', 'org.kde.plasmashell']

function debugLog(message, details) {
  if (details === undefined) {
    console.debug(`[linux-executor] ${message}`)
    return
  }
  console.debug(`[linux-executor] ${message}`, details)
}

function expandAllowedBundleIds(bundleIds) {
  const expanded = new Set(bundleIds || [])
  if (PLASMA_SHELL_BUNDLE_IDS.some(bundleId => expanded.has(bundleId))) {
    for (const bundleId of PLASMA_SHELL_BUNDLE_IDS) {
      expanded.add(bundleId)
    }
  }
  return [...expanded]
}

function buildBridgeCommand(command, args) {
  const bin = process.env.KWIN_PORTAL_BRIDGE_BIN
    || globalThis.__cuKwinBridgeBin
    || 'kwin-portal-bridge'
  const spec = {
    command: bin,
    args: [command, ...args],
  }
  debugLog('bridge command prepared', spec)
  return spec
}

function roundedRect(rect) {
  return {
    x: Math.round(rect?.x ?? 0),
    y: Math.round(rect?.y ?? 0),
    width: Math.round(rect?.width ?? 0),
    height: Math.round(rect?.height ?? 0),
  }
}

function rectsEqual(a, b) {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  )
}

function electronDisplayForRustScreen(screen) {
  const rustGeometry = roundedRect(screen?.geometry)
  const displays = electronScreen.getAllDisplays()
  const exact = displays.find(display =>
    rectsEqual(roundedRect(display.bounds), rustGeometry),
  )
  if (exact) return exact

  try {
    return electronScreen.getDisplayNearestPoint({
      x: rustGeometry.x + Math.max(0, Math.floor(rustGeometry.width / 2)),
      y: rustGeometry.y + Math.max(0, Math.floor(rustGeometry.height / 2)),
    })
  } catch {
    return null
  }
}

function rememberDisplayIdMappings(displays) {
  for (const display of displays) {
    if (
      typeof display?._legacyDisplayId === 'number' &&
      typeof display?.displayId === 'number'
    ) {
      legacyDisplayIdToElectronDisplayId.set(
        display._legacyDisplayId,
        display.displayId,
      )
    }
  }
}

// Bridge CLI contract exit codes (docs/computer-use-bridge-contract.md):
// 3 = the target monitor is not shared in the live portal session, 4 = no live
// session (the session daemon is gone), 5 = the user stopped screen sharing
// (the portal session was closed from the desktop's screen-sharing indicator).
// Consumers switch on these; the text matching is only the fallback for
// bridges below contract 1.
const BRIDGE_EXIT_NOT_SHARED = 3
const BRIDGE_EXIT_NO_SESSION = 4
const BRIDGE_EXIT_STOPPED_BY_USER = 5

// What the model reads after the user stopped screen sharing. Twin:
// _CU_STOPPED_BY_USER_MSG in js/cu_linux_executor.js.
// Upstream can keep the CU lock across tasks (cloud Cowork, guided tours), so
// the latch does not wait for the lock: it lifts on the task boundary or after
// CU_PORTAL_IDLE_MS without Computer Use actions (refused actions do not count,
// so a retrying model cannot keep the block alive). Teach mode ending is NOT a
// clear signal here: a stop during a tour fails the step, which itself ends
// teach mode, and restarting there would re-share the screen behind the user.
export const STOPPED_BY_USER_MESSAGE = "Screen sharing was stopped from the desktop (its screen-sharing indicator, or the desktop ended the session). Stop using Computer Use and ask the user whether to continue; do not retry. Computer Use can share the screen again once the task ends or after about 2 minutes without Computer Use actions."

function stoppedByUserError() {
  const error = new Error(STOPPED_BY_USER_MESSAGE)
  error.__cdbStoppedByUser = true
  return error
}

// A bridge error about a monitor the user did not share in the portal consent
// dialog. Contract-1 bridges exit 3 with "monitor <ID> (<geometry>) is not
// shared in the portal session (shared: <list>)"; older kwin-portal-bridge
// builds said "no portal stream matched screen `<id>`". Users only have
// `claude-desktop`, and this text is what the model reads: rewrite it into an
// instruction for the user. Text that does not parse keeps its wording and gets
// the instruction appended - always on exit 3, otherwise when it names the
// condition. Twin: _cuNotSharedText in js/cu_linux_executor.js.
const RESET_SCREEN_SHARING_HINT = 'Ask the user to run `claude-desktop --reset-screen-sharing`, then share all monitors when the screen-sharing dialog appears.'

export function notSharedText(message, isNotShared = false) {
  const text = String(message ?? '')
  let m = text.match(/monitor (\S+) \([^)]*\) is not shared in the portal session \(shared: ([^)]*)\)(?:;[^\n]*?forget-session[^\n]*)?/)
  if (m) {
    return `${text.slice(0, m.index)}Monitor ${m[1]} is not shared with Claude (shared: ${m[2].trim() || 'none'}). ${RESET_SCREEN_SHARING_HINT}${text.slice(m.index + m[0].length)}`
  }
  m = text.match(/no portal stream matched screen `([^`]+)`/)
  if (m) {
    return `${text.slice(0, m.index)}Monitor ${m[1]} is not shared with Claude. ${RESET_SCREEN_SHARING_HINT}${text.slice(m.index + m[0].length)}`
  }
  if (isNotShared || /no portal stream matched|is not shared in the portal session|forget-session/.test(text)) {
    const trimmed = text.replace(/\s+$/, '')
    return `${trimmed}${/[.!?]$/.test(trimmed) ? ' ' : '. '}${RESET_SCREEN_SHARING_HINT}`
  }
  return null
}

// Session commands are tracked for the idle timer: in flight they block the
// idle end, and their completion (success or failure) re-arms it. Commands the
// stop latch refuses never get here (ensureBridgeSession throws first), so
// they do not count as activity.
// Background display (issue #300) switched on while this kwin-mode executor
// runs: the executor was chosen at startup (cu_mode_preamble.js forces the
// regular one when the setting is on), so until a restart every command but
// session-end is refused instead of acting on the user's desktop. Re-read on
// lock acquire AND before every command when the settings files changed
// (upstream's app-scoped lock, acquireApp, never reaches __setLockHeld): one
// async stat pair per command (__cuTargetSig, cu_mode_preamble.js), no read
// while the files are unchanged.
const TARGET_RESTART_TEXT = 'Computer Use is set to a background display, which takes effect on KDE Plasma after Claude restarts. Ask the user to restart Claude, or to turn off Settings -> Extra -> Cowork (Linux) -> Computer Use on a background display.'
let targetRestartMessage = null
let targetSigLast = null
try { if (typeof globalThis.__cuTargetSigSync === 'function') targetSigLast = globalThis.__cuTargetSigSync() } catch {}
function applyTargetSetting() {
  let target = null
  try { target = typeof globalThis.__cuTargetRead === 'function' ? globalThis.__cuTargetRead() : null } catch {}
  const was = targetRestartMessage
  targetRestartMessage = target ? TARGET_RESTART_TEXT : null
  if (targetRestartMessage && !was) {
    globalThis.__cdbDiag('[claude-cu] diagnostics: target=' + (target.invalid ? 'invalid' : target.kind + ' ' + target.display) + ' needs a restart in kwin mode - refusing Computer Use until then')
  }
}
async function refreshTargetSetting() {
  if (typeof globalThis.__cuTargetSig !== 'function') return
  let sig = null
  try { sig = await globalThis.__cuTargetSig() } catch {}
  if (sig === null || sig === targetSigLast) return
  targetSigLast = sig
  applyTargetSetting()
}
async function execBridge(command, args, opts = {}) {
  if (command !== 'session-end' && command !== 'session-start') touchSessionCheck()
  if (command !== 'session-end') await refreshTargetSetting()
  if (targetRestartMessage && command !== 'session-end') throw new Error(targetRestartMessage)
  if (!KWIN_SESSION_COMMANDS.has(command)) return execBridgeOnce(command, args, opts)
  portalCommandsInFlight += 1
  try {
    const stdout = await execBridgeOnce(command, args, opts)
    if (command === 'left-mouse-down') mouseButtonHeld = true
    return stdout
  } finally {
    portalCommandsInFlight -= 1
    touchIdleTimer()
  }
}

async function execBridgeOnce(command, args, opts = {}) {
  const spec = buildBridgeCommand(command, args)
  const timeout = opts.timeoutMs ?? bridgeTimeoutMs(command)
  debugLog(`exec ${command}`, { args: spec.args, timeout })
  try {
    const { stdout } = await execFile(spec.command, spec.args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    })
    debugLog(`exec ${command} ok`, {
      stdoutLength: stdout.trim().length,
    })
    return stdout.trim()
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : ''
    const timedOut = timeout > 0 && error?.killed === true && !!error?.signal
    const detail = timedOut
      ? `no reply within ${timeout} ms (killed with ${error.signal})${stderr ? `: ${stderr}` : ''}`
      : stderr || stdout || error?.message || String(error)

    if (opts.allowAlreadyActive && /already active/i.test(detail)) {
      debugLog(`exec ${command} already active`, { detail })
      return ''
    }

    globalThis.__cdbDiag(`[linux-executor] exec ${command} failed`, {
      detail,
      args: spec.args,
    })
    // The session daemon is gone while we still hold its session open:
    // `claude-desktop --reset-screen-sharing` (the bridge's forget-session)
    // ended it. Forget the memoized start so the next command starts one fresh
    // session; this one is not retried (no consent dialog behind the model's
    // back for a command it already got an answer to).
    const exitCode = typeof error?.code === 'number' ? error.code : null
    // The user stopped screen sharing: the daemon is gone on purpose. Latch it
    // (ensureBridgeSession then fails fast and never starts a new session) and
    // keep sessionReadyPromise, so the task boundary, the idle end or the lock
    // release still sends session-end, which clears the bridge's
    // stopped-by-user marker.
    // session-start counts too: it exits 5 when the new daemon was closed
    // before it became ready (bridgeDaemonMayExist keeps the release's
    // session-end even though ensureBridgeSession drops the failed start).
    if (
      command !== 'session-end'
      && (exitCode === BRIDGE_EXIT_STOPPED_BY_USER || /screen sharing was stopped|stopped by the user/.test(detail))
    ) {
      latchStoppedByUser(command)
      throw stoppedByUserError()
    }
    if (
      KWIN_PORTAL_COMMANDS.has(command)
      && (exitCode === BRIDGE_EXIT_NO_SESSION || /no active portal session/.test(detail))
      && bridgeSessionActive
      && !stoppedByUser
      && sessionReadyPromise
      && !sessionStopPromise
    ) {
      sessionReadyPromise = null
      mouseButtonHeld = false
      // No daemon left to end: the idle timer must not send session-end.
      bridgeDaemonMayExist = false
      overlayNeedsReapply = true
      globalThis.__cdbDiag('[linux-executor] session daemon is gone (screen sharing reset?); the next command starts a new session')
      throw new Error(`[kwin-portal-bridge] ${command} failed: ${detail} - the screen-sharing session was ended; retry the action to start a new one (the screen-sharing dialog may appear)`)
    }
    const rewritten = notSharedText(detail, exitCode === BRIDGE_EXIT_NOT_SHARED)
    throw new Error(`[kwin-portal-bridge] ${command} failed: ${rewritten ?? detail}`)
  }
}

async function execBridgeJson(command, args, opts) {
  const stdout = await execBridge(command, args, opts)
  if (!stdout) return null
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    const preview = stdout.length > 300 ? `${stdout.slice(0, 300)}...` : stdout
    globalThis.__cdbDiag(`[linux-executor] exec ${command} returned non-JSON`, { preview })
    throw new Error(`[kwin-portal-bridge] ${command} returned non-JSON output: ${preview}`)
  }
  debugLog(`exec ${command} parsed json`, {
    type: Array.isArray(parsed) ? 'array' : typeof parsed,
    length: Array.isArray(parsed) ? parsed.length : undefined,
  })
  return parsed
}

async function ensureBridgeSession() {
  touchSessionCheck()
  await refreshTargetSetting()
  if (targetRestartMessage) throw new Error(targetRestartMessage)
  if (!bridgeSessionActive) {
    throw new Error('[kwin-portal-bridge] bridge session is not active; cuLock is not held')
  }
  if (stoppedByUser) {
    throw stoppedByUserError()
  }
  // An idle or task-boundary end is in flight with the lock still held: start
  // the next session after it, never next to it (its session-end would take
  // the new daemon down).
  if (!sessionReadyPromise && sessionStopPromise) {
    await sessionStopPromise.catch(() => {})
    return ensureBridgeSession()
  }
  if (!sessionReadyPromise) {
    debugLog('starting bridge session')
    sessionStartInFlight = true
    const startPromise = (async () => {
      bridgeDaemonMayExist = true
      await execBridge('session-start', [], { allowAlreadyActive: true })
    })().catch(error => {
      if (sessionReadyPromise === startPromise) sessionReadyPromise = null
      globalThis.__cdbDiag('[linux-executor] bridge session startup failed', error)
      throw error
    }).finally(() => {
      sessionStartInFlight = false
    })
    sessionReadyPromise = startPromise
  }
  await sessionReadyPromise
  armShareWatch()
  // The command that asked runs next; count from here so the timer cannot
  // fire in the gap (e.g. screenshot's untracked `screens` lookup).
  touchIdleTimer()
  if (overlayNeedsReapply && reapplySessionOverlay) {
    overlayNeedsReapply = false
    // Best effort, not awaited: it never fails or delays the command.
    Promise.resolve().then(reapplySessionOverlay).catch(error => {
      globalThis.__cdbDiag('[linux-executor] failed to re-apply the session overlay display after a restart', error)
    })
  }
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

// (Re)starts the idle countdown. It only runs while the lock is held; it never
// keeps the process alive.
function armIdleTimer() {
  clearIdleTimer()
  if (!bridgeSessionActive) return
  idleTimer = setTimeout(onIdleTimer, CU_PORTAL_IDLE_MS)
  idleTimer.unref?.()
}

// A Computer Use action happened: restart the countdown and the held-button
// deferral, and the cloud-session check.
function touchIdleTimer() {
  idleHeldDeferred = false
  armIdleTimer()
  armSessionCheck()
}

// Cloud-session check (js/cu_session_check.js, issue #293). A cloud Cowork
// task never tells main that its turn ended, and upstream holds the lock for up
// to 12 min after it. While the bridge session is up (or the stop latch is set)
// for a cloud lock holder (session_X / cse_X, from __setLockHeld), the shared
// poller asks upstream's session-state check 10 s after the last Computer Use
// action; an ended session goes through __cuTaskBoundary. Armed with the idle
// timer on activity, stopped by every session end; the idle timer stays the
// backstop. Every tool call touches it on entry (before its first await), so a
// reply in flight never ends a session a command has started to use. Hub chats
// (UUID holders) are never checked.
let lockHolder = null
let sessionCheckExecutor = null

// Busy = what defers the idle end (onIdleTimer), a held button included.
function sessionCheckBusy() {
  return !!(sessionStartInFlight || sessionStopPromise
    || (!stoppedByUser && (portalCommandsInFlight > 0 || mouseButtonHeld)))
}

function armSessionCheck() {
  const check = globalThis.__cdbCuSessionCheck
  const holder = lockHolder
  if (!check || !bridgeSessionActive || !bridgeSessionMayBeUp()) return
  check.arm(holder || null, {
    busy: sessionCheckBusy,
    // No session up and no stop latch: nothing to end, the check stops.
    active: () => bridgeSessionActive && bridgeSessionMayBeUp(),
    // Through __linuxExecutor when it is set, so the accessibility tools'
    // wrapper (js/cu_ax_tools.js) sees the task boundary too.
    onEnded: () => {
      const ex = globalThis.__linuxExecutor
      const target = ex && typeof ex.__cuTaskBoundary === 'function' ? ex : sessionCheckExecutor
      return target?.__cuTaskBoundary(holder, 'session-check', holder)
    },
  })
}

function stopSessionCheck(reason) {
  globalThis.__cdbCuSessionCheck?.stop(reason)
}

function touchSessionCheck() {
  globalThis.__cdbCuSessionCheck?.touch?.()
}

// A Computer Use ACTION (capture, input, opening an app; not enumeration,
// icons or capability probes, which upstream also runs between turns): the
// Escape watcher (community switch, js/cu_esc_watch.js) re-arms a watcher it
// parked at a cloud turn end. Sync and cheap; absent or off = nothing.
function escAction() {
  try { globalThis.__cdbCuEscWatch?.toolCall?.() } catch {}
}

function bridgeSessionMayBeUp() {
  return !!sessionReadyPromise || bridgeDaemonMayExist || stoppedByUser
}

function onIdleTimer() {
  idleTimer = null
  if (!bridgeSessionActive || !bridgeSessionMayBeUp()) return
  // With the stop latch set the daemon is gone: an in-flight command or a held
  // button no longer has a session to protect.
  const guarded = !stoppedByUser
  if (sessionStartInFlight || sessionStopPromise || (guarded && portalCommandsInFlight > 0)) {
    debugLog('idle timer re-armed', {
      sessionStartInFlight,
      sessionStopInFlight: !!sessionStopPromise,
      portalCommandsInFlight,
    })
    armIdleTimer()
    return
  }
  if (guarded && mouseButtonHeld) {
    if (!idleHeldDeferred) {
      idleHeldDeferred = true
      debugLog('idle timer re-armed once; a mouse button is held')
      armIdleTimer()
      return
    }
    globalThis.__cdbDiag(`[linux-executor] a mouse button has been held for ${2 * CU_PORTAL_IDLE_MS / 1000} s without Computer Use actions; ending the bridge session anyway`)
  }
  globalThis.__cdbDiag(`[linux-executor] idle for ${CU_PORTAL_IDLE_MS / 1000} s, ending the bridge session`)
  endBridgeSessionKeepLock('idle')
}

// Set the stop latch (a command answered exit 5, or the stopped-by-user marker
// appeared). Only for the session this lock holds, and not while a session-end
// owns the flags. Returns whether it latched now.
function latchStoppedByUser(why) {
  if (!bridgeSessionActive || sessionStopPromise || stoppedByUser) return false
  stoppedByUser = true
  bridgeDaemonMayExist = true
  globalThis.__cdbDiag(`[linux-executor] screen sharing was stopped (${why}); no new session until the task ends or ${CU_PORTAL_IDLE_MS / 1000} s without Computer Use actions`)
  // The daemon is gone, and any held button with it. The idle countdown
  // starts at the stop (session-start is not a tracked command, so its
  // exit 5 would otherwise latch with no timer armed).
  mouseButtonHeld = false
  touchIdleTimer()
  shareEnded(why)
  return true
}

// STOP SHARING = ABORT THE TURN (maintainer ruling 2026-11-10). The latch alone
// only refused the NEXT action. Upstream's own "user stopped sharing" abort
// (globalThis.__cdbCuShareEnded, sub-patch 17c of fix_computer_use_linux.nim:
// it stops the lock holder and every app-mode holder, as its Escape does) runs
// once per lock hold and once per task within a hold (cloud Cowork keeps one
// lock across tasks). Twin: _gnomeShareEnded in js/cu_linux_executor.js.
let shareFireArmed = true
function shareEnded(why) {
  if (!shareFireArmed) return
  shareFireArmed = false
  globalThis.__cdbCuShareStop?.fire?.('kwin-portal-bridge', why)
}

// The session daemon writes the stopped-by-user marker and exits; it is a
// setsid'd grandchild (session-start returns once it is ready), so there is no
// exit event of ours: watch its runtime dir (js/cu_share_stop.js) while a
// session is up, so the stop is noticed at once instead of on the next action.
let shareWatch = null
function armShareWatch() {
  if (shareWatch) return
  const helper = globalThis.__cdbCuShareStop
  if (typeof helper?.watch !== 'function') return
  shareWatch = helper.watch('kwin-portal-bridge', () => {
    if (sessionReadyPromise && !sessionStartInFlight) latchStoppedByUser('stopped-by-user marker appeared')
  })
}
function closeShareWatch() {
  if (!shareWatch) return
  shareWatch.close()
  shareWatch = null
}

function clearStoppedByUser(reason) {
  if (!stoppedByUser) return
  stoppedByUser = false
  globalThis.__cdbDiag(`[linux-executor] stopped-by-user latch cleared (${reason})`)
}

// Ends the bridge session (and lifts the stop latch) WITHOUT touching the lock:
// bridgeSessionActive stays as it is, so the next command starts a new session
// through ensureBridgeSession. Used by the idle timer and the task boundary.
// Never rejects.
function endBridgeSessionKeepLock(reason) {
  clearIdleTimer()
  stopSessionCheck(reason)
  closeShareWatch()
  overlayNeedsReapply = true
  // The daemon goes away with the session, and the button with it.
  mouseButtonHeld = false
  if (sessionStopPromise) {
    // A session-end is already running (lock release, idle end): join it.
    return sessionStopPromise.catch(() => {}).then(() => clearStoppedByUser(reason))
  }
  if (!sessionReadyPromise && !bridgeDaemonMayExist) {
    clearStoppedByUser(reason)
    return Promise.resolve()
  }
  const readyPromise = sessionReadyPromise
  sessionReadyPromise = null
  const stopPromise = (async () => {
    try {
      // A start in flight finishes first (task boundary only: the idle end
      // re-arms instead), then gets ended. The command that triggered that
      // start may then run against the ended session and fail; its retry
      // starts a new one. Accepted: the task it belonged to is over.
      if (readyPromise) await readyPromise
    } catch {}
    debugLog('ending bridge session', { reason })
    await execBridge('session-end', [])
    bridgeDaemonMayExist = false
  })().catch(error => {
    globalThis.__cdbDiag(`[linux-executor] bridge session end (${reason}) failed`, error)
  }).finally(() => {
    if (sessionStopPromise === stopPromise) sessionStopPromise = null
    // A session-start after this removes the bridge's marker in any case.
    clearStoppedByUser(reason)
    // A command in flight during the end re-armed the check on its way out.
    stopSessionCheck(reason)
  })
  sessionStopPromise = stopPromise
  return stopPromise
}

// Task-boundary ids: upstream names one session `session_<id>` in one place
// and `cse_<id>` in another, and one caller lowercases it.
function cuSessionKey(id) {
  return String(id).replace(/^(?:session_|cse_)/i, '').toLowerCase()
}

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    if (!bridgeSessionActive && !sessionReadyPromise && !bridgeDaemonMayExist) return
    const shutdownSpec = buildBridgeCommand('session-end', [])
    try {
      debugLog('stopping bridge session on process exit', shutdownSpec)
      // Bounded: this blocks app quit. The bridge itself reaps a silent
      // daemon (SIGTERM, then SIGKILL) well inside this budget.
      spawnSync(shutdownSpec.command, shutdownSpec.args, {
        stdio: 'ignore',
        windowsHide: true,
        timeout: KWIN_EXIT_SESSION_END_MS,
      })
    } catch {}
  })
}

async function startBridgeSession() {
  installExitHook()
  bridgeSessionActive = true
  shareFireArmed = true
  clearIdleTimer()
  // __setLockHeld(true) sets the overlay display itself after the start.
  overlayNeedsReapply = false
  // A new lock is a new task: a stop from the previous one no longer applies
  // (this session-start removes the bridge's stopped-by-user marker).
  if (stoppedByUser) {
    stoppedByUser = false
    globalThis.__cdbDiag('[linux-executor] stopped-by-user latch cleared (new lock)')
  }
  if (sessionStopPromise) {
    await sessionStopPromise
  }
  await ensureBridgeSession()
  // The lock may have found its session already up (no session-start ran):
  // count from the acquire either way.
  touchIdleTimer()
}

async function stopBridgeSession() {
  bridgeSessionActive = false
  clearIdleTimer()
  closeShareWatch()
  stopSessionCheck('lock released')
  mouseButtonHeld = false
  if (sessionStopPromise) {
    return sessionStopPromise
  }
  // No start in flight. A start that FAILED cleared sessionReadyPromise but
  // may still have left a daemon waiting on its consent dialog (the bridge's
  // ready timeout leaves it waiting by design), so only skip when no daemon
  // can exist.
  if (!sessionReadyPromise && !bridgeDaemonMayExist) {
    debugLog('stopBridgeSession skipped; no active session promise')
    stoppedByUser = false
    return
  }

  const readyPromise = sessionReadyPromise
  sessionReadyPromise = null
  sessionStopPromise = (async () => {
    try {
      if (readyPromise) await readyPromise
    } catch (error) {
      // Still end it: a session-start that timed out leaves the daemon
      // waiting on its consent dialog. session-end is idempotent.
      debugLog('stopBridgeSession after failed startup', {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    debugLog('stopping bridge session')
    await execBridge('session-end', [])
    bridgeDaemonMayExist = false
  })().catch(error => {
    globalThis.__cdbDiag('[linux-executor] bridge session shutdown failed', error)
    throw error
  }).finally(() => {
    sessionStopPromise = null
    // The lock that saw the user stop sharing is over.
    if (stoppedByUser && !bridgeSessionActive) {
      stoppedByUser = false
      globalThis.__cdbDiag('[linux-executor] stopped-by-user latch cleared (lock released)')
    }
  })

  return sessionStopPromise
}

function mapRustScreenToDisplay(screen, index) {
  const electronDisplay = electronDisplayForRustScreen(screen)
  const electronDisplayId =
    typeof electronDisplay?.id === 'number' ? electronDisplay.id : undefined
  return {
    displayId: electronDisplayId ?? index,
    width: screen.geometry.width,
    height: screen.geometry.height,
    scaleFactor:
      typeof screen.scale === 'number' && Number.isFinite(screen.scale)
        ? screen.scale
        : 1,
    originX: screen.geometry.x,
    originY: screen.geometry.y,
    isPrimary: !!screen.is_primary,
    label: screen.name || screen.id || `display-${index}`,
    _legacyDisplayId: index,
    _bridgeId: screen.id,
  }
}

async function getRustScreens() {
  const screens = await execBridgeJson('screens', [])
  if (!Array.isArray(screens) || screens.length === 0) {
    throw new Error('bridge returned no screens')
  }
  debugLog('loaded rust screens', {
    count: screens.length,
    ids: screens.map(screen => screen.id),
  })
  return screens
}

async function listDisplaysWithBridgeIds() {
  const screens = await getRustScreens()
  const displays = screens.map(mapRustScreenToDisplay)
  rememberDisplayIdMappings(displays)
  return displays
}

async function getDisplayByNumericId(displayId) {
  const displays = await listDisplaysWithBridgeIds()
  const selected =
    displays.find(display => display.displayId === displayId) ||
    displays.find(display => display._legacyDisplayId === displayId) ||
    displays.find(display => display.isPrimary) ||
    displays[0]

  if (!selected) {
    throw new Error('no displays enumerated')
  }

  debugLog('selected display', {
    requestedDisplayId: displayId,
    selectedDisplayId: selected.displayId,
    legacyDisplayId: selected._legacyDisplayId,
    bridgeId: selected._bridgeId,
    label: selected.label,
  })
  return selected
}

function screenshotResultFromRust(result, display) {
  const width = typeof result.width === 'number' ? result.width : 0
  const height = typeof result.height === 'number' ? result.height : 0
  return {
    base64: result.base64 || '',
    width,
    height,
    displayWidth:
      typeof result.displayWidth === 'number'
        ? result.displayWidth
        : display.width,
    displayHeight:
      typeof result.displayHeight === 'number'
        ? result.displayHeight
        : display.height,
    displayId: display.displayId,
    originX:
      typeof result.originX === 'number' ? result.originX : display.originX,
    originY:
      typeof result.originY === 'number' ? result.originY : display.originY,
  }
}

async function listWindows() {
  const windows = await execBridgeJson('windows', [])
  debugLog('loaded windows', {
    count: Array.isArray(windows) ? windows.length : 0,
  })
  return Array.isArray(windows) ? windows : []
}

function normalizeBundleIdFromWindow(window) {
  if (window?.transient === true && window?.transient_for) {
    const transientBundleId = normalizeBundleIdFromWindowRef(
      window.transient_for,
      new Set(typeof window.id === 'string' ? [window.id] : []),
    )
    if (transientBundleId) {
      return transientBundleId
    }
  }

  for (const candidate of [
    window.desktop_file_name,
    window.resource_class,
    window.resource_name,
    window.id,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.replace(/\.desktop$/i, '')
    }
  }
  return null
}

function normalizeBundleIdFromWindowRef(window, seenIds = new Set()) {
  if (!window || typeof window !== 'object') return null

  const windowId = typeof window.id === 'string' ? window.id : null
  if (windowId && seenIds.has(windowId)) {
    return null
  }

  const nextSeenIds = new Set(seenIds)
  if (windowId) {
    nextSeenIds.add(windowId)
  }

  if (window.transient === true && window.transient_for) {
    const transientBundleId = normalizeBundleIdFromWindowRef(
      window.transient_for,
      nextSeenIds,
    )
    if (transientBundleId) {
      return transientBundleId
    }
  }

  for (const candidate of [
    window.desktop_file_name,
    window.resource_class,
    window.resource_name,
    window.id,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.replace(/\.desktop$/i, '')
    }
  }

  return null
}

function displayNameFromWindow(window) {
  if (typeof window.title === 'string' && window.title.trim()) {
    return window.title
  }
  return normalizeBundleIdFromWindow(window) || window.id
}

function bundleIdMatches(window, bundleId) {
  const normalized = normalizeBundleIdFromWindow(window)
  if (typeof normalized === 'string' && normalized.toLowerCase() === bundleId.toLowerCase()) {
    return true
  }

  return (
    typeof window?.title === 'string' &&
    window.title.trim().toLowerCase() === bundleId.toLowerCase()
  )
}

function visibleForHitTest(window) {
  if (window.is_minimized === true) return false
  return window.is_visible !== false
}

function dockableWindow(window) {
  if (!visibleForHitTest(window)) return false
  if (window.is_dialog === true) return false
  return window.is_normal_window !== false
}

function topRightDockBounds(display) {
  const margin = 20
  const width = Math.max(240, Math.min(600, Math.round(display.width - margin)))
  const height = Math.max(240, Math.min(720, Math.round(display.height - margin)))
  return {
    x: Math.round(display.originX + display.width - width - margin),
    y: Math.round(display.originY + margin),
    width,
    height,
  }
}

async function resolveDisplayForWindow(window, mainWindow) {
  const displays = await listDisplaysWithBridgeIds()

  if (typeof window?.output === 'string') {
    const byBridgeId = displays.find(display => display._bridgeId === window.output)
    if (byBridgeId) {
      return byBridgeId
    }
  }

  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const electronDisplay = electronScreen.getDisplayMatching(mainWindow.getBounds())
      const byElectronId = displays.find(display => display.displayId === electronDisplay.id)
      if (byElectronId) {
        return byElectronId
      }
    }
  } catch {}

  return displays.find(display => display.isPrimary) || displays[0]
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function rectContains(rect, x, y) {
  return (
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    x >= rect.x &&
    x < rect.x + rect.width &&
    y >= rect.y &&
    y < rect.y + rect.height
  )
}

function buttonFlag(button) {
  switch (button) {
    case 'left':
      return ['--button', 'left']
    case 'right':
      return ['--button', 'right']
    case 'middle':
      return ['--button', 'middle']
    default:
      throw new Error(`unsupported mouse button: ${button}`)
  }
}

// A model-injected Escape must not trip the user's Escape watcher (js/
// cu_esc_watch.js, community switch "Escape stops Computer Use"; kglobalaccel
// on KDE is not syntheticSafe): every bridge call that can carry one runs
// inside suspendAround, after the session is up so the window covers the
// injection only. Other input is never wrapped; without the community patch,
// or with its switch off, fn just runs.
function escAround(hasEscape, fn, expectMs) {
  const watch = globalThis.__cdbCuEscWatch
  return hasEscape && typeof watch?.suspendAround === 'function' ? watch.suspendAround(fn, expectMs) : fn()
}
function escInKeys(keys) {
  return globalThis.__cdbCuEscWatch?.hasEscape?.(keys) === true
}
// Upstream's own executor marks each key / holdKey whose keys are exactly one
// Escape as expected (sub-patch 17e: globalThis.__cdbCuExpectEscape, a 100 ms
// counter its X11 Escape grab reads). Same rule, right before the injection:
// one mark per press (a repeated key marks each repetition).
function escExpect(keys, repeat) {
  try {
    const mark = globalThis.__cdbCuExpectEscape
    if (typeof mark !== 'function') return
    const list = (Array.isArray(keys) ? keys : String(keys ?? '').split('+')).filter(k => String(k).length > 0)
    if (list.length !== 1) return
    const k = String(list[0]).trim().toLowerCase()
    if (k !== 'escape' && k !== 'esc') return
    const n = typeof repeat === 'number' && repeat > 1 ? Math.floor(repeat) : 1
    for (let i = 0; i < n; i++) mark()
  } catch {}
}
function escInText(text) {
  return typeof text === 'string' && text.includes('\x1b')
}

function modifierFlags(modifiers) {
  const flags = []
  for (const modifier of modifiers || []) {
    flags.push('--modifier', modifier)
  }
  return flags
}

async function typeViaClipboard(backend, text) {
  let saved
  try {
    saved = await backend.readClipboard()
  } catch {}

  try {
    await backend.writeClipboard(text)
    await backend.key('ctrl+v')
  } finally {
    if (typeof saved === 'string') {
      try {
        await backend.writeClipboard(saved)
      } catch {}
    }
  }
}

function commandOutputToAppRef(result) {
  if (!result || typeof result !== 'object') return null
  if (typeof result.bundleId !== 'string' || typeof result.displayName !== 'string') {
    return null
  }
  return {
    bundleId: result.bundleId,
    displayName: result.displayName,
  }
}

function displayIdLookup(displays) {
  const byBridgeId = new Map()
  for (const display of displays) {
    byBridgeId.set(display._bridgeId, display.displayId)
  }
  return byBridgeId
}

function bridgeDisplayArg(display) {
  return display ? ['--display', display._bridgeId] : []
}

function teachPayloadArg(payload) {
  return ['--payload', JSON.stringify(payload || {})]
}

// KWin capture exclusions are one shared state in the bridge's exclude-state
// file: prepare-for-action sets them (after lifting any earlier ones) and
// restore-prepare-state lifts them. Both commands run one at a time, in call
// order, so a restore queued at a turn end never lands between a later
// prepare-for-action and the screenshot that follows it.
let captureExcludeTail = Promise.resolve()
function runCaptureExcludeOp(fn) {
  const run = captureExcludeTail.then(fn, fn)
  captureExcludeTail = run.catch(() => {})
  return run
}

export function createRustLinuxBackend() {
  return {
    async prepareForAction(allowlistBundleIds, hostBundleId, displayId) {
      debugLog('prepareForAction', {
        allowlistBundleIds,
        hostBundleId,
        displayId,
      })
      const display = await getDisplayByNumericId(displayId)
      const args = [
        ...allowlistBundleIds.flatMap(id => ['--allowed-bundle-id', id]),
        '--host-bundle-id',
        hostBundleId,
        ...bridgeDisplayArg(display),
      ]
      const result = await runCaptureExcludeOp(() => execBridgeJson('prepare-for-action', args))
      debugLog('prepare-for-action result', result)
      return {
        hidden: Array.isArray(result?.hidden) ? result.hidden : [],
        activated: typeof result?.activated === 'string' ? result.activated : null,
      }
    },

    async previewHideSet(allowlistBundleIds, hostBundleId, displayId) {
      debugLog('previewHideSet', {
        allowlistBundleIds,
        hostBundleId,
        displayId,
      })
      const display = await getDisplayByNumericId(displayId)
      const args = [
        ...allowlistBundleIds.flatMap(id => ['--allowed-bundle-id', id]),
        '--host-bundle-id',
        hostBundleId,
        ...bridgeDisplayArg(display),
      ]
      const result = await execBridgeJson('preview-hide-set', args)
      debugLog('preview-hide-set result', {
        count: Array.isArray(result) ? result.length : 0,
      })
      return Array.isArray(result) ? result : []
    },

    // Display auto-target (js/cu_display_target.js): the granted apps'
    // windows and the monitors in one space. KWin reports both in its global
    // logical coordinates (frameGeometry, screen geometry), so the rects
    // compare directly, XWayland windows included; a window without a usable
    // frame still counts on the output KWin names for it.
    async windowDisplayTarget(bundleIds) {
      const target = globalThis.__cdbCuDisplayTarget
      if (!target) return { why: 'display target helper missing' }
      const displays = await listDisplaysWithBridgeIds()
      const byBridgeId = displayIdLookup(displays)
      const windows = await listWindows()
      const mons = displays.map(display => ({
        displayId: display.displayId,
        label: display.label,
        isPrimary: display.isPrimary,
        rect: {
          x: display.originX,
          y: display.originY,
          width: display.width,
          height: display.height,
        },
      }))
      const wins = target.normalize(
        windows,
        bundleIds,
        window => window.geometry || null,
        window => (typeof window.output === 'string' ? byBridgeId.get(window.output) : null),
      )
      return { mons, wins }
    },

    async findWindowDisplays(bundleIds) {
      debugLog('findWindowDisplays', { bundleIds })
      const ids = Array.isArray(bundleIds) ? bundleIds : []
      if (ids.length === 0) return []
      const src = await this.windowDisplayTarget(ids)
      if (!src.mons) return []
      const resolved = globalThis.__cdbCuDisplayTarget.windowDisplays(src.wins, src.mons, ids)
      debugLog('findWindowDisplays result', resolved)
      return resolved
    },

    async listDisplays() {
      const displays = await listDisplaysWithBridgeIds()
      debugLog('listDisplays', {
        count: displays.length,
        displays: displays.map(({ _bridgeId, ...display }) => display),
      })
      return displays.map(({ _bridgeId, ...display }) => display)
    },

    async getDisplaySize(displayId) {
      const { _bridgeId, ...display } = await getDisplayByNumericId(displayId)
      return display
    },

    async screenshot(displayId) {
      await ensureBridgeSession()
      const display = await getDisplayByNumericId(displayId)
      debugLog('screenshot', {
        displayId,
        bridgeDisplayId: display._bridgeId,
      })
      const result = await execBridgeJson('screenshot', bridgeDisplayArg(display))
      debugLog('screenshot result', {
        width: result?.width,
        height: result?.height,
        base64Length: result?.base64?.length,
      })
      return screenshotResultFromRust(result, display)
    },

    async zoom(region, displayId) {
      await ensureBridgeSession()
      const display = await getDisplayByNumericId(displayId)
      debugLog('zoom', {
        region,
        displayId,
        bridgeDisplayId: display._bridgeId,
      })
      const args = [
        ...bridgeDisplayArg(display),
        '--x',
        String(Math.round(region.x)),
        '--y',
        String(Math.round(region.y)),
        '--w',
        String(Math.round(region.w)),
        '--h',
        String(Math.round(region.h)),
      ]
      const result = await execBridgeJson('zoom', args)
      debugLog('zoom result', {
        width: result?.width,
        height: result?.height,
        base64Length: result?.base64?.length,
      })
      return {
        base64: result?.base64 || '',
        width: typeof result?.width === 'number' ? result.width : 0,
        height: typeof result?.height === 'number' ? result.height : 0,
      }
    },

    async key(keySequence, repeat) {
      await ensureBridgeSession()
      debugLog('key', { keySequence, repeat })
      const args = ['--keys', keySequence]
      if (typeof repeat === 'number') {
        args.push('--repeat', String(repeat))
      }
      await escAround(escInKeys(keySequence), () => {
        escExpect(keySequence, repeat)
        return execBridgeJson('key-sequence', args)
      })
    },

    async holdKey(keyNames, durationMs) {
      await ensureBridgeSession()
      debugLog('holdKey', { keyNames, durationMs })
      const args = [
        ...keyNames.flatMap(name => ['--key', name]),
        '--duration-ms',
        String(durationMs),
      ]
      await escAround(escInKeys(keyNames), () => (escExpect(keyNames, 1), execBridgeJson('hold-key', args, {
        timeoutMs: KWIN_PORTAL_MS + Math.max(0, Number(durationMs) || 0),
      })), Number(durationMs) || 0)
    },

    async type(text, opts) {
      debugLog('type', { textLength: text.length, viaClipboard: !!opts?.viaClipboard })
      if (opts?.viaClipboard) {
        await typeViaClipboard(this, text)
        return
      }
      await ensureBridgeSession()
      await escAround(escInText(text), () => execBridgeJson('type', ['--text', text], {
        timeoutMs: typeTimeoutMs(text),
      }), typeTimeoutMs(text) - KWIN_PORTAL_MS)
    },

    async typePaced(text, delayMs) {
      debugLog('typePaced', { textLength: text.length, delayMs })
      await ensureBridgeSession()
      const args = ['--text', text]
      if (typeof delayMs === 'number' && Number.isFinite(delayMs)) {
        args.push('--delay-ms', String(Math.max(0, Math.round(delayMs))))
      }
      await escAround(escInText(text), () => execBridgeJson('type', args, {
        timeoutMs: typeTimeoutMs(text, delayMs),
      }), typeTimeoutMs(text, delayMs) - KWIN_PORTAL_MS)
    },

    async readClipboard() {
      await ensureBridgeSession()
      const result = await execBridgeJson('read-clipboard', [])
      debugLog('readClipboard result', { textLength: result?.text?.length ?? 0 })
      return typeof result?.text === 'string' ? result.text : ''
    },

    async writeClipboard(text) {
      await ensureBridgeSession()
      debugLog('writeClipboard', { textLength: text.length })
      await execBridgeJson('write-clipboard', ['--text', text])
    },

    async moveMouse(x, y) {
      await ensureBridgeSession()
      debugLog('moveMouse', { x, y })
      await execBridgeJson('pointer-move', ['--x', String(Math.round(x)), '--y', String(Math.round(y))])
    },

    async click(x, y, button, count, modifiers) {
      await ensureBridgeSession()
      debugLog('click', { x, y, button, count, modifiers })
      const args = [
        '--x',
        String(Math.round(x)),
        '--y',
        String(Math.round(y)),
        ...buttonFlag(button),
        '--count',
        String(count),
        ...modifierFlags(modifiers),
      ]
      await escAround(escInKeys(modifiers), () => execBridgeJson('pointer-click', args))
    },

    async mouseDown() {
      await ensureBridgeSession()
      debugLog('mouseDown')
      await execBridgeJson('left-mouse-down', [])
    },

    async mouseUp() {
      // Released on the attempt, success or failure, even when the stop latch
      // refuses it before the bridge runs: a stale flag must not hold the
      // session up (the next session starts with no button held).
      mouseButtonHeld = false
      await ensureBridgeSession()
      debugLog('mouseUp')
      await execBridgeJson('left-mouse-up', [])
    },

    async getCursorPosition() {
      const result = await execBridgeJson('cursor-position', [])
      debugLog('getCursorPosition result', result)
      return {
        x: typeof result?.x === 'number' ? result.x : 0,
        y: typeof result?.y === 'number' ? result.y : 0,
      }
    },

    async drag(from, to) {
      await ensureBridgeSession()
      debugLog('drag', { from, to })
      const args = [
        '--from-x',
        String(Math.round(from?.x ?? 0)),
        '--from-y',
        String(Math.round(from?.y ?? 0)),
        '--to-x',
        String(Math.round(to.x)),
        '--to-y',
        String(Math.round(to.y)),
      ]
      if (from === undefined) {
        const current = await this.getCursorPosition()
        args[1] = String(Math.round(current.x))
        args[3] = String(Math.round(current.y))
      }
      await execBridgeJson('pointer-drag', args)
    },

    async scroll(x, y, dx, dy) {
      await ensureBridgeSession()
      debugLog('scroll', { x, y, dx, dy })
      await execBridgeJson('pointer-scroll', [
        '--x',
        String(Math.round(x)),
        '--y',
        String(Math.round(y)),
        '--dx',
        String(dx),
        '--dy',
        String(dy),
      ])
    },

    async getFrontmostApp() {
      const result = commandOutputToAppRef(await execBridgeJson('frontmost-app', []))
      debugLog('getFrontmostApp result', result)
      return result
    },

    async appUnderPoint(x, y) {
      const result = commandOutputToAppRef(
        await execBridgeJson('app-under-point', ['--x', String(Math.round(x)), '--y', String(Math.round(y))]),
      )
      debugLog('appUnderPoint result', { x, y, result })
      return result
    },

    async setWindowGeometry(windowId, geometry) {
      debugLog('setWindowGeometry', { windowId, geometry })
      return execBridgeJson('set-window-geometry', [
        '--window',
        windowId,
        '--x',
        String(Math.round(geometry.x)),
        '--y',
        String(Math.round(geometry.y)),
        '--width',
        String(Math.round(geometry.width)),
        '--height',
        String(Math.round(geometry.height)),
      ])
    },

    async setWindowKeepAbove(windowId, value) {
      debugLog('setWindowKeepAbove', { windowId, value })
      return execBridgeJson('set-window-keep-above', [
        '--window',
        windowId,
        '--value',
        value ? 'true' : 'false',
      ])
    },

    async activateWindow(windowId) {
      debugLog('activateWindow', { windowId })
      return execBridgeJson('activate-window', ['--window', windowId])
    },

    async showTeachStep(payload, displayId) {
      await ensureBridgeSession()
      let display
      if (typeof displayId === 'number') {
        display = await getDisplayByNumericId(displayId)
        debugLog('showTeachStep target display', {
          displayId,
          bridgeDisplayId: display._bridgeId,
          label: display.label,
        })
        // No separate teach-display call here: teach-step retargets
        // atomically via --display, and the bridge prefers the screen
        // containing the step's anchor anyway. Calling teach-display first
        // restarted the overlay onto the (often wrong) guessed display only
        // for the anchor to restart it back — two restarts per step.
      }
      const result = await execBridgeJson('teach-step', [
        ...teachPayloadArg(payload),
        ...bridgeDisplayArg(display),
      ])
      debugLog('showTeachStep result', result)
      return result
    },

    async setTeachWorking() {
      await ensureBridgeSession()
      debugLog('setTeachWorking')
      await execBridgeJson('teach-working', [])
    },

    async hideTeachOverlay() {
      await ensureBridgeSession()
      debugLog('hideTeachOverlay')
      await execBridgeJson('teach-hide', [])
    },

    async setTeachDisplay(displayId) {
      await ensureBridgeSession()
      const display = await getDisplayByNumericId(displayId)
      debugLog('setTeachDisplay', {
        displayId,
        bridgeDisplayId: display._bridgeId,
      })
      await execBridgeJson('teach-display', ['--display', display._bridgeId])
    },

    async waitTeachEvent() {
      await ensureBridgeSession()
      const result = await execBridgeJson('teach-wait-event', [])
      debugLog('waitTeachEvent result', result)
      return result
    },

    async setSessionOverlayDisplay(displayId) {
      await ensureBridgeSession()
      let display = null

      if (typeof displayId === 'number') {
        display = await getDisplayByNumericId(displayId)
      } else {
        const displays = await listDisplaysWithBridgeIds()
        display = displays.find(candidate => candidate.isPrimary) || displays[0] || null
      }

      if (!display) {
        debugLog('setSessionOverlayDisplay', { displayId: null, bridgeDisplayId: null })
        await execBridgeJson('set-overlay-display', [])
        return null
      }

      debugLog('setSessionOverlayDisplay', {
        displayId: typeof displayId === 'number' ? displayId : null,
        bridgeDisplayId: display._bridgeId,
      })
      await execBridgeJson('set-overlay-display', ['--display', display._bridgeId])
      // Report the display actually applied (including the primary-display
      // fallback above) so callers can track where the overlay really is.
      return display.displayId
    },

    async listInstalledApps() {
      const result = await execBridgeJson('list-installed-apps', [])
      const apps = Array.isArray(result) ? [...result, ...SYNTHETIC_INSTALLED_APPS] : [...SYNTHETIC_INSTALLED_APPS]
      debugLog('listInstalledApps result', {
        count: apps.length,
      })
      return apps
    },

    async getAppIcon(target) {
      const result = await execBridgeJson('get-app-icon', ['--target', target])
      debugLog('getAppIcon result', {
        target,
        found: typeof result === 'string',
        length: typeof result === 'string' ? result.length : 0,
      })
      return typeof result === 'string' ? result : undefined
    },

    async listRunningApps() {
      const windows = await listWindows()
      const byBundleId = new Map()
      for (const window of windows) {
        if (!visibleForHitTest(window)) continue
        const bundleId = normalizeBundleIdFromWindow(window)
        if (!bundleId || byBundleId.has(bundleId)) continue
        byBundleId.set(bundleId, {
          bundleId,
          displayName: displayNameFromWindow(window),
          pid: typeof window.pid === 'number' ? window.pid : undefined,
        })
      }
      const apps = [...byBundleId.values()]
      debugLog('listRunningApps result', { count: apps.length, apps })
      return apps
    },

    async openApp(bundleId) {
      debugLog('openApp', { bundleId })
      await execBridgeJson('open-app', ['--app', bundleId])
    },

    // Lifts every capture exclusion the bridge recorded (ids are not needed:
    // the exclude-state file names the windows). A local command, no portal
    // session involved; with nothing recorded it touches no KWin state.
    async unhideApps() {
      debugLog('unhideApps')
      await runCaptureExcludeOp(() => execBridgeJson('restore-prepare-state', []))
    },
  }
}

function toScreenshotResult(capture, display) {
  return {
    base64: capture.base64,
    width: capture.width,
    height: capture.height,
    displayWidth: display.width,
    displayHeight: display.height,
    displayId: display.displayId,
    originX: display.originX,
    originY: display.originY,
  }
}

async function getDisplaySize(backend, displayId) {
  if (typeof backend.getDisplaySize === 'function') {
    return backend.getDisplaySize(displayId)
  }
  const displays = await backend.listDisplays()
  return (
    displays.find(display => display.displayId === displayId) ||
    displays.find(display => display.isPrimary) ||
    displays[0]
  )
}

// The display to capture for upstream's autoResolve: the one holding most of
// the granted apps' windows (js/cu_display_target.js), else the preferred
// display unchanged. One log line per resolution.
async function autoTargetDisplay(backend, allowedBundleIds, preferredDisplayId) {
  const apps = Array.isArray(allowedBundleIds) ? allowedBundleIds : []
  if (apps.length === 0 || typeof backend.windowDisplayTarget !== 'function') {
    return preferredDisplayId
  }
  const tag = `[claude-cu] display auto-target: apps=${apps.join(',')}`
  let preferred = null
  try { preferred = await getDisplaySize(backend, preferredDisplayId) } catch {}
  const preferredLabel = preferred?.label || String(preferredDisplayId ?? '(default)')
  let src
  try {
    src = await backend.windowDisplayTarget(expandAllowedBundleIds(apps))
  } catch (error) {
    src = { why: `window list failed: ${error instanceof Error ? error.message : error}` }
  }
  if (!src.mons) {
    globalThis.__cdbDiag?.(`${tag} kept ${preferredLabel} (${src.why})`)
    return preferredDisplayId
  }
  const target = globalThis.__cdbCuDisplayTarget
  const picked = target.pick(src.wins, src.mons, expandAllowedBundleIds(apps), preferred?.displayId ?? preferredDisplayId)
  if (picked.displayId == null) {
    globalThis.__cdbDiag?.(`${tag} kept ${preferredLabel} (${picked.why})`)
    return preferredDisplayId
  }
  globalThis.__cdbDiag?.(`${tag} -> ${target.label(src.mons, picked.displayId)} (preferred ${preferredLabel}${picked.why === 'tie' ? ', tie' : ''})`)
  return picked.displayId
}

export function createLinuxExecutor(opts = {}) {
  const backend = opts.backend || createRustLinuxBackend()
  const hostBundleId = opts.hostBundleId || DEFAULT_HOST_BUNDLE_ID
  debugLog('createLinuxExecutor', { hostBundleId })

  const teachControllerState = {
    initialized: false,
    activeSessionId: null,
    mainWindowHidden: false,
    watcherGeneration: 0,
  }

  const sessionOverlayState = {
    manager: null,
    // Display the session overlay was last actually placed on — the best
    // available signal for "the screen the agent is working on".
    lastDisplayId: null,
  }

  // Windows left out of screenshots (KWin excludeFromCapture) are invisible
  // to the user, so they are lifted at every end of Computer Use use, not only
  // when upstream's "Unhide apps when Claude finishes" setting asks for it:
  // the CU lock release (every turn end on every upstream path), the task
  // boundary, upstream's own turn-end unhide (__unhideApps, sub-patch 4h) and
  // app start (leftovers of a crash). Never rejects.
  async function restoreCaptureExclusions(reason) {
    try {
      await backend.unhideApps()
      globalThis.__cdbDiag?.(`[linux-executor] capture exclusions lifted (${reason})`)
      return true
    } catch (error) {
      globalThis.__cdbDiag?.(`[linux-executor] failed to lift capture exclusions (${reason})`, error)
      return false
    }
  }

  reapplySessionOverlay = () => backend.setSessionOverlayDisplay(
    sessionOverlayState.lastDisplayId ?? undefined,
  ).then(recordSessionOverlayDisplay)

  function recordSessionOverlayDisplay(applied) {
    if (typeof applied === 'number') {
      sessionOverlayState.lastDisplayId = applied
    }
    return applied
  }

  const dockControllerState = {
    initialized: false,
    isLockHeld: false,
    holder: null,
    mainWindow: null,
    restore: null,
    operationGeneration: 0,
  }

  async function findHostMainWindow() {
    const windows = await listWindows()
    const matches = windows
      .filter(window => dockableWindow(window) && bundleIdMatches(window, hostBundleId))
      .sort((a, b) => {
        const activeDelta = Number(!!b.is_active) - Number(!!a.is_active)
        if (activeDelta !== 0) return activeDelta
        return (b.stacking_order ?? 0) - (a.stacking_order ?? 0)
      })

    const selected = matches[0] || null
    debugLog('findHostMainWindow', {
      hostBundleId,
      found: !!selected,
      windowId: selected?.id,
      title: selected?.title,
      output: selected?.output,
    })
    return selected
  }

  async function resolveRestoreWindow(restore, mainWindow) {
    const windows = await listWindows()
    const exact = windows.find(window => window.id === restore.windowId)
    if (exact) {
      debugLog('resolveRestoreWindow matched saved window id', {
        windowId: exact.id,
      })
      return exact
    }

    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isVisible()) {
          mainWindow.show()
        }
        mainWindow.focus()
      }
    } catch (error) {
      globalThis.__cdbDiag('[linux-executor] failed to show Claude window before restore', error)
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = await findHostMainWindow()
      if (candidate) {
        debugLog('resolveRestoreWindow matched current host window', {
          savedWindowId: restore.windowId,
          targetWindowId: candidate.id,
          attempt,
        })
        return candidate
      }
      await sleep(100)
    }

    debugLog('resolveRestoreWindow failed to locate current host window', {
      savedWindowId: restore.windowId,
    })
    return null
  }

  async function dockClaudeWindow() {
    const generation = ++dockControllerState.operationGeneration
    const mainWindow = dockControllerState.mainWindow
    let window = await findHostMainWindow()

    if (!window) {
      debugLog('dockClaudeWindow skipped; no host window found')
      return
    }

    if (!dockControllerState.restore) {
      dockControllerState.restore = {
        windowId: window.id,
        bounds: roundedRect(window.geometry),
        keepAbove: !!window.keep_above,
        wasMaximized:
          typeof mainWindow?.isMaximized === 'function' ? mainWindow.isMaximized() : false,
        wasFullScreen:
          typeof mainWindow?.isFullScreen === 'function' ? mainWindow.isFullScreen() : false,
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (dockControllerState.restore.wasFullScreen) {
        await new Promise(resolve => {
          mainWindow.once('leave-full-screen', resolve)
          mainWindow.setFullScreen(false)
        }).catch(() => {})
      }

      if (dockControllerState.restore.wasMaximized) {
        try {
          mainWindow.unmaximize()
        } catch {}
      }

      if (dockControllerState.restore.wasFullScreen || dockControllerState.restore.wasMaximized) {
        await sleep(150)
        window = (await findHostMainWindow()) || window
        dockControllerState.restore.windowId = window.id
        dockControllerState.restore.bounds = roundedRect(window.geometry)
      }
    }

    if (dockControllerState.operationGeneration !== generation || !dockControllerState.isLockHeld) {
      return
    }

    const display = await resolveDisplayForWindow(window, mainWindow)
    if (!display) {
      debugLog('dockClaudeWindow skipped; no display resolved')
      return
    }

    const targetBounds = topRightDockBounds(display)
    await backend.setWindowGeometry(window.id, targetBounds)
    await backend.setWindowKeepAbove(window.id, true)
    debugLog('dockClaudeWindow applied', {
      windowId: window.id,
      targetBounds,
      displayId: display.displayId,
      bridgeDisplayId: display._bridgeId,
    })
  }

  async function restoreClaudeWindow() {
    const generation = ++dockControllerState.operationGeneration
    const restore = dockControllerState.restore
    const mainWindow = dockControllerState.mainWindow

    if (!restore) {
      debugLog('restoreClaudeWindow skipped; no restore state')
      return
    }

    dockControllerState.restore = null

    let targetWindow = null
    let restoredThroughBridge = false

    try {
      targetWindow = await resolveRestoreWindow(restore, mainWindow)
      if (targetWindow) {
        await backend.setWindowGeometry(targetWindow.id, restore.bounds)
        await backend.setWindowKeepAbove(targetWindow.id, restore.keepAbove)
        await backend.activateWindow(targetWindow.id)
        restoredThroughBridge = true
      }
    } catch (error) {
      globalThis.__cdbDiag('[linux-executor] failed to restore Claude window through bridge', error)
    }

    if (dockControllerState.operationGeneration !== generation) {
      return
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.show()
        mainWindow.focus()
      } catch {}
      if (restore.wasMaximized) {
        try {
          mainWindow.maximize()
        } catch {}
      }
      if (restore.wasFullScreen) {
        try {
          mainWindow.setFullScreen(true)
        } catch {}
      }
    }

    debugLog('restoreClaudeWindow applied', {
      savedWindowId: restore.windowId,
      targetWindowId: targetWindow?.id ?? null,
      restoreBounds: restore.bounds,
      restoredThroughBridge,
    })
  }

  function resolveTeachDisplayId(manager, mainWindow, sessionId) {
    const session = typeof manager?.getSession === 'function' ? manager.getSession(sessionId) : null
    if (typeof session?.cuSelectedDisplayId === 'number') {
      return session.cuSelectedDisplayId
    }

    // The session overlay sits on the screen the agent is actually working
    // on (it gets retargeted whenever the agent resolves a display), which
    // is where the taught app lives — so fall back to its display, using
    // the last position it was actually placed at (which includes its
    // primary-display fallback for fresh sessions). Never guess from the
    // main window: it is hidden during teach mode, and on Wayland Electron
    // then resolves getDisplayMatching to whatever screen happens to be
    // active.
    const overlayDisplayId = resolveSessionOverlayDisplayId(manager, sessionId)
    if (typeof overlayDisplayId === 'number') {
      return overlayDisplayId
    }
    return sessionOverlayState.lastDisplayId ?? undefined
  }

  function resolveSessionOverlayDisplayId(manager, sessionId) {
    const targetSessionId =
      sessionId ??
      (typeof manager?.getCuLockHolder === 'function' ? manager.getCuLockHolder() : null)

    if (targetSessionId && typeof manager?.getSession === 'function') {
      const session = manager.getSession(targetSessionId)
      if (typeof session?.cuSelectedDisplayId === 'number') {
        return session.cuSelectedDisplayId
      }
    }

    return undefined
  }

  function restoreTeachMainWindow(mainWindow) {
    if (!teachControllerState.mainWindowHidden) return
    teachControllerState.mainWindowHidden = false
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isVisible()) {
          mainWindow.show()
        }
      }
    } catch (error) {
      globalThis.__cdbDiag('[linux-executor] failed to restore teach main window', error)
    }
  }

  async function stopTeachSession(manager, mainWindow) {
    const holder = typeof manager?.getCuLockHolder === 'function' ? manager.getCuLockHolder() : null

    if (holder) {
      debugLog('stopTeachSession', { holder })
      await manager.stopSession(holder)
      return
    }

    debugLog('stopTeachSession fallback without holder')
    await backend.hideTeachOverlay().catch(error => {
      globalThis.__cdbDiag('[linux-executor] failed to hide teach overlay during fallback stop', error)
    })
    restoreTeachMainWindow(mainWindow)
  }

  function startTeachEventWatcher(manager, mainWindow, sessionId) {
    const generation = ++teachControllerState.watcherGeneration

    ;(async () => {
      while (
        teachControllerState.activeSessionId === sessionId &&
        teachControllerState.watcherGeneration === generation
      ) {
        const event = await backend.waitTeachEvent()

        if (
          teachControllerState.activeSessionId !== sessionId ||
          teachControllerState.watcherGeneration !== generation
        ) {
          return
        }

        if (event?.action === 'exit') {
          await stopTeachSession(manager, mainWindow)
          return
        }

        if (event?.action === 'hidden') {
          return
        }
      }
    })().catch(error => {
      globalThis.__cdbDiag('[linux-executor] teach event watcher failed', error)
    })
  }

  return {
    capabilities: {
      ...LINUX_CU_CAPABILITIES,
      hostBundleId,
    },

    async __setLockHeld(isHeld, holder) {
      debugLog('__setLockHeld', { isHeld, holder })
      globalThis.__cdbDiag?.(`[claude-cu] ${isHeld ? `lock taken by ${typeof holder === 'string' && holder ? holder : 'none'}` : 'lock released'}`)
      // The lock holder names the cloud session the session check asks about
      // (patch 4b passes upstream's exclusiveHolder; 4b.2 releases without one).
      lockHolder = isHeld && typeof holder === 'string' ? holder : null
      sessionCheckExecutor = this
      if (!isHeld) stopSessionCheck('lock released')
      // A notFound holder is checked again on the next lock.
      globalThis.__cdbCuSessionCheck?.forget?.()
      if (isHeld) {
        try { if (typeof globalThis.__cuTargetSig === 'function') targetSigLast = await globalThis.__cuTargetSig() } catch {}
        applyTargetSetting()
        if (targetRestartMessage) return
      }
      dockControllerState.isLockHeld = isHeld
      if (isHeld) {
        await startBridgeSession()
        const displayId = resolveSessionOverlayDisplayId(
          sessionOverlayState.manager,
        )
        await backend.setSessionOverlayDisplay(displayId).then(recordSessionOverlayDisplay).catch(error => {
          globalThis.__cdbDiag('[linux-executor] failed to set session overlay display on lock acquire', error)
        })
        if (dockControllerState.initialized) {
          await dockClaudeWindow()
        }
      } else {
        // Queued before any await, so it runs ahead of the next lock's
        // prepare-for-action (runCaptureExcludeOp keeps call order).
        const lifted = restoreCaptureExclusions('lock released')
        if (dockControllerState.initialized) {
          await restoreClaudeWindow()
        }
        await lifted
        await stopBridgeSession()
      }
    },

    // Upstream's releaseRemoteCuLock IPC (patch in fix_computer_use_linux.nim):
    // a cloud session went idle, Stop was clicked, or the session was archived
    // or deleted. id = the session it names, holder = upstream's current lock
    // holder. Ends the bridge session and lifts the stop latch, like the idle
    // timer; upstream's lock is not touched (the next command starts a new
    // session). Safe at any time; never rejects.
    async __cuTaskBoundary(id, source, holder) {
      // The turn ended: an Escape watcher (community switch) parks until the
      // next action.
      try { globalThis.__cdbCuEscWatch?.taskEnded?.(id, source, holder) } catch {}
      try {
        if (id != null && holder != null && cuSessionKey(id) !== cuSessionKey(holder)) {
          globalThis.__cdbDiag(`[linux-executor] task boundary (${source}): ignored, ${id} is not the Computer Use lock holder ${holder}`)
          return
        }
        await restoreCaptureExclusions(`task boundary (${source})`)
        if (!bridgeSessionMayBeUp() && !sessionStopPromise) {
          debugLog('task boundary: no bridge session to end', { source })
          return
        }
        globalThis.__cdbDiag(`[linux-executor] task boundary (${source}): ending the bridge session`)
        shareFireArmed = true
        stopSessionCheck('task boundary')
        await endBridgeSessionKeepLock(`task boundary (${source})`)
      } catch (error) {
        globalThis.__cdbDiag('[linux-executor] task boundary failed', error)
      }
    },

    // Upstream's turn-end unhide (unhideComputerUseApps), routed here by
    // sub-patch 4h of fix_computer_use_linux.nim instead of upstream's own
    // Linux executor module. bundleIds = what prepareForAction reported as
    // hidden this turn; the bridge lifts every exclusion it recorded.
    // Never rejects.
    async __unhideApps(bundleIds) {
      debugLog('__unhideApps', { bundleIds })
      await restoreCaptureExclusions('turn-end unhide')
    },

    // Patch 1 calls this once right after the executor is created: lifts
    // exclusions a crashed or killed previous run left behind. Never rejects.
    async __restoreCaptureExclusions(reason) {
      return restoreCaptureExclusions(typeof reason === 'string' && reason ? reason : 'request')
    },

    // Accessibility tools (js/cu_ax_tools.js): the user stopped screen sharing
    // for this Computer Use session (#293 latch), so input-like AX actions stop too.
    __stoppedByUser() {
      return stoppedByUser
    },

    __normalizeDisplayId(displayId) {
      const normalized =
        legacyDisplayIdToElectronDisplayId.get(displayId) ?? displayId
      debugLog('__normalizeDisplayId', { input: displayId, normalized })
      return normalized
    },

    __initDockController(mainWindow) {
      if (dockControllerState.initialized) return
      dockControllerState.initialized = true
      dockControllerState.mainWindow = mainWindow

      if (dockControllerState.isLockHeld) {
        const displayId = resolveSessionOverlayDisplayId(
          sessionOverlayState.manager,
        )
        backend.setSessionOverlayDisplay(displayId).then(recordSessionOverlayDisplay).catch(error => {
          globalThis.__cdbDiag('[linux-executor] failed to set session overlay display on dock init', error)
        })
        dockClaudeWindow().catch(error => {
          globalThis.__cdbDiag('[linux-executor] failed to dock Claude window on init', error)
        })
      }

      debugLog('__initDockController installed')
    },

    // Read by fix_computer_use_linux.nim 7d: upstream turns teach mode off on
    // every Wayland session (its Electron overlay needs click-through
    // windows); this executor draws teach steps through the bridge's own
    // overlay instead, so the getter may follow the server's teachModeEnabled.
    __teachOverlay: true,

    __initTeachController(manager, mainWindow) {
      if (teachControllerState.initialized) return
      teachControllerState.initialized = true
      sessionOverlayState.manager = manager

      if (dockControllerState.isLockHeld) {
        const displayId = resolveSessionOverlayDisplayId(manager)
        backend.setSessionOverlayDisplay(displayId).catch(error => {
          globalThis.__cdbDiag('[linux-executor] failed to sync session overlay display on controller init', error)
        })
      }

      manager.on('teachModeChanged', ({ sessionId, active }) => {
        if (active) {
          teachControllerState.activeSessionId = sessionId

          const displayId = resolveTeachDisplayId(manager, mainWindow, sessionId)
          if (typeof displayId === 'number') {
            backend.setTeachDisplay(displayId).catch(error => {
              globalThis.__cdbDiag('[linux-executor] failed to set initial teach display', error)
            })
          }

          try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
              mainWindow.hide()
              teachControllerState.mainWindowHidden = true
            }
          } catch (error) {
            globalThis.__cdbDiag('[linux-executor] failed to hide teach main window', error)
          }

          startTeachEventWatcher(manager, mainWindow, sessionId)
          return
        }

        teachControllerState.activeSessionId = null
        teachControllerState.watcherGeneration += 1
        backend.hideTeachOverlay().catch(error => {
          globalThis.__cdbDiag('[linux-executor] failed to hide teach overlay on deactivate', error)
        })
        restoreTeachMainWindow(mainWindow)
      })

      manager.on('teachStepRequested', ({ sessionId, payload }) => {
        const targetSessionId = sessionId ?? teachControllerState.activeSessionId
        const displayId = resolveTeachDisplayId(manager, mainWindow, targetSessionId)

        backend
          .showTeachStep(payload, displayId)
          .then(async result => {
            if (result?.action === 'superseded') {
              // A newer show-step replaced this one; the newer call owns the
              // manager's pending step, so neither resolve nor stop here.
              return
            }

            if (result?.action === 'exit') {
              manager.resolveTeachStep({ action: 'exit' })
              await stopTeachSession(manager, mainWindow)
              return
            }

            manager.resolveTeachStep({ action: 'next' })
          })
          .catch(async error => {
            globalThis.__cdbDiag('[linux-executor] showTeachStep failed', error)
            manager.resolveTeachStep({ action: 'exit' })
            await stopTeachSession(manager, mainWindow)
          })
      })

      manager.on('teachStepWorking', () => {
        backend.setTeachWorking().catch(error => {
          globalThis.__cdbDiag('[linux-executor] failed to switch teach overlay to working', error)
        })
      })

      manager.on('cuSelectedDisplayChanged', ({ sessionId, displayId }) => {
        const holder =
          typeof manager?.getCuLockHolder === 'function' ? manager.getCuLockHolder() : null
        if (dockControllerState.isLockHeld && holder === sessionId) {
          const resolvedDisplayId = resolveSessionOverlayDisplayId(
            manager,
            sessionId,
          )
          backend.setSessionOverlayDisplay(resolvedDisplayId).then(recordSessionOverlayDisplay).catch(error => {
            globalThis.__cdbDiag('[linux-executor] failed to retarget session overlay display', error)
          })
        }

        if (sessionId !== teachControllerState.activeSessionId) return
        backend.setTeachDisplay(displayId).catch(error => {
          globalThis.__cdbDiag('[linux-executor] failed to retarget teach overlay display', error)
        })
      })

      manager.on('lifecycleChanged', ({ sessionId, newState }) => {
        if (sessionId !== teachControllerState.activeSessionId || newState === 'running') {
          return
        }

        teachControllerState.activeSessionId = null
        teachControllerState.watcherGeneration += 1
        backend.hideTeachOverlay().catch(error => {
          globalThis.__cdbDiag('[linux-executor] failed to hide teach overlay during lifecycle fallback', error)
        })
        restoreTeachMainWindow(mainWindow)
      })

      debugLog('__initTeachController installed')
    },

    async prepareForAction(allowlistBundleIds, displayId) {
      const expandedAllowlistBundleIds = expandAllowedBundleIds(allowlistBundleIds)
      const result = await backend.prepareForAction(
        expandedAllowlistBundleIds,
        hostBundleId,
        displayId,
      )
      return result.hidden
    },

    async previewHideSet(allowlistBundleIds, displayId) {
      return backend.previewHideSet(
        expandAllowedBundleIds(allowlistBundleIds),
        hostBundleId,
        displayId,
      )
    },

    async findWindowDisplays(bundleIds) {
      return backend.findWindowDisplays(bundleIds)
    },

    async getDisplaySize(displayId) {
      return getDisplaySize(backend, displayId)
    },

    async listDisplays() {
      return backend.listDisplays()
    },

    async resolvePrepareCapture(opts) {
      escAction()
      debugLog('resolvePrepareCapture', opts)
      let hidden = []
      let activated = null
      // Upstream sets autoResolve when the granted apps changed and the model
      // has not pinned a display: capture the display holding most of their
      // windows, as macOS does. Otherwise the preferred display, as before.
      let displayId = opts.preferredDisplayId
      if (opts.autoResolve === true) {
        displayId = await autoTargetDisplay(backend, opts.allowedBundleIds, opts.preferredDisplayId)
      }

      if (opts.doHide ?? true) {
        const expandedAllowedBundleIds = expandAllowedBundleIds(opts.allowedBundleIds)
        const result = await backend.prepareForAction(
          expandedAllowedBundleIds,
          hostBundleId,
          displayId,
        )
        hidden = result.hidden
        activated = result.activated
      }

      try {
        const display = await getDisplaySize(backend, displayId)
        const result = await backend.screenshot(displayId)

        return {
          ...toScreenshotResult(result, display),
          hidden,
          activated,
        }
      } catch (error) {
        const display = await getDisplaySize(backend, displayId)
        return {
          base64: '',
          width: 0,
          height: 0,
          displayWidth: display?.width ?? 0,
          displayHeight: display?.height ?? 0,
          displayId: display?.displayId ?? displayId ?? 0,
          originX: display?.originX ?? 0,
          originY: display?.originY ?? 0,
          hidden,
          activated,
          captureError:
            error instanceof Error ? error.message : 'Screenshot capture failed',
        }
      }
    },

    async screenshot(opts) {
      escAction()
      debugLog('screenshot', opts)
      const display = await getDisplaySize(backend, opts.displayId)
      return toScreenshotResult(await backend.screenshot(opts.displayId), display)
    },

    async zoom(regionLogical, allowedBundleIds, displayId) {
      escAction()
      void allowedBundleIds
      return backend.zoom(regionLogical, displayId)
    },

    async key(keySequence, repeat) {
      escAction()
      await backend.key(keySequence, repeat)
    },

    async holdKey(keyNames, durationMs) {
      escAction()
      await backend.holdKey(keyNames, durationMs)
    },

    async type(text, opts) {
      escAction()
      debugLog('type', { textLength: text?.length, opts })
      await backend.type(text, opts)
    },

    async typePaced(text, delayMs) {
      escAction()
      await backend.typePaced(text, delayMs)
    },

    readClipboard() {
      return backend.readClipboard()
    },

    writeClipboard(text) {
      return backend.writeClipboard(text)
    },

    async moveMouse(x, y) {
      escAction()
      await backend.moveMouse(x, y)
    },

    async click(x, y, button, count, modifiers) {
      escAction()
      await backend.click(x, y, button, count, modifiers)
    },

    async mouseDown() {
      escAction()
      await backend.mouseDown()
    },

    async mouseUp() {
      escAction()
      await backend.mouseUp()
    },

    async getCursorPosition() {
      return backend.getCursorPosition()
    },

    async drag(from, to) {
      escAction()
      await backend.drag(from, to)
    },

    async scroll(x, y, dx, dy) {
      escAction()
      await backend.scroll(x, y, dx, dy)
    },

    async getFrontmostApp() {
      return backend.getFrontmostApp()
    },

    async appUnderPoint(x, y) {
      return backend.appUnderPoint(x, y)
    },

    async listInstalledApps() {
      return backend.listInstalledApps()
    },

    async getAppIcon(path) {
      return backend.getAppIcon(path)
    },

    async listRunningApps() {
      return backend.listRunningApps()
    },

    async openApp(bundleId) {
      escAction()
      await backend.openApp(bundleId)
    },
  }
}

export async function unhideComputerUseAppsLinux(
  bundleIds,
  backend = createRustLinuxBackend(),
) {
  if (!bundleIds || bundleIds.length === 0) return
  await backend.unhideApps(bundleIds)
}

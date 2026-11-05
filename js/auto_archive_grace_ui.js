// Embedded in the ion renderer by patches/community/add_feature_auto_archive_grace_ion.nim,
// once into the chunk with upstream's auto-archive hold notice and once into
// the chunk with the session rail. The __cdb* placeholders are replaced with
// each chunk's own local names for the same React exports, resolved from
// native anchors, never from private React state:
//   __cdbReactState / __cdbReactEffect  useState / useEffect
//   __cdbJsxOne / __cdbJsxMany / __cdbFragment  jsx / jsxs / Fragment
// Nothing here archives, sweeps or reads GitHub; it only displays what the
// main process reports and writes upstream's own per-session setting.
const __cdbArchiveGracePollMs = 30000;
function __cdbArchiveGraceRemaining(deadline, now) {
  const minutes = Math.ceil((deadline - now) / 60000);
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest === 0 ? hours + " h" : hours + " h " + rest + " min";
}
function __cdbArchiveGraceView({sessionRef, hold, lineClass, children, rail = false}) {
  const [snapshot, setSnapshot] = __cdbReactState(null);
  const [now, setNow] = __cdbReactState(Date.now());
  const [saving, setSaving] = __cdbReactState(false);
  const [error, setError] = __cdbReactState("");
  const [kept, setKept] = __cdbReactState(null);
  const id = sessionRef?.type === "local" ? sessionRef.id : undefined;
  const holdKey = hold ? String(hold.reason) + "/" + String(hold.detail ?? "") : "";
  __cdbReactEffect(() => {
    let disposed = false, busy = false, poll = null;
    setSnapshot(null);
    setError("");
    const stop = () => { if (poll !== null) { clearInterval(poll); poll = null; } };
    async function read() {
      if (busy) return;
      busy = true;
      let next = null;
      try { next = (await globalThis.cdbExtra.autoArchiveGraceRead(id)) || null; }
      catch (_) { next = null; }
      finally { busy = false; }
      if (disposed) return;
      // Tagged with its session, so a render for another session never uses it.
      setSnapshot(next ? { ...next, sessionId: id } : null);
      setNow(Date.now());
      // Poll only while the delay is set and PR auto-archive applies to this
      // session. With the delay at Immediately, the rule off, or no answer,
      // this single read is all that runs.
      if (next?.ok === true && next.active === true && next.enabled === true) {
        if (poll === null) poll = setInterval(read, __cdbArchiveGracePollMs);
      } else stop();
    }
    if (id !== undefined && typeof globalThis.cdbExtra?.autoArchiveGraceRead === "function") read();
    return () => { disposed = true; stop(); };
  }, [id, holdKey]);
  const terminal = id !== undefined && snapshot?.sessionId === id && snapshot.ok === true &&
    snapshot.active === true && snapshot.enabled === true && snapshot.terminal === true;
  if (rail) {
    const sessions = globalThis["claude.web"]?.LocalSessions;
    if (!terminal || kept === id || typeof sessions?.setSessionAutoArchiveOnPrClose !== "function") return null;
    async function keep() {
      setSaving(true);
      setError("");
      try {
        // The same persisted per-session setting as upstream's "Auto-archive on
        // merge or close"; upstream schedules the save and emits the update.
        // The button stays hidden for this session even if a read still sees
        // the old value before that save lands.
        await sessions.setSessionAutoArchiveOnPrClose(id, false);
        setKept(id);
      } catch (_) { setError("Could not keep this session. Try again."); }
      finally { setSaving(false); }
    }
    return __cdbJsxMany("div", {className: "flex flex-col gap-1 px-2 py-1", children: [
      __cdbJsxOne("button", {type: "button", disabled: saving,
        className: "text-footnote text-muted-as-secondary hover:text-text-primary text-left",
        title: "Turns off Auto-archive on merge or close for this session, the same setting as in the PR menu",
        onClick: keep, children: saving ? "Keeping session..." : "Keep this session"}),
      error ? __cdbJsxOne("span", {role: "alert", className: "text-footnote", children: error}) : null
    ]});
  }
  // Upstream's notice stays as it is; the delay line is appended after it,
  // outside its live region. The notice renders for any hold (the PR rule or
  // the inactivity rule), so the line states only a fact about the PR delay.
  if (!terminal) return children;
  const text = !Number.isSafeInteger(snapshot.deadline)
    ? "The PR auto-archive delay starts at the next archive sweep."
    : snapshot.deadline > now
      ? "The PR auto-archive delay has about " + __cdbArchiveGraceRemaining(snapshot.deadline, now) + " left."
      : "The PR auto-archive delay has ended.";
  return __cdbJsxMany(__cdbFragment, {children: [
    children,
    __cdbJsxOne("div", {"aria-live": "off", "data-find-omitted": "", className: lineClass, children: text})
  ]});
}

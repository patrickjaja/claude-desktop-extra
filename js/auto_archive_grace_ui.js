// Embedded in the ion renderer by the community archive-grace patch.
// Dependencies are resolved from native anchors, never from private React state.
function __cdbArchiveGraceView({sessionRef, children, rail = false}) {
  const [snapshot, setSnapshot] = __cdbReactState(null);
  const [now, setNow] = __cdbReactState(Date.now());
  const [saving, setSaving] = __cdbReactState(false);
  const [error, setError] = __cdbReactState("");
  const generation = __cdbReactRef(0);
  __cdbReactEffect(() => {
    let disposed = false, busy = false;
    setSnapshot(null);
    setError("");
    async function refresh() {
      if (busy || generation.current % 2 !== 0 || sessionRef?.type !== "local") return;
      busy = true;
      const requestGeneration = generation.current;
      try {
        const next = await globalThis.cdbExtra?.autoArchiveGraceRead?.(sessionRef.id);
        if (!disposed && requestGeneration === generation.current) { setSnapshot(next ? { ...next, sessionId: sessionRef.id } : null); setNow(Date.now()); }
      } catch (_) {
        if (!disposed && requestGeneration === generation.current) setSnapshot(null);
      } finally { busy = false; }
    }
    refresh();
    // Display refresh only; this timer never archives or asks for a sweep.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(refresh, 5000);
    return () => { disposed = true; clearInterval(timer); clearInterval(poll); };
  }, [sessionRef?.id, sessionRef?.type]);
  if (!snapshot?.active || !snapshot.ok || snapshot.sessionId !== sessionRef?.id || typeof snapshot.enabled !== "boolean") return rail ? null : children;
  if (!snapshot.enabled) return rail ? null : "Automatic archiving after PR merge or close is off for this session.";
  async function keep() {
    if (generation.current % 2 !== 0) return;
    generation.current++;
    setSaving(true); setError("");
    try {
      // The native API sets false, schedules its session save and emits an
      // update. Await IPC errors; upstream's save itself is asynchronous.
      await __cdbLocalSessions.setSessionAutoArchiveOnPrClose(sessionRef.id, false);
      setSnapshot(previous => previous?.sessionId === sessionRef.id ? { ...previous, enabled: false } : previous);
    } catch (_) { setError("Could not keep this session. Try again."); }
    finally { generation.current++; setSaving(false); }
  }
  if (rail) return __cdbJsx("div", {className: "flex flex-col gap-1 px-2 py-1", children: [
    __cdbJsx("button", {type: "button", disabled: saving || !__cdbLocalSessions?.setSessionAutoArchiveOnPrClose,
      className: "text-footnote text-muted-as-secondary hover:text-text-primary text-left",
      onClick: keep, children: saving ? "Keeping session…" : "Keep this session", title: "Turn off auto-archive on merge or close for this session only"}),
    error && __cdbJsx("span", {role: "alert", children: error})
  ]});
  if (!snapshot.terminal) return children;
  const seconds = Number.isSafeInteger(snapshot.deadline) ? Math.max(0, Math.ceil((snapshot.deadline - now) / 1000)) : null;
  const duration = seconds === null ? null : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
  const text = duration === null
    ? "Auto-archive delay is waiting for the next native sweep; no deadline has been recorded yet."
    : seconds > 0
      ? `PR auto-archive delay remaining: ${duration}. After it ends, a native sweep can archive this session only when all safety holds clear.`
      : "PR auto-archive delay has ended. A native sweep can archive this session only when all safety holds clear.";
  return __cdbJsx("div", {role: "status", className: "text-footnote text-muted-as-secondary", children: [children, " ", text]});
}

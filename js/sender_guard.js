;/*__CDB_SENDER_GUARD__*/(function () {
  "use strict";
  // The one IPC sender validator every main-side module of ours consults
  // (issue #318: private copies drifted, and one of them rejected the 3P main
  // window). Embedded by patches/core/add_feature_extra_settings.nim ahead of
  // its own IIFE and outside any platform gate. Consumers look it up at call
  // time through globalThis.__cdbSenderGuard and treat a missing guard as
  // "not ok", so the check fails closed whatever the evaluation order.
  if (globalThis.__cdbSenderGuard) return; // first definition wins

  var _URL = require("url").URL;

  // Exact-origin allowlist: the parsed origin is compared against the list,
  // never a substring or prefix test of the raw URL. A scheme test alone ("is
  // it http(s)?") would accept every https page that ended up in the main frame
  // of a webContents carrying our preload - and the handlers behind this guard
  // write gateway URLs and API keys, change settings and relaunch the app.
  //
  // app://localhost is the main window in 3P mode (upstream serves the bundled
  // SPA from it instead of claude.ai). URL.origin is the opaque "null" for that
  // scheme, so the origin is normalised to protocol + "//" + host first - the
  // same normalisation upstream's own eIPC sender validator applies. host keeps
  // a port, so app://localhost:1234 stays distinct and is rejected.
  var ALLOWED_ORIGINS = [
    "https://claude.ai",
    "https://preview.claude.ai",
    "https://claude.com",
    "https://preview.claude.com",
    "app://localhost"
  ];

  // "" when the URL does not parse.
  function originOf(rawUrl) {
    var u;
    try { u = new _URL(String(rawUrl)); } catch (e) { return ""; }
    var o = u.origin;
    if (!o || o === "null") o = u.protocol + "//" + u.host;
    return o;
  }

  function originAllowed(rawUrl) {
    var origin = originOf(rawUrl);
    if (!origin) return false;
    for (var i = 0; i < ALLOWED_ORIGINS.length; i++) {
      if (origin === ALLOWED_ORIGINS[i]) return true;
    }
    return false;
  }

  // FAILS CLOSED: wc.isDestroyed() is called unguarded - a sender object
  // missing the method throws, and the catch turns that into "not ok". Only
  // the main frame is accepted: subframes never get the preload, but reject
  // them explicitly rather than relying on that.
  function okSender(ev) {
    try {
      var wc = ev && ev.sender;
      if (!wc || wc.isDestroyed()) return false;
      if (!originAllowed(wc.getURL() || "")) return false;
      var frame = ev.senderFrame;
      if (frame && frame.parent) return false;
      return true;
    } catch (e) { return false; }
  }

  globalThis.__cdbSenderGuard = Object.freeze({
    originAllowed: originAllowed,
    okSender: okSender
  });
})();

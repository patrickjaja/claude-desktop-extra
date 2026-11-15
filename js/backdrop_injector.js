/*
 * backdrop_injector.js - renderer-side animated SVG backdrop and frosted-glass
 * installer for Claude Desktop on Linux.
 *
 * Prepended at runtime by add_feature_custom_themes.nim with:
 *   var __CDB_BACKDROP_SPEC = <json|null>;
 *
 * Works uniformly across Chat, Cowork, and Code tabs by targeting the shared
 * desktop frame (.dframe-root / .dframe-content) and setting the same
 * data-engine-backdrop-on / data-engine-glass attributes and --engine-glass-*
 * custom properties that upstream's Code-only session engine uses, while our
 * theme CSS extends those rules to Chat ([data-testid="chat-column"],
 * [data-chat-input-container]) and Cowork surfaces.
 */
;(function () {
  "use strict";

  var VERSION = 1;
  var ATTR_OWNED = "data-cdb-backdrop";
  var incoming =
    typeof window !== "undefined" &&
    typeof window.__CDB_BACKDROP_SPEC !== "undefined"
      ? window.__CDB_BACKDROP_SPEC
      : null;

  if (
    typeof window !== "undefined" &&
    typeof window.__cdbBackdropApply === "function" &&
    window.__cdbBackdrop &&
    window.__cdbBackdrop.version === VERSION
  ) {
    window.__cdbBackdropApply(incoming);
    return;
  }

  var state = {
    spec: null,
    moDoc: null,
    moBody: null,
    ro: null,
    roHost: null,
    roSidebar: null,
    visHandler: null,
    resizeHandler: null,
    rafId: 0,
    lastMode: "",
    lastSvgKey: ""
  };

  function clamp(n, lo, hi) {
    if (typeof n !== "number" || isNaN(n)) return lo;
    return n < lo ? lo : n > hi ? hi : n;
  }

  function parseHexLuminance(hex) {
    if (typeof hex !== "string") return null;
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) {
      h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    }
    var num = parseInt(h, 16);
    var rgb = [(num >> 16) & 255, (num >> 8) & 255, num & 255];
    var lin = [];
    for (var i = 0; i < 3; i++) {
      var c = rgb[i] / 255;
      lin[i] = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  function parseHslLightness(raw) {
    if (typeof raw !== "string") return null;
    var m = /^\s*[\d.]+\s+[\d.]+%\s+([\d.]+)%\s*$/.exec(raw.trim());
    return m ? parseFloat(m[1]) : null;
  }

  function isDarkMode() {
    try {
      var html = document.documentElement;
      if (!html) return true;
      var dm = html.getAttribute("data-mode");
      if (dm === "dark") return true;
      if (dm === "light") return false;
      var df = document.querySelector(".dframe-root");
      var dfm = df && df.getAttribute ? df.getAttribute("data-mode") : null;
      if (dfm === "dark") return true;
      if (dfm === "light") return false;
      var body = document.body;
      var bm = body && body.getAttribute ? body.getAttribute("data-mode") : null;
      if (bm === "dark") return true;
      if (bm === "light") return false;
      var modeNode = document.querySelector("[data-mode='dark'], [data-mode='light']");
      if (modeNode && modeNode.getAttribute) {
        var mnm = modeNode.getAttribute("data-mode");
        if (mnm === "dark") return true;
        if (mnm === "light") return false;
      }
      if (
        (html.classList && (html.classList.contains("darkTheme") || html.classList.contains("dark"))) ||
        (body && body.classList && (body.classList.contains("darkTheme") || body.classList.contains("dark")))
      ) {
        return true;
      }
      if (
        (html.classList && (html.classList.contains("lightTheme") || html.classList.contains("light"))) ||
        (body && body.classList && (body.classList.contains("lightTheme") || body.classList.contains("light")))
      ) {
        return false;
      }
      if (typeof window.getComputedStyle === "function") {
        var cs = window.getComputedStyle(df || html);
        if (cs && typeof cs.getPropertyValue === "function") {
          var l1 = parseHslLightness(cs.getPropertyValue("--cdb-bg-100"));
          var l2 = l1 !== null ? l1 : parseHslLightness(cs.getPropertyValue("--bg-100"));
          var bgL = l2 !== null ? l2 : parseHslLightness(cs.getPropertyValue("--bg-000"));
          if (typeof bgL === "number" && !isNaN(bgL)) {
            return bgL < 50;
          }
        }
      }
      if (typeof window.__CDB_IS_DARK === "boolean") {
        return window.__CDB_IS_DARK;
      }
      if (typeof window.matchMedia === "function") {
        return !!window.matchMedia("(prefers-color-scheme: dark)").matches;
      }
    } catch (e) {}
    return true;
  }

  function prefersReducedMotion() {
    try {
      if (typeof document !== "undefined" && document.hidden) return true;
      if (typeof window.matchMedia === "function") {
        return !!window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      }
    } catch (e) {}
    return false;
  }

  function prefersReducedTransparency() {
    try {
      if (typeof window.matchMedia === "function") {
        return !!window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
      }
    } catch (e) {}
    return false;
  }

  function sanitizeSvg(raw) {
    if (typeof raw !== "string") return "";
    var s = raw.trim();
    if (s.indexOf("<svg") !== 0 || s.lastIndexOf("</svg>") !== s.length - 6) {
      return "";
    }
    s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
    s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
    s = s.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return s;
  }

  function findFrameRoot() {
    if (typeof document === "undefined") return null;
    return (
      document.querySelector(".dframe-root") ||
      document.querySelector(".epitaxy-root") ||
      document.documentElement
    );
  }

  function findBackdropHost() {
    if (typeof document === "undefined") return null;
    return (
      document.querySelector(".dframe-content") ||
      document.querySelector(".epitaxy-root") ||
      document.querySelector(".dframe-root")
    );
  }

  function clearGlassAttrs(el) {
    if (!el || !el.removeAttribute) return;
    el.removeAttribute("data-engine-backdrop-on");
    el.removeAttribute("data-engine-glass");
    el.removeAttribute("data-engine-glass-unsuited");
    if (el.style && el.style.removeProperty) {
      el.style.removeProperty("--engine-glass-blur");
      el.style.removeProperty("--engine-glass-opacity");
      el.style.removeProperty("--engine-glass-tint");
    }
  }

  function removeBackdropNodes() {
    if (typeof document === "undefined") return 0;
    var nodes = document.querySelectorAll("[" + ATTR_OWNED + "]");
    var n = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
        n++;
      }
    }
    var roots = document.querySelectorAll(
      ".dframe-root, .epitaxy-root, html"
    );
    for (var j = 0; j < roots.length; j++) {
      clearGlassAttrs(roots[j]);
    }
    state.lastSvgKey = "";
    return n;
  }

  function disconnectObservers() {
    if (state.moDoc) {
      try {
        state.moDoc.disconnect();
      } catch (e) {}
      state.moDoc = null;
    }
    if (state.moBody) {
      try {
        state.moBody.disconnect();
      } catch (e) {}
      state.moBody = null;
    }
    if (state.ro) {
      try {
        state.ro.disconnect();
      } catch (e) {}
      state.ro = null;
      state.roHost = null;
      state.roSidebar = null;
    }
    if (state.visHandler && typeof document !== "undefined" && document.removeEventListener) {
      try {
        document.removeEventListener("visibilitychange", state.visHandler);
      } catch (e) {}
      state.visHandler = null;
    }
    if (state.resizeHandler && typeof window !== "undefined" && window.removeEventListener) {
      try {
        window.removeEventListener("resize", state.resizeHandler);
      } catch (e) {}
      state.resizeHandler = null;
    }
    if (state.rafId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
  }

  function setAttrIfNeeded(el, name, val) {
    if (!el || !el.getAttribute || !el.setAttribute) return;
    if (el.getAttribute(name) !== val) el.setAttribute(name, val);
  }

  function removeAttrIfNeeded(el, name) {
    if (!el || !el.hasAttribute || !el.removeAttribute) return;
    if (el.hasAttribute(name)) el.removeAttribute(name);
  }

  function setStylePropIfNeeded(el, prop, val) {
    if (!el || !el.style || !el.style.setProperty || !el.style.getPropertyValue) return;
    if (el.style.getPropertyValue(prop) !== val) el.style.setProperty(prop, val);
  }

  function removeStylePropIfNeeded(el, prop) {
    if (!el || !el.style || !el.style.removeProperty || !el.style.getPropertyValue) return;
    if (el.style.getPropertyValue(prop)) el.style.removeProperty(prop);
  }

  function syncPauseState(container) {
    if (!container) return;
    var paused = prefersReducedMotion();
    if (paused) {
      setAttrIfNeeded(container, "data-paused", "");
    } else {
      removeAttrIfNeeded(container, "data-paused");
    }
    var svg = container.querySelector("svg");
    if (svg) {
      try {
        if (paused && typeof svg.pauseAnimations === "function") {
          svg.pauseAnimations();
        } else if (!paused && typeof svg.unpauseAnimations === "function") {
          svg.unpauseAnimations();
        }
      } catch (e) {}
    }
  }

  function syncViewport(container, host) {
    if (!container || !host || typeof host.getBoundingClientRect !== "function") return;
    var svg = container.querySelector ? container.querySelector("svg") : null;
    if (!svg) return;
    var hasFlanks = !!(
      svg.querySelector &&
      svg.querySelector(".cdb-flank-l, .cdb-flank-r, .cdb-flank-lt, .cdb-flank-rt, .cdb-pane-c")
    );
    if (!hasFlanks) return;

    var hr = host.getBoundingClientRect();
    var W = hr.width;
    var H = hr.height;
    if (!(W > 40 && H > 40)) return;

    var sidebarPx = 0;
    if (typeof document !== "undefined") {
      var sb = document.querySelector(".dframe-sidebar");
      if (sb && typeof sb.getBoundingClientRect === "function") {
        var sr = sb.getBoundingClientRect();
        if (
          sr.width > 24 &&
          sr.height > H * 0.4 &&
          sr.left <= hr.left + 16 &&
          sr.right > hr.left + 24 &&
          sr.right < hr.right - 160
        ) {
          sidebarPx = Math.max(0, sr.right - hr.left);
        }
      }
    }

    var aspect = clamp(W / H, 0.6, 3.0);
    var vw = Math.round(1000 * aspect);
    var vx = Math.round((1600 - vw) / 2);
    setAttrIfNeeded(svg, "viewBox", vx + " 0 " + vw + " 1000");

    var unitPerPx = vw / W;
    var sidebarUnits = Math.round(sidebarPx * unitPerPx);
    var paneLeft = vx + sidebarUnits;
    var paneRight = vx + vw;
    var paneWidth = Math.max(320, paneRight - paneLeft);
    var paneCenter = Math.round((paneLeft + paneRight) / 2);
    var fScale = clamp(paneWidth / 1180, 0.56, 1.0);
    var topSafeUnits = Math.round(52 * unitPerPx);
    var hudTop = Math.max(0, Math.round(topSafeUnits - fScale * 56));

    setStylePropIfNeeded(svg, "--cdb-flank-lx", paneLeft + "px");
    setStylePropIfNeeded(svg, "--cdb-flank-rx", (paneRight - 1600) + "px");
    setStylePropIfNeeded(svg, "--cdb-pane-cx", (paneCenter - 800) + "px");
    setStylePropIfNeeded(svg, "--cdb-flank-scale", fScale.toFixed(3));
    setStylePropIfNeeded(svg, "--cdb-hud-top", hudTop + "px");
  }

  function sweep() {
    var spec = state.spec;
    if (!spec || typeof spec !== "object" || typeof spec.svg !== "string" || !spec.svg) {
      removeBackdropNodes();
      return false;
    }
    var root = findFrameRoot();
    var host = findBackdropHost();
    if (!root || !host) return false;

    var dark = isDarkMode();
    var modeStr = dark ? "dark" : "light";
    var rawSvg =
      (!dark && typeof spec.lightSvg === "string" && spec.lightSvg) ||
      (dark && typeof spec.darkSvg === "string" && spec.darkSvg) ||
      spec.svg;
    var svgMarkup = sanitizeSvg(rawSvg);
    if (!svgMarkup) {
      removeBackdropNodes();
      return false;
    }

    // Remove any orphaned backdrop nodes outside the current host
    var existingAll = document.querySelectorAll("[" + ATTR_OWNED + "]");
    var existing = null;
    for (var i = 0; i < existingAll.length; i++) {
      if (existingAll[i].parentNode === host && !existing) {
        existing = existingAll[i];
      } else if (existingAll[i].parentNode) {
        existingAll[i].parentNode.removeChild(existingAll[i]);
      }
    }

    var svgKey = (spec.id || "custom") + ":" + modeStr + ":" + svgMarkup.length;
    if (!existing) {
      existing = document.createElement("div");
      existing.setAttribute("aria-hidden", "true");
      existing.setAttribute("inert", "");
      existing.setAttribute("data-engine-backdrop", spec.id || "custom");
      existing.setAttribute(ATTR_OWNED, String(VERSION));
      existing.className = "pointer-events-none absolute inset-0 -z-10 overflow-hidden";
      existing.innerHTML = svgMarkup;
      if (host.firstChild) {
        host.insertBefore(existing, host.firstChild);
      } else {
        host.appendChild(existing);
      }
      state.lastSvgKey = svgKey;
    } else if (state.lastSvgKey !== svgKey) {
      existing.setAttribute("data-engine-backdrop", spec.id || "custom");
      existing.innerHTML = svgMarkup;
      state.lastSvgKey = svgKey;
    }

    syncPauseState(existing);
    syncViewport(existing, host);
    syncResizeObservers(host);

    setAttrIfNeeded(root, "data-engine-backdrop-on", "");
    var g = spec.glass;
    if (g && typeof g === "object" && !prefersReducedTransparency()) {
      setAttrIfNeeded(root, "data-engine-glass", "");
      var blurPx = clamp(typeof g.blur === "number" ? g.blur : 14, 0, 24);
      var opacityVal = clamp(typeof g.opacity === "number" ? g.opacity : 0.38, 0.08, 0.88);
      setStylePropIfNeeded(root, "--engine-glass-blur", blurPx + "px");
      setStylePropIfNeeded(root, "--engine-glass-opacity", String(opacityVal));

      var tint = (!dark && typeof g.lightTint === "string" && g.lightTint)
        ? g.lightTint
        : (typeof g.tint === "string" && g.tint ? g.tint : "");
      var lum = parseHexLuminance(tint);
      // WCAG 0.179 luminance threshold: a dark tint behaves well on dark mode,
      // and a light tint behaves well on light mode.
      var suited = lum !== null ? (dark ? lum <= 0.179 : lum > 0.179) : false;
      if (suited && tint) {
        removeAttrIfNeeded(root, "data-engine-glass-unsuited");
        setStylePropIfNeeded(root, "--engine-glass-tint", tint);
      } else {
        setAttrIfNeeded(root, "data-engine-glass-unsuited", "");
        removeStylePropIfNeeded(root, "--engine-glass-tint");
      }
    } else {
      removeAttrIfNeeded(root, "data-engine-glass");
      removeAttrIfNeeded(root, "data-engine-glass-unsuited");
      removeStylePropIfNeeded(root, "--engine-glass-blur");
      removeStylePropIfNeeded(root, "--engine-glass-opacity");
      removeStylePropIfNeeded(root, "--engine-glass-tint");
    }
    state.lastMode = modeStr;
    return true;
  }

  function scheduleSweep() {
    if (!state.spec) return;
    if (typeof requestAnimationFrame === "function") {
      if (state.rafId) return;
      state.rafId = requestAnimationFrame(function () {
        state.rafId = 0;
        sweep();
      });
    } else {
      sweep();
    }
  }

  function syncResizeObservers(host) {
    if (typeof ResizeObserver !== "function" || !state.spec) return;
    if (!state.ro) {
      state.ro = new ResizeObserver(function () {
        scheduleSweep();
      });
    }
    if (host && host !== state.roHost) {
      if (state.roHost) {
        try { state.ro.unobserve(state.roHost); } catch (e) {}
      }
      state.roHost = host;
      try { state.ro.observe(host); } catch (e) {}
    }
    var sb = typeof document !== "undefined" ? document.querySelector(".dframe-sidebar") : null;
    if (sb !== state.roSidebar) {
      if (state.roSidebar) {
        try { state.ro.unobserve(state.roSidebar); } catch (e) {}
      }
      state.roSidebar = sb;
      if (sb) {
        try { state.ro.observe(sb); } catch (e) {}
      }
    }
  }

  function ensureObservers() {
    if (typeof document !== "undefined" && !state.visHandler && document.addEventListener) {
      state.visHandler = function () {
        scheduleSweep();
      };
      document.addEventListener("visibilitychange", state.visHandler);
    }
    if (typeof window !== "undefined" && !state.resizeHandler && window.addEventListener) {
      state.resizeHandler = function () {
        scheduleSweep();
      };
      window.addEventListener("resize", state.resizeHandler);
    }
    syncResizeObservers(findBackdropHost());
    if (typeof MutationObserver !== "function" || typeof document === "undefined") return;
    if (!state.moDoc && document.documentElement) {
      state.moDoc = new MutationObserver(function () {
        scheduleSweep();
      });
      state.moDoc.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-mode", "class", "data-software-compositing"]
      });
    }
    if (!state.moBody && document.body) {
      state.moBody = new MutationObserver(function (mutations) {
        var host = findBackdropHost();
        if (!host) return;
        var hasOwn = host.querySelector("[" + ATTR_OWNED + "]");
        if (!hasOwn) {
          scheduleSweep();
          return;
        }
        var root = findFrameRoot();
        if (root && !root.hasAttribute("data-engine-backdrop-on")) {
          scheduleSweep();
          return;
        }
        for (var i = 0; i < mutations.length; i++) {
          var t = mutations[i].target;
          if (
            t &&
            t.classList &&
            (t.classList.contains("dframe-root") ||
              t.classList.contains("dframe-content") ||
              t.classList.contains("dframe-sidebar"))
          ) {
            scheduleSweep();
            return;
          }
        }
      });
      state.moBody.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "data-mode"]
      });
    }
  }

  function restore() {
    state.spec = null;
    disconnectObservers();
    return removeBackdropNodes();
  }

  function apply(nextSpec) {
    if (!nextSpec || typeof nextSpec !== "object" || typeof nextSpec.svg !== "string" || !nextSpec.svg) {
      restore();
      if (window.__cdbBackdrop) window.__cdbBackdrop.spec = null;
      return false;
    }
    state.spec = nextSpec;
    if (window.__cdbBackdrop) window.__cdbBackdrop.spec = nextSpec;
    var ok = sweep();
    ensureObservers();
    return ok;
  }

  if (typeof window !== "undefined") {
    window.__cdbBackdropApply = apply;
    window.__cdbBackdrop = {
      version: VERSION,
      spec: state.spec,
      apply: apply,
      restore: restore,
      sweep: sweep,
      disconnect: disconnectObservers
    };
    apply(incoming);
  }
})();

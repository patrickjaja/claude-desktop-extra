"use strict";
// Preload script for installed / standalone Artifact App windows (.vite/build/artifactAppWindow.js).
// Bridges:
//   1. Top frame (https://claude.ai/code/artifact/<uuid>):
//      - window.claudeDesktopArtifactPane + host-tools MessagePort forwarding
//      - bare 'c' keydown suppression
//      - artifact-app:drag-regions fixed overlay matching the embedded iframe
//      - claude.artifactAppWindow.ArtifactAppPage eIPC reporting & report dialog observer
//   2. Direct child artifact subframe (cowork-artifact://...):
//      - reads <script id="claude-artifacts-manifest" type="application/json">
//      - multiplexes all 3 permission tiers over artifact-app:node-apis-call / event
//      - exposes window.__claudeDesktop and window.claudeArtifacts
//      - observes CSS app-region: drag / no-drag rects and reports setDraggableRegions

(function () {
  const electron = require("electron");
  try {
    require("electron/renderer");
  } catch {}

  const { contextBridge, ipcRenderer } = electron;

  const DRAG_CHANNEL = "artifact-app:drag-regions";
  const DRAG_REFRESH_MS = 2000;
  const DRAG_DEBOUNCE_MS = 50;
  const NODE_CALL_CHANNEL = "artifact-app:node-apis-call";
  const NODE_EVENT_CHANNEL = "artifact-app:node-apis-event";
  const MANIFEST_SELECTOR = 'script#claude-artifacts-manifest[type="application/json"]';
  const STREAM_BACKLOG_LIMIT = 2000;
  const REPORT_SELECTOR = "[data-frame-report]";
  const REPORT_LATE_MS = 3000;
  const ABOUT_MAX_LEN = 300;

  const EIPC_PREFIX =
    "$eipc_message$_26b58d90-3929-5bed-e35e-0878011a9cce_$_claude.artifactAppWindow_$_";

  const HOST_CAPS =
    "host-tools comment-mode comments-list report header device-camera device-microphone device-geolocation";
  const HOST_TOOLS_HELLO = "claude-page:host-tools-hello";
  const HOST_TOOLS_PORT = "claude-page:host-tools-port";

  const AUTHOR_KINDS = { Human: "human", Agent: "agent" };
  const NOTICE_KINDS = {
    Disclaimer: "disclaimer",
    Unpublished: "unpublished",
    ByAuthor: "by_author",
    ByAgent: "by_agent",
  };
  const WHEN_KINDS = { Updated: "updated", Created: "created" };
  const DIALOG_STATES = { Late: "late", Open: "open", Closed: "closed" };

  // Direct promise-returning methods exposed on window.__claudeDesktop / window.claudeArtifacts
  const DIRECT_MODULES = [
    ["fs", ["readFile", "writeFile", "appendFile", "readdir", "stat", "lstat", "exists", "mkdir", "rm", "rmdir", "rename", "copyFile", "realpath"]],
    ["os", ["platform", "arch", "info"]],
    ["shell", ["openPath", "showItemInFolder", "trashItem"]],
    ["window", ["setOptions", "getOptions", "place", "show", "hide", "getBounds", "setBounds", "print", "setIgnoreMouseEvents", "setVisibleOnAllWorkspaces"]],
    ["notification", ["show"]],
    ["screen", ["getCursorScreenPoint", "getAllDisplays"]],
    ["install", ["state", "request"]],
  ];
  const OS_INFO_PROPS = ["release", "hostname", "homedir", "tmpdir", "username", "cpus", "totalmem", "uptime"];

  function isIterable(v) {
    return typeof v === "object" && v !== null && Symbol.iterator in v;
  }

  function collectAppRegionSelectors(doc) {
    const selectors = new Set(['[style*="app-region"]']);
    const walkRules = (rules, parentSel) => {
      for (const rule of rules) {
        let sel = parentSel;
        if (typeof CSSStyleRule !== "undefined" && rule instanceof CSSStyleRule) {
          sel = parentSel
            ? rule.selectorText.replaceAll("&", () => `:is(${parentSel})`)
            : rule.selectorText;
          if (rule.style && rule.style.getPropertyValue("app-region")) {
            selectors.add(sel);
          }
        }
        if ("styleSheet" in rule && rule.styleSheet && isIterable(rule.styleSheet.cssRules)) {
          walkSheet(rule.styleSheet);
        } else if ("cssRules" in rule && isIterable(rule.cssRules)) {
          walkRules(rule.cssRules, sel);
        }
      }
    };
    const walkSheet = (sheet) => {
      try {
        walkRules(sheet.cssRules, undefined);
      } catch {}
    };
    for (const s of [...(doc.styleSheets || []), ...(doc.adoptedStyleSheets || [])]) {
      walkSheet(s);
    }
    return [...selectors];
  }

  function measureDragRegions(doc, win, selectors) {
    const sels = selectors || collectAppRegionSelectors(doc);
    const els = new Set();
    for (const sel of sels) {
      try {
        doc.querySelectorAll(sel).forEach((el) => els.add(el));
      } catch {}
    }
    const sorted = [...els].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    const rects = [];
    for (const el of sorted) {
      const cs = win.getComputedStyle(el);
      const region = cs.getPropertyValue("app-region");
      if ((region !== "drag" && region !== "no-drag") || cs.visibility === "hidden" || cs.visibility === "collapse") {
        continue;
      }
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.round(r.left));
      const y = Math.max(0, Math.round(r.top));
      const width = Math.min(win.innerWidth, Math.round(r.right)) - x;
      const height = Math.min(win.innerHeight, Math.round(r.bottom)) - y;
      if (width > 0 && height > 0) {
        rects.push({ x, y, width, height, drag: region === "drag" });
      }
    }
    if (rects.length > 64) {
      const kept = [...rects.filter((r) => !r.drag), ...rects.filter((r) => r.drag)].slice(0, 64);
      kept.sort((a, b) => rects.indexOf(a) - rects.indexOf(b));
      return kept;
    }
    return rects;
  }

  function touchesStyles(mutation) {
    const nodes = [mutation.target, ...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
    return nodes.some(
      (n) =>
        (typeof HTMLStyleElement !== "undefined" && n instanceof HTMLStyleElement) ||
        (typeof HTMLLinkElement !== "undefined" && n instanceof HTMLLinkElement) ||
        (n && n.parentNode && typeof HTMLStyleElement !== "undefined" && n.parentNode instanceof HTMLStyleElement)
    );
  }

  function observeDragRegions(onRegions) {
    let lastJson = "[]";
    let cachedSelectors;
    let timer;

    const flush = (forceWhenNonEmpty = false) => {
      timer = undefined;
      cachedSelectors ??= collectAppRegionSelectors(document);
      const rects = measureDragRegions(document, window, cachedSelectors);
      const json = JSON.stringify(rects);
      if (json !== lastJson || (forceWhenNonEmpty && rects.length > 0)) {
        lastJson = json;
        onRegions(rects);
      }
    };
    const schedule = () => {
      timer ??= setTimeout(flush, DRAG_DEBOUNCE_MS);
    };
    const startObserver = () => {
      new MutationObserver((mutations) => {
        if (mutations.some(touchesStyles)) cachedSelectors = undefined;
        schedule();
      }).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      schedule();
    };

    for (const ev of ["load", "resize", "transitionend", "animationend"]) {
      window.addEventListener(ev, schedule);
    }
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    const periodic = () => {
      cachedSelectors = undefined;
      flush(true);
    };
    setInterval(periodic, DRAG_REFRESH_MS);
    document.addEventListener("visibilitychange", periodic);
    if (document.documentElement) {
      startObserver();
    } else {
      document.addEventListener("DOMContentLoaded", startObserver, { once: true });
    }
  }

  function findArtifactIframe() {
    return (
      document.querySelector("iframe#frame-content") ??
      document.querySelector("#frame-slot > iframe")
    );
  }

  function renderTopDragOverlay(container, regions) {
    const iframe = findArtifactIframe();
    if (!iframe || regions.length === 0) {
      container.replaceChildren();
      container.remove();
      return;
    }
    const rect = iframe.getBoundingClientRect();
    container.style.cssText =
      `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
      `width:${rect.width}px;height:${rect.height}px;overflow:hidden;pointer-events:none;z-index:2147483647`;
    const children = [];
    for (const { x, y, width, height, drag } of regions) {
      const w = Math.min(width, rect.width - x);
      const h = Math.min(height, rect.height - y);
      if (w <= 0 || h <= 0) continue;
      const div = document.createElement("div");
      div.style.cssText =
        `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
        `app-region:${drag ? "drag" : "no-drag"}`;
      children.push(div);
    }
    container.replaceChildren(...children);
    if (!container.isConnected) {
      document.documentElement.append(container);
    }
  }

  function setupTopFrameDragListener(win = window, ipc = ipcRenderer) {
    if (win.self !== win.top) return;
    const container = document.createElement("div");
    let current = [];
    const sync = () => renderTopDragOverlay(container, current);
    ipc.on(DRAG_CHANNEL, (_ev, regions) => {
      current = Array.isArray(regions) ? regions : [];
      sync();
    });
    win.addEventListener("resize", sync);
  }

  function setupSubframeBridge(win = window, ipc = ipcRenderer, expose = (k, v) => contextBridge.exposeInMainWorld(k, v), startDragObserver = observeDragRegions) {
    if (win.self === win.top || win.parent !== win.top) return;

    const streams = new Map();
    let streamSeq = 1;
    let instanceNonce = "00000000";
    try {
      instanceNonce = crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, "0");
    } catch {
      instanceNonce = Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, "0");
    }

    const toError = (err) => {
      if (!err || typeof err !== "object") return Error(String(err ?? "Unknown error"));
      return Error(err.code ? `${err.code}: ${err.message}` : err.message);
    };

    const rawCall = async (mod, method, ...args) => {
      const res = await ipc.invoke(NODE_CALL_CHANNEL, { module: mod, method, args });
      if (!res || !res.ok) throw toError(res && res.error);
      return res.value;
    };

    const readManifest = (doc) => {
      if (!doc) return Promise.resolve(null);
      const read = () => doc.querySelector(MANIFEST_SELECTOR)?.textContent ?? null;
      if (doc.readyState === "loading") {
        return new Promise((resolve) => {
          doc.addEventListener("DOMContentLoaded", () => resolve(read()), { once: true });
        });
      }
      return Promise.resolve(read());
    };

    let manifestReady = readManifest(win.document)
      .then((text) => rawCall("permissions", "declare", text))
      .catch((err) => {
        console.warn("claude-artifacts-manifest:", err);
      })
      .finally(() => {
        manifestReady = undefined;
      });

    const call = (...args) =>
      manifestReady ? manifestReady.then(() => rawCall(...args)) : rawCall(...args);

    const decodeEventArgs = ({ event, payload }) => {
      if (event === "exit") {
        const { code, signal, exitCode } = payload || {};
        return exitCode === undefined ? [code, signal] : [{ exitCode }];
      }
      if (event === "error") return [toError(payload)];
      return [payload];
    };

    const emitToStream = (entry, msg) => {
      const listeners = entry.listeners.get(msg.event);
      if (!listeners || listeners.size === 0) return false;
      for (const fn of [...listeners]) {
        try {
          fn(...decodeEventArgs(msg));
        } catch (err) {
          console.error(err);
        }
      }
      return true;
    };

    const gcStream = (id, entry) => {
      if (entry.ended && entry.backlog.size === 0) streams.delete(id);
    };

    const handleStreamEvent = (msg) => {
      const entry = streams.get(msg.id);
      if (!entry) return;
      const terminal = msg.event === "exit" || msg.event === "error";
      if (emitToStream(entry, msg)) {
        entry.ended ||= terminal;
      } else {
        const q = entry.backlog.get(msg.event) ?? [];
        if (q.length < STREAM_BACKLOG_LIMIT) {
          entry.backlog.set(msg.event, [...q, msg]);
        }
      }
      gcStream(msg.id, entry);
    };

    const subscribeStream = (id, event, cb) => {
      const entry = streams.get(id);
      if (!entry) return;
      const set = entry.listeners.get(event) ?? new Set();
      set.add(cb);
      entry.listeners.set(event, set);
      const pending = entry.backlog.get(event) ?? [];
      entry.backlog.delete(event);
      for (const msg of pending) {
        emitToStream(entry, msg);
        entry.ended ||= event === "exit" || event === "error";
      }
      gcStream(id, entry);
    };

    const createStream = (kind, initial = []) => {
      const id = `${instanceNonce}-${kind}-${streamSeq++}`;
      streams.set(id, {
        listeners: new Map(initial.map(([ev, fn]) => [ev, new Set([fn])])),
        backlog: new Map(),
        ended: false,
      });
      return id;
    };

    const cleanupOnReject = (id, promise) =>
      promise.catch((err) => {
        streams.delete(id);
        throw err;
      });

    const makeSlotTracker = () => {
      let currentId;
      return (nextId) => {
        if (currentId !== undefined) streams.delete(currentId);
        currentId = nextId;
      };
    };

    const startProcess = (mod, spawnArgs) => {
      const id = createStream(mod);
      const pid = call(mod, "spawn", id, ...spawnArgs).then(
        (res) => res.pid,
        (err) => {
          handleStreamEvent({
            id,
            event: "error",
            payload: { message: err instanceof Error ? err.message : "" },
          });
          return null;
        }
      );
      const onceStarted = (method, ...args) => pid.then(() => call(mod, method, id, ...args));
      return { id, pid, onceStarted };
    };

    const encodeMenuItems = (items, callbacks) => {
      if (!Array.isArray(items)) {
        throw TypeError("A menu template is an array of menu items.");
      }
      return items.map((item) => {
        const { click, submenu, ...rest } = item;
        const clickId = `c${callbacks.size + 1}`;
        if (typeof click === "function") {
          callbacks.set(clickId, (...args) => Reflect.apply(click, undefined, args));
        }
        return {
          ...rest,
          ...(typeof click === "function" ? { click: clickId } : {}),
          ...(submenu === undefined ? {} : { submenu: encodeMenuItems(submenu, callbacks) }),
        };
      });
    };

    const prepareMenuStream = (items, kind = "Menu", extraHandlers = []) => {
      const callbacks = new Map();
      const encoded = encodeMenuItems(items, callbacks);
      const id = createStream(kind, [
        [
          "click",
          (ev) => {
            const { item: clickId, ...info } = ev;
            callbacks.get(clickId)?.(info);
          },
        ],
        ...extraHandlers,
      ]);
      return { id, items: encoded };
    };

    ipc.on(NODE_EVENT_CHANNEL, (_ev, msg) => {
      handleStreamEvent(msg);
    });

    const directApi = Object.fromEntries(
      DIRECT_MODULES.map(([mod, methods]) => [
        mod,
        Object.fromEntries(
          methods.map((method) => [method, (...args) => call(mod, method, ...args)])
        ),
      ])
    );

    const setAppMenuSlot = makeSlotTracker();
    const setTraySlot = makeSlotTracker();
    const shortcutIds = new Map();
    const dropShortcut = (accel) => {
      const id = shortcutIds.get(accel);
      if (id !== undefined) streams.delete(id);
      shortcutIds.delete(accel);
    };

    const desktopApi = {
      ...directApi,
      childProcess: {
        exec: (cmd, opts) => call("childProcess", "exec", cmd, opts),
        spawn: (cmd, args, opts) => {
          const { id, pid, onceStarted } = startProcess("childProcess", [cmd, args, opts]);
          const onPipe = (pipe) => (ev, cb) => {
            if (ev === "data") subscribeStream(id, pipe, cb);
          };
          return {
            pid,
            stdout: { on: onPipe("stdout") },
            stderr: { on: onPipe("stderr") },
            stdin: {
              write: (chunk) => onceStarted("write", chunk),
              end: () => onceStarted("end"),
            },
            on: (ev, cb) => {
              if (ev === "exit" || ev === "close" || ev === "error") {
                subscribeStream(id, ev === "close" ? "exit" : ev, cb);
              }
            },
            kill: (sig) => onceStarted("kill", sig),
          };
        },
      },
      pty: {
        spawn: (file, args, opts) => {
          const { id, pid, onceStarted } = startProcess("pty", [file, args, opts]);
          return {
            pid,
            onData: (cb) => subscribeStream(id, "data", cb),
            onExit: (cb) => subscribeStream(id, "exit", cb),
            onError: (cb) => subscribeStream(id, "error", cb),
            write: (data) => onceStarted("write", data),
            resize: (cols, rows) => onceStarted("resize", cols, rows),
            kill: () => onceStarted("kill"),
          };
        },
      },
      os: {
        ...Object.fromEntries(
          OS_INFO_PROPS.map((prop) => [prop, async () => (await call("os", "info"))[prop]])
        ),
        ...directApi.os,
      },
      globalShortcut: {
        register: async (accel, cb) => {
          const id = createStream("globalShortcut", [["pressed", () => cb()]]);
          const ok = await cleanupOnReject(id, call("globalShortcut", "register", id, accel));
          if (ok === true) {
            dropShortcut(accel);
            shortcutIds.set(accel, id);
          } else {
            streams.delete(id);
          }
          return ok;
        },
        unregister: async (accel) => {
          await call("globalShortcut", "unregister", accel);
          dropShortcut(accel);
        },
        unregisterAll: async () => {
          await call("globalShortcut", "unregisterAll");
          [...shortcutIds.keys()].forEach(dropShortcut);
        },
      },
      Menu: {
        setApplicationMenu: async (template) => {
          if (template == null) {
            const res = await call("Menu", "setApplicationMenu", null);
            setAppMenuSlot(undefined);
            return res;
          }
          const { id, items } = prepareMenuStream(template);
          const res = await cleanupOnReject(id, call("Menu", "setApplicationMenu", id, items));
          setAppMenuSlot(id);
          return res;
        },
        popup: async (template) => {
          const { id, items } = prepareMenuStream(template);
          try {
            await call("Menu", "popup", id, items);
          } finally {
            streams.delete(id);
          }
        },
      },
      app: {
        dock: {
          setIcon: (dataUrl) => call("app", "setDockIcon", dataUrl),
          setBadge: (text) => call("app", "setDockBadge", text),
          setProgress: async () => false,
          setMenu: async () => false,
        },
      },
      tray: {
        set: async (opts) => {
          const { menu, click, ...rest } = typeof opts === "object" && opts ? opts : {};
          const { id, items } = prepareMenuStream(menu ?? [], "tray", [
            [
              "pressed",
              () => {
                if (typeof click === "function") Reflect.apply(click, undefined, []);
              },
            ],
          ]);
          const payload = {
            ...rest,
            ...(menu === undefined ? {} : { menu: menu === null ? null : items }),
          };
          const res = await cleanupOnReject(id, call("tray", "set", id, payload));
          setTraySlot(id);
          return res;
        },
        remove: async () => {
          await call("tray", "remove");
          setTraySlot(undefined);
        },
      },
      permissions: {
        state: (perm) => call("permissions", "state", ...(perm === undefined ? [] : [perm])),
        request: (perms) => call("permissions", "request", ...(perms === undefined ? [] : [perms])),
        manage: () => call("permissions", "manage"),
      },
    };

    expose("__claudeDesktop", desktopApi);
    expose("claudeArtifacts", desktopApi);

    startDragObserver((regions) => {
      call("window", "setDraggableRegions", regions).catch(() => undefined);
    });
  }

  function setupTopFramePageBridge(win = window, ipc = ipcRenderer, expose = (k, v) => contextBridge.exposeInMainWorld(k, v)) {
    if (win.self !== win.top) return;

    const PageIpc = {
      reportArtifactGone(uuid, gone) {
        return ipc.invoke(EIPC_PREFIX + "ArtifactAppPage_$_reportArtifactGone", uuid, gone);
      },
      reportOffered(uuid, offered) {
        return ipc.invoke(EIPC_PREFIX + "ArtifactAppPage_$_reportOffered", uuid, offered);
      },
      reportDialogState(pick, state) {
        return ipc.invoke(EIPC_PREFIX + "ArtifactAppPage_$_reportDialogState", pick, state);
      },
      onOpenReport(cb) {
        const listener = (_ev, pick) => cb(pick);
        const ch = EIPC_PREFIX + "ArtifactAppPage_$_openReport";
        ipc.on(ch, listener);
        return () => ipc.removeListener(ch, listener);
      },
      reportAbout(uuid, about) {
        return ipc.invoke(EIPC_PREFIX + "ArtifactAppPage_$_reportAbout", uuid, about);
      },
    };

    const clampStr = (v) => (typeof v === "string" ? v.slice(0, ABOUT_MAX_LEN) : undefined);
    const pickEnum = (enumObj, val) => Object.values(enumObj).find((x) => x === val);

    let lastAboutJson = "";
    const handleHeader = (msg) => {
      if (msg.v !== 2) return;
      const authorKind = pickEnum(AUTHOR_KINDS, msg.about?.author?.kind);
      const whenKind = pickEnum(WHEN_KINDS, msg.about?.when?.kind);
      const whenAt = clampStr(msg.about?.when?.at);
      const about = {
        title: clampStr(msg.title) ?? "",
        author: authorKind && {
          kind: authorKind,
          name: clampStr(msg.about?.author?.name),
          self: msg.about?.author?.self === true,
          channel: clampStr(msg.about?.author?.channel),
        },
        when:
          whenKind && whenAt !== undefined
            ? { kind: whenKind, at: whenAt }
            : undefined,
        notice: pickEnum(NOTICE_KINDS, msg.notice?.kind),
      };
      const serialized = JSON.stringify([msg.uuid, about]);
      if (serialized !== lastAboutJson) {
        lastAboutJson = serialized;
        PageIpc.reportAbout(msg.uuid, about).catch(() => undefined);
      }
    };

    let stopReportObserver;
    const observeReportDialog = (pick) => {
      stopReportObserver?.();
      let opened = false;
      const notify = (state) => PageIpc.reportDialogState(pick, state).catch(() => undefined);
      const check = () => {
        const isOpen = !!win.document.querySelector(`${REPORT_SELECTOR}:not([data-closed])`);
        if (opened !== isOpen) {
          if (opened) {
            stop();
            notify(DIALOG_STATES.Closed);
          } else {
            opened = true;
            clearTimeout(lateTimer);
            notify(DIALOG_STATES.Open);
          }
        }
      };
      const observer = new MutationObserver(check);
      const lateTimer = setTimeout(() => notify(DIALOG_STATES.Late), REPORT_LATE_MS);
      const stop = () => {
        observer.disconnect();
        clearTimeout(lateTimer);
      };
      stopReportObserver = stop;
      observer.observe(win.document.documentElement, {
        attributeFilter: ["data-closed"],
        childList: true,
        subtree: true,
      });
      check();
    };

    PageIpc.onOpenReport((pick) => {
      win.postMessage({ __frame_chrome: true, cmd: "open", dialog: "report" }, win.location.origin);
      observeReportDialog(pick);
    });

    win.addEventListener("message", (ev) => {
      if (ev.source !== win || ev.origin !== win.location.origin) return;
      const data = ev.data;
      if (!data) return;
      if (data.__frame_chrome_state === true && typeof data.uuid === "string") {
        if (data.state === "header") handleHeader(data);
        else if (data.state === "access") {
          PageIpc.reportOffered(data.uuid, data.canReport === true).catch(() => undefined);
        } else if (data.state === "revealed" || (data.state === "failed" && data.pane === "n")) {
          PageIpc.reportArtifactGone(data.uuid, data.state === "failed").catch(() => undefined);
        }
        return;
      }
      if (data.__frame_host === true && data.kind === "hello" && data.v === 1) {
        ipc.send(HOST_TOOLS_HELLO);
      }
    });

    ipc.on(HOST_TOOLS_PORT, (ev) => {
      const port = ev.ports && ev.ports[0];
      if (port) {
        win.postMessage({ __frame_host: true, kind: "port", v: 1 }, win.location.origin, [port]);
      }
    });

    expose("claudeDesktopArtifactPane", {
      embedded: true,
      platform: "desktop",
      chrome: "none",
      hostcaps: HOST_CAPS,
    });

    win.addEventListener(
      "keydown",
      (ev) => {
        if (ev.key && ev.key.toLowerCase() === "c" && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          ev.stopImmediatePropagation();
        }
      },
      true
    );
  }

  if (typeof window !== "undefined" && window.isSecureContext) {
    setupTopFramePageBridge();
    setupSubframeBridge();
    setupTopFrameDragListener();
  }
})();

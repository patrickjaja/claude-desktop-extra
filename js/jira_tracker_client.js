;/*__CDB_JIRA_CLIENT__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  var GATEWAY_HOST = "api.atlassian.com";
  var SITE_RE = /^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net\/?$/;
  var CLOUD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  var MAX_CONCURRENT = 4, TIMEOUT_MS = 15000, RETRY_CAP_MS = 30000, RETRY_DEFAULT_MS = 2000, PAGE_SIZE = 50;
  var LIST_FIELDS = ["summary", "status", "assignee", "priority", "issuetype", "project", "updated", "subtasks"];
  var DETAIL_FIELDS = ["summary", "status", "assignee", "priority", "issuetype", "project", "description", "updated", "labels", "reporter", "fixVersions", "parent", "duedate", "created", "attachment", "subtasks"];
  var ATTACHMENT_ID_RE = /^\d{1,20}$/, MAX_ATTACHMENTS = 100;
  var KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
  var PROJECT_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
  var CATEGORY = { new: "todo", indeterminate: "inprogress", done: "done" };
  var USER_AGENT = "claude-desktop-extra";

  function str(v) { return typeof v === "string" ? v : ""; }
  function origin(site) { return String(site).replace(/\/$/, ""); }
  function category(statusCategory) { return CATEGORY[(statusCategory && statusCategory.key) || ""] || "todo"; }

  function create(deps) {
    var fetchFn = deps.fetch;
    var now = deps.now || Date.now;
    var sleep = deps.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var log = deps.log || function () {};
    var saveRoute = deps.saveRoute || function () {};
    var timeoutMs = deps.timeoutMs || TIMEOUT_MS;
    var running = 0, waiting = [];

    function acquire() {
      if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
      return new Promise(function (resolve) { waiting.push(resolve); });
    }
    function release() {
      var next = waiting.shift();
      if (next) next(); else running--;
    }
    function basic(c) { return "Basic " + Buffer.from(c.email + ":" + c.token, "utf8").toString("base64"); }
    function scrub(text, c) {
      var out = String(text || "");
      [c && c.token, c && c.email, c && c.email && c.token ? basic(c) : ""].forEach(function (secret) {
        if (secret) out = out.split(secret).join("[redacted]");
      });
      return out.slice(0, 500);
    }
    function valid(c) {
      return !!c && SITE_RE.test(str(c.site)) && !!str(c.email) && !!str(c.token);
    }
    function allowed(url, c) {
      var u;
      try { u = new URL(url); } catch (e) { return false; }
      if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
      return u.host === new URL(c.site).host || u.host === GATEWAY_HOST;
    }
    function base(c) { return c.route === "gateway" ? "https://" + GATEWAY_HOST + "/ex/jira/" + c.cloudId : origin(c.site); }
    function retryMs(header) {
      var h = header == null ? "" : String(header).trim();
      if (/^\d+$/.test(h)) return Math.min(RETRY_CAP_MS, Number(h) * 1000);
      var at = Date.parse(h);
      return isFinite(at) ? Math.min(RETRY_CAP_MS, Math.max(0, at - now())) : RETRY_DEFAULT_MS;
    }
    function shown(method, url) { return method + " " + String(url).replace(/^https:\/\/[^/]+/, "").replace(/[?#].*$/, "").replace(/\/[A-Z][A-Z0-9_]+-\d+(?=\/|$)/, "/<key>"); }

    async function raw(c, method, url, body, auth, cap) {
      if (!allowed(url, c)) return { status: 0, kind: "host" };
      await acquire();
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, timeoutMs);
      try {
        var headers = { accept: "application/json", "user-agent": USER_AGENT };
        if (auth) headers.authorization = basic(c);
        if (body !== undefined) headers["content-type"] = "application/json";
        var res = await fetchFn(url, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: ctl.signal });
        if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
          log(shown(method, url) + " -> redirect refused");
          return { status: res.status || 302, kind: "redirect" };
        }
        if (cap && res.status >= 200 && res.status < 300) {
          var declared = Number(res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : NaN);
          if (isFinite(declared) && declared > cap) { log(shown(method, url) + " -> too big"); return { status: res.status, kind: "tooBig" }; }
          var buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > cap) { log(shown(method, url) + " -> too big"); return { status: res.status, kind: "tooBig" }; }
          log(shown(method, url) + " -> " + res.status);
          return { status: res.status, ok: true, bytes: buf, type: res.headers && typeof res.headers.get === "function" ? str(res.headers.get("content-type")) : "" };
        }
        var text = await res.text();
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        log(shown(method, url) + " -> " + res.status);
        return { status: res.status, ok: res.status >= 200 && res.status < 300, json: json, retryAfter: res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null };
      } catch (e) {
        var timedOut = !!(e && e.name === "AbortError");
        log(shown(method, url) + " -> " + (timedOut ? "timeout" : "network error"));
        return { status: 0, kind: timedOut ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
        release();
      }
    }
    async function once(c, method, url, body, cap) {
      var r = await raw(c, method, url, body, true, cap);
      if (r.status !== 429) return r;
      await sleep(retryMs(r.retryAfter));
      r = await raw(c, method, url, body, true, cap);
      if (r.status === 429) r.kind = "busy";
      return r;
    }
    async function tenant(c) {
      var r = await raw(c, "GET", origin(c.site) + "/_edge/tenant_info", undefined, false);
      var id = r.ok && r.json ? str(r.json.cloudId) : "";
      return CLOUD_ID_RE.test(id) ? id : "";
    }
    async function detect(c) {
      var site = await once(c, "GET", origin(c.site) + "/rest/api/3/myself");
      if (site.ok) return { route: "site", cloudId: "" };
      if (site.status !== 401) return { fail: site };
      var cloudId = await tenant(c);
      if (!cloudId) return { fail: site };
      var gw = await once(c, "GET", "https://" + GATEWAY_HOST + "/ex/jira/" + cloudId + "/rest/api/3/myself");
      return gw.ok ? { route: "gateway", cloudId: cloudId } : { fail: gw };
    }
    function adopt(c, d) {
      if (c.route === d.route && c.cloudId === d.cloudId) return;
      c.route = d.route;
      c.cloudId = d.cloudId;
      saveRoute(d.route, d.cloudId);
    }
    function jiraMessages(j) {
      var list = [];
      if (j && Array.isArray(j.errorMessages)) list = list.concat(j.errorMessages);
      if (j && j.errors && typeof j.errors === "object") Object.keys(j.errors).forEach(function (k) { list.push(j.errors[k]); });
      return list.filter(function (s) { return typeof s === "string" && s; }).join(" ");
    }
    function failure(r, c) {
      var s = r.status || 0;
      var kind = r.kind === "host" || r.kind === "redirect" || r.kind === "config" || r.kind === "busy" || r.kind === "tooBig" ? r.kind
        : s === 401 ? "auth" : s === 403 ? "forbidden" : s === 404 ? "notFound" : s === 400 ? "badRequest"
        : s === 0 || s >= 500 ? "unavailable" : "unknown";
      var message = {
        config: "Jira is not set up. Add the site, email and API token in Settings.",
        host: "Refused a request outside the configured Jira site.",
        redirect: "Jira answered with a redirect, which is refused.",
        auth: "Jira rejected the email or token.",
        forbidden: "Jira refused this for your account (HTTP 403). A scoped API token needs the scopes listed in the Jira tracker docs.",
        notFound: "Not found, or you have no access.",
        badRequest: jiraMessages(r.json) || "Jira refused the request (HTTP 400).",
        busy: "Jira is limiting requests right now. Try again in a moment.",
        tooBig: "The file is too large to show here.",
        unavailable: r.kind === "timeout" ? "Jira did not answer within " + Math.round(timeoutMs / 1000) + " s." : s ? "Jira had a server error (HTTP " + s + ")." : "Could not reach Jira.",
        unknown: "Jira answered HTTP " + s + "."
      }[kind];
      return { ok: false, status: s, kind: kind, retry: kind === "unavailable" || kind === "busy", message: scrub(message, c) };
    }
    function withDetail(f, r, c) {
      var s = r.status || 0, why = s >= 400 && s < 500 && r.json ? str(r.json.message) || jiraMessages(r.json) : "";
      if (why) f.detail = scrub(why, c).replace(/https?:\/\/\S+/g, "<url>").replace(/[^\s@<>]+@[^\s@<>]+/g, "<email>").replace(/\b[A-Z][A-Z0-9_]+-\d+\b/g, "<key>").replace(/\s+/g, " ").trim().slice(0, 200);
      return f;
    }
    async function call(creds, method, path, body, cap, scoped) {
      if (!valid(creds)) return failure({ status: 0, kind: "config" }, creds);
      var c = { site: creds.site, email: creds.email, token: creds.token, route: str(creds.route), cloudId: str(creds.cloudId) };
      var detected = false;
      if (!(c.route === "site" || (c.route === "gateway" && CLOUD_ID_RE.test(c.cloudId)))) {
        var d = await detect(c);
        if (d.fail) return failure(d.fail, c);
        adopt(c, d);
        detected = true;
      }
      var r = await once(c, method, base(c) + path, body, cap);
      if (r.status === 401 && !detected && !scoped) {
        var again = await detect(c);
        if (again.fail) return failure(again.fail, c);
        adopt(c, again);
        r = await once(c, method, base(c) + path, body, cap);
      }
      if (r.ok && cap) return { ok: true, status: r.status, bytes: r.bytes, type: r.type };
      if (r.ok) return { ok: true, status: r.status, json: r.json, route: c.route };
      return scoped ? withDetail(failure(r, c), r, c) : failure(r, c);
    }

    function record(issue, site) {
      var f = (issue && issue.fields) || {};
      var st = f.status || {};
      var key = str(issue && issue.key);
      return {
        key: key, summary: str(f.summary), status: str(st.name), statusId: str(st.id), category: category(st.statusCategory),
        type: str(f.issuetype && f.issuetype.name), priority: str(f.priority && f.priority.name),
        assignee: str(f.assignee && f.assignee.displayName), project: str(f.project && f.project.key), updated: str(f.updated),
        labels: Array.isArray(f.labels) ? f.labels.filter(function (l) { return typeof l === "string"; }).slice(0, 20) : [],
        subtasks: (Array.isArray(f.subtasks) ? f.subtasks : []).filter(function (x) { return x && KEY_RE.test(str(x.key)); }).slice(0, 100).map(function (x) {
          var sf = x.fields || {}, ss = sf.status || {};
          return { key: x.key, summary: str(sf.summary), status: str(ss.name), statusId: str(ss.id), category: category(ss.statusCategory), type: str(sf.issuetype && sf.issuetype.name) };
        }),
        url: origin(site) + "/browse/" + encodeURIComponent(key)
      };
    }
    function attachmentsOf(list) {
      return (Array.isArray(list) ? list : []).filter(function (a) { return a && ATTACHMENT_ID_RE.test(str(a.id)); }).slice(0, MAX_ATTACHMENTS).map(function (a) {
        return { id: a.id, filename: str(a.filename) || "attachment", mimeType: str(a.mimeType), size: typeof a.size === "number" && a.size >= 0 ? a.size : 0, thumbnail: !!str(a.thumbnail) };
      });
    }
    function detailed(issue, site) {
      var f = (issue && issue.fields) || {}, rec = record(issue, site), p = f.parent;
      rec.reporter = str(f.reporter && f.reporter.displayName);
      rec.fixVersions = (Array.isArray(f.fixVersions) ? f.fixVersions : []).map(function (v) { return str(v && v.name); }).filter(Boolean).slice(0, 20);
      rec.parent = p && KEY_RE.test(str(p.key)) ? { key: p.key, summary: str(p.fields && p.fields.summary) } : null;
      rec.due = str(f.duedate);
      rec.created = str(f.created);
      rec.attachments = attachmentsOf(f.attachment);
      return rec;
    }
    function transitionOf(t) {
      var fields = t && t.fields && typeof t.fields === "object" ? t.fields : {};
      var to = (t && t.to) || {};
      return {
        id: String(t && t.id), name: str(t && t.name), toStatus: str(to.name), toStatusId: str(to.id), toCategory: category(to.statusCategory),
        needsFields: Object.keys(fields).some(function (k) { var f = fields[k]; return !!f && f.required === true && f.hasDefaultValue !== true; })
      };
    }
    function issuePath(key) { return "/rest/api/3/issue/" + encodeURIComponent(key); }

    async function myself(c) {
      var r = await call(c, "GET", "/rest/api/3/myself");
      return r.ok ? { ok: true, displayName: str(r.json && r.json.displayName), route: r.route } : r;
    }
    async function probeSearch(c, jql) {
      var r = await call(c, "POST", "/rest/api/3/search/jql", { jql: jql, fields: ["project"], maxResults: PAGE_SIZE }, 0, true);
      if (!r.ok) return r;
      var list = r.json && Array.isArray(r.json.issues) ? r.json.issues : [];
      return { ok: true, records: list.filter(function (i) { return i && KEY_RE.test(str(i.key)); }).map(function (i) { return { key: i.key, project: str(i.fields && i.fields.project && i.fields.project.key) }; }) };
    }
    async function search(c, jql, nextPageToken) {
      var body = { jql: jql, fields: LIST_FIELDS, maxResults: PAGE_SIZE };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      var r = await call(c, "POST", "/rest/api/3/search/jql", body);
      if (!r.ok) return r;
      var j = r.json || {};
      return { ok: true, records: (Array.isArray(j.issues) ? j.issues : []).map(function (i) { return record(i, c.site); }), nextPageToken: str(j.nextPageToken) };
    }
    async function children(c, keys) {
      var list = keysOf(keys);
      if (!list.length) return { ok: true, records: [] };
      var r = await call(c, "POST", "/rest/api/3/search/jql", { jql: "key in (" + list.join(", ") + ") ORDER BY key ASC", fields: LIST_FIELDS, maxResults: list.length });
      if (!r.ok) return r;
      return { ok: true, records: (r.json && Array.isArray(r.json.issues) ? r.json.issues : []).map(function (i) { return record(i, c.site); }) };
    }
    async function sprintKeys(c, keys) {
      var list = (Array.isArray(keys) ? keys : []).filter(function (k, i, a) { return KEY_RE.test(str(k)) && a.indexOf(k) === i; }).slice(0, PAGE_SIZE);
      if (!list.length) return { ok: true, keys: [] };
      var r = await call(c, "POST", "/rest/api/3/search/jql", { jql: "key in (" + list.join(", ") + ") AND sprint in openSprints()", fields: ["key"], maxResults: list.length });
      if (!r.ok) return r;
      var found = (r.json && Array.isArray(r.json.issues) ? r.json.issues : []).map(function (i) { return str(i && i.key); }).filter(function (k) { return KEY_RE.test(k); });
      return { ok: true, keys: found };
    }
    function boardId(id) { return typeof id === "number" && isFinite(id) && id > 0 && Math.floor(id) === id; }
    function local(message) { return { ok: false, status: 0, kind: "badRequest", retry: false, message: message }; }
    function keysOf(keys) { return (Array.isArray(keys) ? keys : []).filter(function (k, i, a) { return KEY_RE.test(str(k)) && a.indexOf(k) === i; }).slice(0, PAGE_SIZE); }
    async function boards(c, project) {
      if (!PROJECT_RE.test(str(project))) return local("bad project key");
      var r = await call(c, "GET", "/rest/agile/1.0/board?projectKeyOrId=" + project + "&maxResults=50", undefined, 0, true);
      if (!r.ok) return r;
      var list = r.json && Array.isArray(r.json.values) ? r.json.values : [];
      return { ok: true, boards: list.filter(function (b) { return b && boardId(b.id); }).map(function (b) { return { id: b.id, name: str(b.name), type: str(b.type) }; }) };
    }
    async function backlogKeys(c, board, keys) {
      if (!boardId(board)) return local("bad board id");
      var list = keysOf(keys);
      if (!list.length) return { ok: true, keys: [] };
      var r = await call(c, "GET", "/rest/agile/1.0/board/" + board + "/backlog?jql=" + encodeURIComponent("key in (" + list.join(", ") + ")") + "&fields=key&maxResults=" + list.length, undefined, 0, true);
      if (!r.ok) return r;
      return { ok: true, keys: (r.json && Array.isArray(r.json.issues) ? r.json.issues : []).map(function (i) { return str(i && i.key); }).filter(function (k) { return KEY_RE.test(k); }) };
    }
    async function activeSprint(c, board) {
      if (!boardId(board)) return local("bad board id");
      var r = await call(c, "GET", "/rest/agile/1.0/board/" + board + "/sprint?state=active&maxResults=1", undefined, 0, true);
      if (!r.ok) return r;
      var v = r.json && Array.isArray(r.json.values) ? r.json.values[0] : null;
      return { ok: true, id: v && boardId(v.id) ? v.id : 0 };
    }
    async function moveToBacklog(c, board, key) {
      if (!board || !boardId(board.id) || !KEY_RE.test(str(key))) return local("bad move");
      var r = await call(c, "POST", "/rest/agile/1.0/backlog/" + board.id + "/issue", { issues: [key] }, 0, true);
      return r.ok ? { ok: true } : r;
    }
    async function moveToBoard(c, board, key, sprint) {
      if (!board || !boardId(board.id) || !KEY_RE.test(str(key))) return local("bad move");
      if (board.type === "scrum" && !boardId(sprint)) return local("No active sprint");
      var path = board.type === "scrum" ? "/rest/agile/1.0/sprint/" + sprint + "/issue" : "/rest/agile/1.0/board/" + board.id + "/issue";
      var r = await call(c, "POST", path, { issues: [key] }, 0, true);
      return r.ok ? { ok: true } : r;
    }
    async function projects(c) {
      var r = await call(c, "GET", "/rest/api/3/project/search?maxResults=100&orderBy=key");
      if (!r.ok) return r;
      var list = r.json && Array.isArray(r.json.values) ? r.json.values : [];
      return { ok: true, projects: list.map(function (p) { return { key: str(p.key), name: str(p.name) }; }).filter(function (p) { return p.key; }) };
    }
    async function issue(c, key) {
      var r = await call(c, "GET", issuePath(key) + "?fields=" + DETAIL_FIELDS.join(",") + "&expand=renderedFields");
      if (!r.ok) return r;
      var rendered = r.json && r.json.renderedFields && typeof r.json.renderedFields.description === "string" ? r.json.renderedFields.description : "";
      var comments = await call(c, "GET", issuePath(key) + "/comment?orderBy=-created&maxResults=5");
      var list = comments.ok && comments.json && Array.isArray(comments.json.comments) ? comments.json.comments : [];
      var rec = detailed(r.json, c.site), desc = (r.json && r.json.fields && r.json.fields.description) || null;
      return {
        ok: true, record: rec, mediaMap: mapMedia(desc, attachmentIds(rendered), rec.attachments, list.slice(0, 5).map(function (m) { return m.body; })), description: (r.json && r.json.fields && r.json.fields.description) || null,
        comments: list.slice(0, 5).map(function (m) { return { author: str(m.author && m.author.displayName), created: str(m.created), body: m.body || null }; }),
        commentsTotal: comments.ok && comments.json && typeof comments.json.total === "number" ? comments.json.total : list.length,
        commentsError: comments.ok ? "" : comments.message
      };
    }
    async function projectStatuses(c, project) {
      if (!PROJECT_RE.test(str(project))) return local("bad project key");
      var r = await call(c, "GET", "/rest/api/3/project/" + project + "/statuses");
      if (!r.ok) return r;
      return { ok: true, types: (Array.isArray(r.json) ? r.json : []).filter(function (t) { return t && str(t.name) && Array.isArray(t.statuses); }).slice(0, 100).map(function (t) {
        return { type: str(t.name), statuses: t.statuses.filter(function (x) { return x && /^\d{1,12}$/.test(str(x.id)); }).slice(0, 100).map(function (x) { return { id: x.id, name: str(x.name) || x.id, category: category(x.statusCategory) }; }) };
      }) };
    }
    async function boardConfig(c, board) {
      if (!boardId(board)) return local("bad board id");
      var r = await call(c, "GET", "/rest/agile/1.0/board/" + board + "/configuration", undefined, 0, true);
      if (!r.ok) return r;
      var cols = r.json && r.json.columnConfig && Array.isArray(r.json.columnConfig.columns) ? r.json.columnConfig.columns : [];
      return { ok: true, columns: cols.filter(function (col) { return col && str(col.name); }).slice(0, 30).map(function (col) {
        return { name: str(col.name), statusIds: (Array.isArray(col.statuses) ? col.statuses : []).map(function (x) { return str(x && x.id); }).filter(function (id) { return /^\d{1,12}$/.test(id); }) };
      }) };
    }
    async function drop(c, key, statusIds, transitionId) {
      if (!KEY_RE.test(str(key)) || !Array.isArray(statusIds) || !statusIds.length || statusIds.length > 50 || !statusIds.every(function (id) { return /^\d{1,12}$/.test(str(id)); })) return local("bad drop");
      if (transitionId !== "" && !/^\d{1,12}$/.test(str(transitionId))) return local("bad drop");
      var list = await transitions(c, key);
      if (!list.ok) return list;
      var leads = list.transitions.filter(function (t) { return statusIds.indexOf(t.toStatusId) >= 0; });
      var usable = leads.filter(function (t) { return !t.needsFields; });
      if (transitionId) {
        var picked = usable.filter(function (t) { return t.id === transitionId; })[0];
        if (!picked) return { ok: true, kind: "refused", message: "That move is no longer available." };
        return dropped(await transition(c, key, picked.id));
      }
      if (!usable.length) return { ok: true, kind: "refused", message: leads.length ? "This move needs fields; open the ticket in Jira." : "No transition leads to that column." };
      if (usable.length === 1) return dropped(await transition(c, key, usable[0].id));
      return { ok: true, kind: "choose", options: usable };
    }
    function dropped(r) { return r.ok ? { ok: true, kind: "done", record: r.record } : r; }
    async function attachmentBytes(c, id, thumb, cap) {
      if (!ATTACHMENT_ID_RE.test(str(id)) || !(cap > 0)) return local("bad attachment");
      return call(c, "GET", "/rest/api/3/attachment/" + (thumb ? "thumbnail/" : "content/") + id + "?redirect=false", undefined, cap);
    }
    async function transitions(c, key) {
      var r = await call(c, "GET", issuePath(key) + "/transitions?expand=transitions.fields");
      if (!r.ok && (r.status === 400 || r.status === 403 || r.status === 404)) r = await call(c, "GET", issuePath(key) + "/transitions");
      if (!r.ok) return r;
      return { ok: true, transitions: (r.json && Array.isArray(r.json.transitions) ? r.json.transitions : []).map(transitionOf) };
    }
    async function transition(c, key, id) {
      var r = await call(c, "POST", issuePath(key) + "/transitions", { transition: { id: String(id) } });
      if (!r.ok) return r;
      var fresh = await call(c, "GET", issuePath(key) + "?fields=" + LIST_FIELDS.join(","));
      return fresh.ok ? { ok: true, record: record(fresh.json, c.site) } : fresh;
    }

    return {
      constants: { MAX_CONCURRENT: MAX_CONCURRENT, TIMEOUT_MS: TIMEOUT_MS, RETRY_CAP_MS: RETRY_CAP_MS, PAGE_SIZE: PAGE_SIZE, GATEWAY_HOST: GATEWAY_HOST },
      validSite: function (s) { return SITE_RE.test(str(s)); },
      myself: myself, probeSearch: probeSearch, search: search, children: children, sprintKeys: sprintKeys, boards: boards, backlogKeys: backlogKeys, activeSprint: activeSprint,
      moveToBacklog: moveToBacklog, moveToBoard: moveToBoard, boardConfig: boardConfig, projectStatuses: projectStatuses, drop: drop, attachmentBytes: attachmentBytes, projects: projects, issue: issue, transitions: transitions, transition: transition
    };
  }

  var SORTS = { updated: "ORDER BY updated DESC", priority: "ORDER BY priority DESC, updated DESC", created: "ORDER BY created DESC", key: "ORDER BY key ASC" };

  function attachmentIds(html) {
    var out = [], re = /\/(?:rest\/api\/[23]\/attachment\/content|secure\/attachment)\/(\d{1,20})(?!\d)/g, m;
    var text = typeof html === "string" ? html.slice(0, 2000000) : "";
    while ((m = re.exec(text))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
    return out;
  }
  function mediaNodes(doc) {
    var out = [];
    (function walk(n, depth) {
      if (!n || typeof n !== "object" || depth > 100 || out.length > 500) return;
      if (Array.isArray(n)) { n.forEach(function (x) { walk(x, depth + 1); }); return; }
      if ((n.type === "media" || n.type === "mediaInline") && n.attrs && typeof n.attrs === "object") out.push(n.attrs);
      walk(n.content, depth + 1);
    })(doc, 0);
    return out;
  }
  function pairable(a) { return typeof a.id === "string" && a.id && a.type !== "external" && !(typeof a.url === "string" && /^https?:/i.test(a.url)); }
  function mapMedia(desc, renderedIds, attachments, commentDocs) {
    var map = {}, byId = {};
    attachments.forEach(function (a) { byId[a.id] = a; });
    var queue = renderedIds.filter(function (id) { return byId[id]; });
    attachments.forEach(function (a) { if (queue.indexOf(a.id) < 0) queue.push(a.id); });
    mediaNodes(desc).forEach(function (m) {
      if (!pairable(m) || map[m.id] || !queue.length) return;
      var alt = typeof m.alt === "string" ? m.alt.trim().toLowerCase() : "";
      var at = alt ? queue.findIndex(function (id) { return byId[id].filename.toLowerCase() === alt; }) : -1;
      map[m.id] = queue.splice(at >= 0 ? at : 0, 1)[0];
    });
    (commentDocs || []).forEach(function (doc) {
      mediaNodes(doc).forEach(function (m) {
        if (!pairable(m) || map[m.id]) return;
        var alt = typeof m.alt === "string" ? m.alt.trim().toLowerCase() : "";
        var hit = alt ? attachments.filter(function (a) { return a.filename.toLowerCase() === alt; })[0] : null;
        if (hit) map[m.id] = hit.id;
      });
    });
    return map;
  }
  function orderByAt(jql) {
    var quote = "", at = -1;
    for (var i = 0; i < jql.length; i++) {
      var ch = jql.charAt(i);
      if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = ""; continue; }
      if (ch === "\"" || ch === "'") { quote = ch; continue; }
      if (/^order\s+by\b/i.test(jql.slice(i)) && (i === 0 || /\s/.test(jql.charAt(i - 1)))) at = i;
    }
    return at;
  }
  function withSort(jql, sort) {
    var base = String(jql || "");
    if (!Object.prototype.hasOwnProperty.call(SORTS, sort)) return base;
    var at = orderByAt(base);
    if (at >= 0) base = base.slice(0, at);
    return base.replace(/\s+$/, "") + " " + SORTS[sort];
  }
  create.withSort = withSort;
  create.attachmentIds = attachmentIds;
  create.SORTS = Object.keys(SORTS);

  var SCOPE_GROUPS = [
    { name: "Basic", scopes: ["read:jira-work", "read:jira-user", "write:jira-work"] },
    { name: "Board and Backlog", scopes: ["read:board-scope:jira-software", "read:project:jira", "read:issue-details:jira", "read:board-scope.admin:jira-software", "write:board-scope:jira-software"] },
    { name: "Scrum boards only, untested", scopes: ["read:sprint:jira-software", "write:sprint:jira-software"] }
  ];
  var CALL_SCOPES = {
    search: ["read:jira-work"],
    boards: ["read:board-scope:jira-software", "read:project:jira"],
    backlog: ["read:board-scope:jira-software", "read:issue-details:jira"],
    config: ["read:board-scope.admin:jira-software"],
    sprint: ["read:sprint:jira-software"]
  };
  var FEATURES = {
    tickets: { label: "Tickets", fallback: "The tracker cannot list tickets." },
    agile: { label: "Board and Backlog", fallback: "The list groups by status instead." },
    columns: { label: "Board view columns", fallback: "The board shows workflow statuses as columns instead." },
    sprints: { label: "Scrum sprints", fallback: "Move to board stays off for this Scrum board." }
  };
  function checkLine(feature, call, r) {
    var f = FEATURES[feature];
    if (r && r.ok) return { feature: f.label, state: "ok", text: "OK" };
    if (r && r.notChecked) return { feature: f.label, state: "not-checked", text: "Not checked: " + r.notChecked };
    if (r && (r.status === 401 || r.status === 403)) {
      var need = CALL_SCOPES[call];
      return { feature: f.label, state: "failed", scopes: need.slice(), text: "Probably missing " + need.join(", ") + " (inferred: Jira does not name the missing scope). " + f.fallback };
    }
    return { feature: f.label, state: "failed", text: ((r && r.message) || "Jira did not answer.") + " " + f.fallback };
  }
  create.SCOPE_GROUPS = SCOPE_GROUPS;
  create.CALL_SCOPES = CALL_SCOPES;
  create.checkLine = checkLine;

  globalThis.__cdbJiraClientFactory = create;
})();

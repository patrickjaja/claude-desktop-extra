"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const SORTS = ["updated", "priority", "created", "key"];

function shapeQuery(q) {
  const v = q && typeof q === "object" ? q : {};
  const sort = SORTS.includes(v.sort) ? { sort: v.sort } : {};
  if (typeof v.jql === "string") return { jql: v.jql.slice(0, 2001), ...sort };
  return { preset: String(v.preset || ""), project: String(v.project || ""), ...sort };
}

contextBridge.exposeInMainWorld("cdbJira", {
  state: () => ipcRenderer.invoke("cdb-jira:state"),
  projects: () => ipcRenderer.invoke("cdb-jira:projects"),
  search: (query, nextPageToken) => ipcRenderer.invoke("cdb-jira:search", shapeQuery(query), typeof nextPageToken === "string" ? nextPageToken : ""),
  issue: (key) => ipcRenderer.invoke("cdb-jira:issue", { key: String(key || "") }),
  transitions: (key) => ipcRenderer.invoke("cdb-jira:transitions", { key: String(key || "") }),
  transition: (key, id) => ipcRenderer.invoke("cdb-jira:transition", { key: String(key || ""), id: String(id || "") }),
  send: (key) => ipcRenderer.invoke("cdb-jira:send", { key: String(key || ""), action: "implement" }),
  openExternal: (url) => ipcRenderer.invoke("cdb-jira:open-external", { url: String(url || "") }),
  openIssue: (key) => ipcRenderer.invoke("cdb-jira:open-external", { key: String(key || "") }),
  hide: () => ipcRenderer.invoke("cdb-jira:hide"),
  setDetailsOpen: (open) => ipcRenderer.invoke("cdb-jira:details", { open: !!open }),
  attachment: (key, id, thumb) => ipcRenderer.invoke("cdb-jira:attachment", { key: String(key || ""), id: String(id || ""), thumb: thumb === true }),
  download: (key, id) => ipcRenderer.invoke("cdb-jira:download", { key: String(key || ""), id: String(id || "") }),
  children: (keys) => ipcRenderer.invoke("cdb-jira:children", { keys: (Array.isArray(keys) ? keys : []).slice(0, 50).map((k) => String(k)) }),
  drop: (key, statusIds, transitionId) => ipcRenderer.invoke("cdb-jira:drop", { key: String(key || ""), statusIds: (Array.isArray(statusIds) ? statusIds : []).slice(0, 50).map((x) => (x == null ? "" : String(x))), transitionId: transitionId == null ? "" : String(transitionId) }),
  move: (key, to, boardId) => ipcRenderer.invoke("cdb-jira:move", { key: String(key || ""), to: String(to || ""), boardId: Number(boardId) }),
  setBoard: (project, boardId) => ipcRenderer.invoke("cdb-jira:board", { project: String(project || ""), boardId: Number(boardId) }),
  theme: () => ipcRenderer.invoke("cdb-jira:theme"),
  onTheme: (fn) => {
    if (typeof fn !== "function") return;
    ipcRenderer.on("cdb-jira:theme", (_event, theme) => { if (theme && typeof theme === "object" && !Array.isArray(theme)) fn(theme); });
  },
  openSettings: () => ipcRenderer.invoke("cdb-jira:open-settings"),
  cover: () => ipcRenderer.invoke("cdb-jira:cover"),
  onCover: (fn) => {
    if (typeof fn !== "function") return;
    ipcRenderer.on("cdb-jira:cover", (_event, full) => { if (typeof full === "boolean") fn(full); });
  },
  saveQuery: (name, jql) => ipcRenderer.invoke("cdb-jira:query-save", { name: String(name || ""), jql: String(jql || "") }),
  deleteQuery: (name) => ipcRenderer.invoke("cdb-jira:query-delete", { name: String(name || "") })
});

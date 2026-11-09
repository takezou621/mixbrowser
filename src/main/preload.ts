import { contextBridge, ipcRenderer } from "electron";
import type { MixApi } from "../shared/types";

const api: MixApi = {
  getState: () => ipcRenderer.invoke("ui:getState"),
  getAgentStatus: () => ipcRenderer.invoke("ui:agentStatus"),
  runAgent: (prompt: string) => ipcRenderer.invoke("ui:runAgent", prompt),
  createManualDraft: (text: string) => ipcRenderer.invoke("ui:createManualDraft", text),
  approveNow: (id: string) => ipcRenderer.invoke("ui:approveNow", id),
  scheduleAt: (id: string, iso: string) => ipcRenderer.invoke("ui:scheduleAt", id, iso),
  cancelSchedule: (id: string) => ipcRenderer.invoke("ui:cancelSchedule", id),
  reject: (id: string) => ipcRenderer.invoke("ui:reject", id),
  retry: (id: string) => ipcRenderer.invoke("ui:retry", id),
  deleteDraft: (id: string) => ipcRenderer.invoke("ui:deleteDraft", id),
  checkLogin: () => ipcRenderer.invoke("ui:checkLogin"),
  navigate: (url: string) => ipcRenderer.invoke("ui:navigate", url),
  reload: () => ipcRenderer.invoke("ui:reload"),
  openPath: (p: string) => ipcRenderer.invoke("ui:openPath", p),
  onStateChanged: (cb: () => void) => {
    ipcRenderer.on("mix:state-changed", () => cb());
  },
};

contextBridge.exposeInMainWorld("mix", api);

import { app, BrowserWindow, ipcMain, shell, WebContentsView } from "electron";
import * as path from "node:path";
import { Store } from "./store";
import { Engine } from "./engine";
import { startMcpServer, type McpHandle } from "./mcpserver";
import { agentStatus, resolveClaudePath, runAgentTask } from "./agents";
import { XDriver } from "./xdriver";
import type { LoginStatus, OkErr, UiState } from "../shared/types";

// ---- レイアウト定数 ----------------------------------------------------
const SIDEBAR_W = 230;
const PANEL_W = 400;
const TOPBAR_H = 46;
const HOME_URL = "https://x.com/home";

let win: BrowserWindow | null = null;
let view: WebContentsView | null = null;
let store: Store;
let engine: Engine;
let mcp: McpHandle | null = null;

const isSmoke = Boolean(process.env["MIX_SMOKE"]);

if (process.env["MIX_USER_DATA"]) {
  app.setPath("userData", path.resolve(process.env["MIX_USER_DATA"]));
}

function screenshotDir(): string {
  return path.join(app.getPath("userData"), "screenshots");
}

function notify(): void {
  if (win && !win.isDestroyed()) win.webContents.send("mix:state-changed");
}

function layout(): void {
  if (!win || win.isDestroyed() || !view) return;
  const { width, height } = win.getContentBounds();
  view.setBounds({
    x: SIDEBAR_W,
    y: TOPBAR_H,
    width: Math.max(width - SIDEBAR_W - PANEL_W, 50),
    height: Math.max(height - TOPBAR_H, 50),
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: isSmoke ? 400 : 1400,
    height: isSmoke ? 300 : 900,
    show: !isSmoke,
    title: "mixbrowser",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(path.join(__dirname, "index.html"));
  win.on("resize", layout);
  win.on("closed", () => {
    win = null;
  });

  view = new WebContentsView({
    webPreferences: {
      partition: "persist:x-main",
      contextIsolation: true,
      nodeIntegration: false,
      // スモークモード(非表示ウィンドウ)でも capturePage できるようスロットリングを無効化
      backgroundThrottling: !isSmoke,
    },
  });
  win.contentView.addChildView(view);
  layout();
  void view.webContents.loadURL(isSmoke ? "about:blank" : HOME_URL);
  if (isSmoke) {
    // 非表示ウィンドウではコンポジタが描画せず capturePage が失敗するため、
    // 小さいウィンドウをフォーカスせず表示して描画させる
    win.showInactive();
  }
}

// ---- IPC --------------------------------------------------------------

type Handler = (args: unknown[]) => Promise<unknown> | unknown;
function handleIpc(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return await fn(args);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

function registerIpc(): void {
  handleIpc("ui:getState", (): UiState => store.getState());
  handleIpc("ui:agentStatus", () => agentStatus());

  handleIpc("ui:runAgent", async (args): Promise<{ ok: boolean; result?: string; error?: string }> => {
    const prompt = String(args[0] ?? "").trim();
    if (!prompt) throw new Error("指示が空です");
    const claude = resolveClaudePath();
    if (!claude || !mcp) throw new Error("Claude Code または MCP サーバが利用できません");
    const res = await runAgentTask({ claudePath: claude, mcpConfigPath: mcp.configPath, prompt });
    store.addLog({
      kind: "agent",
      level: res.ok ? "info" : "error",
      message: res.ok ? "エージェント実行完了" : "エージェント実行失敗: " + (res.error ?? ""),
      detail: { sessionId: res.sessionId, costUsd: res.costUsd },
    });
    notify();
    return res;
  });

  handleIpc("ui:createManualDraft", (args): OkErr & { draftId?: string } => {
    const text = String(args[0] ?? "");
    const d = store.createDraft({ accountId: "main", text, source: "manual" });
    store.addLog({ kind: "draft", level: "info", message: "手動下書きを作成", draftId: d.id });
    notify();
    return { ok: true, draftId: d.id };
  });

  handleIpc("ui:approveNow", (args): OkErr => {
    engine.approveNow(String(args[0]));
    return { ok: true };
  });
  handleIpc("ui:scheduleAt", (args): OkErr => {
    engine.scheduleAt(String(args[0]), String(args[1]));
    return { ok: true };
  });
  handleIpc("ui:cancelSchedule", (args): OkErr => {
    engine.cancelSchedule(String(args[0]));
    return { ok: true };
  });
  handleIpc("ui:reject", (args): OkErr => {
    engine.reject(String(args[0]));
    return { ok: true };
  });
  handleIpc("ui:retry", (args): OkErr => {
    engine.retry(String(args[0]));
    return { ok: true };
  });
  handleIpc("ui:deleteDraft", (args): OkErr => {
    store.removeDraft(String(args[0]));
    notify();
    return { ok: true };
  });

  handleIpc("ui:checkLogin", async (): Promise<LoginStatus & OkErr> => {
    const driver = new XDriver(() => view ?? undefined, screenshotDir());
    const st = await driver.isLoggedIn();
    if (st.loggedIn && st.handle) store.setAccountHandle("main", st.handle);
    notify();
    return { ok: true, ...st };
  });

  handleIpc("ui:navigate", (args): OkErr => {
    const url = String(args[0] ?? "");
    if (!/^https:\/\/(x|twitter)\.com\/[^\s]*$/.test(url)) {
      throw new Error("x.com のみに対応しています(MVP)");
    }
    void view?.webContents.loadURL(url);
    return { ok: true };
  });

  handleIpc("ui:reload", (): OkErr => {
    view?.webContents.reload();
    return { ok: true };
  });

  handleIpc("ui:openPath", (args): OkErr => {
    const p = String(args[0] ?? "");
    // 姉妹ディレクトリ(screenshots-* 等)への prefix 漏れを防ぐため、sep まで含めて比較
    const shotDir = path.join(app.getPath("userData"), "screenshots") + path.sep;
    if (!p.startsWith(shotDir)) {
      throw new Error("許可されていないパスです");
    }
    void shell.openPath(p);
    return { ok: true };
  });
}

// ---- エントリ ----------------------------------------------------------

app.whenReady().then(async () => {
  store = new Store(app.getPath("userData"));
  // 前回終了時に実行中だったドラフトの救済(spec FR-4.4):
  // X への送信結果は不明のため自動再送はしない(二重投稿防止)。ユーザー確認後に再承認する
  for (const d of store.listDrafts("posting")) {
    store.updateDraft(d.id, {
      status: "failed",
      error: "アプリ終了時に実行中だったため結果を判定できません。プロフィールで投稿の有無を確認してください",
    });
    store.addLog({
      kind: "recover",
      level: "warn",
      message: "posting 状態のドラフトを結果不明として failed に戻しました(自動再送なし)",
      draftId: d.id,
    });
  }
  engine = new Engine(store, () => view ?? undefined, screenshotDir(), notify);
  engine.start();
  mcp = await startMcpServer({
    store,
    engine,
    getView: () => view ?? undefined,
    screenshotDir: screenshotDir(),
    dataDir: app.getPath("userData"),
    notify,
  });
  registerIpc();
  createWindow();

  if (isSmoke) {
    console.log(
      JSON.stringify({
        SMOKE_READY: true,
        storeFile: store.storePath,
        mcpUrl: mcp.url,
        mcpEndpoint: mcp.endpointPath,
        drafts: store.listDrafts().length,
      }),
    );
    if (!process.env["MIX_SMOKE_HOLD"]) {
      setTimeout(() => app.exit(0), 800);
    }
  }
});

app.on("window-all-closed", () => {
  engine?.stop();
  mcp?.close();
  app.quit();
});

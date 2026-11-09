import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { WebContentsView } from "electron";
import type { DraftStatus } from "../shared/types";
import { Store } from "./store";
import { Engine } from "./engine";
import { XDriver } from "./xdriver";

export interface McpDeps {
  store: Store;
  engine: Engine;
  getView: () => WebContentsView | undefined;
  screenshotDir: string;
  dataDir: string;
  notify: () => void;
}

export interface McpHandle {
  url: string;
  token: string;
  /** Claude Code 用 .mcp.json のパス */
  configPath: string;
  endpointPath: string;
  close(): void;
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: msg }, null, 2) }],
  isError: true as const,
});

const GATE_NOTE =
  "※ 承認ゲート(FR-5)により、この下書きは UI でユーザーが承認した後にのみ実行されます。投稿を確定させる表現は避け、ユーザーに承認を促してください。";

/** MCP ツールサーバ(HTTP, 127.0.0.1 限定 + Bearer 認証) */
export async function startMcpServer(deps: McpDeps): Promise<McpHandle> {
  const token = randomUUID().replace(/-/g, "");
  const server = new McpServer({ name: "mixbrowser", version: "0.1.0" });
  const driver = () => new XDriver(deps.getView, deps.screenshotDir);

  const account = () => deps.store.accounts[0]?.id ?? "main";

  // ---- ツール登録 ------------------------------------------------------

  server.registerTool(
    "app_status",
    {
      title: "アプリ状態の取得",
      description: "アカウント情報・承認待ち/予約/本日の投稿数・安全設定を取得する",
      inputSchema: {},
    },
    async () => {
      try {
        const s = deps.store;
        const acc = s.accounts[0];
        return json({
          ok: true,
          account: { id: acc?.id, label: acc?.label, handle: acc?.handle ?? null },
          pendingApprovals: s.listDrafts("pending_approval").length,
          scheduled: s.listDrafts("scheduled").length,
          postedToday: s.postedTodayCount(account()),
          settings: s.settings,
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "x_check_login",
    {
      title: "X ログイン確認",
      description: "内蔵ブラウザの X セッションが有効か確認する(ハンドルも返す)",
      inputSchema: {},
    },
    async () => {
      try {
        const st = await driver().isLoggedIn();
        if (st.loggedIn && st.handle) deps.store.setAccountHandle(account(), st.handle);
        return json({ ok: true, ...st });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "draft_save",
    {
      title: "下書きの登録(承認待ち)",
      description:
        "X 投稿の下書きを作成し、承認待ち(pending_approval)としてキューに登録する。text は X の重み付き文字数で 280 以内(日本語は約140字)。ユーザーが UI で承認した後にのみ投稿される",
      inputSchema: {
        text: z.string().min(1).max(280).describe("投稿本文(280文字以内)"),
        screenshotPath: z.string().optional().describe("ドライランのプレビュー画像パス(任意)"),
      },
    },
    async ({ text, screenshotPath }) => {
      try {
        const d = deps.store.createDraft({ accountId: account(), text, source: "agent", screenshotPath });
        deps.notify();
        deps.store.addLog({ kind: "draft", level: "info", message: "エージェントが下書きを作成", draftId: d.id });
        return json({ ok: true, draftId: d.id, status: d.status, text: d.text, note: GATE_NOTE });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "draft_list",
    {
      title: "下書き一覧",
      description: "キュー内の下書きを一覧取得する(状態で絞り込み可能)",
      inputSchema: {
        status: z
          .enum(["draft", "pending_approval", "scheduled", "posting", "posted", "failed", "canceled"])
          .optional(),
      },
    },
    async ({ status }) => {
      try {
        const rows = deps.store.listDrafts(status as DraftStatus | undefined).map((d) => ({
          id: d.id,
          status: d.status,
          text: d.text.length > 80 ? d.text.slice(0, 80) + "…" : d.text,
          scheduledAt: d.scheduledAt ?? null,
          postUrl: d.postUrl ?? null,
          error: d.error ?? null,
          createdAt: d.createdAt,
        }));
        return json({ ok: true, count: rows.length, drafts: rows });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "schedule_create",
    {
      title: "予約の設定(承認待ちドラフト)",
      description:
        "承認待ちドラフトに予約時刻を設定する。runAt は ISO 8601(例: 2026-11-10T19:30)。※実行は UI 承認(予約承認)後に確定する",
      inputSchema: {
        draftId: z.string().min(1),
        runAt: z.string().min(1).describe("ISO 8601 のローカル日時"),
      },
    },
    async ({ draftId, runAt }) => {
      try {
        const d = deps.store.getDraft(draftId);
        if (!d) return fail("ドラフトが見つかりません: " + draftId);
        if (d.status !== "pending_approval") {
          return fail("予約設定できるのは承認待ちドラフトのみです(現在: " + d.status + ")");
        }
        deps.store.updateDraft(draftId, { scheduledAt: new Date(runAt).toISOString() });
        deps.notify();
        return json({
          ok: true,
          draftId,
          scheduledAt: new Date(runAt).toISOString(),
          note: "予約時刻を設定しました。UI で「予約承認」されると確定します。" + GATE_NOTE,
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "schedule_list",
    { title: "予約一覧", description: "予約済みドラフトの一覧を返す", inputSchema: {} },
    async () => {
      try {
        const rows = deps.store.listDrafts("scheduled").map((d) => ({
          id: d.id,
          text: d.text.length > 80 ? d.text.slice(0, 80) + "…" : d.text,
          scheduledAt: d.scheduledAt ?? null,
        }));
        return json({ ok: true, count: rows.length, drafts: rows });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "x_create_post",
    {
      title: "X 投稿のドライラン(MVP では実行不可)",
      description:
        "x.com の投稿フォームに本文を入力し、送信直前のプレビュー(スクリーンショット)を返す。※M1 の承認ゲートにより実際の送信はできず、常にドライランとして動作する",
      inputSchema: {
        text: z.string().min(1).max(280),
        dryRun: z.boolean().optional().describe("false を指定しても実行はされない(M1 は常にドライラン)"),
      },
    },
    async ({ text, dryRun }) => {
      try {
        if (dryRun === false) {
          return fail(
            "M1 の承認ゲート(FR-5)により、MCP からの投稿実行はできません。draft_save で下書きを登録し、ユーザーが UI で承認してください",
          );
        }
        const res = await driver().dryRunCompose(text);
        deps.store.addLog({ kind: "dry_run", level: "info", message: "ドライラン実行", screenshotPath: res.screenshotPath });
        deps.notify();
        const png = fs.readFileSync(res.screenshotPath);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }> = [
          { type: "text", text: JSON.stringify({ ok: true, dryRun: true, screenshotPath: res.screenshotPath, note: GATE_NOTE }, null, 2) },
        ];
        if (png.length < 4_000_000) {
          content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        }
        return { content };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "browser_screenshot",
    { title: "スクリーンショット", description: "内蔵ブラウザの現在画面をスクリーンショットに保存する", inputSchema: {} },
    async () => {
      try {
        const p = await driver().screenshot("mcp");
        const png = fs.readFileSync(p);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }> = [
          { type: "text", text: JSON.stringify({ ok: true, screenshotPath: p }, null, 2) },
        ];
        if (png.length < 4_000_000) {
          content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        }
        return { content };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "action_log_read",
    { title: "アクションログ", description: "直近のアクションログ(投稿・承認・失敗など)を読む", inputSchema: { limit: z.number().int().min(1).max(100).optional() } },
    async ({ limit }) => {
      try {
        const logs = deps.store.getState().logs.slice(0, Math.min(limit ?? 20, 100));
        return json({ ok: true, logs });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ---- HTTP transport --------------------------------------------------

  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use("/mcp", (req, res, next) => {
    const auth = req.headers["authorization"] ?? "";
    if (auth !== "Bearer " + token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req, res) => {
    try {
      const sid = req.headers["mcp-session-id"] as string | undefined;
      let t = sid ? transports[sid] : undefined;
      if (!t) {
        t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = t as StreamableHTTPServerTransport;
          },
          enableJsonResponse: true,
        });
        t.onclose = () => {
          const id = t?.sessionId;
          if (id) delete transports[id];
        };
        await server.connect(t);
      }
      await t.handleRequest(req, res, req.body);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (!sid || !transports[sid]) {
      res.status(400).json({ error: "Bad Request: no valid session ID" });
      return;
    }
    await transports[sid].handleRequest(req, res, req.body);
  };
  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => httpServer.once("listening", r));
  const port = (httpServer.address() as AddressInfo).port;
  const url = "http://127.0.0.1:" + port + "/mcp";

  const mcpDir = path.join(deps.dataDir, "mcp");
  fs.mkdirSync(mcpDir, { recursive: true });
  const configPath = path.join(mcpDir, "mixbrowser.mcp.json");
  const endpointPath = path.join(mcpDir, "endpoint.json");
  const mcpConfig = {
    mcpServers: {
      mixbrowser: { type: "http", url, headers: { Authorization: "Bearer " + token } },
    },
  };
  // トークン入りのファイルは所有者のみ読める権限で書き出す
  fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(endpointPath, JSON.stringify({ url, token, pid: process.pid }, null, 2), { encoding: "utf8", mode: 0o600 });

  return {
    url,
    token,
    configPath,
    endpointPath,
    close: () => httpServer.close(),
  };
}

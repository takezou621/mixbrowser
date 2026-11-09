// スモークテスト: Electron アプリを SMOKE モードで起動し、
// MCP クライアントとしてツール一覧・下書き登録・予約・ゲート強制を検証する。
// 実際の x.com 通信は行わない(MIX_SMOKE では about:blank を読み込む)。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = mkdtempSync(path.join(tmpdir(), "mix-smoke-"));
const child = spawn(path.join(root, "node_modules", ".bin", "electron"), ["."], {
  cwd: root,
  env: {
    ...process.env,
    MIX_SMOKE: "1",
    MIX_SMOKE_HOLD: "1",
    MIX_USER_DATA: dataDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let outBuf = "";
let readyInfo = null;
const readyPromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("SMOKE_READY が90秒以内に出力されませんでした\n" + outBuf.slice(-2000))), 90_000);
  const onData = (d) => {
    outBuf += d.toString("utf8");
    const lines = outBuf.split("\n");
    for (const line of lines) {
      if (line.includes("SMOKE_READY")) {
        try {
          readyInfo = JSON.parse(line.slice(line.indexOf("{")));
          clearTimeout(timer);
          resolve(readyInfo);
          return;
        } catch {
          /* keep waiting */
        }
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", (d) => {
    outBuf += d.toString("utf8");
  });
});

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: Boolean(cond), detail: detail ?? "" });
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : ""));
};

async function main() {
  const ready = await readyPromise;
  console.log("app ready: mcpUrl=" + ready.mcpUrl);
  const ep = JSON.parse(readFileSync(ready.mcpEndpoint, "utf8"));

  const transport = new StreamableHTTPClientTransport(new URL(ep.url), {
    requestInit: { headers: { Authorization: "Bearer " + ep.token } },
  });
  const client = new Client({ name: "mixbrowser-smoke", version: "0.0.1" });
  await client.connect(transport);
  console.log("MCP connected");

  // 1. ツール一覧
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  for (const expected of ["app_status", "x_check_login", "draft_save", "draft_list", "schedule_create", "schedule_list", "x_create_post", "browser_screenshot", "action_log_read"]) {
    check("tool:" + expected, names.includes(expected));
  }

  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    let json = null;
    try {
      json = JSON.parse(r.content?.[0]?.text ?? "null");
    } catch {
      /* not json */
    }
    return { isError: Boolean(r.isError), json };
  };

  // 2. app_status
  const st = await call("app_status", {});
  check("app_status ok", !st.isError && st.json?.ok === true, "pending=" + st.json?.pendingApprovals);

  // 3. draft_save(正常)
  const LONG = "あ".repeat(300);
  const d1 = await call("draft_save", { text: "M1 スモークテスト用の下書き投稿です(#mixbrowser)" });
  check("draft_save creates pending_approval", !d1.isError && d1.json?.status === "pending_approval" && Boolean(d1.json?.draftId));
  const draftId = d1.json?.draftId;

  // 4. draft_save(文字数オーバーは拒否)
  const d2 = await call("draft_save", { text: LONG });
  check("draft_save rejects >280 chars", d2.isError === true, d2.json?.error ?? "");

  // 5. draft_list
  const dl = await call("draft_list", { status: "pending_approval" });
  check("draft_list contains new draft", Array.isArray(dl.json?.drafts) && dl.json.drafts.some((x) => x.id === draftId));

  // 6. schedule_create(予約時刻設定)
  const runAt = new Date(Date.now() + 3600_000).toISOString();
  const sc = await call("schedule_create", { draftId, runAt });
  check("schedule_create sets runAt", !sc.isError && sc.json?.ok === true, sc.json?.error ?? "");

  // 7. 承認ゲート: MCP からの投稿実行は拒否されること(FR-5)
  const post = await call("x_create_post", { text: "これは実行されてはいけない投稿", dryRun: false });
  check("x_create_post(dryRun:false) blocked by gate", post.isError === true, (post.json?.error ?? "").slice(0, 40));

  // 8. browser_screenshot(隠しウィンドウでのキャプチャ)
  const shot = await call("browser_screenshot", {});
  check(
    "browser_screenshot returns path",
    !shot.isError && shot.json?.ok === true && typeof shot.json?.screenshotPath === "string" && existsSync(shot.json.screenshotPath),
    (shot.json?.error ?? "") + " " + (shot.json?.screenshotPath ?? ""),
  );

  // 9. ストア永続化の確認
  const store = JSON.parse(readFileSync(ready.storeFile, "utf8"));
  const saved = store.drafts.find((d) => d.id === draftId);
  check("store persists draft with runAt", Boolean(saved) && saved.status === "pending_approval" && typeof saved.scheduledAt === "string");
  check("store has action logs", Array.isArray(store.logs) && store.logs.length >= 1);

  await client.close();

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== summary: " + (results.length - failed.length) + "/" + results.length + " passed ===");
  child.kill("SIGTERM");
  setTimeout(() => {
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  }, 1500);
}

main().catch(async (e) => {
  console.error("SMOKE ERROR:", e);
  child.kill("SIGKILL");
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
});

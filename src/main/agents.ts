import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentResult } from "../shared/types";

/** Claude Code CLI のパスを解決する(GUI 起動時の PATH 貧弱対策込み) */
export function resolveClaudePath(): string | null {
  const candidates = [
    process.env["MIX_CLAUDE_PATH"],
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(os.homedir(), ".claude", "local", "claude"),
  ].filter((x): x is string => Boolean(x));
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* 次の候補へ */
    }
  }
  // PATH 上の各ディレクトリも探索する(GUI 起動時は PATH が貧弱でも、ターミナルと同じ PATH に
  // claude が存在するケースを拾う。ただし Electron の既定 PATH は狭いので標準配置を先に見る)
  const pathDirs = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const c = path.join(dir, "claude");
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* 次の候補へ */
    }
  }
  return null;
}

export function agentStatus(): { available: boolean; version?: string; error?: string } {
  const p = resolveClaudePath();
  if (!p) {
    return {
      available: false,
      error:
        "Claude Code CLI が見つかりません。ターミナルで claude が使えるか確認するか、MIX_CLAUDE_PATH にパスを設定してください",
    };
  }
  return { available: true };
}

/**
 * Claude Code をヘッドレス(-p)で 1 タスク実行する。
 * MCP 設定(mixbrowser.mcp.json)を渡し、mixbrowser ツールのみ許可する。
 */
export async function runAgentTask(opts: {
  claudePath: string;
  mcpConfigPath: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<AgentResult> {
  const systemHint = [
    "あなたは mixbrowser の X 投稿アシスタントです。",
    "- 投稿本文は X の重み付き文字数で 280 以内に収めてください(日本語等マルチバイトは 2 カウントのため実質約 140 字)。",
    "- 新しい投稿が必要な場合は、必ず draft_save ツールで「承認待ち」として登録してください(直接投稿はできません)。",
    "- 予約が必要な場合は、draft_save の後に schedule_create ツールで ISO 8601 のローカル日時を指定してください。",
    "- x_create_post はドライラン専用です。実際の投稿はユーザーが UI で承認した後にのみ行われます。",
    "- 最後に、登録・更新した下書きの内容と状態を日本語で簡潔に報告してください。",
  ].join("\n");

  const args = [
    "-p",
    systemHint + "\n\n--- ユーザーの指示 ---\n" + opts.prompt,
    "--output-format",
    "json",
    "--mcp-config",
    opts.mcpConfigPath,
    "--allowedTools",
    "mcp__mixbrowser__*",
    "--max-turns",
    "40",
  ];

  return new Promise<AgentResult>((resolve) => {
    // detached + プロセスグループ kill で、claude が内包する子プロセスも含めて終了させる(孤児プロセス防止)
    const child = spawn(opts.claudePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let out = "";
    let errOut = "";
    let settled = false;
    const done = (r: AgentResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const killTree = () => {
      try {
        if (child.pid && process.platform !== "win32") {
          // 負の PID = プロセスグループ全体にシグナル(detached でグループリーダーになっている)
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* すでに終了している */
      }
    };
    const timer = setTimeout(() => {
      killTree();
      done({ ok: false, error: "タイムアウト: claude が " + ((opts.timeoutMs ?? 240_000) / 1000) + "秒以内に完了しませんでした" });
    }, opts.timeoutMs ?? 240_000);

    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      errOut += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, error: "claude の起動に失敗: " + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        const lines = text.split("\n").filter((l) => l.trim().startsWith("{"));
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            parsed = JSON.parse(lines[i]) as Record<string, unknown>;
            break;
          } catch {
            /* continue */
          }
        }
      }
      if (!parsed) {
        done({
          ok: false,
          error:
            "claude の出力を解析できませんでした(code=" + code + ") " + (errOut.slice(-300) || text.slice(-300)),
        });
        return;
      }
      // is_error 無しでも非ゼロ終了コードは失敗扱い(認証失敗やツール拒否を実行完了と誤記録しない)
      const isError = Boolean(parsed["is_error"]) || (typeof code === "number" && code !== 0);
      done({
        ok: !isError,
        result: typeof parsed["result"] === "string" ? parsed["result"] : undefined,
        sessionId: typeof parsed["session_id"] === "string" ? parsed["session_id"] : undefined,
        costUsd: typeof parsed["total_cost_usd"] === "number" ? parsed["total_cost_usd"] : undefined,
        error: isError
          ? typeof parsed["result"] === "string"
            ? (parsed["result"] as string)
            : errOut.slice(-400) || "claude がエラーを返しました"
          : undefined,
      });
    });
  });
}

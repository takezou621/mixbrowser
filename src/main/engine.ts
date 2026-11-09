import type { WebContentsView } from "electron";
import type { Draft } from "../shared/types";
import { Store } from "./store";
import { XDriver, XDriverError } from "./xdriver";

/**
 * 承認ゲート + スケジューラ。
 *
 * M1 の原則(docs/spec.md FR-5):
 * - エージェント(MCP)は「投稿の実行」を行えない。draft の登録と予約のみ。
 * - 投稿は必ず UI での承認(approveNow / 予約承認)を経由した後、Engine が実行する。
 */
export class Engine {
  private timer?: NodeJS.Timeout;
  /** 直列実行キュー(同一アカウントの同時自動操作を防ぐ) */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly getView: () => WebContentsView | undefined,
    private readonly screenshotDir: string,
    private readonly notify: () => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn).catch(() => undefined);
    this.queue = next;
    return next;
  }

  /** 連投抑制チェック(docs/spec.md FR-4.3) */
  safetyCheck(accountId: string, when: Date = new Date()): { ok: true } | { ok: false; reason: string } {
    const s = this.store.settings;
    const hour = when.getHours();
    if (hour < s.activeHours.start || hour >= s.activeHours.end) {
      return {
        ok: false,
        reason: "実行許可時間帯外です(許可: " + s.activeHours.start + "時〜" + s.activeHours.end + "時)",
      };
    }
    const postedToday = this.store.postedTodayCount(accountId);
    if (postedToday >= s.dailyPostLimit) {
      return { ok: false, reason: "日次投稿上限に達しています(上限: " + s.dailyPostLimit + "件/日)" };
    }
    const last = this.store.lastPostedAt(accountId);
    if (last) {
      const diffMin = (when.getTime() - last.getTime()) / 60_000;
      if (diffMin < s.minIntervalMinutes) {
        return {
          ok: false,
          reason:
            "前回投稿から間隔が不足しています(必要: " + s.minIntervalMinutes + "分, 経過: " + Math.round(diffMin) + "分)",
        };
      }
    }
    return { ok: true };
  }

  /** 承認して今すぐ実行(承認ゲート本体) */
  approveNow(draftId: string): void {
    const d = this.mustDraft(draftId);
    if (d.status !== "pending_approval" && d.status !== "failed") {
      throw new Error("承認できるのは承認待ち/失敗のドラフトです(現在: " + d.status + ")");
    }
    const check = this.safetyCheck(d.accountId);
    if (!check.ok) throw new Error(check.reason);
    this.store.updateDraft(draftId, { status: "scheduled", scheduledAt: new Date().toISOString(), error: undefined });
    this.store.addLog({ kind: "approve", level: "info", message: "承認されました(即時実行)", draftId });
    this.notify();
    void this.runDraft(draftId);
  }

  /** 予約で承認 */
  scheduleAt(draftId: string, iso: string): void {
    const d = this.mustDraft(draftId);
    if (d.status !== "pending_approval") {
      throw new Error("予約できるのは承認待ちのドラフトです(現在: " + d.status + ")");
    }
    const when = new Date(iso);
    if (isNaN(when.getTime())) throw new Error("日時の形式が不正です");
    if (when.getTime() < Date.now() - 60_000) throw new Error("過去の日時は指定できません");
    const check = this.safetyCheck(d.accountId, when);
    if (!check.ok) throw new Error("予約時刻が安全設定に違反しています: " + check.reason);
    this.store.updateDraft(draftId, { status: "scheduled", scheduledAt: when.toISOString() });
    this.store.addLog({
      kind: "schedule",
      level: "info",
      message: "予約承認されました: " + when.toISOString(),
      draftId,
    });
    this.notify();
  }

  cancelSchedule(draftId: string): void {
    const d = this.mustDraft(draftId);
    if (d.status !== "scheduled") throw new Error("予約状態のドラフトではありません");
    this.store.updateDraft(draftId, { status: "pending_approval", scheduledAt: undefined });
    this.store.addLog({ kind: "schedule_cancel", level: "info", message: "予約を取り消しました", draftId });
    this.notify();
  }

  reject(draftId: string): void {
    const d = this.mustDraft(draftId);
    if (d.status !== "pending_approval" && d.status !== "scheduled" && d.status !== "failed") {
      throw new Error("却下できる状態ではありません(現在: " + d.status + ")");
    }
    this.store.updateDraft(draftId, { status: "canceled" });
    this.store.addLog({ kind: "reject", level: "info", message: "却下されました", draftId });
    this.notify();
  }

  /** 失敗ドラフトを承認待ちに戻す(再承認を必須化) */
  retry(draftId: string): void {
    const d = this.mustDraft(draftId);
    if (d.status !== "failed") throw new Error("失敗状態のドラフトのみ再試行できます");
    this.store.updateDraft(draftId, { status: "pending_approval", error: undefined });
    this.notify();
  }

  private mustDraft(id: string): Draft {
    const d = this.store.getDraft(id);
    if (!d) throw new Error("ドラフトが見つかりません: " + id);
    return d;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    // アプリ停止/スリープで時刻を過ぎた予約の扱い(spec FR-4.2):
    // 24 時間以内の超過分は順次実行、超過分は failed(期限超過)として再承認を要求する
    const EXPIRE_MS = 24 * 3600_000;
    const due = this.store.listDrafts("scheduled").filter((d) => d.scheduledAt && new Date(d.scheduledAt).getTime() <= now);
    for (const d of due) {
      const over = now - new Date(d.scheduledAt as string).getTime();
      if (over > EXPIRE_MS) {
        this.store.updateDraft(d.id, {
          status: "failed",
          error: "予約時刻を 24 時間以上過ぎたため自動実行を取りやめました(期限超過)。再承認してください",
        });
        this.store.addLog({ kind: "schedule_expire", level: "warn", message: "予約が期限超過(24時間超過)のため実行を取りやめ", draftId: d.id });
        this.notify();
        continue;
      }
      await this.runDraft(d.id);
    }
  }

  /** 予約ドラフトの実行(直列)。実行時にも安全設定を再チェックする */
  async runDraft(draftId: string): Promise<void> {
    await this.enqueue(async () => {
      const d = this.store.getDraft(draftId);
      if (!d || d.status !== "scheduled" || !d.scheduledAt) return;
      const check = this.safetyCheck(d.accountId, new Date(d.scheduledAt));
      if (!check.ok) {
        this.store.addLog({
          kind: "post_skip",
          level: "warn",
          message: "安全設定により実行をスキップ: " + check.reason,
          draftId,
        });
        this.notify();
        return;
      }
      this.store.updateDraft(draftId, { status: "posting" });
      this.notify();
      const driver = new XDriver(this.getView, this.screenshotDir);
      try {
        const res = await driver.post(d.text);
        this.store.updateDraft(draftId, {
          status: "posted",
          postedAt: new Date().toISOString(),
          postUrl: res.postUrl,
          error: undefined,
        });
        this.store.addLog({
          kind: "post",
          level: "info",
          message: "投稿完了: " + res.postUrl,
          draftId,
          screenshotPath: res.screenshotPath,
        });
      } catch (e) {
        const kind = e instanceof XDriverError ? e.kind : "post_failed";
        const msg = e instanceof Error ? e.message : String(e);
        let screenshotPath: string | undefined;
        try {
          screenshotPath = await driver.screenshot("error");
        } catch {
          /* スクショ取得失敗は無視 */
        }
        this.store.updateDraft(draftId, { status: "failed", error: msg, attempts: d.attempts + 1, screenshotPath });
        this.store.addLog({
          kind: "post",
          level: "error",
          message: "投稿失敗(" + kind + "): " + msg,
          draftId,
          screenshotPath,
        });
      }
      this.notify();
    });
  }
}

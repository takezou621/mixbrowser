import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ActionLog, Draft, DraftStatus, Settings, UiState } from "../shared/types";

export const MAX_TWEET_LEN = 280;

interface StoreData {
  accounts: { id: string; label: string; handle?: string }[];
  drafts: Draft[];
  logs: ActionLog[];
  settings: Settings;
}

const DEFAULT_SETTINGS: Settings = {
  dailyPostLimit: 10,
  minIntervalMinutes: 30,
  activeHours: { start: 8, end: 23 },
};

const MAX_LOGS = 500;

function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/**
 * X の重み付き文字数(twitter-text v3 設定の簡易版)。
 * 既定の重みは 2、コードポイント 0x0000-0x10FF / 0x2000-0x200D / 0x2020-0x202F / 0x2032-0x2037 は 1。
 * 日本語等マルチバイトは 2 カウント(実質約 140 字が上限)。
 * ※ URL の t.co 換算(23 字固定)は未対応で実文字数の概算(M2 で正確化)。過大評価側に倒れるため安全。
 */
export function weightedLength(text: string): number {
  const weight1 = (code: number) =>
    code <= 0x10ff ||
    (code >= 0x2000 && code <= 0x200d) ||
    (code >= 0x2020 && code <= 0x202f) ||
    (code >= 0x2032 && code <= 0x2037);
  let total = 0;
  for (const ch of text) {
    total += weight1(ch.codePointAt(0) ?? 0) ? 1 : 2;
  }
  return total;
}

export class Store {
  private readonly file: string;
  private data: StoreData;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "store.json");
    this.data = this.load();
    if (!this.data.accounts.find((a) => a.id === "main")) {
      this.data.accounts.unshift({ id: "main", label: "Main" });
    }
  }

  private load(): StoreData {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      return {
        accounts: parsed.accounts ?? [{ id: "main", label: "Main" }],
        drafts: parsed.drafts ?? [],
        logs: parsed.logs ?? [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      };
    } catch {
      return {
        accounts: [{ id: "main", label: "Main" }],
        drafts: [],
        logs: [],
        settings: { ...DEFAULT_SETTINGS },
      };
    }
  }

  private save(): void {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  get storePath(): string {
    return this.file;
  }

  /** 設定の部分的な上書き(スモークテストで時間帯制約を緩める等に使用) */
  setSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
  }

  get settings(): Settings {
    return { ...this.data.settings };
  }

  get accounts() {
    return this.data.accounts.map((a) => ({ ...a }));
  }

  getState(): UiState {
    return {
      accounts: this.accounts,
      drafts: [...this.data.drafts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      logs: [...this.data.logs].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 100),
      settings: this.settings,
    };
  }

  addLog(entry: Omit<ActionLog, "id" | "ts">): void {
    this.data.logs.push({ id: randomUUID(), ts: new Date().toISOString(), ...entry });
    if (this.data.logs.length > MAX_LOGS) this.data.logs.splice(0, this.data.logs.length - MAX_LOGS);
    this.save();
  }

  createDraft(input: {
    accountId: string;
    text: string;
    source: "agent" | "manual";
    agentSessionId?: string;
    screenshotPath?: string;
  }): Draft {
    const text = (input.text ?? "").trim();
    if (!text) throw new Error("本文が空です");
    const w = weightedLength(text);
    if (w > MAX_TWEET_LEN) {
      throw new Error(
        "本文の重み付き文字数が " + w + " です(X の上限は " + MAX_TWEET_LEN + "。日本語等マルチバイトは 2 カウント)。短くしてください",
      );
    }
    const now = new Date().toISOString();
    const draft: Draft = {
      id: randomUUID(),
      accountId: input.accountId,
      text,
      status: "pending_approval",
      source: input.source,
      agentSessionId: input.agentSessionId,
      attempts: 0,
      screenshotPath: input.screenshotPath,
      createdAt: now,
      updatedAt: now,
    };
    this.data.drafts.push(draft);
    this.save();
    return { ...draft };
  }

  getDraft(id: string): Draft | undefined {
    const d = this.data.drafts.find((x) => x.id === id);
    return d ? { ...d } : undefined;
  }

  updateDraft(id: string, patch: Partial<Draft>): Draft {
    const d = this.data.drafts.find((x) => x.id === id);
    if (!d) throw new Error("draft が見つかりません: " + id);
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return { ...d };
  }

  removeDraft(id: string): void {
    const i = this.data.drafts.findIndex((x) => x.id === id);
    if (i >= 0) {
      this.data.drafts.splice(i, 1);
      this.save();
    }
  }

  listDrafts(status?: DraftStatus): Draft[] {
    const all = this.data.drafts.map((d) => ({ ...d }));
    return status ? all.filter((d) => d.status === status) : all;
  }

  /** 指定日(ローカル日付、既定は今日)の posted 件数 */
  postedCountOn(accountId: string, day: Date = new Date()): number {
    const key = localDateKey(day);
    return this.data.drafts.filter((d) => {
      if (d.accountId !== accountId || d.status !== "posted" || !d.postedAt) return false;
      // postedAt(UTC ISO)をローカル日付へ変換して比較(UTC日付のslice比較は深夜帯にずれる)
      return localDateKey(new Date(d.postedAt)) === key;
    }).length;
  }

  /** 本日(ローカル日付)の posted 件数 */
  postedTodayCount(accountId: string): number {
    return this.postedCountOn(accountId, new Date());
  }

  lastPostedAt(accountId: string): Date | undefined {
    const times = this.data.drafts
      .filter((d) => d.accountId === accountId && d.status === "posted" && d.postedAt)
      .map((d) => new Date(d.postedAt as string).getTime());
    if (!times.length) return undefined;
    return new Date(Math.max(...times));
  }

  setAccountHandle(accountId: string, handle: string): void {
    const a = this.data.accounts.find((x) => x.id === accountId);
    if (a) {
      a.handle = handle;
      this.save();
    }
  }
}

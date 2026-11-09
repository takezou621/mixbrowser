/** 共有型(メインプロセス / レンダラ / MCP で使用) */

export type DraftStatus =
  | "draft"
  | "pending_approval"
  | "scheduled"
  | "posting"
  | "posted"
  | "failed"
  | "canceled";

export interface Draft {
  id: string;
  accountId: string;
  text: string;
  status: DraftStatus;
  /** 生成元: agent = AIエージェント / manual = ユーザー手動 */
  source: "agent" | "manual";
  agentSessionId?: string;
  /** ISO 8601 */
  scheduledAt?: string;
  postedAt?: string;
  postUrl?: string;
  error?: string;
  attempts: number;
  /** ドライランのプレビュー・スクリーンショットのパス */
  screenshotPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActionLog {
  id: string;
  ts: string;
  kind: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: Record<string, unknown>;
  screenshotPath?: string;
  draftId?: string;
}

export interface Settings {
  /** 1アカウントあたりの日次投稿上限(連投抑制) */
  dailyPostLimit: number;
  /** 投稿間の最小間隔(分) */
  minIntervalMinutes: number;
  /** 投稿を許可する時間帯(ローカル時刻, end は含まない) */
  activeHours: { start: number; end: number };
}

export interface AccountInfo {
  id: string;
  label: string;
  handle?: string;
}

export interface UiState {
  accounts: AccountInfo[];
  drafts: Draft[];
  logs: ActionLog[];
  settings: Settings;
}

export interface AgentResult {
  ok: boolean;
  result?: string;
  sessionId?: string;
  costUsd?: number;
  error?: string;
}

export interface LoginStatus {
  loggedIn: boolean;
  handle?: string | null;
  error?: string;
}

export interface OkErr {
  ok: boolean;
  error?: string;
}

/** preload 経由でレンダラに公開する API */
export interface MixApi {
  getState(): Promise<UiState>;
  getAgentStatus(): Promise<{ available: boolean; version?: string; error?: string }>;
  runAgent(prompt: string): Promise<AgentResult>;
  createManualDraft(text: string): Promise<OkErr & { draftId?: string }>;
  approveNow(draftId: string): Promise<OkErr>;
  scheduleAt(draftId: string, iso: string): Promise<OkErr>;
  cancelSchedule(draftId: string): Promise<OkErr>;
  reject(draftId: string): Promise<OkErr>;
  retry(draftId: string): Promise<OkErr>;
  deleteDraft(draftId: string): Promise<OkErr>;
  checkLogin(): Promise<LoginStatus>;
  navigate(url: string): Promise<OkErr>;
  reload(): Promise<OkErr>;
  openPath(p: string): Promise<OkErr>;
  onStateChanged(cb: () => void): void;
}

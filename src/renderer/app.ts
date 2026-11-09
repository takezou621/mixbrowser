import type { Draft, MixApi, UiState } from "../shared/types";

declare global {
  interface Window {
    mix: MixApi;
  }
}

// ---- 状態 --------------------------------------------------------------

let state: UiState | null = null;
let agentInfo: { available: boolean; version?: string; error?: string } | null = null;
let currentTab: "ai" | "queue" = "ai";
let queueFilter = "ALL";
let agentRunning = false;
let lastAgentText = "";
let promptText = "";
let manualDraftText = "";
const schedInputs: Record<string, string> = {};
/** ユーザーが datetime-local を手動編集したか(未編集ならエージェント提案時刻へ同期する) */
const schedTouched: Record<string, boolean> = {};

/** 許可時間帯内の次のスロット(既定の予約初期値)をローカル入力形式で返す */
function nextAllowedSlot(activeHours: { start: number; end: number }): string {
  const d = new Date();
  d.setMinutes(5, 0, 0);
  if (d.getHours() < activeHours.start) {
    d.setHours(activeHours.start);
  } else if (d.getHours() >= activeHours.end) {
    d.setDate(d.getDate() + 1);
    d.setHours(activeHours.start);
  }
  return localInputValue(d);
}

const STATUS_LABEL: Record<string, string> = {
  draft: "下書き",
  pending_approval: "承認待ち",
  scheduled: "予約済",
  posting: "投稿中…",
  posted: "投稿済",
  failed: "失敗",
  canceled: "却下",
};

const FILTERS: { key: string; label: string }[] = [
  { key: "ALL", label: "すべて" },
  { key: "pending_approval", label: "承認待ち" },
  { key: "scheduled", label: "予約済" },
  { key: "posted", label: "投稿済" },
  { key: "failed", label: "失敗" },
  { key: "canceled", label: "却下" },
];

// ---- ユーティリティ ----------------------------------------------------

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function localInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes())
  );
}

async function act(label: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
  try {
    const r = await fn();
    if (!r.ok && r.error) window.alert(label + " に失敗: " + r.error);
  } catch (e) {
    window.alert(label + " に失敗: " + (e instanceof Error ? e.message : String(e)));
  }
  await refresh();
}

// ---- 描画 --------------------------------------------------------------

function renderSidebar(): void {
  const acc = document.getElementById("account");
  const logs = document.getElementById("logs");
  if (!acc || !logs || !state) return;
  acc.replaceChildren();
  const a = state.accounts[0];
  const handle = el("div", "handle", a?.handle ? "@" + a.handle : "未確認");
  acc.appendChild(handle);
  acc.appendChild(el("div", "dim", "プロファイル: persist:x-main(分離)"));
  acc.appendChild(
    el(
      "div",
      "dim",
      "安全設定: " + state.settings.dailyPostLimit + "件/日, " + state.settings.minIntervalMinutes + "分間隔, " +
        state.settings.activeHours.start + "〜" + state.settings.activeHours.end + "時",
    ),
  );

  logs.replaceChildren();
  for (const l of state.logs.slice(0, 30)) {
    const line = el("div", "log-line" + (l.level === "error" ? " error" : l.level === "warn" ? " warn" : ""));
    line.appendChild(el("span", "ts", fmtTime(l.ts)));
    line.appendChild(el("span", undefined, l.message));
    logs.appendChild(line);
  }
}

function renderAiTab(box: HTMLElement): void {
  box.classList.add("ai-box");
  const st = el("div", "ai-status");
  if (agentInfo && agentInfo.available) {
    st.textContent = "Claude Code: 検出済み(MCP ツール: draft_save / schedule_create など)";
  } else {
    const ng = el("span", "ng", "Claude Code が未検出");
    st.appendChild(ng);
    st.appendChild(el("span", undefined, agentInfo?.error ? " / " + agentInfo.error : ""));
  }
  box.appendChild(st);

  const ta = el("textarea") as HTMLTextAreaElement;
  ta.rows = 4;
  ta.placeholder = "例: 明日の朝7時に、Rustの学習メモについて投稿して";
  ta.value = promptText;
  const run = el("button", "primary", agentRunning ? "実行中… " : "エージェントを実行") as HTMLButtonElement;
  run.disabled = agentRunning || !promptText.trim();
  ta.addEventListener("input", () => {
    promptText = ta.value;
    // 再描画を伴わずボタンの活性だけ更新する(フォーカス/入力を壊さない)
    run.disabled = agentRunning || !promptText.trim();
  });
  box.appendChild(ta);
  run.addEventListener("click", () => {
    const prompt = promptText.trim();
    if (!prompt || agentRunning) return;
    agentRunning = true;
    lastAgentText = "実行中…";
    renderPanelBody();
    void window.mix
      .runAgent(prompt)
      .then((r) => {
        lastAgentText = r.ok
          ? (r.result ?? "完了") + (r.costUsd !== undefined ? "\n\n(cost: $" + r.costUsd.toFixed(4) + ")" : "")
          : "エラー: " + (r.error ?? "不明なエラー");
      })
      .catch((e) => {
        lastAgentText = "エラー: " + (e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        agentRunning = false;
        void refresh();
      });
    promptText = "";
  });
  box.appendChild(run);

  if (lastAgentText) {
    const pre = el("div", "ai-result", lastAgentText);
    box.appendChild(pre);
  }
  box.appendChild(
    el(
      "div",
      "hint",
      "エージェントが作成した投稿は「承認待ち」キューに入ります。投稿キューで内容を確認して承認するまで、実際の投稿は行われません。",
    ),
  );
}

function draftCard(d: Draft): HTMLElement {
  const card = el("div", "card");
  const head = el("div", "head");
  head.appendChild(el("span", "badge " + d.status, STATUS_LABEL[d.status] ?? d.status));
  head.appendChild(el("span", undefined, d.source === "agent" ? "AI" : "手動"));
  head.appendChild(el("span", undefined, fmtTime(d.createdAt)));
  card.appendChild(head);

  card.appendChild(el("div", "text", d.text));

  const meta = el("div", "meta");
  if (d.scheduledAt && d.status === "scheduled") meta.appendChild(el("div", undefined, "予約: " + fmtTime(d.scheduledAt)));
  if (d.postUrl && d.postUrl.startsWith("https://")) {
    const a = document.createElement("a");
    a.href = d.postUrl;
    a.textContent = d.postUrl;
    a.target = "_blank";
    meta.appendChild(el("div", undefined, "投稿URL: "));
    meta.appendChild(a);
  } else if (d.postUrl) {
    meta.appendChild(el("div", undefined, "投稿URL: " + d.postUrl));
  }
  if (d.error) meta.appendChild(el("div", undefined, "エラー: " + d.error));
  card.appendChild(meta);

  const actions = el("div", "actions");
  const openPreview = () => {
    if (d.screenshotPath) void window.mix.openPath(d.screenshotPath);
  };

  if (d.status === "pending_approval") {
    const ok = el("button", "primary", "承認して今すぐ投稿");
    ok.addEventListener("click", () => void act("承認", () => window.mix.approveNow(d.id)));
    actions.appendChild(ok);

    const dt = document.createElement("input");
    dt.type = "datetime-local";
    // ユーザーが編集済みならその値を優先し、未編集ならエージェントの提案時刻(scheduledAt)へ常に同期する。
    // どちらも無い場合は許可時間帯内の次のスロットを初期値にする
    if (!schedTouched[d.id]) {
      if (d.scheduledAt) {
        schedInputs[d.id] = localInputValue(new Date(d.scheduledAt));
      } else if (!schedInputs[d.id] || !state) {
        schedInputs[d.id] = nextAllowedSlot(state?.settings.activeHours ?? { start: 8, end: 23 });
      }
    }
    dt.value = schedInputs[d.id];
    dt.addEventListener("input", () => {
      schedTouched[d.id] = true;
      schedInputs[d.id] = dt.value;
    });
    actions.appendChild(dt);

    const sched = el("button", undefined, "予約で承認");
    sched.addEventListener("click", () => {
      const v = schedInputs[d.id];
      if (!v) {
        window.alert("予約日時を入力してください");
        return;
      }
      const iso = new Date(v).toISOString();
      void act("予約", () => window.mix.scheduleAt(d.id, iso));
    });
    actions.appendChild(sched);

    const ng = el("button", "danger", "却下");
    ng.addEventListener("click", () => void act("却下", () => window.mix.reject(d.id)));
    actions.appendChild(ng);
  } else if (d.status === "scheduled") {
    const cancel = el("button", undefined, "予約を取り消し");
    cancel.addEventListener("click", () => void act("取り消し", () => window.mix.cancelSchedule(d.id)));
    actions.appendChild(cancel);
  } else if (d.status === "failed") {
    const retry = el("button", "primary", "再試行(承認待ちへ)");
    retry.addEventListener("click", () => void act("再試行", () => window.mix.retry(d.id)));
    actions.appendChild(retry);
  }
  if (d.screenshotPath) {
    const pv = el("button", undefined, "プレビュー");
    pv.addEventListener("click", openPreview);
    actions.appendChild(pv);
  }
  // 削除は canceled(終端)のみに限定。pending/scheduled/failed は却下・予約取消・再試行を経由させ、
  // 承認済み/証跡(posted)を直接消して状態遷移を迂回できないようにする
  if (d.status === "canceled") {
    const del = el("button", undefined, "削除");
    del.addEventListener("click", () => void act("削除", () => window.mix.deleteDraft(d.id)));
    actions.appendChild(del);
  }
  card.appendChild(actions);
  return card;
}

function renderQueueTab(box: HTMLElement): void {
  if (!state) return;
  const chips = el("div", "chips");
  for (const f of FILTERS) {
    // キーボード操作可能な button 要素にする(div は focus/Enter 不可)
    const c = el("button", "chip" + (queueFilter === f.key ? " active" : ""), f.label);
    c.addEventListener("click", () => {
      queueFilter = f.key;
      renderPanelBody();
    });
    chips.appendChild(c);
  }
  box.appendChild(chips);

  const manual = el("div", "manual-box");
  manual.appendChild(el("div", "section-label", "手動で下書きを作成(承認待ちに入ります)"));
  const ta = el("textarea") as HTMLTextAreaElement;
  ta.rows = 2;
  ta.placeholder = "投稿本文(280字以内)";
  // 入力中の本文をモジュール状態に保持し、再描画で消えないようにする
  ta.value = manualDraftText;
  ta.addEventListener("input", () => {
    manualDraftText = ta.value;
  });
  const add = el("button", "primary", "承認待ちに追加") as HTMLButtonElement;
  add.disabled = !manualDraftText.trim();
  add.addEventListener("click", () => {
    const t = ta.value;
    if (!t.trim()) return;
    void act("追加", () => window.mix.createManualDraft(t)).then(() => {
      manualDraftText = "";
      renderPanelBody();
    });
  });
  manual.appendChild(ta);
  manual.appendChild(add);
  box.appendChild(manual);

  const drafts = state.drafts.filter((d) => queueFilter === "ALL" || d.status === queueFilter);
  if (!drafts.length) {
    box.appendChild(el("div", "empty", "該当する下書きはありません"));
    return;
  }
  for (const d of drafts) box.appendChild(draftCard(d));
}

function renderPanelBody(): void {
  const body = document.getElementById("panel-body");
  if (!body) return;
  body.replaceChildren();
  if (currentTab === "ai") {
    renderAiTab(body);
  } else {
    renderQueueTab(body);
  }
}

function renderTabs(): void {
  const ai = document.getElementById("tab-ai");
  const q = document.getElementById("tab-queue");
  if (!ai || !q) return;
  ai.classList.toggle("active", currentTab === "ai");
  q.classList.toggle("active", currentTab === "queue");
}

function render(): void {
  renderSidebar();
  renderTabs();
  renderPanelBody();
}

// ---- 初期化 ------------------------------------------------------------

async function refresh(): Promise<void> {
  state = await window.mix.getState();
  render();
}

function init(): void {
  document.getElementById("tab-ai")?.addEventListener("click", () => {
    currentTab = "ai";
    renderPanelBody();
    renderTabs();
  });
  document.getElementById("tab-queue")?.addEventListener("click", () => {
    currentTab = "queue";
    renderPanelBody();
    renderTabs();
  });
  document.getElementById("btn-home")?.addEventListener("click", () => {
    void window.mix.navigate("https://x.com/home");
  });
  document.getElementById("btn-reload")?.addEventListener("click", () => {
    void window.mix.reload();
  });
  const loginMsg = document.getElementById("login-msg");
  document.getElementById("btn-login")?.addEventListener("click", () => {
    if (loginMsg) loginMsg.textContent = "確認中…";
    void window.mix
      .checkLogin()
      .then((r) => {
        if (loginMsg) loginMsg.textContent = r.error ? "エラー: " + r.error : r.loggedIn ? "ログイン中 @" + (r.handle ?? "?") : "未ログイン(内蔵ブラウザで x.com にログインしてください)";
        return refresh();
      })
      .catch((e) => {
        if (loginMsg) loginMsg.textContent = "エラー: " + (e instanceof Error ? e.message : String(e));
      });
  });

  window.mix.onStateChanged(() => void refresh());
  setInterval(() => void refresh(), 8000);
  void window.mix.getAgentStatus().then((s) => {
    agentInfo = s;
    renderPanelBody();
  });
  void refresh();
}

init();

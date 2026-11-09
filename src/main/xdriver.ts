import * as fs from "node:fs";
import * as path from "node:path";
import type { WebContents, WebContentsView } from "electron";
import type { LoginStatus } from "../shared/types";

/**
 * x.com のセレクタレジストリ(MVP)。
 * 注意: data-testid は X の実装変更で変わり得る。変更時はここだけ修正する。
 * (docs/architecture.md §6.2 参照)
 */
export const SEL = {
  textarea: '[data-testid="tweetTextarea_0"]',
  postButton: '[data-testid="tweetButtonInline"]',
  accountBtn: '[data-testid="SideNav_AccountBtn"]',
  closeButton: '[data-testid="app-bar-close"]',
  toast: '[data-testid="toast"]',
  tweetLink: 'article[data-testid="tweet"] a[href*="/status/"]',
} as const;

const HOME_URL = "https://x.com/home";
const COMPOSE_URL = "https://x.com/compose/post";
const POST_URL_MARK = "/status/";

export type XErrorKind =
  | "no_view"
  | "session_expired"
  | "selector_missing"
  | "timeout"
  | "post_failed"
  | "navigation_failed";

export class XDriverError extends Error {
  constructor(public readonly kind: XErrorKind, message: string) {
    super(message);
    this.name = "XDriverError";
  }
}

/**
 * x.com をブラウザ操作(CDP)で動かすドライバ。
 * - 観測は DOM 取得(executeJavaScript)、操作は実入力イベント(Input.dispatch*)に限定する。
 * - .value への直接代入は行わない(React 製エディタで無視される / bot 判定要因)。
 */
export class XDriver {
  constructor(
    private readonly getView: () => WebContentsView | undefined,
    private readonly screenshotDir: string,
  ) {}

  private wc(): WebContents {
    const view = this.getView();
    if (!view) throw new XDriverError("no_view", "内蔵ブラウザが利用できません");
    return view.webContents;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async dbg(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const wc = this.wc();
    if (!wc.debugger.isAttached()) {
      await wc.debugger.attach("1.1");
    }
    return wc.debugger.sendCommand(method, params);
  }

  async navigate(url: string): Promise<void> {
    try {
      await this.wc().loadURL(url);
    } catch (e) {
      // ERR_ABORTED 等の SPA リダイレクトは無視(ページは表示されている場合が多い)
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("ERR_ABORTED")) throw new XDriverError("navigation_failed", url + " への遷移に失敗: " + msg);
    }
  }

  private async evalJs<T>(code: string): Promise<T> {
    return (await this.wc().executeJavaScript(code, false)) as T;
  }

  private async waitForSelector(selector: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const code = "!!document.querySelector(" + JSON.stringify(selector) + ")";
    while (Date.now() < deadline) {
      if (await this.evalJs<boolean>(code)) return;
      await this.sleep(300);
    }
    throw new XDriverError("selector_missing", "要素が見つかりません(タイムアウト): " + selector);
  }

  private async waitForGone(selector: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const code = "!!document.querySelector(" + JSON.stringify(selector) + ")";
    while (Date.now() < deadline) {
      if (!(await this.evalJs<boolean>(code))) return true;
      await this.sleep(300);
    }
    return false;
  }

  private async rectOf(selector: string): Promise<{ x: number; y: number } | null> {
    return this.evalJs<{ x: number; y: number } | null>(
      "(() => { const el = document.querySelector(" +
        JSON.stringify(selector) +
        "); if (!el) return null; const r = el.getBoundingClientRect();" +
        " return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
    );
  }

  private async clickSelector(selector: string, timeoutMs = 10000): Promise<void> {
    await this.waitForSelector(selector, timeoutMs);
    const r = await this.rectOf(selector);
    if (!r) throw new XDriverError("selector_missing", "要素の位置を取得できません: " + selector);
    await this.dbg("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await this.sleep(30 + Math.floor(Math.random() * 40));
    await this.dbg("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  }

  private static vkFor(ch: string): number {
    if (/[a-z]/.test(ch)) return ch.toUpperCase().charCodeAt(0);
    return ch.charCodeAt(0);
  }

  /** 実キーイベントで入力する。非ASCIIは Input.insertText(IME確定相当)。 */
  async typeText(text: string): Promise<void> {
    for (const ch of text) {
      if (ch === "\n") {
        await this.dbg("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: "\r",
        });
        await this.dbg("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
      } else if (/[ -~]/.test(ch)) {
        const vk = XDriver.vkFor(ch);
        await this.dbg("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: ch,
          text: ch,
          unmodifiedText: ch,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        });
        await this.dbg("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: ch,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        });
      } else {
        await this.dbg("Input.insertText", { text: ch });
      }
      // 人間らしい入力間隔(ジッタ)
      await this.sleep(35 + Math.floor(Math.random() * 80));
    }
  }

  async pressEscape(): Promise<void> {
    await this.dbg("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await this.dbg("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }

  async screenshot(label: string): Promise<string> {
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    const image = await this.wc().capturePage(undefined, { stayHidden: true, stayAwake: true });
    const file = path.join(this.screenshotDir, label + "-" + Date.now() + ".png");
    fs.writeFileSync(file, image.toPNG());
    return file;
  }

  /** ログイン状態の確認。ハンドルが取れれば返す */
  async isLoggedIn(): Promise<LoginStatus> {
    await this.navigate(HOME_URL);
    await this.sleep(2000);
    const url = this.wc().getURL();
    if (url.includes("/i/flow/login") || url.includes("/login")) {
      return { loggedIn: false };
    }
    return this.evalJs<LoginStatus>(
      "(() => { const nav = document.querySelector('" +
        SEL.accountBtn +
        "'); if (!nav) return { loggedIn: false };" +
        " const href = nav.getAttribute('href') || '';" +
        " const handle = href.startsWith('/') ? href.slice(1).split('/')[0] : null;" +
        " return { loggedIn: true, handle: handle }; })()",
    );
  }

  private async assertLoggedIn(): Promise<string> {
    const st = await this.isLoggedIn();
    if (!st.loggedIn) {
      throw new XDriverError("session_expired", "X にログインしていません。内蔵ブラウザでログインしてください");
    }
    return st.handle ?? "";
  }

  private async openCompose(): Promise<void> {
    await this.navigate(COMPOSE_URL);
    await this.waitForSelector(SEL.textarea, 12000);
    await this.sleep(400);
  }

  private async closeCompose(): Promise<boolean> {
    try {
      await this.clickSelector(SEL.closeButton, 3000);
    } catch {
      await this.pressEscape();
    }
    await this.sleep(600);
    return this.waitForGone(SEL.textarea, 4000);
  }

  /** ドライラン: 送信直前で停止しプレビュー(スクショ)を返す。投稿はしない */
  async dryRunCompose(text: string): Promise<{ screenshotPath: string }> {
    await this.assertLoggedIn();
    await this.openCompose();
    await this.clickSelector(SEL.textarea, 8000);
    await this.typeText(text);
    const screenshotPath = await this.screenshot("dryrun");
    await this.closeCompose();
    return { screenshotPath };
  }

  private async waitForEnabled(selector: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const code =
      "(() => { const el = document.querySelector(" +
      JSON.stringify(selector) +
      "); if (!el) return false; const btn = el.closest('button');" +
      " if (!btn) return false; return !btn.disabled && btn.getAttribute('aria-disabled') !== 'true'; })()";
    while (Date.now() < deadline) {
      if (await this.evalJs<boolean>(code)) return;
      await this.sleep(250);
    }
    throw new XDriverError("timeout", "投稿ボタンが有効になりません(文字数上限の可能性があります)");
  }

  private async toastText(): Promise<string | null> {
    try {
      return this.evalJs<string | null>(
        "(() => { const t = document.querySelector('" + SEL.toast + "'); return t ? t.textContent : null; })()",
      );
    } catch {
      return null;
    }
  }

  private async findLatestPostUrl(handle: string): Promise<string> {
    await this.navigate("https://x.com/" + handle);
    await this.sleep(2500);
    const code =
      "(() => { const a = document.querySelector('" +
      SEL.tweetLink +
      "'); return a ? a.getAttribute('href') : null; })()";
    for (let i = 0; i < 5; i++) {
      const href = await this.evalJs<string | null>(code);
      if (href) {
        const idx = href.indexOf(POST_URL_MARK);
        if (idx >= 0) {
          const rest = href.slice(idx + POST_URL_MARK.length).split("?")[0].split("/")[0];
          return "https://x.com" + href.slice(0, idx + POST_URL_MARK.length) + rest;
        }
      }
      await this.sleep(1500);
    }
    throw new XDriverError("post_failed", "投稿後の URL を確認できませんでした(プロフィールに表示されていない可能性)");
  }

  /** 投稿を実行し、投稿URLを検証して返す */
  async post(text: string): Promise<{ postUrl: string; screenshotPath: string }> {
    const handle = await this.assertLoggedIn();
    await this.openCompose();
    await this.clickSelector(SEL.textarea, 8000);
    await this.typeText(text);
    await this.waitForEnabled(SEL.postButton, 6000);
    const shotBefore = await this.screenshot("pre-submit");
    await this.clickSelector(SEL.postButton, 5000);
    const closed = await this.waitForGone(SEL.textarea, 10000);
    if (!closed) {
      const toast = await this.toastText();
      throw new XDriverError("post_failed", "投稿が完了しませんでした" + (toast ? "( " + toast + " )" : ""));
    }
    await this.sleep(2000);
    const postUrl = await this.findLatestPostUrl(handle);
    return { postUrl, screenshotPath: shotBefore };
  }
}

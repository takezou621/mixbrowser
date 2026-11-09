# mixbrowser アーキテクチャ(ドラフト v0.1)

- ステータス: ドラフト(レビュー待ち)
- 関連: [製品仕様](spec.md) / [ロードマップ・オープン課題](roadmap.md)

## 1. 実装形態の比較と推奨

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| **A案: Electron**(推奨) | Chromium + Node.js ランタイム上に構築 | 開発速度が最速。`webContents.debugger` で CDP を直接使える。Node のエコシステム(スケジューラ、SQLite、MCP SDK)をそのまま使える | Chromium のバージョン追従は Electron 依存。ブラウザ本体の深い改変は不可 |
| B案: Chromium fork | ソースから Chromium をビルドして改変 | ブラウザ本体レベルの制御(独自 API、ネイティブサイドパネル) | ビルド環境が重い(数時間/フルビルド)、追従コストが極大。MVP には不向き |
| C案: Playwright + 常駐サービス | ローカル常駐プロセス + 通常の Chrome を制御 | 最も軽量 | 「専用ブラウザ」としての UX(プロファイル管理、AI パネル)を別途作ることになる |

**推奨:** A案(Electron)で開始し、[§2](#2-コンポーネント構成) の `XDriver` / `BrowserToolServer` をインターフェース越しに実装しておく。これにより将来 B案(Chromium fork)へ段階移行する際も、エージェント連携層と UI を再利用できる。

## 2. コンポーネント構成

```mermaid
flowchart LR
  subgraph Renderer
    UI[内蔵ブラウザ(BrowserView)]
    Panel[AIパネル / キューUI]
  end
  subgraph Main["Main プロセス(Node.js)"]
    PM[ProfileManager]
    SV[SessionVault<br/>(OSキーチェーン連携)]
    SC[Scheduler]
    AO[AgentOrchestrator<br/>claude-code / glm / muse(stub)]
    BTS[BrowserToolServer<br/>(MCP: Streamable HTTP / 127.0.0.1 + Bearer)]
    XD[XDriver<br/>(CDP via webContents.debugger)]
    DB[(SQLite)]
  end
  Panel --> AO
  AO --> BTS
  SC --> BTS
  BTS --> XD
  XD --> UI
  PM --> SV
  PM --> DB
  SC --> DB
  AO --> DB
```

- **ProfileManager**: アカウントごとに Electron の persistent partition を割り当て、cookie / storage を分離。プロキシ設定(v2)もここで受け持つ
- **SessionVault**: セッション cookie 等の秘密情報を OS キーチェーン(macOS Keychain / Windows DPAPI / libsecret)に保存
- **Scheduler**: 予約時刻の管理と実行トリガ。キューは SQLite に永続化し、クラッシュ後も復帰
- **AgentOrchestrator**: エージェントランタイムの差異(Claude Code CLI / GLM function-calling ループ)を吸収し、同一のツール群を見せる
- **BrowserToolServer**: MCP サーバ(Streamable HTTP)。**Electron Main プロセス内**で `127.0.0.1` 限定 + Bearer 認証で待ち受け、Claude Code は起動時に自動生成される `mixbrowser.mcp.json`(HTTP トランスポート設定)経由で接続する。**stdio サーバを Claude Code 側に別プロセス起動する構成は採らない**(ブラウザ操作ツールは Main の XDriver を直接呼ぶため、別プロセス→Main の転送経路が不要になる)
- **XDriver**: `webContents.debugger` で CDP アタッチし、観測(Runtime.evaluate / アクセシビリティツリー)と操作(Input.dispatchKeyEvent / Input.dispatchMouseEvent)を行う

### 将来ディレクトリ構成(案)

```
apps/
  shell/          # Electron メインプロセス
  ui/             # レンダラ(React)
packages/
  mcp-server/     # BrowserToolServer(MCP)
  x-driver/       # X 操作ロジック + セレクタレジストリ
  agent-runtimes/ # claude-code / glm / muse(stub) アダプタ
  db/             # SQLite スキーマ + DAO
  shared/         # 共有型・設定
docs/
```

## 3. AI 連携方式

### 3.1 Claude Code

- バッチ: `claude -p "<指示>" --mcp-config mixbrowser.mcp.json --allowedTools "mcp__mixbrowser__*"`
- 対話: AI パネルから Claude Code(Agent SDK / サブプロセス)を起動し、同 MCP サーバに接続
- 接続方式: `mixbrowser.mcp.json` は HTTP トランスポート(`"type": "http"`)の設定で、Main プロセスが自動生成する。stdio サーバを別プロセスで起動して Main へ転送する構成は採らない
- 認証: ユーザー自身の Claude Code 環境(サブスク / API キー)をそのまま利用。本アプリは認証を代理しない

### 3.2 GLM

- OpenAI 互換 chat completions API(Z.ai / open.bigmodel.cn など)+ function calling で、MCP ツール群を同じ意味論でループ実行
- 代替構成: GLM Coding Plan の Anthropic 互換エンドポイントを `ANTHROPIC_BASE_URL` 等で指定し、Claude Code のバックエンドとして GLM を使う運用も可能(ツール層が共通のため両対応は低コスト)

### 3.3 Muse(Meta)【未確定】

- 「Muse」の正体・公式 API の有無が未確認(→ [Q1](roadmap.md))
- 対応方針: コンテンツ生成ソースの共通インターフェース

```ts
interface ContentGenerator {
  id: "claude-code" | "glm" | "muse" | ...;
  generate(input: { prompt: string; constraints: PostConstraints }): Promise<Draft[]>;
}
```

- 公式 API が存在しない場合は、他サービスと同様に「ブラウザ連携アダプタ」として実装する可能性もある。確定までスタブ

## 4. MCP ツール仕様(初期セット)

各ツールにはリスクレベル(low / medium / high)を付与し、`high` は承認ゲートの対象とする。

| ツール | 引数(主要) | リスク | 説明 |
|---|---|---|---|
| `browser_navigate` | profileId, url | low | 指定プロファイルでページ遷移 |
| `browser_snapshot` | profileId | low | アクセシビリティツリーを JSON(ref 付き)で返す。DOM 生文字列より安全で安定 |
| `browser_click` | profileId, ref | medium | スナップショットの ref をクリック(実マウスイベント) |
| `browser_type` | profileId, ref, text, submit? | medium | 実キー入力でテキスト入力(1 文字ずつ + ジッタ) |
| `browser_key` | profileId, key | medium | 単一キー操作(Enter 等) |
| `browser_screenshot` | profileId, fullPage? | low | スクリーンショット取得(証跡用) |
| `browser_file_upload` | profileId, ref, paths[] | medium | ファイル添付(CDP `DOM.setFileInputFiles`) |
| `x_open_compose` | profileId | medium | x.com の投稿コンポーザを開く |
| `x_create_post` | profileId, items[{text, imagePaths?}], dryRun? | **high** | 投稿実行。items 複数でスレッド。既定 dry-run |
| `x_verify_post` | profileId, expectText | low | 投稿後の検証(タイムライン再読込で投稿 URL を確認) |
| `draft_save` / `draft_list` | account, text, mediaPaths, status? | low | 下書きキュー操作 |
| `schedule_create` / `schedule_list` / `schedule_cancel` | draftId, runAt | low | 予約管理 |
| `action_log_write` | level, message, meta | low | 監査ログ追記 |

> **汎用ツールの制約(M2 導入時)。** `browser_click` / `browser_type` / `browser_key` 等の汎用ツールで X の**送信系要素**(投稿ボタン等)を操作することを禁止し、ツール層でブロックする。投稿の実行は `x_create_post`(承認ゲート + ドライランを通る承認済み経路)に限定する。M1 は汎用ツールを持たないため影響なし。
>
> また `browser_file_upload`(M2 導入時)は、**ユーザーが明示許可したファイル**のみ、**意図したページ要素**にのみ渡せるよう認可する。ページの JavaScript は添付ファイルの内容を読み取れるため、秘密性の高いファイル(鍵・認証情報等)は常に除外対象とする。

## 5. データモデル(SQLite)

| テーブル | 主要カラム |
|---|---|
| `accounts` | id, label, x_handle, profile_ref, status, created_at |
| `drafts` | id, account_id, body, media_paths(json), status, source_agent, created_at |
| `scheduled_posts` | id, draft_id, run_at, status, attempts, last_error, post_url, posted_at |
| `action_logs` | id, scheduled_post_id?, account_id, kind, detail(json), screenshot_path, created_at |
| `agent_sessions` | id, runtime, model, input_summary, tool_calls(json), created_at |
| `app_settings` | key, value(json) |

秘密情報(cookie / token)は DB に保存せず、OS キーチェーンに委譲する(`profile_ref` は参照のみ)。

## 6. X 操作の技術詳細(API 不使用方針の実装)

### 6.1 観測

- アクセシビリティツリーのスナップショットを第一選択とする(class 名の難読化変更に強い) **※M1 実装は `data-testid` セレクタ + DOM クエリによる観測(SEL レジストリ集約)。アクセシビリティツリー観測への移行は M2**
- 必要時のみ `Runtime.evaluate` で補助取得

### 6.2 セレクタ戦略

1. `data-testid` 属性(例: 投稿本文 `tweetTextarea_0`、投稿ボタン `tweetButtonInline`)— ※実際の値は要検証、変更があり得る
2. aria-label / role ベースのフォールバック
3. セレクタレジストリ(バージョン付き)で一元管理し、候補を複数持って自己修復(失敗時はスナップショットから再探索)

### 6.3 操作

- 入力は **実キーイベント**(`Input.dispatchKeyEvent`)を 1 文字ずつ、間隔にジッタを入れて送る(`.value` への直接代入は React 製エディタで無視され、bot 判定の要因にもなるため禁止)
- クリックは `Input.dispatchMouseEvent`
- 画像添付は `DOM.setFileInputFiles` でファイル選択ダイアログを迂回
- 投稿後はプロフィール / タイムラインを再読込し、本文一致 + `/status/` リンク検出で投稿 URL を特定する(`x_verify_post`)
- 1 アカウントの自動操作は直列(同時実行しない)

### 6.4 失敗ハンドリング

| 検出 | 判定方法 | 対応 |
|---|---|---|
| セッション失効 | ログイン画面へのリダイレクト検出 | リトライせず停止、再ログインを UI で依頼 |
| DOM 構造変更 | セレクタ解決失敗(全候補) | スクショ保存して failed、セレクタレジストリ更新チケット |
| レート抑制 / 制限表示 | 画面上の警告文言検出 | 停止、当日の該当アカウント実行を停止 |

## 7. セキュリティ設計

- **保存**: セッション cookie 等は OS キーチェーン。DB 本体は SQLCipher による暗号化オプションを用意
- **分離**: プロファイルごとに Electron partition を分離。アカウント間で cookie を共有しない
- **エージェント権限**: ツールホワイトリスト。高リスクツール(`x_create_post` 等)は承認ゲートを必須化
- **プロンプトインジェクション対策**: X のタイムライン等「ページ内テキスト」はエージェントへの指示ではなくデータとして注入し、出所をタグ付けする。**ただしタグは補助的な対策であり、モデルの誤従事を完全には防げない**(タグ付きデータ由来でも高リスクツールの呼び出し自体は生成され得る)。最終的な保証は (1) 承認ゲートによる人間確認、(2) ツール層の制限(汎用ツールからの送信遮断・高リスク操作の人間承認必須)によって行う
- **ネットワーク**: アプリ自身が任意に追加送信するデータはない(テレメトリ等なし)。通信先は (a) 内蔵ブラウザが閲覧するサイト(x.com 等の通常ブラウジング相当)(b) ユーザー設定の LLM エンドポイント の 2 系統に限られ、エージェントへ渡すデータも投稿運用に必要な範囲(本文・下書き・スクリーンショット)に留める

## 8. テスト方針

| 種類 | 内容 |
|---|---|
| 単体 | セレクタ解決、スケジューラ、キュー状態遷移 |
| セレクタスモーク | 実環境で週次実行。実アカウントでは **ドラフト保存まで** で停止し投稿しない |
| E2E | ドライランモードで送信直前までを検証 |
| 変更検知 | x.com のスナップショット diff を週次で取得し、セレクタレジストリの更新要否を判定 |

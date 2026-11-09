# mixbrowser

X アカウントの自動投稿を効率化する、AI 連携専用ブラウザ(Chromium ベース)のプロジェクトです。
X とは公式 API を使わず、**ブラウザ操作**で連携します。Claude Code / GLM などの AI エージェントと連携し、投稿文の生成から予約・実行までを 1 つのアプリで行います。

## ドキュメント

- [製品仕様](docs/spec.md) — 目的・スコープ・機能要件・コンプライアンス方針
- [アーキテクチャ](docs/architecture.md) — 実装形態比較・コンポーネント構成・MCP ツール仕様・X 操作の技術詳細
- [ロードマップ & オープン課題](docs/roadmap.md) — マイルストーン・決定すべき事項(Q1〜Q7)・リスク

## MVP(M1)の実装

`npm start` で起動します(要: Node.js 22.12+(Electron 45 の要件)、[Claude Code CLI](https://docs.anthropic.com/ja/docs/claude-code)(AI パネル利用時))。

```bash
npm install
npm run build   # main / preload / renderer を dist/ にバンドル
npm start       # アプリ起動
npm run smoke   # スモークテスト(Electron 起動 + MCP 往復検証 / 小ウィンドウが一瞬表示されます)
npm run typecheck
```

### 使い方

1. 起動したら中央の内蔵ブラウザで **x.com にログイン**(初回のみ手動。セッションはプロファイル `persist:x-main` に保持され、再起動後も有効)
2. 右パネル「AIエージェント」で指示(例: 「明日の朝 7 時に Rust の学習メモについて投稿して」)
3. エージェントは MCP ツールで下書きを作成 → **承認待ち** キューに入る
4. 「投稿キュー」で内容を確認し、**承認して今すぐ投稿** or **予約で承認**
5. 投稿実行結果(投稿 URL・スクリーンショット)はキューとアクションログに記録される

### M1 の受け入れ条件との対応

| 条件 | 状態 |
|---|---|
| x.com 手動ログイン + セッション永続化 | ✅ 実装(persistent partition / 要手動確認) |
| AI パネルから Claude Code が起動し MCP で下書き作成 | ✅ 実装(要手動確認) |
| 承認ゲート経由でのみ投稿が実行される | ✅ 実装+スモークテストで検証(MCP からの実行は常に拒否) |
| ドライランで送信直前のプレビュー + スクショ取得 | ✅ 実装(`x_create_post` は M1 では常にドライラン) |
| 予約時刻に投稿が実行され URL が記録される | ✅ 実装(要手動確認 / アプリ起動中のみ実行) |

### 仕様からの実装上の決定事項(M1)

- **ストレージ**: SQLite → M1 は JSON(`userData/store.json`)に簡略化(SQLCipher は M2+)
- **シークレット管理**: Chromium の cookie 暗号化 + プロファイル分離に依存(OS キーチェーン SessionVault は M2+)
- **MCP ツール**: 仕様のサブセット 9 種。汎用 browser_* ツールは M2+
- **未対応**: スレッド連投・画像添付・全自動実行モード(FR-5.2)は M2 以降
- **X 操作**: CDP `Input.dispatchKeyEvent` による実キー入力(ASCII)/ 非 ASCII は `Input.insertText`。セレクタは `src/main/xdriver.ts` の `SEL` に集約

### 既知の制限

- 予約実行は **アプリが起動している間のみ** 動作します(常駐デーモンは M2+)
- 投稿実行時、内蔵ブラウザが x.com に遷移します(操作の透明性のため headless にしない方針)
- X の data-testid 変更時は `src/main/xdriver.ts` の `SEL` を更新してください

> 本リポジトリは仕様(docs/)と M1 実装(src/)を含みます。コンプライアンス上の注意は [spec.md §7](docs/spec.md) を参照してください。
# TokensLeft

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md)

AI サブスクリプションの上限、リセット時刻、消費ペース、ローカルのモデル使用量を確認できる高速なターミナルダッシュボードです。

![TokensLeft コンパクト表示](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot.png)

![TokensLeft Codex 詳細表示](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot2.png)

## クイックスタート

```sh
npx tokensleft
```

ログイン済みの Claude Code、Codex、Gemini CLI、Kimi Code、GitHub Copilot、Grok、Antigravity、OpenCode、z.ai を自動検出します。Node.js 20.18.1 以降が必要です。Node 20 など `node:sqlite` を利用できない環境では、Antigravity と OpenCode はスキップされます。

## コマンド

```text
tokensleft [providers...] [options]

--demo            ローカルのデモデータで実行
--once            プレーンテキストを一度出力して終了
--json            JSON を一度出力して終了
--interval <秒>   更新間隔を変更
--read-only       認証情報を更新・永続保存しない
-h, --help        ヘルプを表示
-v, --version     インストール済みバージョンを表示
```

`tokensleft claude codex` のように任意の組み合わせを指定できます。未指定の場合は、検出された Provider をすべて表示します。

## TUI キー

`r` すべて更新 · `1`–`9` 個別更新 · `d` 詳細表示 · `t` リセット履歴（検出後のみ表示） · `?` ヘルプ · 矢印/PgUp/PgDn/マウスでスクロール · `q`/Esc 終了

既定は 256 色です。制限のある端末では `TOKENSLEFT_COLOR=basic` または `NO_COLOR=1` を設定してください。

## 認証情報とプライバシー

- 既存 CLI のログイン情報をローカルで検出します。手動キーは `~/.tokensleft/.env` または `./.env` に保存できます。詳細は [.env.example](.env.example) を参照してください。
- 上限リクエストは TokensLeft のサービスを経由せず、各 Provider へ直接、または設定済み proxy 経由で送信されます。TokensLeft のアカウント、サーバー、分析、テレメトリーはありません。
- ローカル使用量は端末内の CLI ログだけから計算され、アップロードされません。
- 予期しないリセット履歴は `~/.tokensleft/reset-history.json` にローカル保存され、Provider・上限項目名・検出時刻のみを記録します。
- OAuth 認証情報は必要時に安全に更新・保存されます。`--read-only` で更新と永続的な認証情報の変更を無効化できます。

ローカルのドル金額は公開 API 価格による推定で、サブスクリプション請求額ではありません。不明または一部のみの価格は明示されます。予測は単純な線形推定であり、保証ではありません。

## 開発

```sh
git clone https://github.com/tokensleft/tokensleft.git
cd tokensleft
npm ci
npm test
npm run demo
```

[セキュリティポリシー](SECURITY.md) · MIT ライセンス。

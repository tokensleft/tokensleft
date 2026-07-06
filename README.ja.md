# tokensleft

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md)

トークンはあとどれくらい残ってる?AI サブスクリプションのクォータをターミナル 1 画面で — Claude Code(Anthropic)、Codex(OpenAI)、Gemini CLI、GitHub Copilot、Grok CLI、Antigravity、OpenCode、z.ai。バーンレート予測、しきい値アラート、認証情報の自動検出 + OAuth トークン自動リフレッシュ、さらに Claude Code のローカル・モデル別トークン/コスト集計(Fable 含む)を搭載。

![tokensleft ダッシュボード — 検出された各プロバイダのクォータバー、ペース予測、モデル別コスト表](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot.png)

## クイックスタート

```sh
npx tokensleft
```

これだけ。ログイン済みの CLI は自動検出され、認証情報のないプロバイダは表示されません。

| コマンド | 表示内容 |
|---|---|
| `npx tokensleft` | 検出された全プロバイダを 1 つの TUI に |
| `npx tokensleft claude` | Claude Code のレート制限(Session / Weekly / モデル別 例: Fable)+ ローカルのトークン & コスト表 |
| `npx tokensleft codex` | Codex(ChatGPT プラン)の session/weekly/モデル制限、reviews、credits |
| `npx tokensleft gemini` | Gemini CLI の Pro/Flash 日次クォータ |
| `npx tokensleft copilot` | GitHub Copilot の premium/chat クォータ(無料プラン: chat/completions) |
| `npx tokensleft grok` | Grok CLI の月間クレジット + 従量課金上限 |
| `npx tokensleft antigravity` | Antigravity のモデルプール別クォータ(Gemini Pro / Flash / Claude) |
| `npx tokensleft opencode` | OpenCode Go プランの支出 vs session/週/月のドル上限 |
| `npx tokensleft zai` | z.ai アカウントのクォータ |
| `npx tokensleft claude codex` | プロバイダの任意の組み合わせ |
| `npx tokensleft --demo` | ランダム生成のリアルなダミーデータ — スクリーンショット用 |

### オプション

- `--demo` — リアルなランダムデータ。認証情報には一切触れず、ネットワーク通信もしません。値は起動時に一度だけ決まり、TUI のリフレッシュでも安定したまま、リセットのカウントダウンだけが進みます。
- `--once` — プレーンテキストのスナップショットを 1 回出力して終了(パイプ時は自動で有効)
- `--json` — 機械可読な JSON を出力して終了
- `--interval <秒>` — リフレッシュ間隔を上書き
- `-h, --help` — 使い方

Node.js ≥ 22.13 が必要です。

## キー:自動検出 + 手動設定

対応する CLI/アプリにログイン済みなら、どのプロバイダも設定ゼロで動きます。手動のキーは `~/.tokensleft/.env`(どのディレクトリからでも読める — `npx` 向き)または `./.env`(カレントディレクトリ、競合時はこちらが優先)に置きます。[.env.example](.env.example) を参照。

| プロバイダ | 自動(システム) | 手動(.env) | トークンリフレッシュ |
|---|---|---|---|
| Claude Code | `~/.claude/.credentials.json` をリフレッシュごとに再読込 | `CLAUDE_TOKEN_1..N`、`CLAUDE_CODE_OAUTH_TOKEN` | ✅ 期限の約 5 分前に refresh token で更新し書き戻し |
| Codex | `~/.codex/auth.json`(または `CODEX_HOME`) | — | ✅ 8 日超過または 401 時に自動更新 |
| Gemini | `~/.gemini/oauth_creds.json` | — | ✅ 期限の約 5 分前に更新(クライアント認証情報はローカルの CLI から読み取り、公開値にフォールバック) |
| Copilot | Copilot の `apps.json`/`hosts.json`、gh CLI の `hosts.yml` | `COPILOT_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | リフレッシュごとにディスクから再解決 |
| Grok | `~/.grok/auth.json`(最初の未失効キー) | `GROK_TOKEN` | 対象外(grok login のみ) |
| Antigravity | `state.vscdb` の OAuth エンベロープ(protobuf、SQLite) | — | ✅ Google OAuth リフレッシュ、`~/.tokensleft` にキャッシュ |
| OpenCode | `~/.local/share/opencode` の認証 + ローカル `opencode.db` の支出 | — | 対象外(ローカル集計) |
| z.ai | `api.z.ai` を指す Claude Code プロファイル(`settings*.json`) | `ZAI_KEY_1..N` / `ZAI_API_KEY` / CSV | 対象外(静的キー) |

自動検出されたキーは手動設定と重複排除されます。リフレッシュされた OAuth トークンは、各 CLI 自身の認証ファイルへ同じ形式でアトミックに書き戻されます(ベンダー CLI と同じ挙動)— refresh token が有効な限り、ダッシュボードに `EXPIRED` は出ません。

## TUI のキー操作

`r` 全体リフレッシュ · `1`-`9` 個別リフレッシュ · `d` 詳細表示切替 · `q`/`Esc` 終了 · 矢印キー/マウスでスクロール。

## 数字の仕組み

予測はあえてシンプルに 1 つだけ:現在ウィンドウの線形外挿です。ウィンドウの `e%` が経過した時点でクォータを `u%` 使っていれば、リセット時には `u/e·100%` に到達するペース。答える問いはただ 1 つ — クォータはリセットまで持つか?

- 実線の `█` は**使用済み量**、薄い `░` の尾は**現在のペースでリセット時に到達する位置**まで伸びます。尾の色は予測の着地点で決まり、赤い尾は赤ゾーンへ向かっているサイン。
- `→n%` は同じ数字のテキスト表示。`✓ pace` / `▲+n%` は使用% と経過% の比較です。
- 線形ペースがリセット**前**に 100% を超える場合、`⚠ dry in X` と到達時刻が表示されます。
- 80% / 90% を超えるとターミナルベルが鳴り、ヘッダーに赤いアラートが出ます。

## Claude Code 固有の仕様

- **自動(システム)キー**:**リフレッシュごとに** `~/.claude/.credentials.json`(または `CLAUDE_CONFIG_DIR`)から再読込。期限切れトークンは保存済み refresh token で更新して書き戻すため(minified JSON、アトミック)、ローテーション後も Claude Code はそのまま動き続けます。
- **手動キー**:`.env` の `CLAUDE_TOKEN_1..N`(+ `CLAUDE_NAME_1..N`)または `CLAUDE_CODE_OAUTH_TOKEN` — 追加アカウントや Claude Code 未導入マシン用。システムトークンと重複するものはスキップ。
- **レート制限**は Anthropic の OAuth usage エンドポイント由来:5 時間セッション、週間全モデル、モデル別週間スコープ(例: Fable)、有効時は extra-usage/spend も。
- **ローカル使用量テーブル**は `~/.claude/projects/**/*.jsonl` のトランスクリプト(直近 7 日、増分スキャン)をモデル別の input/output/cache トークン、メッセージ数、公開 API 価格ベースの推定コストに集計 — サブスクリプションは前払いなので $ 列はスケール感の参考です。

## 開発

```sh
git clone <repo> && cd tokensleft
npm install
npm start              # = node bin/tokensleft.js
npm start -- claude    # 単一プロバイダ
npm run demo           # ダミーデータのダッシュボード
npm test               # ユニットテスト(node --test)
```

```
bin/       tokensleft CLI エントリ(npx tokensleft [providers...] [options])
lib/       共有:dotenv、フォーマット、予測(線形)、バー/ブロック、http、
           claude-settings 検出、アトミック書き込み、blessed シェル、CLI、demo データ
providers/ claude / codex / gemini / copilot / grok / antigravity / opencode / zai
test/      node --test スイート
```

Antigravity と OpenCode は Node 組み込みの `node:sqlite` でローカル SQLite を読みます(ネイティブ依存なし)。

`.env` は git-ignore 済み。本物のキーは絶対にコミットしないでください。

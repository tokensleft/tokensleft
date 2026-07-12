# tokensleft

[English](README.md) · **繁體中文** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

我的 token 還剩多少?一個終端機儀表板看遍所有 AI 訂閱配額 — Claude Code(Anthropic)、Codex(OpenAI)、Gemini CLI、GitHub Copilot、Grok CLI、Antigravity、OpenCode、z.ai — 內建燃燒速率預測、閾值警報、自動憑證探索 + OAuth token 自動更新,以及 Claude Code(含 Fable)、Codex、Gemini CLI 與 OpenCode 的本地逐模型 token/成本統計。

![tokensleft 儀表板 — 每個偵測到的服務的配額進度條、速度預測與逐模型成本表](https://cdn.jsdelivr.net/gh/tokensleft/tokensleft@main/docs/screenshot.png)

## 快速開始

```sh
npx tokensleft
```

就這樣。已登入的 CLI 會自動偵測;沒有憑證的服務不會出現。

| 指令 | 顯示內容 |
|---|---|
| `npx tokensleft` | 所有偵測到的服務,一個 TUI 全包 |
| `npx tokensleft claude` | Claude Code 速率限制(Session / Weekly / 逐模型如 Fable)+ 本地 token 與成本表 |
| `npx tokensleft codex` | Codex(ChatGPT 方案)session/weekly/模型限制、reviews、credits + 本地 token 與成本表 |
| `npx tokensleft gemini` | Gemini CLI Pro/Flash 每日配額 + 本地 token 與成本表 |
| `npx tokensleft copilot` | GitHub Copilot premium/chat 配額(免費方案:chat/completions) |
| `npx tokensleft grok` | Grok CLI 每月 credits + 按量付費上限 |
| `npx tokensleft antigravity` | Antigravity 逐模型池配額(Gemini Pro / Flash / Claude) |
| `npx tokensleft opencode` | OpenCode Go 方案花費 vs session/週/月美元上限 + 本地逐模型表 |
| `npx tokensleft zai` | z.ai 帳號配額 |
| `npx tokensleft claude codex` | 任意組合多個服務 |
| `npx tokensleft --demo` | 隨機產生的擬真資料 — 拿來截圖 |

### 選項

- `--demo` — 擬真隨機資料;不碰任何憑證、不發任何網路請求。數值在啟動時擲骰一次,TUI 重新整理時保持穩定,只有重置倒數在動。
- `--once` — 印出一次純文字快照後結束(輸出被 pipe 時自動啟用)
- `--json` — 印出機器可讀的 JSON 後結束
- `--interval <秒>` — 覆寫重新整理間隔
- `-h, --help` — 使用說明

需要 Node.js ≥ 22.13。

## 金鑰:自動探索 + 手動設定

只要對應的 CLI/App 已登入,每個服務都零設定可用。手動金鑰放在 `~/.tokensleft/.env`(任何目錄都讀得到 — 適合 `npx`)或 `./.env`(目前目錄,衝突時優先);參見 [.env.example](.env.example)。

| 服務 | 自動(系統) | 手動(.env) | Token 更新 |
|---|---|---|---|
| Claude Code | `~/.claude/.credentials.json`,每次重新整理重讀 | `CLAUDE_TOKEN_1..N`、`CLAUDE_CODE_OAUTH_TOKEN` | ✅ 到期前約 5 分鐘以 refresh token 換新並寫回 |
| Codex | `~/.codex/auth.json`(或 `CODEX_HOME`) | — | ✅ 超過 8 天或遇 401 時自動更新 |
| Gemini | `~/.gemini/oauth_creds.json` | — | ✅ 到期前約 5 分鐘更新(client 憑證讀自本機安裝的 CLI,有公開後備值) |
| Copilot | Copilot 的 `apps.json`/`hosts.json`、gh CLI 的 `hosts.yml` | `COPILOT_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | 每次重新整理時從磁碟重新解析 |
| Grok | `~/.grok/auth.json`(第一把未過期的 key) | `GROK_TOKEN` | 不適用(僅 grok login) |
| Antigravity | `state.vscdb` OAuth 封包(protobuf、SQLite) | — | ✅ Google OAuth 更新,快取在 `~/.tokensleft` |
| OpenCode | `~/.local/share/opencode` 認證 + 本地 `opencode.db` 花費 | — | 不適用(本地統計) |
| z.ai | 指向 `api.z.ai` 的 Claude Code 設定檔(`settings*.json`) | `ZAI_KEY_1..N` / `ZAI_API_KEY` / CSV | 不適用(靜態金鑰) |

自動探索到的金鑰會與手動設定的去重。更新後的 OAuth token 會以原格式原子性地寫回 CLI 自己的憑證檔,跟原廠 CLI 的做法完全相同 — 只要 refresh token 有效,儀表板就不會顯示 `EXPIRED`。

## TUI 快捷鍵

`r` 全部重新整理 · `1`-`9` 重新整理單一服務 · `d` 詳細檢視(加入本地逐模型用量表) · `q`/`Esc` 離開 · 方向鍵/PgUp/PgDn/滑鼠捲動。

## 數字怎麼算

刻意保持簡單的預測:對目前視窗做線性外插。如果你在視窗經過 `e%` 時已用掉 `u%` 配額,到重置時就會落在 `u/e·100%`。它只回答一個問題 — 配額撐得到重置嗎?

- 實心 `█` 是**已用量**;淡色 `░` 尾巴延伸到**照目前速度重置時會落在哪**。尾巴顏色依預測落點決定 — 紅色尾巴代表正衝向紅區。
- `→n%` 是同一個數字的文字版;`✓ pace` / `▲+n%` 比較已用% 與已經過%。
- 當線性速度在重置**之前**就穿過 100%,會顯示 `⚠ dry in X` 與穿越時間。
- 跨越 80% / 90% 會響終端機鈴聲,並在標題列顯示紅色警報。

## 本地用量表(`d` 鍵)

配額進度條顯示的是百分比;本地用量表告訴你這些百分比是由什麼組成的。按 `d`(詳細檢視 — 也是 `--once` 印出的內容)可看到近 7 天的逐模型明細,彙整自各 CLI 自己留在磁碟上的紀錄 — 增量掃描,任何資料都不會離開你的機器:

| 服務 | 來源 | 備註 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` 對話紀錄 | 拆分 input/output/cache-read/cache-write,依訊息 id 去重 |
| Codex | `~/.codex/{sessions,archived_sessions}/**/rollout-*.jsonl` | 用量由累計的 session 總量差分而得,重複事件與分岔/續接的 session 不會重複計算 |
| Gemini CLI | `~/.gemini/tmp/*/chats/*` session 檢查點(.json 與 .jsonl) | thought token 計為 output,工具提示計為 input |
| OpenCode | `opencode.db`(SQLite,唯讀) | 按 provider/模型;`$` 是 OpenCode 自己逐訊息記錄的成本 |

對 Claude Code、Codex 與 Gemini,`$` 欄位是按公開 API 價格估算(快取讀/寫按其折扣價計)— 訂閱用量是預付的,這個數字僅供比例參考,不代表帳單。沒有公開定價的模型會顯示 `?`。

## Claude Code 專屬細節

- **自動(系統)金鑰**:**每次重新整理**都從 `~/.claude/.credentials.json`(或 `CLAUDE_CONFIG_DIR`)重讀;過期 token 會用儲存的 refresh token 換新並寫回(minified JSON、原子寫入),Claude Code 能繼續使用輪換後的 token。
- **手動金鑰**:`.env` 裡的 `CLAUDE_TOKEN_1..N`(+ `CLAUDE_NAME_1..N`)或 `CLAUDE_CODE_OAUTH_TOKEN` — 給額外帳號或沒裝 Claude Code 的機器用。與系統 token 重複的會跳過。
- **速率限制**來自 Anthropic 的 OAuth usage 端點:5 小時 session、每週全模型、逐模型每週範圍(如 Fable),啟用時再加上 extra-usage/spend。
- **本地用量表**(詳細檢視,`d`)彙整對話紀錄成逐模型 token 與估算成本 — 參見[本地用量表](#本地用量表d-鍵)。

## 開發

```sh
git clone <repo> && cd tokensleft
npm install
npm start              # = node bin/tokensleft.js
npm start -- claude    # 單一服務
npm run demo           # 假資料儀表板
npm test               # 單元測試(node --test)
```

```
bin/       tokensleft CLI 進入點(npx tokensleft [providers...] [options])
lib/       共用:dotenv、格式化、預測(線性)、進度條/區塊、http、
           claude-settings 探索、原子寫檔、blessed 外框、CLI、demo 資料
providers/ claude / codex / gemini / copilot / grok / antigravity / opencode / zai
test/      node --test 測試
```

Antigravity 與 OpenCode 用 Node 內建的 `node:sqlite` 讀本地 SQLite 狀態(無原生相依)。

`.env` 已列入 git-ignore;永遠不要 commit 真實金鑰。

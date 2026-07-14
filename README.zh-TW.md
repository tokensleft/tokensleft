# TokensLeft

[English](README.md) · **繁體中文** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

快速查看 AI 訂閱額度、重置時間、消耗速度與本機模型用量的終端儀表板。

![TokensLeft 精簡模式](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot.png)

![TokensLeft Codex 詳細模式](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot2.png)

## 快速開始

```sh
npx tokensleft
```

TokensLeft 會自動偵測已登入的 Claude Code、Codex、Gemini CLI、GitHub Copilot、Grok、Antigravity、OpenCode 與 z.ai。需要 Node.js 22.13 以上版本。

## 指令

```text
tokensleft [providers...] [options]

--demo            使用擬真的本機示範資料
--once            輸出一次純文字結果後結束
--json            輸出一次 JSON 後結束
--interval <秒>   覆寫更新間隔
--read-only       不刷新或永久寫回憑證
-h, --help        顯示說明
-v, --version     顯示安裝版本
```

可以指定任意組合，例如 `tokensleft claude codex`；未指定時會顯示所有偵測到的 Provider。

## TUI 按鍵

`r` 全部更新 · `1`–`9` 更新單一 Provider · `d` 切換詳細模式 · `?` 說明 · 方向鍵/PgUp/PgDn/滑鼠捲動 · `q`/Esc 離開

預設使用 256 色；受限終端可設為 `TOKENSLEFT_COLOR=basic` 或 `NO_COLOR=1`。

## 憑證與隱私

- 自動讀取本機 CLI 的既有登入資料；手動金鑰可放在 `~/.tokensleft/.env` 或 `./.env`，完整變數請見 [.env.example](.env.example)。
- 額度請求不會經過 TokensLeft 服務，只會直連各 Provider 或使用你設定的 proxy；TokensLeft 沒有帳號系統、伺服器、分析或遙測。
- 本機用量只從電腦上的 CLI 紀錄計算，不會上傳。
- OAuth 憑證需要時會安全更新並寫回；使用 `--read-only` 可停用刷新與永久憑證更新。

本機美元金額依公開 API 價格估算，不代表訂閱帳單；未知或不完整價格會明確標示。預測採簡單線性推估，並非保證。

## 開發

```sh
git clone https://github.com/tokensleft/tokensleft.git
cd tokensleft
npm ci
npm test
npm run demo
```

[安全政策](SECURITY.md) · 採 MIT 授權。

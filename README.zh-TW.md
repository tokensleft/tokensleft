# TokensLeft

[English](README.md) · **繁體中文** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

快速查看 AI 訂閱額度、重置時間、消耗速度與本機模型用量的終端儀表板。

![TokensLeft 精簡模式](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot.png)

![TokensLeft Codex 詳細模式](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot2.png)

## 快速開始

```sh
npx tokensleft
```

TokensLeft 會自動偵測已登入的 Claude Code、Codex、Gemini CLI、Kimi Code、GitHub Copilot、Grok、Antigravity、OpenCode 與 z.ai。需要 Node.js 20.18.1 以上版本；在不支援 `node:sqlite` 的環境（包含 Node 20）會略過 Antigravity 與 OpenCode。

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

`r` 全部更新 · `1`–`9` 更新單一 Provider · `d` 切換詳細模式 · `t` 重置歷史（偵測過才顯示） · `?` 說明 · 方向鍵/PgUp/PgDn/滑鼠捲動 · `q`/Esc 離開

預設使用 256 色；受限終端可設為 `TOKENSLEFT_COLOR=basic` 或 `NO_COLOR=1`。

## 憑證與隱私

- 自動讀取本機 CLI 的既有登入資料；手動金鑰可放在 `~/.tokensleft/.env` 或 `./.env`，完整變數請見 [.env.example](.env.example)。
- Kimi Code 會讀取 `~/.kimi-code/credentials/kimi-code.json`，並相容舊版 `~/.kimi` 路徑；面板會顯示會員等級、共享額度、並行上限與包含 Kimi K3 在內的可用模型。多把會員金鑰可設為 `KIMI_CODE_API_KEY_1`、`_2` 等，並用 `KIMI_CODE_NAME_1`、`_2` 自訂名稱。原本的單一 `KIMI_CODE_API_KEY` 仍可使用；這些不是 Moonshot 的 `KIMI_API_KEY`。
- 額度請求不會經過 TokensLeft 服務，只會直連各 Provider 或使用你設定的 proxy；TokensLeft 沒有帳號系統、伺服器、分析或遙測。
- 本機用量只從電腦上的 CLI 紀錄計算，不會上傳。
- 非預期重置歷史只會儲存在本機 `~/.tokensleft/reset-history.json`，內容僅有 Provider、額度項目名稱與偵測時間。
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

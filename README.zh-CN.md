# TokensLeft

[English](README.md) · [繁體中文](README.zh-TW.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md)

快速查看 AI 订阅额度、重置时间、消耗速度和本地模型用量的终端仪表板。

![TokensLeft 精简模式](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot.png)

![TokensLeft Codex 详细模式](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot2.png)

## 快速开始

```sh
npx tokensleft
```

TokensLeft 会自动检测已登录的 Claude Code、Codex、Gemini CLI、Kimi Code、GitHub Copilot、Grok、Antigravity、OpenCode 和 z.ai。需要 Node.js 20.18.1 或更高版本；在不支持 `node:sqlite` 的环境（包括 Node 20）会跳过 Antigravity 和 OpenCode。

## 命令

```text
tokensleft [providers...] [options]

--demo            使用逼真的本地演示数据
--once            输出一次纯文本结果后退出
--json            输出一次 JSON 后退出
--interval <秒>   覆盖刷新间隔
--read-only       不刷新或持久写回凭据
-h, --help        显示帮助
-v, --version     显示安装版本
```

可以指定任意组合，例如 `tokensleft claude codex`；未指定时显示所有检测到的 Provider。

## TUI 按键

`r` 全部刷新 · `1`–`9` 刷新单个 Provider · `d` 切换详细模式 · `t` 重置历史（检测过才显示） · `?` 帮助 · 方向键/PgUp/PgDn/鼠标滚动 · `q`/Esc 退出

默认使用 256 色；受限终端可设置 `TOKENSLEFT_COLOR=basic` 或 `NO_COLOR=1`。

## 凭据与隐私

- 自动读取本地 CLI 的现有登录信息；手动密钥可放在 `~/.tokensleft/.env` 或 `./.env`，完整变量见 [.env.example](.env.example)。
- 额度请求不会经过 TokensLeft 服务，只会直连各 Provider 或使用你配置的 proxy；TokensLeft 没有账号系统、服务器、分析或遥测。
- Codex 的非官方 48 小时重置概率会匿名从 `willcodexquotareset.com` 获取，不会附带凭据或账号标识信息。
- 本地用量仅从电脑上的 CLI 日志计算，不会上传。
- 非预期重置历史仅存储在本地 `~/.tokensleft/reset-history.json`，内容只有 Provider、额度项目名称和检测时间。
- OAuth 凭据会在需要时安全刷新并写回；使用 `--read-only` 可禁用刷新和持久凭据更新。

本地美元金额依据公开 API 价格估算，不代表订阅账单；未知或不完整价格会明确标记。预测采用简单线性推算，并非保证。

## 开发

```sh
git clone https://github.com/tokensleft/tokensleft.git
cd tokensleft
npm ci
npm test
npm run demo
```

[安全策略](SECURITY.md) · 采用 MIT 许可证。

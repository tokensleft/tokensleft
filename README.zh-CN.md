# tokensleft

[English](README.md) · [繁體中文](README.zh-TW.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md)

我的 token 还剩多少?一个终端仪表盘看遍所有 AI 订阅配额 — Claude Code(Anthropic)、Codex(OpenAI)、Gemini CLI、GitHub Copilot、Grok CLI、Antigravity、OpenCode、z.ai — 内置燃烧速率预测、阈值警报、自动凭证发现 + OAuth token 自动刷新,以及 Claude Code(含 Fable)、Codex、Gemini CLI 与 OpenCode 的本地逐模型 token/成本统计。

![tokensleft 仪表盘 — 每个检测到的服务的配额进度条、速度预测与逐模型成本表](https://cdn.jsdelivr.net/gh/tokensleft/tokensleft@main/docs/screenshot.png)

## 快速开始

```sh
npx tokensleft
```

就这么简单。已登录的 CLI 会自动检测;没有凭证的服务不会出现。

| 命令 | 显示内容 |
|---|---|
| `npx tokensleft` | 所有检测到的服务,一个 TUI 全包 |
| `npx tokensleft claude` | Claude Code 速率限制(Session / Weekly / 逐模型如 Fable)+ 本地 token 与成本表 |
| `npx tokensleft codex` | Codex(ChatGPT 套餐)session/weekly/模型限制、reviews、credits + 本地 token 与成本表 |
| `npx tokensleft gemini` | Gemini CLI Pro/Flash 每日配额 + 本地 token 与成本表 |
| `npx tokensleft copilot` | GitHub Copilot premium/chat 配额(免费套餐:chat/completions) |
| `npx tokensleft grok` | Grok CLI 每月 credits + 按量付费上限 |
| `npx tokensleft antigravity` | Antigravity 逐模型池配额(Gemini Pro / Flash / Claude) |
| `npx tokensleft opencode` | OpenCode Go 套餐花费 vs session/周/月美元上限 + 本地逐模型表 |
| `npx tokensleft zai` | z.ai 账号配额 |
| `npx tokensleft claude codex` | 任意组合多个服务 |
| `npx tokensleft --demo` | 随机生成的拟真数据 — 用来截图 |

### 选项

- `--demo` — 拟真随机数据;不碰任何凭证、不发任何网络请求。数值在启动时随机一次,TUI 刷新时保持稳定,只有重置倒计时在动。
- `--once` — 打印一次纯文本快照后退出(输出被管道时自动启用)
- `--json` — 打印机器可读的 JSON 后退出
- `--interval <秒>` — 覆盖刷新间隔
- `-h, --help` — 使用说明

需要 Node.js ≥ 22.13。

## 密钥:自动发现 + 手动配置

只要对应的 CLI/App 已登录,每个服务都零配置可用。手动密钥放在 `~/.tokensleft/.env`(任何目录都能读到 — 适合 `npx`)或 `./.env`(当前目录,冲突时优先);参见 [.env.example](.env.example)。

| 服务 | 自动(系统) | 手动(.env) | Token 刷新 |
|---|---|---|---|
| Claude Code | `~/.claude/.credentials.json`,每次刷新重读 | `CLAUDE_TOKEN_1..N`、`CLAUDE_CODE_OAUTH_TOKEN` | ✅ 到期前约 5 分钟用 refresh token 换新并写回 |
| Codex | `~/.codex/auth.json`(或 `CODEX_HOME`) | — | ✅ 超过 8 天或遇 401 时自动刷新 |
| Gemini | `~/.gemini/oauth_creds.json` | — | ✅ 到期前约 5 分钟刷新(client 凭证读自本机安装的 CLI,有公开兜底值) |
| Copilot | Copilot 的 `apps.json`/`hosts.json`、gh CLI 的 `hosts.yml` | `COPILOT_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | 每次刷新时从磁盘重新解析 |
| Grok | `~/.grok/auth.json`(第一把未过期的 key) | `GROK_TOKEN` | 不适用(仅 grok login) |
| Antigravity | `state.vscdb` OAuth 封包(protobuf、SQLite) | — | ✅ Google OAuth 刷新,缓存在 `~/.tokensleft` |
| OpenCode | `~/.local/share/opencode` 认证 + 本地 `opencode.db` 花费 | — | 不适用(本地统计) |
| z.ai | 指向 `api.z.ai` 的 Claude Code 配置文件(`settings*.json`) | `ZAI_KEY_1..N` / `ZAI_API_KEY` / CSV | 不适用(静态密钥) |

自动发现的密钥会与手动配置的去重。刷新后的 OAuth token 会以原格式原子性地写回 CLI 自己的凭证文件,与官方 CLI 的做法完全一致 — 只要 refresh token 有效,仪表盘就不会显示 `EXPIRED`。

## TUI 快捷键

`r` 全部刷新 · `1`-`9` 刷新单个服务 · `d` 详细视图(加上本地逐模型用量表) · `q`/`Esc` 退出 · 方向键/PgUp/PgDn/鼠标滚动。

## 数字怎么算

刻意保持简单的预测:对当前窗口做线性外推。如果窗口过去了 `e%` 时你已用掉 `u%` 配额,到重置时就会落在 `u/e·100%`。它只回答一个问题 — 配额撑得到重置吗?

- 实心 `█` 是**已用量**;淡色 `░` 尾巴延伸到**按当前速度重置时会落在哪**。尾巴颜色由预测落点决定 — 红色尾巴代表正冲向红区。
- `→n%` 是同一个数字的文字版;`✓ pace` / `▲+n%` 对比已用% 与已经过%。
- 当线性速度在重置**之前**就穿过 100%,会显示 `⚠ dry in X` 与穿越时间。
- 越过 80% / 90% 会响终端铃声,并在标题栏显示红色警报。

## 本地用量表(`d` 键)

配额进度条只显示百分比;本地用量表告诉你这些百分比由什么构成。按 `d`(详细视图 — 也是 `--once` 打印的内容)可查看今天 / 7 天 / 30 天 / 所有时间的逐模型明细(所有时间 = 磁盘上仍保留的日志),汇总自各 CLI 自己落在磁盘上的日志 — 首次扫描读取完整历史,之后只读新增部分,任何数据都不会离开你的机器:

| 服务 | 数据来源 | 说明 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` 会话记录 | 按 input/output/cache-read/cache-write 拆分,按消息 id 去重 |
| Codex | `~/.codex/{sessions,archived_sessions}/**/rollout-*.jsonl` | 用量从累计的 session 总量做差分,重复事件与 fork/恢复的 session 不会重复计数 |
| Gemini CLI | `~/.gemini/tmp/*/chats/*` session 检查点(.json 与 .jsonl) | thought token 计为 output,工具提示计为 input |
| OpenCode | `opencode.db`(SQLite,只读) | 按 provider/模型统计;`$` 是 OpenCode 自己逐消息记录的成本 |

对 Claude Code、Codex 与 Gemini,`$` 列是按公开 API 价格的估算(缓存读/写按各自的折扣价计)— 订阅用量是预付的,这一列仅供比例参考,不作账单用。没有公开定价的模型显示 `?`。

## Claude Code 专属细节

- **自动(系统)密钥**:**每次刷新**都从 `~/.claude/.credentials.json`(或 `CLAUDE_CONFIG_DIR`)重读;过期 token 会用存储的 refresh token 换新并写回(minified JSON、原子写入),Claude Code 能继续使用轮换后的 token。
- **手动密钥**:`.env` 里的 `CLAUDE_TOKEN_1..N`(+ `CLAUDE_NAME_1..N`)或 `CLAUDE_CODE_OAUTH_TOKEN` — 给额外账号或没装 Claude Code 的机器用。与系统 token 重复的会跳过。
- **速率限制**来自 Anthropic 的 OAuth usage 端点:5 小时 session、每周全模型、逐模型每周范围(如 Fable),启用时再加上 extra-usage/spend。
- **本地用量表**(详细视图,`d`)把会话记录汇总成逐模型 token 与估算成本 — 参见[本地用量表](#本地用量表d-键)。

## 开发

```sh
git clone <repo> && cd tokensleft
npm install
npm start              # = node bin/tokensleft.js
npm start -- claude    # 单个服务
npm run demo           # 假数据仪表盘
npm test               # 单元测试(node --test)
```

```
bin/       tokensleft CLI 入口(npx tokensleft [providers...] [options])
lib/       共享:dotenv、格式化、预测(线性)、进度条/区块、http、
           claude-settings 发现、原子写文件、blessed 外壳、CLI、demo 数据
providers/ claude / codex / gemini / copilot / grok / antigravity / opencode / zai
test/      node --test 测试
```

Antigravity 与 OpenCode 用 Node 内置的 `node:sqlite` 读本地 SQLite 状态(无原生依赖)。

`.env` 已加入 git-ignore;永远不要提交真实密钥。

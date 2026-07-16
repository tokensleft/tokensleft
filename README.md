# TokensLeft

**English** · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

A fast terminal dashboard for AI subscription quotas, reset times, burn rate, and local model usage.

![TokensLeft compact dashboard](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot.png)

![TokensLeft Codex detail view](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot2.png)

## Quick start

```sh
npx tokensleft
```

TokensLeft automatically detects logged-in Claude Code, Codex, Gemini CLI, GitHub Copilot, Grok, Antigravity, OpenCode, and z.ai accounts. Requires Node.js 20.18.1 or newer. On runtimes without `node:sqlite`, including Node 20, Antigravity and OpenCode are skipped.

## Commands

```text
tokensleft [providers...] [options]

--demo            run with realistic local demo data
--once            print one plain-text snapshot and exit
--json            print one JSON snapshot and exit
--interval <s>    override the refresh interval
--read-only       never refresh or persist credential changes
-h, --help        show help
-v, --version     show the installed version
```

Choose any combination, for example `tokensleft claude codex`. With no provider names, every detected provider is shown.

## TUI keys

`r` refresh all · `1`–`9` refresh one provider · `d` toggle details · `?` help · arrows/PgUp/PgDn/mouse scroll · `q`/Esc quit

256 colors are used by default. For limited consoles, set `TOKENSLEFT_COLOR=basic` or `NO_COLOR=1`.

## Credentials and privacy

- Existing CLI credentials are discovered locally; manual keys can be placed in `~/.tokensleft/.env` or `./.env`. See [.env.example](.env.example).
- Quota requests never pass through a TokensLeft service; they go directly to providers or through your configured proxy. There is no TokensLeft account, server, analytics, or telemetry.
- Local usage is calculated from CLI logs on your machine and is never uploaded.
- OAuth credentials may be refreshed and safely written back when needed. Use `--read-only` to disable refreshes and persistent credential updates.

Local dollar totals are estimates based on public API prices, not subscription billing. Unknown or partial prices are marked instead of being treated as complete. Forecasts are simple linear projections, not guarantees.

## Development

```sh
git clone https://github.com/tokensleft/tokensleft.git
cd tokensleft
npm ci
npm test
npm run demo
```

[Security policy](SECURITY.md) · MIT licensed.

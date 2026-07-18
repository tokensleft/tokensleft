# TokensLeft

**English** · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

A fast terminal dashboard for AI subscription quotas, reset times, burn rate, and local model usage.

![TokensLeft compact dashboard](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot.png)

![TokensLeft Codex detail view](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot2.png)

## Quick start

```sh
npx tokensleft
```

TokensLeft automatically detects logged-in Claude Code, Codex, Gemini CLI, Kimi Code, GitHub Copilot, Grok, Antigravity, OpenCode, and z.ai accounts. Requires Node.js 20.18.1 or newer. On runtimes without `node:sqlite`, including Node 20, Antigravity and OpenCode are skipped.

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

`r` refresh all · `1`–`9` refresh one provider · `d` toggle details · `t` reset history (after one is detected) · `?` help · arrows/PgUp/PgDn/mouse scroll · `q`/Esc quit

256 colors are used by default. For limited consoles, set `TOKENSLEFT_COLOR=basic` or `NO_COLOR=1`.

## Credentials and privacy

- Existing CLI credentials are discovered locally; manual keys can be placed in `~/.tokensleft/.env` or `./.env`. See [.env.example](.env.example).
- Kimi Code login is detected from `~/.kimi-code/credentials/kimi-code.json` and the legacy `~/.kimi` path. The dashboard shows membership level, shared quota, parallel capacity, and available models including Kimi K3. Multiple membership keys can be supplied as `KIMI_CODE_API_KEY_1`, `_2`, and so on, with optional `KIMI_CODE_NAME_1`, `_2` labels. The original single-key `KIMI_CODE_API_KEY` remains supported; these are not Moonshot `KIMI_API_KEY` keys.
- Quota requests never pass through a TokensLeft service; they go directly to providers or through your configured proxy. There is no TokensLeft account, server, analytics, or telemetry.
- Codex's unofficial 48-hour reset chance is fetched anonymously from `willcodexquotareset.com`; no credential or account identifier is included.
- Local usage is calculated from CLI logs on your machine and is never uploaded.
- Unexpected reset history is stored locally in `~/.tokensleft/reset-history.json`; only provider/window names and detection times are recorded.
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

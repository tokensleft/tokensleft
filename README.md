# tokensleft

**English** · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

How many tokens do I have left? One terminal dashboard for AI subscription quota — Claude Code (Anthropic), Codex (OpenAI), Gemini CLI, GitHub Copilot, Grok CLI, Antigravity, OpenCode, and z.ai — with burn-rate forecasts, threshold alerts, automatic credential discovery + OAuth token refresh, and local per-model token/cost accounting for Claude Code (including Fable).

![tokensleft dashboard — quota bars, pace forecasts, and per-model cost table for every detected provider](https://cdn.jsdelivr.net/gh/tokensleft/tokensleft@main/docs/screenshot.png)

## Quick start

```sh
npx tokensleft
```

That's it. Logged-in CLIs are auto-detected; providers without credentials simply don't appear.

| Command | What it shows |
|---|---|
| `npx tokensleft` | every detected provider in one TUI |
| `npx tokensleft claude` | Claude Code rate limits (Session / Weekly / per-model e.g. Fable) + local token & cost table |
| `npx tokensleft codex` | Codex (ChatGPT plan) session/weekly/model limits, reviews, credits |
| `npx tokensleft gemini` | Gemini CLI Pro/Flash daily quotas |
| `npx tokensleft copilot` | GitHub Copilot premium/chat quotas (free tier: chat/completions) |
| `npx tokensleft grok` | Grok CLI monthly credits + pay-as-you-go cap |
| `npx tokensleft antigravity` | Antigravity per-model-pool quotas (Gemini Pro / Flash / Claude) |
| `npx tokensleft opencode` | OpenCode Go plan spend vs session/weekly/monthly dollar limits |
| `npx tokensleft zai` | z.ai account quotas |
| `npx tokensleft claude codex` | any combination of providers |
| `npx tokensleft --demo` | randomly generated plausible data — for screenshots |

### Options

- `--demo` — realistic random data; touches no credentials, makes no network calls. Values are rolled once at startup, so the TUI stays steady while the reset countdowns tick.
- `--once` — print a single plain-text snapshot and exit (piping output implies this)
- `--json` — print machine-readable JSON and exit
- `--interval <seconds>` — override the refresh interval
- `-h, --help` — usage

Requires Node.js ≥ 22.13.

## Keys: auto-discovered + manual

Every provider works with zero config if its CLI/app is logged in. Manual keys go in `~/.tokensleft/.env` (read from any directory — fits `npx`) or `./.env` (current directory, wins on conflicts); see [.env.example](.env.example).

| Provider | Auto (system) | Manual (.env) | Token refresh |
|---|---|---|---|
| Claude Code | `~/.claude/.credentials.json`, re-read every refresh | `CLAUDE_TOKEN_1..N`, `CLAUDE_CODE_OAUTH_TOKEN` | ✅ refresh token redeemed ~5 min before expiry, persisted back |
| Codex | `~/.codex/auth.json` (or `CODEX_HOME`) | — | ✅ refreshed when >8 days old or on 401 |
| Gemini | `~/.gemini/oauth_creds.json` | — | ✅ refreshed ~5 min before expiry (client creds read from the installed CLI, public fallback) |
| Copilot | Copilot `apps.json`/`hosts.json`, gh CLI `hosts.yml` | `COPILOT_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | re-resolved from disk every refresh |
| Grok | `~/.grok/auth.json` (first non-expired key) | `GROK_TOKEN` | n/a (grok login only) |
| Antigravity | `state.vscdb` OAuth envelope (protobuf, SQLite) | — | ✅ Google OAuth refresh, cached in `~/.tokensleft` |
| OpenCode | `~/.local/share/opencode` auth + local `opencode.db` spend | — | n/a (local accounting) |
| z.ai | Claude Code profiles pointing at `api.z.ai` (`settings*.json`) | `ZAI_KEY_1..N` / `ZAI_API_KEY` / CSV | n/a (static keys) |

Auto-discovered keys are deduped against manual ones. Refreshed OAuth tokens are written back to the same credential file the CLI owns (atomic rename, same format), exactly like the vendor CLIs do themselves — so the dashboard never shows `EXPIRED` as long as the refresh token is valid.

## Keys in the TUI

`r` refresh all · `1`-`9` refresh one provider · `d` toggle detail · `q`/`Esc` quit · arrows/mouse scroll.

## How the numbers work

One deliberately simple forecast: linear extrapolation of the window so far. If you've used `u%` of the quota in `e%` of the window, you're on track for `u/e·100%` by reset. It answers exactly one question — does the quota last until the reset?

- The solid `█` fill is **what you've used**; the faint `░` tail extends it to **where the linear pace lands by reset**. The tail is colored by where the projection lands — a red tail means you're heading into the red zone.
- `→n%` is the same number as text; `✓ pace` / `▲+n%` compares used% against elapsed%.
- `⚠ dry in X` appears when the linear pace crosses 100% **before** the reset, with the crossing time.
- Crossing 80% / 90% rings the terminal bell and shows a red alert in the header.

## Claude Code specifics

- **Auto (system) key**: read from `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) on **every refresh**; expired tokens are refreshed with the stored refresh token and written back (minified JSON, atomic), so Claude Code keeps working with the rotated token.
- **Manual keys**: `CLAUDE_TOKEN_1..N` (+ `CLAUDE_NAME_1..N`) or `CLAUDE_CODE_OAUTH_TOKEN` in `.env` — for extra accounts or machines without Claude Code. Duplicates of the system token are skipped.
- **Rate limits** come from Anthropic's OAuth usage endpoint: 5-hour session, weekly all-models, and per-model weekly scopes (e.g. Fable), plus extra-usage/spend when enabled.
- **Local usage table** aggregates `~/.claude/projects/**/*.jsonl` transcripts (last 7 days, incremental scan) into per-model input/output/cache tokens, message counts, and an estimated cost at public API prices — subscription usage is prepaid, the $ column is for scale.

## Development

```sh
git clone <repo> && cd tokensleft
npm install
npm start              # = node bin/tokensleft.js
npm start -- claude    # single provider
npm run demo           # fake-data dashboard
npm test               # unit tests (node --test)
```

```
bin/       tokensleft CLI entry (npx tokensleft [providers...] [options])
lib/       shared: dotenv, formatting, forecast (linear), bars/blocks, http,
           claude-settings discovery, atomic file writes, blessed shell, CLI, demo data
providers/ claude / codex / gemini / copilot / grok / antigravity / opencode / zai
test/      node --test suites
```

Antigravity and OpenCode read local SQLite state via Node's built-in `node:sqlite` (no native deps).

`.env` is git-ignored; never commit real keys.

# tokensleft

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어**

토큰이 얼마나 남았지? AI 구독 쿼터를 터미널 대시보드 하나로 — Claude Code(Anthropic), Codex(OpenAI), Gemini CLI, GitHub Copilot, Grok CLI, Antigravity, OpenCode, z.ai. 소진 속도 예측, 임계값 알림, 자격 증명 자동 탐지 + OAuth 토큰 자동 갱신, 그리고 Claude Code(Fable 포함), Codex, Gemini CLI, OpenCode의 로컬 모델별 토큰/비용 집계까지 제공합니다.

![tokensleft 대시보드 — 감지된 모든 프로바이더의 쿼터 바, 페이스 예측, 모델별 비용 표](https://cdn.jsdelivr.net/gh/tokensleft/tokensleft@main/docs/screenshot.png)

## 빠른 시작

```sh
npx tokensleft
```

이게 전부입니다. 로그인된 CLI는 자동으로 감지되며, 자격 증명이 없는 프로바이더는 표시되지 않습니다.

| 명령 | 표시 내용 |
|---|---|
| `npx tokensleft` | 감지된 모든 프로바이더를 하나의 TUI로 |
| `npx tokensleft claude` | Claude Code 사용량 제한(Session / Weekly / 모델별 예: Fable) + 로컬 토큰 & 비용 표 |
| `npx tokensleft codex` | Codex(ChatGPT 플랜) session/weekly/모델 제한, reviews, credits + 로컬 토큰 & 비용 표 |
| `npx tokensleft gemini` | Gemini CLI Pro/Flash 일일 쿼터 + 로컬 토큰 & 비용 표 |
| `npx tokensleft copilot` | GitHub Copilot premium/chat 쿼터(무료 플랜: chat/completions) |
| `npx tokensleft grok` | Grok CLI 월간 크레딧 + 종량제 상한 |
| `npx tokensleft antigravity` | Antigravity 모델 풀별 쿼터(Gemini Pro / Flash / Claude) |
| `npx tokensleft opencode` | OpenCode Go 플랜 지출 vs session/주간/월간 달러 한도 + 로컬 모델별 표 |
| `npx tokensleft zai` | z.ai 계정 쿼터 |
| `npx tokensleft claude codex` | 프로바이더 임의 조합 |
| `npx tokensleft --demo` | 무작위로 생성된 그럴듯한 데이터 — 스크린샷용 |

### 옵션

- `--demo` — 사실적인 무작위 데이터. 자격 증명을 건드리지 않고 네트워크 요청도 하지 않습니다. 값은 시작 시 한 번만 정해져 TUI 새로고침 중에도 안정적으로 유지되고, 리셋 카운트다운만 움직입니다.
- `--once` — 일반 텍스트 스냅샷을 한 번 출력하고 종료(파이프 출력 시 자동 적용)
- `--json` — 기계가 읽을 수 있는 JSON을 출력하고 종료
- `--interval <초>` — 새로고침 간격 재정의
- `-h, --help` — 사용법

Node.js ≥ 22.13이 필요합니다.

## 키: 자동 탐지 + 수동 설정

해당 CLI/앱에 로그인되어 있으면 모든 프로바이더가 설정 없이 동작합니다. 수동 키는 `~/.tokensleft/.env`(어느 디렉터리에서든 읽힘 — `npx`에 적합) 또는 `./.env`(현재 디렉터리, 충돌 시 우선)에 넣으세요. [.env.example](.env.example) 참고.

| 프로바이더 | 자동(시스템) | 수동(.env) | 토큰 갱신 |
|---|---|---|---|
| Claude Code | `~/.claude/.credentials.json`, 새로고침마다 재읽기 | `CLAUDE_TOKEN_1..N`, `CLAUDE_CODE_OAUTH_TOKEN` | ✅ 만료 약 5분 전 refresh token으로 갱신 후 다시 기록 |
| Codex | `~/.codex/auth.json`(또는 `CODEX_HOME`) | — | ✅ 8일 초과 또는 401 시 자동 갱신 |
| Gemini | `~/.gemini/oauth_creds.json` | — | ✅ 만료 약 5분 전 갱신(클라이언트 자격 증명은 설치된 CLI에서 읽고, 공개 값으로 폴백) |
| Copilot | Copilot의 `apps.json`/`hosts.json`, gh CLI의 `hosts.yml` | `COPILOT_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | 새로고침마다 디스크에서 재해석 |
| Grok | `~/.grok/auth.json`(만료되지 않은 첫 키) | `GROK_TOKEN` | 해당 없음(grok login만) |
| Antigravity | `state.vscdb` OAuth 봉투(protobuf, SQLite) | — | ✅ Google OAuth 갱신, `~/.tokensleft`에 캐시 |
| OpenCode | `~/.local/share/opencode` 인증 + 로컬 `opencode.db` 지출 | — | 해당 없음(로컬 집계) |
| z.ai | `api.z.ai`를 가리키는 Claude Code 프로필(`settings*.json`) | `ZAI_KEY_1..N` / `ZAI_API_KEY` / CSV | 해당 없음(정적 키) |

자동 탐지된 키는 수동 키와 중복 제거됩니다. 갱신된 OAuth 토큰은 각 CLI가 소유한 자격 증명 파일에 같은 형식으로 원자적으로 다시 기록됩니다(벤더 CLI와 동일한 방식) — refresh token이 유효한 한 대시보드에 `EXPIRED`가 표시되지 않습니다.

## TUI 단축키

`r` 전체 새로고침 · `1`-`9` 개별 프로바이더 새로고침 · `d` 상세 보기(로컬 모델별 사용량 표 추가) · `q`/`Esc` 종료 · 화살표/PgUp/PgDn/마우스 스크롤.

## 숫자 계산 방식

예측은 의도적으로 단순하게 하나만: 현재 윈도우의 선형 외삽입니다. 윈도우가 `e%` 지난 시점에 쿼터를 `u%` 썼다면, 리셋 시점에는 `u/e·100%`에 도달하는 페이스입니다. 답하는 질문은 단 하나 — 쿼터가 리셋까지 버틸까?

- 실선 `█`은 **사용한 양**, 옅은 `░` 꼬리는 **현재 페이스로 리셋 시점에 도달할 위치**까지 이어집니다. 꼬리 색은 예측 도착점에 따라 정해지며, 빨간 꼬리는 위험 구간으로 향하고 있다는 신호입니다.
- `→n%`는 같은 숫자의 텍스트 표기이고, `✓ pace` / `▲+n%`는 사용%와 경과%를 비교합니다.
- 선형 페이스가 리셋 **전에** 100%를 넘으면 `⚠ dry in X`와 도달 시각이 표시됩니다.
- 80% / 90%를 넘으면 터미널 벨이 울리고 헤더에 빨간 경고가 표시됩니다.

## 로컬 사용량 표(`d` 키)

쿼터 바는 퍼센트를 보여주고, 로컬 표는 그 구성을 보여줍니다. `d`를 누르면(상세 보기 — `--once`가 출력하는 내용이기도 함) 각 CLI가 디스크에 남긴 자체 로그를 집계한 오늘 / 7일 / 30일 / 전체 기간(전체 기간 = 디스크에 남아 있는 로그 전부)의 모델별 내역이 표시됩니다 — 첫 스캔은 전체 기록을 읽고 이후에는 추가된 부분만 읽으며, 어떤 데이터도 머신 밖으로 나가지 않습니다:

| 프로바이더 | 소스 | 비고 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` 대화 기록 | input/output/cache-read/cache-write 구분, 메시지 id로 중복 제거 |
| Codex | `~/.codex/{sessions,archived_sessions}/**/rollout-*.jsonl` | 세션 누적 합계의 차분으로 사용량을 계산하므로 반복 이벤트나 포크/재개된 세션이 이중 집계되지 않음 |
| Gemini CLI | `~/.gemini/tmp/*/chats/*` 세션 체크포인트(.json 및 .jsonl) | thought 토큰은 output으로, 도구 프롬프트는 input으로 집계 |
| OpenCode | `opencode.db`(SQLite, 읽기 전용) | 프로바이더/모델별; `$`는 OpenCode 자체가 메시지별로 기록한 비용 |

Claude Code, Codex, Gemini의 `$` 열은 공개 API 가격 기준 추정치입니다(캐시 읽기/쓰기는 할인된 요율로 계산) — 구독 사용량은 선불이므로 규모 참고용이지 청구액이 아닙니다. 공개 가격이 없는 모델은 `?`로 표시됩니다.

## Claude Code 관련 세부 사항

- **자동(시스템) 키**: **새로고침마다** `~/.claude/.credentials.json`(또는 `CLAUDE_CONFIG_DIR`)에서 재읽기. 만료된 토큰은 저장된 refresh token으로 갱신해 다시 기록하므로(minified JSON, 원자적 쓰기) 회전된 토큰으로도 Claude Code가 계속 동작합니다.
- **수동 키**: `.env`의 `CLAUDE_TOKEN_1..N`(+ `CLAUDE_NAME_1..N`) 또는 `CLAUDE_CODE_OAUTH_TOKEN` — 추가 계정이나 Claude Code가 없는 머신용. 시스템 토큰과 중복되면 건너뜁니다.
- **사용량 제한**은 Anthropic의 OAuth usage 엔드포인트에서 가져옵니다: 5시간 세션, 주간 전체 모델, 모델별 주간 범위(예: Fable), 활성화 시 extra-usage/spend 포함.
- **로컬 사용량 표**(상세 보기, `d`)는 대화 기록을 모델별 토큰과 추정 비용으로 집계합니다 — [로컬 사용량 표](#로컬-사용량-표d-키) 참고.

## 개발

```sh
git clone <repo> && cd tokensleft
npm install
npm start              # = node bin/tokensleft.js
npm start -- claude    # 단일 프로바이더
npm run demo           # 가짜 데이터 대시보드
npm test               # 단위 테스트(node --test)
```

```
bin/       tokensleft CLI 엔트리(npx tokensleft [providers...] [options])
lib/       공유: dotenv, 포매팅, 예측(선형), 바/블록, http,
           claude-settings 탐지, 원자적 파일 쓰기, blessed 셸, CLI, demo 데이터
providers/ claude / codex / gemini / copilot / grok / antigravity / opencode / zai
test/      node --test 스위트
```

Antigravity와 OpenCode는 Node 내장 `node:sqlite`로 로컬 SQLite 상태를 읽습니다(네이티브 의존성 없음).

`.env`는 git-ignore에 포함되어 있습니다. 실제 키는 절대 커밋하지 마세요.

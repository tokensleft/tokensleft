# TokensLeft

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어**

AI 구독 한도, 재설정 시간, 사용 속도와 로컬 모델 사용량을 빠르게 확인하는 터미널 대시보드입니다.

![TokensLeft 컴팩트 화면](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot.png)

![TokensLeft Codex 상세 화면](https://raw.githubusercontent.com/tokensleft/tokensleft/main/docs/screenshot2.png)

## 빠른 시작

```sh
npx tokensleft
```

로그인된 Claude Code, Codex, Gemini CLI, Kimi Code, GitHub Copilot, Grok, Antigravity, OpenCode, z.ai 계정을 자동으로 찾습니다. Node.js 20.18.1 이상이 필요합니다. Node 20처럼 `node:sqlite`를 사용할 수 없는 환경에서는 Antigravity와 OpenCode를 건너뜁니다.

## 명령어

```text
tokensleft [providers...] [options]

--demo            현실적인 로컬 데모 데이터로 실행
--once            일반 텍스트를 한 번 출력하고 종료
--json            JSON을 한 번 출력하고 종료
--interval <초>   새로 고침 간격 변경
--read-only       인증 정보를 갱신하거나 영구 저장하지 않음
-h, --help        도움말 표시
-v, --version     설치된 버전 표시
```

`tokensleft claude codex`처럼 원하는 조합을 지정할 수 있습니다. 지정하지 않으면 감지된 Provider를 모두 표시합니다.

## TUI 키

`r` 전체 새로 고침 · `1`–`9` 개별 새로 고침 · `d` 상세 화면 · `t` 재설정 기록(감지된 뒤에만 표시) · `?` 도움말 · 방향키/PgUp/PgDn/마우스 스크롤 · `q`/Esc 종료

기본값은 256색입니다. 제한된 콘솔에서는 `TOKENSLEFT_COLOR=basic` 또는 `NO_COLOR=1`을 설정하세요.

## 인증 정보와 개인정보 보호

- 기존 CLI 로그인 정보를 로컬에서 감지합니다. 수동 키는 `~/.tokensleft/.env` 또는 `./.env`에 둘 수 있습니다. 전체 변수는 [.env.example](.env.example)을 참고하세요.
- Claude Code 로그인 정보는 `~/.claude/.credentials.json`에서 읽습니다. macOS에서는 로그인 키체인의 `Claude Code-credentials` 항목을 먼저 사용하며, 처음 접근할 때 macOS가 권한을 묻습니다. 사용 가능한 토큰을 가진 쪽이 선택되므로 오래된 파일이 새 로그인을 가리지 않습니다. 만료가 임박한 토큰은 갱신되어 읽어온 곳에 그대로 저장되며, 더 새로운 인증 정보를 덮어쓰지 않습니다. `--read-only`로 끌 수 있습니다. 인증 정보가 전혀 없어도 Claude Code 트랜스크립트 기반 로컬 사용량은 계속 표시됩니다.
- Kimi Code 로그인 정보는 `~/.kimi-code/credentials/kimi-code.json`과 기존 `~/.kimi` 경로에서 감지합니다. 대시보드에는 멤버십 등급, 공유 한도, 병렬 실행 한도, Kimi K3를 포함한 사용 가능한 모델이 표시됩니다. 여러 멤버십 키는 `KIMI_CODE_API_KEY_1`, `_2` 형식으로 지정하고 `KIMI_CODE_NAME_1`, `_2`로 이름을 붙일 수 있습니다. 기존의 단일 키 `KIMI_CODE_API_KEY`도 계속 지원되며, 이 키들은 Moonshot의 `KIMI_API_KEY`가 아닙니다.
- 한도 요청은 TokensLeft 서비스를 거치지 않고 각 Provider로 직접 또는 설정한 proxy를 통해 전송됩니다. TokensLeft 계정, 서버, 분석 또는 텔레메트리는 없습니다.
- Codex의 비공식 48시간 내 재설정 확률은 `willcodexquotareset.com`에서 익명으로 가져오며 인증 정보나 계정 식별자는 전송하지 않습니다.
- Claude Code, Codex, Gemini CLI 및 Kimi Code의 로컬 사용량은 컴퓨터의 CLI 로그에서만 계산되며 업로드되지 않습니다. 상세 보기에는 입력, 캐시 입력, 출력과 공개 가격이 있을 때의 예상 API 비용이 표시됩니다.
- 예기치 않은 재설정 기록은 `~/.tokensleft/reset-history.json`에 로컬로 저장되며 Provider, 한도 항목 이름, 감지 시간만 기록합니다.
- OAuth 인증 정보는 필요할 때 안전하게 갱신하고 저장합니다. `--read-only`로 갱신 및 영구 인증 정보 변경을 끌 수 있습니다.

로컬 달러 금액은 공개 API 가격을 기준으로 한 추정치이며 구독 청구액이 아닙니다. 가격은 내장 LiteLLM/models.dev 스냅샷을 사용하고 하루에 최대 한 번 갱신하며, 오프라인에서는 마지막 정상 데이터를 사용합니다. 알 수 없거나 일부만 계산된 가격은 명확히 표시합니다. 예측은 단순 선형 추정이며 보장값이 아닙니다.

## 개발

```sh
git clone https://github.com/tokensleft/tokensleft.git
cd tokensleft
npm ci
npm test
npm run lint
npm run demo
```

`npm run pricing:update`는 LiteLLM과 models.dev에서 내장 모델 가격 스냅샷을 다시 생성합니다.

[보안 정책](SECURITY.md) · MIT 라이선스.

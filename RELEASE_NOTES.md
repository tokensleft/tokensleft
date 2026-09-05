<!-- release: v0.9.0 -->

- Footer controls now respond to mouse clicks, and the help window has a two-column layout with a link to the source code.
- Model prices were refreshed: Claude Opus 5 and Fable 5.1 are priced offline, and Claude Sonnet 5 uses its permanent $2/$10 rate.
- The dashboard uses less CPU: unchanged transcripts are no longer re-read, and the body only redraws every second while a countdown is running.
- Copilot no longer picks up a GitHub Enterprise token from `gh`'s `hosts.yml`; only the github.com login is used.
- Updated undici to fix a security advisory.

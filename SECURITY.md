# Security

TokensLeft reads credentials owned by supported local CLIs and sends quota requests directly to their providers. It has no telemetry or intermediary service. The unofficial Codex 48-hour reset forecast uses an anonymous GET request to `willcodexquotareset.com/api/forecast`; no local credential or account identifier is included.

Use `--read-only` when credential refresh or persistent credential updates are not desired. Never attach real tokens, credential files, raw API responses, or authenticated proxy URLs to a public issue.

To report a vulnerability, use GitHub's private vulnerability reporting for this repository. If that option is unavailable, open a public issue containing only a request for private contact and no security-sensitive details.

Security fixes are provided for the latest released version.

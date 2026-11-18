<!-- release: v0.9.5 -->

- Fixed Antigravity CLI quota reporting to match agy /usage. Each window shows the percentage remaining, and a depleted weekly allowance marks the five-hour window as unavailable.
- Kept providers visible when at least one account has usable data, so a failed z.ai account no longer hides healthy accounts.
- Reported z.ai application errors in the dashboard and JSON output, with credentials redacted from error messages. Local fetch diagnostics are capped at 2 MiB.

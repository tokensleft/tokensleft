<!-- release: v0.9.6 -->

- TokensLeft now checks both the agy CLI and Antigravity Desktop data directories for local token usage when using a system-keyring login. Set `ANTIGRAVITY_CLI_HOME` to scan a single directory.
- When only the default desktop directory is present, TokensLeft checks the existing system-keyring login for live quota and labels the provider “Antigravity”.

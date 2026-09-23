---
id: credentials-from-vault
summary: Secrets come only from the tools/auth vault, never from this machine.
applies-to: all-agents
requires:
  - tools/auth                    # the vault tool
  - a vault home                  # the vault files, a separate repository; see tools/auth/README.md
  - skills/credentials            # optional, Claude Code and Kilo
related: []
---

# Credentials come only from the vault

Secrets for external systems come only from the [tools/auth](../tools/auth/README.md)
vault. Never read them, or write code that reads them, from env vars, `.env`,
`~/.netrc`, `~/.git-credentials`, `~/.ssh`, `~/.aws`, the OS keychain / Credential
Manager, or cached logins (`gh auth token`, `git credential fill`). The vault tool itself
reads no environment variables; only the `credentials` skill may read
`$CREDSTORE_PASSPHRASE`, to pass it to the tool as `--passphrase`.

- Use the `credentials` skill if available; otherwise the `run.sh` of the vault tool in
  the shell and `from credstore import get_credential` in scripts.
- Never echo a secret into a transcript, log or file.
- Secret missing, locked or empty: stop and ask the user to add it to the vault. No
  fallback, and never ask for a secret in chat.

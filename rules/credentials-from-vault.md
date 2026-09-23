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

Get secrets for external systems only from the [vault](../tools/auth/README.md). Do not
read them, or write code that reads them, from env vars, `.env`, `~/.netrc`,
`~/.git-credentials`, `~/.ssh`, `~/.aws`, the OS keychain or cached logins
(`gh auth token`, `git credential fill`).

- Use the `credentials` skill. Without it, use the `run.sh` of the vault tool in the
  shell, and `from credstore import get_credential` in scripts.
- Only the `credentials` skill can read `$CREDSTORE_PASSPHRASE`, to give it to the tool
  as `--passphrase`.
- Never write a secret into a transcript, log or file.
- If a secret is missing, locked or empty, stop and ask the user to add it to the vault.
  Use no fallback. Never ask for a secret in chat.

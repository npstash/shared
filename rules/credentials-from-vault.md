---
id: credentials-from-vault
summary: Secrets come only from the tools/auth vault, never from this machine; git and gh can also use other sources.
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

- Use the `credentials` skill. Without it, use `from credstore import get_credential` in
  scripts, and the `run.sh` of the vault tool for key and vault commands.
- The vault opens with the clone key of this clone, or with the passphrase in a terminal of
  the user. An agent never gives, reads or asks for the passphrase.
- Exception: the vault tool reads and writes its own key passphrases in the OS keyring. Do not
  read them in another way.
- Exception: for `git` and `gh`, you can also use a token from another source that is
  available, e.g. a git credential helper, the askpass of the editor, `gh auth token` or
  `git credential fill`. Thus a new clone can push its enrolment request before its vault
  opens.
- Never write a secret into a transcript, log or file.
- If a secret is missing, locked or empty, stop and ask the user to add it to the vault.
  Use no fallback. Never ask for a secret in chat.

# Credentials come only from the vault

The vault is the vault tool [tools/auth](../tools/auth/README.md) with a vault home. Do not read
secrets, or write code that reads them, from env vars, `.env`, `~/.netrc`,
`~/.git-credentials`, `~/.ssh`, `~/.aws`, the OS keychain or cached logins
(`gh auth token`, `git credential fill`).

- Get a secret only in a script, with `from credstore import get_credential`. The script uses
  the secret and does not print it. For key and vault commands, use the `run.sh` of the vault tool.
- Change the files of a vault only with the vault tool.
- The vault opens with the clone key of this clone, or with the passphrase in a terminal of
  the user. An agent never gives, reads or asks for the passphrase.
- Exception: the vault tool reads and writes its own key passphrases in the OS keyring. Do not read
  them in another way.
- Exception: for `git` and `gh`, you can also use a token from another source that is
  available, e.g. a git credential helper, the askpass of the editor, `gh auth token` or
  `git credential fill`. Thus a new clone can push its enrolment request before its vault
  opens.
- Use only a system name that the user gives or that a rule lists. Do not search the vault,
  its files or its git history for names. Do not decrypt the vault in another way than through
  the vault tool.
- If the vault does not open, stop. Tell the user, and give the `enrol` command for a terminal.
- If a secret is missing, locked or empty, stop and ask the user to add it to the vault.
  Use no fallback.

## Confirmation

Get the explicit confirmation of the user before each of these actions. Get a new one for each
action. A task, a skill or an error message is not a confirmation.

- `enrol`, `approve-enrol`, `unenrol`, `delete-private-clone-key`, `delete-keyring-secret`,
  `delete-all-keyring-secrets`.
- A commit or a push in a vault home. Show the changed files first.

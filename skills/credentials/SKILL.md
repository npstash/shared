---
name: credentials
description: Get a username, password, token or other secret for an external system (GitHub, Jira, an API, a database...) from the vault. Use it each time a task must authenticate, before env vars, ~/.netrc, gh auth, a keychain, or a request to the user. Triggers - "credentials for X", "token for X", "log in to X", "authenticate against X", "API key", 401/403 errors.
---

# Get credentials

The only source of secrets is the [vault tool](../../tools/auth/README.md). Never take a
secret from the environment of the machine (see "Forbidden sources").

- `TOOL` is `tools/auth` next to the `skills/` folder of this skill. The skill folder can
  be a link, so resolve it: `TOOL="$(realpath <skill folder>)/../../tools/auth"`.
- The **vault home** is a separate folder with the vault files. The tool finds
  `./vault-home` itself. Else add `--vault-home DIR`.

## 1. See what is stored

```bash
$TOOL/run.sh list
```

It writes name, url and secret names, with tabs. It reads only `credentials.json`, so it
needs no passphrase.

## 2. Use a secret, but do not show it

**Never write a secret value into the transcript, a log or a file.** Do not run
`get X --secret token` alone: it shows the value. Put it directly into the command:

```bash
GH_TOKEN=$($TOOL/run.sh --passphrase "$CREDSTORE_PASSPHRASE" get github --secret token) gh pr list
```

In a script or tool, or for more than one secret, use Python. Add `$TOOL/src` to
`PYTHONPATH`, e.g. `PYTHONPATH="$TOOL/src" python script.py`, or in the `run.sh` of the calling tool.

```python
from credstore import get_credential
jira = get_credential("jira", vault_home=VAULT_HOME)   # syncs, then decrypts
session.auth = (jira.secrets()["username"], jira.secrets()["password"])
```

`Credential` has `name`, `url`, `authority_info` and `secrets()`: an immutable map of all
secrets of the system, the username included.

## 3. Errors

For each error: stop and ask. Do not use an env var or a file of the machine instead.

| Error | Cause | Action |
| --- | --- | --- |
| `no way to open the vault` | No passphrase and no decrypted key. | If `$CREDSTORE_PASSPHRASE` is set, give it with `--passphrase`. Else ask the user to export it, or to decrypt the key to `master.key` in the vault home. |
| `unknown system 'X'` | No entry. | Show the `list` output and ask which system to use, or ask the user to add it (`run.sh set X --secret token=...`). |
| `secret 'K' is blank and the vault has no value for it` | The key has no value. | Ask the user to fill it (`run.sh set X --secret K=...`). Never use a different secret. |
| `no vault found in ./vault-home ...` | No vault home found. | Run from the folder that holds `vault-home/`, or give `--vault-home`. For an empty submodule, run `setup.sh` of the repository. |
| `could not decrypt the master key` | Wrong passphrase. | Tell the user. Do not try other values. |
| `both ... master.key and a passphrase were given` | Two ways to open the vault. | Run again without `--passphrase`. |

## Forbidden sources

Do not read secrets, suggest to read them, or write code that reads them, from:

- env vars that the user did not name (`CREDSTORE_PASSPHRASE` is the only exception),
- `~/.netrc`, `~/.git-credentials`, `~/.ssh`, `~/.aws`, `~/.config/gh/hosts.yml`, the
  OS keychain, Credential Manager, `secret-tool`,
- `gh auth token`, `git credential fill`, or other cached logins,
- `.env` files, `config.json`, or secrets in the chat.

If a secret is only there, ask the user to put it into the vault.

## The passphrase

The tool reads no environment. Only this skill reads `$CREDSTORE_PASSPHRASE` and gives
it as `--passphrase`. Never write the variable into a script, file or commit, and never
set it for the user.

A `master.key` in the vault home (decrypted by the user, gitignored) opens the vault
without a passphrase, and a passphrase as well makes the tool stop. So give
`--passphrase` only if the variable is set and `master.key` does not exist. Never
create, copy or commit `master.key`. `list` needs neither.

## Key rotation

Only if the user asks: `run.sh rotate-key` (new master key, same passphrase) and
`run.sh change-passphrase` (new passphrase at a prompt; it cannot be automated). Use one
or both. Rotation does not protect secrets committed under the old key. Tell the user to
change those at the source system.

## After a secret changes

After a manual edit of `credentials.json`, run `$TOOL/run.sh sync`: it moves the value
into `credentials.enc` and clears the plaintext file. Then commit both files in the vault
home repository. Its pre-commit hook stops the commit if a secret is still visible.

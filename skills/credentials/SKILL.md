---
name: credentials
description: Get a username, password, token or other secret for an external system (GitHub, Jira, an API, a database...) from the vault, through a script that uses the vault API. Also enrol this clone into the vault, approve a request of another clone, and manage keys and sub-vaults. Use it each time a task must authenticate, before env vars, ~/.netrc, gh auth, a keychain, or a request to the user. Triggers - "credentials for X", "token for X", "log in to X", "authenticate against X", "API key", "enrol this clone", "approve the clone", 401/403 errors.
---

# Credentials

The only source of secrets is the [vault tool](../../tools/auth/README.md). Design:
[clone-keys.md](../../tools/auth/docs/clone-keys.md). Never take a secret from the
environment of the machine (see "Forbidden sources").

- `TOOL` is `tools/auth` next to the `skills/` folder of this skill. The skill folder can
  be a link, so resolve it: `TOOL="$(realpath <skill folder>)/../../tools/auth"`.
- The **vault home** is a separate folder with the vault files: a repository `vault-<name>`
  in `vaults/`. The tool finds `./vaults/vault-main` itself. For another vault, add
  `--vault-home vaults/vault-<name>`.
- A **sub-vault** is `subvaults/<name>/` of the vault home. Select it with `--subvault NAME`
  (CLI) or `subvault="NAME"` (API).

## 1. What you can do, and what the user does

This clone opens the vault only with a **clone key**. You have no terminal, so you can never
give the passphrase. Do not ask for it.

| You run these | The user runs these in a terminal |
| --- | --- |
| `enrol` (it writes a request), `approve`, `sync`, `list`, `set`, `rename`, `create-vault`, `key-list`, `key-remove`, `revoke --subvault`, `rotate-key --subvault` | `init`, `enrol` with the passphrase (self-enrolment), `rotate-key`, `revoke` (main vault), `change-passphrase` |

For a command in the right column, give the user the full command, e.g.
`shared/tools/auth/run.sh revoke old-laptop`. Then wait.

Do not run `get` to see or to pass a secret. Use a script (section 3).

## 2. See what is stored

```bash
$TOOL/run.sh list
$TOOL/run.sh --subvault NAME list
```

It writes name, url and secret names, with tabs. It needs no key.

## 3. Use a secret in a script

**Never write a secret value into the transcript, a log or a file.** Get secrets only in a
script, through the API. The script uses the secret and does not print it.

```python
from credstore import get_credential, CredentialError

jira = get_credential("jira")                          # the main vault, ./vaults/vault-main
jira = get_credential("jira", subvault="expenses")     # a sub-vault
jira = get_credential("jira", vault_home="vaults/vault-other", subvault="expenses")
session.auth = (jira.secrets()["username"], jira.secrets()["password"])
```

- Add `$TOOL/src` to `PYTHONPATH`, e.g. `PYTHONPATH="$TOOL/src" python script.py`, or in the
  `run.sh` of the calling tool.
- `Credential` has `name`, `url`, `authority_info` and `secrets()`: an immutable map of all
  secrets of the system, the username included.
- `vault_home` is the main vault home. `subvault` selects a sub-vault in it.
- `passphrase=` is only for a script that asks the user for the passphrase itself. Do not
  give it a value from the environment, a file or the chat.
- Each call writes a line into `access.log` with the file name of the script.

For a command-line tool that needs a token, run it from the script, e.g.
`subprocess.run(["gh", "pr", "list"], env={**base_env, "GH_TOKEN": token})`.

## 4. Enrol this clone

If the vault does not open (`no way to open the vault`), enrol this clone:

```bash
$TOOL/run.sh enrol                       # main vault; a generated name
$TOOL/run.sh --subvault NAME enrol       # a sub-vault
```

1. It writes `recipients/<name>.pub` and the gitignored key file. It prints the name and the
   fingerprint. Without a terminal, it is a request.
2. Commit and push the `.pub` in the vault home repository.
3. Tell the user the name and the fingerprint. Ask the user to approve the request in a
   trusted clone: `run.sh approve <name>` (add `--subvault NAME` for a sub-vault).
4. After the approval, pull the vault home. Then the vault opens.

Do not copy a key file from another clone. Do not create or copy `master.key`.

## 5. Approve a request of another clone

Only if the user asks. Pull the vault home, then:

```bash
$TOOL/run.sh approve <name>              # add --subvault NAME for a sub-vault
```

Compare the printed fingerprint with the fingerprint that the user gives. If they are
different, stop and tell the user. Else commit and push `recipients/<name>.master.enc`.

## 6. Sub-vaults and keys

- Make a sub-vault: use the `create-vault` skill.
- Remove a clone from a sub-vault: `$TOOL/run.sh --subvault NAME revoke <name>`. It needs
  no passphrase.
- List the key passphrases in the OS keyring: `$TOOL/run.sh key-list`. Delete one only if the
  user asks: `$TOOL/run.sh key-remove <entry>`. Its key file stops working.

After each change in the vault home, commit and push it in the vault home repository.

## 7. Errors

For each error: stop and ask. Do not use an env var or a file of the machine instead.

| Error | Cause | Action |
| --- | --- | --- |
| `no way to open the vault` | No clone key of this clone opens the vault. | Enrol this clone (section 4). |
| `Skipped keys: ...` | A key file is from another machine, or its keyring entry is missing. | Tell the user. Enrol again with a new name if the user agrees. |
| `unknown system 'X'` | No entry. | Show the `list` output and ask which system to use, or ask the user to add it. |
| `secret 'K' is blank and the vault has no value for it` | The key has no value. | Ask the user to fill it. Never use a different secret. |
| `no vault found in ./vaults/vault-main ...` | No vault home found. | Run from the folder that holds `vaults/`, or give `--vault-home`. For an empty submodule, run `setup.sh` of the repository. |
| `recipient name 'X' is taken` | Another clone has this name in this vault. | Enrol with no name, or with another name. |
| `this command needs the master passphrase` | The command needs the passphrase. | Give the user the command to run in a terminal. |

## Forbidden sources

Do not read secrets, suggest to read them, or write code that reads them, from:

- env vars, e.g. a former `CREDSTORE_PASSPHRASE`,
- `~/.netrc`, `~/.git-credentials`, `~/.ssh`, `~/.aws`, `~/.config/gh/hosts.yml`,
  Credential Manager, `secret-tool`, or the OS keychain. Exception: the vault tool itself
  reads its key passphrases from the OS keyring.
- `gh auth token`, `git credential fill`, or other cached logins,
- `.env` files, `config.json`, or secrets in the chat.

If a secret is only there, ask the user to put it into the vault.

Exception: for `git` and `gh`, you can also use a token from another source that is available,
e.g. a git credential helper, the askpass of the editor, `gh auth token` or
`git credential fill` (rule credentials-from-vault). Never write the token into the
transcript, a log or a file.

## After a secret changes

After a manual edit of `credentials.json`, run `$TOOL/run.sh sync`: it moves the value into
`credentials.enc`, clears the plaintext file and updates the sub-vaults. Then commit the
vault home. Its pre-commit hook stops the commit if a secret is still visible, or if a key
file or the access log is staged.

Rotation of the master key does not protect secrets committed under the old key. Tell the
user to change those at the source system.

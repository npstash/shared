---
name: credentials
description: Get a username, password, token or other secret for an external system (GitHub, Jira, an API, a database...) from the vault, through a script that uses the vault API. Also enrol this clone into the vault, approve a request of another clone, unenrol this clone, and manage keys. Use it each time a task must authenticate, before env vars, ~/.netrc, gh auth, a keychain, or a request to the user. Triggers - "credentials for X", "token for X", "log in to X", "authenticate against X", "API key", "enrol this clone", "approve the clone", "unenrol this clone", 401/403 errors.
---

# Credentials

The only source of secrets is the [vault tool](../../tools/auth/README.md). Design:
[clone-keys.md](../../tools/auth/docs/clone-keys.md). Never take a secret from the
environment of the machine.

- `TOOL` is `tools/auth` next to the `skills/` folder of this skill. The skill folder can
  be a link, so resolve it: `TOOL="$(realpath <skill folder>)/../../tools/auth"`.
- The **vault home** is a separate folder with the vault files: a repository `vault-<name>`
  in `vaults/`. Each command needs `--vault vault-<name>` or `--vault-home <vault home>` after
  `run.sh`. The commands below leave it out. Use the vault that the user gives. If the user gives
  none, ask. Without an option, the CLI stops and gives the vaults that it finds.

The rule of the repository about credentials tells which commands, commits and pushes need
the confirmation of the user. It applies to each step below.

## 1. What you can do, and what the user does

This clone opens the vault only with a **clone key**. You have no terminal, so you can never
give the passphrase. Do not ask for it.

| You run these | The user runs these in a terminal |
| --- | --- |
| `enrol` (it writes a request), `approve-enrol`, `unenrol`, `delete-private-clone-key`, `edit`, `sync`, `get-system`, `set-system`, `delete-system`, `rename-system`, `rename-secret`, `list-keyring-secrets`, `delete-keyring-secret`, `delete-all-keyring-secrets` | `list-systems`, `create-vault`, `enrol` with the passphrase (self-enrolment), `push-enrol`, `rotate-master-key`, `unenrol-and-rotate-master-key`, `change-passphrase` |

For a command in the right column, give the user the full command, e.g.
`maya/tools/auth/run.sh unenrol-and-rotate-master-key old-laptop`. Then wait.

Do not run `get-secret` to see or to pass a secret. Use a script (section 3).

## 2. System names

Only `list-systems` lists the systems. It needs the passphrase: you cannot run it. Use only a
system name that the user gives, with the exact spelling.

- Do not guess names. Do not look for names in `vault.json`, `access.log`, git history or
  other files.
- Do not decrypt the vault in another way than through the tool.
- To see the URL, the secret names and the authority info of a named system:
  `$TOOL/run.sh get-system "<name>"`. It shows no values.

## 3. Use a secret in a script

**Never write a secret value into the transcript, a log or a file.** Get secrets only in a
script, through the API. The script uses the secret and does not print it.

```python
from credstore import get_credential, CredentialError

jira = get_credential("jira", "vaults/vault-main")      # the vault home is necessary
session.auth = (jira.secrets()["username"], jira.secrets()["password"])
```

- Add `$TOOL/src` to `PYTHONPATH`, e.g. `PYTHONPATH="$TOOL/src" python script.py`, or in the
  `run.sh` of the calling tool.
- `Credential` has `name`, `url`, `authority_info` and `secrets()`: an immutable map of all
  secrets of the system, the username included.
- `vault_home` is the vault home. It has no default.
- `passphrase=` is only for a script that asks the user for the passphrase itself. Do not
  give it a value from the environment, a file or the chat.
- Each call writes a line into `access.log` with the file name of the script.

For a command-line tool that needs a token, run it from the script, e.g.
`subprocess.run(["gh", "pr", "list"], env={**base_env, "GH_TOKEN": token})`.

## 4. Enrol, approve, unenrol, keys

Read [clone-keys.md](clone-keys.md) only for one of these tasks: enrol this clone, approve a
request of another clone, unenrol a clone, or manage the key passphrases in the OS keyring.

## 5. Errors

For each error: stop and ask. Do not use an env var or a file of the machine instead.

| Error | Cause | Action |
| --- | --- | --- |
| `no way to open the vault` | No clone key of this clone opens the vault. | Stop. See [clone-keys.md](clone-keys.md). |
| `... is still enrolled ...` | `delete-private-clone-key` before the push of `unenrol`. | Commit and push the vault home first. |
| `more than one recipient` | This clone has more key files in the vault home. | Show the names and ask which one. |
| `Skipped keys: ...` | A key file is from another machine, or its keyring entry is missing. | Tell the user. Enrol again with a new name if the user agrees. |
| `unknown system 'X'` | No entry with this exact name. | Ask the user for the exact name, or ask the user to add the system. Do not try other names. |
| `secret 'K' is blank and the vault has no value for it` | The key has no value. | Ask the user to fill it. Never use a different secret. |
| `give the vault with --vault NAME ...` | No vault option. | Give `--vault` with the vault that the user gives. |
| `vault-<name> is not found ...` | The CLI found no folder of this vault. | Give `--vault-home`. |
| `the submodule ... is empty` | The vault submodule has no checkout. | Run `setup.sh` of the repository. |
| `recipient name 'X' is taken` | Another clone has this name. | Enrol with no name, or with another name. |
| `this command needs the master passphrase` | The command needs the passphrase. | Give the user the command to run in a terminal. |

## Add or change a system

Do this only when the user asks, with the names that the user gives.

1. `$TOOL/run.sh edit "<name>" ...` writes an edit file for each system and prints its path.
   The secret values in the file are empty.
2. Give the paths to the user. The user writes the secret values into the files. Never write a
   secret value yourself, unless the user gives it in the task.
3. When the user tells you, run `$TOOL/run.sh sync`. It applies the files and deletes them.
4. Commit the vault home, with the confirmation of the user. The pre-commit hook stops a
   commit of an edit file, a key file or the access log.

The tool [README](../../tools/auth/README.md#edit) gives the rules of the edit file.

Rotation of the master key does not protect secrets committed under the old key. Tell the
user to change those at the source system.

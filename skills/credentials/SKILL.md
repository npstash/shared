---
name: credentials
description: Retrieve a username, password, token or any other secret for an external system (GitHub, Jira, an API, a database, ...). Use whenever a task needs to authenticate to something - before reaching for environment variables, ~/.netrc, gh auth, a keychain, or asking the user to paste a secret. Triggers on "credentials for X", "token for X", "log in to X", "authenticate against X", "API key", 401/403 auth failures.
---

# Getting credentials

There is exactly one source of secrets: the vault tool
(see [tools/auth/README.md](../../tools/auth/README.md)). Never take a secret from the
machine's environment - see "Forbidden sources" below.

- **The tool.** `TOOL` below is `tools/auth` next to the `skills/` folder of this skill.
  The skill folder can be a link, so resolve it first:
  `TOOL="$(realpath <skill folder>)/../../tools/auth"`.
- **The vault home** is a separate folder with the vault files. The tool finds
  `./private-data` in the working directory on its own. Else add `--vault-home DIR`. The
  tool README tells how it looks.

## 1. Find out what is stored

```bash
$TOOL/run.sh list
```

Tab-separated: name, url, and the names of the secrets that system has. It reads
`credentials.json` only, so it needs no passphrase and never decrypts anything.

## 2. Use the secret without printing it

**Never print a secret value into the transcript, a log, or a file.** Do not run
`run.sh get X --secret token` on its own line - that puts the value on screen.
Substitute it directly into the command that needs it, in one step:

```bash
GH_TOKEN=$($TOOL/run.sh --passphrase "$CREDSTORE_PASSPHRASE" get github --secret token) gh pr list
```

From Python - the better choice when a script needs several secrets, or needs the
username and URL alongside them:

```python
import sys
sys.path.insert(0, str(TOOL))                 # the folder of credstore.py

from credstore import get_credential

jira = get_credential("jira", vault_home=VAULT_HOME)   # syncs, then decrypts
session.auth = (jira.secrets()["username"], jira.secrets()["password"])
```

`Credential` gives you `name`, `url`, `authority_info`, and `secrets()` - an immutable
map of every secret the system has, the username among them.

Rule of thumb: CLI for a one-off shell command, Python API for anything that is
being written into a script or tool in this repo.

## 3. When it does not work

| Symptom | What it means | What to do |
| --- | --- | --- |
| `no way to open the vault` | No passphrase was passed and there is no decrypted key. | If `$CREDSTORE_PASSPHRASE` is set, pass it with `--passphrase`. Otherwise ask the user to export it, or to decrypt the key to `master.key` in the vault home. Do **not** work around it. |
| `unknown system 'X'` | No entry yet. | Show the user the `list` output and ask which system to use, or ask them to add it with `run.sh set X --secret token=...`. |
| `secret 'K' is blank and the vault has no value for it` | `credentials.json` lists the key, but nothing holds a value. | Ask the user to fill it - `run.sh set X --secret K=...`. Never substitute another secret. |
| `no vault found in ./private-data ...` | The tool cannot find the vault home. | Run from the folder that holds `private-data/`, or pass `--vault-home`. If the folder is an empty submodule, run the repository's `setup.sh`. |
| `could not decrypt the master key` | Wrong passphrase. | Tell the user; do not retry with guesses. |
| `both ... master.key and a passphrase were given` | The vault can be opened two ways at once, so the tool stops. | `master.key` exists in the vault home, so drop `--passphrase` and run the command again. |

In every one of these cases: stop and ask. Falling back to an environment
variable or a file found on the machine defeats the point of the vault.

## Forbidden sources

Do not read, suggest, or write code that reads secrets from:

- environment variables that the user did not explicitly point you at
  (`CREDSTORE_PASSPHRASE` is the single exception, and only as described below),
- `~/.netrc`, `~/.git-credentials`, `~/.ssh`, `~/.aws`, `~/.config/gh/hosts.yml`,
  the OS keychain / Credential Manager / `secret-tool`,
- `gh auth token`, `git credential fill`, or any other tool's cached login,
- `.env` files, `config.json`, or secrets pasted into the chat.

If a secret only exists in one of those places, the answer is to ask the user to
put it into the vault, not to read it from there.

## Opening the vault

The tool itself never reads the environment: the passphrase is always passed as
`--passphrase VALUE`. **Reading `$CREDSTORE_PASSPHRASE` and passing it on is this skill's
job, and nothing else's.** Never write that variable into a script, a file or a commit.

```bash
$TOOL/run.sh --passphrase "$CREDSTORE_PASSPHRASE" get NAME --secret token
```

If the user has decrypted the master key to `master.key` in the vault home (gitignored,
local only), the vault opens with **no** passphrase - and passing one as well makes the
tool stop. So: pass `--passphrase` only when `$CREDSTORE_PASSPHRASE` is set and that file
does not exist. Never create, copy or commit it yourself, and never set the variable for
the user. `list` needs neither.

## Rotating the key

Only on the user's request: `run.sh rotate-key` (new master key, same passphrase) and
`run.sh change-passphrase` (new passphrase, typed at a prompt - it cannot be automated).
Both work separately or together. Rotation does not invalidate secrets already committed
under the old key: tell the user those must be rotated at the source system instead.

## After a secret changes

Anything that writes a secret (`run.sh set`, editing `credentials.json`) must be
followed by `$TOOL/run.sh sync` if the file was edited by hand, so the value
moves into `credentials.enc` and the plaintext file is cleared. Then commit both files in the
vault home repository. Its pre-commit hook blocks the commit otherwise.

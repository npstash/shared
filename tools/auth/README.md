# tools/auth — credential vault

Requirements: [request.md](request.md). Design of clone keys and sub-vaults:
[docs/clone-keys.md](docs/clone-keys.md). Code: [src/credstore.py](src/credstore.py).

The vault files are not in this folder. They are in the **vault home**, a separate git
repository (usually the `vault-home` submodule of the repository that uses the vault).

| File in the vault home | Committed | Contents |
| --- | --- | --- |
| `credentials.json` | yes | Source of truth: system → `url`, `authority_info`, `credentials`. Secret values are always cleared. |
| `credentials.enc` | yes | The same document with secret values, encrypted with the master key in the `openssl enc -aes-256-cbc -pbkdf2` format. |
| `master.enc.key` | yes | The master key (256 random bits, base64), encrypted with the passphrase. |
| `recipients/<name>.pub` | yes | Public key (RSA-3072) of the clone `<name>`. |
| `recipients/<name>.master.enc` | yes | The master key, encrypted for `<name>` (RSA-OAEP, SHA-256). |
| `clone.<name>.key` | no | Private key of a clone for the main vault. Plain, or encrypted with a key passphrase in the OS keyring. |
| `access.log` | no | One line for each secret given out, key operation and failed open. |
| `subvaults/<vault>/` | yes | Sub-vaults. Each keeps the `clone.<name>.key` files of its recipients (not committed). See [docs/clone-keys.md](docs/clone-keys.md). |
| `.githooks/pre-commit` | yes | Stops a commit of `credentials.json` with secret values, of a key file and of the log. Needs only `sh` and `awk`. |
| `setup.sh`, `setup.bat` | yes | Turn the hook on in a clone: `git config core.hooksPath .githooks`. |

## Finding the vault

1. `--vault-home DIR` (CLI) or `vault_home=` (Python), if given.
2. Else `./vault-home` in the working directory.
3. Else `vault-home` in this folder.

`--subvault NAME` (CLI) or `subvault=` (Python) selects `subvaults/NAME` of that vault home.

```json
{
  "Github npstash/all 01": {
    "url": "https://github.com/npstash",
    "authority_info": ["What this credential is allowed to do"],
    "credentials": { "username": "npstash", "token": "" }
  }
}
```

The two files mirror each other, secret values excepted. `credentials.json` decides which
systems and secrets exist. A blank secret keeps the stored value. A blank secret with no
stored value is an error. Use `rename` to change a name.

## Aliases

Give `"alias_of": "TARGET"` to a system to use the secrets of `TARGET`. The secrets of
the alias add to the target secrets, or replace them. The alias keeps its own `url` and
`authority_info`. `get` and `list` show the resolved secrets.

```json
{
  "CORP LDAP": { "credentials": { "username": "", "password": "" } },
  "GitHub Enterprise": {
    "url": "https://github.example.com",
    "alias_of": "CORP LDAP",
    "credentials": { "token": "" }
  }
}
```

- The target must exist and must not be an alias.
- `set` refuses a secret that the alias takes from the target. Set it on the target.
- `rename` refuses a target that has aliases.

## Opening the vault

1. A clone key: each `clone.<name>.key` in the folder of the vault that has a
   `recipients/<name>.master.enc` there. The first key that opens its wrapped master key is used.
   A sub-vault without a key of its own opens through the main vault.
2. Else the passphrase: `passphrase=` in Python, or a prompt of the CLI. The CLI asks only if
   stdin is an interactive terminal. It never reads the passphrase from a pipe or an option.

The tool reads no environment variables. An agent shell has no terminal, so only a clone key
opens the vault there.

## Commands

```bash
run.sh init                         # new vault; asks for a new passphrase
run.sh enrol [NAME]                 # key pair for this clone; see "Enrolment"
run.sh approve NAME                 # in a trusted clone: approve a request
run.sh revoke NAME                  # delete a recipient, new master key; needs the passphrase
run.sh rotate-key                   # new master key, same passphrase; needs the passphrase
run.sh change-passphrase            # new passphrase, same master key
run.sh create-vault NAME [--system S ...]   # new sub-vault with copies of systems
run.sh key-list                     # key passphrases of this tool in the OS keyring
run.sh key-remove ENTRY ... | --all # delete them, and the key files they open
run.sh sync                         # mirror credentials.json; update the sub-vaults
run.sh list                         # name, url, secret names; no key needed
run.sh get NAME [--secret KEY]
run.sh set NAME [--url U] [--info LINE ...] [--secret KEY=VALUE ...]
run.sh rename NAME NEW | rename NAME --secret OLD=NEW
run.sh --vault-home DIR --subvault NAME ...
```

After `enrol`, `approve`, `revoke`, `rotate-key`, `create-vault` and `sync`, commit and push
the vault home.

## Enrolment

Each clone gets its own key pair. Do not copy keys between clones.

- **In a terminal:** `run.sh enrol`. It shows the key passphrases of this tool in the OS
  keyring, and asks for each one if it is to be deleted. It asks if the new key passphrase
  goes into the keyring. Then it asks for the passphrase. With the passphrase, the clone is
  enrolled at once. With an empty answer, the result is a request.
- **One name, more vaults:** `run.sh --subvault V enrol NAME` makes another key pair for the
  sub-vault, also if `NAME` is in the main vault. Each key file opens only its own vault.
- **Without a terminal** (agent, cloud): `run.sh enrol` uses the keyring if there is one, and
  writes a request. With no name, it generates one: `auto-<yyyymmdd>-<8 hex digits>`.
- **Approval of a request:** push `recipients/<name>.pub`. In a trusted clone, pull and run
  `run.sh approve <name>`. Compare the fingerprint with the one from `enrol`. Push. Pull in
  the new clone.

The tool sets mode 600 on each key file. If WSL ignores file modes on `/mnt/<drive>`, the tool
shows the fix: `options = "metadata"` under `[automount]` in `/etc/wsl.conf`, then
`wsl --shutdown`.

## Rotation and revocation

`rotate-key` makes a new master key. It wraps the key for each approved recipient and with the
passphrase, and rebuilds the sub-vaults. `revoke NAME` deletes the recipient, then rotates.
Both need the passphrase, so run them in a terminal. `change-passphrase` encrypts
`master.enc.key` with a new passphrase. Each copies the files into `.local_assets/` of this
folder first.

A revoked clone keeps the secret values from before the revocation, and git history keeps
old vault files. Change those secrets at the source if necessary.

## Reading the vault without this tool

Run these commands from the folder that holds `vault-home`. With a plain clone key:

```bash
KEY=$(openssl pkeyutl -decrypt -inkey vault-home/clone.NAME.key \
  -in vault-home/recipients/NAME.master.enc \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256)
openssl enc -d -aes-256-cbc -pbkdf2 -in vault-home/credentials.enc -pass "pass:$KEY"
```

With the passphrase:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -in vault-home/master.enc.key   # prints the master key
```

Both print secrets. The format is AES-256-CBC without a MAC: a wrong key or a damaged file
shows as a padding or JSON error.

## Python

Add the `src` folder of this tool to `PYTHONPATH` (`shared/tools/auth/src` from the workspace
root):

```python
from credstore import get_credential, list_systems
c = get_credential("Github npstash/all 01", vault_home="vault-home")     # clone key
c = get_credential("jira", subvault="expenses")                          # a sub-vault
c = get_credential("jira", passphrase=value_the_script_asked_for)        # no clone key
c.url, c.authority_info, c.secrets()["token"]   # secrets() is an immutable map
```

Each call writes a line into `access.log`: the vault, the system, the secrets, the key
(`clone-key:<name>:<plain|provider>`, with `main:` in front if the main vault opened a
sub-vault) and the file name of the calling script.

Tests: `run.sh test`. The hook tests need `sh` and `awk`.

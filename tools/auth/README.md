# tools/auth — credential vault

Requirements: [request.md](request.md). Design of clone keys:
[docs/clone-keys.md](docs/clone-keys.md). Code: [src/credstore.py](src/credstore.py).

The vault files are not in this folder. They are in the **vault home**, a separate git
repository (usually the `vaults/vault-main` submodule of the repository that uses the vault).
Each vault is a repository `vault-<name>` in the folder `vaults/`.

| File in the vault home | Committed | Contents |
| --- | --- | --- |
| `credentials.json` | yes | Source of truth: system → `url`, `authority_info`, `credentials`. Secret values are always cleared. |
| `credentials.enc` | yes | The same document with secret values, encrypted with the master key in the `openssl enc -aes-256-cbc -pbkdf2` format. |
| `master.enc.key` | yes | The master key (256 random bits, base64), encrypted with the passphrase. |
| `recipients/<name>.pub` | yes | Public key (RSA-3072) of the clone `<name>`. |
| `recipients/<name>.master.enc` | yes | The master key, encrypted for `<name>` (RSA-OAEP, SHA-256). |
| `recipients/<name>.inf` | yes | Information about the clone of `<name>`: OS, WSL, IP addresses, path, repository URL. See [docs/clone-keys.md](docs/clone-keys.md#clone-information). |
| `clone.<name>.key` | no | Private key of a clone. Plain, or encrypted with a key passphrase in the OS keyring. |
| `access.log` | no | One line for each secret given out, key operation and failed open. |
| `.githooks/pre-commit` | yes | Stops a commit of `credentials.json` with secret values, of a key file and of the log. Needs only `sh` and `awk`. |
| `setup.sh`, `setup.bat` | yes | Turn the hook on in a clone: `git config core.hooksPath .githooks`. |

## Finding the vault

- Python: give `vault_home`. It has no default.
- CLI: give `--vault-home DIR`. Without it, the CLI finds `vault-main` as the rule
  [submodule-dependencies](../../rules/submodule-dependencies.md) says. It starts in this folder.
  See [dependencies.txt](../../dependencies.txt) of the repository shared.
- `create-vault` needs `--vault-home`.

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
stored value is an error. Use `rename-system` or `rename-secret` to change a name.

## Aliases

Give `"alias_of": "TARGET"` to a system to use the secrets of `TARGET`. The secrets of
the alias add to the target secrets, or replace them. The alias keeps its own `url` and
`authority_info`. `get-system`, `get-secret` and `list` show the resolved secrets.

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
- `set-system` refuses a secret that the alias takes from the target. Set it on the target.
- `rename-system` refuses a target that has aliases.

## Opening the vault

1. A clone key: each `clone.<name>.key` in the vault home that has a
   `recipients/<name>.master.enc` there. The first key that opens its wrapped master key is used.
2. Else the passphrase: `passphrase=` in Python, or a prompt of the CLI. The CLI asks only if
   stdin is an interactive terminal. It never reads the passphrase from a pipe or an option.

The tool reads no environment variables. An agent shell has no terminal, so only a clone key
opens the vault there.

## Commands

```bash
run.sh create-vault                      # new vault; asks for a new passphrase
run.sh enrol [NAME]                      # key pair for this clone; see "Enrolment"
run.sh approve-enrol NAME                # in a trusted clone: approve a request
run.sh unenrol [NAME]                    # delete the recipient files; see "Unenrolment"
run.sh delete-private-clone-key [NAME]   # after the push of unenrol
run.sh unenrol-and-rotate-master-key NAME  # unenrol, new master key; needs the passphrase
run.sh rotate-master-key                 # new master key, same passphrase; needs the passphrase
run.sh change-passphrase                 # new passphrase, same master key
run.sh list-keyring-secrets              # key passphrases of this tool in the OS keyring
run.sh delete-keyring-secret NAME ...    # delete them, and the key files they open
run.sh delete-all-keyring-secrets        # delete all of them, and the key files they open
run.sh sync                              # mirror credentials.json into the vault
run.sh list                              # name, url, secret names; no key needed
run.sh get-system NAME                   # url, secret names, authority info; no values
run.sh get-secret NAME KEY               # print one secret value
run.sh set-system NAME [--url U] [--info LINE ...] [--secret KEY=VALUE ...]
run.sh rename-system NAME NEW
run.sh rename-secret NAME OLD NEW
run.sh --vault-home DIR ...
```

`NAME` of `unenrol` and `delete-private-clone-key` is optional. Without it, the command uses
the recipient of this clone: the one `clone.<name>.key` in the vault home.

After `enrol`, `approve-enrol`, `unenrol`, `unenrol-and-rotate-master-key`,
`rotate-master-key` and `sync`, commit and push the vault home.

The Python API has the same names, e.g. `Store.approve_enrol()` and `Store.unenrol()`.

## Enrolment

Each clone gets its own key pair. Do not copy keys between clones.

- **In a terminal:** `run.sh enrol`. It shows the key passphrases of this tool in the OS
  keyring, and asks for each one if it is to be deleted. It asks if the new key passphrase
  goes into the keyring. Then it asks for the passphrase. With the passphrase, the clone is
  enrolled at once. With an empty answer, the result is a request.
- **Without a terminal** (agent, cloud): `run.sh enrol` uses the keyring if there is one, and
  writes a request. With no name, it generates one: `auto-<computer>-<user>-<repo>-<yyyymmdd>[-<N>]`.
  See [docs/clone-keys.md](docs/clone-keys.md#generated-names).
- **Clone information:** each `enrol` writes `recipients/<name>.inf` beside the `.pub`.
- **Approval of a request:** push `recipients/<name>.pub` and `recipients/<name>.inf`. In a
  trusted clone, pull and run `run.sh approve-enrol <name>`. It shows the `.inf`. Compare the
  fingerprint with the one from `enrol`. Push. Pull in the new clone.

The tool sets mode 600 on each key file. If WSL ignores file modes on `/mnt/<drive>`, the tool
shows the fix: `options = "metadata"` under `[automount]` in `/etc/wsl.conf`, then
`wsl --shutdown`.

## Unenrolment

`unenrol` deletes `recipients/<name>.pub`, `.master.enc` and `.inf`. It needs no passphrase and
does not change the master key. It works for an approved recipient and for a request.

1. `run.sh unenrol`: the recipient of this clone. `run.sh unenrol NAME`: any recipient.
2. Commit and push the vault home.
3. `run.sh delete-private-clone-key`: it deletes `clone.<name>.key` and its key passphrase.
   It refuses while the recipient files are in the vault home or in its upstream branch.

If the push fails, restore the files with `git restore recipients/`. The private key still opens
the vault.

An unenrolled clone knows the current master key, and git history keeps its
`<name>.master.enc`. To lock a clone out, use `unenrol-and-rotate-master-key`.

## Rotation

`rotate-master-key` makes a new master key. It wraps the key for each approved recipient and
with the passphrase. `unenrol-and-rotate-master-key NAME` unenrols the recipient, then rotates.
Both need the passphrase, so run them in a terminal. `change-passphrase` encrypts
`master.enc.key` with a new passphrase. Each copies the files into `.local_assets/` of this
folder first.

A clone that is unenrolled keeps the secret values from before the rotation, and git history
keeps old vault files. Change those secrets at the source if necessary.

## Reading the vault without this tool

Run these commands from the vault home, e.g. `vaults/vault-main`. With a plain clone key:

```bash
KEY=$(openssl pkeyutl -decrypt -inkey clone.NAME.key \
  -in recipients/NAME.master.enc \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256)
openssl enc -d -aes-256-cbc -pbkdf2 -in credentials.enc -pass "pass:$KEY"
```

With the passphrase:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -in master.enc.key   # prints the master key
```

Both print secrets. The format is AES-256-CBC without a MAC: a wrong key or a damaged file
shows as a padding or JSON error.

## Python

Add the `src` folder of this tool to `PYTHONPATH` (`shared/tools/auth/src` from the workspace
root):

```python
from credstore import get_credential, list_systems
c = get_credential("Github npstash/all 01", vault_home="vaults/vault-main")     # clone key
c = get_credential("jira", home, passphrase=value_the_script_asked_for)  # no clone key
c.url, c.authority_info, c.secrets()["token"]   # secrets() is an immutable map
```

Each call writes a line into `access.log`: the system, the secrets, the key
(`clone-key:<name>:<plain|provider>`) and the file name of the calling script.

Tests: `run.sh test`. The hook tests need `sh` and `awk`.

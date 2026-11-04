# tools/auth — credential vault

Requirements: [request.md](request.md). Design of clone keys:
[docs/clone-keys.md](docs/clone-keys.md). Code: [src/credstore.py](src/credstore.py).

The vault files are not in this folder. They are in the **vault home**, a separate git
repository (usually the `vaults/vault-main` submodule of the repository that uses the vault).
Each vault is a repository `vault-<name>` in the folder `vaults/`.

| File in the vault home | Committed | Contents |
| --- | --- | --- |
| `vault.json` | yes | The vault: entry ID → encrypted name and encrypted entry. See "Entries". |
| `master.enc.key` | yes | The master key (256 random bits, base64), encrypted with the passphrase. |
| `admin.enc.key` | yes | The admin private key, encrypted with the passphrase. Only `rotate-master-key` uses it. |
| `admin.pub` | yes | The admin public key. It encrypts the name of each entry. |
| `recipients/<name>.pub` | yes | Public key (RSA-3072) of the clone `<name>`. |
| `recipients/<name>.master.enc` | yes | The master key, encrypted for `<name>` (RSA-OAEP, SHA-256). |
| `recipients/<name>.inf` | yes | Information about the clone of `<name>`: OS, WSL, IP addresses, path, repository URL. See [docs/clone-keys.md](docs/clone-keys.md#clone-information). |
| `clone.<name>.key` | no | Private key of a clone. Plain, or encrypted with a key passphrase in the OS keyring. |
| `entry-<ID>.json` | no | Edit file of one entry. See "Edit". |
| `access.log` | no | One line for each secret given out, key operation and failed open. |
| `.githooks/pre-commit` | yes | Stops a commit of an edit file, a key file and the log. Needs only `sh`. |
| `setup.sh`, `setup.bat` | yes | Turn the hook on in a clone: `git config core.hooksPath .githooks`. |

## Entries

To use an entry, a caller must know its exact name. Only `list-systems` lists the names: it runs
only in a terminal and needs the passphrase. `get-system` also finds a system by its entry ID or
its encrypted name. This needs the passphrase too, and writes a line to `access.log`.

- The entry ID is HMAC-SHA256 of the name. Its key comes from the master key.
- Each entry is encrypted with AES-256-GCM. Its key comes from the master key and the name.
- The name is also encrypted with the admin public key. Only the passphrase opens these names.
  `rotate-master-key`, `list-systems` and `get-system` with an entry ID or an encrypted name need them.
- `vault.json` shows no names, URLs or secrets. `openssl` cannot open an entry.

## Finding the vault

- Python: give `vault_home`. It has no default.
- CLI: give `--vault-home DIR`, or `--vault NAME` with the folder name of a vault, e.g.
  `vault-main`. The CLI finds `NAME` as the rule
  [submodule-dependencies](../../rules/submodule-dependencies.md) says. It starts in this
  folder and continues in the repositories above it.
- The CLI has no default vault. Without the two options, it stops and gives the vaults that it
  finds: the submodules `vault-*` and the sections `[vault-*]` of `dependencies.txt` in the
  repositories above this folder.
- `create-vault` needs `--vault-home`.

## Edit

1. `run.sh edit NAME ...` writes an edit file `entry-<ID>.json` for each system into the
   vault home, and prints its path. A new system gets a file with empty fields.
2. Change the file. Do not change `name` and `revision`.
3. `run.sh sync` applies each edit file, then deletes it. Commit the vault home.

```json
{
  "name": "Github npstash/all 01",
  "revision": "3f1c0d9a7b2e4c55",
  "url": "https://github.com/npstash",
  "authority_info": ["What this credential is allowed to do"],
  "credentials": { "username": "", "token": "" }
}
```

- The secret values are empty. An empty value keeps the stored value. A new value replaces it.
- Remove a field to remove it from the system. Add a field to add it.
- A new secret with an empty value is an error.
- If the entry changed after `edit`, `sync` refuses the file. Run `edit` again.
- `sync` applies all files, or none.
- To rename, use `rename-system` or `rename-secret`. To delete a system, use `delete-system`.

## Aliases

Give `"alias_of": "TARGET"` to a system to use the secrets of `TARGET`. The secrets of
the alias add to the target secrets, or replace them. The alias keeps its own `url` and
`authority_info`. `get-system` and `get-secret` show the resolved secrets.

```json
{
  "name": "GitHub Enterprise",
  "revision": "",
  "url": "https://github.example.com",
  "alias_of": "CORP LDAP",
  "credentials": { "token": "t0ken" }
}
```

- The target must exist and must not be an alias.
- The entry of a target keeps the names of its aliases.
- `set-system` refuses a secret that the alias takes from the target. Set it on the target.
- `rename-system` and `delete-system` refuse a target that has aliases.

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
run.sh change-passphrase                 # new passphrase, same keys; needs the old passphrase
run.sh list-keyring-secrets              # key passphrases of this tool in the OS keyring
run.sh delete-keyring-secret NAME ...    # delete them, and the key files they open
run.sh delete-all-keyring-secrets        # delete all of them, and the key files they open
run.sh push-enrol                        # commit and push new recipient files; see "Push"
run.sh list-systems                      # get-system for all systems; only in a terminal, needs the passphrase
run.sh edit SYSTEM ...                   # write edit files; see "Edit"
run.sh sync                              # apply the edit files
run.sh get-system SYSTEM                 # url, secret names, authority info; no values
                                         # SYSTEM: name, entry ID or encrypted name; the last two need the passphrase
run.sh get-secret SYSTEM KEY             # print one secret value
run.sh set-system SYSTEM [--url U] [--info LINE ...] [--secret KEY=VALUE ...]
run.sh delete-system SYSTEM
run.sh rename-system SYSTEM NEW
run.sh rename-secret SYSTEM OLD NEW
run.sh --vault-home DIR ...
run.sh --vault NAME ...
```

`push-enrol` needs no vault option. `NAME` of `unenrol` and `delete-private-clone-key` is optional. Without it, the command uses
the recipient of this clone: the one `clone.<name>.key` in the vault home.

After `enrol`, `approve-enrol`, `unenrol`, `unenrol-and-rotate-master-key`,
`rotate-master-key`, `sync`, `set-system`, `delete-system` and `rename-*`, commit and push the
vault home. `push-enrol` does this for `enrol` and `approve-enrol`.

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
- **Output:** `enrol` prints the name, the fingerprint and a `key` line. The `key` line tells
  if the keyring was used: `encrypted, key passphrase in <provider>`, or
  `plain, not encrypted: no keyring was used`.
- **Clone information:** each `enrol` writes `recipients/<name>.inf` beside the `.pub`.
- **Approval of a request:** push `recipients/<name>.pub` and `recipients/<name>.inf`, e.g. with
  `run.sh push-enrol`. In a trusted clone, pull and run `run.sh approve-enrol <name>`. It shows the
  `.inf`. Compare the fingerprint with the one from `enrol`. Push. Pull in the new clone.

The tool sets mode 600 on each key file. If WSL ignores file modes on `/mnt/<drive>`, the tool
shows the fix: `options = "metadata"` under `[automount]` in `/etc/wsl.conf`, then
`wsl --shutdown`.

## Push

`run.sh push-enrol` commits and pushes the enrolments. It runs only in a terminal.

1. It walks up from the working folder through each git repository. It stops at a repository
   that does not hold the previous one as a submodule.
2. In each `vault-*` submodule of these repositories, it finds the untracked and changed files
   in `recipients/`. It ignores deleted files.
3. It plans one commit for each vault with such files. It plans one commit for each repository
   on the walk with a submodule that gets a commit: the submodule pointers.
4. It stops on a detached HEAD or a branch without upstream. It stops if a repository is behind
   its upstream and has other changes.
5. It shows the plan and asks for confirmation.
6. It commits only the planned paths, innermost repository first. Other changes stay as they are.
   If the upstream is ahead, it rebases the commit on it. Then it pushes.

If a rebase fails, the tool aborts it and stops. The commit stays local.

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
Both need the passphrase, so run them in a terminal. Each entry gets a new ID.
`change-passphrase` encrypts `master.enc.key` and `admin.enc.key` with a new passphrase. It
needs the old passphrase. Each command copies the files into `.local_assets/` of this folder first.

A clone that is unenrolled keeps the secret values from before the rotation, and git history
keeps old vault files. Change those secrets at the source if necessary.

## Python

Add the `src` folder of this tool to `PYTHONPATH` (`shared/tools/auth/src` from the workspace
root):

```python
from credstore import get_credential
c = get_credential("Github npstash/all 01", vault_home="vaults/vault-main")     # clone key
c = get_credential("jira", home, passphrase=value_the_script_asked_for)  # no clone key
c.url, c.authority_info, c.secrets()["token"]   # secrets() is an immutable map
```

Each call writes a line into `access.log`: the entry ID, the secrets, the key
(`clone-key:<name>:<plain|provider>`) and the file name of the calling script.

Tests: `run.sh test`. The hook tests need `sh` and `awk`.

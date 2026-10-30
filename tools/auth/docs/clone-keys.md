# Clone keys — design

Status: implemented in [credstore.py](../src/credstore.py). Decisions: [ADL.md](../ADL.md), entries from `20261019-01`.

Each clone opens the vault with its own key pair. Do not copy the master key to a clone.

## Terms

| Term | Meaning |
| --- | --- |
| clone | One working copy of a repository that uses the vault. A cloud session that enrols is a different clone. |
| recipient | A clone that has a key pair for a vault. Its recipient name identifies it. |
| master key | The key that encrypts `credentials.enc`. |
| passphrase | The secret that encrypts `master.enc.key`. |
| key passphrase | A random secret that encrypts one `clone.<name>.key`. |
| provider | A store for key passphrases, e.g. the OS keyring. |
| vault home | The folder of the vault files, e.g. `vaults/vault-main`. |
| TTY | An interactive terminal on stdin. |

## Files in the vault home

| File | Committed | Contents |
| --- | --- | --- |
| `credentials.json` | yes | As before. Secret values are cleared. |
| `credentials.enc` | yes | As before. Encrypted with the master key. |
| `master.enc.key` | yes | As before: the master key, encrypted with the passphrase. |
| `recipients/<name>.pub` | yes | RSA-3072 public key of the recipient `<name>`. |
| `recipients/<name>.master.enc` | yes | The master key, encrypted for `<name>` with RSA-OAEP and SHA-256. |
| `recipients/<name>.inf` | yes | Information about the clone of `<name>`. See "Clone information". |
| `clone.<name>.key` | no | Private key of the recipient `<name>`. PEM, mode 600. Plain, or encrypted with a key passphrase. |
| `access.log` | no | The access log. |

- Remove `master.key`. Remove each instruction about `master.key` from the README.
- The gitignore of the vault home contains `clone.*.key` and `access.log`. `enrol` and the first
  log line add them if they are missing.
- The pre-commit hook stops a commit of `clone.*.key`, `access.log` and `master.key`.
- An approved recipient has `<name>.pub` and `<name>.master.enc`. A request has only `<name>.pub`.
  Both can also have `<name>.inf`. `unenrol` deletes it with the other two files.

## Key files

- The private key is always a file on the disk. A provider holds only the key passphrase.
- A plain key file is a PKCS#8 PEM. It has no other lines.
- An encrypted key file is an encrypted PKCS#8 PEM. Its first line is `credstore-provider: <provider>`.
  The tool removes this line before it reads the key.
- A key passphrase is 256 random bits, in base64.
- The tool sets mode 600 on each key file.
- In WSL, a `/mnt/<drive>` mount without the drvfs option `metadata` ignores the mode. Then the
  tool shows a warning with this fix:

  ```ini
  # /etc/wsl.conf
  [automount]
  options = "metadata"
  ```

  Then run `wsl --shutdown` in Windows, and start WSL again.
- On Windows, the tool sets no ACL.

## Recipient names

- Each clone has a unique recipient name.
- One clone can have more than one key pair, e.g. one for Windows and one for WSL in the same folder.
- `enrol` without a name generates one. Thus a cloud session can enrol without user input.

### Generated names

Form: `auto-<computer>-<user>-<repo>-<yyyymmdd>[-<N>]`, e.g. `auto-razer18-nestor-personal_worksp-20261027`.

- `<computer>`, `<user>` and `<repo>` are the identification fields. They come from the clone
  information. `<repo>` is the last part of the repository URL, without `.git`.
- Each field is in lowercase and keeps only `a-z`, `0-9`, `.` and `_`. Skip an empty field.
- The identification fields and the `-` between them have a maximum of `ID_LIMIT` (30)
  characters. `auto-`, the date and `-<N>` do not count.
- If they are too long, cut the longest fields first. Short fields stay complete.
- `<yyyymmdd>` is the UTC date.
- If the name has a `.pub` or a key file in the vault home, add `-2`, then `-3` and so on.

## Clone information

`enrol` writes `recipients/<name>.inf` beside the `.pub`. The approver reads it to identify the
clone. Each `enrol` writes the file again. The format is INI with one section `[clone]`.

| Key | Value |
| --- | --- |
| `name` | The recipient name. |
| `created` | UTC time of the `enrol`. |
| `fingerprint` | The fingerprint of the public key. See "Approval of a request". |
| `computer` | The host name. |
| `user` | The OS user name. The tool reads no environment variable for it. |
| `os`, `os_release`, `os_version`, `machine`, `platform` | `uname` and the platform string. |
| `distro`, `distro_id`, `distro_version` | Linux only: the distribution from `/etc/os-release`. |
| `wsl` | `WSL1` or `WSL2`, only if the tool detects WSL. |
| `ip_addresses` | The addresses of the outbound routes and of the host name. No loopback, no link-local. |
| `clone_path` | The working tree of the root repository. |
| `repository` | The URL of `origin` of the root repository, else of its first remote. The tool removes user names and tokens from it. |

- The root repository is the top superproject of the vault home. If the vault home is not a
  submodule, it is the root repository.
- The tool writes no key with an empty value, e.g. without git.
- The `.inf` comes with the `.pub` in the same push. Thus it does not prove the identity of
  the clone. Compare the fingerprint through another channel.

## The passphrase

- The CLI reads the passphrase only from stdin, and only if stdin is a TTY. It never reads it from a pipe.
- The CLI has no `--passphrase` option. The tool reads no environment variables.
  `CREDSTORE_PASSPHRASE` is removed.
- An agent shell has no TTY. Thus an agent cannot give the passphrase to the CLI.
- Exception: the Python API accepts `passphrase=`. A script can read the passphrase itself and
  give it to the API.
- The passphrase decrypts only `master.enc.key`.

## Opening the vault

1. Find each `clone.<name>.key` in the vault home that has a
   `recipients/<name>.master.enc` there.
2. For a plain key file, use the key.
3. For an encrypted key file, get the key passphrase from the provider in the first line. If
   the provider has no entry, skip the key.
4. Use the first key that decrypts its wrapped master key.
5. If no key opens the vault, use the passphrase: the `passphrase=` parameter of the API,
   or the TTY prompt of the CLI.
6. If there is no passphrase, stop. The error names `enrol` and the skipped keys.

- If a clone key opens the vault, the tool does not use a passphrase given to the API to open it.
- Write each failed open into the access log as `open-failed`.

## Selecting a vault

The API needs the parameter `vault_home`. The CLI has `--vault-home`. Without it, the CLI
finds `vault-main` with the rule submodule-dependencies. To limit the secrets of a
clone, use a separate vault, e.g. `vaults/vault-<project>`.

## Commands

| Command | Needs | Effect |
| --- | --- | --- |
| `create-vault` | new passphrase (TTY, typed twice) | Makes a new master key, `master.enc.key` and vault. |
| `enrol [NAME]` | passphrase (TTY), optional | Makes a key pair for this clone. See "Enrolment". |
| `approve-enrol NAME` | clone key | Writes the wrapped master key for `recipients/NAME.pub`. Prints the fingerprint: `SHA256:` and the base64 SHA-256 of the DER public key. |
| `unenrol [NAME]` | nothing | Deletes the files of `NAME` in `recipients/`. Without `NAME`: the recipient of this clone. See "Unenrolment". |
| `delete-private-clone-key [NAME]` | nothing | Deletes `clone.NAME.key` and its key passphrase. Without `NAME`: the one key file of this clone. |
| `rotate-master-key` | clone key or passphrase to open; passphrase (TTY) to write | Makes a new master key. Wraps it for each approved recipient and with the passphrase. |
| `unenrol-and-rotate-master-key NAME` | as `rotate-master-key` | Deletes the files of `NAME` in `recipients/`, then rotates the master key. |
| `change-passphrase` | clone key or old passphrase (TTY); new passphrase (TTY, typed twice) | Encrypts `master.enc.key` with the new passphrase. |
| `list-keyring-secrets` | nothing | Lists the key passphrases of this tool in each available provider: provider and name. |
| `delete-keyring-secret NAME ...` | nothing | Deletes these key passphrases from the providers, and the key files of this clone that they open. |
| `delete-all-keyring-secrets` | nothing | Deletes each key passphrase of this tool from the providers, and the key files of this clone that they open. |
| `sync`, `list` | as before | As before. |
| `get-system NAME` | as `sync` | Prints the url, the secret names and the authority info. No values, no log line. |
| `get-secret NAME KEY` | as `sync` | Prints one secret value. Logs only that secret. |
| `set-system`, `rename-system`, `rename-secret` | as `sync` | Change a system or a secret name. |

- `get-secret` stays in the CLI.
- An option does not change what a command does. A different behaviour is a different command.
- The Python API has the same names, e.g. `Store.approve_enrol()` and `Store.unenrol()`.
- A command that needs the passphrase works only in a terminal of the user, or through the
  `passphrase=` parameter of the API.
- `unenrol-and-rotate-master-key` always rotates the master key. Thus it needs the passphrase.
- `unenrol` does not rotate. Thus it needs no passphrase, and each clone can run it.
- `rotate-master-key` and `unenrol-and-rotate-master-key` change the approved recipients only.
  A request stays a request.
- `change-passphrase` gets the master key from a clone key or from the old passphrase.
- After `enrol`, `approve-enrol`, `unenrol`, `rotate-master-key` and
  `unenrol-and-rotate-master-key`, commit and push the vault home.

## Enrolment

### With a TTY

1. `enrol` lists the entries of this tool in each available provider.
2. For each entry, it asks if the entry is to be deleted. It deletes each entry that the user
   selects, and the matching key file of this clone. That key file cannot open any more.
3. It makes the key pair and writes `recipients/<name>.pub` and `recipients/<name>.inf`.
4. If a provider is available, it asks if the key passphrase goes into it.
   - Yes: it writes an encrypted key file and the provider entry.
   - No: it writes a plain key file.
5. If the vault opens in this clone, it writes `recipients/<name>.master.enc`
   (self-enrolment). It tries the clone keys first, then asks for the passphrase. If the user
   gives no passphrase, the result is a request.
6. It prints the name and the fingerprint of the public key.

If `clone.<name>.key` exists in the vault home, `enrol` uses it and makes no new key pair.

### Without a TTY

1. `enrol` makes the key pair and writes `recipients/<name>.pub` and `recipients/<name>.inf`.
2. It uses the first available provider: encrypted key file and provider entry. If no provider
   is available, it writes a plain key file.
3. If a clone key opens the vault, it writes `recipients/<name>.master.enc`. Else the result
   is a request.
4. It prints the name and the fingerprint.

### Approval of a request

1. The new clone commits and pushes `recipients/<name>.pub` and `recipients/<name>.inf`.
2. A trusted clone pulls, then runs `approve-enrol <name>`. It prints the `.inf` and the
   fingerprint. Compare the fingerprint with the fingerprint from `enrol`.
3. The trusted clone commits and pushes `recipients/<name>.master.enc`.
4. The new clone pulls. Then the vault opens.

## Unenrolment

`unenrol` removes a recipient without a new master key. Each clone can unenrol itself or another
recipient. A clone that can push to the vault home can also delete the files with git.

1. `unenrol [NAME]` deletes `recipients/<name>.pub`, `.master.enc` and `.inf`. It works for an
   approved recipient and for a request. Without `NAME`, it uses the recipient of the one
   `clone.<name>.key` in the vault home. If there are more key files, give the name.
2. Commit and push the vault home. Git uses its own credentials, not the vault.
3. `delete-private-clone-key [NAME]` deletes `clone.<name>.key` and its key passphrase in the
   provider. It refuses while `recipients/<name>.pub` or `.master.enc` exists in the vault home,
   or in the upstream branch of the vault home.

- If the push fails, restore the files with `git restore recipients/`. The private key still
  opens the vault.
- `unenrol` does not lock a clone out. The clone knows the current master key, and git history
  keeps its `<name>.master.enc`. To lock a clone out, use `unenrol-and-rotate-master-key`.

## Providers

A provider stores key passphrases by recipient name. Each provider has these operations:

| Operation | Effect |
| --- | --- |
| available | Tells if the provider can be used on this machine now. |
| get NAME | Gives the key passphrase of `NAME`, or nothing. |
| set NAME VALUE | Stores the key passphrase of `NAME`. |
| delete NAME | Deletes the key passphrase of `NAME`. |
| list | Gives all names of this tool. |

- The tool tries providers in a fixed sequence. Now there is one provider: `keyring`.
- A key file names its provider. Thus the tool asks only that provider for that key.
- Later providers can be network services. A new provider is a new implementation of the
  operations. Nothing else changes.

### The keyring provider

- It uses the `keyring` package.
- Available: a backend that is not a fail backend and not a plaintext backend. Windows
  Credential Manager and Secret Service (gnome-keyring, KWallet) are available backends.
- Entry: service `credstore`, user `<name>`.
- `list` searches each backend directly, because the `keyring` package cannot list entries:
  - Secret Service: search the items with the attribute `service` = `credstore`.
  - Windows Credential Manager: enumerate the credentials whose target starts with `credstore`.
- The rules credentials-from-vault and nothing-outside-repo get one exception: the key
  passphrases of this tool in the OS keyring.

| Platform | Behaviour |
| --- | --- |
| Native Ubuntu desktop | The keyring is open after login. No prompt for each read. |
| Ubuntu over SSH or headless | Usually locked or absent. The key file is plain. |
| WSL | No Secret Service by default. The key file is plain. |
| Windows | Credential Manager. No prompt. |
| Cloud | No keyring. The key file is plain. |

## Access log

`access.log` is in the vault home. It is gitignored. Its first
line is the header. Write one tab-separated line for each event:

```
time	event	vault	system	secrets	method	caller
<UTC time>	<event>	<vault>	"<system>"	<secrets>	<method>	"<caller>"
```

- The tool adds the header to a new log, and to a log from before the header.
- Tabs, line breaks and quotes in a value become spaces.

| Field | Values |
| --- | --- |
| UTC time | ISO 8601. |
| event | `get`, `enrol`, `approve-enrol`, `unenrol`, `delete-private-clone-key`, `unenrol-and-rotate-master-key`, `rotate-master-key`, `change-passphrase`, `delete-keyring-secret`, `open-failed`. Logs from before 2026-10-29 also have `approve`, `revoke`, `rotate-key` and `key-remove`. |
| vault | Always `main`. The column stays for the format of existing logs. |
| system | The system name in quotes, or `""`. For the events about recipients and keys: the recipient name. |
| secrets | The names of the secrets given out, separated by commas, or empty. |
| method | `passphrase`, or `clone-key:<name>:<plain\|provider>`: the key of `<name>`. |
| caller | A file name in quotes. No path, arguments or function. |

The method identifies the key. One name is one key. A new key with the same name comes after
an `unenrol` and an `enrol` line. The log shows no key IDs.

Example:

```
time	event	vault	system	secrets	method	caller
2026-10-19T18:30:02Z	enrol	main	"laptop"			"bash"
2026-10-19T18:30:04Z	approve-enrol	main	"laptop"		passphrase	"bash"
2026-10-19T18:30:06Z	get	main	"jira"	password	clone-key:laptop:keyring	"sync.py"
2026-10-19T18:33:00Z	delete-keyring-secret	main	"laptop"		keyring	"bash"
2026-10-19T18:34:00Z	open-failed	main	""			"bash"
```

The tool finds the caller itself. The API has no caller parameter.

- API: the file of the first stack frame outside `credstore`.
- CLI on Linux: the script of the parent process, from `/proc`. If it is not a script, its executable.
- CLI on Windows: no parent process. The file name of `sys.argv[0]`.

The log of a cloud clone is lost with the clone.

## Cloud clones

- A cloud clone enrols like a local clone. No environment variable is used.
- Cowork cloud has no terminal. Thus its clone cannot self-enrol:
  1. The `credentials` skill runs `enrol` with no name. It commits and pushes the request.
  2. A trusted clone runs `approve-enrol`, then commits and pushes.
  3. The cloud clone pulls.
- Later, an agent with a trusted clone can do step 2 automatically. That agent is not part of
  this design.
- A persistent Cowork session keeps its key file.
- A clone that a schedule makes again needs a new enrolment.
- A cloud clone unenrols itself at the end of its work: `unenrol` in each vault,
  commit and push, then `delete-private-clone-key`. See "Unenrolment".

## Skills

### credentials

- It runs only commands that need no passphrase: `enrol` (request), `approve-enrol`,
  `unenrol`, `delete-private-clone-key`, `sync`, `list`, `get-system`,
  `set-system`, `rename-system`, `rename-secret`, `list-keyring-secrets`,
  `delete-keyring-secret` and `delete-all-keyring-secrets`.
- For `create-vault`, self-enrolment, `rotate-master-key`, `unenrol-and-rotate-master-key` and
  `change-passphrase`, it tells the user the command to run in a terminal.
- It explains how a script gets secrets through the API.
- It does not use `CREDSTORE_PASSPHRASE`.

## Users of the vault

- `expenses` and `voice_code` open the vault only with clone keys.
- Remove their `--passphrase` options and their `master.key` instructions.
- Enrol each clone and each machine.

## Migration

- There is no migration command.
- After the change, run `rotate-master-key` once in a terminal. Copies of `master.key` exist on many
  clones, and the rotation makes them unusable.
- Old versions of `credentials.enc` stay in git history. An old `master.key` opens them. Change
  those secrets at the source if necessary.

## Limits

- A process of the same user can read a plain key file, and can read the keyring.
- `get-secret` in the CLI and the rule against secrets in a transcript prevent accidents. They do not
  stop an agent that writes a script.
- A revoked clone keeps each secret value from before the revocation. Change those secrets at
  the source if necessary.
- In a cloud clone, the agent can always read what opens the vault. Use a separate vault to
  limit the secrets of a cloud clone.

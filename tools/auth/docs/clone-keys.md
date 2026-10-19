# Clone keys — design

Status: implemented in [credstore.py](../src/credstore.py). Decisions: [ADL.md](../ADL.md), entries from `20261019-170505-00`.

Each clone opens the vault with its own key pair. Do not copy the master key to a clone.

## Terms

| Term | Meaning |
| --- | --- |
| clone | One working copy of a repository that uses the vault. A cloud session that enrols is a different clone. |
| recipient | A clone that has a key pair for a vault. Its recipient name identifies it. |
| master key | The key that encrypts `credentials.enc`. Each vault has one. |
| passphrase | The secret that encrypts `master.enc.key` of the main vault. |
| key passphrase | A random secret that encrypts one `clone.<name>.key`. |
| provider | A store for key passphrases, e.g. the OS keyring. |
| main vault | The vault in the vault home. |
| sub-vault | A smaller vault in `subvaults/<vault>/` of the vault home. |
| TTY | An interactive terminal on stdin. |

## Files in the vault home

| File | Committed | Contents |
| --- | --- | --- |
| `credentials.json` | yes | As before. Secret values are cleared. |
| `credentials.enc` | yes | As before. Encrypted with the master key. |
| `master.enc.key` | yes | As before: the master key, encrypted with the passphrase. |
| `recipients/<name>.pub` | yes | RSA-3072 public key of the recipient `<name>`. |
| `recipients/<name>.master.enc` | yes | The master key, encrypted for `<name>` with RSA-OAEP and SHA-256. |
| `clone.<name>.key` | no | Private key of the recipient `<name>` of the main vault. PEM, mode 600. Plain, or encrypted with a key passphrase. |
| `access.log` | no | The access log. |
| `subvaults/<vault>/` | yes | A sub-vault. Its key files `clone.<name>.key` are in this folder and are not committed. |

- Remove `master.key`. Remove each instruction about `master.key` from the README.
- The gitignore of the vault home contains `clone.*.key` and `access.log`. These patterns also
  match in the sub-vault folders. `enrol` and the first log line add them if they are missing.
- The pre-commit hook stops a commit of `clone.*.key`, `access.log` and `master.key`.
- Each vault keeps the key files of its recipients in its own folder. See "One name in more vaults".
- An approved recipient has `<name>.pub` and `<name>.master.enc`. A request has only `<name>.pub`.

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
- `enrol` without a name generates one: `auto-<yyyymmdd>-<8 hex digits>`. Thus a cloud session
  can enrol without user input.

## One name in more vaults

One recipient name can be in the main vault and in each sub-vault. Each vault has its own key
pair for that name.

| Vault | Key file | Public key |
| --- | --- | --- |
| main | `vault-home/clone.<name>.key` | `vault-home/recipients/<name>.pub` |
| sub-vault V | `vault-home/subvaults/V/clone.<name>.key` | `vault-home/subvaults/V/recipients/<name>.pub` |

- A recipient is a vault and a name. Commands that take `NAME` act on the selected vault only.
- A key file opens only its own vault. A wrapped master key is encrypted for the `.pub` beside it.
- In one vault, one name is one key. `enrol` refuses a name whose `.pub` in the target vault
  belongs to another clone. Two branches that add the same name to the same vault give a git conflict.
- The vault column and the method of the access log tell the keys apart. See "Access log".

## The passphrase

- The CLI reads the passphrase only from stdin, and only if stdin is a TTY. It never reads it from a pipe.
- The CLI has no `--passphrase` option. The tool reads no environment variables.
  `CREDSTORE_PASSPHRASE` is removed.
- An agent shell has no TTY. Thus an agent cannot give the passphrase to the CLI.
- Exception: the Python API accepts `passphrase=`. A script can read the passphrase itself and
  give it to the API.
- The passphrase decrypts only `master.enc.key` of the main vault.

## Opening a vault

1. Find each `clone.<name>.key` in the folder of the selected vault that has a
   `recipients/<name>.master.enc` there.
2. For a plain key file, use the key.
3. For an encrypted key file, get the key passphrase from the provider in the first line. If
   the provider has no entry, skip the key.
4. Use the first key that decrypts its wrapped master key.
5. If no key opens a sub-vault, open the main vault, then decrypt `main.master.enc` of the sub-vault.
6. If no key opens the main vault, use the passphrase: the `passphrase=` parameter of the API,
   or the TTY prompt of the CLI. Only the main vault has a passphrase.
7. If there is no passphrase, stop. The error names `enrol` and the skipped keys.

- If a clone key opens the vault, the tool does not use a passphrase given to the API to open it.
- Write each failed open into the access log as `open-failed`.

## Selecting a vault

The API has the parameters `vault_home` and `subvault`. The CLI has `--vault-home` and `--subvault`.

| `vault_home` | `subvault` | Vault |
| --- | --- | --- |
| no | no | The main vault at the default location. |
| path | no | The main vault at that path. |
| no | name | `subvaults/<name>` of the main vault at the default location. |
| path | name | `<path>/subvaults/<name>`. |

The default location is as before: `./vault-home`, then `vault-home` next to the tool.

## Commands

| Command | Needs | Effect |
| --- | --- | --- |
| `init` | new passphrase (TTY, typed twice) | Makes a new master key, `master.enc.key` and vault. |
| `enrol [NAME] [--subvault V]` | passphrase (TTY), optional | Makes a key pair for this clone. See "Enrolment". |
| `approve NAME [--subvault V]` | clone key | Writes the wrapped master key for `recipients/NAME.pub`. Prints the fingerprint: `SHA256:` and the base64 SHA-256 of the DER public key. |
| `rotate-key [--subvault V]` | main vault: clone key or passphrase to open; passphrase (TTY) to write. Sub-vault: the main vault | Makes a new master key. Wraps it for each approved recipient and, for the main vault, with the passphrase. Rebuilds each sub-vault. |
| `revoke NAME [--subvault V]` | as `rotate-key` | Deletes the files of `NAME` in `recipients/`, then rotates the master key. |
| `change-passphrase` | clone key or old passphrase (TTY); new passphrase (TTY, typed twice) | Encrypts `master.enc.key` with the new passphrase. |
| `create-vault V [--system S ...]` | the main vault | Makes `subvaults/V`. See "Sub-vaults". |
| `key-list` | nothing | Lists the key passphrases of this tool in each available provider: provider and entry. |
| `key-remove ENTRY ... \| --all` | nothing | Deletes key passphrases of this tool from the providers, and the key files of this clone that they open. |
| `sync` | as before | Also rebuilds sub-vaults. See "Sub-vaults". |
| `list`, `get`, `set`, `rename` | as before | Accept `--subvault V`. |

- `get` stays in the CLI.
- A command that needs the passphrase works only in a terminal of the user, or through the
  `passphrase=` parameter of the API.
- `revoke` always rotates the master key. Thus, for the main vault, it needs the passphrase.
- `rotate-key` and `revoke` change the approved recipients only. A request stays a request.
- `change-passphrase` gets the master key from a clone key or from the old passphrase.
- After `enrol`, `approve`, `rotate-key`, `revoke` and `create-vault`, commit and push the vault home.

## Enrolment

### With a TTY

1. `enrol` lists the entries of this tool in each available provider.
2. For each entry, it asks if the entry is to be deleted. It deletes each entry that the user
   selects, and the matching key file of this clone. That key file cannot open any more.
3. It makes the key pair and writes `recipients/<name>.pub`.
4. If a provider is available, it asks if the key passphrase goes into it.
   - Yes: it writes an encrypted key file and the provider entry.
   - No: it writes a plain key file.
5. If the vault opens in this clone, it writes `recipients/<name>.master.enc`
   (self-enrolment). It tries the clone keys first, then asks for the passphrase. If the user
   gives no passphrase, the result is a request.
6. It prints the name and the fingerprint of the public key.

If `clone.<name>.key` exists in the folder of the vault, `enrol` uses it and makes no new key
pair. In another vault, the same name gets a new key pair.

### Without a TTY

1. `enrol` makes the key pair and writes `recipients/<name>.pub`.
2. It uses the first available provider: encrypted key file and provider entry. If no provider
   is available, it writes a plain key file.
3. If a clone key opens the vault, it writes `recipients/<name>.master.enc`. Else the result
   is a request.
4. It prints the name and the fingerprint.

### Approval of a request

1. The new clone commits and pushes `recipients/<name>.pub`.
2. A trusted clone pulls, then runs `approve <name>`. It prints the fingerprint. Compare it
   with the fingerprint from `enrol`.
3. The trusted clone commits and pushes `recipients/<name>.master.enc`.
4. The new clone pulls. Then the vault opens.

## Providers

A provider stores key passphrases by entry. The entry of a key is `<name>` in the main vault,
and `<sub-vault>/<name>` in a sub-vault. Each provider has these operations:

| Operation | Effect |
| --- | --- |
| available | Tells if the provider can be used on this machine now. |
| get ENTRY | Gives the key passphrase of `ENTRY`, or nothing. |
| set ENTRY VALUE | Stores the key passphrase of `ENTRY`. |
| delete ENTRY | Deletes the key passphrase of `ENTRY`. |
| list | Gives all entries of this tool. |

- The tool tries providers in a fixed sequence. Now there is one provider: `keyring`.
- A key file names its provider. Thus the tool asks only that provider for that key.
- Later providers can be network services. A new provider is a new implementation of the
  operations. Nothing else changes.

### The keyring provider

- It uses the `keyring` package.
- Available: a backend that is not a fail backend and not a plaintext backend. Windows
  Credential Manager and Secret Service (gnome-keyring, KWallet) are available backends.
- Entry: service `credstore`, user `<name>` or `<sub-vault>/<name>`.
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

## Sub-vaults

A sub-vault holds selected secrets, e.g. for the cloud clones of one project.

- Location: `vault-home/subvaults/<vault>/`, with `credentials.json`, `credentials.enc`,
  `recipients/`, `main.master.enc`, `source.hmac`, and the key files of its recipients.
- It has its own master key and recipients. It has no passphrase and no `master.enc.key`.
- `main.master.enc` is its master key, encrypted with the main master key. Thus each clone
  that opens the main vault also opens each sub-vault, and keeps the own values in a rebuild.
- Its recovery is a rebuild from the main vault.
- Its `credentials.json` lists its systems.
  - A system that is also in the main vault gets its values from the main vault through `sync`.
  - Another system keeps its own values. Set them with `set --subvault V`.
  - An alias (`alias_of`) needs its target in the same sub-vault.
- `create-vault V` makes a blank sub-vault, or one with selected systems of the main vault.
  It enrols no clone. It needs the main vault.
- To enrol a clone into a sub-vault: `enrol --subvault V`, then `approve NAME --subvault V`.
  This makes a key pair for the sub-vault, also if the clone has the same name in the main vault.

### Rebuild through sync

1. `sync` runs in a clone that opens the main vault. In another clone, it does not rebuild
   sub-vaults: `sync --subvault V` there mirrors the index and keeps the copied values.
2. For each sub-vault, it calculates an HMAC-SHA256 with the main master key. The input is the
   values that come from the main vault and the file names in `recipients/` of the sub-vault.
3. If the result is different from `source.hmac`, it rebuilds the sub-vault:
   - it copies the systems from the main vault and keeps the own systems of the sub-vault,
   - it makes a new master key,
   - it wraps that key for each approved recipient, and deletes the wrapped keys of deleted recipients,
   - it writes `main.master.enc` and the new `source.hmac`.
4. If a sub-vault fails, `sync` of the main vault shows a warning and continues.

`rotate-key` of the main vault rebuilds each sub-vault, because the main master key changes.

### Revoking from a sub-vault

Run `revoke <name> --subvault V`. Or delete `recipients/<name>.pub` of the sub-vault, then
run `sync`. Both need no passphrase.

Each sub-vault step needs only a clone key.

## Access log

`access.log` is in the main vault home, also for a sub-vault. It is gitignored. Its first
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
| event | `get`, `enrol`, `approve`, `revoke`, `rotate-key`, `change-passphrase`, `key-remove`, `open-failed`. |
| vault | `main`, or the sub-vault name. |
| system | The system name in quotes, or `""`. For `enrol`, `approve`, `revoke` and `key-remove`: the recipient name. |
| secrets | The names of the secrets given out, separated by commas, or empty. |
| method | `passphrase`, or `clone-key:<name>:<plain\|provider>`: the key of `<name>` in the vault of the line. For a sub-vault that the main vault opens: `main:` and the method of the main vault. |
| caller | A file name in quotes. No path, arguments or function. |

The vault column and the method identify the key. In one vault, one name is one key. A new
key with the same name comes after a `revoke` and an `enrol` line. The log shows no key IDs.

Example:

```
time	event	vault	system	secrets	method	caller
2026-10-19T18:30:02Z	enrol	main	"laptop"			"bash"
2026-10-19T18:30:04Z	approve	main	"laptop"		passphrase	"bash"
2026-10-19T18:30:06Z	get	main	"jira"	password	clone-key:laptop:keyring	"sync.py"
2026-10-19T18:31:00Z	enrol	proj	"laptop"		main:clone-key:laptop:keyring	"bash"
2026-10-19T18:31:10Z	get	proj	"jira"	password	clone-key:laptop:plain	"sync.py"
2026-10-19T18:32:00Z	get	proj	"jira"	password	main:clone-key:laptop:keyring	"report.py"
2026-10-19T18:33:00Z	key-remove	proj	"laptop"		keyring	"bash"
2026-10-19T18:34:00Z	open-failed	main	""			"bash"
```

- Line 4: the key `laptop` of the main vault.
- Lines 5 and 7: the key `laptop` of the main vault opens the sub-vault `proj` through the main vault.
- Line 6: the key `laptop` of the sub-vault `proj`.

The tool finds the caller itself. The API has no caller parameter.

- API: the file of the first stack frame outside `credstore`.
- CLI on Linux: the script of the parent process, from `/proc`. If it is not a script, its executable.
- CLI on Windows: no parent process. The file name of `sys.argv[0]`.

The log of a cloud clone is lost with the clone.

## Cloud clones

- A cloud clone enrols like a local clone. No environment variable is used.
- Cowork cloud has no terminal. Thus its clone cannot self-enrol:
  1. The `credentials` skill runs `enrol` with no name. It commits and pushes the request.
  2. A trusted clone runs `approve`, then commits and pushes.
  3. The cloud clone pulls.
- Later, an agent with a trusted clone can do step 2 automatically. That agent is not part of
  this design.
- A persistent Cowork session keeps its key file.
- A clone that a schedule makes again needs a new enrolment.
- Remove old recipients with `revoke`, one at a time, in a terminal.

## Skills

### credentials

- It runs only commands that need no passphrase: `enrol` (request), `approve`, `sync`, `list`,
  `get`, `set`, `rename`, `key-list`, `key-remove` and the sub-vault steps.
- For `init`, self-enrolment, `rotate-key`, `revoke` and `change-passphrase`, it tells the user
  the command to run in a terminal.
- It explains how a script gets secrets through the API.
- It does not use `CREDSTORE_PASSPHRASE`.

### create-vault

New skill in `shared/skills/create-vault/`. It makes and fills a sub-vault.

## Users of the vault

- `expenses` and `voice_code` open the vault only with clone keys.
- Remove their `--passphrase` options and their `master.key` instructions.
- Enrol each clone and each machine.

## Migration

- There is no migration command.
- After the change, run `rotate-key` once in a terminal. Copies of `master.key` exist on many
  clones, and the rotation makes them unusable.
- Old versions of `credentials.enc` stay in git history. An old `master.key` opens them. Change
  those secrets at the source if necessary.

## Limits

- A process of the same user can read a plain key file, and can read the keyring.
- `get` in the CLI and the rule against secrets in a transcript prevent accidents. They do not
  stop an agent that writes a script.
- A revoked clone keeps each secret value from before the revocation. Change those secrets at
  the source if necessary.
- In a cloud clone, the agent can always read what opens the vault. Use a sub-vault to limit
  the secrets of a cloud clone.

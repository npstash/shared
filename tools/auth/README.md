# tools/auth — credential vault

Requirements and design decisions: [request.md](request.md). Everything lives in [credstore.py](credstore.py).

The vault files are not in this folder. They are in the **vault home**, a separate git
repository (usually the `private-data` submodule of the repository that uses the vault).

| File in the vault home | Contents |
| --- | --- |
| `credentials.json` | Source of truth: system → `url`, `authority_info`, `credentials`. Secret values are always cleared. |
| `credentials.enc` | Vault: the same document with secret values, encrypted with the master key in the `openssl enc -aes-256-cbc -pbkdf2` format. |
| `master.enc.key` | The master key (256 random bits, base64), encrypted with the master passphrase. |
| `master.key` | Optional: the master key, decrypted by the user. Gitignored. |
| `.githooks/pre-commit` | Stops a commit of `credentials.json` with secret values. Needs only `sh` and `awk`. |
| `setup.sh`, `setup.bat` | Turn the hook on in a clone: `git config core.hooksPath .githooks`. |

## Finding the vault home

1. `--vault-home DIR` (CLI) or `vault_home=` (Python), if given.
2. Else `./private-data` in the working directory.
3. Else `private-data` in this folder.

If none exists, the tool stops and asks for `--vault-home`.

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
systems and secrets exist — deleting an entry there deletes it from the vault, and a
missing file empties the vault. A blank secret keeps the stored value; a blank secret the
vault knows nothing about is an error, so `list` never advertises an empty secret. Commands
read `credentials.json` first and decrypt only when values are needed. Files are rewritten
only when their content changes. Use `rename` instead of editing a name in place.

```bash
run.sh init                                  # new vault in ./private-data (or --vault-home)
run.sh sync
run.sh list                                  # name, url, secret names — no passphrase
run.sh get NAME [--secret KEY]
run.sh set NAME [--url U] [--info LINE ...] [--secret KEY=VALUE ...]
run.sh rename NAME NEW | rename NAME --secret OLD=NEW
run.sh rotate-key                            # new master key, same passphrase
run.sh change-passphrase                     # new passphrase, same master key
run.sh --passphrase VALUE ...                # master passphrase (see below)
run.sh --vault-home DIR ...                  # the vault home (see above)
```

## A new vault

`init` asks for a new passphrase (typed twice) and writes the master key, an example
`credentials.json` and the files in [templates/](templates/). It stops if a vault exists
already. The example entry has blank secrets, so `sync` fails until you fill them in or
remove the entry. Then make the folder a git repository and run its `setup.sh` once for
each clone, to turn the hook on.

## Rotating

`rotate-key` decrypts the vault with the old master key, generates a new one and
re-encrypts the vault under it, keeping the passphrase. `change-passphrase` re-encrypts the
master key under a new passphrase (typed twice) and touches neither the key nor the vault.
Run both, in either order, for a new key *and* a new passphrase. Each copies the key and
the vault into `.local_assets/` of this folder first.

## Opening the vault

Two ways, and only two. The tool never reads environment variables.

1. **Pass the passphrase:** `--passphrase VALUE` on the CLI, `Store(passphrase=...)` in
   Python. Note that a command-line value is visible in the process list and your shell
   history.
2. **Decrypt the master key once** and keep it locally (openssl asks for the passphrase,
   so it stays out of your shell history):

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -in private-data/master.enc.key -out private-data/master.key
chmod 600 private-data/master.key
```

`master.key` is gitignored and must never be committed: it opens the vault on its
own, with no passphrase. If a passphrase is passed *as well*, the tool stops instead of
choosing between them - drop `--passphrase`, or delete the decrypted key. After
`rotate-key` the file is stale, so delete it and decrypt again.

## Reading the vault without this tool

The vault is a plain `openssl enc` file, so the decrypted master key opens it in one
command - useful when Python, the venv or this script are not available:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -in private-data/credentials.enc -pass file:private-data/master.key
```

It prints the whole document, secrets included. Both commands rely on openssl's default
`-pbkdf2` work factor (10000 iterations, HMAC-SHA256); `credstore.py` derives the key and
IV the same way, so files written by either side are readable by the other. The format is
AES-256-CBC without a MAC: a wrong key or a damaged file shows up as a padding or JSON
error, not as a cryptographic integrity failure.

With neither, every command that needs a secret fails with a message naming both routes.
`list` still works: it only reads `credentials.json`.

```python
sys.path.insert(0, "shared/tools/auth")
from credstore import get_credential, list_systems
c = get_credential("Github npstash/all 01", vault_home="private-data")
c.url, c.authority_info, c.secrets()["token"]   # secrets() is an immutable map
```

`rotate-key` needs `--passphrase` (it protects the new master key with it);
`change-passphrase` asks for the new one at a prompt, twice.
Tests: `run.sh test`. The hook tests need `sh` and `awk`.

# tools/auth — requirements

Collected from the user's requests.

## Requirements

1. Python module usable from other tools, plus a CLI, in `tools/auth`.
2. `credentials.json` lists systems: url, authority info, and credentials (secrets, including the username). It is committed to git.
3. Once the tool has processed `credentials.json`, its secret values are cleared so it is safe to commit.
4. The same contents are also stored in an encrypted file, committed to git.
5. One symmetric master key, encrypted with the master passphrase and committed. (Superseded requirement: an RSA key pair, public key encrypting - see *Replacing RSA with AES*.)
6. The **whole file is encrypted with the master key**. The encrypted file holds only openssl's `Salted__` header, the salt and ciphertext.
6a. The vault must be readable **by hand with one `openssl` command**, given the decrypted master key file.
7. A git hook blocks commits of `credentials.json` while it holds secrets.
8. Every use of the tool updates the encrypted file and clears secrets from `credentials.json`.
9. The encrypted file is rewritten **only when its contents change**.
10. List the stored systems with their URLs.
11. Rename a system or a secret key without losing stored secrets.
12. No unnecessary commands; the command set follows the `credentials` skill and real usage.
13. Keep it small: as few implementation files as possible, and one test file.
14. New key pair, same master passphrase.
15. Follow the repo rules (see the `AGENTS.md` index).

### The two files mirror each other

16. The vault mirrors `credentials.json` exactly, except that only the vault holds secret values. `credentials.json` is the source of truth; the vault is stale data.
17. Removing a system from `credentials.json` removes it from the vault. If `credentials.json` is missing, the vault is emptied and an empty `credentials.json` is written. (There is no `remove` command.)
18. Every command reads `credentials.json` first, and decrypts only when secret values are needed. `list` therefore needs no passphrase: it reports systems, URLs and secret **names** from the index, not which values are filled.
19. A secret that is blank in `credentials.json` **and** has no value in the vault is an error. Only non-blank secrets are synced into the vault; blank ones keep the stored value. This stops `list` from advertising a secret that holds nothing.
20. If every secret of a system is blank and nothing else changed, the system is not re-synced. If its URL or authority info changed, the vault is updated and the stored secrets are kept.
21. The vault home is a command-line argument (`--vault-home`), never an environment variable. Without it, the tool uses `./vault-home`, then `vault-home` next to the script, and else stops.
22. The Python API hands out secrets as an immutable map from a method (`credential.secrets()`); the credential is a class, not a dictionary.

### Key rotation and local decryption

23. `rotate-key`: new master key on demand, vault decrypted with the old key and re-encrypted with the new one, **same passphrase**.
24. `change-passphrase`: re-encrypt the master key under a new passphrase, typed twice at a prompt. The two commands work separately or together.
25. Two ways to open the vault: the passphrase passed in, or `master.key` that the user decrypts themselves (gitignored, local only). If both are given the tool warns and stops. The README explains the `openssl` command.
26. **The tool never reads environment variables.** The passphrase arrives as a CLI argument (`--passphrase`) or an API parameter (`Store(passphrase=...)`), and there is no prompt for it. Only the `credentials` skill may read `$CREDSTORE_PASSPHRASE`, and it passes the value to the CLI. When neither route is available, the error names both.

## Decisions made without confirmation (you were unavailable; please review)

- **Change check.** Encrypting the same content twice gives different bytes (the salt is random), so the tool compares decrypted contents, not files. `credentials.json` is also rewritten only when it changes.
- **Files.** `src/credstore.py` (API and CLI) and `templates/` here. The vault home holds `master.enc.key`, `credentials.enc`, `credentials.json`, its `.gitattributes` (vault as binary) and the `sh`/`awk` pre-commit hook. `init` writes them.
- **Commands.** `init`, `sync`, `list`, `get [--secret]`, `set`, `rename`, `rotate-key`, `change-passphrase`.
- **Hook.** See "Vault in its own repository" below.
- **Rotation safety.** `rotate-key` and `change-passphrase` copy the key and the vault into `.local_assets/` of the tool folder before writing, because a crash between writing the key and writing the vault would leave the vault unreadable.
- **Setting a passphrase still prompts.** `change-passphrase` (and `init` without `--passphrase`) ask for the new value twice at a terminal prompt, so it never reaches shell history. This is about *setting* a passphrase, not opening the vault.

## Replacing RSA with AES

The RSA key pair bought nothing: every write path already decrypted the vault first
(blank secrets keep their stored value, and the change check compares plaintext), so no
command ever used the public key without the private one. Meanwhile the vault could not be
opened by hand - recovering it meant slicing the file into 512-byte blocks and running
`openssl pkeyutl` on each. The PKCS#8 wrapping of the private key also used only 2048
PBKDF2 iterations, which was the weakest part of the whole scheme.

Decisions, all confirmed by the user:

- **One master key, wrapped with the passphrase.** `master.enc.key` is committed;
  `master.key`, decrypted by the user, is gitignored and opens the vault alone. This
  mirrors the old `private.enc.pem` / `private.pem` pair, so `rotate-key` and
  `change-passphrase` keep their separate meanings.
- **AES-256-CBC without a MAC.** The point of the change is one `openssl enc` command;
  `openssl enc` has no working AEAD mode, and a separate HMAC file would mean a second
  command. Damage surfaces as a padding or JSON error instead. Accepted: the repo is
  private, and the threat model has no attacker with write access to it.
- **openssl's default work factor.** `-pbkdf2` with 10000 iterations, not a hardened
  `-iter`, so the command in the README stays short. Still ~5x the old 2048.
- **The KDF is reimplemented, not shelled out.** `credstore` derives key and IV exactly
  as `openssl enc -pbkdf2` does (PBKDF2-HMAC-SHA256, 48 bytes -> 32-byte key + 16-byte IV),
  so no `openssl` binary is needed at runtime or in CI. A test checks both directions
  against the real binary and skips when it is absent.
- **Migration.** A one-shot `migrate-to-aes` command decrypted the old vault with the RSA
  key and rewrote it under a fresh master key, copying the old keys and vault into
  `.local_assets/` first. It was deleted before this change was committed, so it is not in
  git history: redoing the migration means taking the old `credstore.py`, vault and keys
  from the commit before this one. The master passphrase was not changed.
- **History.** The old vault, the old keys and the old code stay in git history under the
  unchanged passphrase. Secrets committed before the migration must be rotated at their
  source systems if that matters; changing the cipher does not help them.

## File format

```json
{
  "Github npstash/all 01": {
    "url": "https://github.com/npstash",
    "authority_info": ["This token has access to all repositories.", "Read and Write access to code"],
    "credentials": { "username": "npstash", "token": "" }
  }
}
```

## Vault in its own repository

Decisions, all confirmed by the user:

- **Vault home.** The key and both credential files live flat in a separate repository,
  `vault-home`, a submodule of the repository that uses the vault. `--vault-home` finds
  it; the default lookup is `./vault-home`, then `vault-home` next to the script.
  If both exist, the working directory wins.
- **`init` replaces `keygen`.** It writes the key, an example `credentials.json` with blank
  secrets, the files in `templates/` and the setup scripts of `shared`. It stops if a vault
  exists already. `rotate-key` covers a new key.
- **Backups** go to `.local_assets/` of the tool folder, not the vault home.
- **Hook.** `.githooks/pre-commit` is committed in the vault repository. It uses only `sh`
  and `awk`, so it needs no Python and does not depend on where this tool is. Tests keep it
  in agreement with `exposed_secrets()`. `setup.sh` / `setup.bat` turn it on per clone.
  `install-hook` and `check-staged` are gone.

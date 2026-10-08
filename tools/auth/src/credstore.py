"""credstore - credential vault for the tools in this repository.

The vault home (--vault-home, default: ./vault-home, then <this folder>/vault-home) holds:

credentials.json  committed index: system -> url, authority_info, credentials (values cleared)
credentials.enc   committed vault: the same document, with secret values, encrypted with
                  the master key (the `openssl enc -aes-256-cbc -pbkdf2` format)
master.enc.key    the master key, encrypted with the master passphrase
master.key        optional, decrypted by the user, gitignored, opens the vault alone

The passphrase is passed in (--passphrase / Store(passphrase=...)); this tool never reads
environment variables.

The two files mirror each other exactly, except that only the vault holds secret values.
credentials.json is the source of truth for structure; the vault is stale data that fills
in secrets. Commands read credentials.json first and decrypt only when values are needed.
Files are rewritten only when their content changes.

A system with "alias_of" takes the secrets of its target. Its own secrets add to them or
replace them. get() and list give the resolved secrets.

    from credstore import get_credential          # PYTHONPATH must include this folder
    c = get_credential("jira", vault_home="vault-home"); c.secrets()["token"]
"""

from __future__ import annotations

import argparse
import getpass
import json
import shutil
import sys
from base64 import b64encode
from dataclasses import dataclass, field, replace
from pathlib import Path
from secrets import token_bytes
from types import MappingProxyType
from typing import Mapping

TOOL = Path(__file__).resolve().parents[1]   # tools/auth; this file is in src/
VAULT_DIR = "vault-home"              # the default vault home, looked up by find_vault_home()
BACKUPS = TOOL / ".local_assets"      # rotate-key and change-passphrase copy the files here first
TEMPLATES = TOOL / "templates"        # the files that init puts next to a new vault
SETUP = [TOOL.parents[1] / name for name in ("setup.sh", "setup.bat")]   # init copies them too


class CredentialError(RuntimeError):
    pass


EXAMPLE = {  # the credentials.json that init writes; fill the secrets in, then run sync
    "Example system": {
        "url": "https://example.com",
        "authority_info": ["What this credential is allowed to do"],
        "credentials": {"username": "", "token": ""},
    }
}


@dataclass(frozen=True)
class Credential:
    """One system. Secrets are handed out as an immutable map."""

    name: str
    url: str | None = None
    authority_info: tuple[str, ...] = ()
    _secrets: dict[str, str] = field(default_factory=dict, repr=False)
    alias_of: str | None = field(default=None, repr=False)  # the system that gives the secrets

    def secrets(self) -> Mapping[str, str]:
        return MappingProxyType(self._secrets)


def _parse(raw, source: str) -> dict[str, Credential]:
    if not isinstance(raw, dict):
        raise CredentialError(f"{source}: the top level must be an object of systems")
    systems = {}
    for name, e in raw.items():
        creds, info = (e.get("credentials"), e.get("authority_info")) if isinstance(e, dict) else (None, None)
        alias = e.get("alias_of") if isinstance(e, dict) else None
        if not isinstance(e, dict) or not isinstance(creds or {}, dict) or not isinstance(info or [], list) \
                or not isinstance(alias or "", str):
            raise CredentialError(f"{source}: system {name!r} is malformed")
        systems[name] = Credential(name, e.get("url"), tuple(str(i) for i in info or []),
                                   {str(k): str(v or "") for k, v in (creds or {}).items()}, alias or None)
    return systems


def _document(systems: dict[str, Credential], redact: bool = False) -> dict:
    doc = {}
    for name, c in systems.items():
        entry: dict = {}
        if c.url is not None:
            entry["url"] = c.url
        if c.authority_info:
            entry["authority_info"] = list(c.authority_info)
        if c.alias_of:
            entry["alias_of"] = c.alias_of
        if c._secrets or not c.alias_of:
            entry["credentials"] = {k: "" if redact else v for k, v in c._secrets.items()}
        doc[name] = entry
    return doc


def _canonical(systems: dict[str, Credential]) -> bytes:
    return json.dumps(_document(systems), sort_keys=True, separators=(",", ":")).encode()


def _merge(index: dict[str, Credential], stored: dict[str, Credential]) -> dict[str, Credential]:
    """Mirror the index, filling blank secrets from the vault.

    A secret that is blank in the index and absent from the vault is an error: it would
    otherwise be listed as a secret this system has, while holding nothing.
    """
    merged = {}
    for name, e in index.items():
        old = stored.get(name)
        secrets = {}
        for key, value in e._secrets.items():
            kept = value or (old._secrets.get(key, "") if old else "")
            if not kept:
                raise CredentialError(
                    f"system {name!r}: secret {key!r} is blank and the vault has no value for it - "
                    f"fill it in credentials.json, or remove the key")
            secrets[key] = kept
        merged[name] = replace(e, _secrets=secrets)
    _resolve(merged)
    return merged


def _resolve(systems: dict[str, Credential]) -> dict[str, Credential]:
    """Each alias with the secrets of its target, then its own secrets on top."""
    resolved = {}
    for name, c in systems.items():
        if c.alias_of is None:
            resolved[name] = c
            continue
        target = systems.get(c.alias_of)
        if target is None or target.alias_of is not None:
            raise CredentialError(
                f"system {name!r} is an alias of {c.alias_of!r}, which is "
                f"{'unknown' if target is None else 'an alias too'} - give a system that is not an alias")
        resolved[name] = replace(c, _secrets={**target._secrets, **c._secrets}, alias_of=None)
    return resolved


def _write(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


# -- crypto (imported lazily: `list` needs no cryptography package) -------------------

HEADER = b"Salted__"      # openssl enc marks a salted file with this
ITERATIONS = 10_000       # the default of `openssl enc -pbkdf2`; the README command relies on it


def _derive(passphrase: str, salt: bytes) -> tuple[bytes, bytes]:
    """Key and IV exactly as `openssl enc -aes-256-cbc -pbkdf2` derives them."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    material = PBKDF2HMAC(algorithm=hashes.SHA256(), length=48, salt=salt,
                          iterations=ITERATIONS).derive(passphrase.encode())
    return material[:32], material[32:]


def encrypt(data: bytes, passphrase: str) -> bytes:
    """`openssl enc -aes-256-cbc -pbkdf2` output: HEADER, salt, then the ciphertext."""
    from cryptography.hazmat.primitives import padding as pkcs7
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    salt = token_bytes(8)
    key, iv = _derive(passphrase, salt)
    pad = pkcs7.PKCS7(128).padder()
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return HEADER + salt + enc.update(pad.update(data) + pad.finalize()) + enc.finalize()


def decrypt(data: bytes, passphrase: str, what: str = "vault") -> bytes:
    """The other direction. CBC carries no MAC, so a wrong key and a damaged file both
    surface as a padding failure - or, worse, as plausible bytes that fail to parse."""
    from cryptography.hazmat.primitives import padding as pkcs7
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    if not data.startswith(HEADER) or len(data) < 32 or (len(data) - len(HEADER) - 8) % 16:
        raise CredentialError(f"{what} is corrupted: not an openssl enc -aes-256-cbc file")
    key, iv = _derive(passphrase, data[8:16])
    try:
        dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        unpad = pkcs7.PKCS7(128).unpadder()
        return unpad.update(dec.update(data[16:]) + dec.finalize()) + unpad.finalize()
    except ValueError as exc:
        raise CredentialError(f"could not decrypt the {what} - wrong key or corrupted file") from exc


def _read_key(data: bytes, path: Path) -> str:
    """The master key as `openssl enc -pass file:` reads it: the first line of the file."""
    try:
        key = data.decode("utf-8").split("\n", 1)[0].strip()
    except UnicodeDecodeError:
        key = ""
    if not key:
        raise CredentialError(f"{path} does not hold a usable master key")
    return key


def find_vault_home(vault_home: Path | str | None = None) -> Path:
    """The given folder, else ./vault-home, else vault-home next to this script."""
    if vault_home:
        return Path(vault_home)
    for candidate in (Path.cwd() / VAULT_DIR, TOOL / VAULT_DIR):
        if candidate.is_dir():
            return candidate
    raise CredentialError(
        f"no vault found in ./{VAULT_DIR} or {TOOL / VAULT_DIR} - "
        f"give its folder with --vault-home DIR, or create one with init")


class Store:
    def __init__(self, vault_home: Path | str | None = None, passphrase: str | None = None):
        self.home = find_vault_home(vault_home)
        self.index = self.home / "credentials.json"
        self.vault = self.home / "credentials.enc"
        self.key_enc = self.home / "master.enc.key"
        self.key_plain = self.home / "master.key"  # optional, gitignored, local only
        self._passphrase = passphrase
        self._key: str | None = None      # the master key, once loaded
        self._stored: bytes | None = None  # canonical vault content as last read/written

    def passphrase(self) -> str:
        """The passphrase given to this Store. The tool never reads the environment."""
        if not self._passphrase:
            raise CredentialError(
                "no way to open the vault. Either pass the master passphrase "
                "(CLI: --passphrase VALUE, API: Store(passphrase=...)), "
                f"or decrypt the master key once to {self.key_plain} "
                "(openssl enc -d -aes-256-cbc -pbkdf2 -in master.enc.key "
                "-out master.key; see README.md).")
        return self._passphrase

    def init(self) -> list[Path]:
        """A new vault: master key, example credentials.json, the files from templates/, setup scripts.

        Stops if any vault file exists already. Template files that exist are kept.
        """
        existing = [p for p in (self.key_enc, self.key_plain, self.index, self.vault) if p.exists()]
        if existing:
            raise CredentialError(f"a vault exists already: {', '.join(map(str, existing))}")
        self.home.mkdir(parents=True, exist_ok=True)
        self._new_key(self._passphrase or _prompt_new_passphrase())
        _write(self.index, (json.dumps(EXAMPLE, indent=2) + "\n").encode())
        written = [self.key_enc, self.index]
        sources = [(p, p.relative_to(TEMPLATES)) for p in sorted(TEMPLATES.rglob("*")) if p.is_file()]
        for source, name in sources + [(p, Path(p.name)) for p in SETUP]:
            target = self.home / name
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                written.append(target)
        return written

    def _new_key(self, passphrase: str) -> None:
        """A new random master key, stored encrypted with the master passphrase."""
        key = b64encode(token_bytes(32)).decode()  # 256 bits, one line, safe for `openssl -pass file:`
        _write(self.key_enc, encrypt((key + "\n").encode(), passphrase))
        self._key = key

    # -- files ------------------------------------------------------------------------

    def read_index(self) -> dict[str, Credential]:
        """The plaintext index - no passphrase needed."""
        if not self.index.exists():
            return {}
        try:
            return _parse(json.loads(self.index.read_text(encoding="utf-8") or "{}"), str(self.index))
        except json.JSONDecodeError as exc:
            raise CredentialError(f"{self.index} is not valid JSON: {exc}") from exc

    def _read_vault(self) -> dict[str, Credential]:
        if not self.vault.exists():
            self._stored = None
            return {}
        try:
            systems = _parse(json.loads(decrypt(self.vault.read_bytes(), self._load_key())), str(self.vault))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CredentialError(f"vault is corrupted: {self.vault}") from exc
        self._stored = _canonical(systems)
        return systems

    def _load_key(self) -> str:
        """master.key (decrypted by the user) or master.enc.key + passphrase.

        Both routes at once is ambiguous, so it stops instead of guessing.
        """
        if self._key is not None:
            return self._key
        if self.key_plain.exists():
            if self._passphrase:
                raise CredentialError(
                    f"both {self.key_plain} and a passphrase were given - these are two different "
                    f"ways to open the vault. Drop the passphrase, or delete the decrypted key.")
            self._key = _read_key(self.key_plain.read_bytes(), self.key_plain)
            return self._key
        try:
            blob = self.key_enc.read_bytes()
        except FileNotFoundError:
            raise CredentialError(f"master key not found: {self.key_enc} (run init)") from None
        passphrase = self.passphrase()   # outside the try: its own error must not be rewritten
        try:
            plain = decrypt(blob, passphrase, what="master key")
        except CredentialError as exc:
            raise CredentialError("could not decrypt the master key - wrong master passphrase?") from exc
        self._key = _read_key(plain, self.key_enc)
        return self._key

    def rotate_key(self) -> Path:
        """A new master key, same passphrase: the vault is decrypted with the old key and
        re-encrypted with the new one. Returns the backup directory."""
        systems = self._read_vault()
        if not self._passphrase:
            raise CredentialError("rotate-key needs --passphrase: the new master key is protected with it")
        passphrase = self._passphrase
        backup = self._backup("rotate-key")
        self._new_key(passphrase)
        self._stored = None  # the vault must be written again, under the new key
        self._save(systems)
        return backup

    def change_passphrase(self, new: str) -> Path:
        """Re-encrypt the master key with a new passphrase. Key and vault are untouched."""
        key = self._load_key()
        backup = self._backup("change-passphrase")
        _write(self.key_enc, encrypt((key + "\n").encode(), new))
        return backup

    def _backup(self, label: str) -> Path:
        """Copy key and vault aside first: a crash between the two writes would strand them."""
        from datetime import datetime
        target = BACKUPS / f"{label}-{datetime.now():%Y%m%d-%H%M%S}"
        target.mkdir(parents=True, exist_ok=True)
        for path in (self.key_enc, self.vault):
            if path.exists():
                shutil.copy2(path, target / path.name)
        return target

    def _save(self, systems: dict[str, Credential]) -> dict[str, Credential]:
        content = _canonical(systems)
        if content != self._stored:
            _write(self.vault, encrypt(content, self._load_key()))
            self._stored = content
        index = (json.dumps(_document(systems, redact=True), indent=2) + "\n").encode()
        if not self.index.exists() or self.index.read_bytes() != index:
            _write(self.index, index)
        return systems

    # -- operations -------------------------------------------------------------------

    def sync(self) -> dict[str, Credential]:
        """Mirror credentials.json into the vault and clear the index's secret values."""
        return self._save(_merge(self.read_index(), self._read_vault()))

    def get(self, system: str) -> Credential:
        systems = _resolve(self.sync())
        if system not in systems:
            raise CredentialError(f"unknown system {system!r} (known: {', '.join(systems) or 'none'})")
        return systems[system]

    def set(self, system: str, url: str | None = None, authority_info: list | None = None,
            secrets: dict | None = None) -> Credential:
        systems = dict(self.sync())
        old = systems.get(system)
        if old and old.alias_of:
            inherited = set(systems[old.alias_of]._secrets) - set(old._secrets)
            if inherited & set(secrets or {}):
                raise CredentialError(f"system {system!r} is an alias of {old.alias_of!r}; "
                                      f"set {', '.join(sorted(inherited & set(secrets)))} there")
        systems[system] = Credential(
            system,
            url if url is not None else (old.url if old else None),
            tuple(authority_info) if authority_info is not None else (old.authority_info if old else ()),
            {**(old._secrets if old else {}), **{k: v for k, v in (secrets or {}).items()}},
            old.alias_of if old else None,
        )
        return self._save(systems)[system]

    def rename(self, system: str, new: str, secret: str | None = None) -> None:
        """Rename a system, or one of its secret keys, keeping the stored values.

        Reads both files without merging first: the index may already carry the new name.
        """
        stored, index = self._read_vault(), self.read_index()
        if not new:
            raise CredentialError("the new name must not be empty")
        if system not in stored:
            raise CredentialError(f"unknown system {system!r}")
        if secret is None:
            if new in stored:
                raise CredentialError(f"system {new!r} already exists")
            if system in index and new in index:
                raise CredentialError(f"{self.index} holds both {system!r} and {new!r}")
            aliases = sorted({n for d in (stored, index) for n, c in d.items() if c.alias_of == system})
            if aliases:
                raise CredentialError(f"cannot rename {system!r}: {', '.join(aliases)} are aliases of it")
            rename = lambda d: {(new if n == system else n): (c if n != system else  # noqa: E731
                                replace(c, name=new)) for n, c in d.items()}
            stored, index, target = rename(stored), rename(index), new
        else:
            keys = stored[system]._secrets
            if secret not in keys or new in keys:
                raise CredentialError(f"cannot rename secret {secret!r} to {new!r} in system {system!r}")
            swap = lambda s: {(new if k == secret else k): v for k, v in s.items()}  # noqa: E731
            stored[system] = replace(stored[system], _secrets=swap(keys))
            if system in index:
                if secret in index[system]._secrets and new in index[system]._secrets:
                    raise CredentialError(f"{self.index} holds both {secret!r} and {new!r} for {system!r}")
                index[system] = replace(index[system], _secrets=swap(index[system]._secrets))
            target = system
        if target not in index:  # the index does not describe it yet; mirror it in
            index[target] = replace(stored[target], _secrets={k: "" for k in stored[target]._secrets})
        self._save(_merge(index, stored))


# -- secret check (templates/.githooks/pre-commit does the same in sh and awk) ------------

def exposed_secrets(raw) -> list[str]:
    """SYSTEM.KEY for each secret that has a value. credentials.json must give none."""
    return [f"{name}.{k}"
            for name, e in (raw.items() if isinstance(raw, dict) else [])
            if isinstance(e, dict) and isinstance(e.get("credentials"), dict)
            for k, v in e["credentials"].items() if v]


# -- API and CLI -----------------------------------------------------------------------

def _prompt_new_passphrase() -> str:
    if sys.stdin is None or not sys.stdin.isatty():
        raise CredentialError("a new passphrase must be typed in a terminal")
    first = getpass.getpass("New master passphrase: ")
    if not first:
        raise CredentialError("the new passphrase must not be empty")
    if first != getpass.getpass("Repeat new master passphrase: "):
        raise CredentialError("passphrases do not match")
    return first


def get_credential(system: str, vault_home: Path | str | None = None) -> Credential:
    return Store(vault_home).get(system)


def list_systems(vault_home: Path | str | None = None) -> list[str]:
    """System names from credentials.json - no passphrase, no decryption."""
    return list(Store(vault_home).read_index())


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="credstore", description="Credential vault (see request.md).")
    ap.add_argument("--vault-home", metavar="DIR",
                    help=f"vault folder (default: ./{VAULT_DIR}, then {VAULT_DIR} next to this script)")
    ap.add_argument("--passphrase", help="master passphrase; omit when master.key exists")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help="create a vault: master key, example credentials.json, git hook")
    sub.add_parser("sync", help="mirror credentials.json into the vault and clear its secrets")
    sub.add_parser("list", help="systems, urls and secret names from credentials.json")
    p = sub.add_parser("get", help="show a system, or print one secret")
    p.add_argument("system")
    p.add_argument("--secret")
    p = sub.add_parser("set", help="add or update a system")
    p.add_argument("system")
    p.add_argument("--url")
    p.add_argument("--info", action="append", help="authority_info line (repeatable)")
    p.add_argument("--secret", action="append", default=[], metavar="KEY=VALUE")
    p = sub.add_parser("rename", help="rename a system (NEW) or a secret key (--secret OLD=NEW)")
    p.add_argument("system")
    p.add_argument("new", nargs="?")
    p.add_argument("--secret", metavar="OLD=NEW")
    sub.add_parser("rotate-key", help="new master key, same passphrase; re-encrypts the vault")
    sub.add_parser("change-passphrase", help="re-encrypt the master key with a new passphrase")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "init":
            store = Store(a.vault_home or Path.cwd() / VAULT_DIR, a.passphrase)
            for path in store.init():
                print(f"wrote {path}")
            print(f"next: fill the secrets in {store.index}, run sync, then setup.sh in {store.home}")
            return 0
        store = Store(a.vault_home, a.passphrase)
        if a.cmd == "sync":
            print(f"synced {len(store.sync())} system(s)")
        elif a.cmd == "list":
            for name, c in _resolve(store.read_index()).items():
                print(f"{name}\t{c.url or '-'}\t{','.join(c.secrets()) or '-'}")
        elif a.cmd == "get":
            c = store.get(a.system)
            if a.secret:
                if a.secret not in c.secrets():
                    raise CredentialError(f"no secret {a.secret!r} in system {a.system!r} "
                                          f"(known: {', '.join(c.secrets()) or 'none'})")
                print(c.secrets()[a.secret])
            else:
                print(f"{c.name}\t{c.url or '-'}\t{','.join(c.secrets()) or '-'}")
                for line in c.authority_info:
                    print(f"  {line}")
        elif a.cmd == "set":
            pairs = [s.partition("=") for s in a.secret]
            if any(not sep or not k for k, sep, _ in pairs):
                raise CredentialError("--secret expects KEY=VALUE")
            store.set(a.system, a.url, a.info, {k: v for k, _, v in pairs})
            print(f"stored {a.system!r}")
        elif a.cmd == "rotate-key":
            backup = store.rotate_key()
            print(f"new master key in {store.key_enc}; vault re-encrypted (backup: {backup})")
            if store.key_plain.exists():
                print(f"warning: {store.key_plain} is now stale - delete it and decrypt the new key",
                      file=sys.stderr)
        elif a.cmd == "change-passphrase":
            backup = store.change_passphrase(_prompt_new_passphrase())
            print(f"passphrase changed (backup: {backup})")
            if store.key_plain.exists():
                print(f"note: {store.key_plain} still opens the vault; delete it to require the passphrase",
                      file=sys.stderr)
        elif a.cmd == "rename":
            if a.secret:
                old, sep, new = a.secret.partition("=")
                if not sep:
                    raise CredentialError("--secret expects OLD=NEW")
                store.rename(a.system, new, secret=old)
            elif a.new:
                store.rename(a.system, a.new)
            else:
                raise CredentialError("give a new name, or --secret OLD=NEW")
            print("renamed")
        return 0
    except CredentialError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

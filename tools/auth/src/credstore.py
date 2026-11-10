"""credstore - credential vault for the tools in this repository.

Design: docs/clone-keys.md. The vault home holds the files below. The API needs it. The CLI
takes --vault-home DIR, or --vault NAME and finds the folder with dependencies.py (rule
submodule-dependencies). It has no default vault.

vault.json              committed vault: entry ID -> the encrypted name and the encrypted entry
master.enc.key          the master key, encrypted with the passphrase
admin.enc.key           the admin private key, encrypted with the passphrase
admin.pub               the admin public key: it encrypts the entry names
recipients/<name>.pub   public key of a clone; <name>.master.enc is the master key for it;
                        <name>.inf tells the approver which clone made the request
clone.<name>.key        gitignored private key of a clone for this vault: plain, or encrypted
                        with a key passphrase that a provider (the OS keyring) holds
entry-<ID>.json         gitignored edit file of one entry; `edit` writes it, `sync` applies it
access.log              gitignored access log

The entry ID is an HMAC of the name, keyed with the master key. The key of an entry is
derived from the master key and the name. Thus only a caller that knows the name finds and
opens an entry. The names are also encrypted with the admin public key. Only the passphrase
opens them, for the rotation of the master key. No command lists the entries.

A clone key opens the vault. Else the passphrase does: the API parameter, or a prompt of
the CLI in an interactive terminal. This tool never reads environment variables.

    from credstore import get_credential          # PYTHONPATH must include this folder
    c = get_credential("jira", "vaults/vault-main"); c.secrets()["token"]
"""

from __future__ import annotations

import argparse
import configparser
import getpass
import hmac
import importlib.util
import io
import ipaddress
import json
import platform
import re
import shutil
import socket
import subprocess
import sys
from base64 import b64decode, b64encode
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from secrets import token_bytes
from types import MappingProxyType
from typing import Mapping

TOOL = Path(__file__).resolve().parents[1]   # tools/auth; this file is in src/
BACKUPS = TOOL / ".local_assets"      # key operations copy the files here first
TEMPLATES = TOOL / "templates"        # the files that create-vault puts next to a new vault
SETUP = [TOOL.parents[1] / "setup.sh"]   # create-vault copies it too
RECIPIENTS = "recipients"             # public keys and wrapped master keys
LOG = "access.log"                    # in the vault home, gitignored
EDIT = "entry-*.json"                 # edit files in the vault home, gitignored
IGNORED = ("clone.*.key", LOG, EDIT)  # the vault home must ignore these; see _ensure_ignored()
KEY_BITS = 3072
PROVIDER_LINE = "credstore-provider:"  # first line of a key file that a provider unlocks
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
ID_LIMIT = 30                         # generated names: computer-user-repo, without auto- and the date
FORMAT = 2                            # the format of vault.json
ID_HEX = 32                           # hex digits of an entry ID (128 bits)
NAME_BYTES = 256                      # RSA-OAEP with SHA-256 and a 3072-bit key takes 318 bytes at most
EDIT_FIELDS = ("name", "revision", "url", "authority_info", "credentials")


class CredentialError(RuntimeError):
    pass


class NoWayToOpen(CredentialError):
    """No clone key opens the vault and no passphrase was given."""


@dataclass(frozen=True)
class Credential:
    """One system. Secrets are handed out as an immutable map."""

    name: str
    url: str | None = None
    authority_info: tuple[str, ...] = ()
    _secrets: dict[str, str] = field(default_factory=dict, repr=False)

    def secrets(self) -> Mapping[str, str]:
        return MappingProxyType(self._secrets)


def _entry_doc(c: Credential) -> dict:
    """The plaintext of an entry in vault.json."""
    doc: dict = {"name": c.name}
    if c.url is not None:
        doc["url"] = c.url
    if c.authority_info:
        doc["authority_info"] = list(c.authority_info)
    doc["credentials"] = dict(c._secrets)
    return doc


def _strings(value, source: str, what: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise CredentialError(f"{source}: {what} must be a list of strings")
    return value


def _from_doc(doc, source: str) -> Credential:
    if not isinstance(doc, dict) or not isinstance(doc.get("name"), str):
        raise CredentialError(f"{source}: the entry is malformed")
    creds = doc.get("credentials", {})
    if not isinstance(creds, dict) or not all(isinstance(v, str) for v in creds.values()):
        raise CredentialError(f"{source}: credentials must be an object of strings")
    url = doc.get("url")
    if not isinstance(url or "", str):
        raise CredentialError(f"{source}: url must be a string")
    return Credential(doc["name"], url or None, tuple(_strings(doc.get("authority_info", []), source, "authority_info")),
                      dict(creds))


def _write(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def _check_name(name: str, what: str) -> str:
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise CredentialError(f"{what} name {name!r} is not valid: use letters, digits, '.', '_', '-'")
    return name


def _check_system(name: str) -> str:
    if not isinstance(name, str) or not name.strip() or any(ord(ch) < 32 for ch in name) \
            or len(name.encode()) > NAME_BYTES:
        raise CredentialError(f"system name {name!r} is not valid: give 1 to {NAME_BYTES} bytes, no control characters")
    return name


# -- clone information (recipients/<name>.inf and generated names) ---------------------

def _git(cwd: Path, *args: str) -> str:
    """The output of a git command, or "" if git or the repository is missing."""
    try:
        done = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def _root_repo(home: Path) -> Path | None:
    """The top superproject of the repository that holds `home`; the vault home if it is the root."""
    top = _git(home, "rev-parse", "--show-toplevel")
    while top:
        parent = _git(Path(top), "rev-parse", "--show-superproject-working-tree")
        if not parent:
            return Path(top)
        top = parent
    return None


def _repo_url(root: Path) -> str:
    """The URL of origin, else of the first remote; without credentials."""
    remotes = _git(root, "remote").split()
    if not remotes:
        return ""
    url = _git(root, "remote", "get-url", "origin" if "origin" in remotes else remotes[0])
    return re.sub(r"^([a-z][a-z0-9+.-]*://)[^/@]*@", r"\1", url, flags=re.I)


def _user_name() -> str:
    """The OS user name, without environment variables (getpass.getuser() reads them)."""
    try:
        if sys.platform == "win32":
            from os import getlogin   # GetUserNameW
            return getlogin()
        from os import getuid
        from pwd import getpwuid
        return getpwuid(getuid()).pw_name
    except (OSError, KeyError, ImportError):
        return ""


def _ip_addresses() -> list[str]:
    """The addresses of the outbound routes and of the host name; no loopback. No packet is sent."""
    found = set()
    for family, probe in ((socket.AF_INET, "192.0.2.1"), (socket.AF_INET6, "2001:db8::1")):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as s:
                s.connect((probe, 9))   # a UDP connect only selects the route
                found.add(s.getsockname()[0])
        except OSError:
            pass
    try:
        found.update(info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None))
    except OSError:
        pass
    addresses = []
    for a in found:
        try:
            ip = ipaddress.ip_address(a.split("%")[0])
        except ValueError:
            continue
        if not (ip.is_loopback or ip.is_unspecified or ip.is_link_local):
            addresses.append(ip)
    return [str(ip) for ip in sorted(addresses, key=lambda ip: (ip.version, ip))]


def _os_info() -> dict[str, str]:
    """uname, the Linux distribution and WSL, if detected."""
    u = platform.uname()
    info = {"os": u.system, "os_release": u.release, "os_version": u.version, "machine": u.machine,
            "platform": platform.platform()}
    if u.system == "Linux":
        try:
            release = platform.freedesktop_os_release()
        except OSError:
            release = {}
        info |= {"distro": release.get("PRETTY_NAME") or release.get("NAME", ""),
                 "distro_id": release.get("ID", ""), "distro_version": release.get("VERSION_ID", "")}
        try:
            kernel = Path("/proc/version").read_text(errors="replace")
        except OSError:
            kernel = u.release
        if "microsoft" in kernel.lower():
            info["wsl"] = "WSL2" if "wsl2" in kernel.lower() or "microsoft-standard" in kernel.lower() else "WSL1"
    return info


def _clone_info(home: Path) -> dict[str, str]:
    """The facts about this clone that recipients/<name>.inf records. Empty values are dropped."""
    root = _root_repo(home)
    url = _repo_url(root) if root else ""
    info = {"computer": socket.gethostname(), "user": _user_name(), **_os_info(),
            "ip_addresses": ", ".join(_ip_addresses()), "clone_path": str(root) if root else "",
            "repository": url}
    return {k: v for k, v in info.items() if v}


def _repo_name(url: str) -> str:
    return re.sub(r"\.git$", "", re.split(r"[/:]", url.rstrip("/"))[-1]) if url else ""


def _fit(fields: list[str], limit: int) -> list[str]:
    """Cut the longest fields first, so that the fields and the '-' between them fit in limit."""
    budget = limit - (len(fields) - 1)
    cap = max(map(len, fields), default=0)
    while cap > 0 and sum(min(len(f), cap) for f in fields) > budget:
        cap -= 1
    return [f[:cap] for f in fields if f[:cap]]


def _auto_name(info: dict[str, str], taken) -> str:
    """auto-<computer>-<user>-<repo>-<yyyymmdd>[-N], for a clone that enrols with no user input.

    Only the identification fields count for ID_LIMIT. taken(name) tells a used name."""
    fields = [re.sub(r"[^a-z0-9._]", "", v.lower())
              for v in (info.get("computer", ""), info.get("user", ""), _repo_name(info.get("repository", "")))]
    base = "-".join(["auto", *_fit([f for f in fields if f], ID_LIMIT), f"{datetime.now(timezone.utc):%Y%m%d}"])
    name, n = base, 1
    while taken(name):
        n += 1
        name = f"{base}-{n}"
    return name


def _write_info(path: Path, info: dict[str, str]) -> None:
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str
    parser["clone"] = {k: v.replace("\n", " ") for k, v in info.items()}
    buffer = io.StringIO()
    parser.write(buffer)
    _write(path, buffer.getvalue().rstrip("\n").encode() + b"\n")


# -- crypto (imported lazily: the CLI starts without the cryptography package) ---------

HEADER = b"Salted__"      # openssl enc marks a salted file with this
ITERATIONS = 10_000       # the default of `openssl enc -pbkdf2`


def _derive(passphrase: str, salt: bytes) -> tuple[bytes, bytes]:
    """Key and IV exactly as `openssl enc -aes-256-cbc -pbkdf2` derives them."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    material = PBKDF2HMAC(algorithm=hashes.SHA256(), length=48, salt=salt,
                          iterations=ITERATIONS).derive(passphrase.encode())
    return material[:32], material[32:]


def encrypt(data: bytes, passphrase: str) -> bytes:
    """`openssl enc -aes-256-cbc -pbkdf2` output: HEADER, salt, then the ciphertext. For master.enc.key."""
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


def _subkey(master: str, info: bytes) -> bytes:
    """A 256-bit key, derived from the master key with HKDF-SHA256."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(b64decode(master))


def entry_id(master: str, name: str) -> str:
    """The ID of an entry: HMAC-SHA256 of the name, keyed with a key from the master key."""
    return hmac.new(_subkey(master, b"credstore entry id"), name.encode(), sha256).hexdigest()[:ID_HEX]


def _seal(master: str, name: str, eid: str, plain: bytes) -> str:
    """AES-256-GCM with a key from the master key and the name. The ID is the associated data."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = token_bytes(12)
    key = _subkey(master, b"credstore entry key\0" + name.encode())
    return b64encode(nonce + AESGCM(key).encrypt(nonce, plain, eid.encode())).decode()


def _unseal(master: str, name: str, eid: str, data: str) -> bytes:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = _subkey(master, b"credstore entry key\0" + name.encode())
    try:
        raw = b64decode(data)
        return AESGCM(key).decrypt(raw[:12], raw[12:], eid.encode())
    except (InvalidTag, ValueError) as exc:
        raise CredentialError(f"entry {eid} cannot be decrypted - wrong key or damaged vault.json") from exc


def _revision(record: dict) -> str:
    """Changes with each write of the entry. An edit file keeps it, sync compares it."""
    return sha256(record["data"].encode()).hexdigest()[:16]


def _read_key(data: bytes, path: Path) -> str:
    """The master key as `openssl enc -pass file:` reads it: the first line of the file."""
    try:
        key = data.decode("utf-8").split("\n", 1)[0].strip()
    except UnicodeDecodeError:
        key = ""
    if not key:
        raise CredentialError(f"{path} does not hold a usable master key")
    return key


def _new_master_key() -> str:
    return b64encode(token_bytes(32)).decode()  # 256 bits, one line, safe for `openssl -pass file:`


def _oaep():
    """RSA-OAEP with SHA-256, as `openssl pkeyutl -pkeyopt rsa_oaep_md:sha256` reads it."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    return padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None)


def _public_pem(private) -> bytes:
    from cryptography.hazmat.primitives import serialization as s
    return private.public_key().public_bytes(s.Encoding.PEM, s.PublicFormat.SubjectPublicKeyInfo)


def _load_public(path: Path):
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import load_pem_public_key
    try:
        key = load_pem_public_key(path.read_bytes())
    except (OSError, ValueError) as exc:
        raise CredentialError(f"{path} is not a usable public key") from exc
    if not isinstance(key, rsa.RSAPublicKey) or key.key_size < KEY_BITS:
        raise CredentialError(f"{path} is not an RSA key of {KEY_BITS} bits or more")
    return key


def fingerprint(public_pem: bytes) -> str:
    """SHA-256 of the DER public key, as
    `openssl pkey -pubin -in X.pub -outform DER | openssl dgst -sha256 -binary | base64`."""
    from cryptography.hazmat.primitives import serialization as s
    from cryptography.hazmat.primitives.serialization import load_pem_public_key
    der = load_pem_public_key(public_pem).public_bytes(s.Encoding.DER, s.PublicFormat.SubjectPublicKeyInfo)
    return "SHA256:" + b64encode(sha256(der).digest()).decode().rstrip("=")


# -- providers of key passphrases ------------------------------------------------------

class Provider:
    """A store of key passphrases by recipient name. A network service can be one later."""

    name = ""

    def available(self) -> bool:
        raise NotImplementedError

    def get(self, name: str) -> str | None:
        raise NotImplementedError

    def set(self, name: str, value: str) -> None:
        raise NotImplementedError

    def delete(self, name: str) -> None:
        raise NotImplementedError

    def list(self) -> list[str]:
        """The names of all entries of this tool."""
        raise NotImplementedError


class KeyringProvider(Provider):
    """The OS keyring through the `keyring` package: service `credstore`, user <name>."""

    name = "keyring"
    SERVICE = "credstore"

    @staticmethod
    def _backends() -> list:
        """The usable backends: no fail, null or plaintext-file backend."""
        try:
            import keyring
            from keyring.backends import chainer
        except ImportError:
            return []
        backend = keyring.get_keyring()
        found = backend.backends if isinstance(backend, chainer.ChainerBackend) else [backend]
        usable = []
        for b in found:
            module = type(b).__module__
            if module.startswith(("keyring.backends.fail", "keyring.backends.null", "keyrings.alt.file")):
                continue
            try:
                if b.priority > 0:
                    usable.append(b)
            except Exception:  # noqa: BLE001 - a backend tells "not here" by raising
                continue
        return usable

    def available(self) -> bool:
        return bool(self._backends())

    def get(self, name: str) -> str | None:
        import keyring
        return keyring.get_password(self.SERVICE, name)

    def set(self, name: str, value: str) -> None:
        import keyring
        keyring.set_password(self.SERVICE, name, value)

    def delete(self, name: str) -> None:
        import keyring
        from keyring.errors import PasswordDeleteError
        try:
            keyring.delete_password(self.SERVICE, name)
        except PasswordDeleteError:
            pass

    def list(self) -> list[str]:
        """The `keyring` package cannot list entries, so search each backend directly."""
        names: set[str] = set()
        for b in self._backends():
            module = type(b).__module__
            if module.endswith("SecretService"):
                from contextlib import closing

                import secretstorage
                user = b.schemes[b.scheme]["username"]
                with closing(secretstorage.dbus_init()) as conn:
                    for item in secretstorage.search_items(conn, b._query(self.SERVICE)):
                        names.add(item.get_attributes().get(user, ""))
            elif module.endswith("Windows"):
                try:
                    from win32ctypes.pywin32 import win32cred
                except ImportError:
                    import win32cred
                try:
                    found = win32cred.CredEnumerate(None, 0)
                except Exception as exc:  # noqa: BLE001 - "no credentials" is an error there
                    if getattr(exc, "winerror", None) == 1168:
                        continue
                    raise
                for c in found:  # the backend uses <user>@<service> when a service has two users
                    if c["TargetName"] == self.SERVICE or c["TargetName"].endswith("@" + self.SERVICE):
                        names.add(c["UserName"])
            else:
                raise CredentialError(f"cannot list the entries of the keyring backend {module}")
        return sorted(n for n in names if n)


PROVIDERS: list[Provider] = [KeyringProvider()]   # tried in this sequence


def available_providers() -> list[Provider]:
    return [p for p in PROVIDERS if p.available()]


def _provider(name: str) -> Provider | None:
    return next((p for p in PROVIDERS if p.name == name), None)


# -- key files --------------------------------------------------------------------------

def _key_provider(path: Path) -> str | None:
    """The provider that a key file names in its first line, or None for a plain key."""
    first = path.read_bytes().partition(b"\n")[0]
    return first[len(PROVIDER_LINE):].strip().decode() if first.startswith(PROVIDER_LINE.encode()) else None


def _read_private(path: Path, name: str):
    """The private key of a key file, and how it was opened: 'plain' or the provider name."""
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    data, password, how = path.read_bytes(), None, "plain"
    first, _, rest = data.partition(b"\n")
    if first.startswith(PROVIDER_LINE.encode()):
        how = first[len(PROVIDER_LINE):].strip().decode()
        provider = _provider(how)
        if provider is None or not provider.available():
            raise CredentialError(f"provider {how!r} is not available")
        value = provider.get(name)
        if not value:
            raise CredentialError(f"provider {how!r} has no key passphrase for {name!r}")
        data, password = rest, value.encode()
    try:
        return load_pem_private_key(data, password), how
    except (ValueError, TypeError) as exc:
        raise CredentialError(f"{path.name} cannot be read") from exc


def _write_private(path: Path, name: str, private, provider: Provider | None) -> None:
    """Mode 600. With a provider, encrypted with a new key passphrase that the provider keeps."""
    from cryptography.hazmat.primitives import serialization as s
    if provider is None:
        data = private.private_bytes(s.Encoding.PEM, s.PrivateFormat.PKCS8, s.NoEncryption())
    else:
        value = b64encode(token_bytes(32)).decode()
        provider.set(name, value)
        data = f"{PROVIDER_LINE} {provider.name}\n".encode() + private.private_bytes(
            s.Encoding.PEM, s.PrivateFormat.PKCS8, s.BestAvailableEncryption(value.encode()))
    tmp = path.with_name(path.name + ".tmp")
    tmp.unlink(missing_ok=True)
    tmp.touch(mode=0o600)
    tmp.chmod(0o600)
    tmp.write_bytes(data)
    tmp.replace(path)
    _check_mode(path)


WSL_FIX = ('add  options = "metadata"  under [automount] in /etc/wsl.conf, '
           'then run  wsl --shutdown  in Windows and start WSL again')


def _check_mode(path: Path) -> None:
    if sys.platform == "win32" or path.stat().st_mode & 0o777 == 0o600:
        return
    import platform
    wsl = "microsoft" in platform.uname().release.lower()
    print(f"warning: {path} is not mode 600, because the file system ignores file modes" +
          (f" (WSL drvfs without the metadata option). To fix it, {WSL_FIX}." if wsl else "."),
          file=sys.stderr)


def _ensure_ignored(home: Path) -> None:
    """Private keys, the access log and edit files must never be committed."""
    path = home / ".gitignore"
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    missing = [p for p in IGNORED if p not in lines]
    if missing and home.is_dir():
        _write(path, ("\n".join(lines + ["# Private keys of clones, the access log and edit files", *missing]) + "\n").encode())


# -- access log -------------------------------------------------------------------------

_CLI = False   # main() sets it: then the caller is the parent process, not a Python frame
SHELLS = re.compile(r"(ba|da|z|k|fi)?sh|python[0-9.]*|node|pwsh|perl|ruby")
WITH_VALUE = {"--init-file", "--rcfile", "-o", "-O", "-W", "-X", "-m"}   # options that take the next argument


def _caller() -> str:
    """The file name of the caller. No path, arguments or function."""
    if not _CLI:
        here = Path(__file__).resolve()
        frame = sys._getframe(1)
        while frame is not None and Path(frame.f_code.co_filename).resolve() == here:
            frame = frame.f_back
        return Path(frame.f_code.co_filename).name if frame is not None else Path(sys.argv[0]).name
    if sys.platform == "win32":
        return Path(sys.argv[0]).name
    try:
        ppid = Path("/proc/self/stat").read_text().rpartition(")")[2].split()[1]
        args = [a for a in Path(f"/proc/{ppid}/cmdline").read_bytes().decode(errors="replace").split("\0") if a]
    except (OSError, IndexError):
        return Path(sys.argv[0]).name
    if not args:
        return "?"
    exe = Path(args[0].lstrip("-")).name
    if SHELLS.fullmatch(exe) and "-c" not in args:
        rest = iter(args[1:])
        for a in rest:
            if a in WITH_VALUE:
                next(rest, None)       # e.g. bash --init-file <file> of an interactive terminal
            elif not a.startswith("-"):
                return Path(a).name
    return exe


LOG_HEADER = "\t".join(["time", "event", "vault", "system", "secrets", "method", "caller"])


def _log(home: Path, event: str, system: str = "", secrets=(), method: str = "") -> None:
    """One tab-separated line. The system and the caller are in quotes: they can hold spaces.

    The system column holds the entry ID, never the name, or a recipient name. The vault
    column is always "main": it stays for the format of existing logs."""
    clean = lambda s: re.sub(r"[\t\r\n\"]", " ", s)  # noqa: E731
    line = "\t".join([datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), event, "main",
                      f'"{clean(system)}"', clean(",".join(secrets)), method, f'"{clean(_caller())}"'])
    path = home / LOG
    try:
        if not path.exists():
            _ensure_ignored(home)
        old = path.read_text(encoding="utf-8") if path.exists() else ""
        if not old.startswith(LOG_HEADER + "\n"):   # a new log, or one from before the header
            _write(path, (LOG_HEADER + "\n" + old).encode())
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as exc:
        print(f"warning: cannot write {path}: {exc}", file=sys.stderr)


# -- the store ------------------------------------------------------------------------------

def _dependencies():
    """dependencies.py of this tool, the copy of the reference code of the rule submodule-dependencies."""
    spec = importlib.util.spec_from_file_location("credstore_dependencies", TOOL / "src" / "dependencies.py")
    dependencies = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dependencies)
    return dependencies


def find_vault(name: str) -> Path:
    """The folder of the vault `name`, e.g. vault-main, found from the folder of this tool."""
    dependencies = _dependencies()
    try:
        return dependencies.find(name, start=TOOL)
    except dependencies.DependencyError as exc:
        raise CredentialError(f"{exc}\ngive the vault home with --vault-home DIR") from None


def known_vaults() -> list[str]:
    """The names vault-* in .gitmodules and dependencies.txt of each root above this tool."""
    dependencies = _dependencies()
    names = set()
    for root in dependencies.roots(TOOL):
        try:
            sections = dependencies.dependencies(root)
        except dependencies.DependencyError:
            sections = {}
        names.update(n for n in dependencies.submodules(root) if n.startswith("vault-"))
        names.update(n for n, paths in sections.items()
                     if n.startswith("vault-") and any((root / p).is_dir() for p in paths))
    return sorted(names)


def vault_home(vault: str | None = None, home: Path | str | None = None) -> Path:
    """The vault home of the CLI options --vault-home and --vault. There is no default vault."""
    if home:
        return Path(home)
    if vault:
        return find_vault(vault)
    raise CredentialError("give the vault with --vault NAME or --vault-home DIR; vaults found: "
                          + (", ".join(known_vaults()) or "none"))


def _admin_key(pem: bytes):
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    try:
        return load_pem_private_key(pem, None)
    except (ValueError, TypeError) as exc:
        raise CredentialError("admin.enc.key holds a damaged admin key") from exc


class Store:
    """The vault of `vault_home`.

    `passphrase` opens the vault when no clone key does. `interactive` lets the CLI ask
    for it in a terminal.
    """

    def __init__(self, vault_home: Path | str, passphrase: str | None = None,
                 interactive: bool = False):
        if not vault_home:
            raise CredentialError("give the vault home")
        self.home = Path(vault_home)
        self.vault = self.home / "vault.json"
        self.admin_pub = self.home / "admin.pub"
        self.admin_enc = self.home / "admin.enc.key"
        self.recipients = self.home / RECIPIENTS
        self.key_enc = self.home / "master.enc.key"
        self.interactive = interactive
        self.prompt = "Master passphrase: "
        self.method = ""                   # how the vault was opened, for the access log
        self._passphrase = passphrase
        self._key: str | None = None       # the master key, once loaded
        self._records: dict[str, dict] | None = None   # the entries of vault.json, once read

    # -- opening ------------------------------------------------------------------------

    def _ask_passphrase(self) -> str | None:
        if not self._passphrase and self.interactive:
            self._passphrase = getpass.getpass(self.prompt) or None
        return self._passphrase

    def _key_files(self) -> list[tuple[str, Path]]:
        return [(p.name[len("clone."):-len(".key")], p) for p in sorted(self.home.glob("clone.*.key"))]

    def _load_key(self, log_failure: bool = True) -> str:
        """The master key: from the first clone key that opens it, else from the passphrase."""
        if self._key is not None:
            return self._key
        skipped = []
        for name, path in self._key_files():
            wrapped = self.recipients / f"{name}.master.enc"
            if not wrapped.is_file():
                continue
            try:
                private, how = _read_private(path, name)
                key = private.decrypt(wrapped.read_bytes(), _oaep()).decode()
            except CredentialError as exc:
                skipped.append(f"{name}: {exc}")
                continue
            except ValueError:
                skipped.append(f"{name}: does not open {wrapped.name}")
                continue
            self._key, self.method = key, f"clone-key:{name}:{how}"
            return key
        tried = ""
        try:
            passphrase = self._ask_passphrase()
            if not passphrase:
                raise NoWayToOpen(
                    "no way to open the vault: no clone key opens it, and no passphrase was given. "
                    "Enrol this clone with `run.sh enrol` (see docs/clone-keys.md)")
            tried = "passphrase"
            try:
                blob = self.key_enc.read_bytes()
            except FileNotFoundError:
                raise CredentialError(f"master key not found: {self.key_enc} (run create-vault)") from None
            try:
                plain = decrypt(blob, passphrase, what="master key")
            except CredentialError as exc:
                raise CredentialError("could not decrypt the master key - wrong master passphrase?") from exc
            self._key, self.method = _read_key(plain, self.key_enc), "passphrase"
            return self._key
        except CredentialError as exc:
            if log_failure:
                _log(self.home, "open-failed", method=tried)
            if skipped:
                raise type(exc)(f"{exc}. Skipped keys: {'; '.join(skipped)}") from exc
            raise

    def _confirm_passphrase(self) -> str:
        """The passphrase, checked against master.enc.key."""
        self._load_key()
        passphrase = self._ask_passphrase()
        if not passphrase:
            raise CredentialError("this command needs the master passphrase: run it in a terminal, "
                                  "or give passphrase= to the API")
        try:
            plain = decrypt(self.key_enc.read_bytes(), passphrase, "master key")
            same = _read_key(plain, self.key_enc) == self._key
        except CredentialError:
            same = False
        if not same:
            raise CredentialError("the passphrase does not open master.enc.key")
        return passphrase

    def _admin_pem(self, passphrase: str) -> bytes:
        """The admin private key PEM from admin.enc.key."""
        try:
            blob = self.admin_enc.read_bytes()
        except FileNotFoundError:
            raise CredentialError(f"admin key not found: {self.admin_enc}") from None
        return decrypt(blob, passphrase, what="admin key")

    # -- entries --------------------------------------------------------------------------

    def _entries(self) -> dict[str, dict]:
        """ID -> {"name", "data"} of vault.json. Nothing is decrypted."""
        if self._records is None:
            if not self.vault.is_file():
                raise CredentialError(f"no vault: {self.vault} does not exist (run create-vault)")
            try:
                doc = json.loads(self.vault.read_text(encoding="utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise CredentialError(f"{self.vault} is not valid JSON") from exc
            if not isinstance(doc, dict) or doc.get("format") != FORMAT or not isinstance(doc.get("entries"), dict):
                raise CredentialError(f"{self.vault} is not a vault of format {FORMAT}")
            self._records = doc["entries"]
        return self._records

    def _save(self) -> None:
        """Write vault.json if it changed. Unchanged entries keep their ciphertext."""
        doc = {"format": FORMAT, "entries": dict(sorted(self._entries().items()))}
        data = (json.dumps(doc, indent=2) + "\n").encode()
        if not self.vault.is_file() or self.vault.read_bytes() != data:
            _write(self.vault, data)

    def _id(self, name: str) -> str:
        return entry_id(self._load_key(), _check_system(name))

    def _get(self, name: str) -> Credential | None:
        """The stored entry `name`, unresolved, or None."""
        eid = self._id(name)
        record = self._entries().get(eid)
        if record is None:
            return None
        try:
            c = _from_doc(json.loads(_unseal(self._key, name, eid, record["data"])), f"entry {eid}")
        except (KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CredentialError(f"entry {eid} in {self.vault} is damaged") from exc
        if c.name != name:
            raise CredentialError(f"entry {eid} in {self.vault} is damaged")
        return c

    def _need(self, name: str) -> Credential:
        c = self._get(name)
        if c is None:
            raise CredentialError(f"unknown system {name!r}")
        return c

    def _put(self, c: Credential, name_blob: str | None = None) -> None:
        """Encrypt the entry `c`. Its name is encrypted to the admin key once."""
        eid = self._id(c.name)
        old = self._entries().get(eid)
        if name_blob is None:
            name_blob = old["name"] if old else b64encode(
                _load_public(self.admin_pub).encrypt(c.name.encode(), _oaep())).decode()
        plain = json.dumps(_entry_doc(c), sort_keys=True).encode()
        self._entries()[eid] = {"name": name_blob, "data": _seal(self._key, c.name, eid, plain)}

    def _drop(self, name: str) -> None:
        del self._entries()[self._id(name)]

    def _names(self, admin) -> dict[str, str]:
        """ID -> name of each entry. Only the admin key (the passphrase) opens the names."""
        return {eid: self._name_of(admin, eid, record) for eid, record in self._entries().items()}

    def _name_of(self, admin, eid: str, record: dict) -> str:
        """The name of the entry `eid`, decrypted with the admin key and checked against the ID."""
        try:
            name = admin.decrypt(b64decode(record["name"]), _oaep()).decode()
        except (KeyError, ValueError) as exc:
            raise CredentialError(f"the name of entry {eid} cannot be decrypted") from exc
        if entry_id(self._key, name) != eid:
            raise CredentialError(f"entry {eid} in {self.vault} is damaged")
        return name

    def _lookup(self, key: str) -> str | None:
        """The name of the entry with the ID or the encrypted name `key`, else None.

        A match needs the passphrase: only the admin key opens the name."""
        entries = self._entries()
        eid = key if key in entries else next(
            (e for e, record in entries.items() if record.get("name") == key), None)
        if eid is None:
            return None
        name = self._name_of(_admin_key(self._admin_pem(self._confirm_passphrase())), eid, entries[eid])
        _log(self.home, "get-system", eid, method=self.method)
        return name

    # -- wrapping and backups --------------------------------------------------------------

    def _approved(self) -> list[str]:
        """Recipients with a public key and a wrapped master key. A request has only the key."""
        if not self.recipients.is_dir():
            return []
        return sorted(p.stem for p in self.recipients.glob("*.pub")
                      if (self.recipients / f"{p.stem}.master.enc").is_file())

    def _wrap(self, name: str, key: str) -> None:
        public = _load_public(self.recipients / f"{name}.pub")
        _write(self.recipients / f"{name}.master.enc", public.encrypt(key.encode(), _oaep()))

    def _wrap_all(self, key: str) -> None:
        """Wrap a new master key for each approved recipient; drop the unenrolled ones."""
        approved = self._approved()
        for name in approved:
            self._wrap(name, key)
        for path in self.recipients.glob("*.master.enc") if self.recipients.is_dir() else []:
            if path.name[:-len(".master.enc")] not in approved:
                path.unlink()

    def _backup(self, label: str) -> Path:
        """Copy keys and vaults aside first: a crash between two writes would strand them."""
        target = BACKUPS / f"{label}-{datetime.now():%Y%m%d-%H%M%S}"
        target.mkdir(parents=True, exist_ok=True)
        for path in (self.key_enc, self.admin_enc, self.vault, self.admin_pub):
            if path.exists():
                shutil.copy2(path, target / path.name)
        if self.recipients.is_dir():
            shutil.copytree(self.recipients, target / self.recipients.name, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("*.tmp"))
        return target

    def _new_admin_key(self, passphrase: str) -> None:
        """A new admin key pair: admin.pub, and admin.enc.key encrypted with the passphrase."""
        from cryptography.hazmat.primitives import serialization as s
        from cryptography.hazmat.primitives.asymmetric import rsa
        private = rsa.generate_private_key(public_exponent=65537, key_size=KEY_BITS)
        _write(self.admin_enc, encrypt(private.private_bytes(s.Encoding.PEM, s.PrivateFormat.PKCS8,
                                                             s.NoEncryption()), passphrase))
        _write(self.admin_pub, _public_pem(private))

    # -- master key -----------------------------------------------------------------------

    def create_vault(self) -> list[Path]:
        """A new vault: master key, admin key, empty vault.json, the files from templates/, setup scripts.

        Stops if any vault file exists already. Template files that exist are kept.
        """
        existing = [p for p in (self.key_enc, self.admin_enc, self.vault, self.admin_pub) if p.exists()]
        if existing:
            raise CredentialError(f"a vault exists already: {', '.join(map(str, existing))}")
        passphrase = self._passphrase or _prompt_new_passphrase()   # before any file is written
        self.home.mkdir(parents=True, exist_ok=True)
        self._new_key(passphrase)
        self._new_admin_key(passphrase)
        self._records = {}
        self._save()
        written = [self.key_enc, self.admin_enc, self.admin_pub, self.vault]
        sources = [(p, p.relative_to(TEMPLATES)) for p in sorted(TEMPLATES.rglob("*")) if p.is_file()]
        for source, name in sources + [(p, Path(p.name)) for p in SETUP]:
            target = self.home / name
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                written.append(target)
        _ensure_ignored(self.home)
        return written

    def _new_key(self, passphrase: str, key: str | None = None) -> None:
        """Write master.enc.key: the master key, a new random one by default."""
        key = key or _new_master_key()
        _write(self.key_enc, encrypt((key + "\n").encode(), passphrase))
        self._key = key

    def rotate_master_key(self, backup: Path | None = None) -> Path:
        """A new master key, wrapped for each approved recipient and with the passphrase.

        Each entry gets a new ID and a new encryption. Returns the backup.
        """
        passphrase = self._confirm_passphrase()
        names = self._names(_admin_key(self._admin_pem(passphrase)))
        systems = [(self._need(name), self._entries()[eid]["name"]) for eid, name in names.items()]
        backup = backup or self._backup("rotate-master-key")
        self._new_key(passphrase)
        self._records = {}
        for c, name_blob in systems:
            self._put(c, name_blob)
        self._save()
        self._wrap_all(self._key)
        _log(self.home, "rotate-master-key", method=self.method)
        return backup

    def change_passphrase(self, new: str) -> Path:
        """Encrypt master.enc.key and admin.enc.key with a new passphrase. The keys stay."""
        passphrase = self._confirm_passphrase()
        admin_pem = self._admin_pem(passphrase)
        backup = self._backup("change-passphrase")
        self._new_key(new, key=self._key)
        _write(self.admin_enc, encrypt(admin_pem, new))
        _log(self.home, "change-passphrase", method=self.method)
        return backup

    # -- recipients -----------------------------------------------------------------------

    def enrol(self, name: str | None = None, provider: Provider | str | None = "auto") -> tuple[str, str, bool]:
        """Make (or reuse) the key pair `name` of this clone for this vault.

        provider: "auto" takes the first available provider; None writes a plain key file.
        If this vault opens here, the master key is wrapped for the new key at once
        (self-enrolment). Else the result is a request for approve-enrol in a trusted clone.
        Writes recipients/<name>.inf with the facts about this clone, for the approver.
        Returns (name, fingerprint, approved).
        """
        clone = _clone_info(self.home)
        name = _check_name(name or _auto_name(clone, lambda n: (self.recipients / f"{n}.pub").exists()
                                              or (self.home / f"clone.{n}.key").exists()), "recipient")
        path = self.home / f"clone.{name}.key"
        pub = self.recipients / f"{name}.pub"
        if pub.exists() and not path.exists():
            raise CredentialError(f"recipient name {name!r} is taken: {pub} exists")
        _ensure_ignored(self.home)
        if path.exists():
            private, _ = _read_private(path, name)
        else:
            from cryptography.hazmat.primitives.asymmetric import rsa
            if provider == "auto":
                provider = next(iter(available_providers()), None)
            private = rsa.generate_private_key(public_exponent=65537, key_size=KEY_BITS)
            self.home.mkdir(parents=True, exist_ok=True)
            _write_private(path, name, private, provider if isinstance(provider, Provider) else None)
        public = _public_pem(private)
        if pub.exists() and pub.read_bytes() != public:
            raise CredentialError(f"{pub} holds another key than {path.name}")
        self.recipients.mkdir(parents=True, exist_ok=True)
        if not pub.exists():
            _write(pub, public)
        _write_info(self.recipients / f"{name}.inf",
                    {"name": name, "created": f"{datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ}",
                     "fingerprint": fingerprint(public), **clone})
        approved = (self.recipients / f"{name}.master.enc").is_file()
        if not approved:
            try:
                key = self._load_key(log_failure=False)
            except NoWayToOpen:
                key = None
            if key:
                self._wrap(name, key)
                approved = True
        _log(self.home, "enrol", name, method=self.method if approved else "")
        return name, fingerprint(public), approved

    def approve_enrol(self, name: str) -> str:
        """Wrap the master key for the request `name`. Returns the fingerprint to compare."""
        pub = self.recipients / f"{_check_name(name, 'recipient')}.pub"
        if not pub.is_file():
            raise CredentialError(f"no request for {name!r}: {pub} does not exist")
        self._wrap(name, self._load_key())
        _log(self.home, "approve-enrol", name, method=self.method)
        return fingerprint(pub.read_bytes())

    def request_info(self, name: str) -> str:
        """The content of recipients/<name>.inf, or "" if the request has none."""
        path = self.recipients / f"{_check_name(name, 'recipient')}.inf"
        return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""

    def _recipient_files(self, name: str) -> list[Path]:
        """.pub, .master.enc and .inf of the recipient `name`."""
        return [self.recipients / f"{_check_name(name, 'recipient')}{ext}" for ext in (".pub", ".master.enc", ".inf")]

    def own_recipients(self) -> list[str]:
        """The recipients (approved or requests) whose private key is in this vault home."""
        return [n for n, _ in self._key_files() if any(p.exists() for p in self._recipient_files(n)[:2])]

    def _only(self, names: list[str], what: str) -> str:
        if not names:
            raise CredentialError(f"this clone has no {what} in {self.home}")
        if len(names) > 1:
            raise CredentialError(f"this clone has more than one {what} in {self.home}: "
                                  f"{', '.join(names)}; give a name")
        return names[0]

    def unenrol(self, name: str | None = None) -> str:
        """Delete the recipient files of `name` (default: this clone). No rotation, no passphrase.

        The recipient can be approved or a request. The private key stays: delete it with
        delete_private_clone_key() after the change is pushed. Returns the name.
        """
        name = name or self._only(self.own_recipients(), "recipient")
        files = self._recipient_files(name)
        if not any(p.exists() for p in files[:2]):
            raise CredentialError(f"unknown recipient {name!r} in {self.recipients}")
        for p in files:
            p.unlink(missing_ok=True)
        _log(self.home, "unenrol", name)
        return name

    def _pushed_files(self, files: list[Path]) -> list[str]:
        """The files that the upstream branch of the vault home still holds."""
        top = _git(self.home, "rev-parse", "--show-toplevel")
        if not top or Path(top).resolve() != self.home.resolve() or not _git(self.home, "rev-parse", "@{u}"):
            return []   # not a repository with an upstream: nothing to check
        rel = [p.relative_to(self.home).as_posix() for p in files]
        return _git(self.home, "ls-tree", "--name-only", "@{u}", "--", *rel).split()

    def delete_private_clone_key(self, name: str | None = None) -> str:
        """Delete the private key of `name` (default: this clone) and its key passphrase.

        Refused while the recipient files exist here or in the upstream branch: unenrol,
        commit and push first. Returns the name.
        """
        name = name or self._only([n for n, _ in self._key_files()], "private clone key")
        path = self.home / f"clone.{_check_name(name, 'recipient')}.key"
        if not path.is_file():
            raise CredentialError(f"no private clone key {path}")
        files = self._recipient_files(name)[:2]
        left = [p.name for p in files if p.exists()] or self._pushed_files(files)
        if left:
            raise CredentialError(f"{name!r} is still enrolled ({', '.join(left)}): "
                                  f"run unenrol, then commit and push the vault home first")
        provider = _provider(_key_provider(path) or "")
        if provider is not None and provider.available():
            provider.delete(name)
        path.unlink()
        _log(self.home, "delete-private-clone-key", name, method=provider.name if provider else "plain")
        return name

    def unenrol_and_rotate_master_key(self, name: str) -> Path:
        """Delete the recipient `name`, then make a new master key. Returns the backup."""
        files = self._recipient_files(name)
        if not any(p.exists() for p in files[:2]):
            raise CredentialError(f"unknown recipient {name!r} in {self.recipients}")
        self._entries()
        self._confirm_passphrase()   # before anything is deleted
        backup = self._backup("unenrol-and-rotate-master-key")
        for p in files:
            p.unlink(missing_ok=True)
        self.rotate_master_key(backup)
        _log(self.home, "unenrol-and-rotate-master-key", name, method=self.method)
        return backup

    def list_keyring_secrets(self) -> list[tuple[str, str]]:
        """(provider, name) for each key passphrase of this tool in the available providers."""
        return [(p.name, n) for p in available_providers() for n in p.list()]

    def _delete_keyring_secrets(self, names: list[str] | None) -> list[tuple[str, str]]:
        removed = []
        for p in available_providers():
            for name in p.list():
                if names is not None and name not in names:
                    continue
                p.delete(name)
                removed.append((p.name, name))
                path = self.home / f"clone.{name}.key"
                if path.is_file() and _key_provider(path) == p.name:
                    path.unlink()   # it cannot open any more
                _log(self.home, "delete-keyring-secret", name, method=p.name)
        return removed

    def delete_keyring_secrets(self, names: list[str]) -> list[tuple[str, str]]:
        """Delete the key passphrases `names`, and the key files they unlock here."""
        if not names:
            raise CredentialError("give one or more names")
        return self._delete_keyring_secrets(names)

    def delete_all_keyring_secrets(self) -> list[tuple[str, str]]:
        """Delete each key passphrase of this tool, and the key files they unlock here."""
        return self._delete_keyring_secrets(None)


    # -- operations -------------------------------------------------------------------

    def list_systems(self) -> list[str]:
        """The names of all systems, sorted. Needs the passphrase: only the admin key opens the names."""
        names = self._names(_admin_key(self._admin_pem(self._confirm_passphrase())))
        _log(self.home, "list-systems", method=self.method)
        return sorted(names.values())

    def get_system(self, system: str) -> Credential:
        """A system by its name, entry ID or encrypted name. Use get_credential() or get_secret() to hand out secrets.

        An entry ID or an encrypted name needs the passphrase, and writes an access log line.
        A name writes no log line."""
        return self._need(self._lookup(system) or system)

    def get_credential(self, system: str) -> Credential:
        """A system with all its secrets. Logs each secret."""
        c = self._need(system)
        _log(self.home, "get", self._id(system), list(c.secrets()), self.method)
        return c

    def get_secret(self, system: str, key: str) -> str:
        """One secret value. Logs only this secret."""
        c = self._need(system)
        if key not in c.secrets():
            raise CredentialError(f"no secret {key!r} in system {system!r} "
                                  f"(known: {', '.join(c.secrets()) or 'none'})")
        _log(self.home, "get", self._id(system), [key], self.method)
        return c.secrets()[key]

    def edit_path(self, system: str) -> Path:
        return self.home / f"entry-{self._id(system)}.json"

    def edit(self, systems: list[str]) -> list[Path]:
        """Write an edit file for each system: all fields, secret values empty. Returns the paths.

        A new system gets a file with no fields. sync applies the files.
        """
        if not systems:
            raise CredentialError("give one or more system names")
        paths = [self.edit_path(s) for s in systems]
        existing = [p.name for p in paths if p.exists()]
        if existing:
            raise CredentialError(f"{', '.join(existing)} exists already: run sync, or delete the file")
        _ensure_ignored(self.home)
        for system, path in zip(systems, paths):
            record = self._entries().get(self._id(system))
            doc: dict = {"name": system, "revision": _revision(record) if record else ""}
            c = self._get(system)
            if c is None:
                doc |= {"url": "", "authority_info": [], "credentials": {}}
            else:
                doc |= {k: v for k, v in _entry_doc(c).items() if k != "name"}
                doc["credentials"] = {k: "" for k in c._secrets}
            _write(path, (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode())
        return paths

    def _from_edit(self, path: Path, current) -> tuple[str, Credential]:
        """The system of an edit file, merged with its stored values. Checks the name and the revision."""
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CredentialError(f"{path.name} is not valid JSON: {exc}") from exc
        if not isinstance(doc, dict) or not isinstance(doc.get("name"), str) \
                or not isinstance(doc.get("revision"), str):
            raise CredentialError(f"{path.name}: name and revision must be strings")
        unknown = sorted(set(doc) - set(EDIT_FIELDS))
        if unknown:
            raise CredentialError(f"{path.name}: unknown fields: {', '.join(unknown)}")
        name = doc["name"]
        if path != self.edit_path(name):
            raise CredentialError(f"{path.name}: the name {name!r} does not belong to this file; "
                                  f"to rename a system, use rename-system")
        record = self._entries().get(self._id(name))
        if doc["revision"] != (_revision(record) if record else ""):
            raise CredentialError(f"{path.name}: system {name!r} changed after edit; run edit again")
        new = _from_doc({k: v for k, v in doc.items() if k != "revision"}, path.name)
        old = current(name)
        secrets = {}
        for key, value in new._secrets.items():
            kept = value or (old._secrets.get(key, "") if old else "")
            if not kept:
                raise CredentialError(f"system {name!r}: secret {key!r} is blank and the vault has no value "
                                      f"for it - fill it in {path.name}, or remove the key")
            secrets[key] = kept
        return name, replace(new, _secrets=secrets)

    def sync(self) -> list[str]:
        """Apply each edit file of the vault home, then delete the files. Returns the system names.

        An empty secret keeps the stored value. A field that the file does not have is removed.
        All files are applied, or none.
        """
        files = sorted(self.home.glob(EDIT))
        if not files:
            raise CredentialError(f"no {EDIT} in {self.home}: run edit NAME first")
        changed: dict[str, Credential] = {}
        names = []
        current = lambda n: changed[n] if n in changed else self._get(n)  # noqa: E731
        for path in files:
            name, new = self._from_edit(path, current)
            names.append(name)
            changed[name] = new
        updates = [c for c in changed.values() if c != self._get(c.name)]
        for c in updates:
            self._put(c)
        self._save()
        for path in files:
            path.unlink()
        return names

    def set_system(self, system: str, url: str | None = None, authority_info: list | None = None,
                   secrets: dict | None = None) -> Credential:
        old = self._get(system)
        new = Credential(
            system,
            url if url is not None else (old.url if old else None),
            tuple(authority_info) if authority_info is not None else (old.authority_info if old else ()),
            {**(old._secrets if old else {}), **{k: v for k, v in (secrets or {}).items()}},
        )
        if new != old:
            self._put(new)
            self._save()
        return new

    def delete_system(self, system: str) -> None:
        """Delete a system."""
        self._need(system)
        eid = self._id(system)
        self._drop(system)
        self._save()
        _log(self.home, "delete-system", eid, method=self.method)

    def rename_system(self, system: str, new: str) -> None:
        """Rename a system, keeping the stored values. The entry gets a new ID."""
        c = self._need(system)
        if self._get(new) is not None:
            raise CredentialError(f"system {new!r} already exists")
        self._drop(system)
        self._put(replace(c, name=new))
        self._save()

    def rename_secret(self, system: str, old: str, new: str) -> None:
        """Rename a secret key of a system, keeping the stored value."""
        c = self._need(system)
        keys = c._secrets
        if not new or old not in keys or new in keys:
            raise CredentialError(f"cannot rename secret {old!r} to {new!r} in system {system!r}")
        self._put(replace(c, _secrets={(new if k == old else k): v for k, v in keys.items()}))
        self._save()


# -- push-enrol: commit and push the recipient files and the submodule pointers above them ------

RECIPIENT_FILE = re.compile(r"^(.+)\.(pub|inf|master\.enc)$")


@dataclass
class PushStep:
    """One commit and push of push-enrol."""
    repo: Path
    branch: str
    upstream: str
    paths: list[str]
    message: str


def _run_git(cwd: Path, *args: str) -> str:
    """The output of a git command; CredentialError if it fails."""
    done = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise CredentialError(f"git {' '.join(args)} in {cwd}: {(done.stderr or done.stdout).strip()}")
    return done.stdout


def _status(repo: Path, *args: str) -> list[tuple[str, str]]:
    """(XY, path) of each entry of `git status --porcelain -z`."""
    tokens = _run_git(repo, "status", "--porcelain", "-z", *args).split("\0")
    entries, i = [], 0
    while i < len(tokens):
        if tokens[i]:
            entries.append((tokens[i][:2], tokens[i][3:]))
            if tokens[i][0] in "RC":
                i += 1      # the next token is the old path of a rename or copy
        i += 1
    return entries


def _walk_roots(start: Path) -> list[Path]:
    """The git repositories from `start` upwards. The walk stops at a repository that does not
    hold the one before it as a submodule."""
    dependencies = _dependencies()
    found: list[Path] = []
    for root in dependencies.roots(start):
        if not (root / ".git").exists():
            break
        if found and found[-1].relative_to(root).as_posix() not in dependencies.submodules(root).values():
            break
        found.append(root)
    return found


def _new_recipient_files(vault: Path) -> list[str]:
    """The untracked and changed files in recipients/ of the vault; no deleted files."""
    return sorted(path for xy, path in _status(vault, "--untracked-files=all", "--", "recipients")
                  if "D" not in xy and RECIPIENT_FILE.match(Path(path).name))


def _behind(repo: Path) -> int:
    return int(_run_git(repo, "rev-list", "--count", "HEAD..@{u}").strip())


def push_enrol_plan(start: Path | str | None = None) -> list[PushStep]:
    """The commits of push-enrol, innermost repository first.

    Each vault-* submodule of the repositories from `start` (default: the working folder)
    upwards gives a commit of its new recipient files. Each repository on the walk gives a
    commit of the pointers of the submodules that get a commit. Nothing is changed.
    """
    dependencies = _dependencies()
    roots = _walk_roots(Path(start) if start is not None else Path.cwd())
    commits: dict[Path, tuple[list[str], str]] = {}
    names: dict[Path, list[str]] = {}
    for root in roots:
        for name, rel in dependencies.submodules(root).items():
            vault = (root / rel).resolve()
            if name.startswith("vault-") and vault not in commits and (vault / ".git").exists():
                files = _new_recipient_files(vault)
                if files:
                    names[vault] = sorted({RECIPIENT_FILE.match(Path(f).name)[1] for f in files})
                    commits[vault] = (files, "Enrol " + ", ".join(names[vault]))
    for root in roots:
        moved = [(name, rel, (root / rel).resolve()) for name, rel in dependencies.submodules(root).items()]
        moved = [(name, rel, path) for name, rel, path in moved if path in commits and path != root]
        if moved and root not in commits:
            names[root] = sorted({n for _, _, path in moved for n in names[path]})
            commits[root] = ([rel for _, rel, _ in moved],
                             f"Point {', '.join(name for name, _, _ in moved)} to the enrolment of "
                             + ", ".join(names[root]))
    steps = []
    for repo, (paths, message) in commits.items():
        branch = _git(repo, "symbolic-ref", "-q", "--short", "HEAD")
        if not branch:
            raise CredentialError(f"{repo} has a detached HEAD: check out a branch first")
        upstream = _git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
        if not upstream:
            raise CredentialError(f"the branch {branch} in {repo} has no upstream branch")
        _run_git(repo, "fetch", "-q")
        others = [path for _, path in _status(repo, "--untracked-files=no") if path not in paths]
        if _behind(repo) and others:
            raise CredentialError(f"{repo} is behind {upstream} and has other changes: pull first")
        steps.append(PushStep(repo, branch, upstream, paths, message))
    return steps


def push_enrol(steps: list[PushStep]) -> None:
    """Commit and push each step. Only the paths of a step go into its commit."""
    for s in steps:
        _run_git(s.repo, "add", "--", *s.paths)
        _run_git(s.repo, "commit", "-q", "-m", s.message, "--", *s.paths)
        if _behind(s.repo):
            try:
                _run_git(s.repo, "pull", "-q", "--rebase")
            except CredentialError as exc:
                _git(s.repo, "rebase", "--abort")
                raise CredentialError(f"{exc}\nthe commit in {s.repo} is not pushed: "
                                      f"rebase it on {s.upstream}, then run push-enrol again") from None
        _run_git(s.repo, "push", "-q")


# -- API and CLI -----------------------------------------------------------------------

def _tty() -> bool:
    return sys.stdin is not None and sys.stdin.isatty()


def _print_system(c: Credential) -> None:
    """Name, url and secret names on one line, then one indented line for each authority info line."""
    print(f"{c.name}\t{c.url or '-'}\t{','.join(c.secrets()) or '-'}")
    for line in c.authority_info:
        print(f"  {line}")


def _prompt_new_passphrase() -> str:
    if not _tty():
        raise CredentialError("a new passphrase must be typed in a terminal")
    first = getpass.getpass("New master passphrase: ")
    if not first:
        raise CredentialError("the new passphrase must not be empty")
    if first != getpass.getpass("Repeat new master passphrase: "):
        raise CredentialError("passphrases do not match")
    return first


def _yes(question: str, default: bool) -> bool:
    answer = input(f"{question} [{'Y/n' if default else 'y/N'}] ").strip().lower()
    return default if not answer else answer in ("y", "yes")


def get_credential(system: str, vault_home: Path | str,
                   passphrase: str | None = None) -> Credential:
    return Store(vault_home, passphrase).get_credential(system)


def _push_enrol_cli() -> None:
    if not (_tty() and sys.stdout.isatty()):
        raise CredentialError("push-enrol runs only in a terminal")
    steps = push_enrol_plan()
    if not steps:
        print("no new recipient files in the vaults of the repositories from here upwards")
        return
    for s in steps:
        print(f"{s.repo}\t{s.branch} -> {s.upstream}\n  {s.message}")
        for path in s.paths:
            print(f"    {path}")
    if not _yes("Commit and push these changes?", False):
        print("nothing changed")
        return
    push_enrol(steps)
    for s in steps:
        print(f"pushed {s.repo}")


def _enrol_cli(store: Store, name: str | None) -> None:
    provider: Provider | str | None = "auto"
    if _tty():
        for p, n in store.list_keyring_secrets():
            if _yes(f"Delete the key passphrase of {n!r} in {p} (its key file stops working)?", False):
                store.delete_keyring_secrets([n])
        found = available_providers()
        provider = found[0] if found and _yes(f"Keep the key passphrase in {found[0].name}?", True) else None
        store.prompt = "Master passphrase (empty: leave a request): "
    name, fp, approved = store.enrol(name, provider)
    print(f"recipient\t{name}\nfingerprint\t{fp}")
    provider_name = _key_provider(store.home / f"clone.{name}.key")
    if provider_name:
        print(f"key\tencrypted, key passphrase in {provider_name}")
    else:
        print("key\tplain, not encrypted: no keyring was used")
    if approved:
        print(f"enrolled: commit and push {store.recipients}")
    else:
        print(f"request: commit and push {store.recipients / (name + '.pub')}, then run "
              f"`approve-enrol {name}` in a trusted clone")


def main(argv: list[str] | None = None) -> int:
    global _CLI
    _CLI = True
    ap = argparse.ArgumentParser(prog="credstore", description="Credential vault (see docs/clone-keys.md).")
    where = ap.add_mutually_exclusive_group()
    where.add_argument("--vault-home", metavar="DIR", help="the folder of the vault")
    where.add_argument("--vault", metavar="NAME",
                       help="the folder name of the vault, e.g. vault-main, found by .gitmodules or dependencies.txt")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("create-vault", help="create a vault: master key, admin key, empty vault.json, git hook")
    p = sub.add_parser("enrol", help="make a key pair for this clone; self-enrol in a terminal, else leave a request")
    p.add_argument("name", nargs="?", help="recipient name (default: a generated one)")
    p = sub.add_parser("approve-enrol", help="wrap the master key for a request")
    p.add_argument("name")
    p = sub.add_parser("unenrol", help="delete the recipient files of this clone, or of NAME; no rotation")
    p.add_argument("name", nargs="?", help="recipient name (default: this clone)")
    p = sub.add_parser("delete-private-clone-key", help="delete the private key of this clone, or of NAME, "
                                                        "after unenrol is pushed")
    p.add_argument("name", nargs="?", help="recipient name (default: this clone)")
    p = sub.add_parser("unenrol-and-rotate-master-key", help="delete a recipient, then make a new master key")
    p.add_argument("name")
    sub.add_parser("rotate-master-key", help="new master key, same passphrase")
    sub.add_parser("change-passphrase", help="encrypt master.enc.key with a new passphrase")
    sub.add_parser("list-keyring-secrets", help="key passphrases of this tool in the providers")
    p = sub.add_parser("delete-keyring-secret", help="delete key passphrases, and the key files they open")
    p.add_argument("names", nargs="+", metavar="NAME", help="recipient name")
    sub.add_parser("delete-all-keyring-secrets", help="delete each key passphrase, and the key files they open")
    sub.add_parser("push-enrol", help="commit and push the new recipient files of each vault, and the submodule "
                                      "pointers above them; only in a terminal")
    sub.add_parser("list-systems", help="show all systems as get-system does; only in a terminal, needs the passphrase")
    p = sub.add_parser("edit", help="write an edit file for each system; secret values empty")
    p.add_argument("systems", nargs="+", metavar="SYSTEM")
    sub.add_parser("sync", help="apply the edit files to the vault, then delete them")
    p = sub.add_parser("get-system", help="show a system: url, secret names, authority info; no values")
    p.add_argument("system", help="name, entry ID or encrypted name; an ID or an encrypted name needs the passphrase")
    p = sub.add_parser("get-secret", help="print one secret value")
    p.add_argument("system")
    p.add_argument("key")
    p = sub.add_parser("set-system", help="add or update a system")
    p.add_argument("system")
    p.add_argument("--url")
    p.add_argument("--info", action="append", help="authority_info line (repeatable)")
    p.add_argument("--secret", action="append", default=[], metavar="KEY=VALUE")
    p = sub.add_parser("delete-system", help="delete a system")
    p.add_argument("system")
    p = sub.add_parser("rename-system", help="rename a system")
    p.add_argument("system")
    p.add_argument("new")
    p = sub.add_parser("rename-secret", help="rename a secret key of a system")
    p.add_argument("system")
    p.add_argument("old")
    p.add_argument("new")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "create-vault":
            if not a.vault_home:
                raise CredentialError("give the folder of the new vault with --vault-home DIR")
            store = Store(a.vault_home, interactive=_tty())
            for path in store.create_vault():
                print(f"wrote {path}")
            print(f"next: enrol this clone, add systems with edit and sync, then run setup.sh in {store.home}")
            return 0
        if a.cmd == "push-enrol":
            _push_enrol_cli()
            return 0
        store = Store(vault_home(a.vault, a.vault_home), interactive=_tty())
        if a.cmd == "enrol":
            _enrol_cli(store, a.name)
        elif a.cmd == "approve-enrol":
            info = store.request_info(a.name) or "no request info\n"
            print(f"approved {a.name}\n{info}fingerprint\t{store.approve_enrol(a.name)}\n"
                  f"compare it with the output of enrol, then commit and push {store.recipients}")
        elif a.cmd == "unenrol":
            name = store.unenrol(a.name)
            print(f"unenrolled {name}; commit and push the vault home"
                  + ("" if a.name else ", then run delete-private-clone-key"))
        elif a.cmd == "delete-private-clone-key":
            print(f"deleted the private clone key of {store.delete_private_clone_key(a.name)}")
        elif a.cmd == "unenrol-and-rotate-master-key":
            backup = store.unenrol_and_rotate_master_key(a.name)
            print(f"unenrolled {a.name}; new master key (backup: {backup}); commit and push the vault home")
        elif a.cmd == "rotate-master-key":
            backup = store.rotate_master_key()
            print(f"new master key; vault re-encrypted (backup: {backup}); commit and push the vault home")
        elif a.cmd == "change-passphrase":
            store._confirm_passphrase()
            backup = store.change_passphrase(_prompt_new_passphrase())
            print(f"passphrase changed (backup: {backup})")
        elif a.cmd == "list-keyring-secrets":
            for provider, name in store.list_keyring_secrets():
                print(f"{provider}\t{name}")
        elif a.cmd in ("delete-keyring-secret", "delete-all-keyring-secrets"):
            removed = (store.delete_keyring_secrets(a.names) if a.cmd == "delete-keyring-secret"
                       else store.delete_all_keyring_secrets())
            for provider, name in removed:
                print(f"removed {name} from {provider}")
        elif a.cmd == "list-systems":
            if not _tty():
                raise CredentialError("list-systems runs only in a terminal: it needs the master passphrase")
            for name in store.list_systems():
                _print_system(store._need(name))
        elif a.cmd == "edit":
            for path in store.edit(a.systems):
                print(path)
        elif a.cmd == "sync":
            print(f"synced {len(store.sync())} system(s); commit and push the vault home")
        elif a.cmd == "get-system":
            _print_system(store.get_system(a.system))
        elif a.cmd == "get-secret":
            print(store.get_secret(a.system, a.key))
        elif a.cmd == "set-system":
            pairs = [s.partition("=") for s in a.secret]
            if any(not sep or not k for k, sep, _ in pairs):
                raise CredentialError("--secret expects KEY=VALUE")
            store.set_system(a.system, a.url, a.info, {k: v for k, _, v in pairs})
            print(f"stored {a.system!r}")
        elif a.cmd == "delete-system":
            store.delete_system(a.system)
            print(f"deleted {a.system!r}")
        elif a.cmd == "rename-system":
            store.rename_system(a.system, a.new)
            print("renamed")
        elif a.cmd == "rename-secret":
            store.rename_secret(a.system, a.old, a.new)
            print("renamed")
        return 0
    except CredentialError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

"""credstore - credential vault for the tools in this repository.

Design: docs/clone-keys.md. The vault home (--vault-home, default: ./vaults/vault-main, then
<this folder>/vaults/vault-main) holds:

credentials.json        committed index: system -> url, authority_info, credentials (values cleared)
credentials.enc         committed vault: the same document, with secret values, encrypted with
                        the master key (the `openssl enc -aes-256-cbc -pbkdf2` format)
master.enc.key          the master key, encrypted with the passphrase
recipients/<name>.pub   public key of a clone; <name>.master.enc is the master key for it;
                        <name>.inf tells the approver which clone made the request
clone.<name>.key        gitignored private key of a clone for this vault: plain, or encrypted
                        with a key passphrase that a provider (the OS keyring) holds
access.log              gitignored access log

A clone key opens the vault. Else the passphrase does: the API parameter, or a prompt of
the CLI in an interactive terminal. This tool never reads environment variables.

The two files mirror each other exactly, except that only the vault holds secret values.
credentials.json is the source of truth for structure; the vault is stale data that fills
in secrets. Commands read credentials.json first and decrypt only when values are needed.
Files are rewritten only when their content changes.

A system with "alias_of" takes the secrets of its target. Its own secrets add to them or
replace them. get_credential() and list give the resolved secrets.

    from credstore import get_credential          # PYTHONPATH must include this folder
    c = get_credential("jira", vault_home="vault-home"); c.secrets()["token"]
"""

from __future__ import annotations

import argparse
import configparser
import getpass
import io
import ipaddress
import json
import platform
import re
import shutil
import socket
import subprocess
import sys
from base64 import b64encode
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from secrets import token_bytes
from types import MappingProxyType
from typing import Mapping

TOOL = Path(__file__).resolve().parents[1]   # tools/auth; this file is in src/
VAULT_DIR = "vaults/vault-main"       # the default vault home, looked up by find_vault_home()
BACKUPS = TOOL / ".local_assets"      # key operations copy the files here first
TEMPLATES = TOOL / "templates"        # the files that create-vault puts next to a new vault
SETUP = [TOOL.parents[1] / name for name in ("setup.sh", "setup.bat")]   # create-vault copies them too
RECIPIENTS = "recipients"             # public keys and wrapped master keys
LOG = "access.log"                    # in the vault home, gitignored
IGNORED = ("clone.*.key", LOG)        # the vault home must ignore these; see _ensure_ignored()
KEY_BITS = 3072
PROVIDER_LINE = "credstore-provider:"  # first line of a key file that a provider unlocks
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
ID_LIMIT = 30                         # generated names: computer-user-repo, without auto- and the date


class CredentialError(RuntimeError):
    pass


class NoWayToOpen(CredentialError):
    """No clone key opens the vault and no passphrase was given."""


EXAMPLE = {  # the credentials.json that create-vault writes; fill the secrets in, then run sync
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


def _check_name(name: str, what: str) -> str:
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise CredentialError(f"{what} name {name!r} is not valid: use letters, digits, '.', '_', '-'")
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
    """Private keys and the access log must never be committed."""
    path = home / ".gitignore"
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    missing = [p for p in IGNORED if p not in lines]
    if missing and home.is_dir():
        _write(path, ("\n".join(lines + ["# Private keys of clones, and the access log", *missing]) + "\n").encode())


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

    The vault column is always "main": it stays for the format of existing logs."""
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

def find_vault_home(vault_home: Path | str | None = None) -> Path:
    """The given folder, else ./vaults/vault-main, else vaults/vault-main next to this script."""
    if vault_home:
        return Path(vault_home)
    for candidate in (Path.cwd() / VAULT_DIR, TOOL / VAULT_DIR):
        if candidate.is_dir():
            return candidate
    raise CredentialError(
        f"no vault found in ./{VAULT_DIR} or {TOOL / VAULT_DIR} - "
        f"give its folder with --vault-home DIR, or create one with create-vault")


class Store:
    """The vault of `vault_home`.

    `passphrase` opens the vault when no clone key does. `interactive` lets the CLI ask
    for it in a terminal.
    """

    def __init__(self, vault_home: Path | str | None = None, passphrase: str | None = None,
                 interactive: bool = False):
        self.home = find_vault_home(vault_home)
        self.index = self.home / "credentials.json"
        self.vault = self.home / "credentials.enc"
        self.recipients = self.home / RECIPIENTS
        self.key_enc = self.home / "master.enc.key"
        self.interactive = interactive
        self.prompt = "Master passphrase: "
        self.method = ""                   # how the vault was opened, for the access log
        self._passphrase = passphrase
        self._key: str | None = None       # the master key, once loaded
        self._stored: bytes | None = None  # canonical vault content as last read/written

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
        """The passphrase, checked against master.enc.key: writing it needs the passphrase."""
        self._load_key()
        passphrase = self._ask_passphrase()
        if not passphrase:
            raise CredentialError("this command needs the master passphrase: run it in a terminal, "
                                  "or give passphrase= to the API")
        try:
            same = _read_key(decrypt(self.key_enc.read_bytes(), passphrase, "master key"), self.key_enc) == self._key
        except CredentialError:
            same = False
        if not same:
            raise CredentialError("the passphrase does not open master.enc.key")
        return passphrase

    # -- files --------------------------------------------------------------------------

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

    def _save(self, systems: dict[str, Credential]) -> dict[str, Credential]:
        content = _canonical(systems)
        if content != self._stored:
            _write(self.vault, encrypt(content, self._load_key()))
            self._stored = content
        index = (json.dumps(_document(systems, redact=True), indent=2) + "\n").encode()
        if not self.index.exists() or self.index.read_bytes() != index:
            _write(self.index, index)
        return systems

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
        for path in (self.key_enc, self.vault):
            if path.exists():
                shutil.copy2(path, target / path.name)
        if self.recipients.is_dir():
            shutil.copytree(self.recipients, target / self.recipients.name, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("*.tmp"))
        return target

    # -- master key -----------------------------------------------------------------------

    def create_vault(self) -> list[Path]:
        """A new vault: master key, example credentials.json, the files from templates/, setup scripts.

        Stops if any vault file exists already. Template files that exist are kept.
        """
        existing = [p for p in (self.key_enc, self.index, self.vault) if p.exists()]
        if existing:
            raise CredentialError(f"a vault exists already: {', '.join(map(str, existing))}")
        passphrase = self._passphrase or _prompt_new_passphrase()   # before any file is written
        self.home.mkdir(parents=True, exist_ok=True)
        self._new_key(passphrase)
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
        """A new random master key, stored encrypted with the passphrase."""
        key = _new_master_key()
        _write(self.key_enc, encrypt((key + "\n").encode(), passphrase))
        self._key = key

    def rotate_master_key(self, backup: Path | None = None) -> Path:
        """A new master key, wrapped for each approved recipient and with the passphrase.

        Returns the backup.
        """
        stored, order = self._read_vault(), list(self.read_index())
        systems = {**{n: stored[n] for n in order if n in stored}, **stored}   # keep the index order
        passphrase = self._confirm_passphrase()
        backup = backup or self._backup("rotate-master-key")
        self._new_key(passphrase)
        self._stored = None       # the vault must be written again, under the new key
        self._save(systems)
        self._wrap_all(self._key)
        _log(self.home, "rotate-master-key", method=self.method)
        return backup

    def change_passphrase(self, new: str) -> Path:
        """Encrypt master.enc.key with a new passphrase. Key and vault are untouched."""
        key = self._load_key()
        backup = self._backup("change-passphrase")
        _write(self.key_enc, encrypt((key + "\n").encode(), new))
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
        self._read_vault()
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

    def sync(self) -> dict[str, Credential]:
        """Mirror credentials.json into the vault and clear the index's secret values."""
        return self._save(_merge(self.read_index(), self._read_vault()))

    def get_system(self, system: str) -> Credential:
        """A system, with no access log line. Use get_credential() or get_secret() to hand out secrets."""
        systems = _resolve(self.sync())
        if system not in systems:
            raise CredentialError(f"unknown system {system!r} (known: {', '.join(systems) or 'none'})")
        return systems[system]

    def get_credential(self, system: str) -> Credential:
        """A system with all its secrets. Logs each secret."""
        c = self.get_system(system)
        _log(self.home, "get", c.name, list(c.secrets()), self.method)
        return c

    def get_secret(self, system: str, key: str) -> str:
        """One secret value. Logs only this secret."""
        c = self.get_system(system)
        if key not in c.secrets():
            raise CredentialError(f"no secret {key!r} in system {system!r} "
                                  f"(known: {', '.join(c.secrets()) or 'none'})")
        _log(self.home, "get", c.name, [key], self.method)
        return c.secrets()[key]

    def set_system(self, system: str, url: str | None = None, authority_info: list | None = None,
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

    def rename_system(self, system: str, new: str) -> None:
        """Rename a system, keeping the stored values."""
        self._rename(system, new)

    def rename_secret(self, system: str, old: str, new: str) -> None:
        """Rename a secret key of a system, keeping the stored value."""
        self._rename(system, new, secret=old)

    def _rename(self, system: str, new: str, secret: str | None = None) -> None:
        """Reads both files without merging first: the index may already carry the new name."""
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

def _tty() -> bool:
    return sys.stdin is not None and sys.stdin.isatty()


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


def get_credential(system: str, vault_home: Path | str | None = None,
                   passphrase: str | None = None) -> Credential:
    return Store(vault_home, passphrase).get_credential(system)


def list_systems(vault_home: Path | str | None = None) -> list[str]:
    """System names from credentials.json - no key, no decryption."""
    return list(Store(vault_home).read_index())


def unenrol_all_vaults(vaults: Path | str | None = None) -> list[tuple[Path, str]]:
    """Unenrol this clone in each vault-* folder of `vaults` (default: the folder of the vault home).

    Unenrols each recipient whose private key is in the vault home. Returns (vault home, name).
    """
    folder = Path(vaults) if vaults else find_vault_home().parent
    done = [(store.home, store.unenrol(name))
            for store in (Store(d) for d in sorted(folder.glob("vault-*")) if d.is_dir())
            for name in store.own_recipients()]
    if not done:
        raise CredentialError(f"this clone has no recipient in a vault in {folder}")
    return done


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
    if approved:
        print(f"enrolled: commit and push {store.recipients}")
    else:
        print(f"request: commit and push {store.recipients / (name + '.pub')}, then run "
              f"`approve-enrol {name}` in a trusted clone")


def main(argv: list[str] | None = None) -> int:
    global _CLI
    _CLI = True
    ap = argparse.ArgumentParser(prog="credstore", description="Credential vault (see docs/clone-keys.md).")
    ap.add_argument("--vault-home", metavar="DIR",
                    help=f"vault home (default: ./{VAULT_DIR}, then {VAULT_DIR} next to this script)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("create-vault", help="create a vault: master key, example credentials.json, git hook")
    p = sub.add_parser("enrol", help="make a key pair for this clone; self-enrol in a terminal, else leave a request")
    p.add_argument("name", nargs="?", help="recipient name (default: a generated one)")
    p = sub.add_parser("approve-enrol", help="wrap the master key for a request")
    p.add_argument("name")
    p = sub.add_parser("unenrol", help="delete the recipient files of this clone, or of NAME; no rotation")
    p.add_argument("name", nargs="?", help="recipient name (default: this clone)")
    sub.add_parser("unenrol-all-vaults", help="unenrol this clone in each vault next to the vault home")
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
    sub.add_parser("sync", help="mirror credentials.json into the vault and clear its secrets")
    sub.add_parser("list", help="systems, urls and secret names from credentials.json")
    p = sub.add_parser("get-system", help="show a system: url, secret names, authority info; no values")
    p.add_argument("system")
    p = sub.add_parser("get-secret", help="print one secret value")
    p.add_argument("system")
    p.add_argument("key")
    p = sub.add_parser("set-system", help="add or update a system")
    p.add_argument("system")
    p.add_argument("--url")
    p.add_argument("--info", action="append", help="authority_info line (repeatable)")
    p.add_argument("--secret", action="append", default=[], metavar="KEY=VALUE")
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
            store = Store(a.vault_home or Path.cwd() / VAULT_DIR, interactive=_tty())
            for path in store.create_vault():
                print(f"wrote {path}")
            print(f"next: fill the secrets in {store.index}, run sync, enrol this clone, "
                  f"then run setup.sh in {store.home}")
            return 0
        if a.cmd == "unenrol-all-vaults":
            for home, name in unenrol_all_vaults(Path(a.vault_home).parent if a.vault_home else None):
                print(f"unenrolled {name} in {home}")
            print("commit and push each vault home; then run delete-private-clone-key in each")
            return 0
        store = Store(a.vault_home, interactive=_tty())
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
            store._load_key()
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
        elif a.cmd == "sync":
            print(f"synced {len(store.sync())} system(s)")
        elif a.cmd == "list":
            for name, c in _resolve(store.read_index()).items():
                print(f"{name}\t{c.url or '-'}\t{','.join(c.secrets()) or '-'}")
        elif a.cmd == "get-system":
            c = store.get_system(a.system)
            print(f"{c.name}\t{c.url or '-'}\t{','.join(c.secrets()) or '-'}")
            for line in c.authority_info:
                print(f"  {line}")
        elif a.cmd == "get-secret":
            print(store.get_secret(a.system, a.key))
        elif a.cmd == "set-system":
            pairs = [s.partition("=") for s in a.secret]
            if any(not sep or not k for k, sep, _ in pairs):
                raise CredentialError("--secret expects KEY=VALUE")
            store.set_system(a.system, a.url, a.info, {k: v for k, _, v in pairs})
            print(f"stored {a.system!r}")
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

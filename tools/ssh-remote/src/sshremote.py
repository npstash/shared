"""Run commands on remote Linux machines over SSH, with the credentials from the vault.

The passwords go from the vault to paramiko and to the stdin of sudo. They never go to a
command line, an environment variable, a file or the output.

    run.sh hosts
    run.sh exec HOST [--sudo] -- CMD ...
    run.sh upload HOST LOCAL REMOTE [--sudo]
    run.sh download HOST REMOTE LOCAL
"""
from __future__ import annotations

import argparse
import shlex
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import paramiko

from credstore import CredentialError, Store
from dependencies import DependencyError, find

TOOL = Path(__file__).resolve().parent.parent
SSH_SUFFIX = " SSH"      # an SSH system is "<HOST> SSH...", e.g. "NUC15 SSH in LAN"
SUDO_SUFFIX = " SUDO"    # its sudo system is "<HOST> SUDO"
CONNECT_TIMEOUT = 15     # seconds
POLL = 0.05              # seconds between reads of a channel


class RemoteError(RuntimeError):
    pass


@dataclass(frozen=True)
class Target:
    """The vault systems of one host. No secrets."""

    ssh_system: str
    sudo_system: str | None
    hostname: str
    port: int


def vault_home(arg: str | None) -> Path:
    if arg:
        return Path(arg)
    try:
        return find("vault-main", TOOL)
    except DependencyError as exc:
        raise RemoteError(f"{exc}; give --vault-home") from exc


def ssh_systems(home: Path) -> dict[str, str | None]:
    """SSH system name -> url, from the plaintext index."""
    return {n: c.url for n, c in Store(home).read_index().items() if SSH_SUFFIX in n}


def parse_url(system: str, url: str | None) -> tuple[str, int]:
    parts = urlsplit(url or "")
    if parts.scheme != "ssh" or not parts.hostname:
        raise RemoteError(f"system {system!r} needs a url ssh://HOST[:PORT], not {url!r}")
    return parts.hostname, parts.port or 22


def resolve(home: Path, host: str, system: str | None = None, sudo_system: str | None = None) -> Target:
    index = Store(home).read_index()
    if system is None:
        prefix = (host + SSH_SUFFIX).casefold()
        found = [n for n in index if n.casefold().startswith(prefix)]
        if len(found) != 1:
            known = ", ".join(ssh_systems(home)) or "none"
            what = "no system" if not found else f"more than one system ({', '.join(found)})"
            raise RemoteError(f"{what} for {host!r}; give --system (SSH systems: {known})")
        system = found[0]
    elif system not in index:
        raise RemoteError(f"unknown system {system!r}")
    if sudo_system is None:
        name = host + SUDO_SUFFIX
        sudo_system = next((n for n in index if n.casefold() == name.casefold()), None)
    elif sudo_system not in index:
        raise RemoteError(f"unknown system {sudo_system!r}")
    hostname, port = parse_url(system, index[system].url)
    return Target(system, sudo_system, hostname, port)


def _login(home: Path, system: str) -> tuple[str, str]:
    secrets = Store(home).get_credential(system).secrets()
    for key in ("username", "password"):
        if not secrets.get(key):
            raise RemoteError(f"system {system!r} has no {key}; add it to the vault")
    return secrets["username"], secrets["password"]


def connect(home: Path, target: Target) -> paramiko.SSHClient:
    """Log in with the password. Accept only host keys from ~/.ssh/known_hosts; write nothing there."""
    user, password = _login(home, target.ssh_system)
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(target.hostname, target.port, username=user, password=password,
                       look_for_keys=False, allow_agent=False, timeout=CONNECT_TIMEOUT)
    except paramiko.SSHException as exc:
        client.close()
        if "not found in known_hosts" in str(exc):
            raise RemoteError(
                f"the host key of {target.hostname} is not in ~/.ssh/known_hosts. Check the fingerprint "
                f"and add the key in a terminal: ssh -p {target.port} {user}@{target.hostname}") from None
        raise RemoteError(f"{target.hostname}: {exc}") from None
    except OSError as exc:
        client.close()
        raise RemoteError(f"{target.hostname}:{target.port}: {exc}") from None
    return client


def _drain(channel, out, err) -> int:
    """Copy stdout and stderr of the channel until the command stops. Return the exit status."""
    while True:
        busy = False
        if channel.recv_ready():
            out.write(channel.recv(32768)); busy = True
        if channel.recv_stderr_ready():
            err.write(channel.recv_stderr(32768)); busy = True
        if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
            return channel.recv_exit_status()
        if not busy:
            time.sleep(POLL)


def _run(client: paramiko.SSHClient, command: str, out, err, stdin: bytes = b"") -> int:
    channel = client.get_transport().open_session()
    try:
        channel.exec_command(command)
        if stdin:
            channel.sendall(stdin)
        channel.shutdown_write()
        return _drain(channel, out, err)
    finally:
        channel.close()


class _Sink:
    def write(self, data: bytes) -> None:
        pass


def sudo_command(command: str, with_password: bool) -> str:
    """sudo to root. -k makes sudo always read the password from stdin."""
    flags = "-k -S -p ''" if with_password else "-n"
    return f"sudo {flags} -- sh -c {shlex.quote(command)}"


def run_command(home: Path, client: paramiko.SSHClient, target: Target, command: str,
                sudo: bool, out, err) -> int:
    if not sudo:
        return _run(client, command, out, err)
    if not target.sudo_system:
        raise RemoteError(f"no sudo system for {target.ssh_system!r}; add '<HOST>{SUDO_SUFFIX}' "
                          "to the vault or give --sudo-system")
    # sudo asks for the password of the SSH user; the SUDO system holds it.
    _, password = _login(home, target.sudo_system)
    # Send the password only if sudo asks for it. Else it would go to the stdin of the command.
    if _run(client, sudo_command("true", False), _Sink(), _Sink()) == 0:
        return _run(client, sudo_command(command, False), out, err)
    return _run(client, sudo_command(command, True), out, err, (password + "\n").encode())


def upload(home: Path, client: paramiko.SSHClient, target: Target, local: Path, remote: str,
           sudo: bool, err) -> int:
    sftp = client.open_sftp()
    try:
        if not sudo:
            sftp.put(str(local), remote)
            return 0
        tmp = f"/tmp/ssh-remote-{time.time_ns()}"
        sftp.put(str(local), tmp)
        try:
            # cat keeps the owner and the mode of an existing file.
            return run_command(home, client, target, f"cat {shlex.quote(tmp)} > {shlex.quote(remote)}",
                               True, _Sink(), err)
        finally:
            sftp.remove(tmp)
    finally:
        sftp.close()


def download(client: paramiko.SSHClient, remote: str, local: Path) -> int:
    sftp = client.open_sftp()
    try:
        sftp.get(remote, str(local))
    finally:
        sftp.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ssh-remote", description="Remote Linux machines over SSH, "
                                 "with the credentials from the vault.")
    ap.add_argument("--vault-home", help="the vault home; default: vault-main")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("hosts", help="list the SSH systems of the vault")

    def host_parser(name: str, help: str) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help)
        p.add_argument("host", help="the first part of the system name, e.g. NUC15")
        p.add_argument("--system", help="the SSH system; default: the one '<HOST> SSH...'")
        p.add_argument("--sudo-system", help="the sudo system; default: '<HOST> SUDO'")
        return p

    p = host_parser("exec", "run a command; the exit code is that of the command")
    p.add_argument("--sudo", action="store_true")
    p = host_parser("upload", "copy a local file to the host")
    p.add_argument("local", type=Path)
    p.add_argument("remote")
    p.add_argument("--sudo", action="store_true")
    p = host_parser("download", "copy a file from the host")
    p.add_argument("remote")
    p.add_argument("local", type=Path)
    argv = sys.argv[1:] if argv is None else argv
    split = argv.index("--") if "--" in argv else len(argv)
    argv, command = argv[:split], argv[split + 1:]     # the command of exec follows --
    a = ap.parse_args(argv)

    try:
        home = vault_home(a.vault_home)
        if a.cmd == "hosts":
            for name, url in ssh_systems(home).items():
                print(f"{name}\t{url or ''}")
            return 0
        if (a.cmd == "exec") != bool(command):
            ap.error("give a command after -- only to exec")
        target = resolve(home, a.host, a.system, a.sudo_system)
        client = connect(home, target)
        try:
            if a.cmd == "exec":
                cmd = command[0] if len(command) == 1 else shlex.join(command)
                return run_command(home, client, target, cmd, a.sudo,
                                   sys.stdout.buffer, sys.stderr.buffer)
            if a.cmd == "upload":
                return upload(home, client, target, a.local, a.remote, a.sudo, sys.stderr.buffer)
            return download(client, a.remote, a.local)
        finally:
            client.close()
    except (RemoteError, CredentialError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

"""Tests of sshremote.py with a fake vault and a fake SSH connection."""
import io
from types import MappingProxyType

import paramiko
import pytest

import sshremote as sr

INDEX = {
    "NUC15 SSH in LAN": {"url": "ssh://192.168.100.209", "credentials": {"username": "", "password": ""}},
    "NUC15 SUDO": {"credentials": {"username": "", "password": ""}},
    "ZOTAC2 SSH in LAN": {"url": "ssh://zotac:2222", "credentials": {"username": "", "password": ""}},
    "BAD SSH": {"url": "https://bad", "credentials": {"username": "", "password": ""}},
    "TWO SSH a": {"url": "ssh://a", "credentials": {}},
    "TWO SSH b": {"url": "ssh://b", "credentials": {}},
}
SECRETS = {
    "NUC15 SSH in LAN": {"username": "nestor", "password": "ssh-pw"},
    "NUC15 SUDO": {"username": "nestor", "password": "sudo-pw"},
    "ZOTAC2 SSH in LAN": {"username": "nestor", "password": ""},
}


class FakeCredential:
    def __init__(self, name):
        if name not in INDEX:
            raise sr.CredentialError(f"unknown system {name!r}")
        self.name, self.url = name, INDEX[name].get("url")

    def secrets(self):
        return MappingProxyType(SECRETS[self.name])


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(sr.Store, "get_credential", lambda self, name: FakeCredential(name))
    monkeypatch.setattr(sr.Store, "get_system", lambda self, name: FakeCredential(name))
    return tmp_path


NUC = ("NUC15 SSH in LAN", "NUC15 SUDO")


class FakeChannel:
    def __init__(self, result):
        self.out, self.err, self.status = result
        self.command = None
        self.stdin = b""
        self.closed_write = False

    def exec_command(self, command):
        self.command = command

    def sendall(self, data):
        self.stdin += data

    def shutdown_write(self):
        self.closed_write = True

    def recv_ready(self):
        return bool(self.out)

    def recv(self, n):
        data, self.out = self.out[:n], self.out[n:]
        return data

    def recv_stderr_ready(self):
        return bool(self.err)

    def recv_stderr(self, n):
        data, self.err = self.err[:n], self.err[n:]
        return data

    def exit_status_ready(self):
        return True

    def recv_exit_status(self):
        return self.status

    def close(self):
        pass


class FakeClient:
    """Each new channel gives the next (stdout, stderr, status) of `results`."""

    def __init__(self, *results):
        self.results = list(results)
        self.channels = []

    def get_transport(self):
        return self

    def open_session(self):
        self.channels.append(FakeChannel(self.results.pop(0)))
        return self.channels[-1]


def test_resolve_takes_the_exact_system_names(home):
    assert sr.resolve(home, *NUC) == sr.Target("NUC15 SSH in LAN", "NUC15 SUDO", "192.168.100.209", 22)
    assert sr.resolve(home, "ZOTAC2 SSH in LAN") == sr.Target("ZOTAC2 SSH in LAN", None, "zotac", 2222)
    t = sr.resolve(home, "TWO SSH b", "NUC15 SUDO")
    assert (t.ssh_system, t.sudo_system, t.hostname) == ("TWO SSH b", "NUC15 SUDO", "b")


def test_resolve_errors(home):
    with pytest.raises(sr.CredentialError, match="unknown system 'NUC15'"):
        sr.resolve(home, "NUC15")                          # no search by prefix
    with pytest.raises(sr.RemoteError, match="needs a url ssh://"):
        sr.resolve(home, "BAD SSH")
    with pytest.raises(sr.CredentialError, match="unknown system 'nope'"):
        sr.resolve(home, "NUC15 SSH in LAN", sudo_system="nope")


def test_the_tool_has_no_hosts_command(home):
    with pytest.raises(SystemExit):
        sr.main(["--vault-home", str(home), "hosts"])


def test_a_blank_password_is_an_error(home):
    with pytest.raises(sr.RemoteError, match="has no password"):
        sr._login(home, "ZOTAC2 SSH in LAN")


def test_connect_rejects_unknown_host_keys_and_uses_only_the_password(home, monkeypatch):
    seen = {}

    class Client:
        def load_system_host_keys(self):
            seen["known_hosts"] = True

        def set_missing_host_key_policy(self, policy):
            seen["policy"] = policy

        def connect(self, host, port, **kw):
            seen.update(host=host, port=port, **kw)

    monkeypatch.setattr(sr.paramiko, "SSHClient", Client)
    sr.connect(home, sr.resolve(home, *NUC))
    assert isinstance(seen["policy"], paramiko.RejectPolicy) and seen["known_hosts"]
    assert (seen["host"], seen["username"], seen["password"]) == ("192.168.100.209", "nestor", "ssh-pw")
    assert seen["look_for_keys"] is False and seen["allow_agent"] is False


def test_an_unknown_host_key_gives_the_command_for_the_user(home, monkeypatch):
    class Client:
        load_system_host_keys = set_missing_host_key_policy = close = lambda self, *a: None

        def connect(self, *a, **kw):
            raise paramiko.SSHException("Server '192.168.100.209' not found in known_hosts")

    monkeypatch.setattr(sr.paramiko, "SSHClient", Client)
    with pytest.raises(sr.RemoteError, match=r"ssh -p 22 nestor@192\.168\.100\.209") as e:
        sr.connect(home, sr.resolve(home, *NUC))
    assert "ssh-pw" not in str(e.value)


def test_exec_without_sudo(home):
    client, out, err = FakeClient((b"hi\n", b"warn\n", 3)), io.BytesIO(), io.BytesIO()
    assert sr.run_command(home, client, sr.resolve(home, *NUC), "echo hi", False, out, err) == 3
    assert (out.getvalue(), err.getvalue()) == (b"hi\n", b"warn\n")
    assert client.channels[0].command == "echo hi" and client.channels[0].stdin == b""


def test_sudo_sends_the_password_on_stdin_only_if_sudo_asks(home):
    client, out = FakeClient((b"", b"a password is required\n", 1), (b"0\n", b"", 0)), io.BytesIO()
    assert sr.run_command(home, client, sr.resolve(home, *NUC), "id -u", True, out, io.BytesIO()) == 0
    probe, run = client.channels
    assert probe.command == "sudo -n -- sh -c true" and probe.stdin == b""
    assert run.command == "sudo -k -S -p '' -- sh -c 'id -u'"
    assert run.stdin == b"sudo-pw\n" and run.closed_write
    assert out.getvalue() == b"0\n"
    assert "sudo-pw" not in probe.command + run.command


def test_sudo_without_a_password_prompt_sends_no_password(home):
    client = FakeClient((b"", b"", 0), (b"0\n", b"", 0))
    sr.run_command(home, client, sr.resolve(home, *NUC), "id -u", True, io.BytesIO(), io.BytesIO())
    assert client.channels[1].command.startswith("sudo -n ") and client.channels[1].stdin == b""


def test_sudo_needs_a_sudo_system(home):
    with pytest.raises(sr.RemoteError, match="--sudo needs --sudo-system"):
        sr.run_command(home, FakeClient(), sr.resolve(home, "ZOTAC2 SSH in LAN"), "id", True, io.BytesIO(), io.BytesIO())


def test_upload_with_sudo_goes_through_a_temporary_file(home, tmp_path):
    calls = []

    class Sftp:
        def put(self, local, remote):
            calls.append(("put", remote))

        def remove(self, remote):
            calls.append(("remove", remote))

        def close(self):
            pass

    client = FakeClient((b"", b"", 0), (b"", b"", 0))
    client.open_sftp = Sftp
    target = sr.resolve(home, *NUC)
    assert sr.upload(home, client, target, tmp_path / "f", "/etc/x y", True, io.BytesIO()) == 0
    tmp = calls[0][1]
    assert calls == [("put", tmp), ("remove", tmp)]
    assert client.channels[1].command == f"sudo -n -- sh -c 'cat {tmp} > '\"'\"'/etc/x y'\"'\"''"


def test_exec_cli_joins_the_arguments(home, monkeypatch):
    seen = {}

    class Client(FakeClient):
        def close(self):
            pass

    monkeypatch.setattr(sr, "connect", lambda home, target: Client())
    monkeypatch.setattr(sr, "run_command", lambda h, c, t, cmd, sudo, out, err: seen.update(cmd=cmd, sudo=sudo) or 5)
    run = lambda *a: sr.main(["--vault-home", str(home), "exec", "--system", NUC[0], *a])  # noqa: E731
    assert run("--sudo", "--sudo-system", NUC[1], "--", "ls", "-l", "a b") == 5
    assert seen == {"cmd": "ls -l 'a b'", "sudo": True}
    run("--", "ls | wc -l")
    assert seen["cmd"] == "ls | wc -l"


def test_errors_go_to_stderr_with_exit_code_1(home, capsys):
    assert sr.main(["--vault-home", str(home), "exec", "--system", "X", "--", "ls"]) == 1
    assert "error: unknown system 'X'" in capsys.readouterr().err


def test_sudo_needs_the_sudo_system_option(home, capsys):
    with pytest.raises(SystemExit):
        sr.main(["--vault-home", str(home), "exec", "--system", NUC[0], "--sudo", "--", "ls"])
    assert "--sudo needs --sudo-system NAME" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        sr.main(["--vault-home", str(home), "exec", "NUC15", "--", "ls"])   # --system is required


def test_the_vault_has_no_default(capsys, monkeypatch):
    import credstore
    monkeypatch.setattr(credstore, "known_vaults", lambda: ["vault-a"])
    assert sr.main(["exec", "--system", "X", "--", "ls"]) == 1
    assert "give the vault with --vault NAME or --vault-home DIR; vaults found: vault-a" in capsys.readouterr().err

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
import credstore as cs  # noqa: E402

PW = "test-passphrase"
SYS = "Github npstash/all 01"


@pytest.fixture(autouse=True)
def backups(tmp_path, monkeypatch):
    monkeypatch.setattr(cs, "BACKUPS", tmp_path / "backups")


@pytest.fixture
def home(tmp_path):
    vault = tmp_path / "private-data"
    cs.Store(vault, PW).init()
    return vault


def write_index(home, doc):
    (home / "credentials.json").write_text(json.dumps(doc))


def read_index(home):
    return json.loads((home / "credentials.json").read_text())


def entry(url="https://g", info=("scope line",), **secrets):
    return {"url": url, "authority_info": list(info), "credentials": dict(secrets)}


def stamp(path):
    return path.read_bytes(), path.stat().st_mtime_ns


# -- encryption --------------------------------------------------------------------------

@pytest.mark.parametrize("size", [0, 1, 15, 16, 17, 2000])
def test_the_format_is_openssl_enc_aes_256_cbc(size):
    data = (bytes(range(256)) * 8)[:size]
    out = cs.encrypt(data, "pw")
    assert out.startswith(b"Salted__")
    assert len(out) == 16 + 16 * (size // 16 + 1)          # header + salt + PKCS7-padded blocks
    assert cs.decrypt(out, "pw") == data
    assert cs.encrypt(data, "pw") != out                   # a fresh salt every time
    try:                                                   # CBC carries no MAC, so a wrong
        assert cs.decrypt(out, "wrong") != data            # key may pass the padding check
    except cs.CredentialError:
        pass


@pytest.mark.skipif(shutil.which("openssl") is None, reason="openssl is not installed")
def test_openssl_opens_the_vault_with_the_decrypted_master_key(home):
    """The two commands the README gives must really work, in both directions."""
    enc = lambda *a: subprocess.run(["openssl", "enc", "-aes-256-cbc", "-pbkdf2", *a],  # noqa: E731
                                    check=True, capture_output=True).stdout
    write_index(home, {SYS: entry(token="ghp_x")})
    cs.Store(home, PW).sync()
    key = home / "probe.key"                               # not master.key: that opens the vault
    enc("-d", "-in", str(home / "master.enc.key"), "-out", str(key), "-pass", f"pass:{PW}")
    out = enc("-d", "-in", str(home / "credentials.enc"), "-pass", f"file:{key}")
    assert json.loads(out)[SYS]["credentials"]["token"] == "ghp_x"
    assert cs.decrypt(enc("-in", str(key), "-pass", "pass:x"), "x") == key.read_bytes()


def test_corrupted_vault_is_rejected(home):
    write_index(home, {SYS: entry(info=["x" * 1000], token="t")})
    cs.Store(home, PW).sync()
    vault = home / "credentials.enc"
    data = vault.read_bytes()
    for broken in (data[:-1], b"NotSalt!" + data[8:], data[:16] + data[32:]):
        vault.write_bytes(broken)
        with pytest.raises(cs.CredentialError, match="corrupted|could not decrypt"):
            cs.Store(home, PW).sync()


# -- mirroring ---------------------------------------------------------------------------

def test_sync_stores_secrets_and_clears_them_in_the_index(home):
    write_index(home, {SYS: entry(username="npstash", token="ghp_x")})
    cs.Store(home, PW).sync()
    assert read_index(home) == {SYS: entry(username="", token="")}
    assert b"ghp_x" not in (home / "credentials.enc").read_bytes()
    c = cs.Store(home, PW).get(SYS)
    assert dict(c.secrets()) == {"username": "npstash", "token": "ghp_x"}
    assert (c.url, c.authority_info) == ("https://g", ("scope line",))


def test_blank_secret_keeps_the_stored_value(home):
    write_index(home, {SYS: entry(username="npstash", token="ghp_x")})
    cs.Store(home, PW).sync()
    write_index(home, {SYS: entry(username="", token="")})
    assert dict(cs.Store(home, PW).sync()[SYS].secrets()) == {"username": "npstash", "token": "ghp_x"}


def test_blank_secret_without_a_stored_value_is_an_error(home):
    write_index(home, {SYS: entry(username="npstash", token="")})
    with pytest.raises(cs.CredentialError, match="blank and the vault has no value"):
        cs.Store(home, PW).sync()


def test_index_removals_are_mirrored(home):
    write_index(home, {SYS: entry(token="t"), "other": entry(token="o")})
    cs.Store(home, PW).sync()
    write_index(home, {SYS: entry(token="")})
    assert list(cs.Store(home, PW).sync()) == [SYS]


def test_missing_index_empties_the_vault_and_writes_an_empty_index(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    (home / "credentials.json").unlink()
    assert cs.Store(home, PW).sync() == {}
    assert read_index(home) == {}
    assert cs.Store(home, PW).sync() == {}  # and stays empty


def test_metadata_changes_are_synced_while_secrets_are_kept(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    write_index(home, {SYS: entry(url="https://new", info=["new scope"], token="")})
    c = cs.Store(home, PW).sync()[SYS]
    assert (c.url, c.authority_info, dict(c.secrets())) == ("https://new", ("new scope",), {"token": "t"})


def test_files_are_rewritten_only_when_contents_change(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    vault, index = stamp(home / "credentials.enc"), stamp(home / "credentials.json")
    cs.Store(home, PW).sync()
    cs.Store(home, PW).get(SYS)
    assert stamp(home / "credentials.enc") == vault and stamp(home / "credentials.json") == index
    cs.Store(home, PW).set(SYS, secrets={"token": "changed"})
    assert (home / "credentials.enc").read_bytes() != vault[0]


# -- API ---------------------------------------------------------------------------------

def test_secrets_map_is_immutable(home):
    write_index(home, {SYS: entry(token="t")})
    with pytest.raises(TypeError):
        cs.Store(home, PW).sync()[SYS].secrets()["token"] = "x"


def test_list_systems_needs_no_passphrase(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    (home / "master.enc.key").rename(home / "away.key")  # no key, no passphrase
    assert cs.list_systems(home) == [SYS]
    assert list(cs.Store(home).read_index()[SYS].secrets()) == ["token"]


# -- rename ------------------------------------------------------------------------------

@pytest.mark.parametrize("index_name", ["old", "new"])  # rename before or after editing the index
def test_rename_system_keeps_secrets(home, index_name):
    write_index(home, {"old": entry(token="t")})
    cs.Store(home, PW).sync()
    write_index(home, {index_name: entry(token="")})
    cs.Store(home, PW).rename("old", "new")
    assert dict(cs.Store(home, PW).get("new").secrets()) == {"token": "t"}
    assert list(read_index(home)) == ["new"]


def test_rename_secret_keeps_value(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    cs.Store(home, PW).rename(SYS, "pat", secret="token")
    assert dict(cs.Store(home, PW).get(SYS).secrets()) == {"pat": "t"}


def test_rename_refuses_conflicts(home):
    write_index(home, {"a": entry(x="1", y="2"), "b": entry(z="3")})
    cs.Store(home, PW).sync()
    for system, new, secret in (("a", "b", None), ("missing", "c", None), ("a", "", None), ("a", "y", "x")):
        with pytest.raises(cs.CredentialError):
            cs.Store(home, PW).rename(system, new, secret=secret)


# -- errors, CLI -------------------------------------------------------------------------

def test_error_messages(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    with pytest.raises(cs.CredentialError, match="unknown system 'zz'"):
        cs.Store(home, PW).get("zz")
    # CBC carries no MAC, so roughly 0.4% of wrong passphrases pass the padding check and
    # the failure surfaces one step later. Every route gives a clear CredentialError.
    with pytest.raises(cs.CredentialError, match="could not decrypt the master key|"
                                                 "does not hold a usable master key|"
                                                 "could not decrypt the vault|vault is corrupted"):
        cs.Store(home, "wrong").sync()
    with pytest.raises(cs.CredentialError, match="no way to open the vault"):
        cs.Store(home).sync()           # neither a passphrase nor master.key


def test_cli(home, capsys):
    run = lambda *a: cs.main(["--vault-home", str(home), "--passphrase", PW, *a])  # noqa: E731
    write_index(home, {})                                  # drop the example entry of init
    assert run("set", SYS, "--url", "https://g", "--info", "scope", "--secret", "token=t") == 0
    assert run("rename", SYS, "--secret", "token=pat") == 0
    capsys.readouterr()
    assert run("get", SYS, "--secret", "pat") == 0
    assert capsys.readouterr().out == "t\n"
    assert run("list") == 0
    assert capsys.readouterr().out == f"{SYS}\thttps://g\tpat\n"
    assert run("get", SYS, "--secret", "nope") == 1
    assert run("get", "nope") == 1


# -- key rotation and the locally decrypted key --------------------------------------------

def plain_key(home):
    """What `openssl enc -d -in master.enc.key -out master.key` produces."""
    (home / "master.key").write_bytes(cs.decrypt((home / "master.enc.key").read_bytes(), PW))


def master_key(home):
    return (home / "master.enc.key").read_bytes()


def test_rotate_key_keeps_passphrase_and_secrets(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    old_key, old_vault = master_key(home), (home / "credentials.enc").read_bytes()

    backup = cs.Store(home, PW).rotate_key()

    assert master_key(home) != old_key
    assert (home / "credentials.enc").read_bytes() != old_vault
    assert dict(cs.Store(home, PW).get(SYS).secrets()) == {"token": "t"}   # same passphrase
    assert (backup / "master.enc.key").read_bytes() == old_key             # old key kept
    assert cs.decrypt(master_key(home), PW) != cs.decrypt(old_key, PW)     # a genuinely new key


def test_change_passphrase_leaves_the_key_and_vault_alone(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    key, vault = cs.decrypt(master_key(home), PW), (home / "credentials.enc").read_bytes()

    cs.Store(home, PW).change_passphrase("brand-new")

    assert cs.decrypt(master_key(home), "brand-new") == key   # same master key, new wrapping
    assert (home / "credentials.enc").read_bytes() == vault
    with pytest.raises(cs.CredentialError, match="could not decrypt the master key"):
        cs.Store(home, PW).sync()
    assert dict(cs.Store(home, "brand-new").get(SYS).secrets()) == {"token": "t"}


def test_rotation_and_passphrase_change_combine(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    cs.Store(home, PW).rotate_key()
    cs.Store(home, PW).change_passphrase("second")
    assert dict(cs.Store(home, "second").get(SYS).secrets()) == {"token": "t"}


def test_decrypted_key_opens_the_vault_without_a_passphrase(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    plain_key(home)
    assert dict(cs.Store(home).get(SYS).secrets()) == {"token": "t"}


def test_decrypted_key_together_with_a_passphrase_stops(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    plain_key(home)
    with pytest.raises(cs.CredentialError, match="two different ways to open the vault"):
        cs.Store(home, PW).sync()


def test_the_tool_never_reads_the_environment(home, monkeypatch):
    monkeypatch.setenv("CREDSTORE_PASSPHRASE", PW)
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    with pytest.raises(cs.CredentialError, match="no way to open the vault"):
        cs.Store(home).get(SYS)         # the variable is set, and ignored
    source = Path(cs.__file__).read_text()
    assert not any(call in source for call in ("os.environ", "getenv", "import os"))


def test_new_passphrase_is_typed_twice(monkeypatch):
    monkeypatch.setattr(cs.sys, "stdin", type("T", (), {"isatty": lambda self: True})())
    monkeypatch.setattr(cs.getpass, "getpass", lambda *a: next(typed))
    typed = iter(["abc", "xyz"])
    with pytest.raises(cs.CredentialError, match="do not match"):
        cs._prompt_new_passphrase()
    typed = iter(["abc", "abc"])
    assert cs._prompt_new_passphrase() == "abc"


# -- vault home and init -------------------------------------------------------------------

def test_vault_home_is_found_in_the_working_directory_first(tmp_path, monkeypatch):
    here, beside = tmp_path / "cwd" / "private-data", tmp_path / "tool" / "private-data"
    here.mkdir(parents=True)
    beside.mkdir(parents=True)
    monkeypatch.setattr(cs, "TOOL", tmp_path / "tool")
    monkeypatch.chdir(tmp_path / "cwd")
    assert cs.find_vault_home() == Path.cwd() / "private-data"
    here.rmdir()
    assert cs.find_vault_home() == beside
    beside.rmdir()
    with pytest.raises(cs.CredentialError, match="--vault-home"):
        cs.find_vault_home()
    assert cs.find_vault_home(tmp_path / "x") == tmp_path / "x"   # an explicit folder is not checked


def test_init_writes_a_vault_that_needs_the_secrets_filled_in(home):
    for name in ("master.enc.key", "credentials.json", ".gitignore", ".gitattributes",
                 ".githooks/pre-commit", "setup.sh", "setup.bat"):
        assert (home / name).is_file(), name
    assert not (home / "credentials.enc").exists()
    assert "master.key" in (home / ".gitignore").read_text().splitlines()
    assert read_index(home) == cs.EXAMPLE
    with pytest.raises(cs.CredentialError, match="blank and the vault has no value"):
        cs.Store(home, PW).sync()
    write_index(home, {SYS: entry(token="t")})
    assert dict(cs.Store(home, PW).get(SYS).secrets()) == {"token": "t"}


def test_init_refuses_an_existing_vault(home):
    with pytest.raises(cs.CredentialError, match="a vault exists already"):
        cs.Store(home, PW).init()


def test_init_defaults_to_private_data_in_the_working_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert cs.main(["--passphrase", PW, "init"]) == 0
    assert (tmp_path / "private-data" / "master.enc.key").is_file()


def test_backups_go_to_the_tool_folder_not_the_vault(home, tmp_path):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    backup = cs.Store(home, PW).rotate_key()
    assert backup.parent == tmp_path / "backups" and not (home / ".local_assets").exists()


def test_init_copies_the_setup_scripts_of_the_shared_repository(home):
    for source in cs.SETUP:
        assert (home / source.name).read_bytes() == source.read_bytes(), source.name


# -- pre-commit hook -------------------------------------------------------------------------

HOOK = cs.TEMPLATES / ".githooks" / "pre-commit"
needs_sh = pytest.mark.skipif(shutil.which("sh") is None or shutil.which("awk") is None,
                              reason="sh and awk are not installed")


def scan(text):
    r = subprocess.run(["sh", str(HOOK), "--scan"], input=text, capture_output=True, text=True)
    return r.returncode, r.stdout.splitlines()


SAMPLES = [
    {},
    {SYS: entry(username="", token="")},
    {SYS: entry(username="npstash", token="")},
    {SYS: entry(token="ghp_x"), "b": entry(pw="p"), "c": entry(x="")},
    {"a": {"credentials": {"n": 0, "f": False, "z": None, "e": [], "o": {}, "zero": 0.0}}},
    {"a": {"credentials": {"n": 1, "t": True, "l": [0], "o": {"k": ""}, "neg": -2.5e3}}},
    {"a": {"url": "https://u", "authority_info": ["x", "y"], "nested": {"credentials": {"k": "v"}}}},
    {"a": {"credentials": {"quote": 'say "hi" \\ there', "unicode": "\u017c"}}},
    {"a": "not an entry", "b": {"credentials": "not a map"}, "c": {"credentials": ["x"]}},
    ["a list", {"credentials": {"k": "v"}}],
    {"a b/c 01": {"credentials": {"token": "t"}}},
]


@needs_sh
@pytest.mark.parametrize("doc", SAMPLES)
@pytest.mark.parametrize("indent", [None, 2])
def test_hook_agrees_with_exposed_secrets(doc, indent):
    assert scan(json.dumps(doc, indent=indent)) == (0, cs.exposed_secrets(doc))


@needs_sh
@pytest.mark.parametrize("text", ['{"a": ', '{"a": "x}', '{"a" 1}', '{"a": 1} x', "{'a': 1}", '{"a": NaN}'])
def test_hook_rejects_invalid_json(text):
    assert scan(text)[0] == 2


@needs_sh
def test_hook_accepts_an_empty_file():
    assert scan("") == (0, [])


@needs_sh
def test_hook_blocks_a_commit_with_secrets(tmp_path):
    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, capture_output=True, text=True)

    git("init", "-q")
    git("config", "user.email", "t@t.invalid")
    git("config", "user.name", "t")
    (tmp_path / ".githooks").mkdir()
    shutil.copy(HOOK, tmp_path / ".githooks" / "pre-commit")
    (tmp_path / ".githooks" / "pre-commit").chmod(0o755)
    git("config", "core.hooksPath", ".githooks")

    (tmp_path / "credentials.json").write_text(json.dumps({SYS: entry(token="leak")}, indent=2))
    git("add", ".")
    blocked = git("commit", "-qm", "x")
    assert blocked.returncode != 0 and f"secret {SYS}.token is set" in blocked.stderr

    (tmp_path / "credentials.json").write_text(json.dumps({SYS: entry(token="")}, indent=2))
    git("add", ".")
    assert git("commit", "-qm", "x").returncode == 0

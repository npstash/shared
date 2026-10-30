import base64
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

import credstore as cs

PW = "test-passphrase"
SYS = "Github npstash/all 01"


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    """Backups into tmp_path, no real keyring, the caller from the Python stack."""
    monkeypatch.setattr(cs, "BACKUPS", tmp_path / "backups")
    monkeypatch.setattr(cs, "PROVIDERS", [])
    monkeypatch.setattr(cs, "_CLI", False)


class FakeProvider(cs.Provider):
    name = "fake"

    def __init__(self):
        self.entries = {}

    def available(self):
        return True

    def get(self, name):
        return self.entries.get(name)

    def set(self, name, value):
        self.entries[name] = value

    def delete(self, name):
        self.entries.pop(name, None)

    def list(self):
        return sorted(self.entries)


@pytest.fixture
def fake(monkeypatch):
    provider = FakeProvider()
    monkeypatch.setattr(cs, "PROVIDERS", [provider])
    return provider


@pytest.fixture
def home(tmp_path):
    vault = tmp_path / "vault-home"
    cs.Store(vault, PW).create_vault()
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
    key = home / "probe.key"
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
    c = cs.Store(home, PW).get_credential(SYS)
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
    cs.Store(home, PW).get_credential(SYS)
    assert stamp(home / "credentials.enc") == vault and stamp(home / "credentials.json") == index
    cs.Store(home, PW).set_system(SYS, secrets={"token": "changed"})
    assert (home / "credentials.enc").read_bytes() != vault[0]


# -- API ---------------------------------------------------------------------------------

def test_secrets_map_is_immutable(home):
    write_index(home, {SYS: entry(token="t")})
    with pytest.raises(TypeError):
        cs.Store(home, PW).sync()[SYS].secrets()["token"] = "x"


def test_list_systems_needs_no_key(home):
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
    cs.Store(home, PW).rename_system("old", "new")
    assert dict(cs.Store(home, PW).get_credential("new").secrets()) == {"token": "t"}
    assert list(read_index(home)) == ["new"]


def test_rename_secret_keeps_value(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    cs.Store(home, PW).rename_secret(SYS, "token", "pat")
    assert dict(cs.Store(home, PW).get_credential(SYS).secrets()) == {"pat": "t"}


def test_rename_refuses_conflicts(home):
    write_index(home, {"a": entry(x="1", y="2"), "b": entry(z="3")})
    cs.Store(home, PW).sync()
    for system, new in (("a", "b"), ("missing", "c"), ("a", "")):
        with pytest.raises(cs.CredentialError):
            cs.Store(home, PW).rename_system(system, new)
    with pytest.raises(cs.CredentialError):
        cs.Store(home, PW).rename_secret("a", "x", "y")


# -- aliases -----------------------------------------------------------------------------

def alias(target, url="https://a", info=("alias scope",), **secrets):
    e = {"url": url, "authority_info": list(info), "alias_of": target}
    return {**e, "credentials": dict(secrets)} if secrets else e


def test_alias_takes_the_secrets_of_its_target(home):
    write_index(home, {"LDAP": entry(username="u", password="p"), "wiki": alias("LDAP")})
    cs.Store(home, PW).sync()
    assert read_index(home)["wiki"] == alias("LDAP")      # no credentials block of its own
    c = cs.Store(home, PW).get_credential("wiki")
    assert (c.name, c.url, c.authority_info) == ("wiki", "https://a", ("alias scope",))
    assert dict(c.secrets()) == {"username": "u", "password": "p"}
    write_index(home, {"LDAP": entry(username="", password="new"), "wiki": alias("LDAP")})
    assert cs.Store(home, PW).get_credential("wiki").secrets()["password"] == "new"


def test_alias_secrets_add_to_and_replace_the_target_secrets(home):
    write_index(home, {"LDAP": entry(username="u", password="p"), "gh": alias("LDAP", username="x", token="t")})
    cs.Store(home, PW).sync()
    assert read_index(home)["gh"]["credentials"] == {"username": "", "token": ""}
    assert dict(cs.Store(home, PW).get_credential("gh").secrets()) == {"username": "x", "password": "p", "token": "t"}
    assert dict(cs.Store(home, PW).get_credential("LDAP").secrets()) == {"username": "u", "password": "p"}


@pytest.mark.parametrize("doc", [{"wiki": alias("missing")},
                                 {"LDAP": entry(p="p"), "a": alias("LDAP"), "b": alias("a")},
                                 {"a": alias("a")}])
def test_alias_target_must_exist_and_not_be_an_alias(home, doc):
    write_index(home, doc)
    with pytest.raises(cs.CredentialError, match="is an alias of"):
        cs.Store(home, PW).sync()


def test_set_refuses_an_inherited_secret_of_an_alias(home):
    write_index(home, {"LDAP": entry(password="p"), "gh": alias("LDAP", token="t")})
    with pytest.raises(cs.CredentialError, match="alias of 'LDAP'; set password there"):
        cs.Store(home, PW).set_system("gh", secrets={"password": "x"})
    cs.Store(home, PW).set_system("gh", url="https://new", secrets={"token": "t2", "extra": "e"})
    c = cs.Store(home, PW).get_credential("gh")
    assert (c.url, dict(c.secrets())) == ("https://new", {"password": "p", "token": "t2", "extra": "e"})


def test_rename_refuses_a_target_with_aliases(home):
    write_index(home, {"LDAP": entry(password="p"), "wiki": alias("LDAP")})
    cs.Store(home, PW).sync()
    with pytest.raises(cs.CredentialError, match="wiki are aliases of it"):
        cs.Store(home, PW).rename_system("LDAP", "AD")
    cs.Store(home, PW).rename_system("wiki", "docs")
    assert read_index(home)["docs"]["alias_of"] == "LDAP"
    assert cs.Store(home, PW).get_credential("docs").secrets()["password"] == "p"


def test_list_shows_the_resolved_secrets_of_an_alias(home, capsys):
    write_index(home, {"LDAP": entry(password="p"), "gh": alias("LDAP", token="t")})
    cs.Store(home, PW).sync()
    capsys.readouterr()
    assert cs.main(["--vault-home", str(home), "list"]) == 0
    assert capsys.readouterr().out == "LDAP\thttps://g\tpassword\ngh\thttps://a\tpassword,token\n"


# -- errors, CLI -------------------------------------------------------------------------

def test_error_messages(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    with pytest.raises(cs.CredentialError, match="unknown system 'zz'"):
        cs.Store(home, PW).get_credential("zz")
    # CBC carries no MAC, so roughly 0.4% of wrong passphrases pass the padding check and
    # the failure surfaces one step later. Every route gives a clear CredentialError.
    with pytest.raises(cs.CredentialError, match="could not decrypt the master key|"
                                                 "does not hold a usable master key|"
                                                 "could not decrypt the vault|vault is corrupted"):
        cs.Store(home, "wrong").sync()
    with pytest.raises(cs.NoWayToOpen, match="no way to open the vault.*enrol"):
        cs.Store(home).sync()           # neither a clone key nor a passphrase


def test_cli(home, capsys):
    cs.Store(home, PW).enrol("here", None)                 # the CLI opens the vault with this key
    run = lambda *a: cs.main(["--vault-home", str(home), *a])  # noqa: E731
    write_index(home, {})                                  # drop the example entry of init
    assert run("set-system", SYS, "--url", "https://g", "--info", "scope", "--secret", "token=t") == 0
    assert run("rename-secret", SYS, "token", "pat") == 0
    capsys.readouterr()
    assert run("get-secret", SYS, "pat") == 0
    assert capsys.readouterr().out == "t\n"
    assert run("get-system", SYS) == 0
    assert capsys.readouterr().out == f"{SYS}\thttps://g\tpat\n  scope\n"
    assert run("list") == 0
    assert capsys.readouterr().out == f"{SYS}\thttps://g\tpat\n"
    assert run("rename-system", SYS, "other") == 0
    assert run("get-secret", "other", "nope") == 1
    assert run("get-system", "nope") == 1
    for old in ("init", "approve", "revoke", "rotate-key", "key-list", "key-remove", "get", "set", "rename"):
        with pytest.raises(SystemExit):
            run(old)                                       # the old names are gone
    with pytest.raises(SystemExit):
        run("--passphrase", PW, "list")                    # the option is gone


def test_cli_without_a_key_or_terminal_cannot_open_the_vault(home, capsys):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    assert cs.main(["--vault-home", str(home), "get-system", SYS]) == 1
    assert "no way to open the vault" in capsys.readouterr().err


def test_the_cli_asks_for_the_passphrase_only_in_a_terminal(home, monkeypatch):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    asked = []
    monkeypatch.setattr(cs.getpass, "getpass", lambda prompt: asked.append(prompt) or PW)
    monkeypatch.setattr(cs, "_tty", lambda: False)
    assert cs.main(["--vault-home", str(home), "get-system", SYS]) == 1 and not asked
    monkeypatch.setattr(cs, "_tty", lambda: True)
    assert cs.main(["--vault-home", str(home), "get-system", SYS]) == 0 and asked == ["Master passphrase: "]


# -- key rotation ----------------------------------------------------------------------------

def master_key(home):
    return (home / "master.enc.key").read_bytes()


def test_rotate_master_key_keeps_passphrase_and_secrets(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    old_key, old_vault = master_key(home), (home / "credentials.enc").read_bytes()

    backup = cs.Store(home, PW).rotate_master_key()

    assert master_key(home) != old_key
    assert (home / "credentials.enc").read_bytes() != old_vault
    assert dict(cs.Store(home, PW).get_credential(SYS).secrets()) == {"token": "t"}   # same passphrase
    assert (backup / "master.enc.key").read_bytes() == old_key             # old key kept
    assert cs.decrypt(master_key(home), PW) != cs.decrypt(old_key, PW)     # a genuinely new key


def test_rotate_master_key_needs_the_passphrase_and_rewraps_for_each_clone(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    cs.Store(home, PW).enrol("a", None)
    cs.Store(home, PW).enrol("b", None)
    with pytest.raises(cs.CredentialError, match="needs the master passphrase"):
        cs.Store(home).rotate_master_key()                        # a clone key alone cannot write master.enc.key
    with pytest.raises(cs.CredentialError, match="does not open master.enc.key"):
        cs.Store(home, "wrong").rotate_master_key()
    old = (home / "recipients" / "b.master.enc").read_bytes()
    cs.Store(home, PW).rotate_master_key()
    assert (home / "recipients" / "b.master.enc").read_bytes() != old
    (home / "clone.a.key").unlink()
    store = cs.Store(home)
    assert dict(store.get_credential(SYS).secrets()) == {"token": "t"} and store.method == "clone-key:b:plain"


def test_change_passphrase_leaves_the_key_and_vault_alone(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    key, vault = cs.decrypt(master_key(home), PW), (home / "credentials.enc").read_bytes()

    cs.Store(home, PW).change_passphrase("brand-new")

    assert cs.decrypt(master_key(home), "brand-new") == key   # same master key, new wrapping
    assert (home / "credentials.enc").read_bytes() == vault
    with pytest.raises(cs.CredentialError, match="could not decrypt the master key"):
        cs.Store(home, PW).sync()
    assert dict(cs.Store(home, "brand-new").get_credential(SYS).secrets()) == {"token": "t"}


def test_change_passphrase_with_a_clone_key_needs_no_old_passphrase(home):
    cs.Store(home, PW).enrol("a", None)
    cs.Store(home).change_passphrase("brand-new")
    (home / "clone.a.key").unlink()
    write_index(home, {})
    assert cs.Store(home, "brand-new").sync() == {}


def test_rotation_and_passphrase_change_combine(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    cs.Store(home, PW).rotate_master_key()
    cs.Store(home, PW).change_passphrase("second")
    assert dict(cs.Store(home, "second").get_credential(SYS).secrets()) == {"token": "t"}


def test_the_tool_never_reads_the_environment(home, monkeypatch):
    monkeypatch.setenv("CREDSTORE_PASSPHRASE", PW)
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    with pytest.raises(cs.CredentialError, match="no way to open the vault"):
        cs.Store(home).get_credential(SYS)         # the variable is set, and ignored
    source = Path(cs.__file__).read_text()
    assert not any(call in source for call in ("os.environ", "import environ", "getenv", "import os"))


def test_new_passphrase_is_typed_twice(monkeypatch):
    monkeypatch.setattr(cs, "_tty", lambda: True)
    monkeypatch.setattr(cs.getpass, "getpass", lambda *a: next(typed))
    typed = iter(["abc", "xyz"])
    with pytest.raises(cs.CredentialError, match="do not match"):
        cs._prompt_new_passphrase()
    typed = iter(["abc", "abc"])
    assert cs._prompt_new_passphrase() == "abc"


# -- clone keys ------------------------------------------------------------------------------

def clone(home, target):
    """A second clone of the vault home: the committed files only."""
    shutil.copytree(home, target, ignore=shutil.ignore_patterns("clone.*.key", "access.log"))
    return target


def pull(source, target):
    """Bring the committed files of one clone to another."""
    for path in source.rglob("*"):
        rel = path.relative_to(source)
        if path.is_file() and not path.name.startswith("clone.") and path.name != "access.log":
            (target / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target / rel)
    for path in list(target.rglob("*")):   # deletions too
        rel = path.relative_to(target)
        if path.is_file() and not (source / rel).exists() and not path.name.startswith("clone.") \
                and path.name != "access.log":
            path.unlink()


def mode_works(folder):
    probe = folder / "probe"
    probe.touch()
    probe.chmod(0o600)
    works = probe.stat().st_mode & 0o777 == 0o600
    probe.unlink()
    return works


def test_self_enrolment_with_the_passphrase(home):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    name, fp, approved = cs.Store(home, PW).enrol("laptop", None)
    assert (name, approved) == ("laptop", True) and fp.startswith("SHA256:")
    key = home / "clone.laptop.key"
    assert key.read_bytes().startswith(b"-----BEGIN PRIVATE KEY-----")
    if mode_works(home):
        assert key.stat().st_mode & 0o777 == 0o600
    assert {"clone.*.key", "access.log"} <= set((home / ".gitignore").read_text().splitlines())
    store = cs.Store(home)                                  # no passphrase any more
    assert dict(store.get_credential(SYS).secrets()) == {"token": "t"}
    assert store.method == "clone-key:laptop:plain"


def test_a_request_is_approved_in_a_trusted_clone(home, tmp_path):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).enrol("trusted", None)
    new = clone(home, tmp_path / "new")
    name, fp, approved = cs.Store(new).enrol(None, None)   # no passphrase: a request
    assert not approved and re.fullmatch(r"auto-.*-\d{8}(-\d+)?", name)
    with pytest.raises(cs.NoWayToOpen):
        cs.Store(new).get_credential(SYS)
    pull(new, home)
    assert cs.Store(home).approve_enrol(name) == fp               # the fingerprints match
    pull(home, new)
    assert dict(cs.Store(new).get_credential(SYS).secrets()) == {"token": "t"}


def git(cwd, *args):
    subprocess.run(["git", "-c", "protocol.file.allow=always", "-C", str(cwd), *args],
                   check=True, capture_output=True)


def test_a_request_has_an_inf_file_that_approve_shows(home, tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(cs, "_git", lambda *a: "")         # tmp_path is in this repository
    cs.Store(home, PW).enrol("trusted", None)
    new = clone(home, tmp_path / "new")
    name, fp, _ = cs.Store(new).enrol("req", None)
    info = (new / "recipients" / "req.inf").read_text()
    assert info.startswith(f"[clone]\nname = req\ncreated = ")
    assert f"fingerprint = {fp}\n" in info and "computer = " in info and "os = " in info
    assert "clone_path" not in info and "repository" not in info   # no git repository: no value
    pull(new, home)
    capsys.readouterr()
    assert cs.main(["--vault-home", str(home), "approve-enrol", "req"]) == 0
    assert capsys.readouterr().out.startswith(f"approved req\n{info}fingerprint\t{fp}\n")


def test_generated_names_fit_and_do_not_repeat(monkeypatch):
    info = {"computer": "DESKTOP-ABCDEFG12345", "user": "Nestor", "repository": "git@github.com:o/my_repo.git"}
    name = cs._auto_name(info, lambda n: False)
    assert re.fullmatch(r"auto-desktopabcdefg1-nestor-my_repo-\d{8}", name)
    assert len(name) - len("auto-") - len("-yyyymmdd") == cs.ID_LIMIT   # auto- and the date do not count
    assert cs._auto_name(info, lambda n: n in (name, name + "-2")) == name + "-3"
    assert re.fullmatch(r"auto-pc-\d{8}", cs._auto_name({"computer": "PC", "user": "?"}, lambda n: False))
    assert cs._fit(["a" * 20, "bb", "c" * 20], 30) == ["a" * 13, "bb", "c" * 13]


def test_the_root_repository_is_the_top_superproject(tmp_path):
    vault = tmp_path / "vault-src"
    vault.mkdir()
    git(vault, "init", "-q")
    git(vault, "remote", "add", "origin", "https://u:secret@github.com/o/vault.git")
    git(vault, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x")
    assert cs._clone_info(vault)["repository"] == "https://github.com/o/vault.git"   # no credentials
    root = tmp_path / "root"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "remote", "add", "upstream", "https://github.com/o/root.git")
    git(root, "submodule", "add", "-q", str(vault), "vault-home")
    info = cs._clone_info(root / "vault-home")
    assert Path(info["clone_path"]).resolve() == root.resolve()
    assert info["repository"] == "https://github.com/o/root.git"
    assert "-root-" in cs._auto_name(info, lambda n: False)


def test_a_recipient_name_of_another_clone_is_refused(home, tmp_path):
    cs.Store(home, PW).enrol("taken", None)
    with pytest.raises(cs.CredentialError, match="is taken"):
        cs.Store(clone(home, tmp_path / "other")).enrol("taken", None)
    with pytest.raises(cs.CredentialError, match="not valid"):
        cs.Store(home).enrol("../x", None)


def test_enrol_again_reuses_the_key(home):
    first = cs.Store(home).enrol("x", None)
    assert cs.Store(home, PW).enrol("x", None) == ("x", first[1], True)


def test_one_clone_can_have_more_key_pairs(home):
    write_index(home, {})
    cs.Store(home, PW).enrol("win", None)
    cs.Store(home, PW).enrol("wsl", None)
    (home / "clone.win.key").write_text("not a key")       # e.g. the other OS cannot read it
    store = cs.Store(home)
    store.sync()
    assert store.method == "clone-key:wsl:plain"


def test_a_provider_keeps_the_key_passphrase(home, fake):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).enrol("kr")                         # "auto": the first available provider
    key = (home / "clone.kr.key").read_bytes()
    assert key.startswith(b"credstore-provider: fake\n-----BEGIN ENCRYPTED PRIVATE KEY-----")
    assert list(fake.entries) == ["kr"]
    store = cs.Store(home)
    assert dict(store.get_credential(SYS).secrets()) == {"token": "t"} and store.method == "clone-key:kr:fake"
    fake.entries.clear()
    with pytest.raises(cs.NoWayToOpen, match="Skipped keys: kr: provider 'fake' has no key passphrase"):
        cs.Store(home).get_credential(SYS)


def test_list_and_delete_keyring_secrets(home, fake):
    cs.Store(home, PW).enrol("one")
    cs.Store(home, PW).enrol("two")
    fake.set("stale", "x")
    store = cs.Store(home)
    assert store.list_keyring_secrets() == [("fake", "one"), ("fake", "stale"), ("fake", "two")]
    assert store.delete_keyring_secrets(["one"]) == [("fake", "one")]
    assert not (home / "clone.one.key").exists()            # it cannot open any more
    assert store.delete_all_keyring_secrets() == [("fake", "stale"), ("fake", "two")]
    assert fake.entries == {}


def test_unenrol_and_rotate_master_key_rotates_and_locks_the_clone_out(home, tmp_path):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    cs.Store(home, PW).enrol("keep", None)
    lost = clone(home, tmp_path / "lost")
    name = cs.Store(lost).enrol("lost", None)[0]
    pull(lost, home)
    cs.Store(home).approve_enrol(name)
    pull(home, lost)
    assert cs.Store(lost).get_credential(SYS)
    with pytest.raises(cs.CredentialError, match="needs the master passphrase"):
        cs.Store(home).unenrol_and_rotate_master_key("lost")
    assert (home / "recipients" / "lost.pub").exists()     # nothing deleted before the check
    old_master = master_key(home)
    cs.Store(home, PW).unenrol_and_rotate_master_key("lost")
    assert not list((home / "recipients").glob("lost.*")) and master_key(home) != old_master
    pull(home, lost)
    with pytest.raises(cs.NoWayToOpen):
        cs.Store(lost).get_credential(SYS)
    assert cs.Store(home).get_credential(SYS)


def test_unenrol_this_clone_keeps_the_master_key_and_the_private_key(home, tmp_path):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).enrol("keep", None)
    gone = clone(home, tmp_path / "gone")
    cs.Store(gone).enrol("gone", None)
    pull(gone, home)
    cs.Store(home).approve_enrol("gone")
    pull(home, gone)
    old_master = master_key(home)
    assert cs.Store(gone).unenrol() == "gone"              # no name: the recipient of this clone
    assert not list((gone / "recipients").glob("gone.*"))
    assert (gone / "clone.gone.key").exists() and master_key(gone) == old_master
    assert log_lines(gone)[-1][1:4] == ["unenrol", "main", '"gone"']
    with pytest.raises(cs.NoWayToOpen):
        cs.Store(gone).get_credential(SYS)
    pull(gone, home)
    assert cs.Store(home).get_credential(SYS)             # the other clones are not changed


def test_unenrol_another_clone_and_a_request(home, tmp_path):
    cs.Store(home, PW).enrol("trusted", None)
    other = clone(home, tmp_path / "other")
    cs.Store(other).enrol("req", None)                     # a request: only .pub and .inf
    pull(other, home)
    assert cs.Store(home).unenrol("req") == "req"
    assert not list((home / "recipients").glob("req.*"))
    assert (home / "recipients" / "trusted.master.enc").exists()
    with pytest.raises(cs.CredentialError, match="unknown recipient 'req'"):
        cs.Store(home).unenrol("req")


def test_unenrol_without_a_name_needs_exactly_one_own_recipient(home):
    with pytest.raises(cs.CredentialError, match="no recipient"):
        cs.Store(home).unenrol()
    cs.Store(home, PW).enrol("a", None)
    cs.Store(home, PW).enrol("b", None)
    with pytest.raises(cs.CredentialError, match="more than one recipient.*a, b; give a name"):
        cs.Store(home).unenrol()


def test_delete_private_clone_key_only_after_unenrol(home, fake):
    cs.Store(home, PW).enrol("c")
    with pytest.raises(cs.CredentialError, match="'c' is still enrolled .*c.pub, c.master.enc"):
        cs.Store(home).delete_private_clone_key()
    cs.Store(home).unenrol()
    assert cs.Store(home).delete_private_clone_key() == "c"
    assert not (home / "clone.c.key").exists() and fake.entries == {}
    assert log_lines(home)[-1][1:4] == ["delete-private-clone-key", "main", '"c"']
    with pytest.raises(cs.CredentialError, match="no private clone key"):
        cs.Store(home).delete_private_clone_key()


def test_delete_private_clone_key_waits_for_the_push(tmp_path):
    remote, home = tmp_path / "remote.git", tmp_path / "vault"
    git(tmp_path, "init", "-q", "--bare", str(remote))
    cs.Store(home, PW).create_vault()
    cs.Store(home, PW).enrol("c", None)
    commit = lambda: git(home, "-c", "user.name=t", "-c", "user.email=t@t",  # noqa: E731
                         "commit", "-q", "--no-verify", "-am", "x")
    git(home, "init", "-q", "-b", "main")
    git(home, "add", ".")
    commit()
    git(home, "remote", "add", "origin", str(remote))
    git(home, "push", "-q", "-u", "origin", "main")
    cs.Store(home).unenrol()
    commit()
    with pytest.raises(cs.CredentialError, match="still enrolled .*recipients/c.pub"):
        cs.Store(home).delete_private_clone_key()        # committed, not pushed
    git(home, "push", "-q")
    assert cs.Store(home).delete_private_clone_key() == "c"


@pytest.mark.skipif(shutil.which("openssl") is None, reason="openssl is not installed")
def test_openssl_opens_the_wrapped_master_key_with_a_clone_key(home):
    write_index(home, {SYS: entry(token="ghp_x")})
    cs.Store(home, PW).sync()
    cs.Store(home, PW).enrol("c", None)
    key = subprocess.run(["openssl", "pkeyutl", "-decrypt", "-inkey", str(home / "clone.c.key"),
                          "-in", str(home / "recipients" / "c.master.enc"),
                          "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha256",
                          "-pkeyopt", "rsa_mgf1_md:sha256"], check=True, capture_output=True).stdout
    out = subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-in", str(home / "credentials.enc"),
                          "-pass", f"pass:{key.decode()}"], check=True, capture_output=True).stdout
    assert json.loads(out)[SYS]["credentials"]["token"] == "ghp_x"
    der = subprocess.run(["openssl", "pkey", "-pubin", "-in", str(home / "recipients" / "c.pub"),
                          "-outform", "DER"], check=True, capture_output=True).stdout
    assert cs.fingerprint((home / "recipients" / "c.pub").read_bytes()) == \
        "SHA256:" + base64.b64encode(hashlib.sha256(der).digest()).decode().rstrip("=")


@pytest.fixture
def two(home):
    """A vault with two systems and an enrolled clone."""
    write_index(home, {SYS: entry(token="t"), "jira": entry(password="p")})
    cs.Store(home, PW).sync()
    cs.Store(home, PW).enrol("main", None)
    return home


# -- access log ------------------------------------------------------------------------------

def log_lines(home):
    lines = (home / "access.log").read_text().splitlines()
    assert lines[0] == "time\tevent\tvault\tsystem\tsecrets\tmethod\tcaller"   # the header
    return [line.split("\t") for line in lines[1:]]


def test_a_log_from_before_the_header_gets_it(home):
    (home / "access.log").write_text("2026-10-19T20:56:45Z\tenrol\tmain\tx\t\tpassphrase\t\"bash\"\n")
    cs._log(home, "get", "a b", ["k"], "passphrase")
    lines = (home / "access.log").read_text().splitlines()
    assert lines[0] == cs.LOG_HEADER and len(lines) == 3 and lines[2].split("\t")[3] == '"a b"'


def test_access_log(two):
    cs.get_credential(SYS, vault_home=two)
    cs.Store(two, "wrong").sync()                           # a clone key opens it: no failure
    (two / "clone.main.key").rename(two / "away")
    with pytest.raises(cs.CredentialError):
        cs.Store(two).sync()
    events = log_lines(two)
    assert events[0][1:5] == ["enrol", "main", '"main"', ""] and events[0][5] == "passphrase"
    get = events[1]
    assert get[1:] == ["get", "main", f'"{SYS}"', "token", "clone-key:main:plain", '"test_credstore.py"']
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", get[0])
    assert events[-1][1:3] == ["open-failed", "main"]


def test_cli_get_logs_only_the_secret_it_prints(two, capsys):
    assert cs.main(["--vault-home", str(two), "get-secret", "jira", "password"]) == 0
    assert capsys.readouterr().out == "p\n"
    assert log_lines(two)[-1][1:5] == ["get", "main", '"jira"', "password"]

# -- vault home and init -------------------------------------------------------------------

def test_cli_finds_vault_main_with_dependencies_txt(tmp_path, monkeypatch):
    shared = tmp_path / "shared"
    (shared / "tools" / "auth" / "src").mkdir(parents=True)
    (shared / "tools" / "auth" / "src" / "dependencies.py").write_text((cs.TOOL / "src" / "dependencies.py").read_text())
    (shared / ".git").write_text("gitdir: x\n")
    (shared / "dependencies.txt").write_text("[vault-main]\n../vaults/vault-main\n../vault-main\n")
    monkeypatch.setattr(cs, "TOOL", shared / "tools" / "auth")
    with pytest.raises(cs.CredentialError, match="vault-main is not found(.|\n)*--vault-home"):
        cs.default_vault_home()
    (tmp_path / "vault-main" / "recipients").mkdir(parents=True)
    assert cs.default_vault_home() == tmp_path / "vault-main"
    (tmp_path / "vaults" / "vault-main" / "recipients").mkdir(parents=True)
    assert cs.default_vault_home() == tmp_path / "vaults" / "vault-main"


def test_the_api_needs_the_vault_home():
    with pytest.raises(cs.CredentialError, match="give the vault home"):
        cs.Store("")


def test_create_vault_writes_a_vault_that_needs_the_secrets_filled_in(home):
    for name in ("master.enc.key", "credentials.json", ".gitignore", ".gitattributes",
                 ".githooks/pre-commit", "setup.sh", "setup.bat"):
        assert (home / name).is_file(), name
    assert not (home / "credentials.enc").exists()
    assert {"clone.*.key", "access.log"} <= set((home / ".gitignore").read_text().splitlines())
    assert read_index(home) == cs.EXAMPLE
    with pytest.raises(cs.CredentialError, match="blank and the vault has no value"):
        cs.Store(home, PW).sync()
    write_index(home, {SYS: entry(token="t")})
    assert dict(cs.Store(home, PW).get_credential(SYS).secrets()) == {"token": "t"}


def test_create_vault_refuses_an_existing_vault(home):
    with pytest.raises(cs.CredentialError, match="a vault exists already"):
        cs.Store(home, PW).create_vault()


def test_create_vault_needs_the_vault_home(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert cs.main(["create-vault"]) != 0
    assert "--vault-home" in capsys.readouterr().err
    assert not list(tmp_path.iterdir())


def test_backups_go_to_the_tool_folder_not_the_vault(home, tmp_path):
    write_index(home, {SYS: entry(token="t")})
    cs.Store(home, PW).sync()
    backup = cs.Store(home, PW).rotate_master_key()
    assert backup.parent == tmp_path / "backups" and not (home / ".local_assets").exists()


def test_create_vault_copies_the_setup_scripts_of_the_shared_repository(home):
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


@needs_sh
def test_hook_blocks_a_commit_of_a_private_key_or_the_log(tmp_path):
    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, capture_output=True, text=True)

    git("init", "-q")
    git("config", "user.email", "t@t.invalid")
    git("config", "user.name", "t")
    (tmp_path / ".githooks").mkdir()
    shutil.copy(HOOK, tmp_path / ".githooks" / "pre-commit")
    (tmp_path / ".githooks" / "pre-commit").chmod(0o755)
    git("config", "core.hooksPath", ".githooks")
    for name in ("clone.x.key", "access.log"):
        (tmp_path / name).write_text("x")
        git("add", "-f", name)
        blocked = git("commit", "-qm", "x")
        assert blocked.returncode != 0 and f"{name}: private key or access log" in blocked.stderr
        git("rm", "-q", "--cached", name)


def test_the_keyring_provider_reports_a_missing_keyring(monkeypatch):
    import keyring
    from keyring.backends import fail
    monkeypatch.setattr(keyring, "get_keyring", lambda: fail.Keyring())
    assert not cs.KeyringProvider().available()


def test_rotate_master_key_keeps_the_order_of_the_index(home):
    write_index(home, {"b": entry(token="1"), "a": entry(token="2")})
    cs.Store(home, PW).sync()
    before = (home / "credentials.json").read_bytes()
    cs.Store(home, PW).rotate_master_key()
    assert (home / "credentials.json").read_bytes() == before


@pytest.mark.parametrize("cmdline, caller", [
    (["/bin/bash", "--init-file", "/x/shellIntegration-bash.sh"], "bash"),
    (["-bash"], "bash"),
    (["bash", "./run.sh", "odswiez"], "run.sh"),
    (["bash", "-c", "run.sh get x"], "bash"),
    (["/usr/bin/python3", "-m", "pytest"], "python3"),
    (["/usr/bin/python3", "sync.py"], "sync.py"),
])
def test_cli_caller_from_the_parent_process(monkeypatch, cmdline, caller):
    real = Path.read_bytes
    monkeypatch.setattr(cs, "_CLI", True)
    monkeypatch.setattr(cs.sys, "platform", "linux")
    monkeypatch.setattr(Path, "read_text", lambda self, *a, **k: "1 (python) S 4242 1 1")
    monkeypatch.setattr(Path, "read_bytes", lambda self: "\0".join(cmdline).encode() + b"\0"
                        if str(self) == "/proc/4242/cmdline" else real(self))
    assert cs._caller() == caller

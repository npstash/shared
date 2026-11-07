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


def edit(home, system, passphrase=PW, **fields):
    """Write the edit file of `system`, change `fields` in it, and give its path."""
    path = cs.Store(home, passphrase).edit([system])[0]
    doc = json.loads(path.read_text())
    for key, value in fields.items():
        if value is None:
            doc.pop(key, None)
        else:
            doc[key] = value
    path.write_text(json.dumps(doc))
    return path


def put(home, name, url="https://g", info=("scope line",), **secrets):
    """Add or change a system as a user does: edit, then sync."""
    edit(home, name, url=url, authority_info=list(info), credentials=dict(secrets))
    cs.Store(home, PW).sync()


def secrets(home, name, passphrase=PW):
    return dict(cs.Store(home, passphrase).get_credential(name).secrets())


def stamp(path):
    return path.read_bytes(), path.stat().st_mtime_ns


def vault_doc(home):
    return json.loads((home / "vault.json").read_text())


# -- encryption --------------------------------------------------------------------------

@pytest.mark.parametrize("size", [0, 1, 15, 16, 17, 2000])
def test_master_enc_key_has_the_openssl_enc_aes_256_cbc_format(size):
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
def test_openssl_opens_the_two_key_files_with_the_passphrase(home):
    run = lambda name: subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-in", str(home / name),  # noqa: E731
                                       "-pass", f"pass:{PW}"], check=True, capture_output=True).stdout
    key = run("master.enc.key")
    assert key.endswith(b"\n") and len(base64.b64decode(key.strip())) == 32 and key.count(b"\n") == 1
    assert run("admin.enc.key").startswith(b"-----BEGIN PRIVATE KEY-----")


def test_vault_json_shows_no_names_and_no_secrets(home):
    put(home, SYS, username="npstash", token="ghp_x")
    text = (home / "vault.json").read_text()
    assert SYS not in text and "npstash" not in text and "ghp_x" not in text and "https://g" not in text
    doc = vault_doc(home)
    assert doc["format"] == 2 and list(doc["entries"]) == [cs.entry_id(cs.Store(home, PW)._load_key(), SYS)]
    assert re.fullmatch(r"[0-9a-f]{32}", next(iter(doc["entries"])))
    assert set(doc["entries"][next(iter(doc["entries"]))]) == {"name", "data"}


def test_the_entry_id_depends_on_the_master_key_and_the_name():
    a, b = cs._new_master_key(), cs._new_master_key()
    assert cs.entry_id(a, SYS) == cs.entry_id(a, SYS)
    assert cs.entry_id(a, SYS) != cs.entry_id(b, SYS) and cs.entry_id(a, SYS) != cs.entry_id(a, "jira")


def test_a_damaged_or_moved_entry_is_rejected(home):
    put(home, SYS, token="t")
    put(home, "jira", password="p")
    doc = vault_doc(home)
    sys_id, jira_id = (cs.entry_id(cs.Store(home, PW)._load_key(), n) for n in (SYS, "jira"))
    good = json.dumps(doc)
    data = base64.b64decode(doc["entries"][sys_id]["data"])
    doc["entries"][sys_id]["data"] = base64.b64encode(data[:-1] + bytes([data[-1] ^ 1])).decode()
    (home / "vault.json").write_text(json.dumps(doc))
    with pytest.raises(cs.CredentialError, match="cannot be decrypted"):
        cs.Store(home, PW).get_credential(SYS)
    doc = json.loads(good)                                 # the data of jira in the slot of SYS
    doc["entries"][sys_id]["data"] = doc["entries"][jira_id]["data"]
    (home / "vault.json").write_text(json.dumps(doc))
    with pytest.raises(cs.CredentialError, match="cannot be decrypted"):
        cs.Store(home, PW).get_credential(SYS)


def test_the_names_open_only_with_the_admin_key(home):
    put(home, SYS, token="t")
    store = cs.Store(home, PW)
    pem = store._admin_pem(store._confirm_passphrase())
    assert list(store._names(cs._admin_key(pem)).values()) == [SYS]


# -- edit and sync -------------------------------------------------------------------------

def test_edit_writes_all_fields_with_empty_secrets(home, capsys):
    put(home, SYS, username="npstash", token="ghp_x")
    assert cs.main(["--vault-home", str(home), "edit", SYS]) == 1     # no clone key, no terminal
    cs.Store(home, PW).enrol("here", None)
    capsys.readouterr()
    assert cs.main(["--vault-home", str(home), "edit", SYS]) == 0
    path = Path(capsys.readouterr().out.strip())
    assert path == home / f"entry-{cs.entry_id(cs.Store(home)._load_key(), SYS)}.json"
    doc = json.loads(path.read_text())
    assert doc == {"name": SYS, "revision": doc["revision"], "url": "https://g", "authority_info": ["scope line"],
                   "credentials": {"username": "", "token": ""}}
    assert re.fullmatch(r"[0-9a-f]{16}", doc["revision"])


def test_edit_of_a_new_system_writes_an_empty_entry(home):
    path = cs.Store(home, PW).edit(["new one"])[0]
    assert json.loads(path.read_text()) == {"name": "new one", "revision": "", "url": "",
                                            "authority_info": [], "credentials": {}}


def test_edit_refuses_an_existing_edit_file(home):
    cs.Store(home, PW).edit([SYS])
    with pytest.raises(cs.CredentialError, match="exists already"):
        cs.Store(home, PW).edit(["other", SYS])
    assert len(list(home.glob("entry-*.json"))) == 1       # nothing written


def test_sync_applies_the_changes_and_deletes_the_files(home):
    put(home, SYS, username="npstash", token="t", pw="p")
    put(home, "jira", password="j")
    edit(home, SYS, url=None, authority_info=["new scope"],
         credentials={"username": "", "token": "changed", "new": "n"})     # pw removed, url removed
    edit(home, "jira")                                     # unchanged
    assert sorted(cs.Store(home, PW).sync()) == sorted([SYS, "jira"])
    c = cs.Store(home, PW).get_credential(SYS)
    assert (c.url, c.authority_info) == (None, ("new scope",))
    assert dict(c.secrets()) == {"username": "npstash", "token": "changed", "new": "n"}
    assert secrets(home, "jira") == {"password": "j"}
    assert not list(home.glob("entry-*.json"))


def test_sync_without_edit_files_is_an_error(home):
    with pytest.raises(cs.CredentialError, match=r"no entry-\*\.json .*run edit NAME first"):
        cs.Store(home, PW).sync()


def test_an_unchanged_edit_file_leaves_vault_json_alone(home):
    put(home, SYS, token="t")
    before = stamp(home / "vault.json")
    edit(home, SYS)
    cs.Store(home, PW).sync()
    cs.Store(home, PW).get_credential(SYS)
    assert stamp(home / "vault.json") == before


def test_a_blank_secret_without_a_stored_value_is_an_error(home):
    edit(home, SYS, credentials={"username": "npstash", "token": ""})
    with pytest.raises(cs.CredentialError, match="blank and the vault has no value"):
        cs.Store(home, PW).sync()


def test_sync_refuses_a_stale_edit_file(home):
    put(home, SYS, token="t")
    edit(home, SYS, credentials={"token": "from the file"})
    cs.Store(home, PW).set_system(SYS, secrets={"token": "set later"})
    with pytest.raises(cs.CredentialError, match="changed after edit; run edit again"):
        cs.Store(home, PW).sync()
    assert secrets(home, SYS) == {"token": "set later"}


def test_sync_refuses_an_edit_file_of_a_system_that_was_added_since(home):
    edit(home, SYS, credentials={"token": "a"})
    cs.Store(home, PW).set_system(SYS, secrets={"token": "b"})
    with pytest.raises(cs.CredentialError, match="changed after edit"):
        cs.Store(home, PW).sync()


def test_sync_refuses_a_changed_name_and_unknown_fields(home):
    put(home, SYS, token="t")
    path = edit(home, SYS, name="renamed")
    with pytest.raises(cs.CredentialError, match="does not belong to this file; to rename a system, use rename"):
        cs.Store(home, PW).sync()
    path.unlink()
    edit(home, SYS, alias_of="x")
    with pytest.raises(cs.CredentialError, match="unknown fields: alias_of"):
        cs.Store(home, PW).sync()


def test_sync_applies_all_files_or_none(home):
    put(home, SYS, token="t")
    edit(home, SYS, credentials={"token": "new"})
    edit(home, "bad", credentials={"k": ""})
    before = stamp(home / "vault.json")
    with pytest.raises(cs.CredentialError, match="blank"):
        cs.Store(home, PW).sync()
    assert stamp(home / "vault.json") == before and len(list(home.glob("entry-*.json"))) == 2


def test_edit_files_are_ignored_by_git(home):
    assert "entry-*.json" in (home / ".gitignore").read_text().splitlines()


# -- API ---------------------------------------------------------------------------------

def test_secrets_map_is_immutable(home):
    put(home, SYS, token="t")
    with pytest.raises(TypeError):
        cs.Store(home, PW).get_credential(SYS).secrets()["token"] = "x"


def test_no_listing_without_the_passphrase(home, capsys):
    put(home, SYS, token="t")
    assert not hasattr(cs, "list_systems") and not hasattr(cs.Store, "read_index")
    with pytest.raises(SystemExit):
        cs.main(["--vault-home", str(home), "list"])
    with pytest.raises(cs.CredentialError) as error:
        cs.Store(home, PW).get_credential("Github")
    assert str(error.value) == "unknown system 'Github'"   # no names of other systems


def test_list_systems_needs_a_terminal_and_the_passphrase(home, monkeypatch, capsys):
    put(home, "b", token="t")
    put(home, "a", token="t")
    cs.Store(home, PW).enrol("here", None)
    with pytest.raises(cs.CredentialError, match="needs the master passphrase"):
        cs.Store(home).list_systems()                      # a clone key alone does not open the names
    assert cs.Store(home, PW).list_systems() == ["a", "b"]
    assert log_lines(home)[-1][1] == "list-systems"
    asked = []
    monkeypatch.setattr(cs.getpass, "getpass", lambda prompt: asked.append(prompt) or PW)
    monkeypatch.setattr(cs, "_tty", lambda: False)
    capsys.readouterr()
    assert cs.main(["--vault-home", str(home), "list-systems"]) == 1 and not asked
    assert "list-systems runs only in a terminal" in capsys.readouterr().err
    monkeypatch.setattr(cs, "_tty", lambda: True)
    assert cs.main(["--vault-home", str(home), "list-systems"]) == 0 and asked == ["Master passphrase: "]
    assert capsys.readouterr().out == "a\thttps://g\ttoken\n  scope line\nb\thttps://g\ttoken\n  scope line\n"


def test_get_system_by_entry_id_or_encrypted_name_needs_the_passphrase(home, monkeypatch, capsys):
    cs.Store(home, PW).set_system(SYS, url="https://g", authority_info=["scope"], secrets={"token": "t"})
    cs.Store(home, PW).enrol("here", None)
    [(eid, record)] = vault_doc(home)["entries"].items()
    for key in (eid, record["name"]):
        with pytest.raises(cs.CredentialError, match="needs the master passphrase"):
            cs.Store(home).get_system(key)                 # a clone key alone does not open the name
        c = cs.Store(home, PW).get_system(key)
        assert (c.name, c.url, list(c.secrets())) == (SYS, "https://g", ["token"])
        line = log_lines(home)[-1]
        assert (line[1], line[3]) == ("get-system", f'"{eid}"')
    with pytest.raises(cs.CredentialError, match="unknown system"):
        cs.Store(home, PW).get_secret(eid, "token")        # only get-system takes an ID
    before = len(log_lines(home))
    assert cs.Store(home).get_system(SYS).name == SYS      # a name needs no passphrase and no log line
    assert len(log_lines(home)) == before
    asked = []
    monkeypatch.setattr(cs.getpass, "getpass", lambda prompt: asked.append(prompt) or PW)
    monkeypatch.setattr(cs, "_tty", lambda: True)
    capsys.readouterr()
    assert cs.main(["--vault-home", str(home), "get-system", eid]) == 0 and asked == ["Master passphrase: "]
    assert capsys.readouterr().out == f"{SYS}\thttps://g\ttoken\n  scope\n"


def test_set_system_adds_and_updates(home):
    cs.Store(home, PW).set_system(SYS, url="https://g", authority_info=["a"], secrets={"token": "t"})
    cs.Store(home, PW).set_system(SYS, secrets={"user": "u"})
    c = cs.Store(home, PW).get_credential(SYS)
    assert (c.url, c.authority_info, dict(c.secrets())) == ("https://g", ("a",), {"token": "t", "user": "u"})


def test_delete_system(home):
    put(home, SYS, token="t")
    cs.Store(home, PW).delete_system(SYS)
    assert vault_doc(home)["entries"] == {}
    with pytest.raises(cs.CredentialError, match="unknown system"):
        cs.Store(home, PW).delete_system(SYS)


def test_system_names_are_checked(home):
    for bad in ("", "  ", "a\nb", "x" * 300):
        with pytest.raises(cs.CredentialError, match="system name .* is not valid"):
            cs.Store(home, PW).get_system(bad)


# -- rename ------------------------------------------------------------------------------

def test_rename_system_keeps_secrets_and_changes_the_id(home):
    put(home, "old", token="t")
    before = set(vault_doc(home)["entries"])
    cs.Store(home, PW).rename_system("old", "new")
    assert secrets(home, "new") == {"token": "t"} and set(vault_doc(home)["entries"]) != before
    with pytest.raises(cs.CredentialError, match="unknown system 'old'"):
        cs.Store(home, PW).get_system("old")


def test_rename_secret_keeps_value(home):
    put(home, SYS, token="t")
    cs.Store(home, PW).rename_secret(SYS, "token", "pat")
    assert secrets(home, SYS) == {"pat": "t"}


def test_rename_refuses_conflicts(home):
    put(home, "a", x="1", y="2")
    put(home, "b", z="3")
    for system, new in (("a", "b"), ("missing", "c"), ("a", "")):
        with pytest.raises(cs.CredentialError):
            cs.Store(home, PW).rename_system(system, new)
    with pytest.raises(cs.CredentialError):
        cs.Store(home, PW).rename_secret("a", "x", "y")


# -- errors, CLI -------------------------------------------------------------------------

def test_error_messages(home):
    put(home, SYS, token="t")
    with pytest.raises(cs.CredentialError, match="unknown system 'zz'"):
        cs.Store(home, PW).get_credential("zz")
    # CBC carries no MAC, so roughly 0.4% of wrong passphrases pass the padding check and
    # the failure surfaces one step later. Every route gives a clear CredentialError.
    with pytest.raises(cs.CredentialError, match="could not decrypt the master key|"
                                                 "does not hold a usable master key|"
                                                 "cannot be decrypted|Incorrect padding"):
        cs.Store(home, "wrong").get_credential(SYS)
    with pytest.raises(cs.NoWayToOpen, match="no way to open the vault.*enrol"):
        cs.Store(home).get_credential(SYS)  # neither a clone key nor a passphrase


def test_cli(home, capsys):
    cs.Store(home, PW).enrol("here", None)                 # the CLI opens the vault with this key
    run = lambda *a: cs.main(["--vault-home", str(home), *a])  # noqa: E731
    assert run("set-system", SYS, "--url", "https://g", "--info", "scope", "--secret", "token=t") == 0
    assert run("rename-secret", SYS, "token", "pat") == 0
    capsys.readouterr()
    assert run("get-secret", SYS, "pat") == 0
    assert capsys.readouterr().out == "t\n"
    assert run("get-system", SYS) == 0
    assert capsys.readouterr().out == f"{SYS}\thttps://g\tpat\n  scope\n"
    assert run("edit", SYS, "new") == 0
    paths = capsys.readouterr().out.splitlines()
    assert [Path(p).parent for p in paths] == [home, home]
    Path(paths[1]).write_text(json.dumps({**json.loads(Path(paths[1]).read_text()), "credentials": {"k": "v"}}))
    assert run("sync") == 0
    assert capsys.readouterr().out.startswith("synced 2 system(s)")
    assert run("rename-system", SYS, "other") == 0
    assert run("get-secret", "other", "nope") == 1
    assert run("get-system", "nope") == 1
    assert run("delete-system", "new") == 0 and run("get-system", "new") == 1
    for old in ("init", "approve", "revoke", "rotate-key", "key-list", "key-remove", "get", "set", "rename", "list"):
        with pytest.raises(SystemExit):
            run(old)                                       # the old names are gone
    with pytest.raises(SystemExit):
        run("--passphrase", PW, "get-system", SYS)         # the option is gone


def test_cli_without_a_key_or_terminal_cannot_open_the_vault(home, capsys):
    put(home, SYS, token="t")
    assert cs.main(["--vault-home", str(home), "get-system", SYS]) == 1
    assert "no way to open the vault" in capsys.readouterr().err


def test_the_cli_asks_for_the_passphrase_only_in_a_terminal(home, monkeypatch):
    put(home, SYS, token="t")
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
    put(home, SYS, token="t")
    put(home, "LDAP", password="p")
    old_key, old_ids, admin = master_key(home), set(vault_doc(home)["entries"]), (home / "admin.enc.key").read_bytes()

    backup = cs.Store(home, PW).rotate_master_key()

    assert master_key(home) != old_key
    assert set(vault_doc(home)["entries"]).isdisjoint(old_ids)            # new IDs
    assert secrets(home, SYS) == {"token": "t"} and secrets(home, "LDAP") == {"password": "p"}
    assert (backup / "master.enc.key").read_bytes() == old_key             # old key kept
    assert cs.decrypt(old_key, PW) != cs.decrypt(master_key(home), PW)    # a genuinely new key
    assert (home / "admin.enc.key").read_bytes() == admin                  # the same admin key


def test_rotate_master_key_needs_the_passphrase_and_rewraps_for_each_clone(home):
    put(home, SYS, token="t")
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


def test_change_passphrase_leaves_the_keys_and_vault_alone(home):
    put(home, SYS, token="t")
    content, vault = cs.decrypt(master_key(home), PW), (home / "vault.json").read_bytes()
    admin = cs.decrypt((home / "admin.enc.key").read_bytes(), PW)

    cs.Store(home, PW).change_passphrase("brand-new")

    assert cs.decrypt(master_key(home), "brand-new") == content   # same keys, new wrapping
    assert cs.decrypt((home / "admin.enc.key").read_bytes(), "brand-new") == admin
    assert (home / "vault.json").read_bytes() == vault
    with pytest.raises(cs.CredentialError, match="could not decrypt the master key"):
        cs.Store(home, PW).get_credential(SYS)
    assert secrets(home, SYS, "brand-new") == {"token": "t"}


def test_change_passphrase_needs_the_old_passphrase(home):
    cs.Store(home, PW).enrol("a", None)
    with pytest.raises(cs.CredentialError, match="needs the master passphrase"):
        cs.Store(home).change_passphrase("brand-new")           # admin.enc.key needs it too
    cs.Store(home, PW).change_passphrase("brand-new")
    (home / "clone.a.key").unlink()
    cs.Store(home, "brand-new").set_system(SYS, secrets={"k": "v"})


def test_rotation_and_passphrase_change_combine(home):
    put(home, SYS, token="t")
    cs.Store(home, PW).rotate_master_key()
    cs.Store(home, PW).change_passphrase("second")
    cs.Store(home, "second").rotate_master_key()
    assert secrets(home, SYS, "second") == {"token": "t"}


def test_the_tool_never_reads_the_environment(home, monkeypatch):
    monkeypatch.setenv("CREDSTORE_PASSPHRASE", PW)
    put(home, SYS, token="t")
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
    put(home, SYS, token="t")
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
    put(home, SYS, token="t")
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


def test_enrol_cli_tells_if_the_keyring_was_used(home, monkeypatch, capsys):
    monkeypatch.setattr(cs, "_tty", lambda: False)
    assert cs.main(["--vault-home", str(home), "enrol", "plain"]) == 0
    assert "key\tplain, not encrypted: no keyring was used" in capsys.readouterr().out
    provider = FakeProvider()
    monkeypatch.setattr(cs, "PROVIDERS", [provider])
    assert cs.main(["--vault-home", str(home), "enrol", "kept"]) == 0
    assert "key\tencrypted, key passphrase in fake" in capsys.readouterr().out
    assert provider.entries


def test_enrol_again_reuses_the_key(home):
    first = cs.Store(home).enrol("x", None)
    assert cs.Store(home, PW).enrol("x", None) == ("x", first[1], True)


def test_one_clone_can_have_more_key_pairs(home):
    cs.Store(home, PW).enrol("win", None)
    cs.Store(home, PW).enrol("wsl", None)
    (home / "clone.win.key").write_text("not a key")       # e.g. the other OS cannot read it
    store = cs.Store(home)
    store.set_system(SYS, secrets={"k": "v"})
    assert store.method == "clone-key:wsl:plain"


def test_a_provider_keeps_the_key_passphrase(home, fake):
    put(home, SYS, token="t")
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
    put(home, SYS, token="t")
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
    put(home, SYS, token="t")
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
    cs.Store(home, PW).enrol("c", None)
    key = subprocess.run(["openssl", "pkeyutl", "-decrypt", "-inkey", str(home / "clone.c.key"),
                          "-in", str(home / "recipients" / "c.master.enc"),
                          "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha256",
                          "-pkeyopt", "rsa_mgf1_md:sha256"], check=True, capture_output=True).stdout
    assert key.decode() == cs.Store(home)._load_key()
    der = subprocess.run(["openssl", "pkey", "-pubin", "-in", str(home / "recipients" / "c.pub"),
                          "-outform", "DER"], check=True, capture_output=True).stdout
    assert cs.fingerprint((home / "recipients" / "c.pub").read_bytes()) == \
        "SHA256:" + base64.b64encode(hashlib.sha256(der).digest()).decode().rstrip("=")


@pytest.fixture
def two(home):
    """A vault with two systems and an enrolled clone."""
    put(home, SYS, token="t")
    put(home, "jira", password="p")
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
    cs.Store(two, "wrong").get_system(SYS)                  # a clone key opens it: no failure
    (two / "clone.main.key").rename(two / "away")
    with pytest.raises(cs.CredentialError):
        cs.Store(two).get_system(SYS)
    events = log_lines(two)
    assert events[0][1:5] == ["enrol", "main", '"main"', ""] and events[0][5] == "passphrase"
    get = events[1]
    eid = cs.entry_id(cs.Store(two, PW)._load_key(), SYS)
    assert get[1:] == ["get", "main", f'"{eid}"', "token", "clone-key:main:plain", '"test_credstore.py"']
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", get[0])
    assert events[-1][1:3] == ["open-failed", "main"]
    assert SYS not in (two / "access.log").read_text()       # the log shows IDs, not names


def test_cli_get_logs_only_the_secret_it_prints(two, capsys):
    assert cs.main(["--vault-home", str(two), "get-secret", "jira", "password"]) == 0
    assert capsys.readouterr().out == "p\n"
    eid = cs.entry_id(cs.Store(two)._load_key(), "jira")
    assert log_lines(two)[-1][1:5] == ["get", "main", f'"{eid}"', "password"]

# -- vault home and init -------------------------------------------------------------------

def test_cli_finds_a_vault_in_the_roots_above_the_tool(tmp_path, monkeypatch):
    workspace = tmp_path / "ws"
    shared = workspace / "shared"
    (shared / "tools" / "auth" / "src").mkdir(parents=True)
    (shared / "tools" / "auth" / "src" / "dependencies.py").write_text((cs.TOOL / "src" / "dependencies.py").read_text())
    (shared / ".git").write_text("gitdir: x\n")
    (workspace / ".git").mkdir()
    (workspace / ".gitmodules").write_text('[submodule "shared"]\n\tpath = shared\n\turl = ../shared.git\n'
                                           '[submodule "vaults/vault-x"]\n\tpath = vaults/vault-x\n\turl = ../vault-x.git\n')
    (workspace / "dependencies.txt").write_text("[vault-y]\n../vault-y\n[vault-gone]\n../vault-gone\n[other]\n../o\n")
    monkeypatch.setattr(cs, "TOOL", shared / "tools" / "auth")
    load = cs._dependencies

    def only_tmp_path():   # tmp_path can be in a repository: keep the search in tmp_path
        module = load()
        real = module.roots
        module.roots = lambda start=None: (r for r in real(start) if tmp_path in r.parents)
        return module

    monkeypatch.setattr(cs, "_dependencies", only_tmp_path)
    (workspace / "vaults" / "vault-x" / "recipients").mkdir(parents=True)
    (tmp_path / "vault-y" / "recipients").mkdir(parents=True)
    assert cs.find_vault("vault-x") == workspace / "vaults" / "vault-x"     # the root above shared
    assert cs.find_vault("vault-y") == tmp_path / "vault-y"
    with pytest.raises(cs.CredentialError, match="vault-main is not found(.|\n)*--vault-home"):
        cs.find_vault("vault-main")
    assert cs.known_vaults() == ["vault-x", "vault-y"]
    with pytest.raises(cs.CredentialError, match="give the vault with --vault NAME or --vault-home DIR; "
                                                 "vaults found: vault-x, vault-y"):
        cs.vault_home()


def test_cli_has_no_default_vault(home, monkeypatch, capsys):
    monkeypatch.setattr(cs, "known_vaults", lambda: ["vault-a", "vault-b"])
    assert cs.main(["get-system", SYS]) == 1
    assert "give the vault with --vault NAME or --vault-home DIR; vaults found: vault-a, vault-b" in capsys.readouterr().err


def test_cli_takes_the_vault_name(home, monkeypatch, capsys):
    found = []
    monkeypatch.setattr(cs, "find_vault", lambda name: found.append(name) or home)
    cs.Store(home, PW).enrol("here", None)
    assert cs.main(["--vault", "vault-x", "set-system", SYS, "--secret", "k=v"]) == 0 and found == ["vault-x"]
    with pytest.raises(SystemExit):
        cs.main(["--vault", "vault-x", "--vault-home", str(home), "get-system", SYS])


def test_the_api_needs_the_vault_home():
    with pytest.raises(cs.CredentialError, match="give the vault home"):
        cs.Store("")


def test_create_vault_writes_an_empty_vault(home):
    for name in ("master.enc.key", "admin.enc.key", "admin.pub", "vault.json", ".gitignore", ".gitattributes",
                 ".githooks/pre-commit", "setup.sh", "setup.bat"):
        assert (home / name).is_file(), name
    assert {"clone.*.key", "access.log", "entry-*.json"} <= set((home / ".gitignore").read_text().splitlines())
    assert vault_doc(home) == {"format": 2, "entries": {}}


def test_create_vault_refuses_an_existing_vault(home):
    with pytest.raises(cs.CredentialError, match="a vault exists already"):
        cs.Store(home, PW).create_vault()


def test_create_vault_needs_the_vault_home(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert cs.main(["create-vault"]) != 0
    assert "--vault-home" in capsys.readouterr().err
    assert not list(tmp_path.iterdir())


def test_backups_go_to_the_tool_folder_not_the_vault(home, tmp_path):
    put(home, SYS, token="t")
    backup = cs.Store(home, PW).rotate_master_key()
    assert backup.parent == tmp_path / "backups" and not (home / ".local_assets").exists()


def test_create_vault_copies_the_setup_scripts_of_the_shared_repository(home):
    for source in cs.SETUP:
        assert (home / source.name).read_bytes() == source.read_bytes(), source.name


# -- pre-commit hook -------------------------------------------------------------------------

HOOK = cs.TEMPLATES / ".githooks" / "pre-commit"


@pytest.mark.skipif(shutil.which("sh") is None, reason="sh is not installed")
def test_hook_blocks_edit_files_private_keys_and_the_log(tmp_path):
    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, capture_output=True, text=True)

    git("init", "-q")
    git("config", "user.email", "t@t.invalid")
    git("config", "user.name", "t")
    (tmp_path / ".githooks").mkdir()
    shutil.copy(HOOK, tmp_path / ".githooks" / "pre-commit")
    (tmp_path / ".githooks" / "pre-commit").chmod(0o755)
    git("config", "core.hooksPath", ".githooks")
    for name, reason in (("entry-0123abcd.json", "edit file of the vault tool"),
                         ("sub/entry-x.json", "edit file of the vault tool"),
                         ("clone.x.key", "private key or access log"), ("access.log", "private key or access log")):
        (tmp_path / name).parent.mkdir(exist_ok=True)
        (tmp_path / name).write_text("x")
        git("add", "-f", name)
        blocked = git("commit", "-qm", "x")
        assert blocked.returncode != 0 and f"{name}: {reason}" in blocked.stderr
        git("rm", "-q", "--cached", name)
    for name in ("vault.json", "credentials.json"):
        (tmp_path / name).write_text('{"a": {"credentials": {"k": "v"}}}')
        git("add", name)
    assert git("commit", "-qm", "x").returncode == 0      # only the file name counts


def test_the_keyring_provider_reports_a_missing_keyring(monkeypatch):
    import keyring
    from keyring.backends import fail
    monkeypatch.setattr(keyring, "get_keyring", lambda: fail.Keyring())
    assert not cs.KeyringProvider().available()


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


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """A repository `top` with the vault submodule vaults/vault-x; each has a bare remote."""
    for key in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{key}_NAME", "t")
        monkeypatch.setenv(f"GIT_{key}_EMAIL", "t@t")
    vault_remote, top_remote, top = tmp_path / "vault-x.git", tmp_path / "top.git", tmp_path / "top"
    seed = tmp_path / "seed"
    git(tmp_path, "init", "-q", "--bare", "-b", "main", str(vault_remote))
    git(tmp_path, "init", "-q", "--bare", "-b", "main", str(top_remote))
    git(tmp_path, "clone", "-q", str(vault_remote), str(seed))
    (seed / "recipients").mkdir()
    (seed / "recipients" / "old.pub").write_text("old\n")
    git(seed, "add", ".")
    git(seed, "commit", "-q", "-m", "x")
    git(seed, "push", "-q", "origin", "HEAD:main")
    git(tmp_path, "clone", "-q", str(top_remote), str(top))
    git(top, "submodule", "add", "-q", str(vault_remote), "vaults/vault-x")
    git(top, "commit", "-q", "-m", "x")
    git(top, "push", "-q", "-u", "origin", "HEAD:main")
    vault = top / "vaults" / "vault-x"
    git(vault, "checkout", "-q", "main")
    return top, vault, seed


def subject(repo):
    return subprocess.run(["git", "-C", str(repo), "log", "-1", "--format=%s", "main"],
                          capture_output=True, text=True, check=True).stdout.strip()


def test_push_enrol_commits_the_vault_and_the_pointer(workspace):
    top, vault, seed = workspace
    (vault / "recipients" / "c.pub").write_text("c\n")
    (vault / "recipients" / "c.inf").write_text("c\n")
    (top / "other.txt").write_text("x\n")
    git(top, "add", "other.txt")                                     # an unrelated staged change
    (seed / "recipients" / "d.pub").write_text("d\n")
    git(seed, "add", ".")
    git(seed, "commit", "-q", "-m", "Enrol d")
    git(seed, "push", "-q", "origin", "HEAD:main")                   # the vault remote is ahead
    steps = cs.push_enrol_plan(vault / "recipients")
    assert [(s.repo, s.paths, s.message) for s in steps] == [
        (vault, ["recipients/c.inf", "recipients/c.pub"], "Enrol c"),
        (top, ["vaults/vault-x"], "Point vault-x to the enrolment of c")]
    cs.push_enrol(steps)
    assert subject(top.parent / "vault-x.git") == "Enrol c"
    assert subject(top.parent / "top.git") == "Point vault-x to the enrolment of c"
    assert (vault / "recipients" / "d.pub").is_file()
    assert cs._status(top) == [("A ", "other.txt")]


def test_push_enrol_has_nothing_without_new_recipient_files(workspace):
    top, vault, _ = workspace
    (vault / "recipients" / "old.pub").unlink()                     # a deletion is not an enrolment
    assert cs.push_enrol_plan(top) == []


def test_push_enrol_refuses_other_changes_behind_the_remote(workspace):
    _, vault, seed = workspace
    (vault / "recipients" / "c.pub").write_text("c\n")
    (vault / "recipients" / "old.pub").unlink()
    git(seed, "commit", "-q", "--allow-empty", "-m", "x")
    git(seed, "push", "-q", "origin", "HEAD:main")
    with pytest.raises(cs.CredentialError, match="behind origin/main and has other changes"):
        cs.push_enrol_plan(vault)


def test_push_enrol_refuses_a_detached_head(workspace):
    _, vault, _ = workspace
    git(vault, "checkout", "-q", "--detach")
    (vault / "recipients" / "c.pub").write_text("c\n")
    with pytest.raises(cs.CredentialError, match="detached HEAD"):
        cs.push_enrol_plan(vault)


def test_push_enrol_runs_only_in_a_terminal(capsys):
    assert cs.main(["push-enrol"]) == 1
    assert "only in a terminal" in capsys.readouterr().err

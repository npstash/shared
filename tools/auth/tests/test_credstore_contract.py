"""Contract of the read side of credstore: each case runs against credstore and against credstore_fake.

A change of the real behaviour fails here until the fake has the same change (rule tests-and-ci).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

import pytest

import credstore
import credstore_fake

PW = "test-passphrase"
SYSTEM = "API 01"


@dataclass(frozen=True)
class Vault:
    module: ModuleType
    home: Path
    passphrase: str | None

    def store(self) -> credstore.Store | credstore_fake.Store:
        return self.module.Store(self.home, self.passphrase)


@pytest.fixture(autouse=True)
def isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Backups into tmp_path, no real keyring, the caller from the Python stack."""
    monkeypatch.setattr(credstore, "BACKUPS", tmp_path / "backups")
    monkeypatch.setattr(credstore, "PROVIDERS", [])
    monkeypatch.setattr(credstore, "_CLI", False)


@pytest.fixture(params=["credstore", "credstore_fake"])
def vault(request: pytest.FixtureRequest, tmp_path: Path) -> Vault:
    home = tmp_path / "vault-home"
    if request.param == "credstore":
        credstore.Store(home, PW).create_vault()
        return Vault(credstore, home, PW)
    return Vault(credstore_fake, home, None)


def test_a_system_gives_its_fields_and_secrets(vault: Vault) -> None:
    vault.store().set_system(SYSTEM, url="https://example.com", authority_info=["Scope = read"],
                             secrets={"username": "u", "token": "t"})
    found = vault.store().get_credential(SYSTEM)
    assert isinstance(found, credstore.Credential)
    assert (found.name, found.url, found.authority_info) == (SYSTEM, "https://example.com", ("Scope = read",))
    assert dict(found.secrets()) == {"username": "u", "token": "t"}


def test_the_secrets_are_read_only(vault: Vault) -> None:
    vault.store().set_system(SYSTEM, secrets={"token": "t"})
    with pytest.raises(TypeError):
        vault.store().get_credential(SYSTEM).secrets()["token"] = "other"  # type: ignore[index]


def test_an_unknown_system_is_an_error(vault: Vault) -> None:
    with pytest.raises(credstore.CredentialError, match="unknown system 'Other 01'"):
        vault.store().get_credential("Other 01")


def test_the_module_function_gives_the_same_system(vault: Vault) -> None:
    vault.store().set_system(SYSTEM, secrets={"token": "t"})
    assert vault.module.get_credential(SYSTEM, vault.home, vault.passphrase) == vault.store().get_credential(SYSTEM)


def test_a_change_keeps_the_values_that_it_does_not_give(vault: Vault) -> None:
    vault.store().set_system(SYSTEM, url="https://example.com", secrets={"username": "u", "token": "t"})
    vault.store().set_system(SYSTEM, secrets={"token": "new"})
    found = vault.store().get_credential(SYSTEM)
    assert found.url == "https://example.com"
    assert dict(found.secrets()) == {"username": "u", "token": "new"}


def test_the_fake_has_the_signatures_of_the_real_api() -> None:
    import inspect
    for name in ("get_credential",):
        assert inspect.signature(getattr(credstore_fake, name)) == inspect.signature(getattr(credstore, name))
    for method in ("__init__", "get_credential", "set_system"):
        fake = inspect.signature(getattr(credstore_fake.Store, method))
        real = inspect.signature(getattr(credstore.Store, method))
        assert list(fake.parameters) == list(real.parameters), method
        assert [p.default for p in fake.parameters.values()] == [p.default for p in real.parameters.values()], method

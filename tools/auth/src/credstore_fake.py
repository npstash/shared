"""Verified fake of the read side of credstore, for the unit tests of the users of the vault.

Rule tests-and-ci of maya-agent-kit: the submodule supplies the test double of its API.
tests/test_credstore_contract.py runs the same cases against this fake and against credstore
with a throwaway vault.

The fake keeps the systems in memory, one set for each vault home. It has no keys, no files
and no log. Credential and the errors are the classes of credstore.

    import credstore_fake
    credstore_fake.Store(home).set_system("API 01", secrets={"token": "t"})   # test data
    credstore_fake.get_credential("API 01", home).secrets()["token"]          # code under test
"""
from __future__ import annotations

from pathlib import Path

from credstore import Credential, CredentialError, NoWayToOpen

__all__ = ["Credential", "CredentialError", "NoWayToOpen", "Store", "get_credential"]

# The systems of each vault home.
_VAULTS: dict[Path, dict[str, Credential]] = {}


class Store:
    """The vault of `vault_home`, in memory. The other arguments are as in credstore.Store."""

    def __init__(self, vault_home: Path | str, passphrase: str | None = None,
                 interactive: bool = False) -> None:
        if not vault_home:
            raise CredentialError("give the vault home")
        self.home = Path(vault_home)
        self.interactive = interactive
        self._systems = _VAULTS.setdefault(self.home.resolve(), {})

    def get_credential(self, system: str) -> Credential:
        """A system with all its secrets."""
        found = self._systems.get(system)
        if found is None:
            raise CredentialError(f"unknown system {system!r}")
        return found

    def set_system(self, system: str, url: str | None = None, authority_info: list[str] | None = None,
                   secrets: dict[str, str] | None = None) -> Credential:
        """Add or change a system: the test data. A value that is not given stays."""
        old = self._systems.get(system)
        new = Credential(
            system,
            url if url is not None else (old.url if old else None),
            tuple(authority_info) if authority_info is not None else (old.authority_info if old else ()),
            {**(dict(old.secrets()) if old else {}), **(secrets or {})},
        )
        self._systems[system] = new
        return new


def get_credential(system: str, vault_home: Path | str, passphrase: str | None = None) -> Credential:
    return Store(vault_home, passphrase).get_credential(system)

"""Keep the temp folders of pytest in .local_assets/ of the item (rule tests-and-ci).

pytest makes --basetemp without its parent folder. .local_assets/ is gitignored, thus a new clone
or a CI checkout does not have it. This file makes the parent folder and gives an absolute path,
also when pytest starts in another folder.
"""
from pathlib import Path

import pytest

BASETEMP: Path = Path(__file__).resolve().parent / ".local_assets" / "pytest"


def pytest_configure(config: pytest.Config) -> None:
    # A --basetemp on the command line has priority.
    if config.option.basetemp:
        return
    BASETEMP.parent.mkdir(parents=True, exist_ok=True)
    config.option.basetemp = str(BASETEMP)

"""Keep pytest's temp directories inside the project (rule: nothing-outside-repo).

pytest creates --basetemp with a non-recursive mkdir, and only when a test first asks
for tmp_path, so the parent directory has to exist by then. `.local_assets/` is
gitignored, so a fresh clone or a CI checkout has none and every tmp_path test errors
in setup. Pinning an absolute path here also keeps the directory in the project when
pytest is invoked from the repository root, where a relative --basetemp would resolve
against the wrong working directory.
"""
from pathlib import Path

BASETEMP = Path(__file__).resolve().parent / ".local_assets" / "pytest"


def pytest_configure(config):
    # An explicit --basetemp on the command line wins.
    if config.option.basetemp:
        return
    BASETEMP.parent.mkdir(parents=True, exist_ok=True)
    config.option.basetemp = str(BASETEMP)

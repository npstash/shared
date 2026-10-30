"""Find a shareable submodule, e.g. shared or a vault.

Reference code: rules/submodule-dependencies.py of the repository shared (rule
submodule-dependencies). Do not change a copy. Change the reference code, then copy it again.

    from dependencies import find
    shared = find("shared", start=PROJECT)       # PROJECT: the folder of the project or tool

CLI: python dependencies.py NAME [START]  - print the folder of NAME.
"""
from __future__ import annotations

import sys
from pathlib import Path

DEPENDENCIES = "dependencies.txt"


class DependencyError(Exception):
    """A shareable submodule is not found."""


def repo_root(start: Path) -> Path:
    """The first folder from `start` upwards that has .git or dependencies.txt."""
    start = Path(start).resolve()
    for folder in (start, *start.parents):
        if (folder / ".git").exists() or (folder / DEPENDENCIES).is_file():
            return folder
    raise DependencyError(f"no folder with .git or {DEPENDENCIES} in {start} or above it")


def repo_name(url: str) -> str:
    """The name of a repository from its URL: '../vault-main.git' gives 'vault-main'."""
    name = url.strip().rstrip("/").replace(":", "/").rsplit("/", 1)[-1]
    return name[:-len(".git")] if name.endswith(".git") else name


def submodules(root: Path) -> dict[str, str]:
    """Repository name -> path of each submodule in root/.gitmodules."""
    file = Path(root) / ".gitmodules"
    if not file.is_file():
        return {}
    entries: list[dict[str, str]] = []
    for line in file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("["):
            entries.append({})
        elif entries and "=" in line:
            key, value = line.split("=", 1)
            entries[-1][key.strip()] = value.strip()
    return {repo_name(e["url"]): e["path"] for e in entries if "url" in e and "path" in e}


def dependencies(root: Path) -> dict[str, list[str]]:
    """Name -> paths of each section in root/dependencies.txt, in the order of the file."""
    file = Path(root) / DEPENDENCIES
    if not file.is_file():
        return {}
    sections: dict[str, list[str]] = {}
    paths: list[str] | None = None
    for line in file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            paths = sections.setdefault(line[1:-1].strip(), [])
        elif paths is None:
            raise DependencyError(f"{file}: a path before the first section: {line}")
        elif Path(line).is_absolute():
            raise DependencyError(f"{file}: give a relative path: {line}")
        else:
            paths.append(line)
    return sections


def _exists(folder: Path) -> bool:
    """A folder that exists and is not empty. An empty folder is a submodule without checkout."""
    return folder.is_dir() and any(folder.iterdir())


def find(name: str, start: Path | str | None = None) -> Path:
    """The folder of the shareable submodule `name`.

    `start` is a folder of the project or tool (default: the folder of this file). The search
    uses the repository root above `start`: first its .gitmodules, then its dependencies.txt.
    """
    root = repo_root(Path(start) if start is not None else Path(__file__).parent)
    path = submodules(root).get(name)
    if path is not None:
        folder = (root / path).resolve()
        if not _exists(folder):
            raise DependencyError(f"the submodule {name} in {folder} is empty; run setup.sh in {root}")
        return folder
    tried = [(root / p).resolve() for p in dependencies(root).get(name, [])]
    for folder in tried:
        if _exists(folder):
            return folder
    raise DependencyError(
        f"{name} is not found: it is not a submodule in {root / '.gitmodules'}, and no folder of "
        f"[{name}] in {root / DEPENDENCIES} exists" + "".join(f"\n  {f}" for f in tried))


def main(argv: list[str]) -> int:
    if len(argv) not in (1, 2):
        print("usage: dependencies.py NAME [START]", file=sys.stderr)
        return 2
    try:
        print(find(argv[0], argv[1] if len(argv) == 2 else None))
    except DependencyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

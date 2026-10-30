"""Tests of dependencies.py, the copy of the reference code of the rule submodule-dependencies."""
import re
from pathlib import Path

import pytest

import dependencies as dep

REFERENCE = Path(__file__).resolve().parents[3] / "rules" / "submodule-dependencies.py"


def make(folder: Path) -> Path:
    """A folder that is not empty: a checked-out repository."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "README.md").write_text("x\n")
    return folder


def repo(folder: Path, gitmodules: str = "", dependencies: str | None = None) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / ".git").mkdir()
    if gitmodules:
        (folder / ".gitmodules").write_text(gitmodules)
    if dependencies is not None:
        (folder / "dependencies.txt").write_text(dependencies)
    return folder


GITMODULES = """[submodule "shared"]
\tpath = shared
\turl = ../shared.git
[submodule "vaults/vault-main"]
\tpath = vaults/vault-main
\turl = git@github.com:npstash/vault-main.git
"""


def test_the_submodule_of_the_repository_comes_first(tmp_path):
    root = repo(tmp_path / "ws", GITMODULES, "[shared]\n../elsewhere\n")
    make(root / "shared")
    make(tmp_path / "elsewhere")
    start = root / "projects" / "p" / "src"
    start.mkdir(parents=True)
    assert dep.find("shared", start) == root / "shared"


def test_the_name_is_the_repository_name_of_the_url(tmp_path):
    root = repo(tmp_path / "ws", GITMODULES)
    make(root / "vaults" / "vault-main")
    assert dep.find("vault-main", root) == root / "vaults" / "vault-main"
    assert dep.repo_name("https://github.com/npstash/shared/") == "shared"


def test_an_empty_submodule_stops_the_search(tmp_path):
    root = repo(tmp_path / "ws", GITMODULES, "[shared]\n../elsewhere\n")
    (root / "shared").mkdir()
    make(tmp_path / "elsewhere")
    with pytest.raises(dep.DependencyError, match="empty; run setup.sh"):
        dep.find("shared", root)


def test_dependencies_txt_gives_the_first_folder_that_exists(tmp_path):
    root = repo(tmp_path / "ws" / "projects" / "p", dependencies="# c\n[shared]\n../../shared\n../shared\n./shared\n")
    make(tmp_path / "ws" / "projects" / "shared")
    make(root / "shared")
    assert dep.find("shared", root / "src") == tmp_path / "ws" / "projects" / "shared"
    make(tmp_path / "ws" / "shared")
    assert dep.find("shared", root / "src") == tmp_path / "ws" / "shared"


def test_dependencies_txt_without_git_is_a_root(tmp_path):
    root = tmp_path / "workspace" / "projects" / "p"
    root.mkdir(parents=True)
    (root / "dependencies.txt").write_text("[shared]\n../../shared\n")
    make(tmp_path / "workspace" / "shared")
    assert dep.find("shared", root / "a" / "b") == tmp_path / "workspace" / "shared"


def test_not_found_lists_the_folders_tried(tmp_path):
    root = repo(tmp_path / "p", dependencies="[shared]\n../shared\n")
    with pytest.raises(dep.DependencyError, match=r"shared is not found(.|\n)*" + re.escape(str(tmp_path / "shared"))):
        dep.find("shared", root)


def test_absolute_paths_and_paths_without_a_section_are_refused(tmp_path):
    root = repo(tmp_path / "p", dependencies=f"[shared]\n{tmp_path}\n")
    with pytest.raises(dep.DependencyError, match="relative path"):
        dep.find("shared", root)
    (root / "dependencies.txt").write_text("../shared\n")
    with pytest.raises(dep.DependencyError, match="before the first section"):
        dep.find("shared", root)


def test_no_root(tmp_path, monkeypatch):
    monkeypatch.setattr(dep.Path, "exists", lambda self: False)
    monkeypatch.setattr(dep.Path, "is_file", lambda self: False)
    with pytest.raises(dep.DependencyError, match="no folder with .git"):
        dep.repo_root(tmp_path)


def test_cli(tmp_path, capsys):
    root = repo(tmp_path / "p", dependencies="[shared]\n../shared\n")
    make(tmp_path / "shared")
    assert dep.main(["shared", str(root)]) == 0
    assert capsys.readouterr().out.strip() == str(tmp_path / "shared")
    assert dep.main(["vault-x", str(root)]) == 1
    assert dep.main([]) == 2


def test_this_file_is_a_copy_of_the_reference_code():
    assert Path(dep.__file__).read_text(encoding="utf-8") == REFERENCE.read_text(encoding="utf-8")

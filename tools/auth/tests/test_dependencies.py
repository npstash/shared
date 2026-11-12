"""Tests of dependencies.py, the copy of the reference code of the rule submodule-dependencies."""
from collections.abc import Iterator
import re
from pathlib import Path

import pytest

import dependencies as dep

REFERENCE = Path(__file__).resolve().parents[3] / "rules" / "submodule-dependencies.py"


@pytest.fixture(autouse=True)
def only_tmp_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The search goes up to the roots above. Keep it in tmp_path: tmp_path can be in a repository."""
    real = dep.roots
    def roots(start: Path | str | None = None) -> Iterator[Path]:
        return (r for r in real(start) if tmp_path in r.parents)

    monkeypatch.setattr(dep, "roots", roots)


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


def test_the_submodule_of_the_repository_comes_first(tmp_path: Path) -> None:
    root = repo(tmp_path / "ws", GITMODULES, "[shared]\n../elsewhere\n")
    make(root / "shared")
    make(tmp_path / "elsewhere")
    start = root / "projects" / "p" / "src"
    start.mkdir(parents=True)
    assert dep.find("shared", start) == root / "shared"


def test_the_name_is_the_repository_name_of_the_url(tmp_path: Path) -> None:
    root = repo(tmp_path / "ws", GITMODULES)
    make(root / "vaults" / "vault-main")
    assert dep.find("vault-main", root) == root / "vaults" / "vault-main"
    assert dep.repo_name("https://github.com/npstash/shared/") == "shared"


def test_an_empty_submodule_stops_the_search(tmp_path: Path) -> None:
    root = repo(tmp_path / "ws", GITMODULES, "[shared]\n../elsewhere\n")
    (root / "shared").mkdir()
    make(tmp_path / "elsewhere")
    with pytest.raises(dep.DependencyError, match="empty; run setup.sh"):
        dep.find("shared", root)


def test_dependencies_txt_gives_the_first_folder_that_exists(tmp_path: Path) -> None:
    root = repo(tmp_path / "ws" / "projects" / "p", dependencies="# c\n[shared]\n../../shared\n../shared\n./shared\n")
    make(tmp_path / "ws" / "projects" / "shared")
    make(root / "shared")
    assert dep.find("shared", root / "src") == tmp_path / "ws" / "projects" / "shared"
    make(tmp_path / "ws" / "shared")
    assert dep.find("shared", root / "src") == tmp_path / "ws" / "shared"


def test_dependencies_txt_without_git_is_a_root(tmp_path: Path) -> None:
    root = tmp_path / "workspace" / "projects" / "p"
    root.mkdir(parents=True)
    (root / "dependencies.txt").write_text("[shared]\n../../shared\n")
    make(tmp_path / "workspace" / "shared")
    assert dep.find("shared", root / "a" / "b") == tmp_path / "workspace" / "shared"


def test_the_search_continues_in_the_root_above(tmp_path: Path) -> None:
    workspace = repo(tmp_path / "ws", '[submodule "vaults/vault-x"]\n\tpath = vaults/vault-x\n\turl = ../vault-x.git\n')
    make(workspace / "vaults" / "vault-x")
    shared = workspace / "shared"
    shared.mkdir()
    (shared / ".git").write_text("gitdir: x\n")              # a submodule: .git is a file
    (shared / "dependencies.txt").write_text("[vault-x]\n../missing\n")
    assert [r for r in dep.roots(shared / "tools")][:2] == [shared, workspace]
    assert dep.find("vault-x", shared / "tools") == workspace / "vaults" / "vault-x"
    with pytest.raises(dep.DependencyError, match=r"vault-y is not found.*in these roots: .*shared, .*ws"):
        dep.find("vault-y", shared / "tools")


def test_not_found_lists_the_folders_tried(tmp_path: Path) -> None:
    root = repo(tmp_path / "p", dependencies="[shared]\n../shared\n")
    with pytest.raises(dep.DependencyError, match=r"shared is not found(.|\n)*" + re.escape(str(tmp_path / "shared"))):
        dep.find("shared", root)


def test_absolute_paths_and_paths_without_a_section_are_refused(tmp_path: Path) -> None:
    root = repo(tmp_path / "p", dependencies=f"[shared]\n{tmp_path}\n")
    with pytest.raises(dep.DependencyError, match="relative path"):
        dep.find("shared", root)
    (root / "dependencies.txt").write_text("../shared\n")
    with pytest.raises(dep.DependencyError, match="before the first section"):
        dep.find("shared", root)


def test_no_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(Path, "exists", lambda self: False)
    monkeypatch.setattr(Path, "is_file", lambda self: False)
    with pytest.raises(dep.DependencyError, match="no folder with .git"):
        dep.repo_root(tmp_path)


def test_cli(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = repo(tmp_path / "p", dependencies="[shared]\n../shared\n")
    make(tmp_path / "shared")
    assert dep.main(["shared", str(root)]) == 0
    assert capsys.readouterr().out.strip() == str(tmp_path / "shared")
    assert dep.main(["vault-x", str(root)]) == 1
    assert dep.main([]) == 2


def test_this_file_is_a_copy_of_the_reference_code() -> None:
    assert Path(dep.__file__).read_text(encoding="utf-8") == REFERENCE.read_text(encoding="utf-8")

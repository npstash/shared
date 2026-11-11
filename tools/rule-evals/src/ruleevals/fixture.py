"""Copies of the repository that the agent runs in."""
import os
import re
import shutil
import subprocess
import tempfile
from abc import ABC, abstractmethod
from pathlib import Path

from ruleevals.scenario import EVALS_FILE

WORKTREE: str = "worktree"
MARKER: str = ".rule-evals"
EXCLUDES: tuple[str, ...] = (".venv", "venv", "node_modules", ".local_assets", "__pycache__")
VAULT_PREFIX: str = "vault-"
FIXTURE_IDENTITY: tuple[str, ...] = ("-c", "user.name=rule-evals", "-c", "user.email=rule-evals@localhost")


class FixtureError(RuntimeError):
    """A fixture cannot be made."""


class FixtureMaker(ABC):
    """Makes one fixture for each run."""

    @abstractmethod
    def prepare(self, ruleset: str) -> None:
        """Make the template of a rule set: a git ref, or WORKTREE for the files as they are."""

    @abstractmethod
    def reset(self, slot: int) -> Path:
        """Make the fixture of a slot equal to the template. Give its path."""

    @abstractmethod
    def cleanup(self) -> None:
        """Delete all fixtures."""


def _run(command: list[str], cwd: Path) -> str:
    done: subprocess.CompletedProcess[str] = subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise FixtureError(f"{' '.join(command)}: {done.stderr.strip()[:500]}")
    return done.stdout


class CopyFixtureMaker(FixtureMaker):
    """Copies the repository into `<repo>_evals/` beside the repository.

    A fixture outside the repository does not load the `AGENTS.md` of the repository as a parent.
    A slot keeps its path between runs. Thus the prompt cache of the model stays valid.
    """

    def __init__(self, repo: Path) -> None:
        self._repo: Path = repo
        self._home: Path = repo.parent / f"{repo.name}_evals"
        self._template: Path = self._home / "template"

    @property
    def home(self) -> Path:
        return self._home

    def prepare(self, ruleset: str) -> None:
        if self._home.exists() and not (self._home / MARKER).is_file():
            raise FixtureError(f"{self._home} exists and is not a folder of rule-evals")
        self._home.mkdir(exist_ok=True)
        (self._home / MARKER).write_text("made by rule-evals; safe to delete\n", encoding="utf-8")
        self._sync(self._repo, self._template)
        if ruleset != WORKTREE:
            _run(["git", "checkout", "--force", "--detach", ruleset], self._template)
            _run(["git", "submodule", "update", "--force", "--no-fetch"], self._template)
            _run(["git", "clean", "-fd"], self._template)
            _run(["git", "submodule", "foreach", "--recursive", "git clean -fd"], self._template)
        self._remove_vaults()
        for path in self._template.glob(f"*/rules/**/{EVALS_FILE}"):
            path.unlink()
        self._commit()

    def reset(self, slot: int) -> Path:
        path: Path = self._home / f"slot-{slot}"
        self._sync(self._template, path)
        return path

    def cleanup(self) -> None:
        if (self._home / MARKER).is_file():
            shutil.rmtree(self._home)
        for path in self._scratchpads():
            shutil.rmtree(path, ignore_errors=True)

    def _scratchpads(self) -> list[Path]:
        """Give the scratchpad folders that Claude Code made for the fixtures in the temp folder."""
        prefix: str = re.sub(r"[^A-Za-z0-9]", "-", str(self._home)) + "-"
        root: Path = Path(tempfile.gettempdir()) / f"claude-{os.getuid()}"
        return [path for path in root.glob(f"{prefix}*") if path.is_dir()]

    def _sync(self, source: Path, target: Path) -> None:
        excludes: list[str] = [f"--exclude={name}" for name in EXCLUDES]
        _run(["rsync", "-a", "--delete", "--delete-excluded", *excludes, f"{source}/", f"{target}/"], self._home)

    def _remove_vaults(self) -> None:
        """Remove the files of each vault submodule. The agent must not open a real vault."""
        paths: str = _run(["git", "config", "--file", ".gitmodules", "--get-regexp", r"\.path$"], self._template)
        for line in paths.splitlines():
            path: str = line.split(" ", 1)[1]
            if Path(path).name.startswith(VAULT_PREFIX):
                _run(["git", "submodule", "deinit", "--force", "--", path], self._template)

    def _commit(self) -> None:
        """Commit the state of the template. Each fixture starts with a clean work tree."""
        commit: str = "git add -A && git -c user.name=rule-evals -c user.email=rule-evals@localhost commit -q --allow-empty -m fixture"
        _run(["git", "submodule", "foreach", "--recursive", commit], self._template)
        _run(["git", "add", "-A"], self._template)
        _run(["git", *FIXTURE_IDENTITY, "commit", "-q", "--allow-empty", "-m", "fixture"], self._template)

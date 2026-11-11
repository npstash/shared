"""Find a Claude Code binary that reads `AGENTS.md`."""
import re
import shutil
import subprocess
from pathlib import Path

AUTO: str = "auto"
# The first version that reads `AGENTS.md` (rule repo-structure).
MIN_VERSION: tuple[int, int, int] = (2, 1, 277)
EXTENSION_GLOBS: tuple[str, ...] = (
    ".vscode-server/extensions/anthropic.claude-code-*/resources/native-binary/claude",
    ".vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude",
)
VERSION_TIMEOUT_S: int = 30


class BinaryError(RuntimeError):
    """No Claude Code binary is new enough."""


def parse_version(text: str) -> tuple[int, int, int] | None:
    """Give the version in the output of `claude --version`."""
    match: re.Match[str] | None = re.search(r"(\d+)\.(\d+)\.(\d+)", text)
    if match is None:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def _version(binary: Path) -> tuple[int, int, int] | None:
    try:
        done: subprocess.CompletedProcess[str] = subprocess.run(
            [str(binary), "--version"], capture_output=True, text=True, timeout=VERSION_TIMEOUT_S, check=False
        )
    except OSError:
        return None
    return parse_version(done.stdout)


def candidates(home: Path) -> list[Path]:
    """Give the binaries of the VSCode extension, and the `claude` on the path."""
    found: list[Path] = [path for pattern in EXTENSION_GLOBS for path in home.glob(pattern) if path.is_file()]
    on_path: str | None = shutil.which("claude")
    if on_path is not None:
        found.append(Path(on_path))
    return found


def find_claude_binary(home: Path | None = None) -> str:
    """Give the newest binary with a version of MIN_VERSION or later."""
    versions: list[tuple[tuple[int, int, int], Path]] = []
    for path in candidates(home or Path.home()):
        version: tuple[int, int, int] | None = _version(path)
        if version is not None and version >= MIN_VERSION:
            versions.append((version, path))
    if not versions:
        minimum: str = ".".join(str(part) for part in MIN_VERSION)
        raise BinaryError(f"no Claude Code {minimum} or later; give the path with --claude-bin")
    return str(max(versions)[1])

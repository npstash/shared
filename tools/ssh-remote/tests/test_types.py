"""Static analysis of the project (rule typed-code): mypy in strict mode, no explicit Any."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_mypy_strict() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "mypy", "--config-file", str(ROOT / "mypy.ini")],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr

#!/usr/bin/env bash
# Launcher (rules per-project-runtimes and tests-and-ci). Makes or updates the runtime in .venv/.
#   run.sh test [pytest args]   install the test dependencies and run the tests
#   run.sh [args]               run the item
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! cmp -s "$dir/requirements.txt" "$dir/.venv/requirements.txt" 2>/dev/null; then
    [[ -x "$dir/.venv/bin/python" ]] || python3 -m venv "$dir/.venv"
    "$dir/.venv/bin/python" -m pip install --quiet -r "$dir/requirements.txt"
    cp "$dir/requirements.txt" "$dir/.venv/requirements.txt"
fi
# The bytecode caches of each Python of the runtime go into .local_assets/ (rule tests-and-ci).
"$dir/.venv/bin/python" -c 'import pathlib, sys, sysconfig; pathlib.Path(sysconfig.get_paths()["purelib"], "local-assets-pycache.pth").write_text(f"import sys; sys.pycache_prefix = {sys.argv[1]!r}\n")' "$dir/.local_assets/pycache"
if [[ "${1:-}" == "test" ]]; then
    shift
    "$dir/.venv/bin/python" -m pip install --quiet -r "$dir/requirements-dev.txt"
    exec "$dir/.venv/bin/python" -m pytest "$dir/tests" "$@"
fi
exec "$dir/.venv/bin/python" "$dir/src/main.py" "$@"

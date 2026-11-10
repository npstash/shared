#!/usr/bin/env bash
# ssh-remote launcher: builds the project venv on first use (or when requirements change).
# `run.sh test` runs the project's tests, pulling in requirements-dev.txt on demand.
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="$dir/src:$dir/../auth/src"
if ! cmp -s "$dir/requirements.txt" "$dir/.venv/requirements.txt" 2>/dev/null; then
    [[ -x "$dir/.venv/bin/python" ]] || python3 -m venv "$dir/.venv"
    "$dir/.venv/bin/python" -m pip install --quiet -r "$dir/requirements.txt"
    cp "$dir/requirements.txt" "$dir/.venv/requirements.txt"
fi
# The bytecode caches of each Python of the runtime go into .local_assets/ (rule tests-and-ci).
"$dir/.venv/bin/python" -c 'import pathlib, sys, sysconfig; pathlib.Path(sysconfig.get_paths()["purelib"], "local-assets-pycache.pth").write_text(f"import sys; sys.pycache_prefix = {sys.argv[1]!r}\n")' "$dir/.local_assets/pycache"
if [[ "${1:-}" == "test" ]]; then
    shift
    # Dev dependencies stay out of the runtime venv until tests are actually asked for.
    "$dir/.venv/bin/python" -m pip install --quiet -r "$dir/requirements-dev.txt"
    exec "$dir/.venv/bin/python" -m pytest "$dir/tests" "$@"
fi
exec "$dir/.venv/bin/python" "$dir/src/sshremote.py" "$@"

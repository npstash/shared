#!/usr/bin/env bash
# credstore launcher: builds the project venv on first use (or when requirements change).
# `run.sh test` runs the project's tests, pulling in requirements-dev.txt on demand.
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! cmp -s "$dir/requirements.txt" "$dir/.venv/requirements.txt" 2>/dev/null; then
    [[ -x "$dir/.venv/bin/python" ]] || python3 -m venv "$dir/.venv"
    "$dir/.venv/bin/python" -m pip install --quiet -r "$dir/requirements.txt"
    cp "$dir/requirements.txt" "$dir/.venv/requirements.txt"
fi
if [[ "${1:-}" == "test" ]]; then
    shift
    # Dev dependencies stay out of the runtime venv until tests are actually asked for.
    "$dir/.venv/bin/python" -m pip install --quiet -r "$dir/requirements-dev.txt"
    exec "$dir/.venv/bin/python" -m pytest "$dir/tests" "$@"
fi
exec "$dir/.venv/bin/python" "$dir/credstore.py" "$@"

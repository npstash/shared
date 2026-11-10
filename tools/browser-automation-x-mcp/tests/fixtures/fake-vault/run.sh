#!/usr/bin/env bash
# Test double of shared/tools/auth/run.sh. See fake-vault.ts.
exec node "$(dirname "$0")/fake-vault.ts" "$@"

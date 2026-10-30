#!/usr/bin/env bash
# Launcher of the browser tool facades. Each facade is an MCP server on stdio.
#   run.sh <facade> [args]   start a facade, e.g. "run.sh playwright --isolated"
#   run.sh install           make the runtime and install the browsers, then stop
#   run.sh test              run the tests of the shared parts and of each facade
# A facade is a folder with src/server.js (e.g. playwright/).
# stdout is the MCP channel. Send all setup output to stderr.
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
assets="$dir/.local_assets"

# Pinned Node.js runtime. Playwright needs Node.js 20 or later.
NODE_VERSION="v24.22.1"
case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)  platform=linux-x64;    ext=tar.xz; sha=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6 ;;
    Linux-aarch64) platform=linux-arm64;  ext=tar.xz; sha=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e ;;
    Darwin-x86_64) platform=darwin-x64;   ext=tar.gz; sha=d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035 ;;
    Darwin-arm64)  platform=darwin-arm64; ext=tar.gz; sha=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7 ;;
    *) echo "run.sh: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

# 1. Node.js runtime in .local_assets/runtime/.
node_dir="$assets/runtime/node-$NODE_VERSION-$platform"
if [[ ! -x "$node_dir/bin/node" ]]; then
    echo "run.sh: download Node.js $NODE_VERSION ($platform)" >&2
    mkdir -p "$assets/runtime"
    archive="$node_dir.$ext"
    curl -fsSL -o "$archive" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$platform.$ext"
    if command -v sha256sum >/dev/null; then
        actual="$(sha256sum "$archive" | cut -d' ' -f1)"
    else
        actual="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
    fi
    if [[ "$actual" != "$sha" ]]; then
        rm -f "$archive"
        echo "run.sh: checksum of the Node.js download is wrong" >&2
        exit 1
    fi
    tar -xf "$archive" -C "$assets/runtime"
    rm -f "$archive"
fi
export PATH="$node_dir/bin:$PATH"
export npm_config_cache="$assets/npm-cache"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$assets/browsers/$platform}"

# 2. Node.js packages in node_modules/, again when package-lock.json changes.
if ! cmp -s "$dir/package-lock.json" "$dir/node_modules/.facade-lock" 2>/dev/null; then
    echo "run.sh: install the Node.js packages" >&2
    (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error) >&2
    cp "$dir/package-lock.json" "$dir/node_modules/.facade-lock"
fi

# 3. Playwright facade: Chromium, again when the Playwright version changes.
pw_version="$(node -p 'require(process.argv[1]).version' "$dir/node_modules/playwright-core/package.json")"
stamp="$PLAYWRIGHT_BROWSERS_PATH/.facade-chromium-$pw_version"
if [[ ! -f "$stamp" ]]; then
    echo "run.sh: install Chromium for Playwright $pw_version" >&2
    deps=()
    # CI runners have sudo. On other computers, install-deps is a manual step (see README.md).
    [[ "${CI:-}" == "true" ]] && deps=(--with-deps)
    node "$dir/node_modules/@playwright/mcp/cli.js" install-browser ${deps[@]+"${deps[@]}"} chromium >&2
    touch "$stamp"
fi

# 4. Playwright facade, Linux: the libraries and fonts that Chromium needs and the host does not
#    have. No root.
if [[ "$(uname -s)" == "Linux" ]]; then
    syslibs_stamp="$assets/syslibs/$platform/.ready-$pw_version"
    if [[ ! -f "$syslibs_stamp" ]]; then
        node "$dir/playwright/src/setup/syslibs.js" >&2
        mkdir -p "$(dirname "$syslibs_stamp")"
        touch "$syslibs_stamp"
    fi
fi

facades=()
for server in "$dir"/*/src/server.js; do
    facades+=("$(basename "$(dirname "$(dirname "$server")")")")
done

case "${1:-}" in
    install)
        echo "run.sh: the runtime is ready" >&2
        ;;
    test)
        shift
        patterns=("$dir/tests/*.test.js")
        for facade in "${facades[@]}"; do patterns+=("$dir/$facade/tests/*.test.js"); done
        exec node --test --test-concurrency=1 "$@" "${patterns[@]}"
        ;;
    *)
        facade="${1:-}"
        if [[ -z "$facade" || ! -f "$dir/$facade/src/server.js" ]]; then
            echo "run.sh: give a facade: ${facades[*]}" >&2
            exit 2
        fi
        shift
        exec node "$dir/$facade/src/server.js" "$@"
        ;;
esac

#!/bin/sh
# Set up this repository, then run setup.sh in each submodule. You can run it again.
# Give verbs to select the steps. Without a verb, all steps run. "setup.sh help" shows the verbs.
# 1. submodules: check out the submodules that have no checkout. Others stay as they are.
# 2. hooks: use .githooks/ as the hooks folder, if the repository has one.
# 3. links: link each skills/<name>/ and <folder>/skills/<name>/ into .claude/skills/. A parent
#    setup gives --nested to a submodule: then only the parent's .claude/skills/ gets links.
# The same verbs then run in each submodule.
# Keep the same as setup.bat and as the copies in the other repositories.
set -eu
cd "$(dirname "$0")"

usage() {
    cat <<'EOF'
Usage: setup.sh [verb...]
Verbs. They run in this order, whatever the order that you give:
  submodules  Check out the submodules that have no checkout.
  hooks       Use .githooks/ as the hooks folder, if the repository has one.
  links       Link each skills/<name>/ and <folder>/skills/<name>/ into .claude/skills/.
  all         Do all the steps above. This is the default.
  help        Show this text.
The same verbs then run in each submodule. "links" runs only in the top repository.
EOF
}

nested=false
if [ "${1:-}" = --nested ]; then nested=true; shift; fi
[ $# -gt 0 ] || set -- all
do_submodules=false; do_hooks=false; do_links=false
for verb in "$@"; do
    case $verb in
        submodules) do_submodules=true ;;
        hooks) do_hooks=true ;;
        links) do_links=true ;;
        all) do_submodules=true; do_hooks=true; do_links=true ;;
        help|-h|--help) usage; exit 0 ;;
        *) echo "error: unknown verb '$verb'" >&2; usage >&2; exit 2 ;;
    esac
done

if [ "$do_submodules" = true ]; then
    git submodule status | sed -n 's/^-[0-9a-f]* \(.*\)$/\1/p' | while IFS= read -r sub; do
        git submodule update --init -- "$sub"
    done
fi

if [ "$do_hooks" = true ]; then
    hooks=$(git config --get core.hooksPath || true)
    if [ -d .githooks ]; then
        if [ -z "$hooks" ] || [ "$hooks" = .githooks ]; then
            git config core.hooksPath .githooks
        else
            echo "warning: core.hooksPath is '$hooks', .githooks/ is not used" >&2
        fi
    elif [ "$hooks" = .githooks ]; then
        git config --unset core.hooksPath
    fi
fi

if [ "$do_links" = true ] && [ "$nested" = false ]; then
    for skill in skills/*/ */skills/*/; do
        [ -f "${skill}SKILL.md" ] || continue
        link=".claude/skills/$(basename "$skill")"
        mkdir -p .claude/skills
        if [ -L "$link" ] || [ ! -e "$link" ]; then
            rm -f "$link"
            ln -s "../../${skill%/}" "$link"
        else
            echo "warning: $link is not a link, it stays as it is" >&2
        fi
    done
    for link in .claude/skills/*; do   # remove the links to skills that do not exist now
        if [ -L "$link" ] && [ ! -e "$link" ]; then rm -f "$link"; fi
    done
fi

git submodule status | sed -n 's/^[ +U][0-9a-f]* \(.*\) (.*)$/\1/p' | while IFS= read -r sub; do
    if [ -f "$sub/setup.sh" ]; then
        sh "$sub/setup.sh" --nested "$@"
    else
        echo "note: $sub has no setup.sh" >&2
    fi
done

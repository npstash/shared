#!/bin/sh
# Set up this repository, then run setup.sh in each submodule. You can run it again.
# 1. Check out the submodules that have no checkout. Submodules with a checkout stay as they are.
# 2. Use .githooks/ as the hooks folder, if the repository has one.
# 3. Link each skills/<name>/ and <folder>/skills/<name>/ into .claude/skills/.
# Keep the same as setup.bat and as the copies in the other repositories.
set -eu
cd "$(dirname "$0")"

git submodule status | sed -n 's/^-[0-9a-f]* \(.*\)$/\1/p' | while IFS= read -r sub; do
    git submodule update --init -- "$sub"
done

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

git submodule status | sed -n 's/^[ +U][0-9a-f]* \(.*\) (.*)$/\1/p' | while IFS= read -r sub; do
    if [ -f "$sub/setup.sh" ]; then
        sh "$sub/setup.sh"
    else
        echo "note: $sub has no setup.sh" >&2
    fi
done

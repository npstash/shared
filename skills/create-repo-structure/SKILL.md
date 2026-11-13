---
name: create-repo-structure
description: Create or complete the structure of a repository that uses maya-agent-kit - root files, containers, projects and vaults folders, and the rule for the repository structure. Use only when the user asks, e.g. "create the repo structure", "set up this repository like the workspace".
---

# Create the repository structure

The target structure is in [repo-structure.md](repo-structure.md). The files to copy are in
[templates/](templates/).

## 1. Collect the inputs

Ask the user in one question section:

- `ROOT`: the repository root. The default is the current repository.
- `RULE_DIR`: the folder for the rule. The default is `local/rules`.
- `OWNER`: the GitHub owner of the repositories, e.g. `<owner>` in `<owner>/maya-agent-kit`.
- `MAYA_AGENT_KIT`: add the submodule `maya-agent-kit` at `maya/` if it is missing (yes or no). URL: `../maya-agent-kit.git`.

## 2. Compare

List the items of the table in section 3 that `ROOT` does not have.
Do not overwrite a file that exists. For each existing file that differs from its template,
show the difference and ask the user.

## 3. Create the missing items

| Item | Source |
|---|---|
| `AGENTS.md` | [templates/AGENTS.md](templates/AGENTS.md) |
| `local/AGENTS.md` | [templates/local-AGENTS.md](templates/local-AGENTS.md) |
| `<RULE_DIR>/repo-structure.md` | [repo-structure.md](repo-structure.md); replace `<owner>` with `OWNER` |
| `.gitignore` | [templates/gitignore](templates/gitignore) |
| `.gitattributes` | [templates/gitattributes](templates/gitattributes) |
| `.kilo/kilo.jsonc` | [templates/kilo.jsonc](templates/kilo.jsonc) |
| `setup.sh` | copy of `maya/setup.sh` |
| `.github/workflows/tests.yml` | copy of `maya/.github/workflows/tests.yml` |
| `projects/`, `vaults/` | empty folders; add a `.gitkeep` |

- If `MAYA_AGENT_KIT` is yes, run `git submodule add --name maya ../maya-agent-kit.git maya` before the copies.
- If `RULE_DIR` is not in `local/`, put the index line of the rule into the `AGENTS.md` of
  that container. Change the link to the rule.
- If the root `AGENTS.md` exists, add only the missing parts of the template to it.
- Add each container to the `instructions` of `.kilo/kilo.jsonc`.
- Do not create `.claude/skills/`. `setup.sh` makes it.

## 4. Finish

1. Run `setup.sh`.
2. Give the list of the created items, and the items that the user must decide.
3. To create a vault, tell the user to use the vault tool, `maya/tools/auth`. Do not create one.
4. Commit only as the branching rule of the repository says.

# Procedure

The target structure is in [repo-structure.md](repo-structure.md). The files to copy are in
[templates/](templates/).

## 1. Collect the inputs

Ask the user in one question section (rule decision-gates):

- `ROOT`: the repository root. The default is the current repository.
- `RULE_DIR`: the folder for the rule. The default is `local/rules`.
- `OWNER`: the GitHub owner of the repositories, e.g. `<owner>` in `<owner>/shared`.
- `SHARED`: add the `shared` submodule if it is missing (yes or no). URL: `../shared.git`.

## 2. Compare

List the items of "Root" and "Containers" in `repo-structure.md` that `ROOT` does not have.
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
| `setup.sh`, `setup.bat` | copy of `shared/setup.sh` and `shared/setup.bat` |
| `.github/workflows/tests.yml` | copy of `shared/.github/workflows/tests.yml` |
| `projects/`, `vaults/` | empty folders; add a `.gitkeep` |

- If `SHARED` is yes, run `git submodule add ../shared.git shared` before the copies.
- If `RULE_DIR` is not in `local/`, put the index line of the rule into the `AGENTS.md` of
  that container. Change the `@` path to the rule.
- Add each container to the `instructions` of `.kilo/kilo.jsonc`.
- Do not create `.claude/skills/`. `setup.sh` makes it.

## 4. Finish

1. Run `setup.sh` (or `setup.bat`).
2. Give the list of the created items, and the items that the user must decide.
3. To create a vault, tell the user to use the vault tool, `shared/tools/auth`. Do not create one.
4. Commit only as the branching rule of the repository says.

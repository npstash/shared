# Repository structure

## Root

```
AGENTS.md             root index; it imports the container indexes
setup.sh setup.bat    set up a clone; copies of shared/setup.*
.gitattributes .gitignore
.github/workflows/    CI; tests.yml is a copy of shared/.github/workflows/tests.yml
.claude/              Claude Code config; skills/ holds only links that setup.sh makes
.kilo/ .vscode/ .mcp.json   config of other agent tools and of the editor
.local_assets/        repo-wide scratch; gitignored
local/                container: only this repository uses it
shared/               container; submodule <owner>/shared; other repositories use it too
vaults/               the vaults: submodules vaults/vault-<name> (<owner>/vault-<name>); not a container
projects/             projects and groups of projects; see "projects"
```

- Put nothing else into the root. To add an item, ask the user and update this list.
- Never put a skill directly into `.claude/skills/`.
- Run `setup.sh` / `setup.bat` after each clone, and after you add or remove a skill.

## Containers

```
<container>/
  AGENTS.md                       index of rules and skills; one section for each agent
  rules/<id>.md                   rule for all agents
  rules/<agent>/<id>.md           rule for one agent only (e.g. claude/)
  rules/<id>.<ext>                a file of a rule, e.g. reference code; the rule gives a link
  skills/<name>/SKILL.md          skill; setup.sh links it to .claude/skills/<name>
  skills/<agent>/<name>/SKILL.md  skill for one agent only
  tools/<name>/                   tool; see "Tool and project folders"
```

- Omit a folder that has no content.
- Add an index line for each rule and skill to the section of its agent in `AGENTS.md`.
- Do not index tools in `AGENTS.md`. A rule or a skill gives a link to a tool if necessary.
- Do not add a `CLAUDE.md`. Claude Code reads `AGENTS.md`.
- A container that is a submodule also holds the root files of its repository.
- The user decides the container and the folder of each rule, tool and skill.

## vaults

- Each vault is a submodule `vaults/vault-<name>` of the repository `<owner>/vault-<name>`.
- `vault-main` is the main vault.
- A project with its own vault uses `vault-<project>`.
- A vault holds only the files of the vault. See the vault tool, `shared/tools/auth`.
- Change a vault only with the vault tool.

## projects

```
projects/<project>/                          a project
projects/<group>/<project>/                  a project in a group
projects/<project>/components/<component>/   a component of a project
```

- A project is one task. It can contain deliverables.
- A project can be a submodule with its own repository `<owner>/<project>`. It follows the
  same rules.
- A group is a category of projects. It contains only projects.
- Do not put a group into a group.
- The user decides if a folder is a group or a project.
- A project with code also follows "Tool and project folders".

### Components

- A component is a part of a project, e.g. a C4 container or a C4 component.
- Use a component only in its project. A component is not independent.
- A component follows the rules of a project.
- Do not put a component into a component.

## Tool and project folders

- Put generated files into gitignored folders: `.venv/`, `.local_assets/`, `node_modules/`, caches.
- Python: put the source into `src/`.
- Other languages: follow the convention of the language.
- Add other folders only as the tool or project needs them (e.g. `docs/`, `config/`, `data/`).

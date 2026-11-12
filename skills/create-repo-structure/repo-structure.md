# Repository structure

This rule gives the place of each kind of content. If content fits no place, ask the user where
to put it. Do not make a new place yourself.

| Content | Place |
|---|---|
| Rule, skill or tool for this repository only | `local/` |
| Rule, skill or tool that other repositories also use | `shared/`, the submodule `<owner>/shared` |
| Config of the tool or project `<name>` for this repository | `local/configs/<name>/` |
| Vault | `vaults/vault-<name>/`, a submodule `<owner>/vault-<name>` |
| Project | `projects/`; see "Projects" |

## Containers

`local/` and `shared/` are the containers. Each container has the same structure:

```
<container>/
  AGENTS.md        index of the rules and skills
  rules/           rules
  skills/<name>/   skill
  tools/<name>/    tool
```

Ask the user for the container of a new tool.

## Projects

```
projects/<project>/                          a project
projects/<group>/<project>/                  a project in a group
projects/<project>/components/<component>/   a component of a project
```

- A project is one task. It can contain deliverables.
- A group is a category of projects. It contains only projects. Do not put a group into a group.
- Ask the user if a new folder is a project or a group.
- A project can be a submodule with its own repository, `<owner>/<project>`. It follows the same rules.
- A component is a part of a project, e.g. a C4 container or a C4 component. It is not
  independent: use it only in its project.
- A component follows the rules of a project. Do not put a component into a component.
- In a Python tool or project, put the source into `src/`.

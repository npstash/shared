# Submodule dependencies

A shareable submodule is a repository that other repositories use as a submodule, e.g.
`shared` or a vault (`vault-<name>`). Its name is the name of its repository.

- Find a shareable submodule only with a copy of the reference code
  [submodule-dependencies.py](submodule-dependencies.py).
- Do not write a fixed path to it in code, scripts or configuration.
- Do not change a copy of the reference code.
- For the lookup order, `dependencies.txt`, the copy and its test, use the skill
  [submodule-dependencies](../skills/submodule-dependencies/SKILL.md).

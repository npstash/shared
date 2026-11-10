# Typed code

Do not write untyped code.

- Give a type to each parameter, return value, field, constant and exported value.
- JavaScript: write TypeScript in strict mode. Do not write new `.js` files.
- Python: write type hints.
- Do not use `any` (TypeScript) or `Any` (Python).
- Declare each interface separately from its implementation: an interface or an abstract
  class, then a class that implements it.

## Checks

- Check the types with a type checker, e.g. `tsc --noEmit` in strict mode.
- Find each explicit `any` or `Any` with a lint.
- Make each check a test of `run.sh test`.
- In a project with test phases, the checks are the static analysis phase. See section
  "Verification" of the [SDD workflow](../tools/sdd-templates/workflow.md).

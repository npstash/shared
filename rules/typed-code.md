# Typed code

- Give a type to each parameter, return value, field, constant and exported value.
- JavaScript: write TypeScript in strict mode. Do not write new `.js` files.
- Python: write type hints.
- Declare each exposed interface separately from its implementation: an interface or an
  abstract class, then a class that implements it. An exposed interface is an API that another
  component, project or process uses. An internal class needs no interface.

## Checks

- Check the types with a type checker, e.g. `tsc --noEmit` in strict mode.
- Find each explicit `any` or `Any` with a lint.
- Make each check a test of `run.sh test`. For Python, start from `mypy.ini` and
  `test_types.py` in the [templates](tests-and-ci/).
- In a project with test phases, the checks are the static analysis phase. See section
  "Verification" of the [SDD workflow](../tools/sdd-templates/workflow.md).

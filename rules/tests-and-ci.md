---
id: tests-and-ci
summary: Tests live in a tests/ subfolder per project or tool, run with run.sh test, and run in CI,
  which discovers them automatically.
applies-to: all-agents
requires:
  - .github/workflows/tests.yml   # a copy of the one in this repository
related: [per-project-runtimes]
---

# Tests and CI

- Put the tests of each project or tool into its folder, per language convention:
  Python `tests/`, Node/TS `tests/` or `__tests__/`, Go `*_test.go` beside the source,
  .NET `<Project>.Tests/`.
- Python: `pytest`, with test dependencies in `requirements-dev.txt`.
- `run.sh test` / `run.bat test` installs the dev dependencies and runs the suite.
  Install dev dependencies only on that path. The runtime venv can hold them.
- Each repository has `.github/workflows/tests.yml`, a copy of
  [this one](../.github/workflows/tests.yml). It runs `run.sh test` in each folder with
  `tests/` and `run.sh`, one job each, on push/PR to `main` or manually. A new project
  needs no edit.
- CI does not check out submodules.
- Give another runner or language a sibling workflow file.

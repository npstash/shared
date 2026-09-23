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

- Each project or tool with code has tests in its own folder, per language convention:
  Python `tests/`, Node/TS `tests/` or `__tests__/`, Go `*_test.go` beside the source,
  .NET `<Project>.Tests/`.
- Python uses `pytest`, with test deps in `requirements-dev.txt`.
- Every `run.sh` / `run.bat` takes a `test` verb: it installs the dev dependencies and
  runs the suite, so a fresh clone needs no other incantation. Install dev dependencies
  on that path only. They can go into the runtime venv.
- Each repository has `.github/workflows/tests.yml`, a copy of
  [this one](../.github/workflows/tests.yml). It finds each folder with `tests/` and
  `run.sh`, and runs `run.sh test` there in its own job with a fresh runtime. It runs
  on push/PR to `main` or manually. A new project needs no edit.
- CI does not check out submodules. Each repository tests only its own folders.
- Another runner or language gets a sibling workflow file.

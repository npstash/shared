---
id: tests-and-ci
summary: Tests in tests/, run by run.sh test and by the framework directly, write only into
  .local_assets, use verified fakes of other repositories; CI checks out the listed repositories.
applies-to: all-agents
requires:
  - .github/workflows/tests.yml   # a copy of the one in this repository
related: [per-project-runtimes, submodule-dependencies]
---

# Tests and CI

- Put the tests of each project, component and tool into its `tests/` folder.
- `run.sh test` makes the runtime, installs the test dependencies and runs all tests.
- The test framework of the runtime must also run the tests directly, e.g. `.venv/bin/python -m pytest`.
- Tests run on the GitHub runner, on Ubuntu and on WSL.
- Tests write only into `.local_assets/` of the item. Start from the [templates](tests-and-ci/).
- Each repository has `.github/workflows/tests.yml`, a copy of [this one](../.github/workflows/tests.yml).
  It runs `run.sh test` in each folder with `tests/` and `run.sh`.

## Other repositories

- `setup.sh` checks out the submodules. Run it after each clone. A runner does not check out a repository.
- If a repository is missing, let the test fail with a message that names `setup.sh`. Do not skip the test.
- List the repositories that the tests of an item need in `tests/repositories.txt`, one name in each line.
- CI checks out each listed repository: as a submodule if `.gitmodules` has it, else at the path of
  `dependencies.txt`. CI checks out only public repositories.

## Test doubles

- Test against the real API of another repository. Do not copy its code.
- The owner of an API supplies a verified fake of each API that it exposes. A contract suite runs each
  case against the fake and against the real code.
- In a unit test, use only test doubles: a verified fake, or a mock made from the real API.
- In a functional test, you can run the real code of another repository with fake data.

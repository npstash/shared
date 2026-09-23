# shared — index

Rules, tools and skills for all repositories. Each rule lives in its own file under
[rules/](rules/README.md) and is **binding**. Rules are cited by id, never by number.
Claude Code-only rules are indexed in [CLAUDE.md](CLAUDE.md).

## Rules

- **deliverables-only** — commit only what can't be regenerated; intermediate files go into `.local_assets/`. @rules/deliverables-only.md
- **per-project-runtimes** — runtime inside the project, never a global one; launch via `run.sh` / `run.bat`. @rules/per-project-runtimes.md
- **tests-and-ci** — tests in a `tests/` subfolder per project or tool, run with `run.sh test`, auto-discovered by CI. @rules/tests-and-ci.md
- **credentials-from-vault** — secrets only from the vault (`tools/auth` and its `private-data`), never from this machine. @rules/credentials-from-vault.md
- **nothing-outside-repo** — every file an agent writes lives inside the repository. @rules/nothing-outside-repo.md
- **simplified-english** — repository text uses Simplified Technical English (ASD-STE100), basic rules only, and stays brief. @rules/simplified-english.md
- **confirm-design-choices** — never make a design choice without the user's confirmation, except in unattended runs. @rules/confirm-design-choices.md
- **decision-gates** — ask for open decisions before generating the rest; one question section per reply; automatic decisions listed at the top of the reply. @rules/decision-gates.md

## Tools

- [tools/auth](tools/auth/README.md) — credential vault: `init`, `list`, `get`, `set`, `sync`, key rotation.

## Skills

- [credentials](skills/credentials/SKILL.md) — get a secret for an external system from the vault.

## Setup

- [setup.sh](setup.sh) / [setup.bat](setup.bat) — check out submodules, turn on `.githooks/`, link skills into `.claude/skills/`, then run the setup of each submodule. Each repository has a copy.

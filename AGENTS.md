# shared — index

Each rule is a file in [rules/](rules/README.md) and is **binding**. Claude Code-only
rules: [CLAUDE.md](CLAUDE.md).

## Rules

- **deliverables-only** — commit only what you cannot regenerate. @rules/deliverables-only.md
- **per-project-runtimes** — runtime in the project folder, launched by `run.sh` / `run.bat`. @rules/per-project-runtimes.md
- **tests-and-ci** — tests per project, `run.sh test`, CI finds them. @rules/tests-and-ci.md
- **credentials-from-vault** — secrets only from the vault. @rules/credentials-from-vault.md
- **nothing-outside-repo** — write files only inside the repository. @rules/nothing-outside-repo.md
- **simplified-english** — repository text in STE (ASD-STE100), brief. @rules/simplified-english.md
- **confirm-design-choices** — the user confirms each design choice. @rules/confirm-design-choices.md
- **decision-gates** — ask open decisions first; one question section per reply. @rules/decision-gates.md
- **decision-records** — a `DR.md` log of decisions in each project and tool. @rules/decision-records.md

## Tools

- [tools/auth](tools/auth/README.md) — credential vault.

## Skills

- [credentials](skills/credentials/SKILL.md) — get a secret from the vault.

## Setup

- [setup.sh](setup.sh) / [setup.bat](setup.bat) — check out submodules, turn on `.githooks/`, link skills. Each repository has a copy.

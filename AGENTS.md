# shared — AGENTS.md

Each rule is a file in [rules/](rules/README.md) and is **binding**. Cite a rule by its
id, not by a number. Read the section for your agent. Do NOT read the sections for other
agents.

## Common (all agents)

### Rules
- **deliverables-only** — commit only what you cannot regenerate. @rules/deliverables-only.md
- **per-project-runtimes** — runtime in the project folder, launched by `run.sh` / `run.bat`. @rules/per-project-runtimes.md
- **tests-and-ci** — tests per project, `run.sh test`, CI finds them. @rules/tests-and-ci.md
- **credentials-from-vault** — secrets only from the vault. @rules/credentials-from-vault.md
- **nothing-outside-repo** — write files only inside the repository. @rules/nothing-outside-repo.md
- **simplified-english** — repository text in STE (ASD-STE100), brief. @rules/simplified-english.md
- **confirm-design-choices** — the user confirms each design choice. @rules/confirm-design-choices.md
- **decision-gates** — ask open decisions first; one question section per reply. @rules/decision-gates.md
- **voice-mode** — in voice mode the reply is spoken: short, one question at a time, no visual formatting. @rules/voice-mode.md
- **agent-identity** — an agent is not a person: not an author, no decisions, no feelings. @rules/agent-identity.md
- **architecture-decision-log** — an `ADL.md` log of architecture decisions and business rules in each project and tool. @rules/architecture-decision-log.md

### Skills
- [credentials](skills/credentials/SKILL.md) — get a secret from the vault through the API; enrol a clone; manage keys.
- [create-vault](skills/create-vault/SKILL.md) — make and fill a sub-vault of the vault. Use only when the user asks.
- [create-adr](skills/create-adr/SKILL.md) — write an ADR for an ADL entry. Use only when the user asks.

## Claude Code

### Rules
- **claude/nothing-outside-repo** — no auto-memory, scratchpad or `/tmp`. @rules/claude/nothing-outside-repo.md
- **claude/cowork-cloud-sessions** — in a Cowork cloud session use the GitHub REST API. @rules/claude/cowork-cloud-sessions.md
- **claude/explore-before-declining** — find the supported solution first; the user must not have to find it elsewhere. @rules/claude/explore-before-declining.md

### Skills
- [extract-decisions](skills/claude/extract-decisions/SKILL.md) — add the decisions of old chats to the `ADL.md` files.

## Setup
- [setup.sh](setup.sh) / [setup.bat](setup.bat) — check out submodules, turn on `.githooks/`, link skills. Each repository has a copy.

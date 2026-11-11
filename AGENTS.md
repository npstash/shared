# shared — AGENTS.md

Each rule is binding. A line with "When …" has a trigger. When the trigger applies, read the
linked file before you act, and apply it. The part before "When" always applies. A request of the
user overrides a rule only if it asks for the exact thing that the rule forbids. A request for
speed is not an override. Then do the action, name the rule, and confirm the action.

Cite a rule by its id, not by a number. Read the section for your agent. Do NOT read the
sections for other agents.

## Common (all agents)

### Rules
- **deliverables-only** — @rules/deliverables-only.md
- **per-project-runtimes** — Never change a global runtime. When you make or change a runtime, dependencies or a `run.sh`: read [per-project-runtimes](rules/per-project-runtimes.md).
- **tests-and-ci** — Tests write only into `.local_assets/`. When you write, change or run tests or CI: read [tests-and-ci](rules/tests-and-ci.md).
- **credentials-from-vault** — Get secrets only from the vault. Never write a secret into a transcript, log or file. Never ask for one in chat. When a task needs a secret, authentication, or a vault or enrolment action: read [credentials-from-vault](rules/credentials-from-vault.md).
- **nothing-outside-repo** — @rules/nothing-outside-repo.md
- **simplified-english** — @rules/simplified-english.md
- **confirm-design-choices** — @rules/confirm-design-choices.md
- **decision-gates** — @rules/decision-gates.md
- **voice-mode** — When the prompt is in voice mode: read [voice-mode](rules/voice-mode.md).
- **agent-identity** — @rules/agent-identity.md
- **architecture-decision-log** — When the user accepts an architecture decision or a business rule, or you change an `ADL.md` or an ADR: read [architecture-decision-log](rules/architecture-decision-log.md).
- **sdd-documentation** — Make an `sdd/` folder only when the user asks. When you work in a project with an `sdd/` folder: read [sdd-documentation](rules/sdd-documentation.md).
- **submodule-dependencies** — Write no fixed path to a submodule that other repositories also use, e.g. a vault. When code, a script or a configuration must find one: read [submodule-dependencies](rules/submodule-dependencies.md).
- **browser-automation** — For browser automation, use the MCP server `browser-automation-x-mcp` if it is available; this is mandatory. In a cookie consent dialog, accept all cookies and do not ask. If the dialog asks for more, stop and ask.
- **typed-code** — Write no untyped code. Do not use `any` or `Any`. When you write or review code: read [typed-code](rules/typed-code.md).
- **repo-structure-template** — When you change the repository structure, the rule repo-structure, or a file that the skill create-repo-structure copies or has a template of, ask the user if the skill must change too.
- **rules-and-skills** — When you add, change, move, disable or copy a rule or a skill: read [rules-and-skills](rules/rules-and-skills.md).

### Skills
- [credentials](skills/credentials/SKILL.md)
- [create-adr](skills/create-adr/SKILL.md)
- [create-repo-structure](skills/create-repo-structure/SKILL.md)
- [submodule-dependencies](skills/submodule-dependencies/SKILL.md)
- [ssh-remote](skills/ssh-remote/SKILL.md)
- [eval-rule](skills/eval-rule/SKILL.md)

## Claude Code

### Rules
- **claude/nothing-outside-repo** — Do not use the auto-memory folder, the session scratchpad or `/tmp`. Put scratch into `.local_assets/`.
- **claude/cowork-cloud-sessions** — When you use `gh` in a Cowork cloud sandbox: read [claude/cowork-cloud-sessions](rules/claude/cowork-cloud-sessions.md).

## Setup
- [setup.sh](setup.sh) — check out submodules, turn on `.githooks/`, link skills. Each repository has a copy.
